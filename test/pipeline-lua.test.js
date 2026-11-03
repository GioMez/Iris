const nodeTest = require("node:test");
const test = (name, fn) => nodeTest(name, { skip: process.env.IRIS_TEST_LUA !== "1" }, fn);
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { fork } = require("node:child_process");
const { executeLua } = require("../src/pipeline/lua-vm");

function run(request) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "helpers/lua-vm-process.cjs"), { stdio: ["ignore", "pipe", "pipe", "ipc"], detached: true,
      env: { PATH: process.env.PATH, LUA_BIN_PATH: process.env.LUA_BIN_PATH || "" } });
    let response, stderr = "";
    const timer = setTimeout(() => { process.kill(-child.pid, "SIGKILL"); }, 10000);
    child.stderr.on("data", bytes => { if (stderr.length < 4096) stderr += bytes; });
    child.on("message", value => { response = value; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!response) reject(new Error(`VM fixture exited ${code}/${signal}: ${stderr}`));
      else resolve(response);
    });
    child.send({ mode: "plan", script: "iris.lua", modules: { "iris.lua": "return { plan = function(ctx) return ctx end }" }, ...request });
  });
}

test("Lua uses the configured executable directory instead of an embedded interpreter", async () => {
  const result = await run({ binPath: path.join(__dirname, "missing-lua-installation") });
  assert.equal(result.error?.code, "PIPELINE_LUA_UNAVAILABLE", JSON.stringify(result));
});

test("Lua invocation deadlines terminate a planner loop", async () => {
  const result = await run({ timeoutMs: 100, modules: { "iris.lua": "return {plan=function() while true do end end}" } });
  assert.equal(result.error?.code, "PIPELINE_LUA_TIMEOUT", JSON.stringify(result));
});

test("Lua cancellation terminates a running planner and preserves the abort reason", async () => {
  const result = await run({ abortAfterMs: 100, modules: { "iris.lua": "return {plan=function() while true do end end}" } });
  assert.equal(result.error?.code, 20, JSON.stringify(result));
});

test("Lua cancellation from a host callback preserves authority failure and stops further I/O", async () => {
  const controller = new AbortController(), reason = Object.assign(new Error("lost authority"), { code: "PIPELINE_RUN_AUTHORITY_CHANGED" });
  let calls = 0;
  await assert.rejects(executeLua({ mode: "transform", script: "iris.lua", entrypoint: "go", signal: controller.signal,
    modules: { "iris.lua": "return {go=function(ctx) ctx.log('info','ready'); ctx.log('info','stale') end}" },
    host: { log: () => { calls++; controller.abort(reason); } },
  }), error => error === reason);
  assert.equal(calls, 1);
});

test("Lua cancellation during a binary reply retains the abort reason rather than a pipe error", async () => {
  const controller = new AbortController(), reason = new Error("cancel binary transfer");
  await assert.rejects(executeLua({ mode: "transform", script: "iris.lua", entrypoint: "go", signal: controller.signal,
    modules: { "iris.lua": "return {go=function(ctx) return #ctx.read('input','bytes.bin') end}" },
    host: { read: () => { controller.abort(reason); return Buffer.alloc(1024 * 1024); } },
  }), error => error === reason);
});

test("Lua data transport retains double precision and Unicode at the graph byte limit", async () => {
  const context = { pi: 3.141592653589793, fraction: 1.2345678901234567, text: "\ufeff".repeat(100) };
  const maxPlanBytes = Buffer.byteLength(JSON.stringify(context));
  assert.deepEqual((await run({ context, policy: { maxPlanBytes } })).result, context);
  assert.equal((await run({ context, policy: { maxPlanBytes: maxPlanBytes - 1 } })).error?.code, "PIPELINE_LUA_VALUE_INVALID");
});

test("Lua retains finite JavaScript numbers outside the safe-integer range as doubles", async () => {
  const context = { value: 1e18, negative: -1e18, huge: Number.MAX_VALUE, tiny: Number.MIN_VALUE };
  const result = await run({ context });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.deepEqual(result.result, context);
});

test("Lua binary read and write frames enforce their byte budget even when caught by the plugin", async () => {
  for (const body of ["pcall(ctx.read,'input','bytes.bin')", "pcall(ctx.write,'out','bytes.bin',string.rep('x',1025))"]) {
    const result = await run({ mode: "transform", entrypoint: "go", maxIoBytes: 1024, bytes: Buffer.alloc(1025).toString("base64"),
      modules: { "iris.lua": `return {go=function(ctx) ${body} end}` } });
    assert.equal(result.error?.code, "PIPELINE_LUA_VALUE_INVALID", JSON.stringify(result));
  }
});

test("Lua rejects malformed process frames before accepting a result", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-lua-protocol-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "lua");
  // Controlled executables exercise corruption that trusted Lua cannot emit.
  for (const frame of [Buffer.from([255,255,255,255,0,0,0,0]), Buffer.from([0,0,0,1,0,0,0,0,255]),
    Buffer.from([0,0,0,8,0,0,0,0,123])]) {
    await fs.writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdout.end(Buffer.from('${frame.toString("base64")}','base64'),()=>process.exit(0));`, { mode: 0o700 });
    const result = await run({ binPath: root });
    assert.equal(result.error?.code, "PIPELINE_LUA_PROTOCOL_INVALID", JSON.stringify(result));
    assert.ok(!result.error.message.includes(root));
  }
});

test("Lua descriptor inspection leaves entrypoints uncalled and planner values retain JSON shape", async () => {
  const inspected = await run({ mode: "inspect", modules: { "iris.lua": `return { apiVersion=1, pluginId="sample",
    parameterSchema={type="object",properties={amount={type="number",default=2}}},
    requiredCapabilities=iris.array{}, plan=function() error("inspection must not plan") end }` } });
  assert.equal(inspected.error, undefined, JSON.stringify(inspected.error));
  assert.deepEqual(inspected.result, { apiVersion: 1, pluginId: "sample", parameterSchema: {
    type: "object", properties: { amount: { type: "number", default: 2 } } }, requiredCapabilities: [] });
  const context = { parameters: { text: "é\u0000😀", object: {}, list: [], nullable: null }, snapshot: {}, capabilities: [] };
  assert.deepEqual((await run({ context })).result, context);
});

test("Lua loads only supplied source modules and exposes no operating-system or JS bridge", async () => {
  const modules = { "iris.lua": `local helper = require("parts.helper")
    assert(helper == require("parts.helper"))
    assert(io == nil and os == nil and package == nil and debug == nil and js == nil)
    assert(load == nil and loadfile == nil and dofile == nil and print == nil and string.dump == nil)
    return {plan=function(ctx) return {value=helper.value, unknown=pcall(require,"unknown")} end}`,
    "parts/helper.lua": "return {value=42}" };
  const result = await run({ modules, context: {} });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.deepEqual(result.result, { value: 42, unknown: false });
  for (const source of ["return require('../outside')", "return require('/etc/passwd')", "return require('parts.helper')"]) {
    const denied = await run({ modules: { "iris.lua": source } });
    assert.equal(denied.error?.code, "PIPELINE_LUA_EXECUTION_FAILED");
  }
  const bytecode = await run({ modules: { "iris.lua": "\u001bLua\u0054\u0000" } });
  assert.equal(bytecode.error?.code, "PIPELINE_LUA_EXECUTION_FAILED");
});

test("Lua transformation callbacks preserve every byte including NUL and invalid UTF-8", async () => {
  const bytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const result = await run({ mode: "transform", entrypoint: "copy", bytes: bytes.toString("base64"), context: { options: {} },
    modules: { "iris.lua": `return {copy=function(ctx)
      local files=ctx.list("input"); assert(files[1].path=="bytes.bin")
      local data=ctx.read("input",files[1].path)
      assert(#data==1048576 and string.byte(data,1)==0 and string.byte(data,256)==255)
      ctx.write("output","copy.bin",data)
      ctx.log("info","byte copy")
    end}` } });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.deepEqual(result.writes, [{ port: "output", file: "copy.bin", bytes: bytes.toString("base64") }]);
  assert.deepEqual(result.logs, [{ level: "info", message: "byte copy" }]);
});

test("Lua callback frames preserve nested arrays and null in both directions", async () => {
  const result = await run({ mode: "transform", entrypoint: "roundtrip", context: {}, modules: {
    "iris.lua": `return {roundtrip=function(ctx)
      local values=ctx.list("input")
      assert(values[1].metadata.nullable==iris.null)
      ctx.diagnostic({message="nested",data=values})
      return values
    end}`,
  } });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  const values = [{ path: "bytes.bin", size: 0, metadata: { list: [], nullable: null } }];
  assert.deepEqual(result.result, values);
  assert.deepEqual(result.logs, [{ message: "nested", data: values }]);
});

test("snapshot and listing capacity is independent of the smaller graph-result budget", async () => {
  const files = Array.from({ length: 20000 }, (_, i) => ({ path: `files/${i}.tex`, size: 0, contentHash: "a".repeat(64) }));
  const planned = await run({ context: { snapshot: { files } }, modules: {
    "iris.lua": "return {plan=function(ctx) return #ctx.snapshot.files end}",
  } });
  assert.equal(planned.error, undefined, JSON.stringify(planned.error));
  assert.equal(planned.result, 20000);
  const listed = await run({ mode: "transform", entrypoint: "list", listFiles: files, modules: {
    "iris.lua": "return {list=function(ctx) return #ctx.list('input') end}",
  } });
  assert.equal(listed.error, undefined, JSON.stringify(listed.error));
  assert.equal(listed.result, 20000);
  const oversized = await run({ context: { snapshot: { files } } });
  assert.equal(oversized.error?.code, "PIPELINE_LUA_VALUE_INVALID");
});

test("Lua boundary rejects executable, cyclic, sparse, metatable and lossy JSON values", async () => {
  const expressions = ["function() end", "setmetatable({}, {})", "(function() local t={} t.self=t return t end)()",
    "{[1]='a',[3]='c'}", "{[1]='a',key='b'}", "{[{}]=1}", "{__proto__={}}", "0/0", "math.huge",
    "9007199254740993", "string.char(255)", "iris.array{key=1}", "setmetatable(iris.null,{})",
    "(function() iris.null.value=function() end; return iris.null end)()"];
  for (const expression of expressions) {
    const result = await run({ modules: { "iris.lua": `return {plan=function() return ${expression} end}` } });
    assert.equal(result.error?.code, "PIPELINE_LUA_VALUE_INVALID", expression + ": " + JSON.stringify(result));
  }
});

test("Lua host callbacks reject extra arguments before interpreting their values", async () => {
  const result = await run({ mode: "transform", entrypoint: "bad", modules: {
    "iris.lua": "return {bad=function(ctx) ctx.log('info','message','extra') end}",
  } });
  assert.equal(result.error?.code, "PIPELINE_LUA_VALUE_INVALID", JSON.stringify(result));
});

test("unused approved modules are not read into the interpreter", async () => {
  const result = await executeLua({ mode: "plan", script: "iris.lua", modules: {
    "iris.lua": "return {plan=function() return 42 end}",
    get "unused.lua"() { throw new Error("unused module was read"); },
  } });
  assert.equal(result, 42);
});

test("Lua boundary enforces byte, node and depth budgets before IPC", async () => {
  for (const [expression, policy] of [["string.rep('x',1025)", { maxStringBytes: 1024 }],
    ["{1,2,3,4}", { maxValues: 4 }], ["{a={b={c=1}}}", { maxDepth: 2 }],
    ["{a=string.rep('x',40),b=string.rep('y',40)}", { maxPlanBytes: 80 }]]) {
    const result = await run({ policy, modules: { "iris.lua": `return {plan=function() return ${expression} end}` } });
    assert.equal(result.error?.code, "PIPELINE_LUA_VALUE_INVALID", JSON.stringify(result));
  }
});

test("Lua randomness requires an explicit seed", async () => {
  const random = await run({ modules: { "iris.lua": `return {plan=function()
    assert(not pcall(math.random)); assert(not pcall(math.randomseed))
    math.randomseed(123); local first=math.random(); math.randomseed(123)
    return first==math.random() end}` } });
  assert.equal(random.result, true, JSON.stringify(random));
});

test("integer parameters can seed the Lua random generator", async () => {
  const result = await run({ context: { parameters: { seed: 123 } }, modules: {
    "iris.lua": `return {plan=function(ctx)
      math.randomseed(ctx.parameters.seed); local first=math.random()
      math.randomseed(123); return first==math.random()
    end}`,
  } });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.result, true);
});

test("Lua cannot hide a host I/O failure in pcall or a VM-close finalizer", async () => {
  for (const body of ["pcall(ctx.read,'denied','secret')", `keeper=setmetatable({}, {__gc=function()
    pcall(ctx.read,'denied','secret') end})`, `keeper=setmetatable({}, {__gc=function()
    pcall(ctx.read,'denied','secret') end}); error('action failed')`,
    `keeper=setmetatable({}, {__gc=function() require('cleanup').run(ctx) end})`]) {
    const result = await run({ mode: "transform", entrypoint: "attempt", modules: {
      "iris.lua": `return {attempt=function(ctx) ${body} end}`,
      "cleanup.lua": "return {run=function(ctx) pcall(ctx.read,'denied','secret') end}",
    } });
    assert.equal(result.error?.code, "PIPELINE_INPUT_INVALID", body + ": " + JSON.stringify(result));
  }
});
