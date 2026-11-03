const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile, fork } = require("node:child_process");
const { once } = require("node:events");
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
  const source = { image, memoryBytes: 1073741824, totalMemoryBytes: 2147483648, concurrency: 2 };
  const policy = readRuntimePolicy(source);
  source.memoryBytes = 1;
  assert.equal(policy.memoryBytes, 1073741824);
  assert.ok(Object.isFrozen(policy));
});

test("a worker larger than the aggregate reservation fails before engine admission", () => {
  assert.throws(() => readRuntimePolicy({ image, memoryBytes: 1073741824, totalMemoryBytes: 536870912 }), { code: "PIPELINE_RUNTIME_POLICY_INVALID" });
});

test("memory admission includes retained scratch and the holding container", () => {
  assert.throws(() => readRuntimePolicy({ image, memoryBytes: 268435456, outputBytes: 8388608, tempBytes: 8388608,
    totalMemoryBytes: 285212672 }), { code: "PIPELINE_RUNTIME_POLICY_INVALID" });
});

const native = { skip: !process.env.IRIS_TEST_PIPELINE_IMAGE, timeout: 45000 };
async function runtimeFixture(t, overrides = {}, prepareTransport = async () => ({}), createRuntime = createPodmanRuntime) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-runtime-")), root = path.join(fixtureRoot, "state");
  const transportOverrides = await prepareTransport(fixtureRoot);
  const runtime = await createRuntime({ root, coordinatorId: uuidv7(),
    transport: { command: "podman", connection: process.env.IRIS_TEST_PODMAN_CONNECTION || null, home: process.env.IRIS_TEST_PODMAN_HOME, ...transportOverrides },
    policy: { image: process.env.IRIS_TEST_PIPELINE_IMAGE, memoryBytes: 268435456, totalMemoryBytes: 293601280,
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
  const running = f.run("console.log('done')", { onOutput: () => fs.writeFile(block, "blocked") })
    .then(value => { finished = true; return value; }, error => { finished = true; return error; });
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
  async function write(body, writeActual) {
    if (armed && JSON.parse(body).containers?.length === 1) {
      armed = false; entered(); await held;
    }
    return writeActual(body);
  }
  const injected = name => name === "node:fs/promises" ? { ...fs,
    writeFile: (file, body, ...args) => write(body, bytes => fs.writeFile(file, bytes, ...args)),
    async open(...args) {
      const handle = await fs.open(...args), writeFile = handle.writeFile.bind(handle);
      handle.writeFile = body => write(body, writeFile); return handle;
    },
  } : localRequire(name);
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

async function abandonedFixture(t, workspaceOnly = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-restart-"));
  const options = { root, coordinatorId: uuidv7(), runId: uuidv7(), workspaceOnly,
    transport: { command: "podman", connection: process.env.IRIS_TEST_PODMAN_CONNECTION || null, home: process.env.IRIS_TEST_PODMAN_HOME },
    policy: { image: process.env.IRIS_TEST_PIPELINE_IMAGE, memoryBytes: 268435456, totalMemoryBytes: 293601280,
      outputBytes: 8388608, outputEntries: 64, tempBytes: 8388608, tempEntries: 64 },
    tools: [{ id: "node", path: "/usr/local/bin/node", timeoutMs: 20000 }] };
  const prefix = options.transport.connection ? ["--connection", options.transport.connection] : [];
  const control = args => promisify(execFile)("podman", [...prefix, ...args], { env: { PATH: process.env.PATH, HOME: options.transport.home }, timeout: 10000 });
  let child;
  const resumed = [];
  t.after(async () => {
    child?.kill("SIGKILL");
    for (const runtime of resumed) await runtime.close();
    // Red runs also own their crashed coordinator's resources. Clean only its
    // installation label, even when production startup recovery is missing.
    const { installationId } = JSON.parse(await fs.readFile(path.join(root, "installation.json"), "utf8"));
    const filter = ["--filter", `label=iris.installation=${installationId}`];
    const containers = (await control(["ps", "--all", ...filter, "--format", "{{.ID}}"])).stdout.trim().split("\n").filter(Boolean);
    for (const id of containers) await control(["rm", "--force", "--time=0", id]);
    const volumes = (await control(["volume", "ls", ...filter, "--format", "{{.Name}}"])).stdout.trim().split("\n").filter(Boolean);
    for (const id of volumes) await control(["volume", "rm", id]);
    await fs.rm(root, { recursive: true, force: true });
  });
  child = fork(path.join(__dirname, "fixtures", "pipeline-coordinator.cjs"), [JSON.stringify(options)], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const [message] = await once(child, "message");
  assert.deepEqual(message, { ready: true });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  return { root, options, control, async restart(overrides = {}) {
    const runtime = await createPodmanRuntime({ ...options, coordinatorId: uuidv7(), ...overrides });
    resumed.push(runtime); return runtime;
  } };
}

test("runtime startup drains the dead coordinator's workers and scratch before new admission", native, async t => {
  const { root, control, restart } = await abandonedFixture(t);
  const resumed = await restart();
  const { installationId } = JSON.parse(await fs.readFile(path.join(root, "installation.json"), "utf8"));
  assert.equal((await control(["ps", "--all", "--filter", `label=iris.installation=${installationId}`, "--format", "{{.ID}}"])).stdout.trim(), "");
  assert.equal((await control(["volume", "ls", "--filter", `label=iris.installation=${installationId}`, "--format", "{{.Name}}"])).stdout.trim(), "");
  assert.deepEqual(await fs.readdir(root), ["installation.json"]);
  const workspace = await resumed.createWorkspace({ runId: uuidv7(), stepId: "new" });
  const result = await resumed.runContained({ workspace, tool: resumed.resolveTool("node"), args: ["-e", "console.log('recovered')"] });
  assert.equal(result.code, 0);
});

test("recovery discovers orphan workers by installation labels when their receipt is lost", native, async t => {
  const { root, control, restart } = await abandonedFixture(t);
  for (const file of await fs.readdir(root)) if (file !== "installation.json") await fs.unlink(path.join(root, file));
  await restart();
  const { installationId } = JSON.parse(await fs.readFile(path.join(root, "installation.json"), "utf8"));
  for (const args of [["ps", "--all"], ["volume", "ls"]]) {
    assert.equal((await control([...args, "--filter", `label=iris.installation=${installationId}`, "--format", "{{.Name}}"])).stdout.trim(), "");
  }
  assert.deepEqual(await fs.readdir(root), ["installation.json"]);
});

test("recovery refuses mismatched run ownership without deleting scratch or receipt bytes", native, async t => {
  const { root, control, restart } = await abandonedFixture(t, true);
  const file = (await fs.readdir(root)).find(file => file !== "installation.json"), location = path.join(root, file);
  const record = JSON.parse(await fs.readFile(location, "utf8"));
  record.runId = uuidv7();
  const bytes = JSON.stringify(record); await fs.writeFile(location, bytes);
  await assert.rejects(restart(), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  assert.equal(await fs.readFile(location, "utf8"), bytes);
  for (const volume of record.volumes) await control(["volume", "exists", volume]);
});

test("recovery retries partial volume cleanup and tolerates an already absent resource", native, async t => {
  const { root, options, control, restart } = await abandonedFixture(t, true);
  const file = (await fs.readdir(root)).find(file => file !== "installation.json"), location = path.join(root, file);
  const record = JSON.parse(await fs.readFile(location, "utf8"));
  for (const container of record.containers) await control(["rm", "--force", "--time=0", container]);
  await control(["volume", "rm", record.volumes[0]]);
  const command = path.join(root, "podman-proxy.cjs");
  await fs.writeFile(command, `#!/usr/bin/env node
const {spawn}=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('volume')&&args.includes('rm'))process.exit(125);
const child=spawn('podman',args,{stdio:'inherit'});child.on('error',()=>process.exit(126));child.on('exit',code=>process.exit(code??1));
`, { mode: 0o700 });
  await assert.rejects(restart({ transport: { ...options.transport, command } }), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  assert.deepEqual(JSON.parse(await fs.readFile(location, "utf8")).volumes, [record.volumes[1]]);
  await control(["volume", "exists", record.volumes[1]]);
  await fs.unlink(command);
  await restart();
  assert.deepEqual(await fs.readdir(root), ["installation.json"]);
});

test("startup removes abandoned receipt temporaries after recovery and preserves unrelated files", native, async t => {
  const { root, restart } = await abandonedFixture(t, true);
  const file = (await fs.readdir(root)).find(file => file !== "installation.json"), id = file.slice(0, -5);
  await fs.writeFile(path.join(root, `.receipt-${id}-${uuidv7()}.tmp`), '{"unfinished":');
  await fs.writeFile(path.join(root, "operator-note"), "retained");
  await restart();
  assert.deepEqual((await fs.readdir(root)).sort(), ["installation.json", "operator-note"]);
  assert.equal(await fs.readFile(path.join(root, "operator-note"), "utf8"), "retained");
});

test("runtime scratch survives successive compiler invocations in one workspace", native, async t => {
  const f = await runtimeFixture(t);
  assert.equal((await f.run("require('node:fs').writeFileSync('/work/saved',Buffer.from([0,255,13,10,128]))")).code, 0);
  const read = await f.run("console.log(require('node:fs').readFileSync('/work/saved').toString('hex'))");
  assert.equal(read.code, 0); assert.equal(read.log.trim(), "00ff0d0a80");
});

test("the scratch holder has a separate bounded lifetime and rejects reuse after loss", native, async t => {
  const f = await runtimeFixture(t), record = JSON.parse(await fs.readFile(path.join(f.root, `${f.workspace.id}.json`), "utf8"));
  assert.equal(record.containers.length, 1);
  const prefix = process.env.IRIS_TEST_PODMAN_CONNECTION ? ["--connection", process.env.IRIS_TEST_PODMAN_CONNECTION] : [];
  const control = args => promisify(execFile)("podman", [...prefix, ...args],
    { env: { PATH: process.env.PATH, HOME: process.env.IRIS_TEST_PODMAN_HOME }, timeout: 10000 });
  const holder = JSON.parse((await control(["inspect", record.containers[0]])).stdout)[0];
  assert.equal(holder.State.Running, true);
  assert.equal(holder.HostConfig.Memory, 8388608);
  assert.equal(holder.HostConfig.PidsLimit, 1);
  assert.equal(holder.HostConfig.ReadonlyRootfs, true);
  assert.equal(holder.HostConfig.NetworkMode, "none");
  await control(["rm", "--force", "--time=0", record.containers[0]]);
  await assert.rejects(f.run("console.log('must not run with empty scratch')"), { code: "PIPELINE_WORKSPACE_LOST" });
});

test("the engine expires idle scratch at the workspace deadline without host cancellation", native, async t => {
  const f = await runtimeFixture(t, { runTimeoutMs: 4000, timeoutMs: 3000 });
  const receipt = JSON.parse(await fs.readFile(path.join(f.root, `${f.workspace.id}.json`), "utf8"));
  const prefix = process.env.IRIS_TEST_PODMAN_CONNECTION ? ["--connection", process.env.IRIS_TEST_PODMAN_CONNECTION] : [];
  for (;;) {
    const { stdout } = await promisify(execFile)("podman", [...prefix, "inspect", receipt.containers[0]],
      { env: { PATH: process.env.PATH, HOME: process.env.IRIS_TEST_PODMAN_HOME }, timeout: 10000 });
    if (!JSON.parse(stdout)[0].State.Running) break;
    assert.ok(Date.now() < receipt.deadlineAt + 2500, "the engine must expire idle scratch without a host timer");
    await delay(100);
  }
  await assert.rejects(f.run("console.log('expired')"), { code: "PIPELINE_RUN_DEADLINE" });
});

test("concurrent cancellation shares holder cleanup before deleting the workspace", native, async t => {
  const f = await runtimeFixture(t);
  const started = performance.now();
  await Promise.all([f.runtime.stop(f.workspace), f.runtime.stop(f.workspace)]);
  assert.ok(performance.now() - started < 5000, "cancelled scratch must drain without a graceful-stop delay");
  await f.runtime.disposeWorkspace(f.workspace);
  assert.deepEqual(await fs.readdir(f.root), ["installation.json"]);
});

test("shutdown waits for pending scratch setup and admits no late holder", native, async t => {
  let armed = false, enter, release;
  const writing = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const sourcePath = require.resolve("../src/pipeline/runtime"), localRequire = createRequire(sourcePath), module = { exports: {} };
  const injected = name => name === "node:fs/promises" ? { ...fs, async open(...args) {
    const handle = await fs.open(...args), write = handle.writeFile.bind(handle);
    handle.writeFile = async body => {
      const record = JSON.parse(body);
      if (armed && record.volumes?.length === 1 && record.containers?.length === 0) {
        armed = false; enter(); await held;
      }
      return write(body);
    };
    return handle;
  } } : localRequire(name);
  compileFunction(await fs.readFile(sourcePath, "utf8"), ["require", "module"], { filename: sourcePath })(injected, module);
  const f = await runtimeFixture(t, {}, undefined, module.exports.createPodmanRuntime);
  await f.runtime.disposeWorkspace(f.workspace); armed = true;
  const creating = f.runtime.createWorkspace({ runId: uuidv7(), stepId: "pending" }).then(value => ({ value }), error => ({ error }));
  await writing;
  let closed = false;
  const closing = f.runtime.close().then(() => { closed = true; });
  try {
    await Promise.race([closing, delay(300)]);
    assert.equal(closed, false, "shutdown must retain pending scratch setup");
  } finally { release(); await creating; await closing; }
  assert.equal((await creating).error?.code, "PIPELINE_RUNTIME_STOPPING");
  assert.deepEqual(await fs.readdir(f.root), ["installation.json"]);
});

test("reconciliation preserves active workers and reservations", native, async t => {
  const f = await runtimeFixture(t);
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const running = f.run("console.log('ready');setInterval(()=>{},1000)", { onOutput: chunk => { if (chunk.toString().includes("ready")) ready(); } });
  await entered;
  assert.deepEqual(await f.runtime.reconcile(), { recovered: [] });
  const file = path.join(f.root, `${f.workspace.id}.json`), receipt = JSON.parse(await fs.readFile(file, "utf8"));
  const prefix = process.env.IRIS_TEST_PODMAN_CONNECTION ? ["--connection", process.env.IRIS_TEST_PODMAN_CONNECTION] : [];
  const { stdout } = await promisify(execFile)("podman", [...prefix, "inspect", receipt.containers.at(-1)],
    { env: { PATH: process.env.PATH, HOME: process.env.IRIS_TEST_PODMAN_HOME }, timeout: 10000 });
  assert.equal(JSON.parse(stdout)[0].State.Running, true);
  const controller = new AbortController();
  const queued = f.runtime.createWorkspace({ runId: uuidv7(), stepId: "waiting", signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  await f.runtime.stop(f.workspace); await running;
});

test("uncertain volume setup can close without retaining an unusable reservation", native, async t => {
  let block;
  t.after(async () => { if (block) await fs.rm(block, { force: true }); });
  const f = await runtimeFixture(t, {}, async root => {
    block = path.join(root, "fail-create");
    const command = path.join(root, "podman-proxy.cjs");
    await fs.writeFile(command, `#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process'),args=process.argv.slice(2);
if(args.includes('volume')&&fs.existsSync(${JSON.stringify(block)})&&(args.includes('create')||(args.includes('exists')&&fs.readFileSync(${JSON.stringify(block)},'utf8')==='unconfirmed')))process.exit(125);
const child=spawn('podman',args,{stdio:'inherit'});child.on('error',()=>process.exit(126));child.on('exit',code=>process.exit(code??1));
`, { mode: 0o700 });
    return { command };
  });
  await f.runtime.disposeWorkspace(f.workspace);
  await fs.writeFile(block, "blocked");
  await assert.rejects(f.runtime.createWorkspace({ runId: uuidv7(), stepId: "setup" }), { code: "PIPELINE_ENGINE_COMMAND_FAILED" });
  assert.deepEqual(await fs.readdir(f.root), ["installation.json"], "confirmed failed setup must return its reservation before rejecting");
  await fs.writeFile(block, "unconfirmed");
  await assert.rejects(f.runtime.createWorkspace({ runId: uuidv7(), stepId: "uncertain" }), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  assert.ok((await fs.readdir(f.root)).some(file => file !== "installation.json"));
  await assert.rejects(f.runtime.reconcile(), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  await fs.unlink(block);
  assert.equal((await f.runtime.reconcile()).recovered.length, 1);
  await f.runtime.createWorkspace({ runId: uuidv7(), stepId: "after-recovery" });
  await f.runtime.close();
  assert.deepEqual(await fs.readdir(f.root), ["installation.json"]);
});

test("an interrupted receipt replacement preserves the last complete recovery identity", native, async t => {
  let armed = false, enter, release;
  const writing = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  async function write(body, writeActual) {
    if (armed && JSON.parse(body).containers?.length > 0) {
      armed = false;
      await writeActual(body.slice(0, 20)); enter(); await held;
      throw Object.assign(new Error("Interrupted fixture write"), { code: "EIO" });
    }
    return writeActual(body);
  }
  const sourcePath = require.resolve("../src/pipeline/runtime"), localRequire = createRequire(sourcePath), module = { exports: {} };
  const injected = name => name === "node:fs/promises" ? { ...fs,
    writeFile: (file, body, ...args) => write(body, bytes => fs.writeFile(file, bytes, ...args)),
    async open(...args) {
      const handle = await fs.open(...args), writeFile = handle.writeFile.bind(handle);
      handle.writeFile = body => write(body, writeFile); return handle;
    },
  } : localRequire(name);
  compileFunction(await fs.readFile(sourcePath, "utf8"), ["require", "module"], { filename: sourcePath })(injected, module);
  const f = await runtimeFixture(t, {}, undefined, module.exports.createPodmanRuntime);
  const location = path.join(f.root, `${f.workspace.id}.json`), original = await fs.readFile(location, "utf8");
  armed = true;
  const running = f.run("console.log('must not execute')");
  const rejected = assert.rejects(running, { code: "EIO" });
  await writing;
  try { assert.equal(await fs.readFile(location, "utf8"), original); }
  finally { release(); await rejected; }
});

test("malformed worker receipts block startup and retain their recovery bytes", native, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-bad-receipt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "installation.json"), JSON.stringify({ installationId: uuidv7() }));
  const file = path.join(root, `${uuidv7()}.json`), bytes = '{"interrupted-write":';
  await fs.writeFile(file, bytes);
  await assert.rejects(createPodmanRuntime({ root, coordinatorId: uuidv7(), tools: [],
    transport: { command: "podman", connection: process.env.IRIS_TEST_PODMAN_CONNECTION || null, home: process.env.IRIS_TEST_PODMAN_HOME },
    policy: { image: process.env.IRIS_TEST_PIPELINE_IMAGE, totalMemoryBytes: 1879048192 },
  }), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  assert.equal(await fs.readFile(file, "utf8"), bytes);
});
