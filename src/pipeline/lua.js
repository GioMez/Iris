const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { isDeepStrictEqual } = require("node:util");
const { isUuid } = require("../ids");
const { LUA_DATA_POLICY, readPolicy, cloneValue, canonical, freeze, fail, record, logicalPath,
  validateDescriptor, bindDescriptor, validateBoundDescriptor, validateParameters, validatePlan, validateLuaDiagnostic } = require("./contracts");
const { openCheckedFile, readWorkspaceLimits } = require("./workspaces");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => hash(canonical(value));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const workerPath = path.join(__dirname, "lua-worker.js");
// One MiB of diagnostics plus JSON-line envelopes for at most 1,000 events.
const protocolBytes = 1048576 + 16000;
const implementationHash = digest(["lua.js", "lua-worker.js", "lua-io.js", "lua-vm.js", "lua-bootstrap.lua", "lua-process.lua", "vendor/dkjson.lua", "contracts.js",
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

function parseLuaResponse(bytes, policy = readPolicy(), { mode = "plan", inputs = {} } = {}) {
  const code = "PIPELINE_LUA_RESPONSE_INVALID";
  const diagnosticBudget = mode === "transform" ? 1048576 : 0;
  if (!Buffer.isBuffer(bytes) || bytes.length > policy.maxPlanBytes + diagnosticBudget + 1024) fail(code, "Lua response exceeds its byte limit");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail(code, "Invalid Lua response JSON"); }
  const response = cloneValue(parsed, { ...policy, maxPlanBytes: policy.maxPlanBytes + diagnosticBudget + 1024,
    maxValues: policy.maxValues + 12016, maxDepth: policy.maxDepth + 1 }, code);
  record(response, ["version", "value", "errorCode", "diagnostics", "logsTruncated"], code, "Lua response");
  if (response.version !== 1 || !Array.isArray(response.diagnostics) || response.diagnostics.length > 1000
    || typeof response.logsTruncated !== "boolean" || Object.hasOwn(response, "value") === Object.hasOwn(response, "errorCode")) fail(code, "Invalid Lua response");
  if (mode !== "transform" && (response.diagnostics.length || response.logsTruncated)) fail(code, "Invalid planner response");
  if (mode === "transform") {
    if (Buffer.byteLength(JSON.stringify(response.diagnostics)) > diagnosticBudget) fail("PIPELINE_DIAGNOSTICS_LIMIT", "Lua diagnostics exceed their byte limit");
    const members = new Map(Object.entries(inputs).map(([key, input]) => [key, new Set(input.files.map(file => file.path))]));
    response.diagnostics = response.diagnostics.map(item => validateLuaDiagnostic(item, { policy, hasMember: (input, file) => members.get(input)?.has(file) }));
  }
  if (Object.hasOwn(response, "errorCode")) {
    if (typeof response.errorCode !== "string" || !/^PIPELINE_[A-Z0-9_]{1,55}$/.test(response.errorCode)) fail(code, "Invalid Lua failure code");
  } else cloneValue(response.value, policy, code);
  return response;
}

function metadata(value) {
  return Object.fromEntries(["apiVersion", "pluginId", "parameterSchema", "requiredCapabilities"]
    .filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

function createLuaCoordinator({ runtime, workspace, runId, registry, policy: overrides, limits = {}, deadlineAt }) {
  const policy = readPolicy(overrides), budget = readWorkspaceLimits(limits), bundle = luaBundle(workspace.snapshot);
  if (!isUuid(runId)) fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua coordinator configuration");
  const registryManifest = registry.manifest();
  const runtimeManifest = runtime.manifest();
  deadlineAt ??= Date.now() + runtimeManifest.policy.runTimeoutMs;
  if (!Number.isSafeInteger(deadlineAt)) fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua run deadline");
  const maxLogBytes = Math.min(1048576, runtimeManifest.policy.logBytes);
  if (!["lua-planner", "lua-transform"].every(id => runtimeManifest.tools.find(tool => tool.id === id)?.protocolBytes >= protocolBytes)) {
    fail("PIPELINE_TOOL_INVALID", "Lua worker requires bounded diagnostic transport");
  }
  const plans = new WeakSet();
  const capabilities = [...new Set(registryManifest.flatMap(entry => entry.capabilities))].sort(compare);
  const identity = freeze({ bundleHash: bundle.bundleHash,
    policyHash: digest({ version: 1, runtime: runtimeManifest, policy, limits: budget, workerPath, implementationHash }),
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
    return bindDescriptor(descriptor(value), identity, { policy });
  }
  function cached(value) {
    return descriptor(metadata(validateBoundDescriptor(value, { identity, policy })));
  }
  async function invoke(mode, extra, signal, { context, emit = async () => {}, reportDiagnostic = async () => {} } = {}) {
    signal?.throwIfAborted();
    const tool = runtime.resolveTool(mode === "transform" ? "lua-transform" : "lua-planner");
    const request = cloneValue({ version: 1, mode, script: bundle.script, modules: bundle.modules,
      policy, limits: budget, eventLimits: { maxLogBytes }, timeoutMs: tool.timeoutMs, ...extra }, LUA_DATA_POLICY, "PIPELINE_LUA_REQUEST_INVALID");
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
      if (context) for (const [key, input] of Object.entries(context.inputs)) {
        directories.add(`inputs/${key}`);
        for (const dir of input.directories) directories.add(`inputs/${key}/${dir}`);
        for (const file of input.files) {
          const relative = `inputs/${key}/${file.path}`, parts = relative.split("/");
          for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
          files.push({ path: relative, size: file.size, contentHash: file.contentHash, source: { root: input.root, path: file.path } });
        }
      }
      for (const relative of directories) await fs.mkdir(path.join(root, relative), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(root, "request.json"), bytes, { flag: "wx", mode: 0o400 });
      files.push({ path: "request.json", size: bytes.length, contentHash: hash(bytes) });
      worker = await runtime.createWorkspace({ runId, stepId: context?.step.id || mode, input: { root, files, directories: [...directories] }, signal,
        deadlineAt });
      const decoder = new StringDecoder("utf8");
      const streamedDiagnostics = [], members = new Map(Object.entries(context?.inputs || {}).map(([key, input]) => [key, new Set(input.files.map(file => file.path))]));
      let pending = "", streamBytes = 0, logBytes = 0, logCount = 0, diagnosticBytes = 2;
      const result = await runtime.runTool({ workspace: worker, tool, args: [workerPath, worker.inputRoot, worker.workRoot], signal,
        outputLimitBytes: maxLogBytes + protocolBytes,
        onOutput: context ? async (chunk, channel) => {
          if (channel !== "stdout") return;
          streamBytes += chunk.length;
          if (streamBytes > maxLogBytes + protocolBytes) fail("PIPELINE_LUA_RESPONSE_INVALID", "Lua events exceed their byte limit");
          pending += decoder.write(chunk);
          for (let end; (end = pending.indexOf("\n")) !== -1;) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            let event;
            try { event = JSON.parse(line); } catch { fail("PIPELINE_LOG_INVALID", "Invalid Lua log JSON"); }
            event = cloneValue(event, policy, "PIPELINE_LOG_INVALID");
            if (Object.hasOwn(event, "diagnostic")) {
              record(event, ["diagnostic"], "PIPELINE_DIAGNOSTICS_INVALID", "Lua diagnostic event");
              const item = validateLuaDiagnostic(event.diagnostic, { policy, hasMember: (input, file) => members.get(input)?.has(file) });
              diagnosticBytes += Buffer.byteLength(JSON.stringify(item)) + (streamedDiagnostics.length ? 1 : 0);
              if (diagnosticBytes > 1048576 || streamedDiagnostics.length >= 1000) fail("PIPELINE_DIAGNOSTICS_LIMIT", "Lua diagnostics exceed their limit");
              streamedDiagnostics.push(item);
              await reportDiagnostic(item);
              continue;
            }
            record(event, ["level", "message"], "PIPELINE_LOG_INVALID", "Lua log");
            logBytes += Buffer.byteLength(line) + 1;
            if (logBytes > maxLogBytes) fail("PIPELINE_LOG_INVALID", "Lua logs exceed their byte limit");
            if (++logCount > 1000 || !["debug", "info", "warning", "error"].includes(event.level) || typeof event.message !== "string") fail("PIPELINE_LOG_INVALID", "Invalid Lua log");
            await emit({ stepId: context.step.id, ...event });
          }
        } : undefined });
      signal?.throwIfAborted();
      if (result.drained !== true) fail("PIPELINE_WORKER_RECOVERY_REQUIRED", "Lua worker drain is unconfirmed");
      if (result.timedOut) fail("PIPELINE_LUA_TIMEOUT", "Lua worker timed out");
      if (result.outputLimited || result.truncated) fail("PIPELINE_LUA_RESPONSE_INVALID", "Lua worker event transport exceeded its limit");
      if (result.cancelled || result.code !== 0 || result.signal) fail("PIPELINE_LUA_WORKER_FAILED", "Lua worker failed");
      if (context && !result.truncated && (pending + decoder.end()).length) fail("PIPELINE_LOG_INVALID", "Incomplete Lua log record");
      const exported = await runtime.exportWorkspace({ workspace: worker, directory: "response", destination: path.join(root, "reply"), signal });
      if (exported.files.length !== 1 || exported.files[0].path !== "response/result.json"
        || exported.directories.some(dir => dir !== "response")) fail("PIPELINE_LUA_RESPONSE_INVALID", "Unexpected Lua response files");
      const file = exported.files[0];
      const { input, before } = await openCheckedFile(exported.root, file.path);
      let reply;
      try {
        if (before.size > policy.maxPlanBytes + (context ? 1048576 : 0) + 1024) fail("PIPELINE_LUA_RESPONSE_INVALID", "Lua response exceeds its byte limit");
        reply = await input.readFile();
      } finally { await input.close(); }
      if (reply.length !== file.size || hash(reply) !== file.contentHash) fail("PIPELINE_INPUT_CHANGED", "Lua response identity changed");
      const response = parseLuaResponse(reply, policy, { mode, inputs: context?.inputs });
      if (context && !isDeepStrictEqual(response.diagnostics, streamedDiagnostics)) fail("PIPELINE_DIAGNOSTICS_CHANGED", "Lua final diagnostics differ from their stream");
      response.logsTruncated ||= result.truncated;
      if (context) {
        if (!response.errorCode) {
          const output = await runtime.exportWorkspace({ workspace: worker, directory: "output", destination: path.join(root, "products"), signal });
          // The executor created an empty output directory. Rename the checked
          // export into it; validateOutputs seals and hashes the artifacts next.
          await fs.rename(path.join(output.root, "output"), context.outputDir);
        }
      } else if (response.errorCode) fail(response.errorCode, "Lua worker rejected the request");
      return response;
    } catch (error) {
      recoveryRequired = error.code === "PIPELINE_WORKER_RECOVERY_REQUIRED";
      throw error;
    } finally {
      // Keep staging evidence if worker cleanup cannot be confirmed.
      try {
        if (worker) await runtime.disposeWorkspace(worker);
        if (!recoveryRequired) await fs.rm(root, { recursive: true, force: true });
      } catch {
        fail("PIPELINE_WORKER_RECOVERY_REQUIRED", "Lua worker cleanup is unconfirmed");
      }
    }
  }
  return Object.freeze({ identity,
    async inspectLua({ approval, signal } = {}) {
      approved(approval);
      return bind((await invoke("inspect", { context: {} }, signal)).value);
    },
    async planLua({ approval, descriptor: value, parameters = {}, signal }) {
      approved(approval);
      const expected = cached(value), normalized = validateParameters(expected.parameterSchema, parameters, { policy });
      const { files, directories, settings } = workspace.snapshot;
      const source = (await invoke("plan", { expectedDescriptor: expected, context: { parameters: normalized, capabilities,
        snapshot: { files, directories, settings, snapshotHash: workspace.snapshotHash } } }, signal)).value;
      record(source, null, "PIPELINE_PLAN_INVALID", "pipeline plan");
      if (canonical(descriptor(metadata(source))) !== canonical(expected)) fail("PIPELINE_DESCRIPTOR_CHANGED", "Planner changed plugin metadata");
      if (source.parameters !== undefined && canonical(source.parameters) !== canonical(normalized)) fail("PIPELINE_PARAMETERS_CHANGED", "Planner changed normalized parameters");
      const plan = validatePlan({ ...source, parameters: normalized }, { registry, policy });
      plans.add(plan); return plan;
    },
    async transformLua({ approval, plan, context, emit }) {
      approved(approval);
      if (!plans.has(plan) || !plan.steps.some(step => step.id === context.step.id && canonical(step) === canonical(context.step))) {
        fail("PIPELINE_PLAN_INVALID", "Lua transform requires its approved validated plan");
      }
      const { script, entrypoint, options = {} } = context.options;
      if (!bundle.modules.some(file => file.path === script)) fail("PIPELINE_APPROVAL_REQUIRED", "Lua transform module is outside its approved bundle");
      const inputs = Object.fromEntries(Object.entries(context.inputs).map(([key, input]) => [key, {
        kind: input.kind, mediaType: input.mediaType, files: input.files.map(({ id, path, size, contentHash }) => ({ id, path, size, contentHash })),
      }]));
      const members = new Map(Object.entries(context.inputs).map(([key, input]) => [key, new Map(input.files.map(file => [file.path, file]))]));
      function bindDiagnostic({ input, ...item }) {
        const source = input === undefined ? null : members.get(input).get(item.file);
        const location = !source ? {} : source.producerStep ? {
          generatedSource: { artifactId: source.id, producerStep: source.producerStep, outputPort: source.outputPort,
            path: source.path, contentHash: source.contentHash },
        } : { sourceFileId: source.id, sourceRevisionId: source.sourceRevisionId, sourceContentHash: source.contentHash };
        return { ...item, stepId: context.step.id, ...location };
      }
      const response = await invoke("transform", { script, entrypoint, inputs, outputs: context.step.outputs,
        context: { options: { parameters: plan.parameters, step: options } } }, context.signal, {
        context, emit, reportDiagnostic: item => context.reportDiagnostic(bindDiagnostic(item)),
      });
      const diagnostics = response.diagnostics.map(bindDiagnostic);
      return { diagnostics, logsTruncated: response.logsTruncated, ...(response.errorCode ? { errorCode: response.errorCode } : {}) };
    },
  });
}

function createLuaAdapter({ execute }) {
  return { id: "iris.lua", version: "1.0.0", implementationHash, capabilities: ["transform.lua"], execute,
    optionsSchema: { type: "object", required: ["script", "entrypoint"], properties: {
      script: { type: "string", minLength: 1, maxLength: 500 }, entrypoint: { type: "string", minLength: 1, maxLength: 64 },
      options: { type: "object", additionalProperties: true },
    } },
    additionalInputs: { kinds: ["file", "collection", "layout"], mediaTypes: ["*/*"] },
    additionalOutputs: { kinds: ["file", "collection"], mediaTypes: ["*/*"] },
  };
}

function createLuaTools({ planningTimeoutMs = 5000, transformTimeoutMs = 30000, luaBinPath = process.env.LUA_BIN_PATH || "" } = {}) {
  const bin = luaBinPath ? path.resolve(luaBinPath) : "", env = { LUA_BIN_PATH: bin };
  const dependencies = [bin ? path.join(bin, "lua") : "lua"];
  return [
    { id: "lua-planner", path: process.execPath, timeoutMs: planningTimeoutMs, protocolBytes, env, dependencies },
    { id: "lua-transform", path: process.execPath, timeoutMs: transformTimeoutMs, protocolBytes, env, dependencies },
  ];
}

module.exports = { luaBundle, parseLuaResponse, createLuaCoordinator, createLuaAdapter, createLuaTools };
