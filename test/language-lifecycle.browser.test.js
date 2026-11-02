const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser, readySyntax } = require("./helpers/language-browser.cjs");
const { save, machine } = require("./helpers/language-performance.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";
let pageFor;
test.before(async t => { if (enabled) pageFor = await languageBrowser(t); });

test("HP08 100 mounted document/file/project replacements retire trees and bound post-GC heap", { skip: !enabled, timeout: 180000 }, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "\\section{Initial}" }]);
  const workers = new Set(); let peakWorkers = 0, createdWorkers = 0, closedWorkers = 0;
  page.on("worker", worker => {
    if (!worker.url().includes("/vendor/language-worker/")) return;
    workers.add(worker); createdWorkers++; peakWorkers = Math.max(peakWorkers, workers.size);
    worker.on("close", () => { workers.delete(worker); closedWorkers++; });
  });
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view"), { syntaxTree } = await import("@codemirror/language");
    const { LRParser } = await import("@lezer/lr");
    window.life = { refs: [], starts: 0, latest: null, stale: [] };
    const original = LRParser.prototype.createParse;
    LRParser.prototype.createParse = function (...args) { life.starts++; return original.apply(this, args); };
    life.capture = () => { const v = EditorView.findFromDOM(document.querySelector(".cm-editor")); life.refs.push(new WeakRef(v.state.doc), new WeakRef(syntaxTree(v.state))); };
    IrisEditor.onSyntax(s => { if (s && s.generation !== IrisEditor.syntaxSnapshot()?.generation) life.stale.push(s.generation); });
  });
  const report = { machine: machine(), browser: page.context().browser().version(), heaps: [] };
  async function heap(switches) {
    await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
    const usage = await cdp.send("Runtime.getHeapUsage");
    const retained = await page.evaluate(() => life.refs.filter(r => r.deref()).length);
    report.heaps.push({ switches, ...usage, retainedClosedObjects: retained }); await save("lifecycle", report);
  }
  await readySyntax(page); await heap(0);
  for (let i = 1; i <= 100; i++) {
    await page.evaluate(async i => {
      life.capture();
      const kind = i % 2 ? "tex" : "ly", content = kind === "tex" ? `\\section{Project ${i}}\n` + ("ordinary text " + i + "\n").repeat(6500)
        : `\\header { title = "Project ${i}" }\n` + (`% unique ${i} retained source\n`).repeat(4200) + "\\score { c4 }";
      // Start work that must be cancelled on replacement, including same paths.
      if (i % 10 === 0) IrisEditor.load("\\section{Abandoned}\n" + "x\n".repeat(40000), "tex");
      await IrisApp.load({ id: `project-${i}`, language: "en", activeId: "main", openTabs: ["main", "other"], autoSave: false,
        project: { nodes: [{ id: "main", type: "file", kind, name: `main.${kind}`, path: `main.${kind}`, content },
          { id: "other", type: "file", kind, name: `other.${kind}`, path: `other.${kind}`, content: kind === "tex" ? "\\label{Other}" : "other = { d4 }" }] } });
    }, i);
    await readySyntax(page);
    await page.locator('#tree .node[data-id="other"]').click(); await readySyntax(page);
    await page.locator('#tree .node[data-id="main"]').click(); await readySyntax(page);
    if (i % 25 === 0) await heap(i);
  }
  report.stability = await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view"), { syntaxTree } = await import("@codemirror/language");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor")), tree = syntaxTree(view.state), snapshot = IrisEditor.syntaxSnapshot(), before = life.starts;
    IrisEditor.select(4); IrisEditor.setPeers([{ id: "peer", head: 5, anchor: 5 }]); IrisTheme.setPreference(IrisTheme.resolved() === "light" ? "dark" : "light");
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    return { tree: syntaxTree(view.state) === tree, snapshot: IrisEditor.syntaxSnapshot() === snapshot, starts: life.starts - before, stale: life.stale };
  });
  await save("lifecycle", report); t.diagnostic(JSON.stringify(report));
  assert.deepEqual(report.stability, { tree: true, snapshot: true, starts: 0, stale: [] });
  assert.ok(report.heaps.at(-1).retainedClosedObjects <= 4, "closed document trees must be collectible");
  // 100 unique ~100 KiB documents would retain >10 MiB of source alone. Check
  // Compare the same active language at 50 and 100. Odd checkpoints hold a TeX
  // tree, even checkpoints a LilyPond tree: unlike active heaps aren't a leak.
  assert.ok(report.heaps.at(-1).usedSize - report.heaps.find(h => h.switches === 50).usedSize < 4 * 1024 * 1024, "no source-proportional growth after warmup");
  await cdp.detach();
  await page.close();
  const deadline = Date.now() + 5000;
  while (workers.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  report.workers = { created: createdWorkers, closed: closedWorkers, peak: peakWorkers, liveAfterClose: workers.size };
  await save("lifecycle", report); t.diagnostic(JSON.stringify(report.workers));
  assert.ok(createdWorkers >= 100, "the real replacement workload must exercise Worker lifetimes");
  assert.ok(peakWorkers <= 2); assert.equal(workers.size, 0); assert.equal(closedWorkers, createdWorkers);
});

test("HP08 actual completion cache cold/warm deletion same-path reuse config change and cancellation", { skip: !enabled, timeout: 60000 }, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "\\ref{}" }]);
  await readySyntax(page);
  const result = await page.evaluate(async () => {
    const { createProjectCache } = await import("/iris-language-completion.mjs");
    const cache = createProjectCache(), node = (id, name) => ({ id, type: "file", name: "same.tex", content: `\\label{${name}}\n` + "text\n".repeat(20000) });
    let scope = { projectId: "one", nodes: [node("a", "cold")] };
    const start = performance.now(), cold = await cache.read(scope), coldMs = performance.now() - start;
    const warmStart = performance.now(), warm = await cache.read(scope), warmMs = performance.now() - warmStart;
    const same = cold[0].data === warm[0].data;
    scope = { projectId: "one", nodes: [] }; const deleted = await cache.read(scope);
    scope = { projectId: "one", nodes: [node("b", "reused")] }; const reused = await cache.read(scope);
    const pending = cache.read({ projectId: "old", nodes: [node("c", "obsolete")] });
    const replacement = await cache.read({ projectId: "new", generation: 2, nodes: [node("d", "current")] });
    const cancelled = await pending;
    const changed = await cache.read({ projectId: "new", generation: 3, nodes: [{ id: "d", name: "same.sty", content: "\\newcommand{\\local@name}{}" }] });
    const plain = await cache.read({ projectId: "new", generation: 4, nodes: [{ id: "d", name: "same.tex", content: "\\newcommand{\\local@name}{}" }] });
    const names = entries => entries.flatMap(e => e.data?.symbols.map(s => s.name) || []);
    const result = { coldMs, warmMs, same, deleted: names(deleted), reused: names(reused), cancelled,
      replacement: names(replacement), changed: names(changed), plain: names(plain), obsoleteCurrent: cache.isCurrent(cold) };
    cache.dispose();
    return result;
  });
  await save("cache", result); t.diagnostic(JSON.stringify(result));
  assert.equal(result.same, true); assert.deepEqual(result.deleted, []); assert.deepEqual(result.reused, ["reused"]);
  assert.equal(result.cancelled, null); assert.deepEqual(result.replacement, ["current"]);
  assert.deepEqual(result.changed, ["local@name"]); assert.equal(result.plain.includes("local@name"), false); assert.equal(result.obsoleteCurrent, false);
  // The shipped editor's project cache must also drive the real popup, replacing
  // old results even when path and project ID are reused.
  for (const name of ["First", "Second"]) {
    await page.evaluate(async name => {
      IrisEditor.setCompletionContext({ projectId: "popup", generation: name, activePath: "main.tex", nodes: [{ id: name, name: "same.tex", content: `\\label{${name}}` }] });
      IrisEditor.select(5); IrisEditor.focus();
      const { startCompletion } = await import("@codemirror/autocomplete"), { EditorView } = await import("@codemirror/view");
      startCompletion(EditorView.findFromDOM(document.querySelector(".cm-editor")));
    }, name);
    await page.waitForFunction(name => [...document.querySelectorAll(".cm-completionLabel")].some(n => n.textContent === name), name);
    assert.deepEqual(await page.locator(".cm-completionLabel").allTextContents(), [name]);
  }
});
