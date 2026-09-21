const test = require("node:test"), assert = require("node:assert/strict");
const { languageBrowser } = require("./helpers/language-browser.cjs");
const { installProbe, workload } = require("./helpers/language-performance.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";
let pageFor;
test.before(async t => { if (enabled) pageFor = await languageBrowser(t); });

test("HP08 metric observer records real onSyntax publication before post-ready frame observation", { skip: !enabled, timeout: 30000 }, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "" }]);
  await installProbe(page);
  await page.evaluate(w => { window.hp08Workload = w; window.auditPublications = [];
    IrisEditor.onSyntax(s => { if (s?.status === "ready") auditPublications.push({ at: performance.now(), kind: s.kind,
      generation: s.generation, revision: s.revision, current: s === IrisEditor.syntaxSnapshot() }); });
  }, workload("tex", 100 * 1024));
  const results = [await page.evaluate(() => hp08.load(hp08Workload))];
  for (const mode of ["local", "remote", "context"]) {
    await page.evaluate(() => hp08.load(hp08Workload));
    for (let i = 0; i < 2; i++) results.push(await page.evaluate(({ mode, i }) => hp08.edit(hp08Workload, mode, i), { mode, i }));
  }
  const audit = await page.evaluate(() => auditPublications);
  for (const r of results) {
    assert.equal(typeof r.readyPublicationMs, "number", "ready must come from a recorded callback");
    assert.ok(r.readyPublicationMs >= 0);
    assert.ok(r.readyPublicationMs <= (r.summaryObservedMs ?? r.syntaxReadyMs));
    const target = r.publication.target;
    assert.ok(audit.some(e => e.current && e.kind === target.kind && e.generation === target.generation && e.revision === target.revision
      && e.at >= r.startTime + r.readyPublicationMs && e.at <= r.endTime), "independent real listener observes the same current identity");
    assert.equal(r.unavailablePublicationMs, null);
    if (r.mode) assert.equal(r.summaryMs, r.summaryObservedMs, "legacy observation is retained byte-for-byte");
  }
});

test("HP08 observer cannot use replacement ready events or 5MiB unavailability as the requested summary", { skip: !enabled, timeout: 30000 }, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "" }]);
  await installProbe(page);
  await page.evaluate(w => { window.hp08Workload = w; }, workload("tex", 100 * 1024));
  const replaced = await page.evaluate(async () => {
    hp08.publications.begin(performance.now());
    IrisEditor.loadCollab(hp08Workload.source, "tex", { version: 0, path: "one.tex" });
    hp08.publications.bind(IrisEditor.syntaxSnapshot(), hp08.view().state.doc.length);
    IrisEditor.loadCollab("\\section{Replacement}", "tex", { version: 0, path: "two.tex" });
    while (IrisEditor.syntaxSnapshot()?.status !== "ready") await new Promise(requestAnimationFrame);
    return hp08.publications.finish(IrisEditor.syntaxSnapshot(), performance.now());
  });
  assert.equal(replaced.readyPublicationMs, null);
  assert.ok(replaced.events.some(e => e.status === "ready" && e.generation !== replaced.target.generation));
  await page.evaluate(w => { window.hp08Workload = w; }, workload("tex", 5 * 1024 * 1024));
  const limited = await page.evaluate(() => hp08.load(hp08Workload));
  assert.equal(limited.status, "unavailable"); assert.equal(limited.readyPublicationMs, null);
  assert.equal(typeof limited.unavailablePublicationMs, "number"); assert.equal(limited.lrStarts, 0);
});
