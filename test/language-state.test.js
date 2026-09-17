const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const service = () => import("../public/iris-language-service.mjs");
const stateService = () => import("../public/iris-language-state.mjs");
const doc = text => ({ length: text.length, sliceString: (from, to) => text.slice(from, to) });

function clock() {
  let time = 0, id = 0;
  const tasks = new Map();
  return {
    now: () => time,
    schedule(fn, delay) { const key = ++id; tasks.set(key, { fn, at: time + delay }); return key; },
    cancel: key => tasks.delete(key),
    tick(ms) {
      time += ms;
      const ready = [...tasks].filter(([, value]) => value.at <= time);
      for (const [key, value] of ready) { tasks.delete(key); value.fn(); }
    },
    drain() { for (let i = 0; tasks.size; i++) { assert.ok(i < 10000); this.tick(250); } },
    get pending() { return tasks.size; },
  };
}

test("language loading validates options, isolates profiles and caches both registered languages", async () => {
  const { loadLanguage } = await service();
  const a = await loadLanguage("tex");
  assert.equal(await loadLanguage("tex", { texProfile: "standard" }), a);
  const options = { texProfile: "internal" };
  const b = await loadLanguage("tex", options);
  options.texProfile = "expl3";
  assert.notEqual(a, b);
  assert.equal(await loadLanguage("tex", { texProfile: "internal" }), b);
  const text = "\\foo@bar";
  assert.equal(a.language.parser.parse(text).topNode.firstChild.to, 4);
  assert.equal(b.language.parser.parse(text).topNode.firstChild.to, text.length);
  const { TreeFragment } = await import("@lezer/common");
  const larger = "{\\foo@bar} ".repeat(500);
  const reused = b.language.parser.parse(larger, TreeFragment.addTree(a.language.parser.parse(larger)));
  const full = b.language.parser.parse(larger);
  const nodes = tree => { const out = []; tree.iterate({ enter: node => out.push([node.name, node.from, node.to]) }); return out; };
  assert.deepEqual(nodes(reused), nodes(full), "profile changes must invalidate incompatible fragments");
  const { highlightTree } = await import("@lezer/highlight");
  const { roleHighlighter } = await import("../public/iris-syntax-style.mjs");
  const roles = tree => { const out = []; highlightTree(tree, roleHighlighter, (from, to, role) => out.push([from, to, role])); return out; };
  assert.deepEqual(roles(reused), roles(full));
  assert.deepEqual(b.summarize(reused, doc(larger)), b.summarize(full, doc(larger)));
  assert.equal((await loadLanguage("ly")).kind, "ly");
  assert.equal(await loadLanguage("ly"), await loadLanguage("ly", { initialNoteLanguage: "nederlands" }));
  for (const [kind, opts] of [["ly", { texProfile: "standard" }], ["ly", { initialNoteLanguage: null }], ["other", {}], ["tex", { typo: 1 }], ["tex", { texProfile: "invalid" }], ["tex", { texProfile: null }], ["tex", { initialNoteLanguage: "italiano" }], ["tex", null], ["tex", new Map()], ["tex", { [Symbol("option")]: 1 }]]) {
    await assert.rejects(loadLanguage(kind, opts));
  }
});

test("LilyPond shares guarded startup, unfiltered growth, unavailable distinction and recovery", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { ensureSyntaxTree } = await import("@codemirror/language");
  const { loadLanguage, analyze, MAX_ANALYSIS_LENGTH } = await service();
  const { createLanguageState, createGuardedLanguage } = await stateService();
  const { Tree } = await import("@lezer/common");
  const { rolesFor, analysisRolesFor } = require("./helpers/language-fixtures.cjs");
  const a = await loadLanguage("ly"), scheduler = clock(), seen = [];
  const client = createLanguageState(a, value => seen.push(value), scheduler);
  let state = EditorState.create({ doc: '\\score { c4 }', extensions: client.extension });
  ensureSyntaxTree(state, state.doc.length, 1000); client.read(state); scheduler.drain();
  assert.deepEqual(client.read(state).outline.map(x => x.title), ["Score 1"]);
  const original = a.language.parser.startParse;
  a.language.parser.startParse = () => { throw new Error("Oversized LY reached LR"); };
  try {
    const text = "x".repeat(MAX_ANALYSIS_LENGTH + 1);
    const huge = EditorState.create({ doc: text, extensions: [createGuardedLanguage(a)] });
    assert.equal(ensureSyntaxTree(huge, huge.doc.length, 5).type.isTop, false);
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: text }, filter: false }).state;
    assert.equal(client.read(state).status, "unavailable");
    assert.equal(client.contextAt(state, 1).mode, "unknown");
    const result = await analyze("ly", { length: text.length, sliceString() { throw new Error("Oversized read"); } });
    assert.equal(result.tree, Tree.empty); assert.equal(result.limitReason, "source-too-large");
    assert.equal(await rolesFor("ly", text), null);
    assert.equal((await analysisRolesFor("ly", text)).status, "unavailable");
  } finally { a.language.parser.startParse = original; }
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: '😀\r\n\\lyricmode { do }\n\\score { c4 }' } }).state;
  client.update(state); ensureSyntaxTree(state, state.doc.length, 1000); scheduler.drain();
  assert.equal(client.read(state).status, "ready");
  assert.deepEqual(client.read(state).outline.map(x => x.title), ["\\lyricmode", "Score 1"]);
  client.dispose(); assert.equal(scheduler.pending, 0);
  const parser = a.language.parser, parse = parser.parse;
  parser.parse = () => { throw new Error("Synchronous batch LY parse"); };
  try {
    const result = await analyze("ly", '😀\r\n\\score { c4 }');
    assert.equal(result.data.outline[0].offset, 4);
    const controller = new AbortController(), pending = analyze("ly", '{ c4 } '.repeat(100000), {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(pending, { name: "AbortError" });
  } finally { parser.parse = parse; }
});

test("shared UTF-16 policy keeps the normal corpus supported and oversized results explicitly unavailable", async () => {
  const { analyze, loadLanguage, analysisPolicy, MAX_ANALYSIS_LENGTH } = await service();
  const { Tree } = await import("@lezer/common");
  const { generateFixture } = require("./helpers/language-fixtures.cjs");
  assert.equal(MAX_ANALYSIS_LENGTH, 1048576);
  assert.deepEqual(analysisPolicy(1048576), { mode: "full", length: 1048576, maxLength: 1048576, reason: null });
  assert.equal(analysisPolicy(generateFixture("tex", 1048576).source.length).mode, "full");
  assert.equal(analysisPolicy(generateFixture("ly", 1048576).source.length).mode, "full");
  assert.equal(analysisPolicy(1048577).reason, "source-too-large");
  assert.ok(Object.isFrozen(analysisPolicy(1048577)));
  assert.deepEqual(JSON.parse(JSON.stringify(analysisPolicy(5 * 1048576))), analysisPolicy(5 * 1048576));
  for (const length of [-1, 0.5, Infinity, "1", NaN]) assert.throws(() => analysisPolicy(length));
  const a = await loadLanguage("tex"), original = a.language.parser.startParse;
  a.language.parser.startParse = () => { throw new Error("Oversized source reached LR"); };
  try {
    const source = { length: 5 * 1048576, sliceString() { throw new Error("Oversized source read"); } };
    const result = await analyze("tex", source);
    assert.equal(result.doc, source);
    assert.equal(result.tree, Tree.empty);
    assert.equal(result.status, "unavailable");
    assert.equal(result.limitReason, "source-too-large");
    assert.equal(result.parsedTo, 0);
    assert.deepEqual(result.data, { outline: [], regions: [], symbols: [], references: [], includes: [] });
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.data.outline));
    await assert.rejects(analyze("tex", source, {}, { signal: AbortSignal.abort() }), { name: "AbortError" });
    await assert.rejects(analyze("tex", source, { typo: true }));
  } finally { a.language.parser.startParse = original; }
  const empty = await analyze("tex", "");
  assert.equal(empty.status, "ready");
  assert.equal(empty.limitReason, null);
  assert.notEqual(empty.tree, Tree.empty, "an empty parsed document differs from unavailable syntax");
  assert.equal((await analyze("tex", "x".repeat(1048576))).status, "ready", "inclusive boundary remains supported");
});

test("state size guard prevents LR startup, cancels old work, and restores syntax after shrinking", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const { loadLanguage, MAX_ANALYSIS_LENGTH } = await service();
  const a = await loadLanguage("tex"), scheduler = clock(), seen = [];
  const client = (await stateService()).createLanguageState(a, value => seen.push(value), scheduler);
  let state = EditorState.create({ doc: "\\section{Before}", extensions: client.extension });
  client.read(state);
  const parser = a.language.parser, original = parser.startParse;
  parser.startParse = () => { throw new Error("Oversized state reached LR"); };
  try {
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: "x".repeat(MAX_ANALYSIS_LENGTH + 1) }, filter: false }).state;
    const limited = client.read(state);
    assert.equal(limited.status, "unavailable");
    assert.equal(limited.limitReason, "source-too-large");
    assert.equal(limited.parsedTo, 0);
    assert.equal(limited.outline.length, 0);
    assert.equal(client.contextAt(state, 1).mode, "unknown");
    assert.equal(client.contextAt(state, state.doc.length).mode, "unknown");
    const skipped = ensureSyntaxTree(state, state.doc.length, 5);
    assert.equal(skipped.type.isTop, false, "CodeMirror may return a neutral skipping placeholder");
    assert.equal(syntaxTreeAvailable(state, state.doc.length), false);
    const second = (await stateService()).createLanguageState(a, () => {}, scheduler);
    const huge = EditorState.create({ doc: "x".repeat(5 * 1048576), extensions: second.extension });
    assert.equal(second.read(huge).limitReason, "source-too-large");
    second.dispose();
  } finally { parser.startParse = original; }
  scheduler.drain();
  assert.equal(seen.length, 1, "obsolete supported job never notifies");
  assert.equal(seen[0].status, "unavailable");
  const limitedRevision = client.read(state).revision;
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: "\\section{After}" }, effects: client.identityEffect.of({ generation: 1 }) }).state;
  client.update(state); scheduler.drain();
  assert.equal(client.read(state).status, "ready");
  assert.equal(client.read(state).limitReason, null);
  assert.equal(client.read(state).revision, limitedRevision + 1);
  assert.equal(client.read(state).outline[0].title, "After");
  client.dispose();
  assert.equal(scheduler.pending, 0);
});

test("task scheduler yields, cancels queued work and disposes resources", async () => {
  const { createTaskScheduler } = await import("../public/iris-language-tasks.mjs");
  const tasks = createTaskScheduler(), seen = [];
  const cancelled = tasks.schedule(() => seen.push("cancelled"), 0);
  tasks.cancel(cancelled);
  const done = new Promise(resolve => tasks.schedule(() => { seen.push("ran"); resolve(); }, 0));
  assert.deepEqual(seen, [], "yield is a task, not synchronous execution");
  await done;
  tasks.schedule(() => seen.push("disposed"), 0);
  tasks.schedule(() => seen.push("timer"), 10);
  tasks.dispose(); tasks.dispose();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(seen, ["ran"]);
  assert.throws(() => tasks.schedule(() => {}, 0), /disposed/i);
  // A leaked referenced MessagePort would keep this actual Node process alive.
  const moduleURL = pathToFileURL(path.resolve(__dirname, "../public/iris-language-service.mjs")).href;
  const schedulerURL = pathToFileURL(path.resolve(__dirname, "../public/iris-language-tasks.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {runCooperatively} from ${JSON.stringify(moduleURL)};
    import {createTaskScheduler} from ${JSON.stringify(schedulerURL)};
    for (let i = 0; i < 8; i++) {
      const c = new AbortController();
      const p = runCooperatively((function*(){try {for (;;) yield;} finally {}})(), {signal:c.signal});
      setTimeout(() => c.abort(), 0);
      await p.catch(e => {if (e.name !== 'AbortError') throw e;});
      const s = createTaskScheduler();
      await new Promise(resolve => s.schedule(resolve, 0));
      s.dispose();
    }
    // Exercise real browser-style ports as well as Node's fair immediate path.
    globalThis.setImmediate = undefined;
    for (let i = 0; i < 8; i++) {
      const s = createTaskScheduler();
      await new Promise(resolve => s.schedule(resolve, 0));
      s.schedule(() => {throw new Error('disposed port task');}, 0);
      s.dispose();
    }
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test("cooperative runner closes its iterator on abort and does not monopolize other tasks", async () => {
  const { runCooperatively } = await service();
  const controller = new AbortController();
  let finished = false;
  function* endless() { try { for (;;) yield; } finally { finished = true; } }
  const pending = runCooperatively(endless(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(finished, true);
});

test("analysis uses cooperative parsing/traversal, preserves Source offsets and aborts during work", async () => {
  const { analyze, loadLanguage } = await service();
  const text = "😀\r\n\\section{Title}\r\n{body}";
  const result = await analyze("tex", doc(text));
  assert.equal(result.doc.sliceString(0, text.length), text);
  assert.equal(result.data.outline[0].offset, 4);
  assert.deepEqual(result.data, (await loadLanguage("tex")).summarize(result.tree, result.doc));
  const controller = new AbortController();
  const pending = analyze("tex", "{word} ".repeat(100000), {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(analyze("tex", "", {}, { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("batch analysis never calls the full parse API; cooperative summaries can be aborted", async () => {
  const { loadLanguage, analyze, runCooperatively } = await service();
  const adapter = await loadLanguage("tex"), parser = adapter.language.parser;
  const original = parser.parse;
  parser.parse = () => { throw new Error("Synchronous full parse on service path"); };
  try { assert.equal((await analyze("tex", "\\section{Test}")).data.outline[0].title, "Test"); }
  finally { delete parser.parse; }
  const text = "{x}".repeat(100000), source = doc(text), tree = original.call(parser, text);
  const controller = new AbortController();
  let visited = 0;
  function* work() {
    const steps = adapter.summarySteps(tree, source);
    for (;;) { const step = steps.next(); if (step.done) return step.value; visited++; yield; }
  }
  const pending = runCooperatively(work(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(visited > 0 && visited < 800002, "abort during real tree traversal");
});

test("real EditorState snapshots debounce, are immutable, and invalidate on revisions and identity replacement", async () => {
  const { EditorState } = await import("@codemirror/state");
  const a = await (await service()).loadLanguage("tex");
  const { createLanguageState } = await stateService();
  const scheduler = clock(), seen = [];
  const client = createLanguageState(a, snapshot => seen.push(snapshot), scheduler);
  let state = EditorState.create({ doc: "😀\r\n\\section{First}", extensions: [EditorState.lineSeparator.of("\n"), client.extension] });
  assert.equal(state.doc.length, 19);
  assert.equal(client.read(state).outline.length, 0);
  scheduler.tick(249);
  assert.equal(seen.length, 0);
  scheduler.tick(1); scheduler.drain();
  const first = client.read(state);
  const historical = state;
  assert.equal(first.status, "ready");
  assert.equal(first.outline[0].offset, 4);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.outline[0]));
  assert.throws(() => first.outline.push({}));
  state = state.update({ changes: { from: 13, to: 18, insert: "Next" } }).state;
  assert.equal(client.read(state).revision, first.revision + 1);
  assert.equal(client.read(state).outline.length, 0, "no stale summaries after edit");
  state = state.update({ effects: client.identityEffect.of({ generation: 7 }) }).state;
  assert.equal(client.read(state).generation, 7);
  scheduler.drain();
  assert.equal(client.read(historical).outline.length, 0, "historical reads cannot reinstall old data");
  assert.equal(scheduler.pending, 0);
  assert.equal(seen.at(-1).generation, 7);
  assert.equal(seen.at(-1).outline[0].title, "Next");
  assert.equal(seen.length, 2, "replaced job must not notify");
  assert.throws(() => state.update({ effects: client.identityEffect.of({ generation: 6 }) }).state);
  client.dispose();
  assert.equal(scheduler.pending, 0);
  assert.equal(client.read(state).status, "unavailable");
});

test("partial trees never masquerade as complete and parse-only transactions publish new trees", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const a = await (await service()).loadLanguage("tex");
  const scheduler = clock(), seen = [];
  const client = (await stateService()).createLanguageState(a, value => seen.push(value), scheduler);
  const text = "\\section{Head}\n" + "{plain} ".repeat(100000) + "\\section{Tail}";
  let state = EditorState.create({ doc: text, extensions: client.extension });
  assert.equal(syntaxTreeAvailable(state, text.length), false);
  const old = syntaxTree(state);
  const context = client.contextAt(state, text.length - 3);
  assert.equal(context.mode, "unknown");
  assert.equal(context.certainty, "unknown");
  client.read(state); scheduler.drain();
  const partial = client.read(state);
  assert.equal(partial.status, "partial");
  assert.ok(partial.parsedTo < text.length);
  assert.deepEqual(partial.outline.map(x => x.title), ["Head"]);
  assert.ok(ensureSyntaxTree(state, text.length, 10000));
  const transaction = state.update({});
  assert.equal(transaction.docChanged, false);
  state = transaction.state;
  assert.notEqual(syntaxTree(state), old);
  client.read(state); scheduler.drain();
  const complete = client.read(state);
  assert.equal(complete.revision, partial.revision);
  assert.equal(complete.status, "ready");
  assert.equal(complete.parsedTo, text.length);
  assert.deepEqual(complete.outline.map(x => x.title), ["Head", "Tail"]);
  assert.equal(client.contextAt(state, text.length - 3).mode, "text");
  assert.equal(seen.length, 2);
  client.dispose();
});

test("public contextAt publishes a matching tree/coverage snapshot before and after a parse-only transaction", { timeout: 5000 }, async t => {
  const { EditorState } = await import("@codemirror/state");
  const { syntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const a = await (await service()).loadLanguage("tex");
  const seen = [];
  let notify;
  const published = new Promise(resolve => { notify = resolve; });
  const client = (await stateService()).createLanguageState(a, value => { seen.push(value); notify(value); });
  t.after(() => client.dispose());
  const text = "\\section{Head}\n" + "x".repeat(4000) + "\\section{Tail}";
  let state = EditorState.create({ doc: text, extensions: client.extension });
  const maintained = syntaxTree(state);
  assert.ok(maintained.length < state.doc.length);
  assert.equal(syntaxTreeAvailable(state), false);
  assert.equal(client.contextAt(state, text.length).mode, "text");
  assert.equal(syntaxTreeAvailable(state), true, "public query advanced the mutable parse context");
  assert.equal(syntaxTree(state), maintained, "immutable state still exposes the earlier tree");
  const callback = await published;
  assert.equal(callback.status, "ready");
  assert.equal(callback.parsedTo, text.length, "ready must describe the same full tree as the summary");
  assert.deepEqual(callback.outline.map(item => item.title), ["Head", "Tail"]);
  assert.deepEqual(client.read(state), callback, "read must not revert to the old partial tree");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(client.read(state), callback);
  assert.equal(seen.length, 1, "historical maintained tree must not schedule a rollback");
  const transaction = state.update({});
  assert.equal(transaction.docChanged, false);
  state = transaction.state;
  assert.notEqual(syntaxTree(state), maintained);
  const read = client.read(state);
  assert.equal(read.revision, callback.revision);
  assert.equal(read.generation, callback.generation);
  assert.equal(read.status, "ready");
  assert.equal(read.parsedTo, text.length);
  assert.deepEqual(read.outline.map(item => item.title), ["Head", "Tail"]);
  assert.equal(seen.length, 1, "the now-published ensured tree does not require a duplicate job");
});

test("state queries share adjacent-start, line-break and open-EOF ownership", async () => {
  const { EditorState } = await import("@codemirror/state");
  const a = await (await service()).loadLanguage("tex");
  const cases = [
    ["\\verb|a|\\verb+b+", 8, "literal", 8, "exact"],
    ["$a$\\verb+b+", 3, "literal", 3, "exact"],
    ["\\verb|x", 7, "literal", 0, "recovered"],
    ["$x", 2, "math", 0, "recovered"],
  ];
  for (const eol of ["\r", "\n", "\r\n"]) for (const suffix of ["", "\\section{After}"]) cases.push(["\\verb|x" + eol + suffix, 7 + eol.length, "text", 7 + eol.length, "exact"]);
  for (const [text, pos, mode, from, certainty] of cases) {
    const scheduler = clock();
    const client = (await stateService()).createLanguageState(a, () => {}, scheduler);
    try {
      const state = EditorState.create({ doc: text, extensions: [EditorState.lineSeparator.of("\n"), client.extension] });
      for (const bias of [undefined, -1, 1]) {
        const context = client.contextAt(state, pos, bias);
        assert.deepEqual([context.mode, context.from, context.certainty], [mode, from, certainty], JSON.stringify(text));
      }
      scheduler.drain();
      const snapshot = client.read(state);
      assert.equal(snapshot.status, "ready");
      if (text.startsWith("\\verb|x") && pos > 7) {
        assert.equal(snapshot.regions[0].openEnded, false);
        assert.equal(snapshot.regions[0].certainty, "recovered");
      }
    } finally { client.dispose(); }
  }
});

test("summary chunks yield; disposal/replacement rejects captured obsolete work", async () => {
  const { EditorState } = await import("@codemirror/state");
  const a = await (await service()).loadLanguage("tex");
  const scheduler = clock(), seen = [];
  // Advance the work clock at each sample so one scheduled turn cannot traverse everything.
  let workTime = 0;
  const client = (await stateService()).createLanguageState(a, value => seen.push(value), { ...scheduler, now: () => ++workTime });
  let state = EditorState.create({ doc: "{x}".repeat(500), extensions: client.extension });
  client.read(state); scheduler.tick(250);
  assert.equal(seen.length, 0);
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: "\\section{New}" }, effects: client.identityEffect.of({ generation: 1 }) }).state;
  client.read(state); scheduler.drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outline[0].title, "New");
  client.read(state.update({ changes: { from: 0, insert: "{x}" } }).state);
  client.dispose(); scheduler.drain();
  assert.equal(seen.length, 1);
});

test("unavailable language tree returns unknown without parsing another source", async () => {
  const { EditorState } = await import("@codemirror/state");
  const a = await (await service()).loadLanguage("tex");
  const client = (await stateService()).createLanguageState(a, () => {});
  const state = EditorState.create({ doc: "$x$" });
  assert.equal(client.contextAt(state, 1).mode, "unknown");
  assert.equal(client.read(state).status, "unavailable");
  client.dispose();
});
