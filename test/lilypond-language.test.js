const test = require("node:test");
const assert = require("node:assert/strict");
const { loadFixtures, rolesFor } = require("./helpers/language-fixtures.cjs");
const fixtures = loadFixtures().filter(f => f.kind === "ly" && !f.requirements.includes("LY-08"));
const source = text => ({ length: text.length, sliceString: (from, to) => text.slice(from, to) });
const load = async options => (await import("../public/iris-language-service.mjs")).loadLanguage("ly", options);
async function parse(text, options) {
  const adapter = await load(options), tree = adapter.language.parser.parse(text), doc = source(text);
  return { adapter, tree, doc, data: adapter.summarize(tree, doc), roles: await treeRoles(tree, text.length) };
}
async function treeRoles(tree, length) {
  const { highlightTree } = await import("@lezer/highlight");
  const { roleHighlighter } = await import("../public/iris-syntax-style.mjs");
  const roles = Array(length).fill(null);
  highlightTree(tree, roleHighlighter, (from, to, role) => roles.fill(role, from, to));
  return roles;
}
function nodes(tree) {
  const result = [];
  tree.iterate({ enter: n => result.push([n.name, n.from, n.to]) });
  return result;
}
function role(r, text, needle, expected, start = 0) {
  const from = text.indexOf(needle, start);
  assert.notEqual(from, -1, needle);
  assert.deepEqual(r.roles.slice(from, from + needle.length), Array(needle.length).fill(expected), needle);
}

test("pitch, octave, dotted duration and rest occupy exact UTF-16 spans", async () => {
  assert.equal(typeof rolesFor, "function", "HP05 semantic fixture helper is available");
  const roles = await rolesFor("ly", "{ cis'8. r4 }");
  assert.deepEqual(roles.slice(2, 6), Array(4).fill("pitch"));
  assert.deepEqual(roles.slice(6, 8), Array(2).fill("duration"));
  assert.equal(roles[9], "rest");
  assert.equal(roles[10], "duration");
});

for (const f of fixtures) test(`${f.id}: every LY01–07 role, caret, full outline and region target`, async t => {
  const r = await parse(f.source);
  for (const span of f.roles) assert.deepEqual(r.roles.slice(span.from, span.to), Array(span.to - span.from).fill(span.role === "text" ? null : span.role), `${span.requirement} ${span.text} [${span.from},${span.to})`);
  for (const caret of f.contexts) assert.equal(r.adapter.contextAt(r.tree, r.doc, caret.pos).mode, caret.mode, `caret ${caret.pos}`);
  assert.deepEqual(r.data.outline.map(x => x.title), f.outline);
  for (const target of f.regions || []) assert.ok(r.data.regions.some(x => x.from === target.from && x.to === target.to && x.label === target.label), JSON.stringify(target));
  if (f.validity.status === "complete") assert.deepEqual(nodes(r.tree).filter(n => n[0] === "⚠"), [], r.tree.toString());
  t.diagnostic(`${f.roles.length} role spans; ${f.contexts.length} carets; ${f.outline.length} outline entries; ${(f.regions || []).length} region targets`);
});

test("four 2.26 catalogs include exceptions and aliases without leaking mutable sets", async () => {
  const { noteNames, pitchCatalogVersion } = await import("../public/languages/lilypond/pitches.mjs");
  assert.equal(pitchCatalogVersion, "2.26.0");
  for (const [language, count, yes, no] of [
    ["nederlands", 67, "es eses as ases aeseh eeh bisis", "eseh asah h"],
    ["italiano", 63, "dobsb dodsd soldd sisb redsd", "dox doqs ré"],
    ["english", 105, "cx c-sharpsharp b-natural ctqf ftqs", "cis c-flat-flat h"],
    ["deutsch", 67, "b h asas asah ases aseh aeh eeh heseh", "hes aes eeseh"],
  ]) {
    const names = noteNames(language);
    assert.equal(names.size, count, language);
    for (const name of yes.split(" ")) assert.equal(names.has(name), true, `${language}: ${name}`);
    for (const name of no.split(" ")) assert.equal(names.has(name), false, `${language}: ${name}`);
    assert.equal(names.add, undefined);
    assert.throws(() => Set.prototype.add.call(names, "fake"), TypeError);
    assert.deepEqual([...names], [...names.values()]);
    names.forEach((name, key, owner) => { assert.equal(key, name); assert.equal(owner, names); });
  }
  for (const name of ["unknown", "constructor", "__proto__", "toString"]) assert.equal(noteNames(name), null);
});

test("non-nesting reference block comments, escapes, multiline Unicode and incomplete EOF stay opaque", async () => {
  // LilyPond v2.26.0 lily/lexer.ll <longcomment>: first %+} closes;
  // %{ in a longcomment does not push another state.
  const text = '%{ outer %{ inner %} { c4 }\n"\\\" %{ \\score { d4 } 😀\r\n" { e8 }';
  const r = await parse(text);
  role(r, text, "%{ outer %{ inner %}", "comment");
  role(r, text, "c", "pitch", text.indexOf("{ c"));
  role(r, text, "\\score { d4 }", "string");
  assert.equal(r.roles[text.indexOf("e8")], "pitch");
  assert.equal(r.roles[text.indexOf("e8") + 1], "duration");
});

test("catalog names are whole identifiers; commands are not notes; durations and expressive delimiters differ", async () => {
  const text = "{ cistern c-sharpness rattle qwerty \\c c!?8..*3/2 r\\breve. R1 s2 q4 8. [ ] ( ) -> -. \\< \\> \\! \\\\ | }";
  const r = await parse(text, { initialNoteLanguage: "english" });
  for (const word of ["cistern", "c-sharpness", "rattle", "qwerty"]) role(r, text, word, null);
  role(r, text, "\\c", "command");
  role(r, text, "c!?", "pitch");
  for (const d of ["8..*3/2", "\\breve.", "8."]) role(r, text, d, "duration");
  for (const a of ["[", "]", "(", ")", "->", "-.", "\\<", "\\>", "\\!"]) role(r, text, a, "articulation");
  role(r, text, "\\\\", "operator");
});

test("input modes restore music, figure numbers differ from durations, wrappers preserve their bodies", async () => {
  const text = '\\lyricmode { c do r "sol" } { c4 r } \\markup { c do r } { d8 } \\figuremode { <6 4>2 } \\chordmode { c1:maj7 } \\drummode { bd4 sn8 }';
  const r = await parse(text);
  role(r, text, "c do r", "lyric");
  role(r, text, "c do r", null, text.indexOf("\\markup"));
  role(r, text, "d", "pitch", text.indexOf("{ d"));
  for (const needle of ["6", "4>2", "7"]) assert.equal(r.roles[text.indexOf(needle)], "number");
  assert.equal(r.roles[text.indexOf(">2") + 1], "duration");
  for (const wrapper of ["relative c'", "absolute", "fixed c'", "transpose c d", "repeat volta 2", "alternative", "tuplet 3/2", "grace"]) {
    const text = `\\${wrapper} { c8 d } { e4 }`, r = await parse(text);
    assert.equal(r.roles[text.indexOf("c8")], "pitch", wrapper);
    assert.equal(r.roles[text.indexOf("e4")], "pitch", wrapper);
    assert.deepEqual(nodes(r.tree).filter(n => n[0] === "⚠"), [], wrapper);
  }
});

test("language directives and includes control local pitch certainty and normalized options", async () => {
  const a = await load(), explicit = await load({ initialNoteLanguage: "nederlands" });
  assert.equal(a, explicit);
  assert.equal(await load({ initialNoteLanguage: "invented-one" }), await load({ initialNoteLanguage: "invented-two" }));
  for (const options of [{ initialNoteLanguage: 4 }, { texProfile: "standard" }, { locale: "it" }]) await assert.rejects(load(options));
  const text = '\\language "italiano" { do4 c } \\include "file.ily" { do4 c } \\language "english" { cs8 do } \\language "constructor" { c4 }';
  const r = await parse(text);
  assert.equal(r.roles[text.indexOf("do4")], "pitch");
  const uncertain = text.indexOf("do4", text.indexOf("\\include"));
  assert.equal(r.roles[uncertain], null);
  assert.equal(r.adapter.contextAt(r.tree, r.doc, uncertain).certainty, "unknown");
  role(r, text, "cs", "pitch");
  assert.equal(r.roles[text.lastIndexOf("c4")], null);
  assert.deepEqual(r.data.includes.map(x => x.path), ["file.ily"]);
  assert.equal((await parse("{ do4 c }", { initialNoteLanguage: "italiano" })).roles[2], "pitch");
});

test("assignments are precise, quoted/compound names survive and only invocable symbols become commands", async () => {
  const text = '😀\r\nscalar = "value"\r\n{ c4 }\r\n"quoted name" = { d4 }\r\npart.name = { e4 }\r\nmelody = \\relative c\' { f4 }\r\n\\melody \\unknown \\header { title = "Title" }';
  const r = await parse(text);
  assert.deepEqual(r.data.outline.map(x => x.title), ["scalar =", '"quoted name" =', "part.name =", "melody = \\relative", "\\header"]);
  assert.equal(r.data.outline[0].offset, 4);
  assert.ok(r.data.outline[0].to <= text.indexOf("\r\n{ c"));
  assert.equal(r.data.regions.some(x => x.from === 4 && x.to > text.indexOf("\r\n{ c")), false);
  assert.deepEqual(r.data.symbols.filter(x => x.kind === "command").map(x => x.name), ["scalar", "melody"]);
  assert.ok(r.data.symbols.some(x => x.name === "quoted name" && x.kind === "variable"));
  role(r, text, "\\melody", "variable");
  role(r, text, "\\unknown", "command");
  role(r, text, "title", "property");
});

test("numeric scalar assignments and bare context identifiers cannot absorb a later unrelated block", async () => {
  const text = 'value = 120\n{ c4 }\nnegative = -2.5\n{ d8 }\n\\new Staff = staffOne \\with { indent = 2 } { e4 }';
  const r = await parse(text);
  assert.deepEqual(nodes(r.tree).filter(n => n[0] === '⚠'), []);
  assert.deepEqual(r.data.outline.map(x => x.title), ['value =', 'negative =', '\\new Staff = staffOne']);
  assert.equal(r.data.outline[0].to, text.indexOf('\n'));
  assert.equal(r.data.outline[1].to, text.indexOf('\n{ d'));
  role(r, text, '120', 'number'); role(r, text, '-2.5', 'number');
  assert.equal(r.roles[text.indexOf('e4')], 'pitch');
});

test("long with headers bind the actual context body and configuration never defines music variables", async () => {
  const text = '\\book { \\bookpart { \\score { \\new Staff = "long" \\with { instrumentName = "' + "x".repeat(1000) + '" } { c4 \\context Voice = "v" { d8 } } \\header { title = "Song" } \\layout {} \\midi {} } } } \\paper {}';
  const r = await parse(text), staff = r.data.regions.find(x => x.label === '\\new Staff = "long"');
  assert.equal(staff.to, text.indexOf(" \\header"));
  assert.ok(r.data.outline.some(x => x.title === "Song"));
  assert.deepEqual(r.data.symbols, []);
  assert.ok(r.data.outline.find(x => x.title === "\\book").titleKey);
  for (const x of Object.values(r.data)) assert.ok(Object.isFrozen(x));
});

test("property paths and basic Scheme scalars are isolated; HP06 qualifies actual embedded music only", async () => {
  const text = '{ \\override NoteHead.color = #red \\set Staff.foo = ##t \\unset Staff.foo \\revert NoteHead.color \\tweak color #blue c4 } #(list "\\score { d4 }" c4) #{ \\score { e4 } #} \\score { f4 }';
  const r = await parse(text);
  for (const s of ["#red", "##t", "#blue"]) role(r, text, s, "scheme");
  for (const p of ["NoteHead.color", "Staff.foo", "color"]) role(r, text, p, "property");
  assert.deepEqual(r.data.outline.map(x => x.title), ["Score 1", "Score 2"]);
  assert.equal(r.roles[text.indexOf('d4')], 'string');
  assert.equal(r.roles[text.indexOf('e4')], 'pitch');
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('e4')).certainty, 'exact');
  const literal = r.tree.topNode.getChild('MusicLiteral');
  assert.equal(literal.toString(), 'MusicLiteral(MusicLiteralOpen,Space,Block(BlockCommand,Space,MusicGroup(MusicOpen,Space,Pitch,Duration,Space,CloseBrace)),Space,MusicLiteralClose)');
  assert.equal(r.tree.topNode.getChild('SchemeExpression').toString(), 'SchemeExpression(SchemeIntro,SchemeList(SchemeListOpen,SchemeAtom,SchemeSpace,SchemeString(SchemeStringOpen,SchemeStringEscape,SchemeStringText,SchemeStringClose),SchemeSpace,SchemeAtom,SchemeListClose),SchemeFinish)');
});

function sharedTrees(a, b) {
  const old = new Set(), shared = new Set();
  const visit = (tree, fn) => { fn(tree); for (const child of tree.children || []) if (child.children) visit(child, fn); };
  visit(a, n => old.add(n)); visit(b, n => { if (n.length && old.has(n)) shared.add(n); });
  return shared.size;
}
async function parity(adapter, tree, text) {
  const full = adapter.language.parser.parse(text), doc = source(text), a = nodes(tree), b = nodes(full);
  assert.equal(a.length, b.length, "node count");
  for (let i = 0; i < a.length; i++) assert.deepEqual(a[i], b[i], `node ${i}`);
  assert.deepEqual(await treeRoles(tree, text.length), await treeRoles(full, text.length), "all UTF-16 roles");
  assert.deepEqual(adapter.summarize(tree, doc), adapter.summarize(full, doc), "all summary records");
  for (const pos of [0, 3, Math.min(1700, text.length), Math.floor(text.length / 2), text.length])
    assert.deepEqual(adapter.contextAt(tree, doc, pos), adapter.contextAt(full, doc, pos), `caret ${pos}`);
}

test("incremental language, mode, include, string, comment and nested repairs retain real identities", async t => {
  const { TreeFragment } = await import("@lezer/common"), a = await load();
  let text = '\\language "nederlands"\n' + '{ c4 { d8 } }\n'.repeat(500) + '\\lyricmode { do re }\n% tail\n"string"\n\\include "x.ily"\n{ do4 }\n\\language "nederlands"\n' + '{ c4 { e8 } }\n'.repeat(500);
  let tree = a.language.parser.parse(text), sharedEdits = 0;
  for (const [needle, replacement] of [
    ['nederlands', 'italiano'], ['italiano', 'english'], ['english', 'nederlands'],
    ['lyricmode', 'notemode'], ['notemode', 'lyricmode'], ['% tail', '%{ tail'], ['%{ tail', '% tail'],
    ['"string"', '"string'], ['"string', '"string"'], ['\\include "x.ily"', '\\language "italiano"'],
    ['{ c4 { d8 } }', '{ c4 { d8 }'], ['{ c4 { d8 }', '{ c4 { d8 } }'],
  ]) {
    const from = text.indexOf(needle), before = tree;
    assert.ok(from >= 0);
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: from + needle.length, fromB: from, toB: from + replacement.length }]);
    text = text.slice(0, from) + replacement + text.slice(from + needle.length);
    tree = a.language.parser.parse(text, fragments);
    const reused = sharedTrees(before, tree);
    if (reused) sharedEdits++;
    t.diagnostic(`${needle} -> ${replacement}: ${reused} shared nonempty Trees`);
    await parity(a, tree, text);
  }
  assert.ok(sharedEdits >= 8, `${sharedEdits}/12 edits reused`);
});

test("profile changes reject incompatible fragment meaning, including definitions and prototype names", async () => {
  const { TreeFragment } = await import("@lezer/common");
  const text = 'constructor = { c4 }\n__proto__ = { d4 }\n' + '{ do4 cs8 cis2 \\constructor \\toString \\__proto__ }\n'.repeat(200);
  const old = (await load()).language.parser.parse(text);
  for (const initialNoteLanguage of ["italiano", "english", "deutsch", "constructor"]) {
    const a = await load({ initialNoteLanguage }), tree = a.language.parser.parse(text, TreeFragment.addTree(old));
    await parity(a, tree, text);
  }
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "prototype"]) {
    const r = await parse(`\\${name} \\new ${name} { c4 } \\override ${name}.color = #red`);
    assert.ok(r.tree.length > 0);
    assert.equal(r.roles[0], "command");
  }
});

test("every prefix of short independent forms terminates; malformed closing edits match fresh parsing", async () => {
  const { TreeFragment } = await import("@lezer/common"), a = await load();
  const shorts = ['{ cis\'8. r4 }', '\\lyricmode { "sol" -- do }', '\\new Staff \\with { foo = ##t } { c4 }', '\\language "italiano" { do4 }', '%{ %{ x %} c4', 'name = "a\\"😀\r\nb"', '#(list c4) \\score { d4 }'];
  for (const text of shorts) for (let end = 0; end <= text.length; end++) {
    const prefix = text.slice(0, end), tree = a.language.parser.parse(prefix);
    assert.equal(tree.length, prefix.length);
    const r = a.summarize(tree, source(prefix));
    for (const region of r.regions) assert.ok(0 <= region.from && region.from <= region.to && region.to <= prefix.length);
    a.contextAt(tree, source(prefix), prefix.length);
  }
  let text = '{ c4 }\n'.repeat(800) + '\\markup { x } << { d4 } \\\\ { e8 } >>';
  let tree = a.language.parser.parse(text);
  for (const [needle, insert] of [['{ d4 }', '{ d4 >'], ['{ d4 >', '{ d4 }'], ['\\markup { x }', '\\markup { x'], ['\\markup { x', '\\markup { x }']]) {
    const from = text.indexOf(needle), old = tree;
    text = text.slice(0, from) + insert + text.slice(from + needle.length);
    tree = a.language.parser.parse(text, TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: from, toA: from + needle.length, fromB: from, toB: from + insert.length }]));
    await parity(a, tree, text);
  }
});

test("long tokens, cold caret queries, cooperative summaries and reuse preparation have bounded work", async t => {
  const a = await load(), { TreeFragment } = await import("@lezer/common");
  for (const text of ['"' + "x".repeat(100000) + '"', '%{' + "x".repeat(100000) + '%}', '\\' + "a".repeat(100000), "a".repeat(100000), '#(' + "x".repeat(100000) + ')', '#' + '1'.repeat(100000)]) {
    const tree = a.language.parser.parse(text);
    tree.iterate({ enter(n) { if (!n.node.firstChild && !n.type.isError) assert.ok(n.to - n.from <= 256, `${n.name}: ${n.to - n.from}`); } });
    assert.equal(tree.length, text.length);
  }
  const text = '\\new Staff \\with { instrumentName = "' + 'x'.repeat(20000) + '" } { ' + '{ c4 d8 } '.repeat(2000) + '}';
  let calls = 0, maxRead = 0;
  const doc = { length: text.length, sliceString(from, to) { calls++; maxRead = Math.max(maxRead, to - from); return text.slice(from, to); } };
  const tree = a.language.parser.parse(text), steps = a.summarySteps(tree, doc);
  const cold = a.contextAt(tree, doc, text.indexOf('c4'));
  assert.ok(cold.mode === 'music');
  assert.ok(calls <= 128);
  let turns = 0, result;
  for (;;) {
    calls = 0;
    const step = steps.next();
    assert.ok(calls <= 4, `summary step made ${calls} reads`);
    if (step.done) { result = step.value; break; }
    turns++;
  }
  assert.ok(turns > 20); assert.ok(maxRead <= 512, `largest read ${maxRead}`);
  assert.deepEqual(result, a.summarize(tree, source(text)));
  const partial = a.language.parser.startParse(text, TreeFragment.addTree(tree));
  let prepTurns = 0;
  while (partial.parsedPos === 0 && !partial.advance()) { prepTurns++; assert.ok(prepTurns < 100000); }
  assert.ok(prepTurns > 1, "fragment preflight is cooperative");
  while (!partial.advance()) {}
  t.diagnostic(`${turns} summary yields; max ${maxRead}-unit read; ${prepTurns} preparation turns`);
});

test("tokenizer lookahead and scalar query work are bounded on adversarial long headers", async t => {
  const { ExternalTokenizer } = await import('@lezer/lr');
  const { tokens } = await import('../public/languages/lilypond/tokens.mjs');
  const a = await load();
  let largest = 0, calls = 0;
  const measured = new ExternalTokenizer((input, stack) => {
    const from = input.pos;
    const proxy = { get next() { return input.next; }, get pos() { return input.pos; },
      peek(offset) { largest = Math.max(largest, input.pos + offset - from); return input.peek(offset); },
      advance(size = 1) { largest = Math.max(largest, input.pos + size - from); return input.advance(size); },
      acceptToken: (...args) => input.acceptToken(...args) };
    calls++; tokens.token(proxy, stack);
  }, { contextual: true });
  const text = '\\new Staff \\with { ' + 'a'.repeat(30000) + ' = "' + 'x'.repeat(30000) + '" } { c4 } ' + '\\' + 'b'.repeat(30000);
  const tree = a.language.parser.configure({ tokenizers: [{ from: tokens, to: measured }] }).parse(text);
  assert.equal(tree.length, text.length); assert.ok(largest <= 258, `lookahead/advance ${largest}`); assert.ok(calls > 100);
  const simple = '{ ' + 'c4 '.repeat(10000) + '}', plain = a.language.parser.parse(simple), steps = a.summarySteps(plain, source(simple));
  let yields = 0;
  while (!steps.next().done) yields++;
  assert.ok(yields < 1000, `scalar music should not require ${yields} visitor yields`);
  t.diagnostic(`${largest}-unit maximum token reach; ${calls} token calls; ${yields} scalar summary yields`);
});

test("deep cold caret queries use one linear ancestor walk and conservative uncertainty", async () => {
  const a = await load(), text = '{ '.repeat(100) + 'c4' + ' }'.repeat(100), tree = a.language.parser.parse(text);
  let parents = 0;
  const wrap = node => node && new Proxy(node, { get(target, property) {
    if (property === 'parent') { parents++; return wrap(target.parent); }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const measured = { type: tree.type, length: tree.length, cursor: () => tree.cursor(), resolveInner: (...args) => wrap(tree.resolveInner(...args)) };
  assert.equal(a.contextAt(measured, source(text), 200).mode, 'music');
  assert.ok(parents <= 256, `${parents} ancestor reads`);
});

test("caret certainty is local to its scope and scalar Scheme/property roles survive music ancestors", async () => {
  const a = await load(), text = '{ c4 \\override NoteHead.color = #red } { open', tree = a.language.parser.parse(text), doc = source(text);
  const cold = a.contextAt(tree, doc, 3);
  assert.equal(cold.certainty, 'exact');
  assert.equal(a.contextAt(tree, doc, text.indexOf('#red') + 1).mode, 'scheme');
  assert.equal(a.contextAt(tree, doc, text.indexOf('NoteHead') + 1).argumentRole, 'property');
  a.summarize(tree, doc);
  assert.deepEqual(a.contextAt(tree, doc, 3), cold);
});

test("large escaped include values decode cooperatively without a whole-value regex pass", async () => {
  const a = await load(), value = 'x\\n'.repeat(10000), text = '\\include "' + value + '"', tree = a.language.parser.parse(text);
  const original = RegExp.prototype[Symbol.replace];
  let largest = 0;
  RegExp.prototype[Symbol.replace] = function(input, replacement) { largest = Math.max(largest, input.length); return original.call(this, input, replacement); };
  let data;
  try { data = a.summarize(tree, source(text)); }
  finally { RegExp.prototype[Symbol.replace] = original; }
  assert.equal(data.includes[0].path, 'x\n'.repeat(10000));
  assert.ok(largest <= 512, `whole-value transform of ${largest} units`);
});

test("unsupported Scheme reader forms remain quarantined instead of exposing fake music", async () => {
  // HP06 qualifies characters, quotes, vectors, comments and music literals;
  // these independent unsupported dispatches retain the HP05 quarantine contract.
  for (const prefix of ['#(list #future ', "#'(#future ", '#@(#future ', '$@(#future ', '#(list #; #future ', '##vu8(', '##u8(', '##reader-extension(']) {
    const text = prefix + '\\score { c4 }', r = await parse(text);
    assert.equal(r.data.outline.length, 0, prefix);
    assert.notEqual(r.roles[text.indexOf('c4')], 'pitch', prefix);
    assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('c4')).certainty, 'unknown', prefix);
  }
});

test("pending state ends at completed scalar input modes and symbolic duration factors survive whitespace", async () => {
  const text = '\\markup "c" { d4 } \\markuplist { { c r } } { e8 } { c\\longa.. * 3/2 d4 }';
  const r = await parse(text);
  assert.equal(r.roles[text.indexOf('d4')], 'pitch');
  assert.equal(r.roles[text.indexOf('e8')], 'pitch');
  role(r, text, 'c r', null);
  role(r, text, '\\longa..', 'duration');
  assert.equal(r.roles[text.indexOf('*')], 'duration');
  role(r, text, '3/2', 'duration');
});

test("long pitch-like words never classify a suffix chunk as a separate note", async () => {
  const text = '{ ' + 'x'.repeat(512) + 'cis4 ' + '\\' + 'a'.repeat(512) + 'c4 }', r = await parse(text);
  assert.equal(r.roles[text.indexOf('cis4')], null);
  assert.equal(r.roles[text.lastIndexOf('c4')], 'command');
  assert.equal(r.data.outline.length, 0);
  for (const [atom, expected] of [['#' + 'x'.repeat(511) + 'cis4', 'scheme'], ['#' + '1'.repeat(1000), 'number']]) {
    const r = await parse(atom);
    assert.deepEqual(r.roles, Array(atom.length).fill(expected));
    assert.equal(r.adapter.contextAt(r.tree, r.doc, 600 < atom.length ? 600 : 300).mode, 'scheme');
  }
});

test("language certainty changes inside an existing group, including recovery from an unknown initial profile", async () => {
  const text = '{ do4 \\language "italiano" do4 \\include "x.ily" do4 \\language "italiano" do4 }';
  const r = await parse(text, { initialNoteLanguage: "unknown" });
  const positions = [...text.matchAll(/do4/g)].map(m => m.index);
  assert.deepEqual(positions.map(p => r.roles[p]), [null, "pitch", null, "pitch"]);
  assert.deepEqual(positions.map(p => r.adapter.contextAt(r.tree, r.doc, p).certainty), ["unknown", "exact", "unknown", "exact"]);
  for (const p of positions) {
    const cold = r.adapter.language.parser.parse(text);
    assert.equal(r.adapter.contextAt(cold, r.doc, p).certainty, r.adapter.contextAt(r.tree, r.doc, p).certainty);
  }
});

test("explicit note mode inside text modes overrides and then restores its outer mode", async () => {
  const text = '\\lyricmode { do \\notemode { c4 } re } \\markup { c \\score { d8 } r } { e2 }', r = await parse(text);
  for (const needle of ['c4', 'd8', 'e2']) {
    const p = text.indexOf(needle); assert.equal(r.roles[p], 'pitch');
    assert.equal(r.adapter.contextAt(r.tree, r.doc, p).mode, 'music', needle);
  }
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('re }')).mode, 'lyrics');
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('r }')).mode, 'markup');
});

test("quoted compound assignments preserve complete names and configuration scalar numbers", async () => {
  const text = '"part one"."voice two" = { c4 }\npart."name" = { d4 }\n\\layout { indent = #12.5 }\n\\override Staff.foo = #-3';
  const r = await parse(text);
  assert.deepEqual(nodes(r.tree).filter(x => x[0] === '⚠'), []);
  assert.deepEqual(r.data.outline.map(x => x.title), ['"part one"."voice two" =', 'part."name" =', '\\layout']);
  assert.deepEqual(r.data.symbols.filter(x => x.kind === 'command'), []);
  role(r, text, '#12.5', 'number'); role(r, text, '#-3', 'number');
});

for (const initialSeed of [73, 197]) test(`deterministic recovery sequence ${initialSeed} matches fresh trees and retains reuse`, async t => {
  const a = await load(), { TreeFragment } = await import('@lezer/common');
  let text = ('{ c4 { d8 } } \\markup { c } \\lyricmode { do -- re } %{ x %} "text"\n').repeat(160);
  let tree = a.language.parser.parse(text), seed = initialSeed, reused = 0;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 40; i++) {
    const from = random(text.length), to = Math.min(text.length, from + random(4)), insert = ['', '{', '}', '>', '%', '\n', '"', '\\', 'c'][random(9)], previous = tree;
    text = text.slice(0, from) + insert + text.slice(to);
    tree = a.language.parser.parse(text, TreeFragment.applyChanges(TreeFragment.addTree(previous), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]));
    reused += sharedTrees(previous, tree) > 0 ? 1 : 0;
    await parity(a, tree, text);
  }
  assert.ok(reused > 0); t.diagnostic(`${reused}/40 edits retain nonempty Tree identity`);
});

test('F1 reader dispatch names cannot escape quarantine at a following parenthesis', async () => {
  for (const prefix of ['##vu8', '##u8', '$#vu8', '##someFutureReader', '##' + 'x'.repeat(1000)]) {
    const text = prefix + '( \\score { c4 } )', r = await parse(text);
    assert.deepEqual(r.data.outline, [], prefix);
    assert.equal(r.roles[text.indexOf('c4')], 'scheme', prefix);
    assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('c4')).certainty, 'unknown', prefix);
  }
  const text = '##vu8(1 2 3) { c4 }', r = await parse(text);
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('1')).mode, 'scheme');
  assert.equal(r.roles[text.indexOf('1')], 'scheme');
});

test('F2 markup command chains and bare text own their real argument, then restore music', async () => {
  for (const markup of ['\\markup \\bold { c do r }', '\\markup \\bold \\italic { c do r }', '\\markup c', '\\markup \\fontsize #2 \\bold { c do r }', '\\markup \\concat { c do r }', '\\markup \\null']) {
    for (const assignment of ['', 'name = ']) {
      const text = assignment + markup + ' { d4 }', r = await parse(text), end = assignment.length + markup.length;
      assert.deepEqual(nodes(r.tree).filter(n => n[0] === '⚠'), [], text);
      assert.equal(r.data.outline[0].to, end, text);
      for (let p = assignment.length; p < end; p++) assert.ok(!['pitch', 'rest'].includes(r.roles[p]), `${text}: role ${p}`);
      if (markup.includes('c do r')) assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('c do r')).mode, 'markup');
      assert.equal(r.roles[text.indexOf('d4')], 'pitch');
      assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('d4')).certainty, 'exact');
    }
  }
  const dynamic = '\\markup \\unknownMarkup { c r } { d4 }', r = await parse(dynamic);
  assert.equal(r.roles[dynamic.indexOf('c r')], null);
  assert.equal(r.adapter.contextAt(r.tree, r.doc, dynamic.indexOf('c r')).certainty, 'unknown');
});

test('F3 recursive context, mode and wrapper bodies have complete exact regions', async () => {
  for (const [text, titles, needle, mode] of [
    ["\\new Staff \\relative c' { c4 }", ['\\new Staff'], 'c4', 'music'],
    ['\\new Lyrics \\lyricmode { c do r }', ['\\new Lyrics', '\\lyricmode'], 'c do r', 'lyrics'],
    ["\\relative c' \\tuplet 3/2 { c8 d e }", [], 'c8', 'music'],
    ["\\score { \\new Staff \\with { instrumentName = \"Iris\" } \\relative c' { c4 } }", ['Score 1', '\\new Staff'], 'c4', 'music'],
    ['\\new Staff \\new Voice { c4 }', ['\\new Staff', '\\new Voice'], 'c4', 'music'],
  ]) {
    const r = await parse(text);
    assert.deepEqual(nodes(r.tree).filter(n => n[0] === '⚠'), [], text);
    assert.deepEqual(r.data.outline.map(x => x.title), titles, text);
    assert.ok(r.data.outline.every(x => x.certainty === 'exact'), text);
    assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf(needle)).mode, mode);
    if (titles.length) assert.equal(r.data.outline[0].to, text.length);
    if (text.startsWith('\\score')) {
      const staff = r.data.regions.find(x => x.label === '\\new Staff');
      assert.deepEqual([staff.from, staff.to, staff.certainty], [9, 73, 'exact']);
    }
  }
});

test('F4 symbol names exclude trivia and damage, quoted invocations agree, and certainty follows the name', async () => {
  for (const trivia of [' %{ note %} ', ' % note\r\n ', (' %{ note %} ').repeat(1000)]) {
    const text = 'melody' + trivia + '= { c4 } \\melody', r = await parse(text);
    assert.deepEqual(r.data.symbols.map(x => [x.name, x.kind, x.from, x.to, x.certainty]), [['melody', 'command', 0, 6, 'exact']]);
    assert.equal(r.data.outline[0].title, 'melody =');
    role(r, text, '\\melody', 'variable');
    assert.equal(r.data.references[0].name, 'melody');
  }
  const quoted = await parse('"melody" = { c4 } \\melody');
  assert.deepEqual(quoted.data.symbols.map(x => [x.name, x.kind, x.from, x.to, x.certainty]), [['melody', 'command', 0, 8, 'exact']]);
  const damaged = await parse('foo > = { c4 } \\foo');
  assert.deepEqual(damaged.data.symbols.map(x => [x.name, x.certainty]), [['foo', 'recovered']]);
  assert.equal(damaged.roles[16], 'command');
  const compound = await parse('part %{ a %} . %{ b %} "voice name" = { c4 }');
  assert.deepEqual(compound.data.symbols.map(x => [x.name, x.kind]), [['part."voice name"', 'variable']]);
});

test('F5 time and metronome numbers differ from beat units and repeated music durations', async () => {
  const text = '{ \\time 3/4 \\tempo 4 = 120 c4 8. }', r = await parse(text);
  assert.deepEqual(nodes(r.tree).filter(n => n[0] === '⚠'), []);
  role(r, text, '3/4', 'number'); role(r, text, '120', 'number');
  role(r, text, '=', 'operator'); role(r, text, '8.', 'duration');
  assert.equal(r.roles[text.indexOf('4 =')], 'duration');
  assert.equal(r.roles[text.indexOf('c4')], 'pitch');
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf('120')).certainty, 'exact');
  for (const tempo of ['\\tempo "Allegro" 4. = 120', '\\tempo "Lento"', '\\tempo 4 = 100-120']) {
    const text = '{ ' + tempo + ' c4 }', r = await parse(text);
    assert.deepEqual(nodes(r.tree).filter(n => n[0] === '⚠'), [], tempo);
    assert.equal(r.roles[text.indexOf('c4')], 'pitch', tempo);
  }
});

test('F6 drum mode recognizes rests while drum pitch names remain neutral', async () => {
  const text = '\\drummode { bd4 r4 R1 s2 sn8 } { c4 }', r = await parse(text);
  for (const rest of ['r4', 'R1', 's2']) {
    const pos = text.indexOf(rest); assert.equal(r.roles[pos], 'rest'); assert.equal(r.roles[pos + 1], 'duration');
    assert.equal(r.adapter.contextAt(r.tree, r.doc, pos).mode, 'drums');
  }
  role(r, text, 'bd', null); role(r, text, 'sn', null);
  assert.equal(r.roles[text.indexOf('c4')], 'pitch');
});

test('F7 opaque include/language values invalidate pitch convention until a local literal directive', async () => {
  for (const directive of ['\\include #(string-append "x" ".ily")', '\\language #(list "italiano")', '\\include $(list "x.ily")']) {
    const text = directive + ' { c4 do4 } \\language "italiano" { do4 }', r = await parse(text), pos = text.indexOf('c4');
    assert.equal(r.roles[pos], null, directive);
    assert.equal(r.roles[pos + 1], 'duration');
    assert.equal(r.adapter.contextAt(r.tree, r.doc, pos).certainty, 'unknown');
    assert.equal(r.roles[text.lastIndexOf('do4')], 'pitch');
    assert.equal(r.adapter.contextAt(r.tree, r.doc, text.lastIndexOf('do4')).certainty, 'exact');
  }
});

function sharedNamedTrees(before, after, name) {
  const old = new Set(), shared = new Set();
  const visit = (tree, fn) => { fn(tree); for (const child of tree.children || []) if (child.children) visit(child, fn); };
  visit(before, n => { if (n.type.name === name && n.length) old.add(n); });
  visit(after, n => { if (old.has(n)) shared.add(n); });
  return shared.size;
}

test('F2/F7 actual large markup and HP06 qualified datum reuse preserves mode and language effects', async t => {
  const a = await load(), { TreeFragment } = await import('@lezer/common');
  const prefix = '% head\n' + ' '.repeat(300);
  const opaque = '#(list ' + 'x '.repeat(1200) + ')';
  const initial = prefix + '\\include ' + opaque + ' { c4 } \\language "nederlands"\n' +
    '\\markup \\bold { ' + 'c do r '.repeat(1000) + '} { d4 }\n' + '{ c4 } '.repeat(500);
  let text = initial, tree = a.language.parser.parse(text);
  const old = tree, from = 2;
  text = text.slice(0, from) + 'new ' + text.slice(from);
  tree = a.language.parser.parse(text, TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: from, toA: from, fromB: from, toB: from + 4 }]));
  const opaqueReuse = sharedNamedTrees(old, tree, 'SchemeExpression'), markupReuse = sharedNamedTrees(old, tree, 'MarkupCall');
  assert.ok(opaqueReuse > 0, 'the unchanged qualified datum itself is reused');
  assert.equal(nodes(tree).filter(n => n[0] === 'SchemeAtom').length, 1201);
  assert.equal(nodes(tree).filter(n => n[0] === 'SchemeList').length, 1);
  assert.deepEqual(nodes(tree).filter(n => n[0] === '⚠'), []);
  assert.ok(markupReuse > 0, 'the unchanged markup call itself is reused');
  await parity(a, tree, text);
  const roles = await treeRoles(tree, text.length), doc = source(text);
  assert.equal(roles[text.indexOf('c4')], null, 'reused include still invalidates pitches');
  assert.equal(roles[text.indexOf('c do r')], null, 'reused markup is text');
  assert.equal(roles[text.indexOf('d4')], 'pitch', 'reused markup restores mode');
  assert.equal(a.contextAt(tree, doc, text.indexOf('c4')).certainty, 'unknown');
  t.diagnostic(`${opaqueReuse} shared SchemeExpression; ${markupReuse} shared MarkupCall; ${sharedTrees(old, tree)} total shared nonempty Trees`);
});

test('F1–F7 composed edit/repair sequences have independent semantics and real reuse', async t => {
  const a = await load(), { TreeFragment } = await import('@lezer/common');
  let text = '% header\n' + '{ c4 d8 }\n'.repeat(500) +
    'melody %{ note %} = \\relative c\' \\tuplet 3/2 { c8 d e }\n\\melody\n' +
    '\\new Staff \\with { instrumentName = "Iris" } \\relative c\' { \\time 3/4 \\tempo 4 = 120 c4 }\n' +
    '\\new Lyrics \\lyricmode { c do r }\n\\markup \\bold { c r }\n\\drummode { bd4 r4 R1 s2 sn8 }\n' +
    '\\include #(list "file.ily") { c4 } \\language "nederlands"\n' + '{ c4 e8 }\n'.repeat(500);
  let tree = a.language.parser.parse(text), reused = 0;
  for (const [needle, insert] of [
    ['% header', '% changed header'], ['%{ note %}', '% note\r\n'],
    ['melody % note\r\n', '"melody" % note\r\n'], ['"melody" % note\r\n', 'melody > '], ['melody > ', 'melody %{ note %} '],
    ['\\bold', '\\fontsize #2 \\italic'], ['\\fontsize #2 \\italic', '\\bold'],
    ['\\time 3/4', '\\time 6/8'], ['4 = 120', '8. = 90'],
    ['\\lyricmode', '\\notemode'], ['\\notemode', '\\lyricmode'],
    ['\\drummode', '\\notemode'], ['\\notemode { bd4', '\\drummode { bd4'],
    ['#(list "file.ily")', '##vu8( \\score { c4 } )'], ['##vu8( \\score { c4 } )', '#(list "file.ily")'],
  ]) {
    const from = text.indexOf(needle), previous = tree; assert.ok(from >= 0, needle);
    text = text.slice(0, from) + insert + text.slice(from + needle.length);
    tree = a.language.parser.parse(text, TreeFragment.applyChanges(TreeFragment.addTree(previous), [{ fromA: from, toA: from + needle.length, fromB: from, toB: from + insert.length }]));
    const count = sharedTrees(previous, tree); reused += count > 0 ? 1 : 0;
    await parity(a, tree, text);
    const data = a.summarize(tree, source(text)), roles = await treeRoles(tree, text.length);
    assert.equal(data.outline.some(x => x.title.startsWith('Score')), false, 'quarantine cannot invent a score');
    assert.equal(roles[text.indexOf('c r }')], null, 'known markup arguments stay text');
    assert.equal(data.symbols[0].name, 'melody');
    assert.equal(data.symbols[0].certainty, text.includes('melody >') ? 'recovered' : 'exact');
    t.diagnostic(`${needle} -> ${insert}: ${count} shared Trees`);
  }
  assert.ok(reused >= 12, `${reused}/15 edits reused`);
});

test('F2–F5 independent short prefixes and long quoted/trivia names stay bounded and repairable', async () => {
  const a = await load();
  for (const text of ['\\markup \\bold \\italic { c r }', '\\markup \\fontsize #2 c { d4 }', "\\new Staff \\relative c' \\tuplet 3/2 { c8 }", '"melody" %{x%} = { c4 } \\melody', '{ \\time 3/4 \\tempo 4 = 120 c4 }']) {
    for (let end = 0; end <= text.length; end++) {
      const prefix = text.slice(0, end), tree = a.language.parser.parse(prefix);
      assert.equal(tree.length, prefix.length);
      a.summarize(tree, source(prefix)); a.contextAt(tree, source(prefix), prefix.length);
    }
  }
  const text = '\\markup \\bold ' + 'c'.repeat(100000) + ' { d4 }';
  const r = await parse(text);
  assert.equal(r.roles[text.indexOf('d4')], 'pitch');
  assert.equal(r.roles.slice(14, text.indexOf(' { d4')).includes('pitch'), false);
  r.tree.iterate({ enter(n) { if (!n.node.firstChild && !n.type.isError) assert.ok(n.to - n.from <= 256, `${n.name} ${n.to - n.from}`); } });
  for (const prefix of ['', '\\markup ']) {
    const tree = a.language.parser.parse(prefix + '\\' + 'a'.repeat(256) + ' { c4 }');
    tree.iterate({ enter(n) { if (!n.node.firstChild && !n.type.isError) assert.ok(n.to - n.from <= 256, `${n.name} ${n.to - n.from}`); } });
  }
  const declaration = '"melody"' + ' %{ x %} '.repeat(10000) + '= { c4 } \\melody';
  let reads = 0, maximum = 0;
  const doc = { length: declaration.length, sliceString(from, to) { reads++; maximum = Math.max(maximum, to - from); return declaration.slice(from, to); } };
  const tree = a.language.parser.parse(declaration), steps = a.summarySteps(tree, doc);
  for (;;) { reads = 0; const step = steps.next(); assert.ok(reads <= 4); if (step.done) { assert.equal(step.value.symbols[0].name, 'melody'); break; } }
  assert.ok(maximum <= 512);
});
