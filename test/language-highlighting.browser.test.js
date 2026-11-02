const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser, readySyntax } = require("./helpers/language-browser.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";
const options = { skip: !enabled, timeout: 30000 };
let pageFor;
test.before(async t => { if (enabled) pageFor = await languageBrowser(t); });

test("HP07 mounted snapshot shares editor revision, replaces lifetime and selects file profile", options, async t => {
  const page = await pageFor(t, [{ id: "main", name: "main.sty", path: "main.sty", kind: "tex", type: "file",
    content: "\\newcommand{\\local@name}{}\n\\section{Real}" }]);
  const first = await readySyntax(page);
  assert.ok(first.symbols.some(s => s.name === "local@name" && s.certainty === "exact"));
  await page.evaluate(() => { window.seenSyntax = []; IrisEditor.onSyntax(s => seenSyntax.push(s)); IrisEditor.replaceRange(0, 0, "% 😀\n"); });
  const edited = await readySyntax(page);
  assert.equal(edited.revision, first.revision + 1);
  assert.equal(edited.outline[0].offset, first.outline[0].offset + 5);
  await page.evaluate(() => IrisEditor.setLanguage("tex", { path: "main.tex" }));
  const standard = await readySyntax(page);
  assert.equal(standard.revision, edited.revision);
  assert.ok(standard.generation > edited.generation);
  assert.equal(standard.symbols.some(s => s.name === "local@name"), false);
  await page.evaluate(() => IrisEditor.loadCollab("\\newcommand{\\again@name}{}", "tex", { version: 4, path: "other.cls" }));
  const collab = await readySyntax(page);
  assert.ok(collab.symbols.some(s => s.name === "again@name"));
  assert.ok(collab.generation > standard.generation);
  await page.evaluate(() => IrisEditor.loadCollab("\\newcommand{\\resync@name}{}", "tex", { version: 8 }));
  assert.ok((await readySyntax(page)).symbols.some(s => s.name === "resync@name"));
  await page.evaluate(() => IrisEditor.load("\\newcommand{\\plain@name}{}", "tex", { path: "fresh.tex" }));
  assert.equal((await readySyntax(page)).symbols.some(s => s.name === "plain@name"), false);
});

test("HP07 mounted outline and region presence use the same literal-safe UTF-16 snapshot", options, async t => {
  const source = "% 😀 \\section{Fake comment} \\label{commentFake}\n\\begin{verbatim}\n\\section{Fake literal} \\label{literalFake}\n\\end{verbatim}\n\\newcommand{\\later}{\\section{Fake deferred}\\label{deferredFake}}\n\\section{Real}\\label{live}\nbody\n\\subparagraph{Deep}\nend \\ref{}";
  const page = await pageFor(t, [{ id: "main", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: source }]);
  const snapshot = await readySyntax(page);
  assert.deepEqual(snapshot.outline.map(s => s.title), ["Real", "Deep"]);
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), ["Real", "Deep"]);
  assert.deepEqual(snapshot.symbols.map(s => s.name), ["later", "live"]);
  await page.evaluate(async () => {
    const { startCompletion } = await import("@codemirror/autocomplete"), { EditorView } = await import("@codemirror/view");
    IrisEditor.select(IrisEditor.getValue().length - 1); IrisEditor.focus();
    startCompletion(EditorView.findFromDOM(document.querySelector(".cm-editor")));
  });
  await page.locator(".cm-tooltip-autocomplete").waitFor();
  assert.deepEqual(await page.locator(".cm-completionLabel").allTextContents(), ["live"]);
  assert.equal(await page.evaluate(() => IrisEditor.snapshot().revision), snapshot.revision);
  assert.equal(await page.locator("#outline .ol-item").last().getAttribute("data-level"), "6");
  await page.locator('#sideTabOutline').click();
  await page.locator("#outline .ol-item").first().click();
  assert.equal(await page.evaluate(() => IrisEditor.selection().head), source.indexOf("\\section{Real}"));
  await page.evaluate(pos => {
    IrisEditor.select(pos);
    IrisEditor.setPeers([{ id: "ada", userId: "ada", name: "Ada", role: "editor", head: pos + 2, anchor: pos + 2 }]);
  }, source.indexOf("body"));
  assert.match(await page.locator("#stPeers").getAttribute("title"), /Real/);
  assert.doesNotMatch(await page.locator("#stPeers").getAttribute("title"), /Fake/);
  const identity = await page.evaluate(() => { window.beforeLocale = IrisEditor.syntaxSnapshot(); return [beforeLocale.revision, beforeLocale.generation]; });
  await page.evaluate(() => IrisI18n.setLanguage("it"));
  assert.deepEqual(await page.evaluate(() => { const s = IrisEditor.syntaxSnapshot(); return [s.revision, s.generation]; }), identity);
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot() === beforeLocale), true);
  const pending = await page.evaluate(() => {
    IrisEditor.replaceRange(0, 0, "% prefix\n");
    const beforeClick = IrisEditor.selection().head, row = document.querySelector("#outline .ol-item");
    row.click();
    return { status: document.querySelector("#outline [data-syntax-status]")?.dataset.syntaxStatus,
      disabled: row.getAttribute("aria-disabled"), title: row.querySelector(".label").textContent,
      moved: IrisEditor.selection().head !== beforeClick, regions: document.querySelectorAll(".cm-iris-peer-region").length };
  });
  assert.deepEqual(pending, { status: "partial", disabled: "true", title: "Real", moved: false, regions: 0 });
  const resumed = await readySyntax(page);
  assert.equal(resumed.outline[0].offset, snapshot.outline[0].offset + 9);
  assert.equal(await page.locator("#outline .ol-item").first().getAttribute("aria-disabled"), "false");
  await page.evaluate(() => IrisEditor.replaceRange(0, IrisEditor.getValue().length, "x".repeat(1048577)));
  await page.waitForFunction(() => document.querySelector("#outline [data-syntax-status='unavailable']"));
  assert.match(await page.locator("#outline").textContent(), /analisi|sintassi/i);
  assert.equal(await page.locator(".cm-iris-peer-region").count(), 0);
});

test("HP07 mounted completion ignores deferred/comment/literal records and uses current source", options, async t => {
  const source = "% \\label{commentFake}\n\\begin{verbatim}\n\\label{literalFake}\n\\end{verbatim}\n\\newcommand{\\later}{\\label{deferredFake}}\n\\label{live}\n\\ref{}";
  const page = await pageFor(t, [{ id: "main", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: source }]);
  await readySyntax(page);
  await page.evaluate(async () => {
    const { startCompletion } = await import("@codemirror/autocomplete");
    const { EditorView } = await import("@codemirror/view");
    IrisEditor.select(IrisEditor.getValue().length - 1); IrisEditor.focus();
    startCompletion(EditorView.findFromDOM(document.querySelector(".cm-editor")));
  });
  await page.locator(".cm-tooltip-autocomplete").waitFor();
  assert.deepEqual(await page.locator(".cm-completionLabel").allTextContents(), ["live"]);
});

test("HP07 mounted tree Enter, native pairing, multiple cursors, formatting and undo preserve source", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", path: "main.ly", name: "main.ly", kind: "ly", content: "#{" }]);
  await readySyntax(page);
  await page.evaluate(() => { IrisEditor.select(2); IrisEditor.focus(); });
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "#{\n  \n#}");
  await page.evaluate(() => IrisEditor.undo());
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "#{");
  await page.evaluate(async () => {
    IrisEditor.load("\\begin{a}\n\\begin{a}", "tex");
    const { EditorView } = await import("@codemirror/view"), { EditorSelection, EditorState, StateEffect } = await import("@codemirror/state");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(9), EditorSelection.cursor(19)]) });
    IrisEditor.focus();
  });
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\begin{a}\n  \n\\end{a}\n\\begin{a}\n  \n\\end{a}");
  await page.evaluate(() => { IrisEditor.load("", "tex"); IrisEditor.focus(); });
  await page.keyboard.type("{");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "{}");
  await page.keyboard.press("Backspace");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "");
  await page.keyboard.type("{}");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "{}");
  await page.evaluate(() => { IrisEditor.load("#", "ly"); IrisEditor.select(1); IrisEditor.focus(); });
  await page.keyboard.type("{");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "#{");
  const source = "\\begin{a}\n x  \n\\begin{verbatim}\n  raw  \n\n\n z\n\\end{verbatim}\n \\end{a}";
  await page.evaluate(source => { IrisEditor.load(source, "tex"); window.beforeFormat = IrisEditor.snapshot(); window.bookmark = IrisEditor.trackRange(11, 12); }, source);
  await readySyntax(page);
  assert.equal(await page.evaluate(() => IrisEditor.format(beforeFormat)), "applied");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source.replace("\n x", "\n  x").replace("\n \\end{a}", "\n\\end{a}"));
  assert.equal(await page.evaluate(() => IrisEditor.getValue().slice(bookmark.read().from, bookmark.read().to)), "x");
  assert.equal(await page.evaluate(() => IrisEditor.format(beforeFormat)), "stale");
  assert.equal(await page.evaluate(() => IrisEditor.format()), "unchanged");
  await page.evaluate(() => IrisEditor.undo());
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
});

test("HP07 mounted IME, readonly, auto-indent off, selection and bibliographic policies", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", path: "main.tex", name: "main.tex", kind: "tex", content: "" }]);
  await page.evaluate(() => IrisEditor.focus());
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "{", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "{" });
  await page.waitForFunction(() => IrisEditor.getValue() === "{");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "{", "native composition does not insert a paired closer");
  await cdp.detach();
  await page.evaluate(() => { IrisEditor.load("\\begin{a}", "tex"); IrisEditor.select(9); IrisEditor.setAutoIndent(false); IrisEditor.focus(); });
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\begin{a}\n\n\\end{a}");
  await page.evaluate(() => { IrisEditor.load("\\begin{a}selected", "tex"); IrisEditor.select(9, 17); IrisEditor.setAutoIndent(true); IrisEditor.focus(); });
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\begin{a}\n  ");
  await page.evaluate(() => { IrisEditor.load("\\begin{a}", "tex"); IrisEditor.setReadOnly(true); IrisEditor.select(9); IrisEditor.focus(); });
  await page.keyboard.press("Enter"); await page.keyboard.type("{");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\begin{a}");
  assert.equal(await page.evaluate(() => IrisEditor.format()), "readonly");
  assert.equal(await page.evaluate(() => IrisEditor.undo()), false);
  await page.evaluate(() => { IrisEditor.setReadOnly(false); IrisEditor.load("@book{k,\r\n title={A😀}\r\n}", "bib"); });
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot()), null);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "@book{k,\r\n title={A😀}\r\n}");
  await page.evaluate(() => { IrisEditor.load("TY  - BOOK\r\nER  -", "ris"); IrisEditor.select(IrisEditor.getValue().length); IrisEditor.focus(); });
  await page.locator("#bibliographyTextTab").click();
  await page.evaluate(() => IrisEditor.focus());
  await page.keyboard.type("{");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "TY  - BOOK\r\nER  -{");
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot()), null);
});

test("HP07 mounted parser-only completion, peer/style stability, remote revision and project replacement", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", path: "main.sty", name: "main.sty", kind: "tex", content: "\\section{Before}" }]);
  const first = await readySyntax(page);
  await page.evaluate(() => { window.stableSyntax = IrisEditor.syntaxSnapshot(); IrisEditor.select(3); IrisEditor.setPeers([{ id: "p", head: 4, anchor: 4 }]); document.documentElement.style.setProperty("--syntax-command", "var(--syntax-text)"); });
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot() === stableSyntax), true);
  const progress = await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view"), { forceParsing, syntaxTree } = await import("@codemirror/language");
    IrisEditor.load("\\section{Head}\n" + "x".repeat(20000) + "\\section{Tail}", "tex");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const revision = IrisEditor.snapshot().revision, before = syntaxTree(view.state).length;
    forceParsing(view, view.state.doc.length, 1000);
    return { revision, before, length: view.state.doc.length };
  });
  assert.ok(progress.before < progress.length);
  const parsed = await readySyntax(page);
  assert.equal(parsed.revision, progress.revision);
  assert.deepEqual(parsed.outline.map(s => s.title), ["Head", "Tail"]);
  await page.evaluate(async () => {
    IrisEditor.loadCollab("\\section{Remote}", "tex", { version: 2, path: "main.sty" });
    const { ChangeSet } = await import("@codemirror/state");
    IrisEditor.collabReceive([{ clientID: "peer", changes: ChangeSet.of({ from: 0, insert: "😀\n" }, IrisEditor.getValue().length).toJSON() }]);
  });
  const remote = await readySyntax(page);
  assert.equal(remote.outline[0].offset, 3);
  assert.ok(remote.revision > first.revision);
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await IrisApp.load({ id: "replacement", language: "en", activeId: "main", openTabs: ["main"],
      project: { name: "Replacement", nodes: [{ id: "main", type: "file", kind: "tex", path: "main.tex", name: "main.tex",
        content: `\\newcommand{\\old@name}{}\n\\section{Project ${i}}` }] }, autoSave: false });
  });
  const replacement = await readySyntax(page);
  assert.deepEqual(replacement.outline.map(i => i.title), ["Project 3"]);
  assert.equal(replacement.symbols.some(s => s.name === "old@name"), false);
  assert.ok(replacement.generation > remote.generation);
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), ["Project 3"]);
  await page.evaluate(() => IrisEditor.load("\\score { c4 }", "ly", { path: "score.ly" }));
  await readySyntax(page);
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), ["Score 1"]);
  await page.evaluate(() => { window.localizedSnapshot = IrisEditor.syntaxSnapshot(); return IrisI18n.setLanguage("it"); });
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot() === localizedSnapshot), true);
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), ["Partitura 1"]);
  await page.evaluate(async () => { IrisApp.cancelPendingProjectLoad(); await Promise.resolve(); });
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot()), null, "closing the project retires the document owner");
});

test("HP07 mounted generic included sources share their owner's outline and formatter", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "file", name: "included.sty", path: "included.sty",
    content: "\\newcommand{\\local@name}{}\n\\section{Included}\n\\begin{a}\n x\n\\end{a}" }]);
  const snapshot = await readySyntax(page);
  assert.ok(snapshot.symbols.some(s => s.name === "local@name"));
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), ["Included"]);
  await page.locator("#btnFormat").click();
  assert.match(await page.evaluate(() => IrisEditor.getValue()), /\n  x\n/);
  await page.evaluate(() => IrisApp.load({ id: "included-project", language: "en", activeId: "main", openTabs: ["main"], autoSave: false,
    project: { nodes: [{ id: "main", type: "file", kind: "file", name: "included.ily", path: "included.ily", content: "\\score {\nc4\n}" }] } }));
  await readySyntax(page);
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), ["Score 1"]);
  await page.locator("#btnFormat").click();
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\score {\n  c4\n}");
});

test("HP07 mounted formatter declines edits during native composition", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "\\begin{a}\n x\n\\end{a}" }]);
  await readySyntax(page);
  await page.evaluate(() => { IrisEditor.select(12); IrisEditor.focus(); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "字", selectionStart: 1, selectionEnd: 1 });
  const result = await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const before = IrisEditor.snapshot(), composing = view.composing || view.compositionStarted;
    return { composing, before, result: IrisEditor.format(), after: IrisEditor.snapshot() };
  });
  assert.equal(result.composing, true);
  assert.equal(result.result, "unavailable");
  assert.deepEqual(result.after, result.before);
  await cdp.send("Input.insertText", { text: "字" });
  await cdp.detach();
});

for (const kind of ["tex", "ly"]) test(`HP07 R1 ${kind} mounted analysis reaches EOF beyond viewport lookahead without a force-parse intervention`, options, async t => {
  const source = kind === "tex" ? "\\sec\n" + "hello world\n".repeat(18000) + "\\section{Tail}" : "\\rel\n" + "c4 d8 e2 r4\n".repeat(18000) + "\\score { c4 }";
  const page = await pageFor(t, [{ id: "main", type: "file", kind, name: `main.${kind}`, path: `main.${kind}`, content: source }]);
  await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view"), completion = await import("@codemirror/autocomplete");
    window.longView = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    window.completionAPI = completion;
    IrisEditor.select(4); IrisEditor.focus(); completion.startCompletion(longView);
  });
  await page.waitForFunction(() => completionAPI.completionStatus(longView.state) === "active", null, { timeout: 8000 });
  assert.ok((await page.locator(".cm-completionLabel").allTextContents()).includes(kind === "tex" ? "\\section" : "\\relative"));
  await page.waitForFunction(() => IrisEditor.syntaxSnapshot()?.status === "ready", null, { timeout: 8000 });
  const snapshot = await readySyntax(page);
  assert.equal(snapshot.parsedTo, source.length);
  assert.deepEqual(snapshot.outline.map(x => x.title), [kind === "tex" ? "Tail" : "Score 1"]);
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), [kind === "tex" ? "Tail" : "Score 1"]);
  assert.ok(await page.evaluate(() => longView.viewport.to < 10000));
});

test("HP07 R2 mounted acceptCompletion consumes existing right-hand name text", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "ly", name: "main.ly", path: "main.ly", content: "\\new Staff { c4 }" }]);
  for (const [kind, marked, label, expected] of [
    ["ly", "\\new ¦Staff { c4 }", "Staff", "\\new Staff { c4 }"],
    ["tex", "\\label{hello world}\n\\ref{hello w¦}", "hello world", "\\label{hello world}\n\\ref{hello world}"],
    ["tex", "\\sec¦tion{X}", "\\section", "\\section{X}"],
  ]) {
    await page.evaluate(({ kind, marked }) => { IrisEditor.load(marked.replace("¦", ""), kind); IrisEditor.select(marked.indexOf("¦")); IrisEditor.focus(); }, { kind, marked });
    await readySyntax(page);
    await page.evaluate(async () => {
      window.complete = await import("@codemirror/autocomplete");
      const { EditorView } = await import("@codemirror/view");
      window.acceptView = EditorView.findFromDOM(document.querySelector(".cm-editor"));
      complete.startCompletion(acceptView);
    });
    await page.waitForFunction(label => complete.currentCompletions(acceptView.state).some(o => o.label === label), label);
    await page.evaluate(label => {
      const index = complete.currentCompletions(acceptView.state).findIndex(o => o.label === label);
      acceptView.dispatch({ effects: complete.setSelectedCompletion(index) });
    }, label);
    await page.waitForFunction(() => complete.acceptCompletion(acceptView));
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), expected);
  }
});

for (const phase of ["installed", "pending"]) test(`HP07 R3 profile replacement closes ${phase} completion without resetting source history`, options, async t => {
  const source = "\\newcommand{\\local@name}{}\n\\local";
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.sty", path: "main.sty", content: source }]);
  await page.evaluate(() => { IrisEditor.replaceRange(0, 0, "% edit\n"); IrisEditor.select(IrisEditor.getValue().length); IrisEditor.focus(); });
  if (phase === "installed") await readySyntax(page);
  await page.evaluate(async phase => {
    window.profileCompletion = await import("@codemirror/autocomplete");
    const { EditorView } = await import("@codemirror/view");
    window.profileView = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    window.replaceProfile = () => {
      const before = IrisEditor.snapshot(), selection = IrisEditor.selection(), statusBefore = profileCompletion.completionStatus(profileView.state);
      IrisEditor.setLanguage("tex", { path: "main.tex" });
      return { before, after: IrisEditor.snapshot(), selection, afterSelection: IrisEditor.selection(), statusBefore, status: profileCompletion.completionStatus(profileView.state) };
    };
    if (phase === "pending") {
      // Observe the real installed source registering its abort listener, then
      // replace the profile while that request is awaiting its summary/cache.
      const proto = profileCompletion.CompletionContext.prototype, original = proto.addEventListener;
      proto.addEventListener = function (...args) {
        const result = original.apply(this, args);
        if (args[0] === "abort") {
          proto.addEventListener = original;
          queueMicrotask(() => { window.pendingProfileResult = replaceProfile(); });
        }
        return result;
      };
    }
    profileCompletion.startCompletion(profileView);
  }, phase);
  if (phase === "installed") await page.waitForFunction(() => profileCompletion.currentCompletions(profileView.state).some(o => o.label === "\\local@name"));
  else await page.waitForFunction(() => window.pendingProfileResult);
  const result = await page.evaluate(phase => phase === "pending" ? pendingProfileResult : replaceProfile(), phase);
  assert.equal(result.statusBefore, phase === "pending" ? "pending" : "active");
  assert.equal(result.status, null);
  assert.deepEqual(result.after, result.before); assert.deepEqual(result.afterSelection, result.selection);
  const snapshot = await readySyntax(page);
  assert.equal(snapshot.symbols.some(s => s.name === "local@name"), false);
  assert.equal(await page.evaluate(() => profileCompletion.currentCompletions(profileView.state).length), 0);
  await page.evaluate(() => IrisEditor.undo());
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
});

test("HP07 R4 native inline Enter reserves outer closers in single and multiple selections", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "" }]);
  for (const [kind, source, carets, expected] of [
    ["tex", "\\begin{a}\n\\begin{a}\\end{a}", [19], "\\begin{a}\n\\begin{a}\n  \n\\end{a}\n\\end{a}"],
    ["ly", "{\n{}", [3], "{\n{\n  \n}\n}"],
    ["tex", "\\begin{a}\n\\begin{a}\\end{a}", [9, 19], "\\begin{a}\n  \n\\begin{a}\n  \n\\end{a}\n\\end{a}"],
    ["ly", "{\n{}", [1, 3], "{\n  \n{\n  \n}\n}"],
  ]) {
    await page.evaluate(async ({ kind, source, carets }) => {
      IrisEditor.load(source, kind);
      const { EditorView } = await import("@codemirror/view"), { EditorSelection, EditorState, StateEffect } = await import("@codemirror/state");
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor"));
      view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
      view.dispatch({ selection: EditorSelection.create(carets.map(p => EditorSelection.cursor(p))) });
      IrisEditor.focus();
    }, { kind, source, carets });
    assert.equal(await page.evaluate(async () => {
      const { EditorView } = await import("@codemirror/view");
      return EditorView.findFromDOM(document.querySelector(".cm-editor")).state.selection.ranges.length;
    }), carets.length);
    await readySyntax(page);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), expected);
    await page.evaluate(() => IrisEditor.undo());
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
  }
});

for (const phase of ["ready", "pending"]) test(`HP07 R5 image-active project replacement retires ${phase} source syntax`, options, async t => {
  const source = "\\section{A} alpha \\section{B} beta";
  const image = { id: "image", type: "file", kind: "img", name: "image.svg", path: "image.svg",
    data: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>') };
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: source }, image]);
  await readySyntax(page);
  // Same-project preview keeps the source available and retains its lifetime.
  await page.evaluate(() => { window.imageBefore = IrisEditor.syntaxSnapshot(); });
  await page.locator('#tree .node[data-id="image"]').click();
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot() === imageBefore), true);
  await page.evaluate(phase => {
    if (phase === "pending") IrisEditor.load("\\section{Old}\n" + "hello world\n".repeat(18000), "tex");
    IrisEditor.select(5); window.retiredGeneration = IrisEditor.syntaxSnapshot().generation;
  }, phase);
  if (phase === "pending") assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot().status), "partial");
  await page.evaluate(image => IrisApp.load({ id: "image-project", language: "en", activeId: "image", openTabs: ["image"], autoSave: false,
    project: { nodes: [image] } }), image);
  assert.equal(await page.evaluate(() => IrisEditor.syntaxSnapshot()), null);
  assert.equal(await page.locator("#outline .ol-item").count(), 0);
  assert.equal(await page.locator(".cm-iris-peer-region").count(), 0);
  await page.evaluate(() => IrisApp.load({ id: "next-project", language: "en", activeId: "main", openTabs: ["main"], autoSave: false,
    project: { nodes: [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "\\section{New}" }] } }));
  const snapshot = await readySyntax(page);
  assert.ok(snapshot.generation > await page.evaluate(() => retiredGeneration));
  assert.deepEqual(await page.locator("#outline .label").allTextContents(), ["New"]);
});

test("HP07 R6 same-line peer moves and mapped offsets update structural presence without a local caret move", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "\\section{A} alpha \\section{B} beta" }]);
  await readySyntax(page);
  await page.evaluate(() => {
    window.peerEvents = []; IrisEditor.onPeers(peers => peerEvents.push(peers.map(p => [p.anchor, p.head])));
    IrisEditor.select(12); IrisEditor.setPeers([{ id: "ada", userId: "ada", name: "Ada", role: "editor", head: 13, anchor: 13 }]);
  });
  assert.equal(await page.locator("#stPeers").evaluate(e => e.classList.contains("overlap")), true);
  await page.evaluate(() => IrisEditor.setPeers([{ id: "ada", userId: "ada", name: "Ada", role: "editor", head: 31, anchor: 31 }]));
  assert.deepEqual(await page.evaluate(() => peerEvents.at(-1)), [[31, 31]]);
  assert.equal(await page.locator("#stPeers").evaluate(e => e.classList.contains("overlap")), false);
  assert.match(await page.locator("#stPeers").getAttribute("title"), /B/);
  assert.equal(await page.locator(".cm-iris-peer-region").count(), 0);
  await page.evaluate(() => IrisEditor.replaceRange(17, 17, "x".repeat(40)));
  await readySyntax(page);
  assert.deepEqual(await page.evaluate(() => peerEvents.at(-1)), [[71, 71]]);
  assert.equal(await page.evaluate(() => IrisEditor.selection().head), 12);
  assert.equal(await page.locator("#stPeers").evaluate(e => e.classList.contains("overlap")), false);
  await page.evaluate(() => IrisEditor.setPeers([{ id: "ada", userId: "ada", name: "Ada", role: "editor", head: 71, anchor: 70 }]));
  assert.deepEqual(await page.evaluate(() => peerEvents.at(-1)), [[70, 71]]);
});

async function openR2Completion(page, kind, marked, customCommands) {
  await page.evaluate(({ kind, marked, customCommands }) => {
    IrisEditor.load(marked.replace("¦", ""), kind, { path: `main.${kind}` });
    IrisEditor.select(marked.indexOf("¦")); IrisEditor.focus();
    if (customCommands) IrisEditor.setCompletionContext({ projectId: "r2-custom", nodes: [], customCommands });
  }, { kind, marked, customCommands });
  await readySyntax(page);
  await page.evaluate(async () => {
    window.r2Completion = await import("@codemirror/autocomplete");
    const { EditorView } = await import("@codemirror/view");
    window.r2View = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    r2Completion.startCompletion(r2View);
  });
  await page.waitForFunction(() => r2Completion.completionStatus(r2View.state) !== "pending");
  return page.evaluate(() => r2Completion.currentCompletions(r2View.state).map(o => o.label));
}

async function acceptR2Completion(page, label) {
  const labels = await page.evaluate(() => r2Completion.currentCompletions(r2View.state).map(o => o.label));
  assert.ok(labels.includes(label), `mounted popup must offer ${label}`);
  await page.evaluate(label => {
    r2View.dispatch({ effects: r2Completion.setSelectedCompletion(r2Completion.currentCompletions(r2View.state).findIndex(o => o.label === label)) });
  }, label);
  await page.waitForFunction(() => r2Completion.acceptCompletion(r2View));
}

for (const command of ["cref", "cite"]) test(`HP07 R2.1 mounted ${command} acceptance preserves commas around empty list slots`, options, async t => {
  const page = await pageFor(t, [
    { id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "" },
    { id: "refs", type: "file", kind: "bib", name: "refs.bib", path: "refs.bib", content: "@book{one,}\n@book{two,}\n@book{three,}" },
  ]);
  const head = "\\label{one}\n\\label{two}\n\\label{three}\n";
  for (const [slot, expected] of [["¦,two", "one,two"], ["¦, two", "one, two"], ["two,¦", "two,one"], ["two,¦,three", "two,one,three"], ["¦,,two", "one,,two"]]) {
    const marked = `${head}\\${command}{${slot}}`;
    await openR2Completion(page, "tex", marked);
    await acceptR2Completion(page, "one");
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), `${head}\\${command}{${expected}}`);
    await page.evaluate(() => IrisEditor.undo());
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), marked.replace("¦", ""));
  }
});

for (const [category, kind, head, cases] of [
  ["scalar", "tex", "\\label{intro}\n\\label{hello world}\n", [
    ["\\ref{¦invalid}", "intro", "\\ref{intro}"], ["\\ref{in¦valid}", "intro", "\\ref{intro}"], ["\\ref{in¦}", "intro", "\\ref{intro}"],
    ["\\ref{hello w¦rong}", "hello world", "\\ref{hello world}"],
  ]],
  ["list", "tex", "\\label{intro}\n\\label{two}\n\\label{three}\n", [
    ["\\cref{two,¦invalid,three}", "intro", "\\cref{two,intro,three}"],
    ["\\cref{two,in¦valid,three}", "intro", "\\cref{two,intro,three}"],
    ["\\cref{two,in¦,three}", "intro", "\\cref{two,intro,three}"],
  ]],
  ["command", "tex", "", [
    ["¦\\wrong", "\\section", "\\section"], ["\\sec¦Wrong", "\\section", "\\section"], ["\\sec¦", "\\section", "\\section"],
  ]],
  ["context", "ly", "", [
    ["\\new ¦Staff { c4 }", "Voice", "\\new Voice { c4 }"],
    ["\\new Vo¦Wrong { c4 }", "Voice", "\\new Voice { c4 }"],
    ["\\new Vo¦ { c4 }", "Voice", "\\new Voice { c4 }"],
  ]],
]) test(`HP07 R2.2 mounted ${category} prefix filtering and full replacement at start middle and end`, options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind, name: `main.${kind}`, path: `main.${kind}`, content: "" }]);
  for (const [marked, label, expected] of cases) {
    await openR2Completion(page, kind, head + marked);
    await acceptR2Completion(page, label);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), head + expected);
    await page.evaluate(() => IrisEditor.undo());
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), head + marked.replace("¦", ""));
  }
});

test("HP07 R2.2 mounted completion retains native fuzzy matching and project custom catalogs", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "" }]);
  for (const [marked, label, expected] of [
    ["\\sct¦Wrong", "\\section", "\\section"],
    ["\\myCm¦Wrong", "\\myCommand", "\\myCommand"],
  ]) {
    const labels = await openR2Completion(page, "tex", marked, { tex: ["\\myCommand", "\\zebraCustom"], ly: [] });
    assert.equal(labels.includes("\\zebraCustom"), false, "unrelated suggestions still use CM filtering");
    await acceptR2Completion(page, label);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), expected);
  }
});

test("HP07 R2.2 captured apply refuses changed source profile project selection and readonly state", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "" }]);
  for (const action of ["source", "profile", "project", "selection", "readonly"]) {
    await page.evaluate(() => IrisEditor.setReadOnly(false));
    await openR2Completion(page, "tex", "\\sec¦Wrong\nbody");
    const result = await page.evaluate(action => {
      const option = r2Completion.currentCompletions(r2View.state).find(o => o.label === "\\section");
      const from = 0, to = IrisEditor.selection().from;
      if (action === "source") IrisEditor.replaceRange(IrisEditor.getValue().length - 4, IrisEditor.getValue().length, "edit");
      else if (action === "profile") IrisEditor.setLanguage("tex", { path: "main.sty" });
      else if (action === "project") IrisEditor.setCompletionContext({ projectId: "replacement", nodes: [] });
      else if (action === "selection") IrisEditor.select(to + 1);
      else IrisEditor.setReadOnly(true);
      const before = IrisEditor.snapshot(), selection = IrisEditor.selection();
      // Invoke the previously installed callback even though CM may have already
      // closed its popup, exercising the application-time guards themselves.
      option.apply(r2View, option, from, to);
      return { before, after: IrisEditor.snapshot(), selection, afterSelection: IrisEditor.selection() };
    }, action);
    assert.deepEqual(result.after, result.before, action);
    assert.deepEqual(result.afterSelection, result.selection, action);
  }
});

test("HP07 R2.2 mounted completion is one annotated undo event independent of adjacent typing", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "" }]);
  await openR2Completion(page, "tex", "\\se¦Wrong");
  await page.keyboard.type("c");
  await readySyntax(page);
  await page.evaluate(() => r2Completion.startCompletion(r2View));
  await page.waitForFunction(() => r2Completion.completionStatus(r2View.state) !== "pending");
  const before = await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view"), { StateEffect } = await import("@codemirror/state");
    window.completionEdits = [];
    r2View.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
      for (const tr of update.transactions) if (tr.docChanged) completionEdits.push({ event: tr.isUserEvent("input.complete"), picked: tr.annotation(r2Completion.pickedCompletion)?.label });
    })) });
    return IrisEditor.snapshot();
  });
  assert.equal(before.text, "\\secWrong");
  await acceptR2Completion(page, "\\section");
  assert.deepEqual(await page.evaluate(() => completionEdits), [{ event: true, picked: "\\section" }]);
  assert.deepEqual(await page.evaluate(() => IrisEditor.snapshot()), { text: "\\section", revision: before.revision + 1 });
  await page.evaluate(() => IrisEditor.undo());
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\secWrong", "completion undo retains the preceding native keystroke");
  await page.evaluate(() => IrisEditor.undo());
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\seWrong");
});

for (const remote of [false, true]) test(`HP07 R2.3 ${remote ? "collaborative" : "local"} unrelated edits retire stale completion before native Tab and Enter`, options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "\\secWrong\nbody" }]);
  await page.evaluate(remote => {
    if (remote) IrisEditor.loadCollab("\\secWrong\nbody", "tex", { version: 7, path: "main.tex" });
    IrisEditor.select(4); IrisEditor.focus();
  }, remote);
  await readySyntax(page);
  await page.evaluate(async () => {
    window.r23Completion = await import("@codemirror/autocomplete");
    const { EditorView } = await import("@codemirror/view");
    window.r23View = EditorView.findFromDOM(document.querySelector(".cm-editor"));
    r23Completion.startCompletion(r23View);
  });
  await page.waitForFunction(() => r23Completion.currentCompletions(r23View.state).some(o => o.label === "\\section"));
  // Wait through CM's interaction delay without accepting or changing source.
  await page.waitForFunction(() => r23Completion.moveCompletionSelection(true)(r23View));
  const edited = await page.evaluate(async remote => {
    const index = r23Completion.currentCompletions(r23View.state).findIndex(o => o.label === "\\section");
    r23View.dispatch({ effects: r23Completion.setSelectedCompletion(index) });
    const before = IrisEditor.snapshot();
    if (remote) {
      const { ChangeSet } = await import("@codemirror/state");
      IrisEditor.collabReceive([{ clientID: "peer", changes: ChangeSet.of({ from: 10, to: 14, insert: "edit" }, 14).toJSON() }]);
    } else IrisEditor.replaceRange(10, 14, "edit");
    return { before, after: IrisEditor.snapshot(), caret: IrisEditor.selection().head,
      status: r23Completion.completionStatus(r23View.state), version: IrisEditor.collabVersion() };
  }, remote);
  assert.deepEqual(edited.after, { text: "\\secWrong\nedit", revision: edited.before.revision + 1 });
  assert.equal(edited.caret, 4);
  assert.equal(edited.status, null, "old popup must not keep a non-applicable callback installed");
  if (remote) assert.equal(edited.version, 8);
  assert.equal(await page.locator(".cm-tooltip-autocomplete").count(), 0);
  assert.equal(await page.evaluate(() => r23Completion.acceptCompletion(r23View)), false);
  for (const [key, expected] of remote
    ? [["Enter", "\\sec\nWrong\nedit"], ["Tab", "\\sec\n  Wrong\nedit"]]
    : [["Tab", "\\sec  Wrong\nedit"], ["Enter", "\\sec  \nWrong\nedit"]]) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), expected, `${key} performs the normal editor action`);
    await page.waitForFunction(() => r23Completion.completionStatus(r23View.state) !== "pending");
    assert.equal(await page.evaluate(() => r23Completion.completionStatus(r23View.state)), null);
  }
});

test("HP07 R2.3 refused apply closes its installed popup without closing a newer valid result", options, async t => {
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "tex", name: "main.tex", path: "main.tex", content: "" }]);
  await openR2Completion(page, "tex", "\\sec¦Wrong\nbody");
  const refused = await page.evaluate(() => {
    window.rejectedOption = r2Completion.currentCompletions(r2View.state).find(o => o.label === "\\section");
    const before = IrisEditor.snapshot(), selection = IrisEditor.selection();
    rejectedOption.apply(r2View, rejectedOption, 0, 3); // uncertified matching endpoint
    return { before, after: IrisEditor.snapshot(), selection, afterSelection: IrisEditor.selection(), status: r2Completion.completionStatus(r2View.state) };
  });
  assert.deepEqual(refused.after, refused.before);
  assert.deepEqual(refused.afterSelection, refused.selection);
  assert.equal(refused.status, null);
  await page.evaluate(() => r2Completion.startCompletion(r2View));
  await page.waitForFunction(() => r2Completion.currentCompletions(r2View.state).some(o => o.label === "\\section"));
  assert.equal(await page.evaluate(() => {
    rejectedOption.apply(r2View, rejectedOption, 0, 3);
    return r2Completion.completionStatus(r2View.state);
  }), "active", "a discarded callback must not close another query's valid popup");
  await acceptR2Completion(page, "\\section");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "\\section\nbody");
});
