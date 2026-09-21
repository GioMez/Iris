// Diagnostic only: preserves the exact gate loadCollab/select/focus sequence.
// Counter/stack/CPU overhead is reported, never substituted for clean timings.
const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser } = require("./helpers/language-browser.cjs");
const { workload, save, machine, installProbe } = require("./helpers/language-performance.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1" && process.env.IRIS_LANGUAGE_QUALIFY === "1";

function syncProfile(profile, navigationStart, from, to) {
  const times = new Map(); let elapsed = profile.startTime / 1000 - navigationStart * 1000, count = 0;
  profile.samples.forEach((id, i) => {
    elapsed += profile.timeDeltas[i] / 1000;
    if (elapsed >= from && elapsed <= to) { times.set(id, (times.get(id) || 0) + profile.timeDeltas[i] / 1000); count++; }
  });
  return { samples: count, top: profile.nodes.map(n => ({ name: n.callFrame.functionName, url: n.callFrame.url,
    line: n.callFrame.lineNumber + 1, selfMs: times.get(n.id) || 0 })).filter(n => n.selfMs).sort((a, b) => b.selfMs - a.selfMs) };
}

for (const bytes of [1048576, 5 * 1048576]) test(`HP08 exact synchronous load attribution tex ${bytes}`, { skip: !enabled, timeout: 180000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "" }]);
  await installProbe(page);
  const w = workload("tex", bytes);
  await page.evaluate(w => { window.hp08Workload = w; }, w);
  await page.evaluate(async () => {
    const { Text } = await import("@codemirror/state");
    const original = Text.prototype.toString;
    window.loadTrace = { active: false };
    Text.prototype.toString = function (...args) {
      if (!loadTrace.active) return original.apply(this, args);
      const caller = new Error().stack, start = performance.now();
      const result = original.apply(this, args);
      loadTrace.flatten.push({ from: start, ms: performance.now() - start, length: this.length, caller });
      return result;
    };
    for (const name of ["loadCollab", "select", "focus", "getValue", "snapshot"]) {
      const original = IrisEditor[name];
      IrisEditor[name] = function (...args) {
        if (!loadTrace.active) return original.apply(this, args);
        const start = performance.now();
        try { return original.apply(this, args); }
        finally {
          loadTrace.calls.push({ name, from: start, ms: performance.now() - start });
          if (name === "focus") { loadTrace.to = performance.now(); loadTrace.active = false; }
        }
      };
    }
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable"); await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
  const report = { machine: machine(), browser: page.context().browser().version(), workload: w.metrics, loads: [], preparationEdits: [] };
  for (const phase of ["cold", "after-local-25", "after-remote-25"]) {
    if (phase !== "cold") {
      const mode = phase === "after-local-25" ? "local" : "remote";
      for (let i = 0; i < 25; i++) report.preparationEdits.push(await page.evaluate(({ mode, i }) => hp08.edit(hp08Workload, mode, i), { mode, i }));
    }
    const { metrics } = await cdp.send("Performance.getMetrics"), navigationStart = metrics.find(m => m.name === "NavigationStart").value;
    await cdp.send("Profiler.start");
    const sample = await page.evaluate(async () => {
      window.loadTrace = { active: true, from: performance.now(), flatten: [], calls: [] };
      const result = await hp08.load(hp08Workload);
      return { ...result, trace: loadTrace };
    });
    const { profile } = await cdp.send("Profiler.stop");
    const sync = syncProfile(profile, navigationStart, sample.trace.from, sample.trace.to);
    report.loads.push({ phase, ...sample, navigationStart, profile, sync });
    await save(`load-attribution-tex-${bytes}`, report);
    assert.ok(sample.ok && sample.syntaxReady); assert.ok(sync.samples > 0, "CPU slice must cover the measured synchronous task");
    if (bytes > 1048576) assert.equal(sample.lrStarts, 0);
    t.diagnostic(JSON.stringify({ phase, dispatchMs: sample.dispatchMs, longTasks: sample.longTasks,
      trace: sample.trace, sync }));
  }
  await cdp.detach();
});
