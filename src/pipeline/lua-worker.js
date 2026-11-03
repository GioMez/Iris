const fs = require("node:fs");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

// Private file protocol. The coordinator stages this tree through the runtime's
// checked transfer manifest, and the engine mounts it read-only at /input.
async function executeRequest({ inputRoot, workRoot }) {
  const { executeLua } = require("./lua-vm");
  const { createLuaIO, readLuaFile } = require("./lua-io");
  const { readWorkspaceLimits } = require("./workspaces");
  const { LUA_DATA_POLICY, readPolicy, cloneValue, logicalPath, name, record, fail } = require("./contracts");
  const outputRoot = path.join(workRoot, "output"), responseRoot = path.join(workRoot, "response");
  fs.mkdirSync(outputRoot, { mode: 0o700 }); fs.mkdirSync(responseRoot, { mode: 0o700 });
  let io, response;
  try {
    const bytes = readLuaFile(inputRoot, "request.json", null, LUA_DATA_POLICY.maxPlanBytes);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua worker request"); }
    const code = "PIPELINE_LUA_REQUEST_INVALID", request = cloneValue(parsed, LUA_DATA_POLICY, code);
    record(request, ["version", "mode", "script", "entrypoint", "modules", "context", "inputs", "outputs", "policy", "limits", "eventLimits", "memoryBytes", "expectedDescriptor"], code, "Lua worker request");
    if (request.version !== 1 || !["inspect", "plan", "transform"].includes(request.mode)) fail(code, "Unsupported Lua worker request");
    logicalPath(request.script, code);
    if (!Array.isArray(request.modules) || !request.modules.length || request.modules.length > 20000) fail(code, "Invalid Lua module manifest");
    if (request.mode === "transform") name(request.entrypoint, code);
    else if (request.entrypoint !== undefined || request.inputs !== undefined || request.outputs !== undefined) fail(code, "Planner cannot receive transformation I/O");
    const budget = readWorkspaceLimits(request.limits || {}), policy = readPolicy(request.policy), modules = Object.create(null);
    for (const file of request.modules) {
      record(file, ["path", "size", "contentHash"], code, "Lua module");
      logicalPath(file.path, code);
      if (!/\.lua$/i.test(file.path) || Object.hasOwn(modules, file.path) || !Number.isSafeInteger(file.size) || file.size < 0
        || typeof file.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(file.contentHash)) fail(code, "Invalid Lua module identity");
      Object.defineProperty(modules, file.path, { enumerable: true,
        get: () => readLuaFile(inputRoot, `modules/${file.path}`, file, budget.maxArtifactBytes) });
    }
    if (!Object.hasOwn(modules, request.script)) fail(code, "Lua entry module is absent from the supplied bundle");
    let host = {};
    if (request.mode === "transform") {
      io = createLuaIO({ inputRoot, outputRoot, inputs: request.inputs, outputs: request.outputs,
        limits: request.limits, eventLimits: request.eventLimits,
        // The I/O layer bounds bytes before posting. The process event loop can
        // drain these messages even while synchronous Lua keeps this thread busy.
        emit: event => parentPort.postMessage(JSON.stringify(event) + "\n") });
      host = Object.fromEntries(["read", "list", "write", "log", "diagnostic"].map(key => [key, io[key]]));
    }
    const value = await executeLua({ mode: request.mode, script: request.script, modules, context: request.context,
      entrypoint: request.entrypoint, host, policy, memoryBytes: request.memoryBytes, maxIoBytes: budget.maxArtifactBytes,
      expectedDescriptor: request.expectedDescriptor });
    response = { version: 1, value };
  } catch (error) {
    // Filesystem and VM exceptions may contain private paths. Only stable codes
    // cross this boundary; author diagnostics carry their own checked locations.
    response = { version: 1, errorCode: /^PIPELINE_[A-Z0-9_]{1,55}$/.test(error?.code || "") ? error.code : "PIPELINE_LUA_WORKER_FAILED" };
  }
  Object.assign(response, io ? io.result() : { diagnostics: [], logsTruncated: false });
  fs.writeFileSync(path.join(responseRoot, "result.json"), JSON.stringify(response), { flag: "wx", mode: 0o600 });
}

function runLuaWorker({ inputRoot = "/input", workRoot = "/work" } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { irisLuaWorker: true, inputRoot, workRoot } });
    worker.on("message", frame => process.stdout.write(frame));
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolve() : reject(Object.assign(new Error("Lua worker thread failed"), { code: "PIPELINE_LUA_WORKER_FAILED" })));
  });
}

if (!isMainThread && workerData?.irisLuaWorker === true) executeRequest(workerData).catch(() => { process.exitCode = 1; });
else if (require.main === module) runLuaWorker().catch(() => { process.exitCode = 1; });
module.exports = { runLuaWorker };
