const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { compileFunction } = require("node:vm");
const { uuidv7 } = require("../src/ids");
const { createRegistry } = require("../src/pipeline/registry");
const { createRunWorkspace, disposeRunWorkspace } = require("../src/pipeline/workspaces");
const { createPodmanRuntime, readRuntimePolicy } = require("../src/pipeline/runtime");
const { executePlan } = require("../src/pipeline/executor");
const { ConcurrencyGate } = require("../src/throttle");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const image = process.env.IRIS_TEST_PIPELINE_IMAGE;
const contained = { skip: !image, timeout: 90000 };
const script = `local count=require('settings').count
return {apiVersion=1,pluginId='generate',parameterSchema={type='object',properties={count={type='integer',default=count,minimum=1}}},
  plan=function(ctx)
    assert(ctx.read==nil and ctx.snapshot.root==nil and ctx.snapshot.files[1].contentHash~=nil)
    assert(ctx.capabilities[1]=='check')
    return {apiVersion=1,pluginId='generate',parameterSchema={type='object',properties={count={type='integer',default=count,minimum=1}}},
      steps={{id='check',adapter={id='check',version='1.0.0'},options={count=ctx.parameters.count}}},
      targets={default={steps={'check'},publish=iris.array{}}}}
  end}`;
const definitions = [{ id: "check", version: "1.0.0", implementationHash: "a".repeat(64), capabilities: ["check"],
  optionsSchema: { type: "object", properties: { count: { type: "integer" } } }, execute: async () => ({}) }];

async function fixture(t, { native = false, sources = { "iris.lua": script, "settings.lua": "return {count=3}" }, adapters = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-lua-host-"));
  const source = path.join(root, "source"); await fs.mkdir(source);
  const files = [];
  for (const [relative, bytes] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await fs.writeFile(path.join(source, relative), bytes);
    files.push({ id: uuidv7(), path: relative, binary: Buffer.isBuffer(bytes) });
  }
  const workspace = await createRunWorkspace({ root: source, files, directories: [], settings: {} }, { root: path.join(root, "runs") });
  let runtime, starts = 0;
  const admissions = [];
  t.after(async () => { await runtime?.close(); await disposeRunWorkspace(workspace); await fs.rm(root, { recursive: true }); });
  const policy = readRuntimePolicy({ image: image || `sha256:${"a".repeat(64)}`, memoryBytes: 268435456, totalMemoryBytes: 335544320,
    outputBytes: 16777216, tempBytes: 8388608, outputEntries: 1024, tempEntries: 64 });
  const tools = require("../src/pipeline/lua").createLuaTools();
  if (native) runtime = await createPodmanRuntime({ root: path.join(root, "runtime"), coordinatorId: uuidv7(),
    transport: { connection: process.env.IRIS_TEST_PODMAN_CONNECTION, home: process.env.IRIS_TEST_PODMAN_HOME }, policy, tools });
  const boundary = native ? { ...runtime, createWorkspace: options => { starts++; admissions.push(options.stepId); return runtime.createWorkspace(options); } } : {
    manifest: () => ({ policy, tools }), createWorkspace() { starts++; throw new Error("Unexpected worker admission"); },
  };
  const { createLuaCoordinator } = require("../src/pipeline/lua");
  const registry = createRegistry([...definitions, ...adapters]);
  const createHost = options => createLuaCoordinator({ runtime: boundary, workspace, runId: uuidv7(), registry, ...options });
  const host = createHost();
  return { host, createHost, workspace, root, source, registry, boundary, admissions, starts: () => starts };
}

test("Lua bundle identity covers executable paths and bytes but ignores source-only edits", () => {
  const { luaBundle } = require("../src/pipeline/lua");
  const files = ["iris.lua", "lib/helper.LUA", "main.tex"].map(p => ({ path: p, size: 1, contentHash: hash("a") }));
  const original = luaBundle({ files });
  assert.equal(original.bundleHash, luaBundle({ files: [...files].reverse() }).bundleHash);
  assert.equal(original.bundleHash, luaBundle({ files: files.map(f => f.path === "main.tex" ? { ...f, contentHash: hash("b") } : f) }).bundleHash);
  for (const changed of [files.slice(0, 1), [...files, { path: "extra.lua", size: 0, contentHash: hash("") }],
    files.map(f => f.path === "lib/helper.LUA" ? { ...f, contentHash: hash("b") } : f),
    files.map(f => f.path === "lib/helper.LUA" ? { ...f, path: "lib/renamed.lua" } : f)]) {
    assert.notEqual(original.bundleHash, luaBundle({ files: changed }).bundleHash);
  }
  assert.throws(() => luaBundle({ files: files.slice(1) }), { code: "PIPELINE_SCRIPT_MISSING" });
});

test("Lua inspection rejects unapproved bundle and policy identities without starting work", async t => {
  const f = await fixture(t), approval = f.host.identity;
  for (const field of ["bundleHash", "registryHash", "policyHash"]) {
    await assert.rejects(f.host.inspectLua({ approval: { ...approval, [field]: "0".repeat(64) } }), { code: "PIPELINE_APPROVAL_REQUIRED" });
  }
  await assert.rejects(f.host.inspectLua({}), { code: "PIPELINE_APPROVAL_REQUIRED" });
  assert.equal(f.starts(), 0);
  assert.deepEqual(await fs.readdir(f.workspace.root), ["snapshot"]);
});

test("Lua snapshot creation detects edits after approval while preserving accepted immutable source", async t => {
  const f = await fixture(t), approval = f.host.identity;
  await fs.writeFile(path.join(f.source, "settings.lua"), "return {count=9}");
  const changed = await createRunWorkspace({ ...f.workspace.snapshot, root: f.source }, { root: path.join(f.root, "runs") });
  t.after(() => disposeRunWorkspace(changed));
  const host = f.createHost({ workspace: changed });
  await assert.rejects(host.inspectLua({ approval }), { code: "PIPELINE_APPROVAL_REQUIRED" });
  assert.equal(f.starts(), 0);
  assert.equal(await fs.readFile(path.join(f.workspace.snapshot.root, "settings.lua"), "utf8"), "return {count=3}");
  const policy = f.createHost({ memoryBytes: 134217728 });
  await assert.rejects(policy.inspectLua({ approval }), { code: "PIPELINE_APPROVAL_REQUIRED" });
  const registry = createRegistry([{ ...definitions[0], implementationHash: "b".repeat(64) }]);
  await assert.rejects(f.createHost({ registry }).inspectLua({ approval }), { code: "PIPELINE_APPROVAL_REQUIRED" });
});

test("Lua coordinator retains request evidence when worker setup needs engine recovery", async t => {
  const f = await fixture(t);
  const host = f.createHost({ runtime: { ...f.boundary, async createWorkspace() {
    throw Object.assign(new Error("unconfirmed setup cleanup"), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  } } });
  await assert.rejects(host.inspectLua({ approval: host.identity }), { code: "PIPELINE_WORKER_RECOVERY_REQUIRED" });
  const retained = (await fs.readdir(f.workspace.root)).filter(name => name.startsWith("lua-"));
  assert.equal(retained.length, 1);
  const request = JSON.parse(await fs.readFile(path.join(f.workspace.root, retained[0], "request.json"), "utf8"));
  assert.equal(request.mode, "inspect");
  assert.equal(request.modules.length, 2);
});

test("Lua invocations share the coordinator's original whole-run deadline", async t => {
  const f = await fixture(t), deadlines = [], before = Date.now();
  const host = f.createHost({ runtime: { ...f.boundary, async createWorkspace(options) {
    deadlines.push(options.deadlineAt);
    throw Object.assign(new Error("admission probe"), { code: "PIPELINE_RUN_DEADLINE" });
  } } });
  const after = Date.now();
  for (let i = 0; i < 2; i++) await assert.rejects(host.inspectLua({ approval: host.identity }), { code: "PIPELINE_RUN_DEADLINE" });
  assert.ok(Number.isSafeInteger(deadlines[0]));
  assert.ok(deadlines[0] >= before + 1800000 && deadlines[0] <= after + 1800000);
  assert.equal(deadlines[1], deadlines[0]);
});

test("Lua approval changes when trusted containment implementation changes", async t => {
  const f = await fixture(t), source = require.resolve("../src/pipeline/lua"), localRequire = createRequire(source);
  const sync = require("node:fs"), module = { exports: {} };
  // Simulate an installed runtime-source update without altering this checkout.
  const changedRequire = id => id === "node:fs" ? { ...sync, readFileSync(file, ...args) {
    const value = sync.readFileSync(file, ...args);
    return file === require.resolve("../src/pipeline/runtime") ? Buffer.concat([value, Buffer.from("\n// changed containment\n")]) : value;
  } } : localRequire(id);
  compileFunction(sync.readFileSync(source, "utf8"), ["require", "module", "__dirname"], { filename: source })(changedRequire, module, path.dirname(source));
  const host = module.exports.createLuaCoordinator({ runtime: f.boundary, workspace: f.workspace, runId: uuidv7(), registry: f.registry });
  await assert.rejects(host.inspectLua({ approval: f.host.identity }), { code: "PIPELINE_APPROVAL_REQUIRED" });
  assert.equal(f.starts(), 0);
});

test("contained Lua planning uses approved defaults and rejects invalid parameters before admission", contained, async t => {
  const f = await fixture(t, { native: true }), approval = f.host.identity;
  const descriptor = await f.host.inspectLua({ approval });
  assert.equal(descriptor.parameterSchema.properties.count.default, 3);
  assert.equal(descriptor.bundleHash, approval.bundleHash);
  const before = f.starts();
  await assert.rejects(f.host.planLua({ approval, descriptor, parameters: { count: 0 } }), { code: "PIPELINE_PARAMETERS_INVALID" });
  assert.equal(f.starts(), before);
  const plan = await f.host.planLua({ approval, descriptor, parameters: {} });
  assert.deepEqual(plan.parameters, { count: 3 });
  assert.equal(plan.steps[0].options.count, 3);
  assert.deepEqual(await fs.readdir(f.workspace.root), ["snapshot"]);
});

test("default Lua transforms can run beyond the five-second planning deadline", contained, async t => {
  const { createLuaAdapter } = require("../src/pipeline/lua");
  const controller = new AbortController();
  let f, plan, timer;
  t.after(() => clearTimeout(timer));
  const plugin = `return {apiVersion=1,pluginId='deadlines',plan=function() return {
    apiVersion=1,pluginId='deadlines',steps={{id='wait',adapter={id='iris.lua',version='1.0.0'},
      options={script='iris.lua',entrypoint='wait'}}},targets={default={steps={'wait'},publish=iris.array{}}}} end,
    wait=function(ctx) ctx.log('info','ready') while true do end end}`;
  f = await fixture(t, { native: true, sources: { "iris.lua": plugin }, adapters: [
    createLuaAdapter({ execute: context => f.host.transformLua({ approval: f.host.identity, plan, context,
      emit: () => { timer = setTimeout(() => controller.abort(), 6500); } }) }),
  ] });
  const descriptor = await f.host.inspectLua({ approval: f.host.identity });
  plan = await f.host.planLua({ approval: f.host.identity, descriptor });
  const result = await executePlan({ plan, target: "default", workspace: f.workspace, registry: f.registry,
    signal: controller.signal, gate: new ConcurrencyGate({ limit: 1 }) });
  assert.equal(result.state, "cancelled", JSON.stringify(result.steps));
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("contained Lua planning rejects a stale cached schema before calling project plan", contained, async t => {
  const f = await fixture(t, { native: true });
  const descriptor = await f.host.inspectLua({ approval: f.host.identity });
  await assert.rejects(f.host.planLua({ approval: f.host.identity, descriptor: {
    ...descriptor, parameterSchema: { type: "object", properties: {} },
  }, parameters: {} }), { code: "PIPELINE_DESCRIPTOR_CHANGED" });
  assert.equal(f.starts(), 1);
});

test("contained Lua planner failure is rejected even when its worker exits zero", contained, async t => {
  const f = await fixture(t, { native: true, sources: {
    "iris.lua": "return {apiVersion=1,pluginId='failure',plan=function() error('failed plan') end}",
  } });
  const descriptor = await f.host.inspectLua({ approval: f.host.identity });
  await assert.rejects(f.host.planLua({ approval: f.host.identity, descriptor, parameters: {} }), { code: "PIPELINE_LUA_EXECUTION_FAILED" });
  assert.deepEqual(await fs.readdir(f.workspace.root), ["snapshot"]);
});

for (const mode of ["inspect", "plan"]) test(`contained Lua ${mode} loops stop at the planning deadline`, contained, async t => {
  const f = await fixture(t, { native: true, sources: { "iris.lua": mode === "inspect" ? "while true do end" :
    "return {apiVersion=1,pluginId='loop',plan=function() while true do end end}" } });
  const approval = f.host.identity;
  const descriptor = mode === "plan" ? await f.host.inspectLua({ approval }) : null;
  const signal = AbortSignal.timeout(12000);
  await assert.rejects(mode === "inspect" ? f.host.inspectLua({ approval, signal }) :
    f.host.planLua({ approval, descriptor, signal }), { code: "PIPELINE_LUA_TIMEOUT" });
  assert.equal(signal.aborted, false, "the planner deadline must precede the outer cancellation");
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("an expired whole-run deadline rejects Lua admission and leaves no worker", contained, async t => {
  const f = await fixture(t, { native: true }), host = f.createHost({ deadlineAt: Date.now() - 1 });
  await assert.rejects(host.inspectLua({ approval: host.identity }), { code: "PIPELINE_RUN_DEADLINE" });
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("Lua coordinator refuses malformed or oversized worker result frames", () => {
  const { parseLuaResponse } = require("../src/pipeline/lua");
  const valid = { version: 1, value: {}, diagnostics: [], logsTruncated: false };
  for (const value of [{ ...valid, version: 2 }, { ...valid, errorCode: "PIPELINE_LUA_EXECUTION_FAILED" },
    { ...valid, errorCode: "bad" }, { ...valid, diagnostics: {} }, { ...valid, privatePath: "/private" },
    { ...valid, value: "x".repeat(1048577) }]) {
    assert.throws(() => parseLuaResponse(Buffer.from(JSON.stringify(value))), { code: "PIPELINE_LUA_RESPONSE_INVALID" });
  }
  assert.throws(() => parseLuaResponse(Buffer.from([255])), { code: "PIPELINE_LUA_RESPONSE_INVALID" });
  assert.deepEqual(parseLuaResponse(Buffer.from(JSON.stringify(valid))), valid);
});

test("Lua transform responses cannot forge diagnostic source identities or locations", () => {
  const { parseLuaResponse } = require("../src/pipeline/lua");
  const options = { mode: "transform", inputs: { source: { files: [{ path: "main.tex" }] } } };
  const diagnostic = { severity: "warning", message: "checked", input: "source", file: "main.tex", line: 1 };
  const frame = item => Buffer.from(JSON.stringify({ version: 1, value: null, diagnostics: [item], logsTruncated: false }));
  assert.deepEqual(parseLuaResponse(frame(diagnostic), undefined, options).diagnostics, [diagnostic]);
  for (const item of [{ ...diagnostic, sourceFileId: uuidv7() }, { ...diagnostic, file: "../outside" },
    { ...diagnostic, input: "unknown" }, { ...diagnostic, line: 0 }, { ...diagnostic, generatedSource: {} }]) {
    assert.throws(() => parseLuaResponse(frame(item), undefined, options), { code: "PIPELINE_DIAGNOSTICS_INVALID" });
  }
});

test("descriptor validation rejects an explicit null schema rather than inventing parameter metadata", () => {
  const { validateDescriptor } = require("../src/pipeline/contracts");
  assert.throws(() => validateDescriptor({ apiVersion: 1, pluginId: "null", parameterSchema: null }), { code: "PIPELINE_SCHEMA_INVALID" });
});

test("contained Lua transforms preserve binary products and bind source/generated diagnostics", contained, async t => {
  const { createLuaAdapter } = require("../src/pipeline/lua");
  let f, plan;
  const events = [], bytes = Buffer.from([0, 255, 128, 10]);
  const plugin = `local schema={type='object',properties={suffix={type='string',default='!'}}}
    return {apiVersion=1,pluginId='binary',parameterSchema=schema,
      plan=function(ctx) return {apiVersion=1,pluginId='binary',parameterSchema=schema,steps={
        {id='generate',adapter={id='iris.lua',version='1.0.0'},inputs={source={snapshot=true}},
          options={script='iris.lua',entrypoint='generate',options={suffix='?'}},
          outputs={out={kind='file',mediaType='application/octet-stream',path='generated/bytes.bin'}}},
        {id='check',adapter={id='iris.lua',version='1.0.0'},inputs={generated={step='generate',port='out'}},
          options={script='iris.lua',entrypoint='check'},
          outputs={out={kind='file',mediaType='application/octet-stream',path='checked/bytes.bin'}}}},
        targets={default={steps={'check'},publish={{step='check',port='out'}}}}} end,
      generate=function(ctx)
        ctx.write('out','generated/bytes.bin',ctx.read('source','bytes.bin')..ctx.options.parameters.suffix..ctx.options.step.suffix)
        ctx.diagnostic({severity='warning',message='original',input='source',file='bytes.bin',line=1})
      end,
      check=function(ctx)
        ctx.write('out','checked/bytes.bin',ctx.read('generated','generated/bytes.bin'))
        ctx.diagnostic({severity='warning',message='generated',input='generated',file='generated/bytes.bin',line=1})
        ctx.log('info','checked output')
      end}`;
  f = await fixture(t, { native: true, sources: { "iris.lua": plugin, "bytes.bin": bytes }, adapters: [
    createLuaAdapter({ execute: context => f.host.transformLua({ approval: f.host.identity, plan, context, emit: event => events.push(event) }) }),
  ] });
  const descriptor = await f.host.inspectLua({ approval: f.host.identity });
  plan = await f.host.planLua({ approval: f.host.identity, descriptor });
  const products = [];
  const result = await executePlan({ plan, target: "default", workspace: f.workspace, registry: f.registry,
    gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }), onArtifacts: async (context, artifacts) => products.push(...artifacts) });
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.deepEqual(await fs.readFile(path.join(result.artifacts[0].root, result.artifacts[0].path)), Buffer.concat([bytes, Buffer.from("!?")]));
  const source = f.workspace.snapshot.files.find(file => file.path === "bytes.bin");
  assert.equal(result.steps[0].diagnostics[0].sourceFileId, source.id);
  assert.equal(result.steps[0].diagnostics[0].sourceContentHash, hash(bytes));
  assert.deepEqual(result.steps[1].diagnostics[0].generatedSource, {
    artifactId: products[0].id, producerStep: "generate", outputPort: "out", path: "generated/bytes.bin", contentHash: hash(Buffer.concat([bytes, Buffer.from("!?")])),
  });
  assert.equal(result.steps[1].diagnostics[0].sourceFileId, undefined);
  assert.equal(result.steps[1].diagnostics[0].input, undefined);
  assert.deepEqual(events, [{ stepId: "check", level: "info", message: "checked output" }]);
  assert.deepEqual(f.admissions, ["inspect", "plan", "generate", "check"]);
});

for (const corruptReply of [false, true]) test(`contained Lua failure retains diagnostics with ${corruptReply ? "a changed final reply" : "a matching final reply"}`, contained, async t => {
  const { createLuaAdapter } = require("../src/pipeline/lua");
  let f, plan;
  const plugin = `return {apiVersion=1,pluginId='failure',plan=function() return {
    apiVersion=1,pluginId='failure',steps={{id='fail',adapter={id='iris.lua',version='1.0.0'},
      options={script='iris.lua',entrypoint='fail'},outputs={out={kind='file',mediaType='text/plain',path='out.txt'}}}},
    targets={default={steps={'fail'},publish={{step='fail',port='out'}}}}} end,
    fail=function(ctx) ctx.write('out','out.txt','partial')
      ctx.diagnostic({severity='error',message='retained failure'}) error('stop') end}`;
  f = await fixture(t, { native: true, sources: { "iris.lua": plugin }, adapters: [
    createLuaAdapter({ execute: context => f.host.transformLua({ approval: f.host.identity, plan, context }) }),
  ] });
  if (corruptReply) f.host = f.createHost({ runtime: { ...f.boundary, async exportWorkspace(options) {
    const exported = await f.boundary.exportWorkspace(options);
    if (options.workspace.stepId !== "fail" || options.directory !== "response") return exported;
    const file = exported.files[0], full = path.join(exported.root, file.path);
    const response = JSON.parse(await fs.readFile(full, "utf8"));
    response.diagnostics = [];
    const bytes = JSON.stringify(response);
    await fs.chmod(full, 0o600); await fs.writeFile(full, bytes);
    return { ...exported, files: [{ ...file, size: Buffer.byteLength(bytes), contentHash: hash(bytes) }] };
  } } });
  const descriptor = await f.host.inspectLua({ approval: f.host.identity });
  plan = await f.host.planLua({ approval: f.host.identity, descriptor });
  const result = await executePlan({ plan, target: "default", workspace: f.workspace, registry: f.registry,
    gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }) });
  assert.equal(result.state, "failed");
  assert.equal(result.steps[0].errorCode, corruptReply ? "PIPELINE_DIAGNOSTICS_CHANGED" : "PIPELINE_LUA_EXECUTION_FAILED");
  assert.deepEqual(result.steps[0].diagnostics, [{ severity: "error", message: "retained failure", stepId: "fail" }]);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(await fs.readdir(path.join(f.workspace.root, "steps/fail/output")), []);
});

test("Lua timeout retains a live diagnostic after log saturation and publishes no product", contained, async t => {
  const { createLuaAdapter } = require("../src/pipeline/lua");
  let f, plan;
  const logs = [], progress = [];
  const plugin = `return {apiVersion=1,pluginId='timeout',plan=function() return {
    apiVersion=1,pluginId='timeout',steps={{id='wait',adapter={id='iris.lua',version='1.0.0'},
      options={script='iris.lua',entrypoint='wait'}}},targets={default={steps={'wait'},publish=iris.array{}}}} end,
    wait=function(ctx)
      for i=1,100 do ctx.log('info',string.rep('x',60000)) end
      ctx.diagnostic({severity='warning',message='before timeout'})
      while true do end
    end}`;
  f = await fixture(t, { native: true, sources: { "iris.lua": plugin }, adapters: [
    createLuaAdapter({ execute: context => f.host.transformLua({ approval: f.host.identity, plan, context, emit: event => logs.push(event) }) }),
  ] });
  const descriptor = await f.host.inspectLua({ approval: f.host.identity });
  plan = await f.host.planLua({ approval: f.host.identity, descriptor });
  const result = await executePlan({ plan, target: "default", workspace: f.workspace, registry: f.registry,
    gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }), emit: event => progress.push(structuredClone(event)) });
  assert.equal(result.state, "failed");
  assert.equal(result.steps[0].errorCode, "PIPELINE_LUA_TIMEOUT");
  assert.deepEqual(result.steps[0].diagnostics, [{ severity: "warning", message: "before timeout", stepId: "wait" }]);
  assert.deepEqual(progress[1], { stepId: "wait", diagnostic: result.steps[0].diagnostics[0] });
  assert.equal(logs.length, 17);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
});

test("cancelling a running Lua transform drains its worker and prevents partial product export", contained, async t => {
  const { createLuaAdapter } = require("../src/pipeline/lua");
  let f, plan;
  const controller = new AbortController(), events = [], progress = [];
  const plugin = `return {apiVersion=1,pluginId='cancel',plan=function() return {
    apiVersion=1,pluginId='cancel',steps={{id='wait',adapter={id='iris.lua',version='1.0.0'},
      options={script='iris.lua',entrypoint='wait'},outputs={out={kind='file',mediaType='text/plain',path='out.txt'}}}},
    targets={default={steps={'wait'},publish={{step='wait',port='out'}}}}} end,
    wait=function(ctx) ctx.write('out','out.txt','partial')
      ctx.diagnostic({severity='warning',message='before cancellation'})
      ctx.log('info','ready') while true do end end}`;
  f = await fixture(t, { native: true, sources: { "iris.lua": plugin }, adapters: [
    createLuaAdapter({ execute: context => f.host.transformLua({ approval: f.host.identity, plan, context,
      emit: event => { events.push(event); controller.abort(); } }) }),
  ] });
  const descriptor = await f.host.inspectLua({ approval: f.host.identity });
  plan = await f.host.planLua({ approval: f.host.identity, descriptor });
  const result = await executePlan({ plan, target: "default", workspace: f.workspace, registry: f.registry,
    signal: controller.signal, gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }), emit: event => progress.push(structuredClone(event)) });
  assert.equal(result.state, "cancelled", JSON.stringify(result.steps));
  assert.equal(result.steps[0].state, "cancelled");
  assert.deepEqual(events, [{ stepId: "wait", level: "info", message: "ready" }]);
  assert.deepEqual(result.steps[0].diagnostics, [{ severity: "warning", message: "before cancellation", stepId: "wait" }]);
  assert.deepEqual(progress[1], { stepId: "wait", diagnostic: result.steps[0].diagnostics[0] });
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(await fs.readdir(path.join(f.workspace.root, "steps/wait/output")), []);
  assert.deepEqual(await fs.readdir(path.join(f.root, "runtime")), ["installation.json"]);
  assert.deepEqual((await fs.readdir(f.workspace.root)).sort(), ["snapshot", "steps"]);
});
