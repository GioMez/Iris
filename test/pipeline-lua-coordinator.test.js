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

async function fixture(t, { native = false, sources = { "iris.lua": script, "settings.lua": "return {count=3}" } } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-lua-host-"));
  const source = path.join(root, "source"); await fs.mkdir(source);
  const files = [];
  for (const [relative, bytes] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await fs.writeFile(path.join(source, relative), bytes);
    files.push({ id: uuidv7(), path: relative });
  }
  const workspace = await createRunWorkspace({ root: source, files, directories: [], settings: {} }, { root: path.join(root, "runs") });
  let runtime, starts = 0;
  t.after(async () => { await runtime?.close(); await disposeRunWorkspace(workspace); await fs.rm(root, { recursive: true }); });
  const policy = readRuntimePolicy({ image: image || `sha256:${"a".repeat(64)}`, memoryBytes: 268435456, totalMemoryBytes: 335544320,
    outputBytes: 16777216, tempBytes: 8388608, outputEntries: 1024, tempEntries: 64 });
  const tools = [{ id: "lua-worker", path: "/usr/local/bin/node", timeoutMs: 5000 }];
  if (native) runtime = await createPodmanRuntime({ root: path.join(root, "runtime"), coordinatorId: uuidv7(),
    transport: { connection: process.env.IRIS_TEST_PODMAN_CONNECTION, home: process.env.IRIS_TEST_PODMAN_HOME }, policy, tools });
  const boundary = native ? { ...runtime, createWorkspace: options => { starts++; return runtime.createWorkspace(options); } } : {
    manifest: () => ({ policy, tools }), createWorkspace() { starts++; throw new Error("Unexpected worker admission"); },
  };
  const { createLuaCoordinator } = require("../src/pipeline/lua");
  const registry = createRegistry(definitions);
  const createHost = options => createLuaCoordinator({ runtime: boundary, workspace, runId: uuidv7(), registry, ...options });
  const host = createHost();
  return { host, createHost, workspace, root, source, registry, boundary, starts: () => starts };
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

test("descriptor validation rejects an explicit null schema rather than inventing parameter metadata", () => {
  const { validateDescriptor } = require("../src/pipeline/contracts");
  assert.throws(() => validateDescriptor({ apiVersion: 1, pluginId: "null", parameterSchema: null }), { code: "PIPELINE_SCHEMA_INVALID" });
});
