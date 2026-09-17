// Mounted guarded Lezer paths and explicitly retained legacy TeX/LY streams.
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
const sourceClasses = { cmd: "t-command t-cmd", env: "t-environment t-env", brace: "t-delimiter t-brace",
  math: "t-math", comment: "t-comment", special: "t-operator t-special", string: "t-string" };
const sourceRoles = { cmd: "command", env: "environment", brace: "delimiter",
  math: "math", comment: "comment", special: "operator", string: "string" };
const bibliographyClasses = { entryType: "t-bib-entry-type t-cmd", key: "t-bib-key t-env",
  field: "t-bib-field t-special", value: "t-bib-value t-math", comment: "t-bib-comment t-comment",
  brace: "t-bib-delimiter t-brace", special: "t-bib-operator t-special" };

function loadSyntaxModules() {
  // Real StringStream's RegExp checks need the syntax modules in the same realm.
  const window = {};
  for (const name of ["latex", "lilypond"]) {
    new Function("window", fs.readFileSync(path.join(__dirname, `../public/iris-${name}.js`), "utf8"))(window);
  }
  return { latex: window.IrisLatex, lilypond: window.IrisLilyPond };
}

// Runs the stream tokenizer over the whole source and returns one token name
// (or null) per character. Also asserts the tokenizer always makes progress —
// the invariant CodeMirror itself enforces at runtime.
function streamClasses(spec, src) {
  const classes = [];
  const state = spec.startState();
  const lines = src.split("\n");
  lines.forEach((line, index) => {
    const stream = new StringStream(line, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const token = spec.token(stream, state);
      assert.ok(stream.pos > stream.start,
        `tokenizer stalled at line ${index + 1}, pos ${stream.pos}: ${JSON.stringify(line)}`);
      for (let i = stream.start; i < stream.pos; i++) classes.push(token || null);
    }
    if (index < lines.length - 1) classes.push(null);
  });
  return classes;
}

// Each pair is a hand-labelled source fragment, including plain text. Checking
// every UTF-16 offset catches both missing tokens and color leaking past closers.
const syntaxCorpora = {
  latex: [
    ["\\documentclass", "cmd"], ["[", "brace"], ["11pt", null], ["]{", "brace"], ["article", null], ["}", "brace"], ["\n", null],
    ["\\usepackage", "cmd"], ["[", "brace"], ["utf8", null], ["]{", "brace"], ["inputenc", null], ["}\n", "brace"],
    ["% comment with \\commands and $math$ and \\begin{x}\n", "comment"],
    ["\\begin", "cmd"], ["{", "brace"], ["document", "env"], ["}\n", "brace"],
    ["\\section*", "cmd"], ["{", "brace"], ["Hello ", null], ["&", "special"], [" World 😀", null], ["}\n", "brace"],
    ["Text with ", null], ["~", "special"], [" special, ", null], ["\\%", "cmd"], [" escaped, and braces ", null],
    ["{", "brace"], ["like ", null], ["[", "brace"], ["these", null], ["]}", "brace"], [".\nInline ", null],
    ["$a^2 + b_1 \\$ still$", "math"], [" and ", null], ["\\(x+y\\)", "math"], [" math.\nDisplay: ", null],
    ["\\[ \\int_0^1 x\\,dx \\]\n$$\\sum_{i=1}^n i$$", "math"], ["\n", null],
    ["\\begin", "cmd"], ["{", "brace"], ["align*", "env"], ["}", "brace"], ["\n  a ", null], ["&", "special"],
    ["= b ", null], ["\\\\", "special"], ["\n  c ", null], ["&", "special"], ["= d\n", null],
    ["\\end", "cmd"], ["{", "brace"], ["align*", "env"], ["}\n", "brace"],
    ["\\begin", "cmd"], [" ", null], ["{", "brace"], ["spaced", "env"], ["}\n", "brace"], ["text", null],
    ["\\end", "cmd"], ["{", "brace"], ["spaced", "env"], ["}\n", "brace"],
    ["Multi-line math ", null], ["$a +\n\nb$", "math"], [" then prose.\n", null],
    ["\\begin", "cmd"], ["{}\n", "brace"], ["Unclosed inline ", null], ["\\( math 😀 to the end", "math"],
  ],
  lilypond: [
    ["\\version", "cmd"], [" ", null], ['"2.24.0"', "string"], ["\n", null],
    ["% line comment with \\score\n%{ block\n\ncomment across lines %}", "comment"],
    ["\nglobal = ", null], ["{", "brace"], [" ", null], ["\\key", "cmd"], [" c ", null], ["\\major", "cmd"],
    [" ", null], ["\\time", "cmd"], [" 4/4 ", null], ["}\n", "brace"],
    ["\\score", "cmd"], [" ", null], ["{", "brace"], ["\n  ", null], ["\\relative", "cmd"], [" c' ", null], ["{", "brace"],
    ["\n    c4 d e2 | <c e g>1 |\n    d8-. e-- ", null], ["\\f", "cmd"], [" g", null], ["\\p", "cmd"],
    ["\n    ", null], ["<<", "brace"], [" ", null], ["{", "brace"], [" c2 ", null], ["}", "brace"], [" ", null],
    ["\\\\", "cmd"], [" ", null], ["{", "brace"], [" e2 ", null], ["}", "brace"], [" ", null], [">>", "brace"],
    ["\n  ", null], ["}", "brace"], ["\n  ", null], ["\\addlyrics", "cmd"], [" ", null], ["{", "brace"],
    [" la la ", null], ['"quoted lyric"', "string"], [" ", null], ["}", "brace"], ["\n  ", null], ["\\layout", "cmd"],
    [" ", null], ["{", "brace"], [" ", null], ["}\n}", "brace"], ["\n", null], ['"multi\n\nline string"', "string"], ["\n", null],
    ["\\markup", "cmd"], [" ", null], ["{", "brace"], [" ", null], ["\\bold", "cmd"], [" ", null],
    ['"text with \\"escape\\" inside"', "string"], [" ", null], ["}", "brace"], ["\nangle singles: a < b > c 😀\n", null],
    ['"unclosed 😀 string', "string"],
  ],
};

for (const [kind, fragments] of Object.entries(syntaxCorpora)) {
  const text = fragments.map(([value]) => value).join("");
  const expected = fragments.flatMap(([value, style]) => value.split("").map(char => char === "\n" ? null : style));
  test(`legacy ${kind} tokens cover commands, delimiters, escapes, multiline and Unicode source in real CodeMirror`, async () => {
    const { stream } = loadSyntaxModules()[kind];
    assert.deepEqual(streamClasses(stream, text), expected);
    const { StreamLanguage, highlightTree, legacyTokenTable: tokenTable, roleHighlighter, cssHighlighter } = await highlighting();
    const tree = StreamLanguage.define({ ...stream, tokenTable }).parser.parse(text);
    const actual = new Array(text.length).fill(null);
    highlightTree(tree, cssHighlighter, (from, to, style) => actual.fill(style, from, to));
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\n") assert.equal(actual[i], sourceClasses[expected[i]] || null, `UTF-16 offset ${i}: ${JSON.stringify(text.slice(i - 10, i + 10))}`);
    }
    const semantic = new Array(text.length).fill(null);
    highlightTree(tree, roleHighlighter, (from, to, role) => semantic.fill(role, from, to));
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\n") assert.equal(semantic[i], sourceRoles[expected[i]] || null,
        `semantic role at UTF-16 offset ${i}: ${JSON.stringify(text.slice(i - 10, i + 10))}`);
    }
  });

  test(`legacy ${kind} every in-progress prefix advances and copied multiline states branch independently`, () => {
    const spec = loadSyntaxModules()[kind].stream;
    for (let end = 0; end <= text.length; end++) {
      const state = spec.startState();
      for (const line of text.slice(0, end).split("\n")) {
        const stream = new StringStream(line, 2);
        while (!stream.eol()) {
          stream.start = stream.pos;
          const copy = spec.copyState(state), saved = structuredClone(state);
          const probe = new StringStream(line, 2); probe.pos = stream.pos; probe.start = stream.start;
          const token = spec.token(probe, copy);
          assert.deepEqual(state, saved, "tokenizing a copied state must not mutate its source");
          assert.equal(spec.token(stream, state), token);
          assert.equal(stream.pos, probe.pos);
          assert.ok(stream.pos > stream.start, `stalled on ${JSON.stringify(line)}`);
        }
      }
    }
  });
}

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
