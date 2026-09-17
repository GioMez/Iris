/** Owned task queue for browser and Node. Positive delays remain timers (the
 * 250 ms debounce); zero-delay continuation uses setImmediate in Node, otherwise
 * MessageChannel when available. Node MessagePort batches can starve timers.
 * No microtask-only yielding: input, timers and cancellation must get a turn.
 * Ports close on idle, cancellation and disposal, including rejected analyses.
 */
export function createTaskScheduler() {
  let channel = null, nextID = 0, disposed = false;
  const pending = new Map();
  function closeChannel() {
    if (channel) {
      channel.port1.onmessage = null;
      channel.port1.close(); channel.port2.close(); channel = null;
    }
  }
  const closeIfIdle = () => { if (!pending.size) closeChannel(); };
  function invoke(id) {
    const task = pending.get(id);
    if (!task || disposed) return;
    pending.delete(id);
    try { task.fn(); }
    finally {
      // Let an awaiting continuation enqueue its next task before closing ports.
      queueMicrotask(closeIfIdle);
    }
  }
  function schedule(fn, delay = 0) {
    if (disposed) throw new Error("Task scheduler disposed");
    const id = ++nextID, task = { fn, timer: null, immediate: null };
    pending.set(id, task);
    if (delay > 0 || typeof MessageChannel === "undefined") task.timer = setTimeout(() => invoke(id), delay);
    else if (typeof globalThis.setImmediate === "function") task.immediate = globalThis.setImmediate(() => invoke(id));
    else {
      if (!channel) {
        channel = new MessageChannel();
        channel.port1.onmessage = event => invoke(event.data);
      }
      channel.port2.postMessage(id);
    }
    return id;
  }
  function cancel(id) {
    const task = pending.get(id);
    if (task && task.timer !== null) clearTimeout(task.timer);
    if (task && task.immediate !== null) globalThis.clearImmediate(task.immediate);
    pending.delete(id); closeIfIdle();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const task of pending.values()) {
      if (task.timer !== null) clearTimeout(task.timer);
      if (task.immediate !== null) globalThis.clearImmediate(task.immediate);
    }
    pending.clear(); closeChannel();
  }
  return Object.freeze({ schedule, cancel, dispose });
}
