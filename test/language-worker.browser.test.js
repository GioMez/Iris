const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser } = require("./helpers/language-browser.cjs");
const { workload, save, machine } = require("./helpers/language-performance.cjs");
const { loadFixtures } = require("./helpers/language-fixtures.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";

test("owned large parse publishes EOF without full LR construction on the main thread", { skip: !enabled, timeout: 60000 }, async t => {
  const pageFor = await languageBrowser(t, { beforeNavigate: async page => {
    await page.addInitScript(() => { window.workerSourceReadMax = 0; });
    await page.route("**/iris-language-parser.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      const hook = "function create(input, fragments, ranges, doc, viewport) {";
      assert.ok(source.includes(hook));
      await route.fulfill({ response, body: source.replace(hook, hook + `
        const originalInput = input;
        input = { length: originalInput.length, lineChunks: originalInput.lineChunks, chunk: pos => originalInput.chunk(pos),
          read(from, to) { workerSourceReadMax = Math.max(workerSourceReadMax, to - from); return originalInput.read(from, to); } };`) });
    });
  } });
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "text" }]);
  const result = await page.evaluate(async () => {
    const { LRParser } = await import("@lezer/lr");
    const { EditorView } = await import("@codemirror/view");
    const { syntaxTreeAvailable, syntaxTree } = await import("@codemirror/language");
    const original = LRParser.prototype.createParse;
    let full = 0, prefixes = 0;
    LRParser.prototype.createParse = function (...args) {
      const parse = original.apply(this, args), advance = parse.advance;
      parse.advance = function () { const tree = advance.call(this); if (tree) { if (this.stoppedAt === null) full++; else prefixes++; } return tree; };
      return parse;
    };
    const source = "{x} $a_1+\\alpha$ ".repeat(6000) + "\\section{Worker EOF}";
    IrisEditor.loadCollab(source, "tex", { version: 0, path: "worker.tex" });
    const start = performance.now();
    while (IrisEditor.syntaxSnapshot()?.status !== "ready" && performance.now() - start < 10000) await new Promise(r => setTimeout(r, 10));
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    LRParser.prototype.createParse = original;
    return { full, prefixes, sourceReadMax: workerSourceReadMax, status: IrisEditor.syntaxSnapshot()?.status, title: IrisEditor.syntaxSnapshot()?.outline.at(-1)?.title,
      covered: syntaxTreeAvailable(view.state), length: syntaxTree(view.state).length, expected: source.length };
  });
  assert.equal(result.full, 0, "a full tree-returning LR advance must run in the Worker");
  assert.ok(result.prefixes > 0, "immediate syntax must still be a real main-thread parse");
  assert.equal(result.status, "ready"); assert.equal(result.covered, true);
  assert.equal(result.title, "Worker EOF"); assert.equal(result.length, result.expected);
  assert.ok(result.sourceReadMax <= 4096, `Worker source preparation must also bound CM input reads: ${result.sourceReadMax}`);
});

test("Worker local bundle constructs real trees, reuses retained roots, and scopes configuration", { skip: !enabled, timeout: 60000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "text" }]);
  const result = await page.evaluate(async () => {
    const module = await import("./iris-language-worker-client.mjs").catch(() => ({}));
    if (!module.createWorkerClient) return { available: false };
    const { loadLanguage } = await import("./iris-language-service.mjs");
    const { Tree, NodeProp } = await import("@lezer/common");
    const adapter = await loadLanguage("tex", { texProfile: "internal" });
    const client = module.createWorkerClient(adapter);
    const source = "\\foo@bar {x} $y$\r\n".repeat(5000) + "\\section{After}";
    try {
      const a = await client.parse(source, { generation: 1, revision: 1 });
      const b = await client.parse("\\begin{verbatim}" + source, { generation: 1, revision: 2 });
      const c = await client.parse(source, { generation: 1, revision: 3 });
      const tree = c.tree;
      return { available: true, statuses: [a.status, b.status, c.status], real: tree instanceof Tree,
        length: tree?.length, expected: source.length, reused: a.tree === tree, cacheHit: c.metrics?.cacheHit,
        title: adapter.summarize(tree, { length: source.length, sliceString: (a, b) => source.slice(a, b) }).outline.at(-1)?.title,
        command: tree.resolveInner(2, 1).to, bracket: tree.resolveInner(source.indexOf("{"), 1).type.prop(NodeProp.closedBy),
        metrics: [a.metrics, b.metrics, c.metrics] };
    } finally { client.dispose(); }
  });
  assert.equal(result.available, true, "shipped real Worker client is required");
  assert.deepEqual(result.statuses, ["ready", "ready", "ready"]);
  assert.equal(result.real, true); assert.equal(result.length, result.expected);
  assert.equal(result.title, "After"); assert.equal(result.command, 8);
  assert.deepEqual(result.bracket, ["CloseBrace"]);
  assert.equal(result.reused, true); assert.equal(result.cacheHit, true);
  assert.ok(result.metrics[0].advances > 0);
  t.diagnostic(JSON.stringify(result.metrics));
});

test("Worker cancellation, generation replacement and disposal settle pending work", { skip: !enabled, timeout: 60000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "ly", name: "main.ly", content: "{ c4 }" }]);
  const result = await page.evaluate(async () => {
    const module = await import("./iris-language-worker-client.mjs").catch(() => ({}));
    if (!module.createWorkerClient) return null;
    const { loadLanguage } = await import("./iris-language-service.mjs");
    const client = module.createWorkerClient(await loadLanguage("tex"));
    const old = client.parse("{x} $y$ ".repeat(100000), { generation: 1, revision: 1 });
    const fresh = client.parse("\\section{New project}", { generation: 2, revision: 2 });
    const a = await old, b = await fresh;
    const pending = client.parse("{x} ".repeat(200000), { generation: 2, revision: 3 });
    client.dispose();
    const c = await pending;
    return [a.status, b.status, b.tree?.length, c.status];
  });
  assert.deepEqual(result, ["unavailable", "ready", 21, "unavailable"]);
});

test("background non-open large analysis also constructs its full tree off the UI thread", { skip: !enabled, timeout: 60000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "text" }]);
  const result = await page.evaluate(async () => {
    const { LRParser } = await import("@lezer/lr");
    const { analyze } = await import("./iris-language-service.mjs");
    const original = LRParser.prototype.createParse;
    let starts = 0;
    LRParser.prototype.createParse = function (...args) { starts++; return original.apply(this, args); };
    try {
      const result = await analyze("tex", "{x} $y$ ".repeat(5000) + "\\section{Batch}");
      return { starts, status: result.status, title: result.data.outline.at(-1)?.title };
    } finally { LRParser.prototype.createParse = original; }
  });
  assert.deepEqual(result, { starts: 0, status: "ready", title: "Batch" });
});

test("Worker stress proof distinguishes cold, exact undo and literal-body-modified restoration", { skip: !enabled, timeout: 120000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "text" }]);
  const w = workload("tex", 1024 * 1024);
  const result = await page.evaluate(async source => {
    const { createWorkerClient } = await import("./iris-language-worker-client.mjs");
    const { loadLanguage, runCooperatively } = await import("./iris-language-service.mjs");
    const adapter = await loadLanguage("tex"), client = createWorkerClient(adapter), results = [];
    let revision = 0;
    const prefix = "\\begin{verbatim}\n", at = source.indexOf("a_1"), modified = source.slice(0, at) + "b" + source.slice(at + 1);
    try {
      for (const [name, text] of [["cold", source], ["open", prefix + source], ["exact-undo", source], ["open-again", prefix + source],
        ["literal-body-edit", prefix + modified], ["modified-restore", modified]]) {
        const start = performance.now(), result = await client.parse(text, { generation: 0, revision: ++revision });
        if (result.status !== "ready") return { failure: result.reason };
        const fullMs = performance.now() - start;
        const doc = { length: text.length, sliceString: (a, b) => text.slice(a, b) };
        const summary = await runCooperatively(adapter.summarySteps(result.tree, doc));
        results.push({ name, fullMs, summaryMs: performance.now() - start, metrics: result.metrics,
          length: result.tree.length, mode: adapter.contextAt(result.tree, doc, at + (name.includes("open") || name === "literal-body-edit" ? prefix.length : 0) + 1).mode,
          outline: summary.outline.length });
      }
      return { results };
    } finally { client.dispose(); }
  }, w.source);
  await save("worker-stress-proof", { machine: machine(), browser: page.context().browser().version(), ...result });
  assert.equal(result.failure, undefined);
  assert.equal(result.results.find(r => r.name === "exact-undo").metrics.cacheHit, true);
  const modified = result.results.find(r => r.name === "modified-restore");
  assert.equal(modified.metrics.cacheHit, false); assert.ok(modified.metrics.advances > 0);
  assert.ok(modified.metrics.advances < result.results[0].metrics.advances / 10,
    "a retained normal version with one body edit must supply genuine incremental reuse");
  assert.equal(modified.mode, "math");
  t.diagnostic(JSON.stringify(result));
});

test("missing Worker asset leaves large editor editing available with explicit unavailable syntax", { skip: !enabled, timeout: 60000 }, async t => {
  const pageFor = await languageBrowser(t, { beforeNavigate: async page => {
    await page.route("**/vendor/language-worker/worker.mjs", route => route.fulfill({ status: 404, body: "missing" }));
  } });
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "{x} ".repeat(10000) }]);
  await page.waitForFunction(() => IrisEditor.syntaxSnapshot()?.status === "unavailable");
  const result = await page.evaluate(() => {
    const before = IrisEditor.syntaxSnapshot(); IrisEditor.replaceRange(0, 0, "edit ");
    return { reason: before.limitReason, text: IrisEditor.getValue().slice(0, 5) };
  });
  assert.deepEqual(result, { reason: "worker-unavailable", text: "edit " });
});

test("real Worker bundle matches corpus and incremental recovery with retained large groups", { skip: !enabled, timeout: 120000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "text" }]);
  const result = await page.evaluate(async fixtures => {
    const { createWorkerClient } = await import("./iris-language-worker-client.mjs");
    const { loadLanguage } = await import("./iris-language-service.mjs");
    const { highlightTree } = await import("@lezer/highlight");
    const { roleHighlighter } = await import("./iris-syntax-style.mjs");
    const failures = [], shared = [], configs = [["tex", {}], ["tex", { texProfile: "internal" }], ["tex", { texProfile: "expl3" }],
      ...["nederlands", "italiano", "english", "deutsch", "unknown"].map(initialNoteLanguage => ["ly", { initialNoteLanguage }])];
    let comparisons = 0;
    for (const [kind, options] of configs) {
      const adapter = await loadLanguage(kind, options), client = createWorkerClient(adapter);
      let revision = 0;
      const signature = (tree, text) => {
        const nodes = [], roles = [], doc = { length: text.length, sliceString: (a, b) => text.slice(a, b) };
        tree.iterate({ enter: n => nodes.push([n.name, n.from, n.to]) });
        highlightTree(tree, roleHighlighter, (a, b, r) => roles.push([a, b, r]));
        return JSON.stringify({ nodes, roles, summary: adapter.summarize(tree, doc), contexts: [0, 10, text.length].map(p => adapter.contextAt(tree, doc, Math.min(p, text.length))) });
      };
      try {
        for (const fixture of fixtures.filter(f => f.kind === kind)) {
          const result = await client.parse(fixture.source, { generation: 0, revision: ++revision });
          if (result.status !== "ready" || signature(result.tree, fixture.source) !== signature(adapter.language.parser.parse(fixture.source), fixture.source)) failures.push(`${kind}/${JSON.stringify(options)}/${fixture.id}`);
          comparisons++;
        }
        // Leave an unchanged lookahead gap before Group, as in the existing
        // raw/owned identity fixture. Editing its adjacent opener invalidates
        // Group in Lezer itself and cannot require whole-Group identity.
        const gap = " header".repeat(80);
        let text = "% header" + gap + "\r\n{" + (kind === "tex" ? "plain $x$ " : "c4 d8 r2 ").repeat(5000) + "} tail";
        let previous;
        for (const insert of ["", " remote", " remote repaired"]) {
          text = "% header" + insert + gap + "\r\n" + text.slice(text.indexOf("{") );
          const result = await client.parse(text, { generation: 1, revision: ++revision });
          if (result.status !== "ready" || signature(result.tree, text) !== signature(adapter.language.parser.parse(text), text)) failures.push(`${kind}/incremental`);
          const group = result.tree.topNode.getChild("Group")?.toTree();
          if (previous) shared.push(group === previous);
          previous = group; comparisons++;
        }
      } finally { client.dispose(); }
    }
    return { failures, shared, comparisons };
  }, loadFixtures().map(({ id, kind, source }) => ({ id, kind, source })));
  assert.deepEqual(result.failures, []); assert.ok(result.shared.length > 0 && result.shared.every(Boolean));
  t.diagnostic(`${result.comparisons} full Worker/cold signatures; ${result.shared.length} identical retained large Groups`);
});
