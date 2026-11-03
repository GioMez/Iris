const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { uuidv7, isUuid } = require("../ids");
const { ConcurrencyGate } = require("../throttle");
const { fail, name } = require("./contracts");

const DEFAULTS = Object.freeze({ memoryBytes: 1073741824, totalMemoryBytes: 2147483648, cpus: 2, pids: 64,
  outputBytes: 536870912, outputEntries: 20000, tempBytes: 134217728, tempEntries: 4096,
  logBytes: 1048576, timeoutMs: 120000, runTimeoutMs: 1800000, controlTimeoutMs: 15000, concurrency: 2, queueLimit: 8 });
const error = code => Object.assign(new Error(code), { code });

function readRuntimePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PIPELINE_RUNTIME_POLICY_INVALID", "Invalid contained runtime policy");
  const { image, ...overrides } = value, result = { ...DEFAULTS };
  if (typeof image !== "string" || !/^(?:sha256:|[a-zA-Z0-9._/:\-]+@sha256:)[a-f0-9]{64}$/.test(image)) fail("PIPELINE_RUNTIME_POLICY_INVALID", "Worker image requires an exact digest");
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < (key === "queueLimit" ? 0 : 1)) fail("PIPELINE_RUNTIME_POLICY_INVALID", "Invalid contained resource limit");
    result[key] = value;
  }
  if (result.memoryBytes > result.totalMemoryBytes || result.controlTimeoutMs > 2147483647 || result.runTimeoutMs > 2147483647 || result.timeoutMs > result.runTimeoutMs) {
    fail("PIPELINE_RUNTIME_POLICY_INVALID", "Invalid contained resource reservation");
  }
  return Object.freeze({ image, ...result });
}

// The CLI is a host control client, never the worker. Pass only its transport
// environment; container arguments supply a separate explicit environment.
function commandClient(transport, policy) {
  const prefix = transport.connection ? ["--connection", transport.connection] : [];
  const env = Object.fromEntries(["PATH", "TMPDIR", "XDG_RUNTIME_DIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.HOME = transport.home || process.env.HOME;
  env.LANG = "C.UTF-8";
  function start(args, { timeoutMs = policy.controlTimeoutMs, maxBytes = 1048576, onOutput, control = true } = {}) {
    const child = spawn(transport.command || "podman", [...prefix, ...args], { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, truncated = false, failure = null, callbacks = Promise.resolve();
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { failure = error("PIPELINE_CONTROL_TIMEOUT"); child.kill("SIGKILL"); }, timeoutMs);
      const capture = chunk => {
        const remaining = Math.max(0, maxBytes - bytes), retained = chunk.subarray(0, remaining);
        if (retained.length) {
          chunks.push(retained); bytes += retained.length;
          if (onOutput) callbacks = callbacks.then(() => onOutput(retained)).catch(() => { failure ||= error("PIPELINE_OUTPUT_CALLBACK_FAILED"); });
        }
        if (chunk.length > remaining) {
          truncated = true;
          if (control) { failure = error("PIPELINE_CONTROL_OUTPUT_LIMIT"); child.kill("SIGKILL"); }
        }
      };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("error", () => { failure = error("PIPELINE_RUNTIME_UNAVAILABLE"); });
      child.once("close", async (code, signal) => {
        clearTimeout(timer);
        await callbacks;
        const text = Buffer.from(Buffer.concat(chunks).toString("utf8"));
        const log = new StringDecoder("utf8").write(text.subarray(0, maxBytes));
        if (failure) reject(failure);
        else resolve({ code, signal, log, truncated: truncated || text.length > maxBytes });
      });
    });
    done.catch(() => {});
    return { done };
  }
  async function run(args) {
    const result = await start(args).done;
    if (result.code !== 0) throw error("PIPELINE_ENGINE_COMMAND_FAILED");
    return result.log;
  }
  return { start, run };
}

async function createPodmanRuntime({ root, coordinatorId, transport = {}, policy: values, tools }) {
  const policy = readRuntimePolicy(values), client = commandClient(transport, policy);
  if (!isUuid(coordinatorId) || !path.isAbsolute(root)) throw error("PIPELINE_RUNTIME_POLICY_INVALID");
  const info = JSON.parse(await client.run(["info", "--format", "json"]));
  if (info.host?.os !== "linux" || info.host.cgroupVersion !== "v2" || !info.host.security?.rootless || !info.host.security?.seccompEnabled
    || !["cpu", "memory", "pids"].every(value => info.host.cgroupControllers?.includes(value))) throw error("PIPELINE_CONTAINMENT_UNAVAILABLE");
  if (policy.totalMemoryBytes > info.host.memTotal) throw error("PIPELINE_RUNTIME_CAPACITY");
  await client.run(["image", "exists", policy.image]);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const identityPath = path.join(root, "installation.json");
  try { await fs.writeFile(identityPath, JSON.stringify({ installationId: uuidv7() }), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const { installationId } = JSON.parse(await fs.readFile(identityPath, "utf8"));
  if (!isUuid(installationId)) throw error("PIPELINE_RUNTIME_IDENTITY_INVALID");
  const registered = new Map(), tokens = new WeakSet(), workspaces = new Map();
  for (const definition of tools) {
    name(definition.id);
    if (registered.has(definition.id) || !/^\/[a-zA-Z0-9_./-]+$/.test(definition.path) || definition.path.split("/").includes("..")
      || !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > policy.runTimeoutMs) throw error("PIPELINE_TOOL_INVALID");
    const tool = Object.freeze({ id: definition.id, path: definition.path, timeoutMs: definition.timeoutMs });
    tokens.add(tool); registered.set(tool.id, tool);
  }
  const gate = new ConcurrencyGate({ limit: Math.min(policy.concurrency, Math.floor(policy.totalMemoryBytes / policy.memoryBytes)), queueLimit: policy.queueLimit });
  let accepting = true;
  function get(workspace) {
    const state = workspaces.get(workspace);
    if (!state) throw error("PIPELINE_WORKER_WORKSPACE_INVALID");
    return state;
  }
  const labels = state => ({ "iris.installation": installationId, "iris.coordinator": coordinatorId, "iris.workspace": state.record.id, "iris.run": state.record.runId });
  const labelArgs = state => Object.entries(labels(state)).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
  const save = state => fs.writeFile(path.join(root, `${state.record.id}.json`), JSON.stringify(state.record), { mode: 0o600 });
  async function inspectOwned(state, kind, id) {
    const records = JSON.parse(await client.run([...(kind === "volume" ? ["volume"] : []), "inspect", id]));
    const record = records[0], found = kind === "volume" ? record.Labels : record.Config?.Labels;
    if (!Object.entries(labels(state)).every(([key, value]) => found?.[key] === value)) throw error("PIPELINE_WORKER_OWNERSHIP_INVALID");
    return record;
  }
  async function removeContainer(state, worker) {
    await inspectOwned(state, "container", worker.name);
    await client.run(["rm", "--force", worker.name]);
    worker.removed = true;
  }
  async function stopWorker(state, worker) {
    return worker.stopping ||= (async () => {
      await worker.prepared;
      // A lost create acknowledgement does not prove the container is absent.
      await worker.created?.catch(() => {});
      if (!worker.removed) await removeContainer(state, worker);
      await worker.execution?.done.catch(() => {});
      worker.confirmDrain();
    })().finally(() => { worker.stopping = null; });
  }
  async function createWorkspace({ runId, stepId, signal, deadlineAt = Date.now() + policy.runTimeoutMs }) {
    if (!accepting) throw error("PIPELINE_RUNTIME_STOPPING");
    if (!isUuid(runId) || !Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now() || deadlineAt > Date.now() + policy.runTimeoutMs) throw error("PIPELINE_WORKER_IDENTITY_INVALID");
    name(stepId);
    const release = await gate.acquire({ signal });
    if (!accepting || signal?.aborted) { release(); signal?.throwIfAborted(); throw error("PIPELINE_RUNTIME_STOPPING"); }
    if (deadlineAt <= Date.now()) { release(); throw error("PIPELINE_RUN_DEADLINE"); }
    const id = uuidv7(), workspace = Object.freeze({ id, runId, stepId });
    const state = { record: { id, installationId, coordinatorId, runId, stepId, deadlineAt, volumes: [], containers: [] }, release, worker: null, cancelled: false, disposing: null };
    workspaces.set(workspace, state);
    try {
      await save(state);
      for (const [suffix, bytes, entries] of [["work", policy.outputBytes, policy.outputEntries], ["tmp", policy.tempBytes, policy.tempEntries]]) {
        signal?.throwIfAborted();
        const volume = `iris-${id}-${suffix}`;
        state.record.volumes.push(volume); await save(state);
        await client.run(["volume", "create", ...labelArgs(state), "--opt=type=tmpfs", "--opt=device=tmpfs",
          `--opt=o=size=${bytes},nr_inodes=${entries},mode=1777,nosuid,nodev,noexec`, volume]);
      }
      return workspace;
    } catch (failure) {
      // Keep the reservation and durable identities if engine setup is uncertain.
      state.setupFailure = true;
      throw failure;
    }
  }
  async function runContained({ tool, args, workspace, signal, onOutput }) {
    const state = get(workspace);
    if (state.cancelled) throw error("PIPELINE_WORKSPACE_CANCELLED");
    if (!tokens.has(tool) || !Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== "string" || value.includes("\0"))
      || Buffer.byteLength(JSON.stringify(args)) > 65536) throw error("PIPELINE_TOOL_INVALID");
    if (state.worker || state.setupFailure) throw error("PIPELINE_WORKER_BUSY");
    signal?.throwIfAborted();
    const remaining = state.record.deadlineAt - Date.now();
    if (remaining <= 0) throw error("PIPELINE_RUN_DEADLINE");
    const timeoutMs = Math.min(tool.timeoutMs, remaining), started = Date.now();
    let confirmDrain, complete, preparationDone;
    const drained = new Promise(resolve => { confirmDrain = resolve; }), completed = new Promise(resolve => { complete = resolve; });
    const prepared = new Promise(resolve => { preparationDone = resolve; });
    const worker = { name: `iris-${uuidv7()}`, removed: false, stopping: null, execution: null, created: null,
      cancelled: false, confirmDrain, drained, completed, prepared };
    state.worker = worker; state.record.containers.push(worker.name);
    let timer, timedOut = false, stoppingError = null;
    const stop = () => {
      if (signal?.aborted) state.cancelled = true;
      stopWorker(state, worker).catch(error => { stoppingError = error; });
    };
    try {
      await save(state);
      if (signal?.aborted || worker.cancelled) {
        worker.removed = true; preparationDone(); worker.confirmDrain();
        return { code: null, signal: null, log: "", truncated: false, cancelled: true, timedOut: false, oomKilled: false, drained: true, durationMs: Date.now() - started };
      }
      const argsCreate = ["create", "--name", worker.name, ...labelArgs(state), "--pull=never", "--network=none", "--read-only", "--read-only-tmpfs=false",
        "--ipc=none", "--cap-drop=all", "--security-opt=no-new-privileges", "--log-driver=none", "--user=65534:65534",
        `--memory=${policy.memoryBytes}`, `--memory-swap=${policy.memoryBytes}`, `--pids-limit=${policy.pids}`, `--cpus=${policy.cpus}`,
        "--ulimit=nofile=256:256", `--timeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`, "--workdir=/work", "--unsetenv-all",
        "--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=HOME=/work", "--env=TMPDIR=/tmp", "--env=LANG=C.UTF-8",
        `--volume=${state.record.volumes[0]}:/work:rw`, `--volume=${state.record.volumes[1]}:/tmp:rw`,
        "--entrypoint", tool.path, policy.image, ...args];
      worker.created = client.run(argsCreate);
      try { await worker.created; } finally { preparationDone(); }
      if (signal?.aborted || worker.cancelled) {
        await stopWorker(state, worker);
        return { code: null, signal: null, log: "", truncated: false, cancelled: true, timedOut: false, oomKilled: false, drained: true, durationMs: Date.now() - started };
      }
      worker.execution = client.start(["start", "--attach", worker.name], { timeoutMs: timeoutMs + 2 * policy.controlTimeoutMs, maxBytes: policy.logBytes, onOutput, control: false });
      signal?.addEventListener("abort", stop, { once: true });
      timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const result = await worker.execution.done;
      result.oomKilled = false;
      if (worker.stopping) await worker.stopping;
      if (!worker.removed) {
        const inspection = await inspectOwned(state, "container", worker.name);
        if (inspection.State.Running || inspection.State.Pid !== 0) throw error("PIPELINE_WORKER_DRAIN_REQUIRED");
        result.code = inspection.State.ExitCode;
        result.oomKilled = inspection.State.OOMKilled === true;
        if (inspection.State.ExitCode !== 0 && Date.now() - started >= timeoutMs) timedOut = true;
        await removeContainer(state, worker);
      }
      worker.confirmDrain();
      if (stoppingError) throw stoppingError;
      return { ...result, cancelled: worker.cancelled || signal?.aborted === true, timedOut, drained: true, durationMs: Date.now() - started };
    } catch (failure) {
      if (!worker.created) { worker.removed = true; preparationDone(); worker.confirmDrain(); }
      else {
        try { await stopWorker(state, worker); }
        catch {
          // Preserve the caller's execution/resource lease and recovery receipt.
          // Independent stop/recovery calls can retry the engine boundary without
          // waiting for a project gate held by that caller.
          await worker.drained;
        }
      }
      throw failure;
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      try {
        if (worker.removed) {
          state.record.containers = state.record.containers.filter(id => id !== worker.name);
          await save(state); state.worker = null;
        }
      } finally { complete(); }
    }
  }
  async function stop(workspace) {
    const state = get(workspace);
    state.cancelled = true;
    const worker = state.worker;
    if (worker) {
      worker.cancelled = true;
      await stopWorker(state, worker);
      await worker.completed;
    }
  }
  async function disposeWorkspace(workspace) {
    const state = workspaces.get(workspace);
    if (!state) return;
    return state.disposing ||= (async () => {
      await stop(workspace);
      for (const volume of [...state.record.volumes]) {
        await inspectOwned(state, "volume", volume);
        await client.run(["volume", "rm", volume]);
        state.record.volumes = state.record.volumes.filter(id => id !== volume); await save(state);
      }
      await fs.unlink(path.join(root, `${state.record.id}.json`));
      workspaces.delete(workspace); state.release();
    })().finally(() => { state.disposing = null; });
  }
  async function close() {
    accepting = false; gate.drain("PIPELINE_RUNTIME_STOPPING");
    for (const workspace of workspaces.keys()) await disposeWorkspace(workspace);
  }
  return Object.freeze({ createWorkspace, runContained, stop, disposeWorkspace, close,
    resolveTool(id) { const tool = registered.get(id); if (!tool) throw error("PIPELINE_TOOL_INVALID"); return tool; } });
}

module.exports = { readRuntimePolicy, createPodmanRuntime };
