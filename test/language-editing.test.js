const test = require("node:test");
const assert = require("node:assert/strict");
async function language(kind, text) {
  const { loadLanguage, analyze } = await import("../public/iris-language-service.mjs");
  return { adapter: await loadLanguage(kind), ...await analyze(kind, text) };
}
const apply = (source, changes) => changes.reduceRight((s, c) => s.slice(0, c.from) + c.insert + s.slice(c.to), source);

test("Enter reserves same-name outer closers and recognizes open EOF and inline environment pairs", async () => {
  for (const [source, pos, expected] of [
    ["\\begin{a}\n\\begin{a}\n\\end{a}", 19, ["\\end{a}", true]],
    ["\\begin{a}", 9, ["\\end{a}", true]],
    ["\\begin{a}\\end{a}", 9, ["\\end{a}", false]],
    ["😀\r\n\\begin{a}\r\n\\begin{a}\r\n\\end{a}", 24, ["\\end{a}", true]],
  ]) {
    const { adapter, tree, doc } = await language("tex", source), plan = adapter.blockAtEnter(tree, doc, pos);
    assert.ok(plan, JSON.stringify(source));
    assert.deepEqual([plan.close, plan.needsClose], expected);
    if (!plan.needsClose) assert.equal(plan.closingFrom, pos);
  }
});
test("Enter handles actual LY groups, simultaneous music and two-unit music-literal closers", async () => {
  for (const [source, pos, close, needsClose] of [
    ["\\score {", 8, "}", true], ["{ }", 1, "}", false], ["<<", 2, ">>", true],
    ["#{", 2, "#}", true], ["#(list #{ #})", 9, "#}", false],
    ["{\n{\n}", 3, "}", true],
  ]) {
    const { adapter, tree, doc } = await language("ly", source), plan = adapter.blockAtEnter(tree, doc, pos);
    assert.ok(plan, source); assert.deepEqual([plan.close, plan.needsClose], [close, needsClose]);
  }
});
test("Enter never pairs comments, literals, strings, discarded or unknown Scheme and parser finishes", async () => {
  for (const [kind, marked] of [
    ["tex", "% \\begin{a}¦"], ["tex", "\\verb|\\begin{a}¦|"],
    ["tex", "\\begin{verbatim}\n\\begin{a}¦\n\\end{verbatim}"],
    ["ly", '% {¦'], ["ly", '"{¦"'], ["ly", '#(list #; #{¦ #})'],
    ["ly", '#(list #vu8(1) #{¦'], ["ly", '#12¦'], ["ly", '#(x)¦'],
  ]) {
    const pos = marked.indexOf("¦"), source = marked.replace("¦", "");
    const { adapter, tree, doc } = await language(kind, source);
    assert.equal(adapter.blockAtEnter(tree, doc, pos), null, marked);
  }
});
test("Enter uses the adapter's initial note convention and its current certainty", async () => {
  const { loadLanguage, analyze } = await import("../public/iris-language-service.mjs");
  for (const initialNoteLanguage of ["italiano", "unknown"]) {
    const options = { initialNoteLanguage }, adapter = await loadLanguage("ly", options), { tree, doc } = await analyze("ly", "{", options);
    if (initialNoteLanguage === "unknown") {
      assert.equal(adapter.contextAt(tree, doc, 1).certainty, "unknown");
      assert.equal(adapter.blockAtEnter(tree, doc, 1), null);
    } else assert.equal(adapter.blockAtEnter(tree, doc, 1).close, "}");
  }
});
test("formatting returns granular indentation, preserves CRLF/content and is idempotent", async () => {
  for (const [kind, source, expected] of [
    ["tex", "😀\r\n\\begin{a}\r\n x  \r\n \\end{a}\r\n", "😀\r\n\\begin{a}\r\n  x  \r\n\\end{a}\r\n"],
    ["ly", "\\score {\n{\nc4  \n}\n}\n", "\\score {\n  {\n    c4  \n  }\n}\n"],
  ]) {
    const { adapter, tree, doc } = await language(kind, source), changes = adapter.formatChanges(tree, doc);
    assert.ok(changes.length > 0);
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i]; assert.match(source.slice(c.from, c.to), /^[\t ]*$/); assert.match(c.insert, /^ *$/);
      if (i) assert.ok(changes[i - 1].to <= c.from);
    }
    const formatted = apply(source, changes);
    assert.equal(formatted, expected);
    const again = await language(kind, formatted);
    assert.deepEqual(again.adapter.formatChanges(again.tree, again.doc), []);
  }
});
test("formatting protects literal and multiline string bytes including blank and trailing lines", async () => {
  for (const [kind, source, protectedText] of [
    ["tex", "\\begin{a}\n\\begin{verbatim}\n  a  \n\n\n b\n\\end{verbatim}\n\\end{a}", "\n  a  \n\n\n b\n"],
    ["ly", '\\score {\ntext = "line\n  second  \n\n last"\nc4\n}', '"line\n  second  \n\n last"'],
    ["ly", '\\score {\n#(list #vu8(1)\n raw  \n\n tail\n}', '#(list #vu8(1)\n raw  \n\n tail\n}'],
  ]) {
    const { adapter, tree, doc } = await language(kind, source), changes = adapter.formatChanges(tree, doc);
    const from = source.indexOf(protectedText), to = from + protectedText.length;
    assert.ok(from >= 0);
    for (const c of changes) assert.equal(c.from >= from && c.from < to || c.from < to && c.to > from, false);
    assert.ok(apply(source, changes).includes(protectedText));
  }
});
