const test = require("node:test");
const assert = require("node:assert/strict");
const sourceDoc = text => ({ length: text.length, sliceString: (from, to) => text.slice(from, to) });
const adapter = async () => (await import("../public/iris-language-service.mjs")).loadLanguage("tex");

test("TeX summaries materialize structural nodes, not ignored scalar leaves", async t => {
  const a = await adapter(), { TreeCursor } = await import("@lezer/common");
  const source = "{" + "text 123 + \\alpha ".repeat(10000) + "}";
  const tree = a.language.parser.parse(source), descriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "node");
  let allocations = 0, result;
  Object.defineProperty(TreeCursor.prototype, "node", { ...descriptor, get() { allocations++; return descriptor.get.call(this); } });
  try { result = a.summarize(tree, sourceDoc(source)); }
  finally { Object.defineProperty(TreeCursor.prototype, "node", descriptor); }
  t.diagnostic(`${allocations} cursor.node requests for10000 scalar phrases`);
  assert.ok(allocations < 100, "ignored scalars must not allocate SyntaxNode/buffer-parent wrappers");
  assert.deepEqual(result, { outline: [], symbols: [], references: [], includes: [], regions: [
    { kind: "group", name: "", label: "group", from: 0, to: source.length, certainty: "exact", openEnded: false },
  ] });
});

test("already ordered TeX math regions take linear, cooperative ordering work without losing records", async t => {
  const a = await adapter(), count = 10000, source = "$x$ ".repeat(count), tree = a.language.parser.parse(source);
  const freeze = Object.freeze, seen = new WeakSet();
  let reads = 0, maximum = 0, turns = 0, result;
  // Observe the actual region objects at their normal freeze boundary. Counting
  // from/to accesses makes an unconditional NlogN reorder visible through the
  // public summary path, without exporting a test-only sorting API.
  Object.freeze = value => {
    if (value?.kind === "math" && !seen.has(value)) {
      seen.add(value); const from = value.from, to = value.to;
      Object.defineProperties(value, {
        from: { enumerable: true, configurable: true, get() { reads++; return from; } },
        to: { enumerable: true, configurable: true, get() { reads++; return to; } },
      });
    }
    return freeze(value);
  };
  try {
    const steps = a.summarySteps(tree, sourceDoc(source));
    for (;;) {
      const before = reads, step = steps.next(); maximum = Math.max(maximum, reads - before); turns++;
      if (step.done) { result = step.value; break; }
    }
  } finally { Object.freeze = freeze; }
  t.diagnostic(`${count} regions: ${reads} ordering field reads, max${maximum}/step, ${turns} total visitor turns`);
  assert.ok(reads <= count * 5, `already ordered output must use linear work, got ${reads} field reads`);
  assert.ok(maximum <= 768, "even the sortedness check must yield cooperatively");
  assert.equal(result.regions.length, count); assert.deepEqual(result.outline, []);
  for (let i = 0; i < count; i++) assert.deepEqual(result.regions[i], {
    kind: "math", name: "", label: "math", from: i * 4, to: i * 4 + 3, certainty: "exact", openEnded: false,
  });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.regions) && result.regions.every(Object.isFrozen));
});

test("TeX math region entry does not materialize a node that only its exit needs", async t => {
  const a = await adapter(), { TreeCursor } = await import("@lezer/common");
  const count = 10000, source = "$x$ ".repeat(count), tree = a.language.parser.parse(source);
  const descriptor = Object.getOwnPropertyDescriptor(TreeCursor.prototype, "node");
  let allocations = 0, result;
  Object.defineProperty(TreeCursor.prototype, "node", { ...descriptor, get() { allocations++; return descriptor.get.call(this); } });
  try { result = a.summarize(tree, sourceDoc(source)); }
  finally { Object.defineProperty(TreeCursor.prototype, "node", descriptor); }
  t.diagnostic(`${count} Math regions: ${allocations} cursor.node requests`);
  assert.ok(allocations <= count + 4, "range-only entry should use cursor coordinates; exit still inspects its real closer");
  assert.equal(result.regions.length, count);
  assert.deepEqual(result.regions.map(r => [r.from, r.to, r.certainty, r.openEnded]),
    Array.from({ length: count }, (_, i) => [i * 4, i * 4 + 3, "exact", false]));
});

test("TeX ordering keeps equal-range preorder stable through the full heading sort", async () => {
  const a = await adapter(), { Tree } = await import("@lezer/common");
  const types = Object.fromEntries(a.language.parser.nodeSet.types.map(type => [type.name, type]));
  // Real public Tree objects isolate equal comparator keys. Named wrappers share
  // a range; their distinct kinds/certainties make stability observable. The
  // appended real heading is emitted postorder and requires the full sort.
  const math = new Tree(types.Math, [new Tree(types.MathOpen, [], [], 1), new Tree(types.MathClose, [], [], 1)], [0, 9], 10);
  const literal = new Tree(types.Verb, [math], [0], 10), group = new Tree(types.Group, [literal], [0], 10);
  // Isolate the other comparator key with overlapping same-start Tree ranges.
  // A from-only sortedness check would incorrectly keep the shorter one first.
  const shorter = new Tree(types.Math, math.children, [0, 3], 4);
  const overlapping = new Tree(types.Document, [shorter, math], [0, 0], 10);
  assert.deepEqual(a.summarize(overlapping, sourceDoc("0123456789")).regions.map(r => [r.from, r.to]), [[0, 10], [0, 4]]);
  for (const suffix of ["", "\\section{Tail}"]) {
    const parsed = a.language.parser.parse(suffix), text = "0123456789" + suffix;
    const tree = new Tree(types.Document, [group, ...parsed.children], [0, ...parsed.positions.map(p => p + 10)], text.length);
    const data = a.summarize(tree, sourceDoc(text));
    assert.deepEqual(data.regions.slice(0, 3).map(r => [r.kind, r.from, r.to, r.certainty]), [
      ["group", 0, 10, "recovered"], ["literal", 0, 10, "recovered"], ["math", 0, 10, "exact"],
    ]);
    if (suffix) {
      assert.deepEqual(data.regions.slice(3).map(r => [r.kind, r.from, r.to]), [["heading", 10, 24], ["group", 18, 24]]);
      assert.deepEqual(data.outline, [{ level: 2, num: "1", title: "Tail", offset: 10, to: 24, certainty: "exact" }]);
    }
  }
});

test("TeX heading endpoints and recovered ranges retain from-ascending/to-descending ordering", async () => {
  const a = await adapter();
  const text = "😀\r\n\\section{A {B}}\r\n\\begin{outer}\\begin{inner}x\\end{outer}\r\n\\section{C} $open";
  const data = a.summarize(a.language.parser.parse(text), sourceDoc(text));
  const second = text.lastIndexOf("\\section"), closer = text.indexOf("\\end");
  assert.deepEqual(data.outline.map(r => [r.title, r.offset, r.certainty]), [["A {B}", 4, "exact"], ["C", second, "exact"]]);
  assert.deepEqual(data.regions.filter(r => r.kind === "heading").map(r => [r.label, r.from, r.to]), [["A {B}", 4, second], ["C", second, text.length]]);
  const environment = data.regions.find(r => r.kind === "environment");
  assert.equal(environment.name, "outer"); assert.equal(environment.certainty, "recovered");
  assert.equal(environment.to, closer + "\\end{outer}".length);
  assert.equal(data.regions.find(r => r.name === "inner").to, closer, "recovered inner environment ends at its ancestor close");
  const math = data.regions.find(r => r.kind === "math");
  assert.deepEqual([math.from, math.to, math.certainty, math.openEnded], [text.indexOf("$"), text.length, "recovered", true]);
  for (let i = 1; i < data.regions.length; i++) {
    const previous = data.regions[i - 1], current = data.regions[i];
    assert.ok(previous.from < current.from || previous.from === current.from && previous.to >= current.to);
  }
});
