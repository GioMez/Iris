// Test-only policy/observer, shared verbatim with the mounted browser probe.
// Timestamps are event data; this module never replaces a clock or editor API.
function installMetrics() {
  const gateVersion = "hp08-v2-publication-edit-scope";
  const p95 = values => values.length ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
  const identity = s => s ? { kind: s.kind, generation: s.generation, revision: s.revision } : null;
  const same = (a, b) => !!a && !!b && a.kind === b.kind && a.generation === b.generation && a.revision === b.revision;
  function createPublicationRecorder() {
    let active = null;
    return {
      begin(start) { active = { start, target: null, events: [] }; },
      bind(snapshot, length) {
        if (!active || !snapshot) throw new Error("Publication observation needs an active target");
        active.target = { ...identity(snapshot), length };
      },
      observe(snapshot, current, at) {
        if (!active) return;
        active.events.push({ at, ...identity(snapshot), status: snapshot?.status ?? null, parsedTo: snapshot?.parsedTo ?? null,
          currentIdentity: identity(current), isCurrentSnapshot: !!snapshot && snapshot === current });
      },
      finish(current, end) {
        if (!active?.target) throw new Error("Publication target was not bound");
        const { start, target, events } = active;
        const eligible = e => same(target, current) && same(e, target) && same(e.currentIdentity, target)
          && e.isCurrentSnapshot && e.at >= start && e.at <= end;
        const ready = events.find(e => eligible(e) && e.status === "ready" && e.parsedTo === target.length);
        const unavailable = events.find(e => eligible(e) && e.status === "unavailable");
        const result = { target, currentIdentity: identity(current), events: events.slice(),
          readyPublicationMs: ready ? ready.at - start : null,
          unavailablePublicationMs: unavailable ? unavailable.at - start : null };
        active = null;
        return result;
      },
    };
  }
  const overlaps = (task, window) => task.start < window.endTime && task.start + task.duration > window.startTime;
  const statistics = values => {
    const valid = values.filter(v => Number.isFinite(v) && v >= 0);
    return { count: values.length, publications: valid.length, missing: values.length - valid.length,
      p95Ms: valid.length === values.length ? p95(valid) : null, maxMs: valid.length ? Math.max(...valid) : null };
  };
  function evaluate(report) {
    const { samples, loads, workload } = report, limited = workload.codeUnits > 1048576;
    const failures = [], legacy = [], p95ByMode = {}, summary = {};
    for (const mode of [...new Set(samples.map(s => s.mode))]) {
      const all = samples.filter(s => s.mode === mode), measured = all.filter(s => !s.warmup);
      p95ByMode[mode] = Object.fromEntries(["visibleMs", "summaryMs", "dispatchMs"].map(key => [key, p95(measured.map(s => s[key]))]));
      summary[mode] = { measured: statistics(measured.map(s => s.readyPublicationMs)), all: statistics(all.map(s => s.readyPublicationMs)) };
      if (workload.label === "100k" || workload.label.endsWith("1m")) {
        const target = workload.label === "100k" ? 50 : 100;
        if (p95ByMode[mode].visibleMs > target) {
          const failure = `${mode} visible p95 ${p95ByMode[mode].visibleMs} > ${target} ms`;
          failures.push(failure); legacy.push(failure);
        }
        if (workload.label.endsWith("1m") && p95ByMode[mode].summaryMs > 500) legacy.push(`${mode} summary p95 ${p95ByMode[mode].summaryMs} > 500 ms`);
      }
      for (const s of all) {
        const name = `${mode}[${s.index}]${s.warmup ? " warmup" : " measured"}`;
        if (!limited) {
          if (s.status !== "ready" || !Number.isFinite(s.readyPublicationMs) || s.readyPublicationMs < 0) failures.push(`${name} missing current ready publication`);
          else if (workload.label.endsWith("1m") && s.readyPublicationMs > 500) failures.push(`${name} ready publication ${s.readyPublicationMs} > 500 ms`);
        } else if (s.status !== "unavailable" || s.readyPublicationMs !== null) failures.push(`${name} limited state must be unavailable, not a ready summary`);
      }
    }
    if (workload.label.endsWith("1m") && loads.some(l => l.firstViewportMs > 200)) { failures.push("first viewport > 200 ms"); legacy.push("first viewport > 200 ms"); }
    // Include late observer delivery and cross-phase overlap. A task retains its
    // raw identity; its original array/phase label cannot exempt blocked typing.
    const unique = new Map();
    for (const t of [...(report.observedLongTasks || []), ...[...loads, ...samples].flatMap(s => s.longTasks)]) unique.set(JSON.stringify(t), t);
    const tasks = [...unique.values()].sort((a, b) => a.start - b.start);
    const inWindows = windows => tasks.filter(t => windows.some(w => overlaps(t, w)));
    const describe = values => ({ count: values.length, over50Count: values.filter(t => t.duration > 50).length,
      maximumMs: Math.max(0, ...values.map(t => t.duration)), tasks: values });
    const longTasks = { loads: describe(inWindows(loads)), edits: describe(inWindows(samples)),
      combined: describe(inWindows([...loads, ...samples])),
      attribution: "PerformanceObserver window attribution only. All edit overlap is strict; load feature attribution and 5/8ms budgets need separate profiles." };
    if (longTasks.edits.maximumMs > 50) failures.push(`edit-overlapping long task ${longTasks.edits.maximumMs} > 50 ms (warmups included)`);
    if (longTasks.combined.maximumMs > 50) legacy.push(`observed long task ${longTasks.combined.maximumMs} ms; attribution requires diagnostic profile`);
    return { gateVersion, failures, p95: p95ByMode, summary, longTasks,
      legacyWholeWindow: { gateVersion: "hp08-v1-whole-window-summary-observed-p95", assessment: "v1 policy replay on this new run; not a historical result rewrite", passed: !legacy.length, failures: legacy } };
  }
  const api = { gateVersion, createPublicationRecorder, evaluate, overlaps };
  if (typeof window !== "undefined") { window.hp08Metrics = api; return; }
  return api;
}
module.exports = { ...installMetrics(), installMetrics };
