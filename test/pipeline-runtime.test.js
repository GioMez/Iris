const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { createRequire } = require("node:module");
const { compileFunction } = require("node:vm");
const { uuidv7 } = require("../src/ids");
const { readRuntimePolicy, createPodmanRuntime } = require("../src/pipeline/runtime");

const image = "docker.io/library/node@sha256:" + "a".repeat(64);
test("contained runtime requires a digest identity and positive bounded resources", () => {
  for (const extra of [{ image: "node:24" }, { memoryBytes: 0 }, { outputEntries: 0 }, { cpus: NaN }, { pids: 1.5 }, { timeoutMs: Infinity }, { unknown: 1 }]) {
    assert.throws(() => readRuntimePolicy({ image, ...extra }), { code: "PIPELINE_RUNTIME_POLICY_INVALID" });
  }
  const source = { image, memoryBytes: 1073741824, totalMemoryBytes: 1073741824, concurrency: 2 };
  const policy = readRuntimePolicy(source);
  source.memoryBytes = 1;
  assert.equal(policy.memoryBytes, 1073741824);
  assert.ok(Object.isFrozen(policy));
});

test("a worker larger than the aggregate reservation fails before engine admission", () => {
  assert.throws(() => readRuntimePolicy({ image, memoryBytes: 1073741824, totalMemoryBytes: 536870912 }), { code: "PIPELINE_RUNTIME_POLICY_INVALID" });
});

const native = { skip: !process.env.IRIS_TEST_PIPELINE_IMAGE, timeout: 45000 };
async function runtimeFixture(t, overrides = {}, prepareTransport = async () => ({}), createRuntime = createPodmanRuntime) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-runtime-")), root = path.join(fixtureRoot, "state");
  const transportOverrides = await prepareTransport(fixtureRoot);
  const runtime = await createRuntime({ root, coordinatorId: uuidv7(),
    transport: { command: "podman", connection: process.env.IRIS_TEST_PODMAN_CONNECTION || null, home: process.env.IRIS_TEST_PODMAN_HOME, ...transportOverrides },
    policy: { image: process.env.IRIS_TEST_PIPELINE_IMAGE, memoryBytes: 268435456, totalMemoryBytes: 268435456,
      outputBytes: 8388608, outputEntries: 64, tempBytes: 8388608, tempEntries: 64, concurrency: 2, queueLimit: 2, ...overrides },
    tools: [{ id: "node", path: "/usr/local/bin/node", timeoutMs: 3000 }] });
  t.after(async () => {
    await runtime.close();
    const { installationId } = JSON.parse(await fs.readFile(path.join(root, "installation.json"), "utf8"));
    const prefix = process.env.IRIS_TEST_PODMAN_CONNECTION ? ["--connection", process.env.IRIS_TEST_PODMAN_CONNECTION] : [];
    for (const args of [["ps", "--all"], ["volume", "ls"]]) {
      const { stdout } = await promisify(execFile)("podman", [...prefix, ...args, "--filter", `label=iris.installation=${installationId}`, "--format", "{{.Name}}"],
        { env: { PATH: process.env.PATH, HOME: process.env.IRIS_TEST_PODMAN_HOME }, timeout: 10000 });
      assert.equal(stdout.trim(), "", "no installation-owned engine resources remain after close");
    }
    assert.deepEqual(await fs.readdir(root), ["installation.json"]);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });
  const workspace = await runtime.createWorkspace({ runId: uuidv7(), stepId: "native" });
  return { root, runtime, workspace, run: (script, extra = {}) => runtime.runContained({ tool: runtime.resolveTool("node"), args: ["-e", script], workspace, ...extra }) };
}

test("rootless workers have no backend credentials or writable root", native, async t => {
  const f = await runtimeFixture(t);
  process.env.IRIS_SYNTHETIC_SECRET = "runtime-test-secret";
  t.after(() => { delete process.env.IRIS_SYNTHETIC_SECRET; });
  const result = await f.run(`const fs=require('node:fs');let denied=false;try{fs.writeFileSync('/outside','bad')}catch{denied=true}
    fs.writeFileSync('/work/result.txt',Buffer.from([0,255,13,10]));
    console.log(JSON.stringify({uid:process.getuid(),secret:process.env.IRIS_SYNTHETIC_SECRET||null,denied}));`);
  assert.equal(result.code, 0);
  assert.equal(result.drained, true);
  assert.deepEqual(JSON.parse(result.log), { uid: 65534, secret: null, denied: true });
  await assert.rejects(f.runtime.runContained({ tool: { id: "node", path: "/bin/sh" }, args: [], workspace: f.workspace }), { code: "PIPELINE_TOOL_INVALID" });
});

test("contained cancellation drains a detached descendant before the runtime reservation returns", native, async t => {
  const f = await runtimeFixture(t), controller = new AbortController();
  const running = f.run(`const {spawn}=require('node:child_process');spawn('/bin/sh',['-c','while :; do sleep 1; done'],{detached:true,stdio:'ignore'});console.log('ready');setInterval(()=>{},1000);`, {
    signal: controller.signal, onOutput: chunk => { if (chunk.toString().includes("ready")) controller.abort(); },
  });
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.drained, true);
  const { installationId } = JSON.parse(await fs.readFile(path.join(f.root, "installation.json"), "utf8"));
  const prefix = process.env.IRIS_TEST_PODMAN_CONNECTION ? ["--connection", process.env.IRIS_TEST_PODMAN_CONNECTION] : [];
  const { stdout } = await promisify(execFile)("podman", [...prefix, "ps", "--all", "--filter", `label=iris.installation=${installationId}`, "--format", "{{.ID}}"],
    { env: { PATH: process.env.PATH, HOME: process.env.IRIS_TEST_PODMAN_HOME }, timeout: 10000 });
  assert.equal(stdout.trim(), "", "the cancelled worker and its descendants are gone before disposal");
  await f.runtime.disposeWorkspace(f.workspace);
  const second = await f.runtime.createWorkspace({ runId: uuidv7(), stepId: "after-cancel" });
  const accepted = await f.runtime.runContained({ tool: f.runtime.resolveTool("node"), args: ["-e", "console.log('new worker')"], workspace: second });
  assert.equal(accepted.code, 0);
});

test("the engine deadline ends an uncooperative loop and reports no active worker", native, async t => {
  const f = await runtimeFixture(t);
  const result = await f.run("while(true){} ");
  assert.equal(result.timedOut, true);
  assert.equal(result.drained, true);
  assert.notEqual(result.code, 0);
});

test("resource waiting is cancellable without returning another workspace's reservation", native, async t => {
  const f = await runtimeFixture(t), controller = new AbortController();
  const waiting = f.runtime.createWorkspace({ runId: uuidv7(), stepId: "waiting", signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  const result = await f.run("console.log('first reservation remains usable')");
  assert.equal(result.code, 0);
});

test("a log flood retains only the configured byte budget and still drains the worker", native, async t => {
  const f = await runtimeFixture(t, { logBytes: 1024 });
  const result = await f.run("process.stdout.write('x'.repeat(1048576))");
  assert.equal(result.code, 0);
  assert.equal(Buffer.byteLength(result.log), 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.drained, true);
});

test("direct runtime stop reports cancellation and leaves no late recovery record after disposal", native, async t => {
  const f = await runtimeFixture(t);
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const running = f.run("console.log('ready');setInterval(()=>{},1000)", { onOutput: chunk => { if (chunk.toString().includes("ready")) ready(); } });
  await entered;
  await f.runtime.stop(f.workspace);
  await f.runtime.disposeWorkspace(f.workspace);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.deepEqual(await fs.readdir(f.root), ["installation.json"]);
});

test("worker output bytes and inode limits reject excess writes inside the container", native, async t => {
  const f = await runtimeFixture(t);
  const bytes = await f.run(`const fs=require('node:fs');let code;try{fs.writeFileSync('/work/full',Buffer.alloc(16777216,1));}catch(e){code=e.code}console.log(code);fs.rmSync('/work/full',{force:true});`);
  assert.equal(bytes.code, 0);
  assert.equal(bytes.log.trim(), "ENOSPC");
  const entries = await f.run(`const fs=require('node:fs');let code,count=0;try{for(;count<1000;count++)fs.writeFileSync('/work/'+count,'');}catch(e){code=e.code}console.log(JSON.stringify({code,count}));`);
  assert.equal(entries.code, 0);
  const observed = JSON.parse(entries.log);
  assert.equal(observed.code, "ENOSPC");
  assert.ok(observed.count > 0 && observed.count < 1000);
});

test("memory exhaustion reports the kernel OOM result after cgroup drain", native, async t => {
  const f = await runtimeFixture(t);
  const result = await f.run("const held=[];for(;;)held.push(Buffer.alloc(16777216,1));");
  assert.equal(result.oomKilled, true);
  assert.equal(result.drained, true);
  assert.notEqual(result.code, 0);
});

test("unconfirmed engine inspection retains execution until an independent stop confirms drain", native, async t => {
  let block, observed;
  t.after(async () => { if (block) await fs.rm(block, { force: true }); });
  const f = await runtimeFixture(t, {}, async root => {
    block = path.join(root, "block-inspection"); observed = path.join(root, "inspection-failures");
    const command = path.join(root, "podman-proxy.cjs");
    await fs.writeFile(command, `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('inspect') && !args.includes('volume') && fs.existsSync(${JSON.stringify(block)})){
  fs.appendFileSync(${JSON.stringify(observed)},'failure\\n');process.exit(125);
}
const child=spawn('podman',args,{stdio:'inherit'});child.on('error',()=>process.exit(126));child.on('exit',code=>process.exit(code??1));
`, { mode: 0o700 });
    return { command };
  });
  let finished = false;
  await fs.writeFile(block, "blocked");
  const running = f.run("console.log('done')").then(value => { finished = true; return value; }, error => { finished = true; return error; });
  const deadline = Date.now() + 12000;
  for (;;) {
    const count = await fs.readFile(observed, "utf8").then(text => text.trim().split("\n").length, error => { if (error.code === "ENOENT") return 0; throw error; });
    if (count >= 1) break;
    assert.ok(Date.now() < deadline, "final inspection must reach the controlled failure");
    await delay(20);
  }
  // Observe the caller after the control process reports failure, while its
  // engine inspection stays unavailable. The successful worker exit alone
  // cannot authorize returning a slot or deleting its recovery identity.
  await Promise.race([running, delay(250)]);
  assert.equal(finished, false, "execution must retain its caller until drain is confirmed");
  assert.ok((await fs.readdir(f.root)).some(file => file !== "installation.json"), "recovery identity remains available");
  await fs.rm(block);
  await f.runtime.stop(f.workspace);
  await running;
});

test("concurrent workspace disposal shares cleanup and returns only one resource reservation", native, async t => {
  const f = await runtimeFixture(t);
  await Promise.all([f.runtime.disposeWorkspace(f.workspace), f.runtime.disposeWorkspace(f.workspace)]);
  const one = await f.runtime.createWorkspace({ runId: uuidv7(), stepId: "one" });
  const controller = new AbortController();
  const waiting = f.runtime.createWorkspace({ runId: uuidv7(), stepId: "two", signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await f.runtime.disposeWorkspace(one);
});

test("direct stop during initial receipt creation prevents a later worker launch", native, async t => {
  const f = await runtimeFixture(t);
  const running = f.run("console.log('must not execute')");
  const stopped = f.runtime.stop(f.workspace);
  await stopped;
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.log, "");
  await assert.rejects(f.run("console.log('late invocation')"), { code: "PIPELINE_WORKSPACE_CANCELLED" });
});

test("a run deadline that expires in the resource queue admits no workspace", native, async t => {
  const f = await runtimeFixture(t), deadlineAt = Date.now() + 100;
  const waiting = f.runtime.createWorkspace({ runId: uuidv7(), stepId: "expired", deadlineAt });
  while (Date.now() <= deadlineAt) await delay(20);
  await f.runtime.disposeWorkspace(f.workspace);
  await assert.rejects(waiting, { code: "PIPELINE_RUN_DEADLINE" });
  assert.deepEqual(await fs.readdir(f.root), ["installation.json"]);
});

test("disposal waits for the worker's last receipt write before deleting recovery evidence", native, async t => {
  let armed = false, release, entered;
  const held = new Promise(resolve => { release = resolve; }), writing = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const sourcePath = require.resolve("../src/pipeline/runtime"), localRequire = createRequire(sourcePath), module = { exports: {} };
  const injected = name => name === "node:fs/promises" ? { ...fs, async writeFile(file, body, ...args) {
    if (armed && String(file).endsWith(".json") && JSON.parse(body).containers?.length === 0) {
      armed = false; entered(); await held;
    }
    return fs.writeFile(file, body, ...args);
  } } : localRequire(name);
  compileFunction(await fs.readFile(sourcePath, "utf8"), ["require", "module"], { filename: sourcePath })(injected, module);
  const f = await runtimeFixture(t, {}, undefined, module.exports.createPodmanRuntime);
  const running = f.run("console.log('done')", { onOutput: () => { armed = true; } });
  await writing;
  let disposed = false;
  const disposing = f.runtime.disposeWorkspace(f.workspace).then(() => { disposed = true; });
  try {
    await Promise.race([disposing, delay(1000)]);
    assert.equal(disposed, false, "a finishing worker still owns its receipt write");
  } finally { release(); await running; await disposing; }
  assert.deepEqual(await fs.readdir(f.root), ["installation.json"]);
});
