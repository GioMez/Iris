// Guarded Lezer paths and the retained BibTeX/RIS streams.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { StringStream } = require("@codemirror/language");

// Keep tags, highlighter, language and state on the same native-ESM graph.
async function highlighting() {
  assert.ok(fs.existsSync(path.join(__dirname, "../public/iris-syntax-style.mjs")), "shared syntax style module exists");
  const [style, language, highlight, state] = await Promise.all([
    import("../public/iris-syntax-style.mjs"), import("@codemirror/language"),
    import("@lezer/highlight"), import("@codemirror/state"),
  ]);
  return { ...style, ...language, ...highlight, ...state };
}
const bibliographyClasses = { entryType: "t-bib-entry-type t-cmd", key: "t-bib-key t-env",
  field: "t-bib-field t-special", value: "t-bib-value t-math", comment: "t-bib-comment t-comment",
  brace: "t-bib-delimiter t-brace", special: "t-bib-operator t-special" };

test("mounted TeX extension uses guarded Lezer with separate math roles across replacements and size crossings", async () => {
  const { createTexHighlighting } = await import("../public/iris-tex-highlighting.mjs");
  const { EditorState, Compartment, ensureSyntaxTree, syntaxTreeAvailable, highlightTree, roleHighlighter } = await highlighting();
  const tex = await createTexHighlighting();
  const compartment = new Compartment();
  let state = EditorState.create({ doc: "$x+1$", extensions: [compartment.of(tex())] });
  const semantic = () => {
    const tree = ensureSyntaxTree(state, state.doc.length, 1000), result = Array(state.doc.length).fill("text");
    if (tree) highlightTree(tree, roleHighlighter, (from, to, role) => result.fill(role, from, to));
    return result;
  };
  assert.deepEqual(semantic(), ["delimiter", "math", "operator", "number", "delimiter"]);
  state = state.update({ changes: { from: 0, to: 5, insert: "x".repeat(1048577) }, filter: false }).state;
  const skipped = ensureSyntaxTree(state, state.doc.length, 10);
  assert.ok(!skipped || !skipped.type.name && skipped.children.length === 0, "CM may return an anonymous skipping placeholder, never a TeX tree");
  assert.equal(syntaxTreeAvailable(state, state.doc.length), false);
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: "$y_2$" }, filter: false }).state;
  assert.deepEqual(semantic(), ["delimiter", "math", "operator", "number", "delimiter"]);
  state = state.update({ effects: compartment.reconfigure([]) }).state;
  assert.deepEqual(semantic(), Array(5).fill("text"));
  state = state.update({ effects: compartment.reconfigure(tex()) }).state;
  assert.deepEqual(semantic(), ["delimiter", "math", "operator", "number", "delimiter"]);
  // The factory is also used on setState/load: each installation owns its life.
  state = EditorState.create({ doc: "$z^3$", extensions: [tex()] });
  assert.deepEqual(semantic(), ["delimiter", "math", "operator", "number", "delimiter"]);
});

test('HP06 mounted LY extension guards initial/growing documents and survives replacement/reconfiguration', async () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../public/iris-lilypond-highlighting.mjs')), 'guarded LY highlighting factory');
  const { createLilyPondHighlighting } = await import('../public/iris-lilypond-highlighting.mjs');
  const { EditorState, Compartment, ensureSyntaxTree, syntaxTreeAvailable, highlightTree, roleHighlighter } = await highlighting();
  const ly = await createLilyPondHighlighting(), compartment = new Compartment();
  let state = EditorState.create({ doc: '#{ c4 #}', extensions: [compartment.of(ly())] });
  const semantic = () => {
    const tree = ensureSyntaxTree(state, state.doc.length, 1000), result = Array(state.doc.length).fill(null);
    if (tree) highlightTree(tree, roleHighlighter, (from, to, role) => result.fill(role, from, to));
    return result;
  };
  const music = ['delimiter', 'delimiter', null, 'pitch', 'duration', null, 'delimiter', 'delimiter'];
  assert.deepEqual(semantic(), music);
  state = state.update({ effects: compartment.reconfigure([]) }).state;
  assert.deepEqual(semantic(), Array(8).fill(null));
  state = state.update({ effects: compartment.reconfigure(ly()) }).state;
  assert.deepEqual(semantic(), music);
  state = state.update({ changes: { from: 0, to: 8, insert: 'x'.repeat(1048577) }, filter: false }).state;
  assert.equal(semantic().some(Boolean), false); assert.equal(syntaxTreeAvailable(state, state.doc.length), false);
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: '#{ d8 #}' }, filter: false }).state;
  assert.deepEqual(semantic(), music);
  state = EditorState.create({ doc: 'x'.repeat(1048577), extensions: [ly()] });
  assert.equal(semantic().some(Boolean), false); assert.equal(syntaxTreeAvailable(state, state.doc.length), false);
  state = EditorState.create({ doc: '#{ e2 #}', extensions: [ly()] });
  assert.deepEqual(semantic(), music);
});

const bibliographyCorpora = [
  ["bib", '\uFEFF% outside\r\n@book{key\u{1f600},\r\n title={A {nested \\} tail},\r\n year=2026, custom=macro # "open\r\n% literal',
    [["% outside", "comment"], ["@book", "entryType"], ["key\u{1f600}", "key"], ["title", "field"],
      ["{A {nested \\} tail}", "value"], ["year", "field"], ["2026", "value"], ["custom", "field"],
      ["macro", "value"], ['"open', "value"], ["% literal", "value"]]],
  ["bib", '@string{foo="x\\", bar={b}}\n@preamble{foo # {y}}\n@comment{outer {nested}\n% comment}\n@article(k(), title="A {\\"} B", note={unfinished',
    [["@string", "entryType"], ["foo", "field"], ["bar", "field"], ["@preamble", "entryType"],
      ["% comment", "comment"], ["k()", "key"], ['"A {\\"} B"', "value"], ["note", "field"], ["{unfinished", "value"]]],
  ["bib", '@comment(outer (inner) {)} \\) tail)\r\n@comment{braced\\}\r\n@book{k,title={x}}',
    [["outer (inner) {)} \\) tail)", "comment"], ["braced\\}", "comment"], ["@book", "entryType"], ["title", "field"], ["{x}", "value"]]],
  ["ris", '\uFEFF% outside\r\nty  - book\r\nID  - a\u{1f600}\r\nTI  - A\r\n\r\n% continuation\r\n  AU  - literal\r\nER  - \r\n% after\r\nTY  - JOUR\r\nZZ  - unfinished',
    [["% outside", "comment"], ["ty", "field"], ["book", "entryType"], ["ID", "field"], ["a\u{1f600}", "value"],
      ["TI", "field"], ["% continuation", "value"], ["  AU  - literal", "value"], ["ER", "field"],
      ["% after", "comment"], ["JOUR", "entryType"], ["ZZ", "field"], ["unfinished", "value"]]],
  ["bib", "% note\r@book{k,title={A}}",
    [["@book", "entryType"], ["title", "field"], ["{A}", "value"], ["% note", "comment"]], "valid"],
  ["bib", "@book(k )\n@article{next,title={A}}\n@book(smith(2026),title={B})",
    [[")", "brace"], ["@article", "entryType"], ["next", "key"],
      ["title", "field"], ["{A}", "value"], ["smith(2026)", "key"]], "valid"],
  ["bib", '\uFEFF% before\r\n@book{mixed,\r% field note\r title={A\r% literal\r\nB},\n year=2026}\r% after\r@article{next,title="Q\rR"}',
    [["title", "field"], ["@article", "entryType"], ["next", "key"], ["% field note", "comment"],
      ["% literal", "value"], ['"Q\rR"', "value"], ["year", "field"], ["2026", "value"], ["% after", "comment"]], "valid"],
  ["ris", "TY  - BOOK\rTI  - A\rER  -",
    [["TI", "field"], ["BOOK", "entryType"], ["A", "value"], ["ER", "field"]], "valid"],
  ["ris", "\uFEFF% outside\r\r  ty  - book\r% before field\r\nN1  -\r% continuation\r\r  TY  - literal\nTI  - A\u{1f600}\r\nER  -\r% after\rTY  - JOUR\nER  -",
    [["ty", "field"], ["book", "entryType"], ["N1", "field"], ["TI", "field"], ["JOUR", "entryType"],
      ["% outside", "comment"], ["% before field", "comment"], ["% continuation", "value"],
      ["  TY  - literal", "value"], ["A\u{1f600}", "value"], ["% after", "comment"]], "valid"],
];

for (const kind of ["bib", "ris"]) {
  test(`${kind} incremental stream highlights incomplete native syntax in real CodeMirror`, { timeout: 5000 }, async () => {
    const mod = require(`../public/iris-${kind === "bib" ? "bibtex" : "ris"}.js`);
    assert.equal(typeof mod.stream, "object", "parser must export an incremental stream");
    const { EditorState, StreamLanguage, StringStream, ensureSyntaxTree, highlightTree,
      bibliographyTokenTable: tokenTable, cssHighlighter: highlighter } = await highlighting();
    const language = StreamLanguage.define({ ...mod.stream, tokenTable });
    for (const [, text, spans, status] of bibliographyCorpora.filter(([format]) => format === kind)) {
      if (status) assert.equal(mod.parse(text).status, status, JSON.stringify(text));
      const state = EditorState.create({ doc: text, extensions: [EditorState.lineSeparator.of("\n"), language] });
      assert.equal(state.doc.toString(), text);
      assert.equal(state.doc.length, text.length, "highlight offsets must use the raw UTF-16 document");
      const actual = new Array(text.length).fill(null);
      highlightTree(ensureSyntaxTree(state, state.doc.length, 1000), highlighter, (from, to, style) => actual.fill(style, from, to));
      for (const [literal, style] of spans) {
        const from = text.indexOf(literal);
        assert.notEqual(from, -1);
        assert.deepEqual(actual.slice(from, from + literal.length), new Array(literal.length).fill(bibliographyClasses[style]), `${literal} in ${JSON.stringify(text)}`);
      }
      // Every prefix is a possible in-progress edit. Drive the real StringStream
      // and branch copied states, without calling the full-document scanner.
      for (let end = 0; end <= text.length; end++) {
        let state = mod.stream.startState();
        for (const line of text.slice(0, end).split("\n")) {
          const stream = new StringStream(line, 2);
          if (!line && mod.stream.blankLine) mod.stream.blankLine(state);
          while (!stream.eol()) {
            stream.start = stream.pos;
            const copy = mod.stream.copyState(state), saved = structuredClone(state);
            const probe = new StringStream(line, 2); probe.pos = stream.pos; probe.start = stream.start;
            const token = mod.stream.token(probe, copy);
            assert.deepEqual(state, saved, "copyState must isolate incremental branches");
            assert.equal(mod.stream.token(stream, state), token);
            assert.equal(stream.pos, probe.pos);
            assert.ok(stream.pos > stream.start, `stalled on ${JSON.stringify(line)}`);
          }
        }
      }
    }
  });
}
