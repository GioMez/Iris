const test = require("node:test");
const assert = require("node:assert/strict");
const Completion = require("../public/iris-completion");
const file = (path, content) => ({ type: "file", path, content });
const labels = result => result?.options.map(o => o.label) || [];

async function harness(t, kind = "tex", project = {}) {
  const { EditorState } = await import("@codemirror/state");
  const { CompletionContext, insertCompletionText } = await import("@codemirror/autocomplete");
  const { ensureSyntaxTree } = await import("@codemirror/language");
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createLanguageState } = await import("../public/iris-language-state.mjs");
  const { createSource, createProjectCache } = await import("../public/iris-language-completion.mjs");
  const cache = createProjectCache();
  let owner, current;
  const source = createSource(kind, () => project, {
    cache, contextAt: (state, pos) => owner.contextAt(state, pos),
    snapshot: state => owner.read(state), isCurrent: state => state === current,
  });
  t.after(() => { owner?.dispose(); cache.dispose(); });
  return {
    setProject(next) { project = next; cache.update(next); },
    async query(marked, explicit = false, readonly = false) {
      owner?.dispose();
      const tasks = new Map(); let id = 0;
      owner = createLanguageState(await loadLanguage(kind), () => {}, {
        schedule(fn) { tasks.set(++id, fn); return id; }, cancel: id => tasks.delete(id), now: () => 0,
      });
      const pos = marked.indexOf("¦");
      current = EditorState.create({ doc: marked.replace("¦", ""), selection: { anchor: pos }, extensions: [owner.extension, EditorState.lineSeparator.of("\n"), EditorState.readOnly.of(readonly)] });
      ensureSyntaxTree(current, current.doc.length, 1000); owner.update(current);
      while (tasks.size) { const [id, fn] = tasks.entries().next().value; tasks.delete(id); fn(); }
      return source(new CompletionContext(current, pos, explicit));
    },
    async accept(marked, label, explicit = true) {
      const result = await this.query(marked, explicit);
      const option = result?.options.find(o => o.label === label);
      assert.ok(option, `${marked}: offers ${label}`);
      const view = { get state() { return current; }, dispatch(spec) { current = current.update(spec).state; } };
      if (typeof option.apply === "function") option.apply(view, option, result.from, result.to ?? marked.indexOf("¦"));
      else view.dispatch(insertCompletionText(current, option.apply || label, result.from, result.to ?? marked.indexOf("¦")));
      return current.doc.toString();
    },
  };
}

test("project custom commands normalize names and keep the languages separate", () => {
  assert.deepEqual(Completion.normalizeCustomCommands({ tex: " myMacro\n\\myMacro\n\\missingCommand*\n", ly: ["my-music", "\\my-music"] }), {
    tex: ["\\myMacro", "\\missingCommand*"], ly: ["\\my-music"],
  });
  assert.deepEqual(Completion.normalizeCustomCommands(), { tex: [], ly: [] });
});
test("invalid or oversized custom command lists identify the offending line", () => {
  for (const tex of ["\\valid\n\\bad{argument}", "\\valid\n<img>", ["\\valid", {}]]) {
    assert.throws(() => Completion.normalizeCustomCommands({ tex }), e => e.code === "CUSTOM_COMMANDS_INVALID" && e.kind === "tex" && e.line === 2);
  }
  assert.throws(() => Completion.normalizeCustomCommands({ ly: Array.from({ length: 201 }, (_, i) => `music${i}`) }));
  assert.throws(() => Completion.normalizeCustomCommands({ tex: "a".repeat(81) }));
});
test("commands use the current tree, keep generic builtins and obey explicit whitespace and readonly", async t => {
  const h = await harness(t);
  const r = await h.query("\\sec¦");
  assert.equal(r.from, 0);
  for (const label of ["\\section", "\\alpha", "\\frac", "\\hspace"]) assert.ok(labels(r).includes(label), label);
  assert.ok(labels(await h.query("¦", true)).includes("\\begin"));
  assert.equal(await h.query("ordinary prose¦"), null);
  assert.equal(await h.query("\\sec¦", false, true), null);
});
test("environment roles cover standard, starred and exact project declarations with provenance", async t => {
  const h = await harness(t, "tex", { nodes: [file("macros.sty", "\\newenvironment{customBox}{}{}\n% \\newenvironment{fake}{}{}") ] });
  const r = await h.query("\\begin{it¦}");
  assert.equal(r.from, 7);
  for (const label of ["itemize", "align*", "customBox"]) assert.ok(labels(r).includes(label), label);
  assert.ok(!labels(r).includes("fake"));
  assert.equal(r.options.find(o => o.label === "customBox").detail, "macros.sty");
});
test("reference roles skip comments, literal text, dynamic labels and deferred macro bodies", async t => {
  const h = await harness(t, "tex", { nodes: [file("main.tex", "\\label{intro}"),
    { type: "folder", name: "chapters", children: [file("chapters/part.tex", String.raw`\label{fig:one}
% \label{ignored}
\verb|\label{literal}|
\begin{verbatim}
\label{hidden}
\end{verbatim}
\label{fig:#1}
\newcommand{\later}{\label{deferred}}`)] }] });
  assert.deepEqual(labels(await h.query("\\ref{¦}")).sort(), ["fig:one", "intro"]);
  const r = await h.query("\\cref{intro, fi¦}");
  assert.equal(r.from, 13); assert.deepEqual(labels(r), ["fig:one"]);
  assert.equal(await h.query("\\fakecite{¦}"), null, "unknown names containing cite have no citation role");
});
test("citation signatures preserve bibliography scanning and ignore quoted fake entries", async t => {
  const h = await harness(t, "tex", { nodes: [file("refs.bib", String.raw`% @book{lineFake,}
@comment{ @article{commentFake, title={fake}} }
@string{journal="Journal"}
@preamble{"Text"}
@article{doe2024, title={A {nested} title with @book{fake,} inside}}
@book(smith:2025, title="A quoted @article{fake2,} title")
@book{real, title="Text } @article{fake3,} text"}`)] });
  assert.deepEqual(labels(await h.query("\\cite{¦}")).sort(), ["doe2024", "real", "smith:2025"]);
  const r = await h.query("\\parencite[see][p. 2]{doe2024, sm¦}");
  assert.equal(r.from, 31); assert.deepEqual(labels(r).sort(), ["real", "smith:2025"]);
});
test("project commands include macros and invocable LY variables but respect music-literal scope", async t => {
  const project = { nodes: [file("macros.sty", "\\newcommand{\\my@Macro}[1]{#1}\n\\def\\shortName{}"),
    file("parts.ily", 'melody = { c1 }\nwords = "text"\n% fake = {}\n#(list #{ localOnly = { c4 } #})')],
    customCommands: { tex: ["\\extraMacro"], ly: ["\\extra-music"] } };
  const tex = await harness(t, "tex", project), ly = await harness(t, "ly", project);
  const a = labels(await tex.query("\\¦"));
  for (const label of ["\\my@Macro", "\\shortName", "\\extraMacro"]) assert.ok(a.includes(label), label);
  const b = labels(await ly.query("\\¦"));
  for (const label of ["\\relative", "\\glissando", "\\melody", "\\words", "\\extra-music"]) assert.ok(b.includes(label), label);
  for (const label of ["\\fake", "\\localOnly", "\\extraMacro"]) assert.ok(!b.includes(label), label);
  assert.ok(labels(await ly.query("#(list #{ localHere = { c4 } \\¦ #})")).includes("\\localHere"));
  assert.ok(!labels(await ly.query("#(list #{ localHere = { c4 } #}) \\¦")).includes("\\localHere"));
  const r = await ly.query("\\new St¦ { c4 }");
  assert.equal(r.from, 5); assert.ok(labels(r).includes("Staff"));
  assert.ok(labels(await ly.query("\\new ¦")).includes("Staff"));
});

test("bibliography completion retains long native citation keys", async t => {
  const key = "k".repeat(600), h = await harness(t, "tex", { nodes: [file("refs.bib", `@book{${key}, title={Long}}`)] });
  assert.deepEqual(labels(await h.query("\\cite{¦}")), [key]);
});
test("context completion owns unfinished names and header trivia without escaping comments or completed bodies", async t => {
  const h = await harness(t, "ly");
  for (const marked of ["\\new ¦", "\\context St¦", "\\new % header\n ¦", "\\new ¦Staff { c4 }"]) {
    assert.ok(labels(await h.query(marked)).includes("Staff"), marked);
  }
  for (const marked of ["\\new % ¦", "\\new Staff { c4 } ¦", '#(list #; #{ \\new ¦ #})']) {
    assert.equal(labels(await h.query(marked)).includes("Staff"), false, marked);
  }
});
test("scalar reference completion replaces a comma-containing key as one argument", async t => {
  const h = await harness(t, "tex", { nodes: [file("labels.tex", "\\label{part,a}\n\\label{part}")] });
  const result = await h.query("\\ref{part,¦}");
  assert.equal(result.from, 5);
  assert.deepEqual(labels(result).sort(), ["part", "part,a"]);
});
test("completion declines a truncated key prefix rather than replacing only its tail", async t => {
  const h = await harness(t);
  assert.equal(await h.query("\\ref{" + "k".repeat(1100) + "¦}"), null);
});
test("music-literal local commands remain visible at their own open EOF", async t => {
  const h = await harness(t, "ly");
  assert.ok(labels(await h.query("#{ localHere = { c4 } \\¦")).includes("\\localHere"));
});
test("opaque, unknown, escaped and explicit whitespace contexts suppress commands", async t => {
  for (const kind of ["tex", "ly"]) {
    const h = await harness(t, kind);
    const cases = kind === "tex" ? ["% \\sec¦", "\\\\sec¦", "\\verb|\\sec¦|", "\\begin{verbatim}\n  ¦\n\\end{verbatim}"]
      : ['% \\rel¦', '%{\n\\rel¦\n%}', '\\markup "\\rel¦"', '\\lyricmode "\\rel¦"', '#(list #; #{ \\¦ #})', '#(list #vu8(1)\n  ¦', '\\markup \\unknown {\n  ¦'];
    for (const text of cases) assert.equal(await h.query(text, true), null, text);
  }
});
test("project cache observes edits, deletion and same-path project replacement; active file is always current", async t => {
  const project = { projectId: "A", generation: 1, nodes: [file("main.tex", "\\label{old}"), file("gone.tex", "\\label{removed}")], activePath: "main.tex" };
  const h = await harness(t, "tex", project);
  assert.deepEqual(labels(await h.query("\\label{live}\n\\ref{¦}")).sort(), ["live", "removed"]);
  project.nodes.pop();
  assert.deepEqual(labels(await h.query("\\label{next}\n\\ref{¦}")), ["next"]);
  h.setProject({ projectId: "B", generation: 2, nodes: [file("main.tex", "\\label{newProject}")] });
  assert.deepEqual(labels(await h.query("\\ref{¦}")), ["newProject"]);
});

test("controlled project jobs cannot install old same-path results and unchanged files reuse only summaries", async t => {
  const { createProjectCache } = await import("../public/iris-language-completion.mjs");
  const { analyze } = await import("../public/iris-language-service.mjs");
  const tasks = new Map(), jobs = []; let next = 0;
  const cache = createProjectCache({ schedule(fn) { tasks.set(++next, fn); return next; }, cancel: id => tasks.delete(id),
    analyzeFile(kind, text, options, { signal }) { return new Promise(resolve => jobs.push({ kind, text, options, signal, resolve })); } });
  t.after(() => cache.dispose());
  const tick = () => { const [id, fn] = tasks.entries().next().value; tasks.delete(id); return fn(); };
  const a = { projectId: "A", generation: 1, nodes: [file("same.sty", "\\label{old}")] };
  const old = cache.read(a); const working = tick();
  const b = { projectId: "A", generation: 2, nodes: [file("same.sty", "\\label{new}")] };
  const current = cache.read(b);
  assert.equal(jobs[0].signal.aborted, true);
  jobs[0].resolve(await analyze("tex", jobs[0].text)); await working;
  assert.equal(await old, null);
  const newer = tick();
  assert.equal(jobs[1].options.texProfile, "internal");
  jobs[1].resolve(await analyze("tex", jobs[1].text)); await newer;
  const entries = await current;
  assert.deepEqual(entries[0].data.symbols.map(s => s.name), ["new"]);
  assert.equal(entries[0].tree, undefined);
  assert.equal((await cache.read(b))[0].data, entries[0].data);
  assert.equal(jobs.length, 2);
  b.nodes[0].content = "\\label{changed}";
  const changed = cache.read(b), changing = tick();
  assert.equal(cache.isCurrent(entries), false);
  jobs[2].resolve(await analyze("tex", jobs[2].text)); await changing;
  assert.deepEqual((await changed)[0].data.symbols.map(s => s.name), ["changed"]);
  b.nodes[0].content = "\\label{deletedWhilePending}";
  const deleted = cache.read(b), deleting = tick();
  cache.update({ ...b, nodes: [] });
  assert.equal(jobs[3].signal.aborted, true);
  jobs[3].resolve(await analyze("tex", jobs[3].text)); await deleting;
  assert.equal(await deleted, null);
  assert.deepEqual(await cache.read({ ...b, nodes: [] }), []);
  cache.dispose(); assert.equal(tasks.size, 0);
});
test("deleting a queued file before its task starts leaves no pending work", async t => {
  const { createProjectCache } = await import("../public/iris-language-completion.mjs");
  const tasks = new Map(); let next = 0, starts = 0;
  const cache = createProjectCache({ schedule(fn) { tasks.set(++next, fn); return next; }, cancel: id => tasks.delete(id),
    analyzeFile() { starts++; throw new Error("deleted file must not start"); } });
  t.after(() => cache.dispose());
  const scope = { projectId: "A", nodes: [file("gone.tex", "\\label{gone}")] };
  const waiting = cache.read(scope);
  cache.update({ ...scope, nodes: [] });
  assert.equal(await waiting, null);
  while (tasks.size) { const [id, fn] = tasks.entries().next().value; tasks.delete(id); await fn(); }
  assert.equal(starts, 0);
  assert.deepEqual(await cache.read({ ...scope, nodes: [] }), []);
  cache.dispose(); assert.equal(tasks.size, 0);
});

test("HP07 R2 accepted completion replaces entire tree-owned names and scalar/list items", async t => {
  const tex = await harness(t, "tex", { nodes: [file("labels.tex", "\\label{intro}\n\\label{hello world}\n\\label{part,a}")] });
  const ly = await harness(t, "ly");
  for (const [h, marked, label, expected] of [
    [tex, "\\ref{¦intro}", "intro", "\\ref{intro}"],
    [tex, "\\ref{in¦tro}", "intro", "\\ref{intro}"],
    [tex, "\\ref{intro¦}", "intro", "\\ref{intro}"],
    [tex, "\\ref{hello w¦}", "hello world", "\\ref{hello world}"],
    [tex, "\\ref{part,¦a}", "part,a", "\\ref{part,a}"],
    [tex, "\\cref{other, in¦tro, last}", "intro", "\\cref{other, intro, last}"],
    [tex, "\\begin{it¦emize}\\end{itemize}", "itemize", "\\begin{itemize}\\end{itemize}"],
    [tex, "\\sec¦tion{X}", "\\section", "\\section{X}"],
    [tex, "¦\\section{X}", "\\section", "\\section{X}"],
    [tex, "😀\r\n\\ref{he¦llo world}", "hello world", "😀\r\n\\ref{hello world}"],
    [ly, "\\new ¦Staff { c4 }", "Staff", "\\new Staff { c4 }"],
    [ly, "\\new St¦aff { c4 }", "Staff", "\\new Staff { c4 }"],
    [ly, "\\new Staff¦ { c4 }", "Staff", "\\new Staff { c4 }"],
  ]) assert.equal(await h.accept(marked, label), expected, marked);
  assert.equal(await tex.query("\\ref{¦" + "k".repeat(2100) + "}", true), null, "uncertified right boundary declines");
  assert.equal(await tex.query("\\sec¦" + "x".repeat(2100), true), null, "an over-budget command cannot fall back to a partial replacement");
  assert.equal(await ly.query("\\new ¦ % retained\n Staff { c4 }", true), null, "completion must not delete header comments to reach a name");
});

test("HP07 R1 builtins finish with partial syntax and pending project files; bounded reads still abort and dispose", { timeout: 2000 }, async t => {
  const { EditorState } = await import("@codemirror/state"), { CompletionContext } = await import("@codemirror/autocomplete");
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createLanguageState } = await import("../public/iris-language-state.mjs");
  const { createSource, createProjectCache } = await import("../public/iris-language-completion.mjs");
  const tasks = new Map(); let next = 0;
  const scheduler = { schedule(fn) { tasks.set(++next, fn); return next; }, cancel(id) { tasks.delete(id); } };
  const owner = createLanguageState(await loadLanguage("tex"), () => {}, scheduler), cache = createProjectCache(scheduler);
  t.after(() => { owner.dispose(); cache.dispose(); });
  const state = EditorState.create({ doc: "\\sec\n" + "x".repeat(216000), extensions: owner.extension });
  const scope = { projectId: "pending", nodes: [file("other.tex", "\\label{unready}")] };
  const source = createSource("tex", () => scope, { cache, contextAt: (s, p) => owner.contextAt(s, p), snapshot: s => owner.read(s), isCurrent: s => s === state });
  const result = await source(new CompletionContext(state, 4, true));
  assert.equal(owner.read(state).status, "partial", "neither queued analysis was allowed to run");
  assert.ok(labels(result).includes("\\section"));
  const controller = new AbortController(), pending = cache.read(scope, controller.signal, 1000);
  controller.abort(); assert.equal(await pending, null);
  const removed = cache.read(scope); cache.dispose(); assert.equal(await removed, null);
  owner.dispose(); assert.equal(tasks.size, 0);
});

test("HP07 R2 partial-tree cutoffs cannot certify a replacement's right boundary", async t => {
  const { EditorState } = await import("@codemirror/state"), { CompletionContext } = await import("@codemirror/autocomplete");
  const { loadLanguage } = await import("../public/iris-language-service.mjs"), adapter = await loadLanguage("tex");
  const { createSource, createProjectCache } = await import("../public/iris-language-completion.mjs");
  const cache = createProjectCache(), scope = {}; t.after(() => cache.dispose());
  for (const text of ["\\ref{" + "i".repeat(600) + "}", "\\" + "a".repeat(600) + " "]) {
    const parse = adapter.language.parser.startParse(text); parse.stopAt(260);
    let tree; while (!(tree = parse.advance())) {}
    const state = EditorState.create({ doc: text });
    assert.ok(tree.length < text.length);
    const source = createSource("tex", () => scope, { cache, isCurrent: s => s === state,
      contextAt: (s, p) => adapter.contextAt(tree, s.doc, p),
      snapshot: s => ({ ...adapter.summarize(tree, s.doc), status: "partial", parsedTo: tree.length }) });
    assert.equal((await source(new CompletionContext(state, 6, true))) === null, true, text.slice(0, 10));
  }
});

test("HP07 R2.1 empty reference and citation slots preserve adjacent commas", async t => {
  const h = await harness(t, "tex", { nodes: [file("labels.tex", "\\label{one}\n\\label{two}\n\\label{three}"),
    file("refs.bib", "@book{one,}\n@book{two,}\n@book{three,}")] });
  for (const command of ["cref", "cite"]) for (const [slot, expected] of [
    ["¦,two", "one,two"], ["¦, two", "one, two"], ["two,¦", "two,one"],
    ["two,¦,three", "two,one,three"], ["¦,,two", "one,,two"],
  ]) assert.equal(await h.accept(`\\${command}{${slot}}`, "one"), `\\${command}{${expected}}`);
});

test("HP07 R2.2 match ranges contain only the typed prefix while acceptance replaces the full target", async t => {
  const tex = await harness(t, "tex", { nodes: [file("labels.tex", "\\label{intro}")] }), ly = await harness(t, "ly");
  for (const [h, marked, label, expected, pattern] of [
    [tex, "\\ref{in¦valid}", "intro", "\\ref{intro}", "in"],
    [tex, "\\cref{two,in¦valid}", "intro", "\\cref{two,intro}", "in"],
    [tex, "\\sec¦Wrong", "\\section", "\\section", "\\sec"],
    [ly, "\\new ¦Staff { c4 }", "Voice", "\\new Voice { c4 }", ""],
  ]) {
    const result = await h.query(marked, true), text = marked.replace("¦", "");
    assert.equal(text.slice(result.from, result.to ?? marked.indexOf("¦")), pattern, marked);
    assert.equal(await h.accept(marked, label), expected);
  }
});

test("HP07 R2.2 a displayed builtin still applies when pending project analysis finishes", async t => {
  const { EditorState } = await import("@codemirror/state"), { syntaxTree } = await import("@codemirror/language");
  const { CompletionContext } = await import("@codemirror/autocomplete");
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createSource, createProjectCache } = await import("../public/iris-language-completion.mjs");
  const adapter = await loadLanguage("tex");
  let run, current = EditorState.create({ doc: "\\secWrong", selection: { anchor: 4 }, extensions: adapter.language });
  const cache = createProjectCache({ schedule(fn) { run = fn; return 1; }, cancel() { run = null; } });
  t.after(() => cache.dispose());
  const scope = { projectId: "A", nodes: [file("later.tex", "\\label{later}")] };
  const source = createSource("tex", () => scope, { cache, isCurrent: state => state === current,
    contextAt: (state, pos) => adapter.contextAt(syntaxTree(state), state.doc, pos),
    snapshot: state => ({ ...adapter.summarize(syntaxTree(state), state.doc), status: "ready", parsedTo: state.doc.length }) });
  const result = await source(new CompletionContext(current, 4, true));
  const option = result.options.find(o => o.label === "\\section");
  await run();
  const view = { get state() { return current; }, dispatch(spec) { current = current.update(spec).state; } };
  option.apply(view, option, result.from, result.to);
  assert.equal(current.doc.toString(), "\\section");
});

test("HP07 R2.3 document mappings retire captured completion results even outside the matching range", async t => {
  const { ChangeSet } = await import("@codemirror/state"), h = await harness(t);
  const result = await h.query("\\sec¦Wrong\nbody", true);
  const map = changes => result.map ? result.map(result, changes.desc) : result;
  assert.equal(map(ChangeSet.empty(14)), result, "non-document updates keep usable completion");
  for (const change of [{ from: 10, to: 14, insert: "edit" }, { from: 14, insert: " later" }, { from: 0, insert: "% " }]) {
    assert.equal(map(ChangeSet.of(change, 14)) === null, true, "mapped coordinates cannot make a captured old document current");
  }
});
