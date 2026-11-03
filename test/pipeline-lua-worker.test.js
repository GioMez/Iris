const nodeTest = require("node:test");
const test = (name, fn) => nodeTest(name, { skip: process.env.IRIS_TEST_LUA !== "1" }, fn);
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { watch } = require("node:fs");
const { promisify } = require("node:util");
const env = { PATH: process.env.PATH, LUA_BIN_PATH: process.env.LUA_BIN_PATH || "" };

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, script, extra = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "iris-lua-request-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "input"), workRoot = path.join(root, "work"), bytes = Buffer.from([0, 255, 128, 10]);
  await fs.mkdir(path.join(inputRoot, "modules"), { recursive: true });
  await fs.mkdir(path.join(inputRoot, "inputs/source"), { recursive: true });
  await fs.mkdir(workRoot);
  await fs.writeFile(path.join(inputRoot, "modules/iris.lua"), script);
  await fs.writeFile(path.join(inputRoot, "inputs/source/bytes.bin"), bytes);
  const request = { version: 1, mode: "transform", script: "iris.lua", entrypoint: "generate", context: { options: {} },
    modules: [{ path: "iris.lua", size: Buffer.byteLength(script), contentHash: hash(script) }],
    inputs: { source: { kind: "collection", mediaType: "application/octet-stream", files: [{ path: "bytes.bin", size: bytes.length, contentHash: hash(bytes) }] } },
    outputs: { include: { kind: "file", path: "generated/include.ily", mediaType: "text/plain" } }, ...extra };
  await fs.writeFile(path.join(inputRoot, "request.json"), JSON.stringify(request));
  return { root, inputRoot, workRoot, request, bytes, run: async () => {
    const worker = path.resolve(__dirname, "../src/pipeline/lua-worker.js");
    const result = await promisify(execFile)(process.execPath, ["-e",
      `require(${JSON.stringify(worker)}).runLuaWorker(${JSON.stringify({ inputRoot, workRoot })}).catch(e=>{console.error(e.code||'worker failed');process.exitCode=1})`],
    { env, timeout: 10000, maxBuffer: 2097152 });
    return { response: JSON.parse(await fs.readFile(path.join(workRoot, "response/result.json"), "utf8")), log: result.stdout };
  } };
}

test("Lua worker reads a file-framed request and returns byte outputs and bounded diagnostics", async t => {
  const f = await fixture(t, `return {generate=function(ctx)
    ctx.write('include','generated/include.ily',ctx.read('source','bytes.bin'))
    ctx.log('info','copied bytes')
    ctx.diagnostic({severity='warning',message='check input',input='source',file='bytes.bin',line=1})
  end}`);
  const result = await f.run();
  assert.deepEqual(result.response, { version: 1, value: null, diagnostics: [
    { severity: "warning", message: "check input", input: "source", file: "bytes.bin", line: 1 },
  ], logsTruncated: false });
  assert.deepEqual(result.log.trim().split("\n").map(line => JSON.parse(line)), [
    { level: "info", message: "copied bytes" },
    { diagnostic: { severity: "warning", message: "check input", input: "source", file: "bytes.bin", line: 1 } },
  ]);
  assert.deepEqual(await fs.readFile(path.join(f.workRoot, "output/generated/include.ily")), f.bytes);
});

test("Lua worker does not expose I/O during inspection or planning", async t => {
  for (const mode of ["inspect", "plan"]) {
    const f = await fixture(t, `return {apiVersion=1,pluginId='sample',parameterSchema={type='object'},
      plan=function(ctx) assert(ctx.read==nil and ctx.write==nil and ctx.log==nil); return {answer=42} end}`, {
      mode, entrypoint: undefined, inputs: undefined, outputs: undefined,
    });
    const result = await f.run();
    assert.equal(result.response.errorCode, undefined);
    assert.deepEqual(result.response.value, mode === "plan" ? { answer: 42 } : {
      apiVersion: 1, pluginId: "sample", parameterSchema: { type: "object" },
    });
  }
});

test("Lua worker reports host failures caught by the script and preserves prior diagnostics", async t => {
  const f = await fixture(t, `return {generate=function(ctx)
    ctx.diagnostic({severity='warning',message='before failure'})
    pcall(ctx.read,'source','../outside')
  end}`);
  const result = await f.run();
  assert.deepEqual(result.response, { version: 1, errorCode: "PIPELINE_INPUT_INVALID",
    diagnostics: [{ severity: "warning", message: "before failure" }], logsTruncated: false });
  assert.ok(!JSON.stringify(result.response).includes(f.root));
});

test("Lua worker rejects changed module bytes and malformed requests before project execution", async t => {
  const changed = await fixture(t, "return {generate=function() end}");
  await fs.writeFile(path.join(changed.inputRoot, "modules/iris.lua"), "return {generate=function() while true do end end}");
  assert.equal((await changed.run()).response.errorCode, "PIPELINE_INPUT_CHANGED");
  const malformed = await fixture(t, "while true do end", { version: 2 });
  assert.equal((await malformed.run()).response.errorCode, "PIPELINE_LUA_REQUEST_INVALID");
});

test("Lua worker rejects changed descriptor metadata before invoking the planner", async t => {
  const f = await fixture(t, `return {apiVersion=1,pluginId='sample',
    parameterSchema={type='object',properties={count={type='integer',default=2}}},
    plan=function() error('planner ran with stale parameter validation') end}`, {
    mode: "plan", entrypoint: undefined, inputs: undefined, outputs: undefined,
    expectedDescriptor: { apiVersion: 1, pluginId: "sample", parameterSchema: {
      type: "object", properties: { count: { type: "integer", default: 1 } }, additionalProperties: false,
    }, requiredCapabilities: [] },
  });
  assert.equal((await f.run()).response.errorCode, "PIPELINE_DESCRIPTOR_CHANGED");
});

test("Lua worker accepts normalized descriptor defaults before planning", async t => {
  const f = await fixture(t, `return {apiVersion=1,pluginId='sample',parameterSchema={type='object'},
    plan=function(ctx) return ctx.parameters end}`, {
    mode: "plan", entrypoint: undefined, inputs: undefined, outputs: undefined, context: { parameters: {} },
    expectedDescriptor: { apiVersion: 1, pluginId: "sample", parameterSchema: { type: "object", properties: {}, additionalProperties: false }, requiredCapabilities: [] },
  });
  const result = (await f.run()).response;
  assert.equal(result.errorCode, undefined);
  assert.deepEqual(result.value, {});
});

test("Lua worker logging remains complete and bounded while the parent delays reading", async t => {
  const f = await fixture(t, "return {generate=function(ctx) for i=1,100 do ctx.log('info',string.rep('x',60000)) end end}", { outputs: {} });
  const source = `require(${JSON.stringify(path.resolve(__dirname, "../src/pipeline/lua-worker.js"))}).runLuaWorker(${JSON.stringify({ inputRoot: f.inputRoot, workRoot: f.workRoot })})
    .then(()=>process.send('finished',()=>process.disconnect()),()=>{process.exitCode=1;process.disconnect()})`;
  const log = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", stderr = "", code, signal, ended = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    function finish() {
      if (code === undefined || !ended) return;
      clearTimeout(timer);
      code === 0 ? resolve(output) : reject(new Error(`Worker exited ${code}/${signal}: ${stderr}`));
    }
    child.stderr.on("data", chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.on("message", () => {
      child.stdout.on("data", chunk => { output += chunk; });
    });
    child.on("error", reject);
    child.stdout.on("end", () => { ended = true; finish(); });
    child.on("exit", (exitCode, exitSignal) => { code = exitCode; signal = exitSignal; child.stdout.resume(); finish(); });
  });
  const response = JSON.parse(await fs.readFile(path.join(f.workRoot, "response/result.json"), "utf8"));
  assert.equal(response.errorCode, undefined, JSON.stringify(response));
  assert.equal(response.logsTruncated, true);
  assert.ok(Buffer.byteLength(log) > 60000 && Buffer.byteLength(log) <= 1048576);
  for (const line of log.trim().split("\n")) assert.equal(JSON.parse(line).message.length, 60000);
});

test("Lua diagnostic events drain after log saturation while project code keeps executing", async t => {
  const f = await fixture(t, `return {generate=function(ctx)
    for i=1,100 do ctx.log('info',string.rep('x',60000)) end
    ctx.diagnostic({severity='warning',message='after log saturation'})
    ctx.write('include','generated/include.ily','ready')
    while true do end
  end}`);
  const worker = path.resolve(__dirname, "../src/pipeline/lua-worker.js");
  const result = await new Promise((resolve, reject) => {
    let ready = false;
    const watcher = watch(f.workRoot, { recursive: true }, (event, file) => {
      if (file?.endsWith("include.ily")) { ready = true; child.stdout.resume(); }
    });
    const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(worker)}).runLuaWorker(${JSON.stringify({ inputRoot: f.inputRoot, workRoot: f.workRoot })})`], {
      env, stdio: ["ignore", "pipe", "ignore"], detached: true,
    });
    let output = "", diagnostics = [], timedOut = false;
    const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, "SIGKILL"); }, 5000);
    child.on("error", error => { clearTimeout(timer); watcher.close(); reject(error); });
    child.stdout.on("data", bytes => {
      output += bytes;
      for (let end; (end = output.indexOf("\n")) !== -1;) {
        const event = JSON.parse(output.slice(0, end)); output = output.slice(end + 1);
        if (event.diagnostic) { diagnostics.push(event.diagnostic); process.kill(-child.pid, "SIGKILL"); }
      }
    });
    child.stdout.pause();
    child.on("close", () => { clearTimeout(timer); watcher.close(); resolve({ ready, timedOut, diagnostics }); });
  });
  assert.equal(result.ready, true, "worker reached the loop before the parent resumed reading");
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.diagnostics, [{ severity: "warning", message: "after log saturation" }]);
  await assert.rejects(fs.stat(path.join(f.workRoot, "response/result.json")), { code: "ENOENT" });
});
