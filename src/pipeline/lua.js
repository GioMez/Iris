const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isUuid } = require("../ids");
const { LUA_DATA_POLICY, readPolicy, cloneValue, canonical, freeze, fail, record, logicalPath,
  validateDescriptor, validateParameters, validatePlan } = require("./contracts");
const { openCheckedFile, readWorkspaceLimits } = require("./workspaces");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => hash(canonical(value));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const workerPath = "/opt/iris/src/pipeline/lua-worker.js";
const implementationHash = digest(["lua.js", "lua-worker.js", "lua-io.js", "lua-vm.js", "lua-bootstrap.lua", "contracts.js",
  "runtime.js", "transfers.js", "workspaces.js"].map(file => [file, hash(readFileSync(path.join(__dirname, file)))]));

// The snapshot owner has already hashed byte-exact authoritative source. All
// Lua files enter approval, including modules the current target does not load.
function luaBundle(snapshot, script = "iris.lua") {
  logicalPath(script, "PIPELINE_SCRIPT_INVALID");
  const modules = cloneValue(snapshot.files.filter(file => /\.lua$/i.test(file.path))
    .map(({ path, size, contentHash }) => ({ path, size, contentHash })), LUA_DATA_POLICY, "PIPELINE_BUNDLE_INVALID");
  const seen = new Set();
  for (const file of modules) {
    logicalPath(file.path, "PIPELINE_BUNDLE_INVALID");
    if (seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.contentHash)) {
      fail("PIPELINE_BUNDLE_INVALID", "Invalid Lua bundle member");
    }
    seen.add(file.path);
  }
  if (!seen.has(script)) fail("PIPELINE_SCRIPT_MISSING", "Pipeline entry module is missing");
  modules.sort((a, b) => compare(a.path, b.path));
  return freeze({ script, modules, bundleHash: digest({ version: 1, script, modules }) });
}

function parseLuaResponse(bytes, policy = readPolicy()) {
  const code = "PIPELINE_LUA_RESPONSE_INVALID";
  if (!Buffer.isBuffer(bytes) || bytes.length > policy.maxPlanBytes + 1024) fail(code, "Lua response exceeds its byte limit");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(code, "Invalid Lua response JSON"); }
  const response = cloneValue(parsed, { ...policy, maxPlanBytes: policy.maxPlanBytes + 1024,
    maxValues: policy.maxValues + 16, maxDepth: policy.maxDepth + 1 }, code);
  record(response, ["version", "value", "errorCode", "diagnostics", "logsTruncated"], code, "Lua response");
  if (response.version !== 1 || !Array.isArray(response.diagnostics) || response.diagnostics.length
    || response.logsTruncated !== false || Object.hasOwn(response, "value") === Object.hasOwn(response, "errorCode")) fail(code, "Invalid planner response");
  if (Object.hasOwn(response, "errorCode")) {
    if (typeof response.errorCode !== "string" || !/^PIPELINE_[A-Z0-9_]{1,55}$/.test(response.errorCode)) fail(code, "Invalid Lua failure code");
  } else cloneValue(response.value, policy, code);
  return response;
}

function metadata(value) {
  return Object.fromEntries(["apiVersion", "pluginId", "parameterSchema", "requiredCapabilities"]
    .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function createLuaCoordinator({ runtime, workspace, runId, registry, policy: overrides, limits = {}, memoryBytes = 268435456, deadlineAt }) {
  const policy = readPolicy(overrides), budget = readWorkspaceLimits(limits), bundle = luaBundle(workspace.snapshot);
  if (!isUuid(runId) || !Number.isSafeInteger(memoryBytes) || memoryBytes < 1) fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua coordinator configuration");
  const registryManifest = registry.manifest();
  const capabilities = [...new Set(registryManifest.flatMap(entry => entry.capabilities))].sort(compare);
  const identity = freeze({ bundleHash: bundle.bundleHash,
    policyHash: digest({ version: 1, runtime: runtime.manifest(), policy, limits: budget, memoryBytes, workerPath, implementationHash }),
    registryHash: digest([...registryManifest].sort((a, b) => compare(`${a.id}@${a.version}`, `${b.id}@${b.version}`))) });
  function approved(approval) {
    if (!approval || Object.entries(identity).some(([key, value]) => approval[key] !== value)) fail("PIPELINE_APPROVAL_REQUIRED", "Exact Lua bundle approval is required");
  }
  function descriptor(value) {
    const result = validateDescriptor(value, { policy });
    if (result.requiredCapabilities.some(item => !capabilities.includes(item))) fail("PIPELINE_CAPABILITY_UNAVAILABLE", "Required plugin capability is unavailable");
    return result;
  }
  function bind(value) {
    const result = { ...descriptor(value), ...identity };
    return freeze({ ...result, descriptorHash: digest(result) });
  }
  function cached(value) {
    const copy = cloneValue(value, policy, "PIPELINE_DESCRIPTOR_INVALID");
    record(copy, ["apiVersion", "pluginId", "parameterSchema", "requiredCapabilities", "bundleHash", "policyHash", "registryHash", "descriptorHash"],
      "PIPELINE_DESCRIPTOR_INVALID", "cached descriptor");
    const normalized = bind(metadata(copy));
    if (canonical(normalized) !== canonical(copy)) fail("PIPELINE_DESCRIPTOR_CHANGED", "Cached plugin descriptor identity changed");
    return metadata(normalized);
  }
  async function invoke(mode, extra, signal) {
    signal?.throwIfAborted();
    const request = cloneValue({ version: 1, mode, script: bundle.script, modules: bundle.modules,
      policy, limits: budget, memoryBytes, ...extra }, LUA_DATA_POLICY, "PIPELINE_LUA_REQUEST_INVALID");
    const bytes = Buffer.from(JSON.stringify(request));
    const root = await fs.mkdtemp(path.join(workspace.root, "lua-"));
    let worker, recoveryRequired = false;
    try {
      const directories = new Set(["modules"]);
      const files = bundle.modules.map(file => {
        const relative = `modules/${file.path}`, parts = relative.split("/");
        for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
        return { ...file, path: relative, source: { root: workspace.snapshot.root, path: file.path } };
      });
      for (const relative of directories) await fs.mkdir(path.join(root, relative), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(root, "request.json"), bytes, { flag: "wx", mode: 0o400 });
      files.push({ path: "request.json", size: bytes.length, contentHash: hash(bytes) });
      worker = await runtime.createWorkspace({ runId, stepId: mode, input: { root, files, directories: [...directories] }, signal,
        ...(deadlineAt === undefined ? {} : { deadlineAt }) });
      const result = await runtime.runContained({ workspace: worker, tool: runtime.resolveTool("lua-worker"), args: [workerPath], signal });
      signal?.throwIfAborted();
      if (result.drained !== true) fail("PIPELINE_WORKER_RECOVERY_REQUIRED", "Lua worker drain is unconfirmed");
      if (result.timedOut) fail("PIPELINE_LUA_TIMEOUT", "Lua worker timed out");
      if (result.oomKilled) fail("PIPELINE_LUA_MEMORY_LIMIT", "Lua worker memory limit exceeded");
      if (result.cancelled || result.code !== 0 || result.signal) fail("PIPELINE_LUA_WORKER_FAILED", "Lua worker failed");
      const exported = await runtime.exportWorkspace({ workspace: worker, directory: "response", destination: path.join(root, "reply"), signal });
      if (exported.files.length !== 1 || exported.files[0].path !== "response/result.json"
        || exported.directories.some(dir => dir !== "response")) fail("PIPELINE_LUA_RESPONSE_INVALID", "Unexpected Lua response files");
      const file = exported.files[0];
      const { input, before } = await openCheckedFile(exported.root, file.path);
      let reply;
      try {
        if (before.size > policy.maxPlanBytes + 1024) fail("PIPELINE_LUA_RESPONSE_INVALID", "Lua response exceeds its byte limit");
        reply = await input.readFile();
      } finally { await input.close(); }
      if (reply.length !== file.size || hash(reply) !== file.contentHash) fail("PIPELINE_INPUT_CHANGED", "Lua response identity changed");
      const response = parseLuaResponse(reply, policy);
      if (response.errorCode) fail(response.errorCode, "Lua worker rejected the request");
      return response.value;
    } catch (error) {
      recoveryRequired = error.code === "PIPELINE_WORKER_RECOVERY_REQUIRED";
      throw error;
    } finally {
      // Keep staging evidence if engine cleanup cannot be confirmed.
      if (worker) await runtime.disposeWorkspace(worker);
      if (!recoveryRequired) await fs.rm(root, { recursive: true, force: true });
    }
  }
  return Object.freeze({ identity,
    async inspectLua({ approval, signal } = {}) {
      approved(approval);
      return bind(await invoke("inspect", { context: {} }, signal));
    },
    async planLua({ approval, descriptor: value, parameters = {}, signal }) {
      approved(approval);
      const expected = cached(value), normalized = validateParameters(expected.parameterSchema, parameters, { policy });
      const { files, directories, settings } = workspace.snapshot;
      const source = await invoke("plan", { expectedDescriptor: expected, context: { parameters: normalized, capabilities,
        snapshot: { files, directories, settings, snapshotHash: workspace.snapshotHash } } }, signal);
      record(source, null, "PIPELINE_PLAN_INVALID", "pipeline plan");
      if (canonical(descriptor(metadata(source))) !== canonical(expected)) fail("PIPELINE_DESCRIPTOR_CHANGED", "Planner changed plugin metadata");
      if (source.parameters !== undefined && canonical(source.parameters) !== canonical(normalized)) fail("PIPELINE_PARAMETERS_CHANGED", "Planner changed normalized parameters");
      return validatePlan({ ...source, parameters: normalized }, { registry, policy });
    },
  });
}

module.exports = { luaBundle, parseLuaResponse, createLuaCoordinator };
