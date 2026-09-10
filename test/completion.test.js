const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EditorState } = require("@codemirror/state");
const { CompletionContext } = require("@codemirror/autocomplete");
const Completion = require("../public/iris-completion");
const window = {};
vm.compileFunction(fs.readFileSync(path.join(__dirname, "../public/iris-latex.js"), "utf8"), ["window"])(window);
vm.compileFunction(fs.readFileSync(path.join(__dirname, "../public/iris-lilypond.js"), "utf8"), ["window", "IrisLatex"])(window, window.IrisLatex);
const syntax = { tex: window.IrisLatex, ly: window.IrisLilyPond };
const file = (path, content) => ({ type: "file", path, content });

function query(text, kind = "tex", project = {}, explicit = false, readonly = false, source = null) {
  const pos = text.indexOf("¦");
  const state = EditorState.create({ doc: text.replace("¦", ""), extensions: EditorState.readOnly.of(readonly) });
  return (source || Completion.createSource(kind, () => project, syntax))(new CompletionContext(state, pos, explicit));
}
const labels = (result) => result ? result.options.map((option) => option.label) : [];

test("project custom commands normalize names and keep the languages separate", () => {
  assert.deepEqual(Completion.normalizeCustomCommands({ tex: " myMacro\n\\myMacro\n\\missingCommand*\n", ly: ["my-music", "\\my-music"] }), {
    tex: ["\\myMacro", "\\missingCommand*"], ly: ["\\my-music"],
  });
  assert.deepEqual(Completion.normalizeCustomCommands(), { tex: [], ly: [] });
});

test("invalid or oversized custom command lists identify the offending line", () => {
  for (const tex of ["\\valid\n\\bad{argument}", "\\valid\n<img>", ["\\valid", {}]]) {
    assert.throws(() => Completion.normalizeCustomCommands({ tex }), (e) => e.code === "CUSTOM_COMMANDS_INVALID" && e.kind === "tex" && e.line === 2);
  }
  assert.throws(() => Completion.normalizeCustomCommands({ ly: Array.from({ length: 201 }, (_, i) => `music${i}`) }));
  assert.throws(() => Completion.normalizeCustomCommands({ tex: "a".repeat(81) }));
});

test("commands complete automatically after a backslash, and explicitly on an empty line", () => {
  const result = query("\\sec¦");
  assert.equal(result.from, 0);
  assert.ok(labels(result).includes("\\section"));
  assert.ok(labels(query("¦", "tex", {}, true)).includes("\\begin"));
  assert.equal(query("ordinary text¦"), null);
  assert.equal(query("\\sec¦", "tex", {}, false, true), null);
});

test("ordinary prose does not require a full lexical scan for completion", () => {
  let scans = 0;
  const instrumented = { ...syntax, tex: { ...syntax.tex, completionText(text) { scans++; return syntax.tex.completionText(text); } } };
  const source = Completion.createSource("tex", () => ({}), instrumented);
  assert.equal(query("ordinary prose¦", "tex", {}, false, false, source), null);
  assert.equal(scans, 0);
});

test("environment completion covers standard, starred and project-defined environments", () => {
  const project = { nodes: [file("macros.sty", "\\newenvironment{customBox}{}{}\n% \\newenvironment{fake}{}{}") ] };
  const result = query("\\begin{it¦}", "tex", project);
  assert.equal(result.from, 7);
  assert.ok(labels(result).includes("itemize"));
  assert.ok(labels(result).includes("align*"));
  assert.ok(labels(result).includes("customBox"));
  assert.ok(!labels(result).includes("fake"));
});

test("reference labels come from all current TeX sources and skip comments and verbatim", () => {
  const project = { nodes: [
    file("main.tex", "\\label{intro}"),
    { type: "folder", name: "chapters", children: [file("chapters/part.tex", String.raw`\label{fig:one}
% \label{ignored}
\verb|\label{literal}|
\begin{verbatim}
\label{hidden}
\end{verbatim}
\label{fig:#1}`)] },
  ] };
  assert.deepEqual(labels(query("\\ref{¦}", "tex", project)).sort(), ["fig:one", "intro"]);
  const result = query("\\cref{intro, fi¦}", "tex", project);
  assert.equal(result.from, 13);
  assert.deepEqual(labels(result), ["fig:one"]);
});

test("citation keys skip fake entries inside comments, quoted values and BibTeX directives", () => {
  const project = { nodes: [file("refs.bib", String.raw`% @book{lineFake,}
@comment{ @article{commentFake, title={fake}} }
@string{journal="Journal"}
@preamble{"Text"}
@article{doe2024, title={A {nested} title with @book{fake,} inside}}
@book(smith:2025, title="A quoted @article{fake2,} title")`)] };
  assert.deepEqual(labels(query("\\cite{¦}", "tex", project)).sort(), ["doe2024", "smith:2025"]);
  const result = query("\\parencite[see][p. 2]{doe2024, sm¦}", "tex", project);
  assert.equal(result.from, 31);
  assert.deepEqual(labels(result), ["smith:2025"]);
});

test("quoted bibliography values cannot terminate brace-delimited entries", () => {
  const nodes = [file("refs.bib", '@book{real, title="Text } @article{fake,} text"}\n@book{next, title={Next}}')];
  assert.deepEqual(labels(query("\\cite{¦}", "tex", { nodes })).sort(), ["next", "real"]);
});

test("project macros and LilyPond variables complement the built-in command catalogs", () => {
  const project = { nodes: [
    file("macros.tex", "\\newcommand{\\myMacro}[1]{#1}\n\\def\\shortName{}"),
    file("parts.ily", 'melody = { c1 }\nwords = "text"\n% fake = {}\n"fake2 = {}"'),
  ], customCommands: { tex: ["\\extraMacro"], ly: ["\\extra-music"] } };
  const tex = labels(query("\\¦", "tex", project));
  assert.ok(tex.includes("\\myMacro") && tex.includes("\\shortName") && tex.includes("\\extraMacro"));
  assert.ok(!tex.includes("\\extra-music"));
  const ly = labels(query("\\¦", "ly", project));
  for (const name of ["\\relative", "\\glissando", "\\melody", "\\words", "\\extra-music"]) assert.ok(ly.includes(name), name);
  assert.ok(!ly.includes("\\fake") && !ly.includes("\\fake2") && !ly.includes("\\extraMacro"));
  const contexts = query("\\new St¦", "ly", project);
  assert.equal(contexts.from, 5);
  assert.ok(labels(contexts).includes("Staff"));
});

test("comments, literal environments, LilyPond strings and escaped backslashes suppress suggestions", () => {
  for (const [kind, text] of [
    ["tex", "% \\sec¦"], ["tex", "\\\\sec¦"], ["tex", "\\verb|\\sec¦|"],
    ["tex", "\\begin{verbatim}\n\\sec¦\n\\end{verbatim}"],
    ["ly", '% \\rel¦'], ["ly", '%{\n\\rel¦\n%}'], ["ly", '\\markup "\\rel¦"'],
  ]) assert.equal(query(text, kind, {}, true), null, text);
});

test("brace pairing respects escaped characters, comments, literal text and Scheme music literals", () => {
  for (const [kind, prefix, expected] of [
    ["tex", "\\section", true], ["tex", "\\", false], ["tex", "\\\\", true],
    ["tex", "% comment", false], ["tex", "\\begin{verbatim}\n", false],
    ["ly", "\\score ", true], ["ly", '#', false], ["ly", '"text', false], ["ly", '%{ comment', false],
  ]) assert.equal(Completion.canPairBrace(kind, prefix, syntax), expected, prefix);
});

test("completion caches observe edits, removals and project replacement without leaking old entries", () => {
  let project = { nodes: [file("main.tex", "\\label{old}"), file("gone.tex", "\\label{removed}")], activePath: "main.tex" };
  const source = Completion.createSource("tex", () => project, syntax);
  assert.deepEqual(labels(query("\\label{live}\n\\ref{¦}", "tex", {}, false, false, source)).sort(), ["live", "removed"]);
  project.nodes.pop();
  assert.deepEqual(labels(query("\\label{next}\n\\ref{¦}", "tex", {}, false, false, source)), ["next"]);
  project = { nodes: [file("main.tex", "\\label{newProject}")] };
  assert.deepEqual(labels(query("\\ref{¦}", "tex", {}, false, false, source)), ["newProject"]);
});
