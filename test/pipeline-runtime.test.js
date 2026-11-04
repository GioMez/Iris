const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createHash } = require("node:crypto");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { uuidv7 } = require("../src/ids");
const { readRuntimePolicy, createNativeRuntime } = require("../src/pipeline/runtime");

async function fixture(t, { policy = {}, tools = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-native-runtime-"));
  let runtime;
  t.after(async () => { await runtime?.close(); await fs.rm(root, { recursive: true, force: true }); });
  runtime = await createNativeRuntime({ root: path.join(root, "runtime"), coordinatorId: uuidv7(), policy,
    tools: [{ id: "node", path: process.execPath, timeoutMs: 5000 }, ...tools] });
  const workspace = await runtime.createWorkspace({ runId: uuidv7(), stepId: "probe" });
  return { root, runtime, workspace, run: (script, options = {}) => runtime.runTool({ workspace,
    tool: runtime.resolveTool("node"), args: ["-e", script], ...options }) };
}

test("native runtime retains scratch between commands and excludes backend credentials", async t => {
  const f = await fixture(t);
  const first = await f.run("require('node:fs').writeFileSync('cache','retained');console.log(JSON.stringify({cwd:process.cwd(),tmp:process.env.TMPDIR,secret:process.env.IRIS_SECRET,password:process.env.DB_PASSWORD}))");
  assert.equal(first.code, 0); assert.equal(first.drained, true);
  assert.deepEqual(JSON.parse(first.log), { cwd: f.workspace.workRoot, tmp: f.workspace.tempRoot });
  assert.equal((await f.run("console.log(require('node:fs').readFileSync('cache','utf8'))")).log, "retained\n");
  await assert.rejects(f.runtime.runTool({ workspace: f.workspace, tool: { id: "node", path: process.execPath }, args: [] }), { code: "PIPELINE_TOOL_INVALID" });
});

test("native runtime cancellation drains the owned process group before returning", async t => {
  const f = await fixture(t), controller = new AbortController();
  let pid;
  const result = await f.run(`const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid);setInterval(()=>{},1000)`, { signal: controller.signal,
    onOutput: chunk => { pid = Number(chunk.toString().trim()); controller.abort(); } });
  assert.equal(result.cancelled, true); assert.equal(result.drained, true);
  assert.ok(Number.isSafeInteger(pid));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("native runtime deadlines stop loops and keep stderr separate from stdout", async t => {
  const f = await fixture(t, { tools: [{ id: "short", path: process.execPath, timeoutMs: 100 }] });
  const output = await f.run("const fs=require('node:fs');fs.writeSync(1,'out');fs.writeSync(2,'err')", { captureStreams: true });
  assert.equal(output.stdout, "out"); assert.equal(output.stderr, "err");
  const result = await f.run("while(true){}", { tool: f.runtime.resolveTool("short") });
  assert.equal(result.timedOut, true); assert.equal(result.drained, true);
});

test("native runtime exports bounded binary outputs and rejects linked files", async t => {
  const f = await fixture(t, { policy: { logBytes: 16, outputBytes: 2097152 } });
  const bytes = Buffer.alloc(1048576, 255);
  assert.equal((await f.run("const fs=require('node:fs');fs.mkdirSync('output');fs.writeFileSync('output/binary',Buffer.alloc(1048576,255))")).code, 0);
  const output = await f.runtime.exportWorkspace({ workspace: f.workspace, directory: "output", destination: path.join(f.root, "export") });
  assert.deepEqual(await fs.readFile(path.join(output.root, "output/binary")), bytes);
  await fs.symlink(path.join(f.workspace.workRoot, "output/binary"), path.join(f.workspace.workRoot, "output/link"));
  await assert.rejects(f.runtime.exportWorkspace({ workspace: f.workspace, directory: "output", destination: path.join(f.root, "rejected") }), { code: "PIPELINE_PATH_INVALID" });
  await assert.rejects(fs.stat(path.join(f.root, "rejected")), { code: "ENOENT" });
});

test("native runtime rejects changed input identities and releases failed workspace admission", async t => {
  const f = await fixture(t, { policy: { concurrency: 1, queueLimit: 1 } });
  await f.runtime.disposeWorkspace(f.workspace);
  const inputRoot = path.join(f.root, "input"); await fs.mkdir(inputRoot);
  await fs.writeFile(path.join(inputRoot, "source"), "changed");
  await assert.rejects(f.runtime.createWorkspace({ runId: uuidv7(), stepId: "changed", input: { root: inputRoot, directories: [],
    files: [{ path: "source", size: 7, contentHash: "a".repeat(64) }] } }), { code: "PIPELINE_INPUT_CHANGED" });
  const next = await f.runtime.createWorkspace({ runId: uuidv7(), stepId: "next", queue: false });
  await f.runtime.disposeWorkspace(next);
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("native policy validates admission and byte limits and rejects retired OS-quota settings", () => {
  for (const policy of [{ outputBytes: 0 }, { logBytes: NaN }, { queueLimit: -1 }, { concurrency: 1.5 }, { unknown: 1 },
    { memoryBytes: 1 }, { image: "old-image" }, { timeoutMs: 200, runTimeoutMs: 100 }]) {
    assert.throws(() => readRuntimePolicy(policy), { code: "PIPELINE_RUNTIME_POLICY_INVALID" });
  }
  const source = { concurrency: 1, queueLimit: 0 }, policy = readRuntimePolicy(source);
  source.concurrency = 5;
  assert.equal(policy.concurrency, 1); assert.ok(Object.isFrozen(policy));
});

test("invalid native tool environments and protocol allowances fail before creating storage", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-native-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "runtime");
  for (const extra of [{ env: { A: "\0" } }, { env: { "bad-key": "x" } }, { protocolBytes: -1 }, { protocolBytes: 16777217 }]) {
    await assert.rejects(createNativeRuntime({ root: destination, coordinatorId: uuidv7(),
      tools: [{ id: "node", path: process.execPath, timeoutMs: 1000, ...extra }] }), { code: "PIPELINE_TOOL_INVALID" });
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  }
});

test("native logging and protocol capture share their configured byte bounds", async t => {
  const f = await fixture(t, { policy: { logBytes: 16 }, tools: [{ id: "protocol", path: process.execPath, timeoutMs: 5000, protocolBytes: 32 }] });
  const script = "require('node:fs').writeSync(1,'x'.repeat(100000))";
  const ordinary = await f.run(script);
  assert.equal(ordinary.code, 0); assert.equal(ordinary.log, "x".repeat(16)); assert.equal(ordinary.truncated, true);
  const protocol = await f.run(script, { tool: f.runtime.resolveTool("protocol"), outputLimitBytes: 48 });
  assert.equal(protocol.outputLimited, true); assert.equal(protocol.log, "x".repeat(48)); assert.equal(protocol.drained, true);
});

test("native output callback failures terminate the process and retain the original failure", async t => {
  const f = await fixture(t), reason = new Error("progress authority lost");
  await assert.rejects(f.run("console.log('ready');setInterval(()=>{},1000)", { onOutput: () => { throw reason; } }), err => err === reason);
  assert.equal((await f.run("console.log('next')")).code, 0);
});

test("native nonqueued and cancelled admissions do not consume another workspace's slot", async t => {
  const f = await fixture(t, { policy: { concurrency: 1, queueLimit: 1 } });
  const options = { runId: uuidv7(), stepId: "waiting" };
  await assert.rejects(f.runtime.createWorkspace({ ...options, queue: false }), { code: "PIPELINE_WORKER_BUSY" });
  const controller = new AbortController(), waiting = f.runtime.createWorkspace({ ...options, signal: controller.signal });
  controller.abort(); await assert.rejects(waiting, { name: "AbortError" });
  await assert.rejects(f.runtime.createWorkspace({ ...options, queue: false }), { code: "PIPELINE_WORKER_BUSY" });
  await f.runtime.disposeWorkspace(f.workspace);
  await f.runtime.disposeWorkspace(await f.runtime.createWorkspace({ ...options, queue: false }));
});

test("native queue admission rechecks the original run deadline", async t => {
  const f = await fixture(t, { policy: { concurrency: 1, queueLimit: 1 } });
  const waiting = f.runtime.createWorkspace({ runId: uuidv7(), stepId: "expired", deadlineAt: Date.now() + 10 });
  await delay(25); await f.runtime.disposeWorkspace(f.workspace);
  await assert.rejects(waiting, { code: "PIPELINE_RUN_DEADLINE" });
});

test("native concurrent disposal shares cleanup and prevents a late process launch", async t => {
  const f = await fixture(t, { policy: { concurrency: 1, queueLimit: 1 } });
  const running = f.run("require('node:fs').writeFileSync('late','bad')");
  await Promise.all([f.runtime.disposeWorkspace(f.workspace), f.runtime.disposeWorkspace(f.workspace)]);
  assert.equal((await running).cancelled, true);
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("native exports preserve existing destinations and refuse oversized or hardlinked products", async t => {
  const f = await fixture(t, { policy: { outputBytes: 16 } });
  const directory = path.join(f.workspace.workRoot, "output"); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "large"), Buffer.alloc(17));
  const destination = path.join(f.root, "export");
  await assert.rejects(f.runtime.exportWorkspace({ workspace: f.workspace, directory: "output", destination }), { code: "PIPELINE_OUTPUT_LIMIT" });
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  await fs.writeFile(path.join(directory, "large"), "short");
  await fs.link(path.join(directory, "large"), path.join(f.root, "linked"));
  await assert.rejects(f.runtime.exportWorkspace({ workspace: f.workspace, directory: "output", destination }), { code: "PIPELINE_PATH_INVALID" });
  await fs.mkdir(destination); await fs.writeFile(path.join(destination, "keep"), "retained");
  await assert.rejects(f.runtime.exportWorkspace({ workspace: f.workspace, directory: "output", destination }), { code: "EEXIST" });
  assert.equal(await fs.readFile(path.join(destination, "keep"), "utf8"), "retained");
});

test("native input capacity remains independent of writable output limits", async t => {
  const f = await fixture(t, { policy: { outputBytes: 16, outputEntries: 2 } });
  await f.runtime.disposeWorkspace(f.workspace);
  const input = path.join(f.root, "source"); await fs.mkdir(input);
  const bytes = Buffer.alloc(1048576, 255); await fs.writeFile(path.join(input, "large.bin"), bytes);
  const workspace = await f.runtime.createWorkspace({ runId: uuidv7(), stepId: "input", input: { root: input, directories: [],
    files: [{ path: "large.bin", size: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") }] } });
  assert.deepEqual(await fs.readFile(path.join(workspace.inputRoot, "large.bin")), bytes);
});

test("native optional executables fail on use and changed executable bytes invalidate registered tools", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-native-executable-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = path.join(root, "probe"); await fs.writeFile(command, "#!/bin/sh\necho original\n", { mode: 0o700 });
  const f = await fixture(t, { tools: [{ id: "probe", path: command, timeoutMs: 1000 }, { id: "missing", path: path.join(root, "absent"), timeoutMs: 1000 }] });
  await assert.rejects(f.run("", { tool: f.runtime.resolveTool("missing"), args: [] }), { code: "PIPELINE_RUNTIME_UNAVAILABLE" });
  await fs.writeFile(command, "#!/bin/sh\necho changed\n");
  await assert.rejects(f.run("", { tool: f.runtime.resolveTool("probe"), args: [] }), { code: "PIPELINE_TOOL_CHANGED" });
});

test("native reconciliation preserves current workspaces and blocks uncertain prior execution without signalling PIDs", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.workspace.workRoot, "retained"), "active");
  await f.runtime.reconcile();
  assert.equal(await fs.readFile(path.join(f.workspace.workRoot, "retained"), "utf8"), "active");
  const stateRoot = path.join(f.root, "runtime"), id = uuidv7();
  const original = JSON.parse(await fs.readFile(path.join(stateRoot, `${f.workspace.id}.json`), "utf8"));
  const receipt = { ...original, id, coordinatorId: uuidv7(), phase: "running", pid: process.pid };
  const file = path.join(stateRoot, `${id}.json`), bytes = JSON.stringify(receipt);
  await fs.mkdir(path.join(stateRoot, id)); await fs.writeFile(file, bytes);
  await assert.rejects(f.runtime.reconcile(), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  process.kill(process.pid, 0);
  await fs.writeFile(file, JSON.stringify({ ...receipt, phase: "idle", pid: null }));
  assert.deepEqual((await f.runtime.reconcile()).recovered, [id]);
  await assert.rejects(fs.stat(path.join(stateRoot, id)), { code: "ENOENT" });
});

test("native restart recovers idle workspaces but retains interrupted execution evidence", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-native-interruption-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = [{ id: "node", path: process.execPath, timeoutMs: 10000 }];
  for (const workspaceOnly of [true, false]) {
    const stateRoot = path.join(root, String(workspaceOnly));
    const child = fork(path.join(__dirname, "fixtures/pipeline-coordinator.cjs"), [JSON.stringify({ root: stateRoot,
      coordinatorId: uuidv7(), runId: uuidv7(), tools, workspaceOnly })], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: { PATH: process.env.PATH } });
    const exited = once(child, "exit");
    t.after(() => child.kill("SIGKILL"));
    const [ready] = await once(child, "message");
    assert.equal(ready.ready, true, JSON.stringify(ready));
    if (ready.pid) t.after(() => { try { process.kill(-ready.pid, "SIGKILL"); } catch (err) { if (err.code !== "ESRCH") throw err; } });
    child.kill("SIGKILL"); await exited;
    if (workspaceOnly) {
      const restarted = await createNativeRuntime({ root: stateRoot, coordinatorId: uuidv7(), tools });
      await restarted.close();
      assert.deepEqual(await fs.readdir(stateRoot), ["installation.json"]);
    } else {
      const receipt = path.join(stateRoot, `${ready.workspace.id}.json`), before = await fs.readFile(receipt, "utf8");
      await assert.rejects(createNativeRuntime({ root: stateRoot, coordinatorId: uuidv7(), tools }), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
      assert.equal(await fs.readFile(receipt, "utf8"), before);
      process.kill(ready.pid, 0);
    }
  }
});

test("native shutdown drains active tools and rejects waiting admissions", async t => {
  const f = await fixture(t, { policy: { concurrency: 1, queueLimit: 1 } });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = f.run("console.log('ready');setInterval(()=>{},1000)", { onOutput: ready });
  await started;
  const waiting = assert.rejects(f.runtime.createWorkspace({ runId: uuidv7(), stepId: "waiting" }), { code: "PIPELINE_RUNTIME_STOPPING" });
  await f.runtime.close(); await waiting;
  assert.equal((await running).cancelled, true);
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("native callback drain retains workspace ownership through asynchronous authority failure", async t => {
  const f = await fixture(t), reason = Object.assign(new Error("lost authority"), { code: "PIPELINE_RUN_AUTHORITY_CHANGED" });
  let ready, release;
  const entered = new Promise(resolve => { ready = resolve; }), held = new Promise(resolve => { release = resolve; });
  const running = assert.rejects(f.run("console.log('ready')", { onOutput: async () => { ready(); await held; throw reason; } }), err => err === reason);
  await entered;
  await assert.rejects(f.run("console.log('overlap')"), { code: "PIPELINE_WORKER_BUSY" });
  release(); await running;
  assert.equal((await f.run("console.log('next')")).code, 0);
});

test("native disposal retries a failed filesystem cleanup without releasing admission", async t => {
  const f = await fixture(t, { policy: { concurrency: 1, queueLimit: 0 } });
  const protectedDir = path.join(f.workspace.workRoot, "protected");
  await fs.mkdir(protectedDir); await fs.writeFile(path.join(protectedDir, "retain"), "evidence");
  await fs.chmod(protectedDir, 0o500);
  try {
    await assert.rejects(f.runtime.disposeWorkspace(f.workspace), err => ["EACCES", "EPERM"].includes(err.code));
    await assert.rejects(f.runtime.createWorkspace({ runId: uuidv7(), stepId: "blocked", queue: false }), { code: "PIPELINE_WORKER_BUSY" });
    assert.equal(await fs.readFile(path.join(protectedDir, "retain"), "utf8"), "evidence");
  } finally { await fs.chmod(protectedDir, 0o700); }
  await f.runtime.disposeWorkspace(f.workspace);
});

test("native shutdown drains other workspaces even when one cleanup fails", async t => {
  const f = await fixture(t), protectedDir = path.join(f.workspace.workRoot, "protected");
  await fs.mkdir(protectedDir); await fs.writeFile(path.join(protectedDir, "retain"), "evidence");
  const second = await f.runtime.createWorkspace({ runId: uuidv7(), stepId: "second" });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = f.run("console.log('ready');setInterval(()=>{},1000)", { workspace: second, onOutput: ready });
  await started; await fs.chmod(protectedDir, 0o500);
  try {
    await assert.rejects(f.runtime.close());
    assert.equal((await running).cancelled, true);
    await assert.rejects(fs.stat(second.workRoot), { code: "ENOENT" });
  } finally { await fs.chmod(protectedDir, 0o700); }
});

test("native cancellation interrupts active export and removes its partial destination", async t => {
  const f = await fixture(t), output = path.join(f.workspace.workRoot, "output"), destination = path.join(f.root, "export");
  await fs.mkdir(output); await fs.writeFile(path.join(output, "bytes"), Buffer.alloc(16 * 1024 * 1024));
  let ready, release;
  const created = new Promise(resolve => { ready = resolve; });
  const paused = new Promise(resolve => { release = resolve; }), mkdir = fs.mkdir;
  // Pause after the real directory write; macOS watcher delivery can arrive
  // after an entire copy, which would test completed rather than active export.
  t.mock.method(fs, "mkdir", async (...args) => {
    const result = await mkdir(...args);
    if (args[0] === destination) { ready(); await paused; }
    return result;
  });
  const exporting = assert.rejects(f.runtime.exportWorkspace({ workspace: f.workspace, directory: "output", destination }), { name: "AbortError" });
  await created;
  const stopping = f.runtime.stop(f.workspace); release();
  await stopping; await exporting;
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});

test("native shutdown cancels input staging before it can admit a late workspace", async t => {
  const f = await fixture(t);
  await f.runtime.disposeWorkspace(f.workspace);
  const input = path.join(f.root, "source"), bytes = Buffer.alloc(16 * 1024 * 1024);
  await fs.mkdir(input); await fs.writeFile(path.join(input, "large"), bytes);
  let ready, release;
  const preparing = new Promise(resolve => { ready = resolve; });
  const paused = new Promise(resolve => { release = resolve; }), mkdir = fs.mkdir;
  const stateRoot = await fs.realpath(path.join(f.root, "runtime"));
  t.mock.method(fs, "mkdir", async (...args) => {
    const result = await mkdir(...args);
    if (path.dirname(args[0]) === stateRoot) { ready(); await paused; }
    return result;
  });
  const creating = assert.rejects(f.runtime.createWorkspace({ runId: uuidv7(), stepId: "staging", input: { root: input, directories: [],
    files: [{ path: "large", size: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") }] } }), { name: "AbortError" });
  await preparing;
  const closing = f.runtime.close(); release();
  await closing; await creating;
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("native malformed recovery receipts retain their bytes and unrelated files", async t => {
  const f = await fixture(t), stateRoot = path.join(f.root, "runtime"), file = path.join(stateRoot, `${uuidv7()}.json`);
  const unrelated = path.join(stateRoot, "operator-notes.txt");
  await fs.writeFile(unrelated, "keep"); await fs.writeFile(file, '{"partial":');
  await assert.rejects(f.runtime.reconcile(), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  assert.equal(await fs.readFile(file, "utf8"), '{"partial":');
  assert.equal(await fs.readFile(unrelated, "utf8"), "keep");
});

test("native decoded stream capture stays within the shared log byte budget", async t => {
  const f = await fixture(t, { policy: { logBytes: 16 } });
  const result = await f.run("const fs=require('node:fs');fs.writeSync(1,Buffer.alloc(8,255));fs.writeSync(2,Buffer.alloc(8,255))", { captureStreams: true });
  assert.equal(result.code, 0);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 16);
  assert.ok(Buffer.byteLength(result.log) <= 16);
  assert.equal(result.truncated, true);
});

test("native export preserves the configured entry capacity without charging its implicit root", async t => {
  const f = await fixture(t, { policy: { outputEntries: 1 } });
  await fs.writeFile(path.join(f.workspace.workRoot, "one"), "one");
  const exported = await f.runtime.exportWorkspace({ workspace: f.workspace, destination: path.join(f.root, "export") });
  assert.equal(await fs.readFile(path.join(exported.root, "one"), "utf8"), "one");
});

test("native output callbacks stop after an asynchronous authority failure", async t => {
  const f = await fixture(t), reason = new Error("authority changed");
  let calls = 0;
  await assert.rejects(f.run("const fs=require('node:fs');fs.writeSync(1,'out');fs.writeSync(2,'err');setInterval(()=>{},1000)", {
    onOutput: async () => { calls++; await delay(20); throw reason; },
  }), err => err === reason);
  assert.equal(calls, 1);
});
