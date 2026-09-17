const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFixtures } = require('./helpers/language-fixtures.cjs');
const source = text => ({ length: text.length, sliceString: (from, to) => text.slice(from, to) });
const load = async options => (await import('../public/iris-language-service.mjs')).loadLanguage('ly', options);
async function roles(tree, length) {
  const { highlightTree } = await import('@lezer/highlight');
  const { roleHighlighter } = await import('../public/iris-syntax-style.mjs');
  const result = Array(length).fill(null);
  highlightTree(tree, roleHighlighter, (from, to, role) => result.fill(role, from, to));
  return result;
}
async function parse(text) {
  const adapter = await load(), tree = adapter.language.parser.parse(text), doc = source(text);
  return { adapter, tree, doc, data: adapter.summarize(tree, doc), roles: await roles(tree, text.length),
    context: pos => adapter.contextAt(tree, doc, pos) };
}
function nodes(tree) { const out = []; tree.iterate({ enter: n => out.push([n.name, n.from, n.to]) }); return out; }
function span(r, text, needle, role) {
  const from = text.indexOf(needle); assert.ok(from >= 0, needle);
  assert.deepEqual(r.roles.slice(from, from + needle.length), Array(needle.length).fill(role), needle);
}
function clean(r) { assert.deepEqual(nodes(r.tree).filter(n => n[0] === '⚠'), [], r.tree.toString()); }

for (const f of loadFixtures().filter(f => f.requirements.includes('LY-08'))) test(`HP06 ${f.id}: every corpus role, caret and complete outline`, async t => {
  const r = await parse(f.source);
  for (const s of f.roles) assert.deepEqual(r.roles.slice(s.from, s.to), Array(s.to - s.from).fill(s.role), s.text);
  for (const c of f.contexts) assert.equal(r.context(c.pos).mode, c.mode, `caret ${c.pos}`);
  assert.deepEqual(r.data.outline.map(x => x.title), f.outline);
  if (f.id === 'lilypond-scheme') clean(r);
  t.diagnostic(`${f.roles.length} roles; ${f.contexts.length} carets; ${f.outline.length} outline entries`);
});

test('HP06 one datum returns through actual nested music to Scheme then outer music', async () => {
  const text = '#(define motif #{ c4 d #})\n\\score { c1 }', r = await parse(text);
  clean(r); span(r, text, 'define', 'scheme');
  assert.equal(r.roles[text.indexOf('c4')], 'pitch');
  assert.equal(r.roles[text.indexOf('c4') + 1], 'duration');
  assert.deepEqual(r.data.outline.map(x => x.title), ['Score 1']);
  assert.equal(r.context(text.indexOf('#}')).mode, 'music');
  assert.equal(r.context(text.indexOf('#}') + 2).mode, 'scheme');
  assert.equal(r.context(text.indexOf('\\score')).mode, 'music');
  for (const name of ['SchemeExpression', 'SchemeList', 'MusicLiteral', 'SchemeAtom', 'Pitch', 'Duration']) assert.ok(nodes(r.tree).some(n => n[0] === name), name);
});

test('HP06 reader introductions consume trivia and exactly one list, vector, quote or scalar', async () => {
  for (const intro of ['#', '$', '#@', '$@']) for (const datum of [
    '(a (b) 1)', '#(a 2)', "'(a b)", '`(a ,b ,@c)', '#t', '#f', 'red', '12.5', '3/4', '1e-3', '#x2a', '#e#x2a', '"a ) #} \\" b"',
    '#\\)', '#\\space', '#\\x41', '#\\λ', '#\\😀',
  ]) {
    const text = `${intro} ; leading\r\n #| outer #| nested |# |# ${datum} \\score { c4 }`, r = await parse(text);
    clean(r); assert.deepEqual(r.data.outline.map(x => x.title), ['Score 1'], text);
    assert.equal(r.roles[text.lastIndexOf('c4')], 'pitch', text);
  }
  const text = '#(list %symbol 3/4 1e-3 #x2a #e#x2a #t #f) #red #12.5', r = await parse(text);
  for (const s of ['%symbol', '#t', '#f', '#red']) span(r, text, s, 'scheme');
  for (const s of ['3/4', '1e-3', '#x2a', '#e#x2a', '#12.5']) span(r, text, s, 'number');
});

test('HP06 comments discard complete datums including nested comments and embedded music', async () => {
  const text = '#(list ; #{ \\score { c4 } #}\r\n #| outer #| inner |# #{ \\score { d4 } #} |# ' +
    '#! nonnested #! #{ \\score { e4 } #} !# ' +
    '#; #; #{ fake = { f4 } #} #{ \\score { g4 } #} ' +
    '#; \'(#{ \\score { a4 } #}) #{ \\score { b4 } #}) \\score { c1 }';
  const r = await parse(text); clean(r);
  assert.deepEqual(r.data.outline.map(x => x.title), ['Score 1', 'Score 2']);
  assert.deepEqual(r.data.symbols, []);
  for (const s of ['c4', 'd4', 'e4', 'f4', 'g4', 'a4']) { span(r, text, s, 'comment'); assert.equal(r.context(text.indexOf(s)).mode, 'comment', s); }
  assert.equal(r.roles[text.indexOf('b4')], 'pitch');
  assert.equal(r.context(text.indexOf('b4')).certainty, 'exact');
});

test('HP06 nested music protects its closer in music strings/comments and Scheme strings/comments', async () => {
  const text = '#(list #{ "#}" %{ #} %} % #}\n c4 #(list "#{ #} )" #| #{ #} |# #{ d8 #}) e2 #} tail) { f4 }';
  const r = await parse(text); clean(r);
  for (const s of ['c4', 'd8', 'e2', 'f4']) { assert.equal(r.roles[text.indexOf(s)], 'pitch', s); assert.equal(r.context(text.indexOf(s)).mode, 'music', s); }
  span(r, text, 'tail', 'scheme');
  assert.equal(nodes(r.tree).filter(n => n[0] === 'MusicLiteral').length, 2);
});

test('HP06 unknown reader dispatch and typed vectors stay quarantined without structure leakage', async () => {
  for (const reader of ['#vu8', '#u8', '#future-reader', '#.', '#1=', '#:', '#{']) {
    const prefix = reader === '#{' ? '#(list #future #{' : '#' + reader;
    const text = prefix + '( \\score { c4 } ) #{ \\score { d4 } #} ) \\score { e4 }';
    const r = await parse(text);
    assert.deepEqual(r.data.outline, [], reader);
    for (const s of ['c4', 'd4', 'e4']) { assert.notEqual(r.roles[text.indexOf(s)], 'pitch'); assert.equal(r.context(text.indexOf(s)).certainty, 'unknown'); }
  }
});

test('HP06 open EOF reader contexts and half-open adjacent boundaries remain conservative', async () => {
  for (const [text, mode] of [['#(', 'scheme'], ["#'", 'scheme'], ['#', 'scheme'], ['#(a "open', 'string'], ['#(a #| open', 'comment'], ['#(a #! open', 'comment'], ['#(a #;', 'comment'], ['#{ c4', 'music']]) {
    const r = await parse(text), c = r.context(text.length);
    assert.equal(c.mode, mode, text); assert.notEqual(c.certainty, 'exact', text);
    assert.ok(c.from <= text.length && c.to === text.length, text);
  }
  const text = '#(a)#{ c4 #}#(b) { d4 } { open', r = await parse(text);
  assert.equal(r.context(4).mode, 'music'); assert.equal(r.context(12).mode, 'scheme');
  assert.equal(r.context(text.indexOf('c4')).certainty, 'exact');
  assert.equal(r.context(text.indexOf('d4')).certainty, 'exact');
});

test('HP06 literal note language is local, including discarded literals and warm/cold context histories', async () => {
  // Native LilyPond 2.26 probe: \language inside #{...#} does not change the
  // caller's convention. A nested literal inherits its immediate entry profile.
  const text = '#(list #{ \\language "italiano" do4 #(list #{ re8 #}) #} #; #{ \\language "deutsch" h4 #}) { c4 }';
  const a = await load(), tree = a.language.parser.parse(text), doc = source(text);
  const before = [text.indexOf('do4'), text.indexOf('re8'), text.lastIndexOf('c4')].map(pos => a.contextAt(tree, doc, pos));
  const data = a.summarize(tree, doc), after = [text.indexOf('do4'), text.indexOf('re8'), text.lastIndexOf('c4')].map(pos => a.contextAt(tree, doc, pos));
  assert.deepEqual(after, before);
  assert.ok(after.every(c => c.certainty === 'exact'));
  const r = await parse(text); clean(r);
  for (const s of ['do4', 're8', 'c4']) assert.equal(r.roles[text.indexOf(s)], 'pitch', s);
  assert.deepEqual(data.outline, []);
  const unknown = await parse('#{ \\include "x.ily" c4 #} { d4 }');
  assert.equal(unknown.roles[unknown.doc.sliceString(0, unknown.doc.length).indexOf('c4')], null);
  assert.equal(unknown.context(unknown.doc.length - 4).certainty, 'exact');
});

function identities(tree) {
  const found = new Set(), pending = [tree];
  while (pending.length) { const t = pending.pop(); if (t.length) found.add(t); for (const c of t.children || []) if (c.children) pending.push(c); }
  return found;
}
async function parity(a, tree, text) {
  const full = a.language.parser.parse(text), doc = source(text);
  assert.deepEqual(nodes(tree), nodes(full), 'node names and raw ranges');
  assert.deepEqual(await roles(tree, text.length), await roles(full, text.length), 'per-unit roles');
  const data = a.summarize(tree, doc);
  assert.deepEqual(data, a.summarize(full, doc), 'complete summary');
  assert.ok(Object.isFrozen(data));
  for (const items of Object.values(data)) { assert.ok(Object.isFrozen(items)); for (const item of items) assert.ok(Object.isFrozen(item)); }
  for (const pos of [0, text.length, ...['prefix', 'alpha', 'c4', '#}', 'do4', 'd8', 'tail', '\\score'].map(s => text.indexOf(s)).filter(p => p >= 0)])
    assert.deepEqual(a.contextAt(tree, doc, pos), a.contextAt(full, doc, pos), `context ${pos}`);
}

test('HP06 delimiter, quote, discard, comment, string, profile and remote edits match fresh parsing with real reuse', async t => {
  const a = await load(), { TreeFragment } = await import('@lezer/common');
  let text = '% prefix 😀\r\n' + '{ c4 d8 }\r\n'.repeat(450) +
    '#(list \'alpha #; (discard #{ \\score { c4 } #}) #| block |# "text )" #{ \\language "italiano" do4 #(list #{ re8 #}) #} tail)\r\n' +
    '\\score { c4 }\r\n' + '{ e4 f8 }\r\n'.repeat(450);
  let tree = a.language.parser.parse(text), shared = 0;
  for (const [needle, insert] of [
    ['prefix', 'remote prefix'], ["'alpha", 'alpha'], ['alpha', "'alpha"], ['#; (discard', '(discard'], ['(discard', '#; (discard'],
    ['#| block |#', '; block\r\n'], ['; block\r\n', '#| block |#'], ['"text )"', '"text )'], ['"text )', '"text )"'],
    ['re8 #}', 're8 '], ['re8 ', 're8 #}'], ['italiano', 'english'], ['english', 'italiano'], ['tail)', 'tail'], ['tail', 'tail)'],
    ['#(list', '$@(list'], ['$@(list', '#(list'],
  ]) {
    const from = text.indexOf(needle); assert.ok(from >= 0, needle);
    const old = tree, prior = identities(old);
    text = text.slice(0, from) + insert + text.slice(from + needle.length);
    tree = a.language.parser.parse(text, TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: from, toA: from + needle.length, fromB: from, toB: from + insert.length }]));
    const reused = [...identities(tree)].filter(n => prior.has(n)).length;
    if (reused) shared++;
    t.diagnostic(`${needle} -> ${insert}: ${reused} shared nonempty Trees`);
    await parity(a, tree, text);
  }
  assert.ok(shared >= 12, `${shared}/17 edits must reuse`);
  const r = await parse(text); clean(r);
  assert.deepEqual(r.data.outline.map(x => x.title), ['Score 1']);
  assert.equal(r.roles[text.indexOf('do4')], 'pitch');
});

test('HP06 healthy 300k music group and large reader scopes retain their actual Tree identities', async t => {
  const a = await load(), { TreeFragment } = await import('@lezer/common');
  for (const [name, body] of [
    ['Group', '{ ' + 'c4 '.repeat(100000) + '}'],
    ['SchemeExpression', '#(list ' + 'alpha '.repeat(4000) + ')'],
    ['MusicLiteral', '#{ ' + 'c4 '.repeat(4000) + '#}'],
    ['SchemeDatumComment', '#(list #; (' + 'alpha '.repeat(4000) + ') beta)'],
  ]) {
    const text = ' '.repeat(500) + body, old = a.language.parser.parse(text), prior = identities(old);
    const next = ' ' + text, tree = a.language.parser.parse(next, TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: 0, toA: 0, fromB: 0, toB: 1 }]));
    const named = [...identities(tree)].filter(n => n.type.name === name && prior.has(n));
    assert.ok(named.length > 0, name);
    await parity(a, tree, next);
    t.diagnostic(`${name}: ${named.length} identical nonempty Trees (${body.length} units)`);
  }
});

test('HP06 adversarial reader chunks, summary steps and deep prefixes make bounded progress', async t => {
  const { ExternalTokenizer } = await import('@lezer/lr'), { tokens } = await import('../public/languages/lilypond/tokens.mjs'), a = await load();
  let reach = 0, calls = 0;
  const measured = new ExternalTokenizer((input, stack) => {
    const from = input.pos;
    const proxy = { get next() { return input.next; }, get pos() { return input.pos; },
      peek(n) { reach = Math.max(reach, input.pos + n - from); return input.peek(n); },
      advance(n = 1) { reach = Math.max(reach, input.pos + n - from); return input.advance(n); }, acceptToken: (...args) => input.acceptToken(...args) };
    calls++; tokens.token(proxy, stack);
  }, { contextual: true });
  const parser = a.language.parser.configure({ tokenizers: [{ from: tokens, to: measured }] });
  for (const datum of ['x'.repeat(100000), '"' + 'x'.repeat(100000) + '"', '#| ' + 'x'.repeat(100000) + ' |# x', '#! ' + 'x'.repeat(100000) + ' !# x', ';' + 'x'.repeat(100000) + '\nx']) {
    const text = '#(' + datum + ')', tree = parser.parse(text);
    assert.equal(tree.length, text.length);
    tree.iterate({ enter(n) { if (!n.node.firstChild && !n.type.isError) assert.ok(n.to - n.from <= 256, n.name); } });
    let reads = 0, largest = 0, yields = 0;
    const doc = { length: text.length, sliceString(from, to) { reads++; largest = Math.max(largest, to - from); return text.slice(from, to); } };
    const steps = a.summarySteps(tree, doc);
    for (;;) { reads = 0; const step = steps.next(); assert.ok(reads <= 4); if (step.done) break; assert.ok(++yields < 10000); }
    assert.ok(largest <= 512);
  }
  assert.ok(reach <= 258, `maximum tokenizer reach ${reach}`);
  for (const form of ["#'(a #; b c)", '#(list #\\) "#}" #{ c4 #})', '#(a #| b #| c |# d |#)', '#(a #! b !#)']) {
    for (let end = 0; end <= form.length; end++) { const text = form.slice(0, end), tree = parser.parse(text); assert.equal(tree.length, end); a.contextAt(tree, source(text), end); }
  }
  for (const text of ['#' + '('.repeat(600) + 'x' + ')'.repeat(600), '#' + "'".repeat(600) + 'x']) {
    const tree = parser.parse(text); assert.equal(tree.length, text.length);
    const c = a.contextAt(tree, source(text), text.length - 1); assert.ok(['scheme', 'unknown'].includes(c.mode));
  }
  t.diagnostic(`${reach}-unit maximum reach; ${calls} bounded tokenizer calls`);
});

test('HP06 numeric prefixes classify real numbers, not arbitrary hash atoms or numeric-looking symbols', async () => {
  const text = '#(list #b101 #o17 #d12 #xdead #i#x10 #x#e2a -1.2e+3 7/8 12abc 1e- deadbeef) #123abc #1e- ##x2a', r = await parse(text);
  clean(r);
  for (const s of ['#b101', '#o17', '#d12', '#xdead', '#i#x10', '#x#e2a', '-1.2e+3', '7/8', '##x2a']) span(r, text, s, 'number');
  for (const s of ['12abc', '1e-', 'deadbeef', '#123abc', '#1e-']) span(r, text, s, 'scheme');
  for (const invalid of ['#b29', '#o89', '#xgh', '#e#i1', '#x#d1']) {
    const value = '#' + invalid + ' ( \\score { c4 } )', r = await parse(value);
    assert.deepEqual(r.data.outline, []); assert.equal(r.context(value.indexOf('c4')).certainty, 'unknown');
  }
});

test('HP06 cold deeply quoted EOF boundary inspection shares a finite budget', async () => {
  const a = await load(), text = '#' + "'".repeat(250), tree = a.language.parser.parse(text);
  let inspections = 0;
  const wrap = node => node && new Proxy(node, { get(target, prop) {
    if (['parent', 'lastChild', 'firstChild', 'prevSibling'].includes(prop)) { inspections++; return wrap(Reflect.get(target, prop, target)); }
    const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const measured = { type: tree.type, length: tree.length, cursor: () => tree.cursor(), resolveInner: (...args) => wrap(tree.resolveInner(...args)) };
  assert.notEqual(a.contextAt(measured, source(text), text.length).certainty, 'exact');
  assert.ok(inspections <= 1024, `${inspections} boundary/ancestor reads`);
});

test('HP06 dotted pair tails are explicit datums and malformed tails cannot certify exact structure', async () => {
  const text = "#'(a (b . c) . #; discarded #{ d4 #}) \\score { e1 }", r = await parse(text);
  clean(r); assert.equal(nodes(r.tree).filter(n => n[0] === 'SchemeTail').length, 2);
  assert.equal(r.roles[text.indexOf('d4')], 'pitch');
  assert.deepEqual(r.data.outline.map(x => x.title), ['Score 1']);
  for (const text of ['#(a .)', '#(a . b c)', '#(. a)', '##(a . b)']) {
    const r = await parse(text);
    assert.ok(nodes(r.tree).some(n => n[0] === '⚠'), text);
    assert.notEqual(r.context(text.indexOf('.')).certainty, 'exact', text);
  }
});

test('HP06 music literals have an independent configuration/symbol scope and restore caller modes', async () => {
  const text = '\\header { value = #(list #{ local = { c4 } \\local #}) } \\local ' +
    '\\lyricmode { before #(list #{ c4 #}) after } { d8 }';
  const r = await parse(text); clean(r);
  assert.ok(r.data.symbols.some(s => s.name === 'local' && s.kind === 'command'));
  assert.equal(r.roles[text.indexOf('\\local')], 'variable');
  assert.equal(r.roles[text.indexOf('\\local', text.indexOf('\\local') + 1)], 'command');
  assert.equal(r.context(text.indexOf('local =')).mode, 'music');
  assert.equal(r.context(text.indexOf('after')).mode, 'lyrics');
  assert.equal(r.roles[text.indexOf('d8')], 'pitch');
});

test('HP06 quoted vector and character boundaries cannot release suffixes into music', async () => {
  for (const datum of ["'#('a)", "`#(,a ,@b)", "'(#('a) b)", '#\\)', '#\\λ', '#\\😀', '#\\x1f600']) {
    const text = '#' + datum + ' \\score { c4 }', r = await parse(text);
    clean(r); assert.deepEqual(r.data.outline.map(x => x.title), ['Score 1'], datum);
  }
  const text = '##\\😀fake( \\score { c4 } )', r = await parse(text);
  assert.deepEqual(r.data.outline, []);
  assert.equal(r.context(text.indexOf('c4')).certainty, 'unknown');
});

test('HP06 damaged inner music groups recover at the literal closer without losing the outer reader', async () => {
  const text = '#(list #{ { c4 #} tail) \\score { d8 }', r = await parse(text);
  assert.ok(nodes(r.tree).some(n => n[0] === '⚠'));
  span(r, text, 'tail', 'scheme');
  assert.deepEqual(r.data.outline.map(x => x.title), ['Score 1']);
  assert.equal(r.roles[text.indexOf('d8')], 'pitch');
  assert.notEqual(r.context(text.indexOf('c4')).certainty, 'exact');
  const fixed = await parse(text.replace('c4 #}', 'c4 } #}')); clean(fixed);
});

test('HP06 arbitrarily long dispatch names that begin like radix numbers cannot expose suffix music', async () => {
  for (const prefix of ['##x' + 'a'.repeat(600), '##b' + '1'.repeat(600), '##e' + '1'.repeat(600)]) {
    const text = prefix + 'z( \\score { c4 } ) #{ \\score { d8 } #}', r = await parse(text);
    assert.deepEqual(r.data.outline, []);
    assert.notEqual(r.roles[text.indexOf('c4')], 'pitch');
    assert.equal(r.context(text.indexOf('c4')).certainty, 'unknown');
  }
});

test('HP06 unqualified bracket/escaped-symbol readers quarantine rather than invent an outer score', async () => {
  for (const prefix of ['#[a ', '#(list [a ', '#|escaped ']) {
    const text = prefix + '\\score { c4 } ] | \\score { d8 }', r = await parse(text);
    assert.deepEqual(r.data.outline, [], prefix);
    assert.equal(r.context(text.indexOf('c4')).certainty, 'unknown');
  }
});

test('HP06 R1 quote punctuation continues an existing Scheme atom, including scalar chunk boundaries', async () => {
  for (const punctuation of ["'", '`', ',']) {
    for (const head of ['foo', 'x'.repeat(255), 'x'.repeat(256), 'x'.repeat(511)]) {
      const datum = head + punctuation + 'c4', text = '#' + datum + ' \\score { d8 }', r = await parse(text);
      clean(r); span(r, text, '#' + datum, 'scheme');
      const expression = r.tree.topNode.firstChild;
      assert.equal(expression.name, 'SchemeExpression');
      assert.deepEqual([expression.from, expression.to], [0, datum.length + 1]);
      assert.equal(nodes(expression.toTree()).some(n => n[0] === 'SchemeQuote'), false);
      assert.deepEqual(r.context(text.indexOf('c4')), { mode: 'scheme', argumentRole: null, from: 1, to: datum.length + 1, certainty: 'exact' });
      assert.deepEqual(r.data.outline.map(x => [x.title, x.offset]), [['Score 1', text.indexOf('\\score')]]);
      assert.equal(r.roles[text.indexOf('d8')], 'pitch');
      r.tree.iterate({ enter(n) { if (!n.node.firstChild && !n.type.isError) assert.ok(n.to - n.from <= 256, n.name); } });
    }
    const text = '#foo' + punctuation + '\\score { c4 } \\score { d8 }', r = await parse(text);
    clean(r); span(r, text, '#foo' + punctuation + '\\score', 'scheme');
    assert.deepEqual(r.data.outline.map(x => [x.title, x.offset]), [['Score 1', text.lastIndexOf('\\score')]]);
    assert.equal(r.roles[text.indexOf('c4')], 'pitch', 'the following group is genuinely outer music');
    assert.equal(r.context(text.indexOf('c4')).certainty, 'exact');
    const quoted = await parse('#' + punctuation + 'foo { c4 }');
    clean(quoted); assert.equal(nodes(quoted.tree).filter(n => n[0] === 'SchemeQuote').length, 1, 'datum-start quote still works');
  }
  const r = await parse("#foo'c4");
  assert.equal(r.tree.toString(), 'Document(SchemeExpression(SchemeAtomIntro,SchemeAtom,SchemeFinish))');
  assert.deepEqual(r.data.outline, []);
});

test('HP06 R1 characters and numeric dispatch validate quote punctuation before releasing the datum', async () => {
  for (const punctuation of ["'", '`', ',']) {
    for (const prefix of ['##\\' + punctuation + 'c4', '##x2a' + punctuation + '\\score', '##t' + punctuation + 'c4']) {
      const text = prefix + ' { c4 } \\score { d8 }', r = await parse(text);
      assert.ok(nodes(r.tree).some(n => n[0] === 'SchemeUnknown'), text);
      assert.equal(nodes(r.tree).some(n => ['Pitch', 'Duration', 'Block'].includes(n[0])), false, text);
      assert.equal(r.context(text.indexOf('d8')).certainty, 'unknown');
      assert.equal(r.context(text.indexOf('d8')).mode, 'scheme');
      span(r, text, '\\score { d8 }', 'scheme');
      assert.deepEqual(r.data.outline, []);
    }
    const text = '##\\' + punctuation + ' { c4 }', r = await parse(text);
    clean(r); span(r, text, '##\\' + punctuation, 'scheme');
    assert.equal(r.roles[text.indexOf('c4')], 'pitch', 'isolated punctuation character is valid');
  }
});

test('HP06 R2 directive effects occur after their datum and cold/warm literal profiles agree', async () => {
  for (const [text, inner, outer] of [
    ['\\include #(list #{ c4 #} #{ d4 #}) { e4 }', ['c4', 'd4'], 'e4'],
    ['\\language #(list #{ c4 #} #{ d4 #}) { e4 }', ['c4', 'd4'], 'e4'],
    ['\\include #(list #{ \\language "italiano" do4 #} #{ c4 #}) { e4 }', ['do4', 'c4'], 'e4'],
    ['#{ \\include #(list #{ c4 #} #{ d4 #}) e4 #} { f4 }', ['c4', 'd4', 'f4'], 'e4'],
    ['\\include #{ c4 #} { e4 }', ['c4'], 'e4'],
  ]) {
    const a = await load(), tree = a.language.parser.parse(text), doc = source(text), semantic = await roles(tree, text.length);
    assert.equal(nodes(tree).some(n => n[0] === '⚠'), false, text);
    const positions = [...inner, outer].map(s => text.indexOf(s)), before = positions.map(pos => a.contextAt(tree, doc, pos));
    for (const [index, pos] of positions.entries()) {
      assert.equal(semantic[pos], index < inner.length ? 'pitch' : null, text);
      assert.equal(before[index].mode, 'music', text);
      assert.equal(before[index].certainty, index < inner.length ? 'exact' : 'unknown', text);
    }
    const data = a.summarize(tree, doc);
    assert.deepEqual(positions.map(pos => a.contextAt(tree, doc, pos)), before, text);
    assert.deepEqual(data.outline.map(x => x.title), text.includes('\\include') ? ['\\include'] : []);
    assert.equal(data.regions.filter(x => x.name === 'MusicLiteral').every(x => x.certainty === 'exact'), true);
    assert.deepEqual(data.symbols, []); assert.deepEqual(data.includes, []);
  }
});

test('HP06 R3 a discarded datum owns unknown markup context and suppresses all descendant records', async () => {
  const text = '#(list #; #{ \\markup \\future c4 #} x) { d4 }';
  const a = await load(), tree = a.language.parser.parse(text), doc = source(text);
  const discarded = nodes(tree).find(n => n[0] === 'SchemeDatumComment');
  assert.deepEqual(discarded, ['SchemeDatumComment', 7, text.length]);
  assert.ok(nodes(tree).some(n => n[0] === 'UnknownMarkup'));
  const want = { mode: 'comment', argumentRole: null, from: 7, to: text.length, certainty: 'unknown' };
  for (const pos of [text.indexOf('c4'), text.indexOf('d4'), text.length]) assert.deepEqual(a.contextAt(tree, doc, pos), want);
  const data = a.summarize(tree, doc);
  assert.deepEqual(data, { outline: [], regions: [], symbols: [], references: [], includes: [] });
  for (const pos of [text.indexOf('c4'), text.indexOf('d4'), text.length]) assert.deepEqual(a.contextAt(tree, doc, pos), want);
  const semantic = await roles(tree, text.length);
  assert.deepEqual(semantic.slice(7), Array(text.length - 7).fill('comment'));
  const ordinary = await parse('\\markup \\future c4');
  assert.deepEqual(ordinary.context(ordinary.doc.length), { mode: 'markup', argumentRole: null, from: 8, to: 18, certainty: 'unknown' });
});

test('HP06 R1–R3 remote and boundary edits preserve corrected semantics with actual large-reader reuse', async t => {
  const a = await load(), { TreeFragment } = await import('@lezer/common');
  let text = '% header 😀\r\n' + ' '.repeat(500) + "#foo'c4\r\n#foo,\\score { c4 }\r\n" +
    '\\include #(list ' + 'pad '.repeat(1200) + '#{ c4 #} #{ d4 #}) { e4 }\r\n\\language "nederlands"\r\n' +
    '{ g4 a8 }\r\n'.repeat(500) + '#(list #; #{ \\markup \\future c4 #} x) { d4 }';
  assert.ok(text.length > 4096);
  let tree = a.language.parser.parse(text), sharing = 0;
  for (const [needle, insert] of [
    ['header', 'remote header'], ["#foo'c4", '#foo`c4'], ['#foo`c4', '#foo,c4'], ['#foo,c4', '#foo c4'], ['#foo c4', "#foo'c4"],
    ['#foo,\\score', "##x2a'\\score"], ["##x2a'\\score", '#foo,\\score'],
    ['\\include #(list', '\\language #(list'], ['\\language #(list', '\\include #(list'],
    ['#{ c4 #}', '#{ \\language "italiano" do4 #}'], ['#{ \\language "italiano" do4 #}', '#{ c4 #}'],
    ['#; #{ \\markup', '#{ \\markup'], ['#{ \\markup', '#; #{ \\markup'], ['\\future', '\\bold'], ['\\bold', '\\future'],
  ]) {
    const from = text.indexOf(needle); assert.ok(from >= 0, needle);
    const old = tree, prior = identities(old);
    text = text.slice(0, from) + insert + text.slice(from + needle.length);
    tree = a.language.parser.parse(text, TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: from, toA: from + needle.length, fromB: from, toB: from + insert.length }]));
    const reused = [...identities(tree)].filter(n => prior.has(n));
    if (reused.length) sharing++;
    if (needle === 'header') assert.ok(reused.some(n => n.type.name === 'SchemeExpression' && n.length > 4096), 'the affected include datum itself is reused after the offset edit');
    await parity(a, tree, text);
    const doc = source(text), data = a.summarize(tree, doc), semantic = await roles(tree, text.length), full = a.language.parser.parse(text);
    a.summarize(full, doc);
    assert.equal(data.outline.some(x => x.titleKey === 'templates.scoreNumber'), false, 'a reader atom cannot invent Score 1');
    const firstAtom = text.indexOf('#foo'), firstNote = text.indexOf('c4', firstAtom), badReader = text.indexOf("##x2a'\\score");
    assert.equal(semantic[firstNote], text.includes('#foo c4') ? 'pitch' : 'scheme');
    const inner = text.indexOf('#{ d4 #}'), outside = text.indexOf('e4'), markup = text.lastIndexOf('\\markup'), protectedNote = text.indexOf('c4', markup);
    for (const pos of [firstNote, inner + 3, outside, protectedNote, text.length])
      assert.deepEqual(a.contextAt(tree, doc, pos), a.contextAt(full, doc, pos), `affected caret ${pos}`);
    if (badReader >= 0) {
      assert.deepEqual(data.outline, []);
      assert.equal(a.contextAt(tree, doc, protectedNote).mode, 'scheme');
      assert.equal(a.contextAt(tree, doc, protectedNote).certainty, 'unknown');
    } else {
      assert.equal(semantic[inner + 3], 'pitch');
      assert.equal(a.contextAt(tree, doc, inner + 3).certainty, 'exact', 'later literal inherits the pre-directive convention');
      assert.equal(semantic[outside], null);
      assert.equal(a.contextAt(tree, doc, outside).certainty, 'unknown', 'directive takes effect at its endpoint');
      const discarded = text.includes('#; #{ \\markup');
      assert.equal(semantic[protectedNote], discarded ? 'comment' : null);
      const context = a.contextAt(tree, doc, protectedNote);
      assert.equal(context.mode, discarded ? 'comment' : 'markup');
      assert.equal(context.certainty, text.includes('\\future') ? 'unknown' : 'exact');
      if (discarded) {
        const owner = nodes(tree).find(n => n[0] === 'SchemeDatumComment');
        assert.deepEqual([context.from, context.to], owner.slice(1));
        assert.equal(data.regions.some(r => r.from >= owner[1] && r.from < owner[2]), false);
      }
    }
    t.diagnostic(`${needle} -> ${insert}: ${reused.length} shared nonempty Trees`);
  }
  assert.ok(sharing >= 13, `${sharing}/15 edits must retain actual identities`);
});
