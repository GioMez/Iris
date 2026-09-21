const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser } = require("./helpers/language-browser.cjs");
const { workload, representative, machine, save, installProbe } = require("./helpers/language-performance.cjs");
const { gateVersion, evaluate } = require("./helpers/language-metrics.cjs");
const { sourceManifest, hash } = require("./helpers/language-qualification.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";
const qualify = process.env.IRIS_LANGUAGE_QUALIFY === "1";
let pageFor, manifest;
test.before(async t => {
  if (!enabled) return;
  manifest = await sourceManifest();
  await save("source-manifest", manifest);
  t.after(async () => {
    const after = await sourceManifest();
    await save("source-manifest-after", { ...after, unchanged: manifest.digest === after.digest });
    assert.equal(after.digest, manifest.digest, "runtime/harness bytes cannot change during a qualification matrix");
  });
  pageFor = await languageBrowser(t);
});

for (const kind of ["tex", "ly"]) for (const [label, bytes, singleLine] of [
  ["100k", 100 * 1024, false], ["1m", 1024 * 1024, false],
  ["5m", 5 * 1024 * 1024, false], ["longline", 100 * 1024, true],
  ["representative-1m", 1024 * 1024, false],
]) test(`HP08 mounted ${kind} ${label} input-to-visible qualification`, { skip: !enabled, timeout: 600000 }, async t => {
  const w = label === "representative-1m" ? representative(kind) : workload(kind, bytes, singleLine);
  const page = await pageFor(t, [{ id: "main", type: "file", kind, name: `main.${kind}`, content: "" }]);
  await installProbe(page);
  // Transfer the large source once, outside every timed evaluation. Passing it
  // with each edit would include Playwright JSON decode/GC in long-task records.
  await page.evaluate(w => { window.hp08Workload = w; }, w);
  const report = { gateVersion, sourceManifestDigest: manifest.digest, sourceSHA256: hash(w.source), machine: machine(), browser: page.context().browser().version(), workload: { kind, label, ...w.metrics, singleLine },
    method: "actual Iris EditorView; local replaceRange / collabReceive serialized ChangeSet; unchanged two-rAF role paint; onSyntax current-generation/revision publication; network excluded from load", loads: [], samples: [], failures: [] };
  const name = `${kind}-${label}`;
  try {
    for (const mode of ["local", "remote", "context"]) {
      const load = await page.evaluate(() => hp08.load(hp08Workload));
      report.loads.push({ mode, cold: mode === "local", ...load });
      await save(name, report);
      assert.ok(load.ok && load.syntaxReady, JSON.stringify(load));
      if (label !== "5m") assert.equal(typeof load.readyPublicationMs, "number", "load readiness needs an actual current onSyntax publication");
      if (label === "5m") { assert.equal(load.status, "unavailable"); assert.equal(load.lrStarts, 0); assert.equal(load.covered, false); }
      for (let i = 0; i < 25; i++) {
        const sample = await page.evaluate(({ mode, i }) => hp08.edit(hp08Workload, mode, i), { mode, i });
        report.samples.push(sample);
        await save(name, report);
        assert.ok(sample.visible && sample.syntaxReady, JSON.stringify(sample));
      }
    }
    report.observedLongTasks = await page.evaluate(() => hp08.observedLongTasks());
    Object.assign(report, evaluate(report));
    t.diagnostic(JSON.stringify({ gateVersion, workload: report.workload, p95: report.p95, summary: report.summary,
      loads: report.loads, longTasks: report.longTasks, failures: report.failures, legacyWholeWindow: report.legacyWholeWindow }));
    if (qualify) assert.deepEqual(report.failures, [], "approved performance budgets (raw samples retained)");
  } finally { await save(name, report); }
});
