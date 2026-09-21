const test = require("node:test");
const assert = require("node:assert/strict");
for (const [kind, source, open, close] of [
  ["tex", "{pair}", "{", "}"], ["tex", "\\section{a {nested} b}", "{", "}"],
  ["tex", "\\ref{live}", "{", "}"], ["tex", "[a {b}]", "[", "]"],
  ["ly", "{ c4 %{ } %} d4 }", "{", "}"], ["ly", "\\lyricmode { text }", "{", "}"],
  ["ly", "<< {c4} {d4} >>", "<<", ">>"], ["ly", "#{ c4 #}", "#{", "#}"],
  ["ly", '#(list ")" 1)', "(", ")"],
]) test(`native bracket matching ${kind}: ${source}`, async () => {
  const { EditorState } = await import("@codemirror/state"), { ensureSyntaxTree, matchBrackets } = await import("@codemirror/language");
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createGuardedLanguage } = await import("../public/iris-language-state.mjs");
  const state = EditorState.create({ doc: source, extensions: createGuardedLanguage(await loadLanguage(kind)) });
  ensureSyntaxTree(state, state.doc.length, 1000);
  const from = source.indexOf(open), to = source.lastIndexOf(close);
  assert.deepEqual(matchBrackets(state, from, 1), { start: { from, to: from + open.length }, end: { from: to, to: to + close.length }, matched: true });
  assert.deepEqual(matchBrackets(state, to + close.length, -1), { start: { from: to, to: to + close.length }, end: { from, to: from + open.length }, matched: true });
});
