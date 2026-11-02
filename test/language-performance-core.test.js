const test = require("node:test");
const assert = require("node:assert/strict");

test("TeX repeated literal chunks retain the immutable context when prefix state is unchanged", async () => {
  const { createContext } = await import("../public/languages/latex/tokens.mjs");
  const terms = await import("../public/languages/latex/parser.terms.mjs");
  const tracker = createContext();
  const literal = tracker.shift(tracker.start, terms.LiteralRejected, {}, { pos: 0 });
  let context = literal;
  for (let i = 0; i < 1000; i++) context = tracker.shift(context, terms.LiteralText, {}, { pos: i * 256 });
  assert.equal(context, literal, "unchanged prefix must not allocate/hash another frame per chunk");
  assert.ok(Object.isFrozen(context));
  const newline = tracker.shift(context, terms.LiteralNewline, {}, { pos: 256000 });
  assert.notEqual(newline.hash, context.hash, "a real line-prefix change must invalidate contextual reuse");
});

test("LilyPond continuity-only shifts preserve the hash without rehashing strings", async t => {
  const { createContext } = await import("../public/languages/lilypond/tokens.mjs");
  const terms = await import("../public/languages/lilypond/parser.terms.mjs");
  const tracker = createContext(), original = String.prototype.charCodeAt;
  let hashes = 0, context = tracker.shift(tracker.start, terms.Space, { pos: 1 }, { pos: 0 });
  const first = context;
  String.prototype.charCodeAt = function (...args) { hashes++; return original.apply(this, args); };
  try {
    for (let pos = 1; pos <= 1000; pos++) context = tracker.shift(context, terms.Space, { pos: pos + 1 }, { pos });
  } finally { String.prototype.charCodeAt = original; }
  t.diagnostic(`continuity-only hash character operations: ${hashes}`);
  assert.equal(context.end, 1001);
  assert.equal(first.end, 1, "previous LR stacks keep their immutable continuity coordinate");
  assert.equal(context.hash, first.hash);
  assert.equal(hashes, 0, "unhashed coordinates must not trigger character hashing");
});

for (const kind of ["tex", "ly"]) {
  test(`${kind} completed trees have reusable metadata before the next edit`, async t => {
    const { loadLanguage } = await import("../public/iris-language-service.mjs");
    const { Tree, TreeFragment } = await import("@lezer/common");
    const adapter = await loadLanguage(kind), parser = adapter.language.parser;
    const source = "% " + "head ".repeat(100) + "\n{" + (kind === "tex" ? "text $a+1$ " : "c4 d8 e8 ").repeat(20000) + "}\n";
    const tree = parser.parse(source);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: 2, toA: 2, fromB: 2, toB: 3 }]);
    const parse = parser.startParse(source.slice(0, 2) + "x" + source.slice(2), fragments);
    let turns = 0, result;
    while (parse.parsedPos === 0 && !(result = parse.advance()) && ++turns < 10000) {}
    t.diagnostic(`first edit preparation advances: ${turns}`);
    assert.ok(turns <= 4, `completed-tree metadata was deferred to the edit (${turns} advances)`);
    while (!result) result = parse.advance();
    const trees = root => {
      const found = new Set(), pending = [root];
      while (pending.length) { const node = pending.pop(); if (node instanceof Tree) { if (node.length) found.add(node); pending.push(...node.children); } }
      return found;
    };
    const before = trees(tree), shared = [...trees(result)].filter(node => before.has(node));
    assert.ok(shared.some(node => node.type.name === "Group" && node.length > 100000), "large unchanged Group retains actual identity");
  });

  test(`${kind} stopAt during uncached preflight does not synchronously drain the old tree`, async t => {
    const directory = kind === "tex" ? "latex" : "lilypond";
    const { parser } = await import(`../public/languages/${directory}/parser.mjs`);
    const { recoverySafeParser } = await import(`../public/languages/${directory}/reuse.mjs`);
    const { TreeFragment } = await import("@lezer/common");
    // A valid externally produced tree has not passed through eager preparation.
    const source = "{" + (kind === "tex" ? "text $a+1$ " : "c4 d8 e8 ").repeat(10000) + "}";
    const tree = parser.parse(source), parse = recoverySafeParser(parser).startParse(source, TreeFragment.addTree(tree));
    parse.advance();
    parse.stopAt(parse.parsedPos);
    let turns = 0, result;
    while (!(result = parse.advance()) && ++turns < 10000) {}
    t.diagnostic(`forced preflight finalization advances: ${turns}`);
    assert.ok(turns <= 4, `CM takeTree would drain ${turns} preparation advances synchronously`);
    assert.equal(parse.stoppedAt, 0);
    // Lezer may include the token crossing the stop, but not the old document.
    assert.ok(result.length <= 256, "stopping preflight cannot claim an unparsed full document");
  });
}

test("LilyPond unchanged bar-containing runs reuse trees with bounded contextual effects", async t => {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { TreeFragment } = await import("@lezer/common");
  const { ContextTracker } = await import("@lezer/lr");
  const { generateFixture } = require("./helpers/language-fixtures.cjs");
  const adapter = await loadLanguage("ly"), tracker = adapter.language.parser.context;
  let reused = 0, units = 0;
  const parser = adapter.language.parser.configure({ contextTracker: new ContextTracker({ ...tracker,
    reuse(value, tree, ...args) { reused++; units += tree.length; return tracker.reuse(value, tree, ...args); },
  }) });
  const source = generateFixture("ly", 64 * 1024).source, at = source.indexOf("c4");
  const before = parser.parse(source), changed = source.slice(0, at) + "r" + source.slice(at + 1);
  const after = parser.parse(changed, TreeFragment.applyChanges(TreeFragment.addTree(before), [{ fromA: at, toA: at + 1, fromB: at, toB: at + 1 }]));
  const nodes = tree => { const out = []; tree.iterate({ enter: n => out.push([n.name, n.from, n.to]) }); return out; };
  assert.deepEqual(nodes(after), nodes(parser.parse(changed)));
  t.diagnostic(`${reused} actual reused nodes / ${units} units of ${source.length}`);
  assert.ok(units > source.length / 2, "ordinary bars must not poison every repetition's compositional reuse effect");
});

test("TeX environment endings do not give healthy body repetitions a closing-header hash", async t => {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { TreeFragment } = await import("@lezer/common");
  const { ContextTracker } = await import("@lezer/lr");
  const { generateFixture } = require("./helpers/language-fixtures.cjs");
  const adapter = await loadLanguage("tex"), tracker = adapter.language.parser.context;
  let units = 0;
  const parser = adapter.language.parser.configure({ contextTracker: new ContextTracker({ ...tracker,
    reuse(value, tree, ...args) { units += tree.length; return tracker.reuse(value, tree, ...args); },
  }) });
  const source = generateFixture("tex", 64 * 1024).source, at = source.indexOf("a_1");
  const before = parser.parse(source), changed = source.slice(0, at) + "1" + source.slice(at + 1);
  const after = parser.parse(changed, TreeFragment.applyChanges(TreeFragment.addTree(before), [{ fromA: at, toA: at + 1, fromB: at, toB: at + 1 }]));
  const nodes = tree => { const out = []; tree.iterate({ enter: n => out.push([n.name, n.from, n.to]) }); return out; };
  assert.deepEqual(nodes(after), nodes(parser.parse(changed)));
  t.diagnostic(`${units} actually reused units of ${source.length}`);
  assert.ok(units > source.length / 2, "matched end header must not poison all preceding repetition hashes");
});

test("LilyPond composed operators preserve chord modifiers, whitespace resets and music roles", async () => {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { TreeFragment } = await import("@lezer/common");
  const { highlightTree } = await import("@lezer/highlight");
  const { roleHighlighter } = await import("../public/iris-syntax-style.mjs");
  const adapter = await loadLanguage("ly"), parser = adapter.language.parser;
  const roles = tree => { const out = []; highlightTree(tree, roleHighlighter, (from, to, role) => out.push([from, to, role])); return out; };
  for (const [mode, unit, numberRole] of [["chordmode", "c:7|9 c4 | ", "number"], ["notemode", "c:7|9 c4 | ", "duration"],
    ["chordmode", "c" + ":|".repeat(20) + "7 c4 | ", "number"]]) {
    const source = `\\${mode} { ` + unit.repeat(1500) + "}\n";
    const before = parser.parse(source), at = source.indexOf("c" + (unit.startsWith("c:") ? ":" : "4"), source.indexOf("{"));
    const changed = source.slice(0, at) + "d" + source.slice(at + 1);
    const after = parser.parse(changed, TreeFragment.applyChanges(TreeFragment.addTree(before), [{ fromA: at, toA: at + 1, fromB: at, toB: at + 1 }]));
    const actual = roles(after);
    assert.deepEqual(actual, roles(parser.parse(changed)));
    const lastUnit = changed.lastIndexOf(unit), seven = changed.indexOf("7", lastUnit), pitch = changed.indexOf("c4", lastUnit);
    assert.ok(actual.some(([from, to, role]) => from <= seven && to > seven && role === numberRole));
    assert.ok(actual.some(([from, to, role]) => from <= pitch && to > pitch && role === "pitch"), "space resets any preceding modifier");
  }
});

test("kernel verbatim uses bounded literal chunks across whitespace and raw line endings", async t => {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { generateFixture } = require("./helpers/language-fixtures.cjs");
  const adapter = await loadLanguage("tex"), body = generateFixture("tex", 1024 * 1024).source;
  const source = "\\begin{verbatim}\n" + body;
  const tree = adapter.language.parser.parse(source);
  let count = 0, maximum = 0;
  tree.iterate({ enter(node) {
    if (["LiteralText", "LiteralSpace", "LiteralNewline"].includes(node.name)) { count++; maximum = Math.max(maximum, node.to - node.from); }
  } });
  t.diagnostic(`${count} kernel literal leaves; maximum ${maximum} UTF-16 units`);
  assert.ok(count <= Math.ceil((body.length + 1) / 256) + 1, "kernel literals must not split each word/space/newline");
  assert.ok(maximum <= 256);
});

test("kernel literal chunks stop at exact own closers across chunk edges and preserve line-family rules", async () => {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { TreeFragment } = await import("@lezer/common");
  const { highlightTree } = await import("@lezer/highlight");
  const { roleHighlighter } = await import("../public/iris-syntax-style.mjs");
  const adapter = await loadLanguage("tex"), parser = adapter.language.parser;
  const roles = tree => { const out = []; highlightTree(tree, roleHighlighter, (from, to, role) => out.push([from, to, role])); return out; };
  for (const name of ["verbatim", "verbatim*"]) for (const at of [254, 255, 256, 257]) {
    const body = ("😀\r\n \t% $ {} \\end{wrong}\n").repeat(20).slice(0, at);
    const source = `\\begin{${name}}` + body + `\\end{${name}}\\section{After}`;
    const tree = parser.parse(source), doc = { length: source.length, sliceString: (a,b) => source.slice(a,b) };
    assert.deepEqual(adapter.summarize(tree, doc).outline.map(x => x.title), ["After"]);
    const literalStart = source.indexOf("}") + 1, closing = source.lastIndexOf(`\\end{${name}}`);
    const painted = new Array(source.length).fill(null);
    for (const [from, to, role] of roles(tree)) painted.fill(role, from, to);
    assert.ok(painted.slice(literalStart, closing).every(role => role === "literal"));
    const changed = source.slice(0, closing + 1) + "x" + source.slice(closing + 1);
    const incremental = parser.parse(changed, TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: closing + 1, toA: closing + 1, fromB: closing + 1, toB: closing + 2 }]));
    assert.deepEqual(roles(incremental), roles(parser.parse(changed)));
  }
  for (const [name, header, close] of [["minted", "{tex}", "  \\end{minted}"], ["comment", "", "\\end{comment}"]]) {
    const source = `\\begin{${name}}${header}\r\n` + `x\\end{${name}}\\section{Fake}\r\n` + close + "\r\n\\section{Real}";
    assert.deepEqual(adapter.summarize(parser.parse(source), { length: source.length, sliceString: (a,b) => source.slice(a,b) }).outline.map(x => x.title), ["Real"]);
  }
});

test("LilyPond summaries do not allocate SyntaxNodes for irrelevant scalar leaves", async t => {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { TreeCursor } = await import("@lezer/common");
  const adapter = await loadLanguage("ly"), source = "{ " + "c4 d8 e8 | ".repeat(10000) + "}";
  const tree = adapter.language.parser.parse(source), descriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "node");
  let allocations = 0, result;
  Object.defineProperty(TreeCursor.prototype, "node", { ...descriptor, get() { allocations++; return descriptor.get.call(this); } });
  try { result = adapter.summarize(tree, { length: source.length, sliceString: (a,b) => source.slice(a,b) }); }
  finally { Object.defineProperty(TreeCursor.prototype, "node", descriptor); }
  t.diagnostic(`${allocations} summary cursor.node requests for 10000 scalar phrases`);
  assert.ok(allocations < 100, "ignored scalar leaves must not materialize nodes");
  assert.deepEqual(result.outline, []);
  assert.deepEqual(result.symbols, []);
  assert.deepEqual(result.regions.map(r => [r.kind, r.from, r.to, r.certainty, r.openEnded]), [["group", 0, source.length, "exact", false]]);
});

test("TeX command signatures use bounded prefix lookup rather than rescanning the catalog", async t => {
  const { createContext } = await import("../public/languages/latex/tokens.mjs");
  const terms = await import("../public/languages/latex/parser.terms.mjs");
  const tracker = createContext();
  for (const [text, pending] of [["\\include{file}", "include"], ["\\alpha", null], ["\\includeExtra", null]]) {
    let reads = 0;
    const input = { pos: 0, peek(offset) { reads++; return offset < text.length ? text.charCodeAt(offset) : -1; } };
    const value = tracker.shift(tracker.start, terms.CatalogCommand, {}, input);
    assert.equal(value.pending?.name ?? null, pending);
    t.diagnostic(`${text}: ${reads} catalog lookahead operations`);
    assert.ok(reads <= 32, "lookup cost must follow the candidate prefix, not the number of catalog entries");
  }
});

test("TeX repeated immutable field hashes are composed with the parent without rehashing their characters", async t => {
  const { createContext } = await import("../public/languages/latex/tokens.mjs");
  const terms = await import("../public/languages/latex/parser.terms.mjs");
  const tracker = createContext(), input = { pos: 0, next: 36, peek: () => 120 };
  const first = tracker.shift(tracker.start, terms.MathOpen, {}, input), original = String.prototype.charCodeAt;
  let operations = 0, next;
  String.prototype.charCodeAt = function (...args) { operations++; return original.apply(this, args); };
  try {
    for (let i = 1; i <= 1000; i++) next = tracker.shift(tracker.start, terms.MathOpen, {}, { ...input, pos: i });
  } finally { String.prototype.charCodeAt = original; }
  assert.equal(next.hash, first.hash);
  assert.equal(first.from, 0); assert.equal(next.from, 1000);
  assert.ok(Object.isFrozen(next));
  assert.notEqual(tracker.shift(first, terms.MathOpen, {}, input).hash, first.hash, "parent context remains a reuse dependency");
  t.diagnostic(`${operations} repeated context-hash character operations`);
  assert.equal(operations, 0);
});
