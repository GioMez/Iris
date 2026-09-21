const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser } = require("./helpers/language-browser.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";

test("current editor text is flattened once per document version and stays synchronous across edits, undo, resync and close", { skip: !enabled, timeout: 60000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "" }]);
  const result = await page.evaluate(async () => {
    const { Text, ChangeSet } = await import("@codemirror/state");
    const original = Text.prototype.toString;
    let calls = 0;
    Text.prototype.toString = function (...args) { calls++; return original.apply(this, args); };
    const records = [];
    function capture(name, action, expected) {
      calls = 0; action();
      const values = Array.from({ length: 8 }, () => [IrisEditor.getValue(), IrisEditor.snapshot()]);
      records.push({ name, calls, expected, values });
    }
    try {
      const text = "\\section{Raw}\r\nBody 😀\rtail", normalized = text.replace(/\r\n?/g, "\n");
      capture("normal load", () => IrisEditor.load(text, "tex"), normalized);
      const revision = IrisEditor.snapshot().revision;
      capture("selection/configuration", () => { IrisEditor.select(4); IrisEditor.setWordWrap(true); IrisEditor.setLanguage("tex", { path: "main.sty" }); }, normalized);
      capture("edit", () => IrisEditor.replaceRange(normalized.length, normalized.length, "!"), normalized + "!");
      capture("undo", () => IrisEditor.undo(), normalized);
      for (const [kind, source] of [["bib", "% before\r\n@book{k,title={A😀\rbare}}\r\n"], ["ris", "TY  - BOOK\r\nTI  - A😀\rAU  - Writer\r\nER  -\r\n"]]) {
        capture(`${kind} raw load`, () => IrisEditor.load(source, kind), source);
        capture(`${kind} resync`, () => IrisEditor.loadCollab(source, kind, { version: 0 }), source);
        const changes = ChangeSet.of({ from: 0, insert: Text.of(["% peer\r", ""]) }, source.length);
        capture(`${kind} remote`, () => IrisEditor.collabReceive([{ clientID: "peer", changes: changes.toJSON() }]), "% peer\r\n" + source);
        capture(`${kind} raw local edit`, () => IrisEditor.replaceRange(0, 0, "😀\r\n"), "😀\r\n% peer\r\n" + source);
        capture(`${kind} raw undo`, () => IrisEditor.undo(), "% peer\r\n" + source);
      }
      capture("close", () => IrisEditor.load("", null), "");
      return { records, revision };
    } finally { Text.prototype.toString = original; }
  });
  for (const record of result.records) {
    for (const [value, snapshot] of record.values) {
      assert.equal(typeof value, "string", record.name);
      assert.equal(value, record.expected, record.name); assert.equal(snapshot.text, record.expected, record.name);
      assert.ok(Number.isSafeInteger(snapshot.revision), record.name);
    }
    assert.ok(record.calls <= (record.name === "selection/configuration" ? 0 : 1),
      `${record.name}: ${record.calls} whole-Text flattens for repeated synchronous reads`);
  }
  assert.equal(result.records[1].values[0][1].revision, result.revision);
  assert.equal(result.records[2].values[0][1].revision, result.revision + 1);
  assert.equal(result.records[3].values[0][1].revision, result.revision + 2);
});

test("text memo releases a closed document even when no caller reads the replacement", { skip: !enabled, timeout: 30000 }, async t => {
  const pageFor = await languageBrowser(t);
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", content: "" }]);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view");
    IrisEditor.load("closed 😀\n".repeat(20000), null);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    IrisEditor.getValue(); IrisEditor.snapshot();
    window.closedText = new WeakRef(view.state.doc);
    // Detach app readers for this narrow lifetime probe. The real editor load
    // remains synchronous; its cache must clear without a subsequent getter.
    const getValue = IrisEditor.getValue, snapshot = IrisEditor.snapshot;
    IrisEditor.getValue = () => ""; IrisEditor.snapshot = () => ({ revision: 0, text: "" });
    try { IrisEditor.load("", null); }
    finally { IrisEditor.getValue = getValue; IrisEditor.snapshot = snapshot; }
  });
  await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
  assert.equal(await page.evaluate(() => !!closedText.deref()), false);
  await cdp.detach();
});
