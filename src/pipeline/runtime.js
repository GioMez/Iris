const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { uuidv7, isUuid } = require("../ids");
const { ConcurrencyGate } = require("../throttle");
const { fail, name, logicalPath, freeze } = require("./contracts");
const { createTransferArchive, extractTransferArchive } = require("./transfers");
const { checkedPath, copyFile } = require("./workspaces");

const DEFAULTS = Object.freeze({ outputBytes: 536870912, outputEntries: 20000, logBytes: 1048576,
  timeoutMs: 120000, runTimeoutMs: 1800000, cleanupTimeoutMs: 5000, concurrency: 2, queueLimit: 8 });
const error = code => Object.assign(new Error(code), { code });
const pathError = () => fail("PIPELINE_PATH_INVALID", "Invalid pipeline workspace path");

function readRuntimePolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("PIPELINE_RUNTIME_POLICY_INVALID");
  const result = { ...DEFAULTS };
  for (const [key, limit] of Object.entries(value)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(limit) || limit < (key === "queueLimit" ? 0 : 1)) throw error("PIPELINE_RUNTIME_POLICY_INVALID");
    result[key] = limit;
  }
  if (result.runTimeoutMs > 2147483647 || result.cleanupTimeoutMs > 2147483647 || result.timeoutMs > result.runTimeoutMs) throw error("PIPELINE_RUNTIME_POLICY_INVALID");
  return Object.freeze(result);
}

function environment(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64
    || Object.entries(value).some(([key, item]) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof item !== "string" || item.includes("\0"))
    || Buffer.byteLength(JSON.stringify(value)) > 65536) throw error("PIPELINE_TOOL_INVALID");
  return { ...value };
}

async function executable(command, searchPath) {
  if (typeof command !== "string" || !command || command.includes("\0")
    || (!path.isAbsolute(command) && !/^[a-zA-Z0-9_.+-]+$/.test(command))) throw error("PIPELINE_TOOL_INVALID");
  const candidates = path.isAbsolute(command) ? [command] : searchPath.split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, command));
  for (const candidate of candidates) {
    let input;
    try {
      const resolved = await fs.realpath(candidate);
      await fs.access(resolved, constants.X_OK);
      input = await fs.open(resolved, "r");
      const before = await input.stat();
      if (!before.isFile()) continue;
      const hash = createHash("sha256");
      for await (const chunk of input.createReadStream({ autoClose: false })) hash.update(chunk);
      const after = await input.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw error("PIPELINE_TOOL_CHANGED");
      return { command, path: candidate, resolved, contentHash: hash.digest("hex") };
    } catch (err) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes(err.code)) throw err; }
    finally { await input?.close(); }
  }
  return { command, path: command, resolved: null, contentHash: null };
}

// Process groups provide ordinary POSIX cancellation, not an OS sandbox. Never
// use a persisted PID as a signal target after the owning coordinator restarts.
function startProcess(tool, args, options) {
  const { cwd, env, timeoutMs, cleanupTimeoutMs, maxBytes, onOutput, captureStreams, limitOutput } = options;
  const child = spawn(tool.path, args, { cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let failure, exited = false, closed = false, groupGone = false, killSent = false, settled = false, code, exitSignal;
  let timedOut = false, cancelled = false, truncated = false, outputLimited = false, retained = 0, timer, cleanupTimer, monitor;
  let callbacks = Promise.resolve();
  const chunks = [], output = { stdout: [], stderr: [] };
  let resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  done.catch(() => {});
  function exists() {
    if (!child.pid) return false;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, 0); return true; }
    catch (err) { if (err.code === "ESRCH") return false; if (err.code === "EPERM") return true; throw err; }
  }
  function kill() {
    if (!child.pid || groupGone || killSent) return;
    // Darwin can return EPERM for another signal while a killed process exits.
    // Send once, then retain ownership until the group disappears.
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); killSent = true; }
    catch (err) { if (err.code === "ESRCH") groupGone = true; else failure ||= err; }
  }
  function finish() {
    if (settled || !closed || !groupGone) return;
    settled = true; clearTimeout(timer); clearTimeout(cleanupTimer); clearInterval(monitor);
    callbacks.then(() => {
      if (failure) reject(failure);
      else {
        function decode(chunks, limit) {
          const text = Buffer.from(Buffer.concat(chunks).toString("utf8"));
          truncated ||= text.length > limit;
          return new StringDecoder("utf8").write(text.subarray(0, limit));
        }
        const log = decode(chunks, maxBytes), streams = {};
        if (captureStreams) {
          streams.stdout = decode(output.stdout, maxBytes);
          streams.stderr = decode(output.stderr, maxBytes - Buffer.byteLength(streams.stdout));
        }
        resolve({ code, signal: exitSignal, log, truncated, outputLimited, cancelled, timedOut, drained: true, ...streams });
      }
    });
  }
  function observe() {
    if (exited && !groupGone) {
      try { groupGone = !exists(); } catch (err) { failure ||= err; }
    }
    finish();
  }
  function terminate(reason) {
    failure ||= reason;
    if (settled) return;
    kill();
    monitor ||= setInterval(observe, 20);
    cleanupTimer ||= setTimeout(() => {
      observe();
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(monitor);
      child.stdout.destroy(); child.stderr.destroy();
      reject(error("PIPELINE_WORKER_RECOVERY_REQUIRED"));
    }, cleanupTimeoutMs);
  }
  for (const channel of ["stdout", "stderr"]) child[channel].on("data", chunk => {
    const remaining = Math.max(0, maxBytes - retained), bytes = chunk.subarray(0, remaining);
    if (bytes.length) {
      chunks.push(bytes); retained += bytes.length;
      if (captureStreams) output[channel].push(bytes);
      if (onOutput) {
        child[channel].pause();
        callbacks = callbacks.then(() => { if (!failure) return onOutput(bytes, channel); }).catch(err => terminate(err))
          .finally(() => child[channel].resume());
      }
    }
    if (chunk.length > remaining) {
      truncated = true;
      if (limitOutput) { outputLimited = true; terminate(); }
    }
  });
  child.once("error", () => { failure ||= error("PIPELINE_RUNTIME_UNAVAILABLE"); });
  child.once("exit", () => { exited = true; terminate(); observe(); });
  child.once("close", (value, signal) => { code = value; exitSignal = signal; exited = true; closed = true; observe(); });
  timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  return { child, done, drained: () => closed && groupGone,
    stop() { cancelled = true; terminate(); } };
}

async function createNativeRuntime({ root, coordinatorId, policy: values, tools }) {
  const policy = readRuntimePolicy(values), searchPath = process.env.PATH || "";
  if (!isUuid(coordinatorId) || !path.isAbsolute(root)) throw error("PIPELINE_RUNTIME_POLICY_INVALID");
  if (!Array.isArray(tools) || tools.length > 128) throw error("PIPELINE_TOOL_INVALID");
  const registered = new Map(), tokens = new WeakSet(), workspaces = new Map();
  for (const definition of tools) {
    name(definition.id);
    if (registered.has(definition.id) || !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > policy.runTimeoutMs) throw error("PIPELINE_TOOL_INVALID");
    const env = environment(definition.env), protocolBytes = definition.protocolBytes ?? 0;
    if (!Number.isSafeInteger(protocolBytes) || protocolBytes < 0 || protocolBytes > 16777216
      || !Number.isSafeInteger(policy.logBytes + protocolBytes)) throw error("PIPELINE_TOOL_INVALID");
    const dependencies = definition.dependencies || [];
    if (!Array.isArray(dependencies) || dependencies.length > 16) throw error("PIPELINE_TOOL_INVALID");
    const identity = await executable(definition.path, env.PATH || searchPath);
    const tool = freeze({ id: definition.id, ...identity, timeoutMs: definition.timeoutMs, protocolBytes, env,
      dependencies: await Promise.all(dependencies.map(command => executable(command, env.PATH || searchPath))) });
    tokens.add(tool); registered.set(tool.id, tool);
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  root = await fs.realpath(root);
  const identityPath = path.join(root, "installation.json");
  try { await fs.writeFile(identityPath, JSON.stringify({ installationId: uuidv7() }), { flag: "wx", mode: 0o600 }); }
  catch (err) { if (err.code !== "EEXIST") throw err; }
  const { installationId } = JSON.parse(await fs.readFile(identityPath, "utf8"));
  if (!isUuid(installationId)) throw error("PIPELINE_RUNTIME_IDENTITY_INVALID");
  const gate = new ConcurrencyGate({ limit: policy.concurrency, queueLimit: policy.queueLimit });
  let accepting = true;
  const get = workspace => {
    const state = workspaces.get(workspace);
    if (!state) throw error("PIPELINE_WORKER_WORKSPACE_INVALID");
    return state;
  };
  async function syncRoot() {
    const handle = await fs.open(root, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function save(state) {
    const destination = path.join(root, `${state.record.id}.json`), temporary = path.join(root, `.receipt-${state.record.id}-${uuidv7()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(JSON.stringify(state.record)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, destination); await syncRoot();
    } finally { await fs.unlink(temporary).catch(err => { if (err.code !== "ENOENT") throw err; }); }
  }
  async function reconcile() {
    const recovered = [], blocked = [];
    for (const file of await fs.readdir(root)) {
      if (!file.endsWith(".json") || file === "installation.json" || !isUuid(file.slice(0, -5))) continue;
      const id = file.slice(0, -5);
      if ([...workspaces.values()].some(state => state.record.id === id)) continue;
      try {
        const location = path.join(root, file), stat = await fs.lstat(location);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw error("PIPELINE_WORKER_RECOVERY_REQUIRED");
        const record = JSON.parse(await fs.readFile(location, "utf8"));
        if (record.version !== 2 || record.id !== id || record.installationId !== installationId || !isUuid(record.coordinatorId)
          || !isUuid(record.runId) || !Number.isSafeInteger(record.deadlineAt) || !["preparing", "idle"].includes(record.phase)) throw error("PIPELINE_WORKER_RECOVERY_REQUIRED");
        name(record.stepId);
        await fs.rm(path.join(root, id), { recursive: true, force: true });
        await fs.unlink(location); recovered.push(id);
      } catch { blocked.push(id); }
    }
    if (blocked.length) throw error("PIPELINE_WORKER_RECOVERY_REQUIRED");
    for (const file of await fs.readdir(root)) {
      const match = /^\.receipt-(.{36})-(.{36})\.tmp$/.exec(file);
      if (match && isUuid(match[1]) && isUuid(match[2]) && ![...workspaces.values()].some(state => state.record.id === match[1])) await fs.unlink(path.join(root, file));
    }
    await syncRoot(); return { recovered };
  }
  async function createWorkspace({ runId, stepId, input, signal, queue = true, deadlineAt = Date.now() + policy.runTimeoutMs }) {
    if (!accepting) throw error("PIPELINE_RUNTIME_STOPPING");
    if (!isUuid(runId) || !Number.isSafeInteger(deadlineAt) || deadlineAt > Date.now() + policy.runTimeoutMs) throw error("PIPELINE_WORKER_IDENTITY_INVALID");
    name(stepId); signal?.throwIfAborted();
    if (deadlineAt <= Date.now()) throw error("PIPELINE_RUN_DEADLINE");
    if (!queue && gate.active >= gate.limit) throw error("PIPELINE_WORKER_BUSY");
    const release = await gate.acquire({ signal });
    if (!accepting || signal?.aborted || deadlineAt <= Date.now()) {
      release(); signal?.throwIfAborted(); throw error(accepting ? "PIPELINE_RUN_DEADLINE" : "PIPELINE_RUNTIME_STOPPING");
    }
    const id = uuidv7(), directory = path.join(root, id);
    const workspace = Object.freeze({ id, runId, stepId, inputRoot: path.join(directory, "input"), workRoot: path.join(directory, "work"), tempRoot: path.join(directory, "tmp") });
    const controller = new AbortController(), effective = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let setupDone;
    const state = { record: { version: 2, id, installationId, coordinatorId, runId, stepId, deadlineAt, phase: "preparing", pid: null },
      release, controller, cancelled: false, setup: new Promise(resolve => { setupDone = resolve; }) };
    workspaces.set(workspace, state);
    try {
      await save(state); effective.throwIfAborted();
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.mkdir(workspace.workRoot, { mode: 0o700 }); await fs.mkdir(workspace.tempRoot, { mode: 0o700 });
      if (input) {
        const sizes = input.files?.map(file => file.size) || [];
        const total = sizes.reduce((sum, size) => sum + size, 0);
        if (!Number.isSafeInteger(total) || total < 0) throw error("PIPELINE_INPUT_CHANGED");
        await extractTransferArchive(createTransferArchive(input, { signal: effective }), workspace.inputRoot,
          { maxArtifactBytes: Math.max(1, ...sizes), maxOutputBytes: Math.max(1, total), maxOutputEntries: input.files.length + input.directories.length + 1 }, { signal: effective });
      } else await fs.mkdir(workspace.inputRoot, { mode: 0o700 });
      effective.throwIfAborted();
      if (deadlineAt <= Date.now()) throw error("PIPELINE_RUN_DEADLINE");
      state.record.phase = "idle"; await save(state);
      return workspace;
    } catch (failure) {
      setupDone();
      try { await disposeWorkspace(workspace); }
      catch (cause) { throw Object.assign(error("PIPELINE_WORKER_RECOVERY_REQUIRED"), { cause: new AggregateError([failure, cause]) }); }
      throw failure;
    } finally { setupDone(); }
  }
  async function runTool({ tool, args, workspace, signal, onOutput, captureStreams = false, outputLimitBytes, env }) {
    const state = get(workspace);
    if (state.cancelled) throw error("PIPELINE_WORKSPACE_CANCELLED");
    if (!tokens.has(tool) || !Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== "string" || value.includes("\0"))
      || Buffer.byteLength(JSON.stringify(args)) > 65536 || (outputLimitBytes !== undefined && (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1))) throw error("PIPELINE_TOOL_INVALID");
    const extraEnv = environment(env);
    if (state.worker || state.transfer) throw error("PIPELINE_WORKER_BUSY");
    signal?.throwIfAborted();
    const remaining = state.record.deadlineAt - Date.now();
    if (remaining <= 0) throw error("PIPELINE_RUN_DEADLINE");
    let complete;
    const worker = { completed: new Promise(resolve => { complete = resolve; }) };
    state.worker = worker;
    const abort = () => { state.cancelled = true; worker.process?.stop(); };
    signal?.addEventListener("abort", abort, { once: true });
    const started = Date.now();
    try {
      for (const identity of [tool, ...tool.dependencies]) {
        if (!identity.resolved) throw error("PIPELINE_RUNTIME_UNAVAILABLE");
        const current = await executable(identity.path, searchPath);
        if (current.resolved !== identity.resolved || current.contentHash !== identity.contentHash) throw error("PIPELINE_TOOL_CHANGED");
      }
      state.record.phase = "running"; await save(state);
      if (state.cancelled || signal?.aborted) return { code: null, signal: null, log: "", truncated: false, cancelled: true, timedOut: false, drained: true };
      const timeoutMs = Math.min(tool.timeoutMs, state.record.deadlineAt - Date.now());
      if (timeoutMs <= 0) throw error("PIPELINE_RUN_DEADLINE");
      worker.process = startProcess(tool, args, { cwd: workspace.workRoot,
        env: { PATH: searchPath, HOME: workspace.workRoot, TMPDIR: workspace.tempRoot, LANG: "C.UTF-8", ...tool.env, ...extraEnv },
        timeoutMs, cleanupTimeoutMs: policy.cleanupTimeoutMs, maxBytes: Math.min(policy.logBytes + tool.protocolBytes, outputLimitBytes ?? policy.logBytes + tool.protocolBytes),
        onOutput, captureStreams, limitOutput: outputLimitBytes !== undefined });
      state.record.pid = worker.process.child.pid || null; await save(state);
      if (state.cancelled || signal?.aborted) worker.process.stop();
      return { ...await worker.process.done, durationMs: Date.now() - started };
    } catch (failure) {
      worker.process?.stop();
      await worker.process?.done.catch(() => {});
      throw failure;
    } finally {
      signal?.removeEventListener("abort", abort);
      try {
        if (!worker.process || worker.process.drained()) {
          state.record.phase = "idle"; state.record.pid = null; await save(state); state.worker = null;
        }
      } finally { complete(); }
    }
  }
  async function stop(workspace) {
    const state = get(workspace);
    state.cancelled = true; state.controller.abort(); state.transfer?.controller.abort();
    await state.setup; await state.transfer?.completed;
    if (state.worker) {
      state.worker.process?.stop(); await state.worker.completed;
      if (state.worker) throw error("PIPELINE_WORKER_RECOVERY_REQUIRED");
    }
  }
  async function exportWorkspace({ workspace, destination, directory, signal }) {
    const state = get(workspace);
    if (directory !== undefined) name(directory, "PIPELINE_PATH_INVALID");
    if (state.cancelled) throw error("PIPELINE_WORKSPACE_CANCELLED");
    if (state.worker || state.transfer) throw error("PIPELINE_WORKER_BUSY");
    const controller = new AbortController(), effective = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let complete, created = false, total = 0, entries = 0;
    state.transfer = { controller, completed: new Promise(resolve => { complete = resolve; }) };
    const files = [], directories = [];
    function check() { effective.throwIfAborted(); if (Date.now() >= state.record.deadlineAt) throw error("PIPELINE_RUN_DEADLINE"); }
    async function walk(rel) {
      check();
      const location = rel ? (await checkedPath(workspace.workRoot, rel, true)).file : workspace.workRoot;
      if (rel && ++entries > policy.outputEntries) throw error("PIPELINE_OUTPUT_LIMIT");
      if (rel) { directories.push(rel); await fs.mkdir(path.join(destination, rel), { mode: 0o700 }); }
      for await (const item of await fs.opendir(location)) {
        check(); const relative = logicalPath(rel ? `${rel}/${item.name}` : item.name, "PIPELINE_PATH_INVALID");
        const stat = await fs.lstat(path.join(workspace.workRoot, relative));
        if (stat.isDirectory()) await walk(relative);
        else {
          if (!stat.isFile() || stat.nlink !== 1) pathError();
          if (++entries > policy.outputEntries || stat.size + total > policy.outputBytes) throw error("PIPELINE_OUTPUT_LIMIT");
          const copied = await copyFile(workspace.workRoot, relative, path.join(destination, relative), policy.outputBytes - total, null, effective);
          total += copied.size; files.push(copied);
        }
      }
    }
    try {
      check(); await fs.mkdir(destination, { mode: 0o700 }); created = true;
      await walk(directory || ""); check();
      return freeze({ root: destination, files: files.sort((a, b) => a.path.localeCompare(b.path, "en")), directories: directories.sort() });
    } catch (failure) {
      if (created) await fs.rm(destination, { recursive: true, force: true });
      throw failure;
    } finally { state.transfer = null; complete(); }
  }
  async function disposeWorkspace(workspace) {
    const state = workspaces.get(workspace);
    if (!state) return;
    return state.disposing ||= (async () => {
      await stop(workspace);
      await fs.rm(path.join(root, state.record.id), { recursive: true, force: true });
      await fs.unlink(path.join(root, `${state.record.id}.json`)); await syncRoot();
      workspaces.delete(workspace); state.release();
    })().finally(() => { state.disposing = null; });
  }
  async function close() {
    accepting = false; gate.drain("PIPELINE_RUNTIME_STOPPING");
    const results = await Promise.allSettled([...workspaces.keys()].map(disposeWorkspace));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw Object.assign(error("PIPELINE_WORKER_RECOVERY_REQUIRED"), { cause: new AggregateError(failures) });
  }
  await reconcile();
  return Object.freeze({ createWorkspace, runTool, exportWorkspace, stop, disposeWorkspace, close, reconcile,
    manifest() { return freeze({ policy, tools: [...registered.values()].sort((a, b) => a.id.localeCompare(b.id, "en")) }); },
    resolveTool(id) { const tool = registered.get(id); if (!tool) throw error("PIPELINE_TOOL_INVALID"); return tool; } });
}

module.exports = { readRuntimePolicy, createNativeRuntime };
