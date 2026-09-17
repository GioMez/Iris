const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const load = file => import(pathToFileURL(path.join(root, file)));
const source = text => ({ length: text.length, sliceString: (from, to) => text.slice(from, to) });
async function adapter() { return (await load("public/iris-language-service.mjs")).loadLanguage("tex"); }
function nodes(tree) {
  const result = [];
  tree.iterate({ enter: node => result.push([node.name, node.from, node.to]) });
  return result;
}
function sharedTrees(before, after) {
  const old = new Set(), shared = new Set();
  const visit = (tree, fn) => { fn(tree); for (const child of tree.children || []) if (child.children) visit(child, fn); };
  visit(before, tree => old.add(tree));
  visit(after, tree => { if (old.has(tree) && tree.length) shared.add(tree); });
  return shared.size;
}
function equalRows(actual, expected, message = "rows") {
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) assert.deepEqual(actual[i], expected[i], `${message}, row ${i}`);
  assert.equal(actual.length, expected.length, `${message}, count`);
}
async function roles(tree) {
  const { highlightTree } = await import("@lezer/highlight");
  const { roleHighlighter } = await load("public/iris-syntax-style.mjs");
  const result = [];
  highlightTree(tree, roleHighlighter, (from, to, role) => result.push([from, to, role]));
  return result;
}

test("generated modules are deterministic; check reports drift/missing outputs without writing", async t => {
  const dir = await fs.mkdtemp(path.join(root, ".language-build-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const file of ["scripts/build-languages.cjs", "public/languages/latex/latex.grammar", "public/languages/latex/tokens.mjs"]) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(dir, file));
  }
  const run = (...args) => spawnSync(process.execPath, [path.join(dir, "scripts/build-languages.cjs"), ...args], { cwd: dir, encoding: "utf8" });
  const outputs = ["parser.mjs", "parser.terms.mjs"].map(file => path.join(dir, "public/languages/latex", file));
  assert.equal(run().status, 0);
  const first = await Promise.all(outputs.map(file => fs.readFile(file, "utf8")));
  assert.equal(run().status, 0);
  assert.deepEqual(await Promise.all(outputs.map(file => fs.readFile(file, "utf8"))), first);
  assert.equal(run("--check").status, 0);
  await fs.writeFile(outputs[0], "drift");
  await fs.rm(outputs[1]);
  const check = run("--check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /parser\.mjs/);
  assert.match(check.stderr, /parser\.terms\.mjs/);
  assert.equal(await fs.readFile(outputs[0], "utf8"), "drift");
  await assert.rejects(fs.stat(outputs[1]), { code: "ENOENT" });
  assert.equal(run("--invalid").status, 1);
  assert.equal(run().status, 0);
  assert.deepEqual(await Promise.all(outputs.map(file => fs.readFile(file, "utf8"))), first);
  // Only declared outputs, no generator cache or terms.js side product.
  assert.deepEqual((await fs.readdir(path.dirname(outputs[0]))).sort(), ["latex.grammar", "parser.mjs", "parser.terms.mjs", "tokens.mjs"]);
});

test("TeX LR slice preserves raw offsets, groups, four math pairs and literal/comment boundaries", async () => {
  const a = await adapter();
  const { LRLanguage } = await import("@codemirror/language");
  assert.ok(a.language instanceof LRLanguage);
  const text = "😀\r\n\\section{Real {nested}}\r\n% \\section{Fake}\r\n" +
    "$a% $ comment\r\n+b$ $$c$$ \\(d\\) \\[e\\] \\% " +
    "\\verb|\\section{Fake}| \\verb*+x+y " +
    "\\begin{verbatim}\\section{Fake} $ {\\end{verbatim}\\section{After}";
  const tree = a.language.parser.parse(text);
  assert.equal(nodes(tree).filter(n => n[0] === "⚠").length, 0, tree.toString());
  assert.equal(nodes(tree).filter(n => n[0] === "Math").length, 4);
  const data = a.summarize(tree, source(text));
  assert.deepEqual(data.outline.map(x => x.title), ["Real {nested}", "After"]);
  assert.equal(data.outline[0].offset, 4);
  assert.equal(data.outline[0].to, text.indexOf("\r\n%"));
  assert.equal(data.outline[0].certainty, "exact");
  for (const [needle, mode] of [["+b", "math"], ["comment", "comment"], ["Fake}|", "literal"], ["Fake} $", "literal"], ["After", "text"]]) {
    assert.equal(a.contextAt(tree, source(text), text.indexOf(needle) + 1).mode, mode, needle);
  }
  const spans = await roles(tree);
  for (const [needle, role] of [["\\section", "structure"], ["\\%", "command"], ["% \\section", "comment"], ["Fake}|", "literal"]]) {
    const pos = text.indexOf(needle);
    assert.ok(spans.some(([from, to, value]) => from <= pos && to > pos && value === role), `${needle}: ${JSON.stringify(spans)}`);
  }
  assert.ok(Object.isFrozen(data) && Object.isFrozen(data.outline) && Object.isFrozen(data.outline[0]));
});

test("incremental TeX trees, roles and summaries agree after delimiter and context edits", async () => {
  const a = await adapter();
  const { TreeFragment } = await import("@lezer/common");
  let text = "😀\r\n" + "{plain} ".repeat(1000) + "\\verb|$x$| $y$ \\begin{verbatim}{fake}\\end{verbatim}\\section{End}";
  assert.ok(text.length > 4096, "pinned Lezer enables fragment reuse above 4096 units");
  let tree = a.language.parser.parse(text);
  for (const edit of [
    s => [s.indexOf("|$"), s.indexOf("|$") + 1, "+"],
    s => [s.indexOf("+$"), s.indexOf("+$") + 1, "|"],
    s => [s.indexOf("\\end{verbatim}"), s.indexOf("\\end{verbatim}") + 14, ""],
    s => [s.indexOf("\\section"), s.indexOf("\\section"), "\\end{verbatim}"],
    () => [0, 0, "%"],
    () => [0, 1, ""],
  ]) {
    const [from, to, insert] = edit(text);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
    text = text.slice(0, from) + insert + text.slice(to);
    const previous = tree;
    tree = a.language.parser.parse(text, fragments);
    assert.ok(sharedTrees(previous, tree) > 0, "unchanged TeX subtrees must actually be reused");
    const full = a.language.parser.parse(text);
    assert.deepEqual(nodes(tree), nodes(full));
    assert.deepEqual(await roles(tree), await roles(full));
    assert.deepEqual(a.summarize(tree, source(text)), a.summarize(full, source(text)));
    for (const pos of [0, 1600, text.indexOf("\\verb") + 7, text.length]) assert.deepEqual(a.contextAt(tree, source(text), pos), a.contextAt(full, source(text), pos));
  }
});

test("recovered 7000-unit context reproducer preserves actual reuse and fresh parse meaning", async t => {
  const a = await adapter();
  const { TreeFragment } = await import("@lezer/common");
  let text = "{x} $a% $\n+b$ ".repeat(500);
  assert.equal(text.length, 7000);
  text = text.slice(0, 5602) + "$" + text.slice(5603);
  let tree = a.language.parser.parse(text), reused = 0;
  for (const [from, to, insert] of [[0, 0, " "], [0, 1, ""], [6, 7, ""], [6, 6, "%"], [5602, 5603, "}"]]) {
    const previous = tree;
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(previous), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
    text = text.slice(0, from) + insert + text.slice(to);
    tree = a.language.parser.parse(text, fragments);
    const full = a.language.parser.parse(text);
    const shared = sharedTrees(previous, tree); reused += shared;
    t.diagnostic(`edit [${from},${to}) -> ${JSON.stringify(insert)}: ${shared} shared nonempty Tree objects`);
    if (from === 0) assert.ok(shared > 0, "context-preserving edits of a recovered source must retain reuse");
    equalRows(nodes(tree), nodes(full), `nodes after edit at ${from}`);
    equalRows(await roles(tree), await roles(full), `roles after edit at ${from}`);
    assert.deepEqual(a.summarize(tree, source(text)), a.summarize(full, source(text)));
    for (const pos of [6, 1509, 1516, 1600, 3554, 5599, 5602, text.length]) {
      assert.deepEqual(a.contextAt(tree, source(text), pos), a.contextAt(full, source(text), pos), `context at ${pos}`);
    }
    if (from === 6 && to === 7) assert.equal(a.contextAt(tree, source(text), 1600).mode, "text");
  }
  assert.ok(reused > 0);
});

test("unfinished contextual subtrees are not reused under their own interior context", async () => {
  const a = await adapter();
  const { TreeFragment } = await import("@lezer/common");
  for (const [start, insert] of [["plain $", "$"], ["plain {", "{"], ["plain \\verb|", "\\verb|"], ["plain \\begin{verbatim}", "\\begin{verbatim}"]]) {
    const before = "prefix ".repeat(200) + start + "x ".repeat(4500);
    const old = a.language.parser.parse(before), text = insert + before;
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: 0, toA: 0, fromB: 0, toB: insert.length }]);
    const incremental = a.language.parser.parse(text, fragments), full = a.language.parser.parse(text);
    equalRows(nodes(incremental), nodes(full), `unfinished ${start}`);
    equalRows(await roles(incremental), await roles(full));
    assert.deepEqual(a.summarize(incremental, source(text)), a.summarize(full, source(text)));
    for (const pos of [insert.length + start.length, 1600, text.length]) assert.deepEqual(a.contextAt(incremental, source(text), pos), a.contextAt(full, source(text), pos));
  }
});

test("incomplete input recovers and long tokens remain bounded", async () => {
  const a = await adapter();
  for (const text of ["\\section{Open", "$open", "\\verb|open", "\\begin{verbatim}open", "{nested{"]) {
    const tree = a.language.parser.parse(text);
    assert.equal(tree.length, text.length);
    assert.ok(nodes(tree).some(n => n[0] === "⚠"), tree.toString());
    const data = a.summarize(tree, source(text));
    assert.ok(data.regions.every(r => r.certainty === "recovered" && r.openEnded));
  }
  for (const text of ["%" + "x".repeat(100000), "\\verb|" + "x".repeat(100000) + "|", "\\" + "a".repeat(100000), "x".repeat(100000)]) {
    const tree = a.language.parser.parse(text);
    tree.iterate({ enter(node) { if (!node.node.firstChild && !node.type.isError) assert.ok(node.to - node.from <= 256, `${node.name} ${node.to - node.from}`); } });
  }
});

test("EOF comments are complete while EOF literals/math stay open and verb stops at a raw CRLF", async () => {
  const a = await adapter();
  for (const [text, mode, certainty] of [["% tail", "comment", "exact"], ["$x", "math", "recovered"], ["\\verb|x", "literal", "recovered"]]) {
    const tree = a.language.parser.parse(text);
    const context = a.contextAt(tree, source(text), text.length);
    assert.equal(context.mode, mode);
    assert.equal(context.certainty, certainty);
    if (mode === "comment") assert.ok(!nodes(tree).some(n => n[0] === "⚠"));
  }
  const text = "\\verb|x\r\n\\section{After}";
  const tree = a.language.parser.parse(text);
  const data = a.summarize(tree, source(text));
  assert.equal(data.outline[0].offset, 9);
  assert.equal(data.regions[0].certainty, "recovered");
  assert.equal(data.regions[0].to, 9);
  assert.equal(a.contextAt(tree, source(text), 10).mode, "text");
});

test("half-open cursor ownership prefers adjacent starts and known verb line endpoints", async () => {
  const a = await adapter();
  for (const [text, pos, mode, from, to] of [
    ["\\verb|a|\\verb+b+", 8, "literal", 8, 16],
    ["$a$\\verb+b+", 3, "literal", 3, 11],
    ["\\verb|a|$b$", 8, "math", 8, 11],
  ]) {
    const tree = a.language.parser.parse(text);
    for (const bias of [undefined, -1, 1]) assert.deepEqual(a.contextAt(tree, source(text), pos, bias), { mode, argumentRole: null, from, to, certainty: "exact" });
  }
  for (const eol of ["\r", "\n", "\r\n"]) for (const suffix of ["", "\\section{After}"]) {
    const text = "\\verb|x" + eol + suffix, end = 7 + eol.length;
    const tree = a.language.parser.parse(text);
    const region = a.summarize(tree, source(text)).regions[0];
    assert.equal(region.to, end);
    assert.equal(region.certainty, "recovered");
    assert.equal(region.openEnded, false, "VerbBreak is a known endpoint");
    for (const bias of [undefined, -1, 1]) {
      const context = a.contextAt(tree, source(text), end, bias);
      assert.equal(context.mode, "text");
      assert.equal(context.certainty, "exact");
      assert.equal(context.from, end);
    }
    assert.equal(a.contextAt(tree, source(text), 6).mode, "literal");
    if (suffix) assert.equal(a.summarize(tree, source(text)).outline[0].offset, end);
  }
  for (const text of ["\\verb|x", "\\begin{verbatim}x", "$x"]) {
    const tree = a.language.parser.parse(text);
    assert.equal(a.summarize(tree, source(text)).regions[0].openEnded, true);
    for (const bias of [undefined, -1, 1]) {
      const context = a.contextAt(tree, source(text), text.length, bias);
      assert.equal(context.mode, text.startsWith("$") ? "math" : "literal");
      assert.equal(context.certainty, "recovered");
    }
  }
});

for (const initialSeed of [73, 197, 991]) test(`deterministic edit sequence ${initialSeed} preserves incremental recovery, roles and summaries`, async t => {
  const a = await adapter();
  const { TreeFragment } = await import("@lezer/common");
  let text = ("{😀 \\alpha} $a% dollars $\n+b$ \\verb|{raw}| \\begin{verbatim}$raw$\\end{verbatim}\n\\section{Title}\n").repeat(120);
  assert.ok(text.length > 4096);
  let tree = a.language.parser.parse(text), seed = initialSeed, reusedEdits = 0;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 160; i++) {
    const from = random(text.length), to = Math.min(text.length, from + random(4));
    const insert = ["", "$", "{", "}", "%", "\n", "|", "\\", "text"][random(9)];
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
    text = text.slice(0, from) + insert + text.slice(to);
    const previous = tree;
    tree = a.language.parser.parse(text, fragments);
    if (sharedTrees(previous, tree)) reusedEdits++;
    const full = a.language.parser.parse(text);
    equalRows(nodes(tree), nodes(full), `edit ${i} at ${from}`);
    equalRows(await roles(tree), await roles(full), `roles at edit ${i}`);
    assert.deepEqual(a.summarize(tree, source(text)), a.summarize(full, source(text)), `summary at edit ${i}`);
    for (const pos of [from, Math.min(text.length, from + insert.length), 1600, Math.floor(text.length / 2), text.length]) {
      assert.deepEqual(a.contextAt(tree, source(text), pos), a.contextAt(full, source(text), pos), `context at edit ${i}, ${pos}`);
    }
  }
  assert.ok(reusedEdits > 0, "the sequence must exercise actual object reuse");
  t.diagnostic(`${reusedEdits}/160 edits retained nonempty Tree identities`);
});

test("recovery-safe fragment preparation preserves parser reconfiguration and stopAt", async () => {
  const a = await adapter();
  const { TreeFragment } = await import("@lezer/common");
  const damaged = "{x} ".repeat(1500) + "$open", old = a.language.parser.parse(damaged);
  const fragments = TreeFragment.addTree(old);
  assert.throws(() => a.language.configure({ strict: true }).parser.parse(damaged, fragments), SyntaxError);
  const partial = a.language.parser.startParse(damaged, fragments);
  partial.stopAt(2000);
  assert.equal(partial.stoppedAt, 2000);
  assert.throws(() => partial.stopAt(2001), RangeError);
  let tree;
  for (let turns = 0; !(tree = partial.advance()); turns++) assert.ok(turns < 100000, "preparation/parsing must finish");
  assert.ok(tree.length >= 2000 && tree.length < damaged.length);
});

test("summary prunes scalar visitor work while preserving nested regions and recovery", async () => {
  const a = await adapter();
  const text = "x ".repeat(2000) + "\\section{A {B}} {open";
  const tree = a.language.parser.parse(text), steps = a.summarySteps(tree, source(text));
  let count = 0, data;
  for (;;) { const step = steps.next(); if (step.done) { data = step.value; break; } count++; }
  assert.ok(count < 100, `scalar text should not require ${count} visitor yields`);
  assert.deepEqual(data.outline, [{ level: 2, num: "", title: "A {B}", offset: 4000, to: 4015, certainty: "exact" }]);
  assert.deepEqual(data.regions.map(r => [r.from, r.to, r.certainty, r.openEnded]), [[4008, 4015, "exact", false], [4011, 4014, "exact", false], [4016, 4021, "recovered", true]]);
});

test("direct queries refuse oversized summary traversal and return conservative contexts", async () => {
  const a = await adapter();
  const unreadableTree = { cursor() { throw new Error("Oversized traversal"); }, resolveInner() { throw new Error("Oversized context traversal"); } };
  const doc = { length: 1048577, sliceString() { throw new Error("Oversized document read"); } };
  assert.throws(() => a.summarize(unreadableTree, doc), { code: "IRIS_ANALYSIS_LIMIT" });
  assert.throws(() => a.summarySteps(unreadableTree, doc).next(), { code: "IRIS_ANALYSIS_LIMIT" });
  assert.deepEqual(a.contextAt(unreadableTree, doc, 10), { mode: "unknown", argumentRole: null, from: 10, to: 10, certainty: "unknown" });
});

test("LilyPond boundary probe handles Scheme strings, characters and nested music with incremental parity", async () => {
  const { buildParser } = require("@lezer/generator");
  const { TreeFragment } = await import("@lezer/common");
  const grammar = await fs.readFile(path.join(__dirname, "fixtures/languages/lilypond-boundaries.grammar"), "utf8");
  const { styleTags } = await import("@lezer/highlight");
  const { syntaxTags } = await load("public/iris-syntax-style.mjs");
  const parser = buildParser(grammar).configure({ props: [styleTags({ "Scheme/...": syntaxTags.scheme, "String!": syntaxTags.string,
    "SchemeComment! LineComment! BlockComment!": syntaxTags.comment, "Character!": syntaxTags.scheme })] });
  const summary = tree => nodes(tree).filter(([name]) => ["Music", "Scheme", "Group"].includes(name));
  let text = "{ c4 } ".repeat(500) + "#(define motif #{ c4 #(list \"a)\" #\\) ; ) comment\n #{ d4 #}) #})" + " { d4 }".repeat(500);
  assert.ok(text.length > 4096);
  let tree = parser.parse(text);
  assert.ok(!nodes(tree).some(n => n[0] === "⚠"), tree.toString());
  assert.equal(nodes(tree).filter(n => n[0] === "Music").length, 2);
  const from = text.indexOf("#}");
  for (const [to, insert] of [[from + 2, ""], [from, "#}"]]) {
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
    text = text.slice(0, from) + insert + text.slice(to);
    const previous = tree;
    tree = parser.parse(text, fragments);
    assert.ok(sharedTrees(previous, tree) > 0, "unchanged LY probe subtrees must actually be reused");
    const full = parser.parse(text);
    assert.deepEqual(nodes(tree), nodes(full));
    assert.deepEqual(await roles(tree), await roles(full));
    assert.deepEqual(summary(tree), summary(full));
    for (const pos of [text.indexOf("a)"), text.indexOf("#\\)"), from, text.length]) {
      const at = tree => { const node = tree.resolveInner(pos, -1); return [node.name, node.from, node.to]; };
      assert.deepEqual(at(tree), at(full), `probe context node at ${pos}`);
    }
    if (!insert) assert.ok(nodes(tree).some(n => n[0] === "⚠"), "missing music closer recovers");
  }
  assert.ok(!nodes(tree).some(n => n[0] === "⚠"));
  assert.ok(!nodes(parser.parse("#(define motif #{ c4 #})")).some(n => n[0] === "⚠"));
});
