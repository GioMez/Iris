import { WORKER_PROTOCOL, decodeRecord } from "./iris-language-transfer.mjs";
import { build } from "./vendor/language-worker/version.mjs";
import { createTaskScheduler } from "./iris-language-tasks.mjs";

export const WORKER_MIN_LENGTH = 32768;
export const canUseLanguageWorker = () => typeof globalThis.Worker === "function";
let owners = 0, workers = 0;
const waiting = new Set(), MAX_WORKERS = 2, MAX_WAITING = 16;
const unavailable = reason => ({ status: "unavailable", reason, tree: null });

/** One owner/configuration scope. At most two real Workers, sixteen queued
 * owners, one live request per owner, three completed transfer registries.
 * Faults settle explicitly; no large synchronous fallback on the UI thread.
 */
export function createWorkerClient(adapter, { timeout = 15000, workerFactory = url => new Worker(url, { type: "module" }) } = {}) {
  const owner = ++owners, tasks = createTaskScheduler(), configuration = `${adapter.kind}:${JSON.stringify(adapter.options)}`;
  let worker = null, disposed = false, failed = false, pending = null, sequence = 0, history = [], generation = null, revision = -1;
  function finish(result) {
    const j = pending;
    if (!j) return;
    pending = null; clearTimeout(j.timer);
    if (j.task != null) tasks.cancel(j.task);
    j.resolve(result);
  }
  function release() {
    waiting.delete(start);
    if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; worker.terminate(); worker = null; workers--; }
    for (const next of waiting) { if (workers >= MAX_WORKERS) break; waiting.delete(next); next(); }
  }
  function fault(reason) { failed = true; finish(unavailable(reason)); history = []; release(); }
  function post(data) { try { worker.postMessage(data); } catch (error) { fault(String(error.message)); } }
  function receive(message) {
    const j = pending;
    if (!j || !Object.keys(j.id).every(key => message[key] === j.id[key])) return;
    try {
      if (message.type === "error") { fault(message.reason || "worker-error"); return; }
      if (message.type === "start") {
        if (j.started || message.nodeNames?.length !== adapter.language.parser.nodeSet.types.length ||
          message.nodeNames.some((name, i) => name !== adapter.language.parser.nodeSet.types[i].name)) throw new Error("Worker node set mismatch");
        j.started = true; j.metrics = message.metrics;
        post({ ...j.id, type: "pull" }); return;
      }
      if (message.type !== "chunk" || !j.started || j.decoding || !Array.isArray(message.records) || message.records.length > 256) throw new Error("Invalid worker chunk");
      const retained = { get: id => { for (const entry of history) { const tree = entry.nodes.get(id); if (tree) return tree; } } };
      function* decode() {
        for (const record of message.records) { yield* decodeRecord(record, adapter.language.parser.nodeSet, j.nodes, retained); yield; }
      }
      j.decoding = decode();
      function chunk() {
        j.task = null;
        if (pending !== j || disposed) return;
        try {
          const start = performance.now(), until = start + 5;
          do {
            const step = j.decoding.next();
            if (step.done) {
              j.decoding = null;
              j.metrics.decodeMaxMs = Math.max(j.metrics.decodeMaxMs || 0, performance.now() - start);
              if (message.done) {
                const tree = j.nodes.get(message.root);
                if (!tree?.type.isTop || tree.length !== j.length) throw new Error("Incomplete worker tree");
                history.unshift({ request: j.id.request, nodes: j.nodes }); history.length = Math.min(history.length, 3);
                finish({ status: "ready", tree, metrics: j.metrics });
              } else post({ ...j.id, type: "pull" });
              return;
            }
          } while (performance.now() < until);
          j.metrics.decodeMaxMs = Math.max(j.metrics.decodeMaxMs || 0, performance.now() - start);
          j.task = tasks.schedule(chunk, 0);
        } catch (error) { fault(String(error.message)); }
      }
      j.task = tasks.schedule(chunk, 0);
    } catch (error) { fault(String(error.message)); }
  }
  function start() {
    if (disposed || failed || !pending) return;
    pending.task = null;
    if (!worker) {
      if (workers >= MAX_WORKERS) {
        if (waiting.size >= MAX_WAITING && !waiting.has(start)) { finish(unavailable("worker-capacity")); return; }
        waiting.add(start); return;
      }
      try { worker = workerFactory(new URL("./vendor/language-worker/worker.mjs", import.meta.url)); workers++; }
      catch (error) { fault(String(error.message)); return; }
      worker.onmessage = event => receive(event.data);
      worker.onerror = event => { event.preventDefault?.(); fault("worker-error"); };
      worker.onmessageerror = () => fault("worker-message-error");
    }
    const j = pending;
    post({ ...j.id, type: "parse", kind: adapter.kind, options: adapter.options, source: j.source, bases: history.map(entry => entry.request) });
    j.source = null;
  }
  function cancel() {
    if (pending) {
      if (worker) post({ type: "cancel", request: pending.id.request });
      finish(unavailable("cancelled"));
    }
    waiting.delete(start);
  }
  function parse(source, id) {
    if (generation !== null && (id.generation < generation || id.revision <= revision)) return Promise.resolve(unavailable("stale-identity"));
    cancel();
    if (disposed || failed) return Promise.resolve(unavailable(disposed ? "disposed" : "worker-unavailable"));
    if (source == null || !Number.isSafeInteger(source.length) || source.length < 0 || source.length > 1048576 ||
      typeof source !== "string" && typeof source.sliceString !== "function" || ![id.generation, id.revision].every(n => Number.isSafeInteger(n) && n >= 0)) return Promise.resolve(unavailable("invalid-source-identity"));
    if (generation !== id.generation) { history = []; generation = id.generation; }
    revision = id.revision;
    return new Promise(resolve => {
      pending = { resolve, source, length: source.length, nodes: new Map(), id: { version: WORKER_PROTOCOL, build, owner,
        request: ++sequence, generation: id.generation, revision: id.revision, configuration } };
      pending.timer = setTimeout(() => fault("worker-timeout"), timeout);
      if (typeof source === "string") start();
      else {
        const j = pending, pieces = []; let from = 0;
        function prepareSource() {
          j.task = null;
          if (pending !== j || disposed) return;
          try {
            const until = performance.now() + 3;
            while (from < j.length && performance.now() < until) {
              const to = Math.min(j.length, from + 4096), piece = source.sliceString(from, to);
              if (typeof piece !== "string" || piece.length !== to - from) throw new Error("Invalid UTF-16 source window");
              pieces.push(piece); from = to;
            }
            if (from < j.length) j.task = tasks.schedule(prepareSource, 0);
            else {
              j.source = pieces.join(""); pieces.length = 0;
              // Worker creation/structured clone gets its own application turn.
              j.task = tasks.schedule(start, 0);
            }
          } catch (error) { fault(String(error.message)); }
        }
        j.task = tasks.schedule(prepareSource, 0);
      }
    });
  }
  function dispose() { if (!disposed) { disposed = true; cancel(); history = []; release(); tasks.dispose(); } }
  return { parse, cancel, dispose };
}
