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

test("summary publication gives consumers a separate owned application turn", async t => {
  const { EditorState } = await import("@codemirror/state");
  const adapter = await (await service()).loadLanguage("tex"), scheduler = clock();
  let work = 0, maximum = 0, notifications = 0;
  const owner = (await stateService()).createLanguageState({ ...adapter,
    *summarySteps(tree, doc) {
      const data = yield* adapter.summarySteps(tree, doc);
      for (let i = 0; i < 6; i++) { work++; yield; }
      return data;
    },
  }, () => { work += 4; notifications++; }, { ...scheduler, now: () => work,
    schedule(fn, delay) { return scheduler.schedule(() => { const before = work; fn(); maximum = Math.max(maximum, work - before); }, delay); },
  });
  t.after(() => owner.dispose());
  const state = EditorState.create({ doc: "\\section{Publication}", extensions: owner.extension });
  owner.update(state); scheduler.drain();
  assert.equal(owner.read(state).status, "ready"); assert.equal(notifications, 1);
  assert.ok(maximum <= 8, `visitor plus consumer cannot spend ${maximum} ms in one application turn`);
});

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
    client.update(state);
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
    client.update(state);
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
  client.update(state);
  assert.equal(client.read(state).revision, first.revision + 1);
  assert.equal(client.read(state).outline.length, 0, "no stale summaries after edit");
  state = state.update({ effects: client.identityEffect.of({ generation: 7 }) }).state;
  client.update(state);
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
  client.read(state); scheduler.tick(250); scheduler.tick(0); // separate consumer publication, same debounce time
  const partial = client.read(state);
  assert.equal(partial.status, "partial");
  assert.ok(partial.parsedTo < text.length);
  assert.deepEqual(partial.outline.map(x => x.title), ["Head"]);
  scheduler.drain();
  assert.equal(syntaxTreeAvailable(state, text.length), true, "owned progress continues after the partial publication");
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
  const { syntaxTreeAvailable } = await import("@codemirror/language");
  const a = await (await service()).loadLanguage("tex");
  const scheduler = clock(), seen = [];
  // Advance the work clock at each sample so one scheduled turn cannot traverse everything.
  let workTime = 0;
  const client = (await stateService()).createLanguageState(a, value => seen.push(value), { ...scheduler, now: () => ++workTime });
  let state = EditorState.create({ doc: "{x}".repeat(500), extensions: client.extension });
  client.read(state);
  // Owned LR publication is asynchronous when the initial slice is exhausted.
  // Establish a real full tree before testing summary traversal's own yielding.
  for (let turns = 0; !syntaxTreeAvailable(state); turns++) { assert.ok(turns < 1000); scheduler.tick(0); }
  scheduler.tick(250);
  assert.equal(seen.length, 0);
  state = state.update({ changes: { from: 0, to: state.doc.length, insert: "\\section{New}" }, effects: client.identityEffect.of({ generation: 1 }) }).state;
  client.update(state); scheduler.drain();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outline[0].title, "New");
  client.update(state.update({ changes: { from: 0, insert: "{x}" } }).state);
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

test("HP07 owners start at the editor revision and historical reads cannot supersede committed jobs", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { createLanguageState } = await stateService();
  const scheduler = clock(), seen = [];
  const owner = createLanguageState(await (await service()).loadLanguage("tex"), s => seen.push(s),
    { ...scheduler, generation: 20, revision: 73 });
  const first = EditorState.create({ doc: "\\section{A}", extensions: owner.extension });
  owner.update(first);
  assert.equal(owner.read(first).revision, 73);
  const current = first.update({ changes: { from: 9, to: 10, insert: "B" } }).state;
  owner.update(current);
  owner.read(first);
  scheduler.drain();
  assert.deepEqual(seen.map(s => [s.revision, s.generation, s.outline[0].title]), [[74, 20, "B"]]);
  owner.dispose();
  assert.equal(scheduler.pending, 0);
});

test("HP07 speculative headless reads cannot adopt an uncommitted future document", async () => {
  const { EditorState } = await import("@codemirror/state");
  const scheduler = clock(), seen = [];
  const owner = (await stateService()).createLanguageState(await (await service()).loadLanguage("tex"), s => seen.push(s), scheduler);
  const current = EditorState.create({ doc: "\\section{Current}", extensions: owner.extension });
  owner.update(current);
  const temporary = current.update({ changes: { from: 9, to: 16, insert: "Temporary" } }).state;
  owner.read(temporary); owner.contextAt(temporary, temporary.doc.length);
  scheduler.drain();
  assert.deepEqual(seen.map(s => s.outline[0].title), ["Current"]);
  assert.equal(owner.read(current).status, "ready");
  owner.dispose(); assert.equal(scheduler.pending, 0);
});

test("HP07 R1 owned prefix/full LR progress uses bounded turns and cancels on replacement", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { ParseContext, syntaxTreeAvailable } = await import("@codemirror/language");
  const adapter = await (await service()).loadLanguage("tex"), scheduler = clock(), seen = [], contexts = new Set();
  const parser = adapter.language.parser, start = parser.startParse;
  let time = 0, advances = 0, maximum = 0, turns = 0, starts = 0;
  parser.startParse = function (...args) {
    starts++;
    contexts.add(ParseContext.get());
    const parse = start.apply(this, args), advance = parse.advance.bind(parse);
    parse.advance = () => { advances++; time++; return advance(); };
    return parse;
  };
  const owner = (await stateService()).createLanguageState(adapter, s => seen.push(s), { ...scheduler,
    parseNow: () => time,
    schedule(fn, delay) { return scheduler.schedule(() => { advances = 0; turns++; fn(); maximum = Math.max(maximum, advances); }, delay); } });
  t.after(() => { owner.dispose(); parser.startParse = start; });
  const source = "\\section{Head}\n" + "x".repeat(216000) + "\\section{Tail}";
  const first = EditorState.create({ doc: source, extensions: owner.extension });
  owner.update(first); scheduler.drain();
  assert.equal(owner.read(first).status, "ready");
  assert.equal(syntaxTreeAvailable(first, first.doc.length), true);
  assert.deepEqual(seen.at(-1).outline.map(x => x.title), ["Head", "Tail"]);
  assert.equal(starts, 2, "one real prefix then one full incremental continuation, not a restart per turn");
  assert.ok(contexts.has(null), "background LR advances outside CM's unbounded work slice");
  assert.ok(turns > 2 && maximum <= 6, `progress yields: ${turns} turns, ${maximum} advances/turn under an advance-driven clock`);
  t.diagnostic(`${turns} scheduled turns; maximum ${maximum} parse advances/turn with 1 ms charged per advance; ${starts} sequential LR passes`);
  const pending = first.update({ changes: { from: 0, to: first.doc.length, insert: source + " " } }).state;
  owner.update(pending); scheduler.tick(250);
  const current = pending.update({ changes: { from: 0, to: pending.doc.length, insert: "\\section{Replacement}" } }).state;
  owner.update(current); owner.read(first); scheduler.drain();
  assert.deepEqual(seen.at(-1).outline.map(x => x.title), ["Replacement"]);
  const count = seen.length;
  owner.update(current.update({ changes: { from: 0, insert: source } }).state);
  owner.dispose(); scheduler.drain();
  assert.equal(seen.length, count); assert.equal(scheduler.pending, 0);
});

test("HP08 parse-only progress shares the revision's debounce deadline", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const scheduler = clock(), seen = [];
  const owner = (await stateService()).createLanguageState(await (await service()).loadLanguage("tex"), s => seen.push(s), scheduler);
  t.after(() => owner.dispose());
  let state = EditorState.create({ doc: "\\section{Head}\n" + "x".repeat(4000) + "\\section{Tail}", extensions: owner.extension });
  assert.equal(syntaxTreeAvailable(state), false);
  owner.update(state);
  scheduler.tick(200);
  ensureSyntaxTree(state, state.doc.length, 1000);
  state = state.update({}).state;
  owner.update(state);
  scheduler.tick(49);
  assert.equal(seen.length, 0, "retain the approved 250 ms debounce");
  scheduler.tick(1);
  for (let turn = 0; turn < 4; turn++) scheduler.tick(0); // parser notification, visitor, consumer; no extra debounce time
  assert.equal(seen.at(-1)?.status, "ready", "parser progress must not restart another 250 ms wait");
  assert.deepEqual(seen.at(-1).outline.map(item => item.title), ["Head", "Tail"]);
  state = state.update({ changes: { from: 9, to: 13, insert: "Next" } }).state;
  owner.update(state);
  scheduler.tick(249);
  assert.equal(seen.length, 1, "a real edit establishes a new deadline");
  scheduler.tick(1);
  for (let turn = 0; turn < 4; turn++) scheduler.tick(0);
  assert.equal(seen.at(-1).outline[0].title, "Next");
});

test("HP08 owned publication keeps CM work slices cheap and reports only real prefix coverage", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const { generateFixture } = require("./helpers/language-fixtures.cjs");
  const adapter = await (await service()).loadLanguage("tex"), scheduler = clock(), seen = [];
  const original = adapter.language.parser.startParse;
  let inCMRequest = false, synchronousAdvances = 0;
  adapter.language.parser.startParse = function (...args) {
    const partial = original.apply(this, args), advance = partial.advance.bind(partial);
    partial.advance = () => { if (inCMRequest) synchronousAdvances++; return advance(); };
    return partial;
  };
  const owner = (await stateService()).createLanguageState(adapter, value => seen.push(value), scheduler);
  t.after(() => { owner.dispose(); adapter.language.parser.startParse = original; });
  const source = generateFixture("tex", 128 * 1024).source;
  const state = EditorState.create({ doc: source, extensions: owner.extension });
  owner.update(state);
  inCMRequest = true;
  try { ensureSyntaxTree(state, state.doc.length, 100); }
  finally { inCMRequest = false; }
  assert.equal(synchronousAdvances, 0, "CM's 100 ms slice must only consume cached publication, not raw LR work");
  assert.equal(syntaxTreeAvailable(state, state.doc.length), false, "a pending suffix is not EOF coverage");
  assert.equal(owner.read(state).status, "partial");
  scheduler.drain();
  assert.equal(syntaxTreeAvailable(state, state.doc.length), true);
  const tree = ensureSyntaxTree(state, state.doc.length, 0), fresh = adapter.language.parser.parse(source);
  const nodes = tree => { const out = []; tree.iterate({ enter: n => out.push([n.name, n.from, n.to]) }); return out; };
  assert.deepEqual(nodes(tree), nodes(fresh), "publication installs proper LR nodes and absolute UTF-16 coordinates");
  assert.deepEqual(seen.at(-1).regions, adapter.summarize(fresh, state.doc).regions);
});

for (const kind of ["tex", "ly"]) test(`HP08 owned ${kind} publications preserve actual unchanged Tree identity`, async t => {
  const { EditorState } = await import("@codemirror/state");
  const { ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const { Tree } = await import("@lezer/common");
  const scheduler = clock(), adapter = await (await service()).loadLanguage(kind);
  const owner = (await stateService()).createLanguageState(adapter, () => {}, scheduler);
  t.after(() => owner.dispose());
  const source = "% " + "header ".repeat(80) + "\n{" + (kind === "tex" ? "text $a+1$ " : "c4 d8 e8 ").repeat(5000) + "}\n";
  let state = EditorState.create({ doc: source, extensions: owner.extension });
  owner.update(state); scheduler.drain();
  const trees = root => {
    const values = new Set(), pending = [root];
    while (pending.length) { const n = pending.pop(); if (n instanceof Tree) { values.add(n); pending.push(...n.children); } }
    return values;
  };
  const before = trees(ensureSyntaxTree(state, state.doc.length, 0));
  state = state.update({ changes: { from: 2, insert: "x" } }).state;
  owner.update(state); scheduler.drain();
  assert.equal(syntaxTreeAvailable(state), true);
  const after = ensureSyntaxTree(state, state.doc.length, 0);
  assert.ok([...trees(after)].some(n => n.type.name === "Group" && n.length > 40000 && before.has(n)), "the identical large Group survives both prefix and full publication");
  assert.deepEqual(adapter.summarize(after, state.doc), adapter.summarize(adapter.language.parser.parse(state.doc.toString()), state.doc));
});

test("HP08 owned raw work and queued notifications retire on replacement and disposal", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const adapter = await (await service()).loadLanguage("tex"), scheduler = clock(), seen = [], queued = [];
  const start = adapter.language.parser.startParse, counts = new Map();
  adapter.language.parser.startParse = function (input, ...args) {
    const partial = start.call(this, input, ...args), advance = partial.advance.bind(partial);
    partial.advance = () => { counts.set(input.length, (counts.get(input.length) || 0) + 1); return advance(); };
    return partial;
  };
  const owner = (await stateService()).createLanguageState(adapter, s => seen.push(s), { ...scheduler,
    schedule(fn, delay) { queued.push(fn); return scheduler.schedule(fn, delay); } });
  t.after(() => { owner.dispose(); adapter.language.parser.startParse = start; });
  const source = "\\section{Old}\n" + "{x} ".repeat(50000);
  const old = EditorState.create({ doc: source, extensions: owner.extension });
  owner.update(old); scheduler.tick(0);
  const oldAdvances = counts.get(source.length);
  let current = old.update({ changes: { from: 0, to: old.doc.length, insert: "\\section{New}" }, effects: owner.identityEffect.of({ generation: 7 }) }).state;
  owner.update(current); scheduler.drain();
  assert.equal(counts.get(source.length), oldAdvances, "the retired LR continuation does no further work");
  assert.deepEqual(seen.map(s => [s.generation, s.outline[0]?.title]), [[7, "New"]]);
  assert.equal(syntaxTreeAvailable(current), true);
  current = current.update({ changes: { from: 0, to: current.doc.length, insert: source + " " } }).state;
  owner.update(current);
  owner.dispose();
  const advances = [...counts.values()].reduce((a,b) => a + b, 0), publications = seen.length;
  for (const callback of queued) callback();
  ensureSyntaxTree(current, current.doc.length, 100);
  scheduler.drain();
  assert.equal([...counts.values()].reduce((a,b) => a + b, 0), advances);
  assert.equal(seen.length, publications);
  assert.equal(scheduler.pending, 0);
});

test("HP08 a short query completing raw work cannot leave full publication stuck at its query stop", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { syntaxTreeAvailable } = await import("@codemirror/language");
  const scheduler = clock(), seen = [];
  let time = 0, fast = false;
  const owner = (await stateService()).createLanguageState(await (await service()).loadLanguage("tex"), s => seen.push(s),
    { ...scheduler, parseNow: () => fast ? time : time += 10 });
  t.after(() => owner.dispose());
  const state = EditorState.create({ doc: "\\verb|x\r\n\\section{After}", extensions: [EditorState.lineSeparator.of("\n"), owner.extension] });
  assert.equal(syntaxTreeAvailable(state), false, "initial bounded slice is deliberately incomplete");
  fast = true;
  assert.equal(owner.contextAt(state, 9).mode, "text");
  scheduler.drain();
  assert.equal(owner.read(state).status, "ready");
  assert.equal(syntaxTreeAvailable(state), true);
  assert.deepEqual(seen.at(-1).outline.map(n => n.title), ["After"]);
  assert.equal(scheduler.pending, 0);
});

test("HP08 the initial slice publishes its real consumed prefix rather than clearing known head syntax", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { syntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const scheduler = clock();
  let time = 0;
  const owner = (await stateService()).createLanguageState(await (await service()).loadLanguage("tex"), () => {},
    { ...scheduler, parseNow: () => time += .5 });
  t.after(() => owner.dispose());
  // Include a full scalar chunk so the stopped prefix exceeds CM's128-unit
  // fragment gap. Smaller fragments may conservatively report no coverage.
  const state = EditorState.create({ doc: "$a$\n" + "x".repeat(30000), extensions: owner.extension });
  assert.equal(syntaxTreeAvailable(state, 3), true, "already consumed math is a real prefix, even if the viewport is incomplete");
  assert.equal(syntaxTree(state).resolveInner(1, 1).name, "MathText");
  assert.equal(syntaxTreeAvailable(state), false);
  assert.ok(syntaxTree(state).length < state.doc.length);
  owner.update(state); scheduler.drain();
  assert.equal(syntaxTreeAvailable(state), true);
  assert.equal(owner.read(state).status, "ready");
});

test("HP08 full continuation yields a paint opportunity after prefix publication and cancels its frame", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { Language, ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const { createCooperativeParser } = await import("../public/iris-language-parser.mjs");
  const adapter = await (await service()).loadLanguage("tex"), guarded = (await stateService()).createGuardedLanguage(adapter), scheduler = clock();
  const frames = new Map();
  let frameID = 0, state;
  const cooperative = createCooperativeParser(guarded.parser, { ...scheduler,
    now: () => performance.now(), requestFrame: fn => { frames.set(++frameID, fn); return frameID; }, cancelFrame: id => frames.delete(id),
    notify: () => { ensureSyntaxTree(state, state.doc.length, 0); },
  });
  t.after(() => cooperative.dispose());
  const language = new Language(guarded.data, cooperative.parser, [], guarded.name);
  state = EditorState.create({ doc: "x".repeat(20000), extensions: language });
  cooperative.commit(state.doc, 0);
  assert.equal(frames.size, 1);
  assert.equal(scheduler.pending, 1, "only the owned paint-deadline timer is pending");
  scheduler.tick(0);
  assert.equal(syntaxTreeAvailable(state), false, "offscreen LR work waits for the prefix's paint opportunity");
  for (const [id, fn] of frames) { frames.delete(id); fn(); }
  scheduler.drain();
  assert.equal(syntaxTreeAvailable(state), true);
  state = state.update({ changes: { from: 0, insert: " " } }).state;
  cooperative.commit(state.doc, 0);
  assert.equal(frames.size, 1);
  cooperative.dispose();
  assert.equal(frames.size, 0);
  assert.equal(scheduler.pending, 0);
});

test("HP08 a small context query publishes a CM-retainable prefix without waiting for EOF", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { syntaxTreeAvailable } = await import("@codemirror/language");
  const scheduler = clock();
  let time = 0, querying = false;
  const owner = (await stateService()).createLanguageState(await (await service()).loadLanguage("tex"), () => {},
    { ...scheduler, parseNow: () => time += querying ? .02 : 10 });
  t.after(() => owner.dispose());
  const state = EditorState.create({ doc: "\\sec\n" + "hello world\n".repeat(18000) + "\\section{Tail}", extensions: owner.extension });
  querying = true;
  const context = owner.contextAt(state, 4);
  assert.equal(context.mode, "text");
  assert.equal(context.certainty, "exact");
  assert.equal(syntaxTreeAvailable(state, 4), true);
  assert.equal(syntaxTreeAvailable(state), false, "the bounded query must not pretend EOF is ready");
});

test("HP08 an unavailable animation frame cannot strand the owner's EOF continuation", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { Language, ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
  const { createCooperativeParser } = await import("../public/iris-language-parser.mjs");
  const guarded = (await stateService()).createGuardedLanguage(await (await service()).loadLanguage("tex")), scheduler = clock();
  let state, cancelled = 0;
  const cooperative = createCooperativeParser(guarded.parser, { ...scheduler, now: () => performance.now(),
    requestFrame: () => 7, cancelFrame: id => { assert.equal(id, 7); cancelled++; },
    notify: () => ensureSyntaxTree(state, state.doc.length, 0) });
  t.after(() => cooperative.dispose());
  state = EditorState.create({ doc: "x".repeat(20000), extensions: new Language(guarded.data, cooperative.parser) });
  cooperative.commit(state.doc, 0);
  scheduler.drain();
  assert.equal(syntaxTreeAvailable(state), true, "hidden/non-rendering hosts still finish real full analysis");
  assert.equal(cancelled, 1);
});
