import { TreeFragment } from "@lezer/common";
import { createParser } from "./languages/parser-factory.mjs";
import { encodeTree, WORKER_PROTOCOL } from "./iris-language-transfer.mjs";
import { createTaskScheduler } from "./iris-language-tasks.mjs";

const tasks = createTaskScheduler();
let job = null, scope = null, parser = null, history = [], transfers = new Map(), ids = new WeakMap();
const identityKeys = ["version", "build", "owner", "request", "generation", "revision", "configuration"];
const identity = message => Object.fromEntries(identityKeys.map(key => [key, message[key]]));
const send = (j, data, buffers = []) => self.postMessage({ ...j.id, ...data }, buffers);
function reset() { history = []; transfers.clear(); ids = new WeakMap(); }
function cancel() { if (job?.task != null) tasks.cancel(job.task); job = null; }

// Exact UTF-16 comparison, never hashes or benchmark-specific prefixes. The
// best of at most three completed versions supplies edit-mapped safe fragments.
function difference(before, after) {
  let from = 0, a = before.length, b = after.length;
  while (from < a && from < b && before.charCodeAt(from) === after.charCodeAt(from)) from++;
  while (a > from && b > from && before.charCodeAt(a - 1) === after.charCodeAt(b - 1)) { a--; b--; }
  return { fromA: from, toA: a, fromB: from, toB: b };
}
function publish(j) {
  const retained = j.bases.map(id => transfers.get(id)).filter(Boolean);
  j.encoding = encodeTree(j.tree, ids, { has: id => retained.some(set => set.has(id)) });
  j.sent = new Set();
  send(j, { type: "start", nodeNames: parser.nodeSet.types.map(type => type.name), metrics: j.metrics });
}
function advance(j) {
  if (job !== j) return;
  try {
    const end = performance.now() + 12;
    do {
      const before = performance.now();
      j.tree = j.parse.advance(); j.metrics.advances++;
      j.metrics.maxAdvanceMs = Math.max(j.metrics.maxAdvanceMs, performance.now() - before);
      if (j.tree) {
        j.metrics.parseMs = performance.now() - j.started;
        history.unshift({ source: j.source, tree: j.tree });
        history.length = Math.min(history.length, 3);
        j.parse = null; publish(j); return;
      }
    } while (performance.now() < end);
    j.task = tasks.schedule(() => advance(j), 0);
  } catch (error) { send(j, { type: "error", reason: String(error.message) }); cancel(); }
}
function pull(j) {
  try {
    const records = [], buffers = [];
    let bytes = 0, root = null, done = false;
    while (records.length < 256 && bytes < 65536) {
      const step = j.encoding.next();
      if (step.done) { done = true; break; }
      const record = step.value;
      records.push(record); root = record.id; j.sent.add(root);
      bytes += record.buffer ? record.buffer.byteLength : 64 + (record.children?.length || 0) * 16;
      if (record.buffer) buffers.push(record.buffer.buffer);
    }
    j.root = root ?? j.root;
    if (done) {
      transfers.set(j.id.request, j.sent);
      while (transfers.size > 3) transfers.delete(transfers.keys().next().value);
    }
    send(j, { type: "chunk", records, done, root: j.root }, buffers);
    if (done) job = null;
  } catch (error) { send(j, { type: "error", reason: String(error.message) }); cancel(); }
}
self.onmessage = ({ data: message }) => {
  if (message.type === "cancel") { if (job?.id.request === message.request) cancel(); return; }
  if (message.type === "pull") {
    if (job?.encoding && identityKeys.every(key => message[key] === job.id[key])) pull(job);
    return;
  }
  if (message.type !== "parse") return;
  cancel();
  const j = job = { id: identity(message), bases: message.bases || [], source: message.source,
    metrics: { cacheHit: false, advances: 0, maxAdvanceMs: 0, parseMs: 0 }, started: performance.now() };
  try {
    if (message.version !== WORKER_PROTOCOL || message.build !== IRIS_WORKER_BUILD || typeof message.source !== "string" || message.source.length > 1048576 ||
      ![message.owner, message.request, message.generation, message.revision].every(n => Number.isSafeInteger(n) && n >= 0) ||
      message.configuration !== `${message.kind}:${JSON.stringify(message.options)}`) throw new Error("Worker protocol/configuration mismatch");
    const nextScope = `${message.owner}/${message.generation}/${message.configuration}`;
    if (scope !== nextScope) { reset(); scope = nextScope; parser = createParser(message.kind, message.options); }
    const cached = history.find(entry => entry.source === message.source);
    if (cached) {
      history = [cached, ...history.filter(entry => entry !== cached)];
      j.tree = cached.tree; j.metrics.cacheHit = true; publish(j); return;
    }
    let best = null;
    for (const entry of history) {
      // Minimize the actual edit, not the absolute number of equal units. A
      // longer history version otherwise wins merely by having an extra prefix,
      // even when an earlier completed version differs by one body character.
      const change = difference(entry.source, message.source), score = -(change.toA - change.fromA + change.toB - change.fromB);
      if (!best || score > best.score) best = { entry, change, score };
    }
    const fragments = best ? TreeFragment.applyChanges(TreeFragment.addTree(best.entry.tree), [best.change]) : [];
    j.parse = parser.startParse(message.source, fragments);
    j.task = tasks.schedule(() => advance(j), 0);
  } catch (error) { send(j, { type: "error", reason: String(error.message) }); cancel(); }
};
