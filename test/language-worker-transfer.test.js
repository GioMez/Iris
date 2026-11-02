const test = require("node:test");
const assert = require("node:assert/strict");
const load = file => import(`../public/${file}`);
const rows = tree => { const out = []; tree.iterate({ enter: n => out.push([n.name, n.from, n.to]) }); return out; };

for (const [kind, options, text] of [
  ["tex", { texProfile: "expl3" }, "😀\r\n\\foo_bar:n {x} $y$ ".repeat(400) + "\\section{After} {open"],
  ["ly", { initialNoteLanguage: "italiano" }, '{ do4 re8 r2 } #(list "x" #{ mi4 #})\r\n'.repeat(400) + "{ open"],
]) test(`Worker compact transfer preserves ${kind} actual types, offsets, props, roles and retained identity`, async () => {
  const wire = await load("iris-language-transfer.mjs").catch(() => ({}));
  assert.equal(typeof wire.encodeTree, "function", "real compact transfer is required");
  const { createParser } = await load("languages/parser-factory.mjs");
  const { loadLanguage } = await load("iris-language-service.mjs");
  const { Tree, TreeBuffer, NodeProp } = await import("@lezer/common");
  const { highlightTree } = await import("@lezer/highlight");
  const { roleHighlighter } = await load("iris-syntax-style.mjs");
  const adapter = await loadLanguage(kind, options), pure = createParser(kind, adapter.options);
  const original = pure.parse(text), fresh = adapter.language.parser.parse(text);
  const ids = new WeakMap(), records = [...wire.encodeTree(original, ids)];
  const buffers = records.filter(r => r.buffer);
  assert.ok(buffers.length > 0, "compact buffers must survive, not expand to scalar Trees");
  const before = buffers.map(r => r.buffer.slice());
  const received = structuredClone(records, { transfer: buffers.map(r => r.buffer.buffer) });
  assert.ok(buffers.every(r => r.buffer.byteLength === 0));
  assert.equal(original.toString(), fresh.toString(), "transferring copies must not detach cached parser trees");
  const decoded = new Map();
  for (const record of received) for (const _ of wire.decodeRecord(record, adapter.language.parser.nodeSet, decoded)) { /* cooperative */ }
  const tree = decoded.get(received.at(-1).id);
  assert.ok(tree instanceof Tree);
  assert.deepEqual(rows(tree), rows(fresh));
  const roles = tree => { const out = []; highlightTree(tree, roleHighlighter, (a, b, role) => out.push([a, b, role])); return out; };
  assert.deepEqual(roles(tree), roles(fresh));
  let dynamic = 0, compact = 0;
  const stack = [[tree, original]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (a instanceof TreeBuffer) { compact++; assert.deepEqual(a.buffer, b.buffer); assert.equal(a.set, adapter.language.parser.nodeSet); continue; }
    assert.equal(a.type, a.type.isAnonymous ? a.type : adapter.language.parser.nodeSet.types[b.type.id]);
    for (const prop of [NodeProp.contextHash, NodeProp.lookAhead]) { assert.equal(a.prop(prop), b.prop(prop)); if (b.prop(prop) !== undefined) dynamic++; }
    for (let i = 0; i < a.children.length; i++) stack.push([a.children[i], b.children[i]]);
  }
  assert.ok(dynamic > 0 && compact === before.length);
  const retained = [...wire.encodeTree(original, ids, new Set(decoded.keys()))];
  const again = new Map();
  for (const record of retained) for (const _ of wire.decodeRecord(record, adapter.language.parser.nodeSet, again, decoded)) {}
  assert.equal(again.get(retained.at(-1).id), tree, "acknowledged retained root reuses the actual local object");
  const doc = { length: text.length, sliceString: (a, b) => text.slice(a, b) };
  assert.deepEqual(adapter.summarize(tree, doc), adapter.summarize(fresh, doc));
  for (const pos of [0, 10, text.length - 2, text.length]) assert.deepEqual(adapter.contextAt(tree, doc, pos), adapter.contextAt(fresh, doc, pos));
});

test("Worker transfer refuses unknown dynamic properties and invalid references", async () => {
  const wire = await load("iris-language-transfer.mjs").catch(() => ({}));
  assert.equal(typeof wire.encodeTree, "function");
  const { Tree, NodeProp, NodeType, NodeSet } = await import("@lezer/common");
  assert.throws(() => [...wire.encodeTree(new Tree(NodeType.none, [], [], 0, [[new NodeProp({ perNode: true }), 1]]), new WeakMap())], /property/);
  assert.throws(() => [...wire.decodeRecord({ id: 1, reuse: true }, new NodeSet([]), new Map())], /reference/);
});
