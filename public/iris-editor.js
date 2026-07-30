/* ===================== Iris · editor adapter (CodeMirror 6) ===================== */
// Single entry point for everything the app needs from the source editor.
// The default implementation is CodeMirror 6, loaded as native ES modules via
// the import map in Iris.html and served from /vendor/codemirror. The legacy
// textarea editor (iris-editor-legacy.js) remains available behind the
// temporary `?editor=legacy` switch (or `localStorage.iris_editor = "legacy"`)
// while the migration is validated, and doubles as an automatic fallback when
// the modules cannot be loaded.
//
// Contract (both implementations):
//   load(content, kind)        fresh document, no change event ("ly"|"tex"|null)
//   getValue()                 current document text
//   applyText(text)            whole-document edit (formatter); granular in CM
//   replaceRange(from, to, s)  ranged edit (find & replace)
//   selection()                { from, to, text }
//   select(from, to, opts)     set selection; reveals like the legacy editor,
//                              opts { align: "top", margin: lines } for outline
//   setWordWrap / setAutoIndent / setReadOnly (booleans)
//   focus() / focusTarget() / ownsTarget(node)
// Events: onChange(fn) after any edit; onCursor(fn) with { line, column }.
(function () {
  const LINE_H = 21;
  const handlers = { change: [], cursor: [] };
  let impl = null;

  function emit(type, payload) {
    handlers[type].forEach((fn) => {
      try { fn(payload); } catch (err) { console.error("IrisEditor handler failed", err); }
    });
  }

  function legacyRequested() {
    try {
      const query = new URLSearchParams(window.location.search).get("editor");
      if (query === "legacy") return true;
      if (query === "codemirror") return false;
      return window.localStorage.getItem("iris_editor") === "legacy";
    } catch (err) {
      return false;
    }
  }

  async function createCodeMirror() {
    const [S, V, L, C, H] = await Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/language"),
      import("@codemirror/commands"),
      import("@lezer/highlight"),
    ]);

    // Custom tags mapped straight onto the existing t-* token classes so the
    // stylesheet keeps a single source of truth for the syntax palette.
    const tokenClasses = { cmd: "t-cmd", env: "t-env", brace: "t-brace", math: "t-math", comment: "t-comment", special: "t-special" };
    const tokenTable = {};
    const styleSpecs = [];
    Object.keys(tokenClasses).forEach((name) => {
      tokenTable[name] = H.Tag.define();
      styleSpecs.push({ tag: tokenTable[name], class: tokenClasses[name] });
    });
    const irisHighlight = L.syntaxHighlighting(L.HighlightStyle.define(styleSpecs));

    const streamDefinition = (spec) => L.StreamLanguage.define({
      startState: spec.startState,
      copyState: spec.copyState,
      token: spec.token,
      languageData: { commentTokens: { line: "%" } },
      tokenTable,
    });
    const languages = {
      tex: streamDefinition(window.IrisLatex.stream),
      ly: streamDefinition(window.IrisLilyPond.stream),
    };

    const flags = { wordWrap: false, autoIndent: true, readOnly: false, kind: null };
    const syntax = () => (flags.kind === "ly" ? window.IrisLilyPond : window.IrisLatex);
    const languageCompartment = new S.Compartment();
    const wrapCompartment = new S.Compartment();
    const readOnlyCompartment = new S.Compartment();
    let suppressEvents = false;

    // Tab and Enter reproduce the legacy editor: two-space insert and the
    // syntax modules' indent-on-enter. Mod-Enter stays unbound so the global
    // compile shortcut keeps working from inside the editor.
    const insertText = (view, text) => {
      if (view.state.readOnly) return true;
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.type" });
      return true;
    };
    const enterCommand = (view) => {
      if (!flags.autoIndent) return insertText(view, "\n");
      const range = view.state.selection.main;
      const before = view.state.sliceDoc(view.state.doc.lineAt(range.from).from, range.from);
      return insertText(view, syntax().indentOnEnter(before, before.length));
    };
    const editorKeymap = [
      { key: "Tab", run: (view) => insertText(view, "  ") },
      { key: "Enter", run: enterCommand },
      { key: "Shift-Enter", run: enterCommand },
      ...C.historyKeymap,
      ...C.defaultKeymap.filter((binding) => binding.key !== "Enter" && binding.key !== "Mod-Enter"),
    ];

    // Find & replace highlights: the app pushes the current match set through
    // highlightMatches() and the decorations stay visible while the focus sits
    // in the find bar (unlike the DOM selection, which CodeMirror only renders
    // when the editor is focused). Ranges are remapped across edits so the
    // marks do not drift before the next recompute.
    const matchesEffect = S.StateEffect.define();
    const matchesField = S.StateField.define({
      create: () => V.Decoration.none,
      update(decorations, tr) {
        decorations = decorations.map(tr.changes);
        for (const effect of tr.effects) if (effect.is(matchesEffect)) decorations = effect.value;
        return decorations;
      },
      provide: (field) => V.EditorView.decorations.from(field),
    });
    const matchMark = V.Decoration.mark({ class: "cm-iris-match" });
    const activeMatchMark = V.Decoration.mark({ class: "cm-iris-match cm-iris-match-active" });
    // Overview ruler: proportional tick marks over the vertical scrollbar
    // showing where the matches sit in a long document. Entries carry their
    // own active flag and are remapped across edits like the decorations.
    let rulerRanges = [];

    const listener = V.EditorView.updateListener.of((update) => {
      if (rulerRanges.length && (update.docChanged || update.geometryChanged)) {
        if (update.docChanged) {
          rulerRanges = rulerRanges.map((range) => ({
            from: update.changes.mapPos(range.from),
            to: update.changes.mapPos(range.to, 1),
            active: range.active,
          }));
        }
        scheduleRulerUpdate();
      }
      if (suppressEvents) return;
      if (update.docChanged) emit("change");
      if (update.docChanged || update.selectionSet) emitCursor(update.view);
    });
    function emitCursor(view) {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      emit("cursor", { line: line.number, column: head - line.from + 1 });
    }

    function makeState(content) {
      return S.EditorState.create({
        doc: content,
        extensions: [
          V.lineNumbers(),
          V.highlightActiveLineGutter(),
          C.history(),
          V.keymap.of(editorKeymap),
          languageCompartment.of(flags.kind === "ly" ? languages.ly : languages.tex),
          irisHighlight,
          L.indentUnit.of("  "),
          wrapCompartment.of(flags.wordWrap ? V.EditorView.lineWrapping : []),
          readOnlyCompartment.of(S.EditorState.readOnly.of(flags.readOnly)),
          matchesField,
          listener,
          V.EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
        ],
      });
    }

    const editorEl = document.querySelector(".editor");
    const host = document.createElement("div");
    host.className = "cm-host";
    editorEl.appendChild(host);
    let view;
    try {
      view = new V.EditorView({ state: makeState(""), parent: host });
    } catch (err) {
      host.remove();
      throw err;
    }
    // The textarea editor's DOM is unused on this path; removing it avoids two
    // competing focus targets inside the same pane.
    ["gutter", "codeWrap"].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.remove();
    });

    const ruler = document.createElement("div");
    ruler.className = "cm-iris-ruler";
    ruler.style.display = "none";
    host.appendChild(ruler);
    function clearRuler() {
      rulerRanges = [];
      ruler.replaceChildren();
      ruler.style.display = "none";
    }
    function scheduleRulerUpdate() {
      view.requestMeasure({
        read() {
          const scroller = view.scrollDOM;
          // Only meaningful when the document actually scrolls.
          if (!rulerRanges.length || scroller.scrollHeight <= scroller.clientHeight + 1) return [];
          const total = Math.max(1, view.contentHeight);
          const docLength = view.state.doc.length;
          // Nearby matches collapse into ~0.5% buckets so a dense result set
          // cannot flood the overlay with thousands of nodes.
          const buckets = new Map();
          rulerRanges.forEach((range) => {
            const top = view.lineBlockAt(Math.min(range.from, docLength)).top;
            const pct = Math.max(0, Math.min(99.5, (top / total) * 100));
            const key = Math.round(pct * 2);
            const previous = buckets.get(key);
            if (!previous || range.active) {
              buckets.set(key, { pct, active: range.active || (previous ? previous.active : false) });
            }
          });
          return Array.from(buckets.values());
        },
        write(ticks) {
          ruler.replaceChildren();
          if (!ticks.length) { ruler.style.display = "none"; return; }
          ruler.style.display = "";
          ticks.forEach((tick) => {
            const mark = document.createElement("div");
            mark.className = "cm-iris-ruler-mark" + (tick.active ? " cm-iris-ruler-mark-active" : "");
            mark.style.top = tick.pct + "%";
            ruler.appendChild(mark);
          });
        },
      });
    }

    function reveal(pos, opts = {}) {
      if (opts.align === "top") {
        view.dispatch({ effects: V.EditorView.scrollIntoView(pos, { y: "start", yMargin: (opts.margin || 0) * LINE_H }) });
        return;
      }
      // Center only when the position falls outside the comfortable band,
      // mirroring the legacy editor's find/replace behaviour.
      const rect = view.scrollDOM.getBoundingClientRect();
      const coords = view.coordsAtPos(pos);
      if (!coords || coords.top < rect.top + 30 || coords.bottom > rect.bottom - 50) {
        view.dispatch({ effects: V.EditorView.scrollIntoView(pos, { y: "center" }) });
      }
    }

    return {
      kind: "codemirror",
      focus() { view.focus(); },
      focusTarget() { return view.contentDOM; },
      ownsTarget(node) { return host.contains(node); },
      getValue() { return view.state.doc.toString(); },
      load(content, kind) {
        flags.kind = kind || null;
        suppressEvents = true;
        try {
          view.setState(makeState(content || ""));
        } finally {
          suppressEvents = false;
        }
        clearRuler();
        emitCursor(view);
      },
      // Formatter output applied as one localized change: prefix/suffix diff
      // keeps the selection in place and the operation granular for history
      // (and, later, for collaborative editing).
      applyText(next) {
        const current = view.state.doc.toString();
        if (next === current) return;
        let from = 0;
        const minLength = Math.min(current.length, next.length);
        while (from < minLength && current.charCodeAt(from) === next.charCodeAt(from)) from++;
        let currentEnd = current.length, nextEnd = next.length;
        while (currentEnd > from && nextEnd > from && current.charCodeAt(currentEnd - 1) === next.charCodeAt(nextEnd - 1)) {
          currentEnd--;
          nextEnd--;
        }
        view.dispatch({
          changes: { from, to: currentEnd, insert: next.slice(from, nextEnd) },
          scrollIntoView: true,
          userEvent: "input.format",
        });
      },
      replaceRange(from, to, insert) {
        view.dispatch({ changes: { from, to, insert }, userEvent: "input.replace" });
      },
      selection() {
        const range = view.state.selection.main;
        return { from: range.from, to: range.to, text: view.state.sliceDoc(range.from, range.to) };
      },
      select(from, to = from, opts = {}) {
        const max = view.state.doc.length;
        const anchor = Math.max(0, Math.min(max, from));
        const head = Math.max(anchor, Math.min(max, to));
        view.dispatch({ selection: { anchor, head } });
        reveal(anchor, opts);
      },
      setWordWrap(on) {
        flags.wordWrap = !!on;
        view.dispatch({ effects: wrapCompartment.reconfigure(flags.wordWrap ? V.EditorView.lineWrapping : []) });
      },
      setAutoIndent(on) { flags.autoIndent = !!on; },
      setReadOnly(on) {
        flags.readOnly = !!on;
        view.dispatch({ effects: readOnlyCompartment.reconfigure(S.EditorState.readOnly.of(flags.readOnly)) });
      },
      // ranges: ordered [{from, to}]; activeIndex marks the current match.
      // An empty array clears both the overlay and the scrollbar ruler.
      highlightMatches(ranges, activeIndex) {
        const max = view.state.doc.length;
        const marks = [];
        rulerRanges = [];
        (ranges || []).forEach((range, index) => {
          const from = Math.max(0, Math.min(max, range.from));
          const to = Math.max(from, Math.min(max, range.to));
          if (to > from) {
            const active = index === activeIndex;
            marks.push((active ? activeMatchMark : matchMark).range(from, to));
            rulerRanges.push({ from, to, active });
          }
        });
        view.dispatch({ effects: matchesEffect.of(V.Decoration.set(marks, true)) });
        if (rulerRanges.length) scheduleRulerUpdate();
        else clearRuler();
      },
    };
  }

  async function boot() {
    if (!legacyRequested()) {
      try {
        return await createCodeMirror();
      } catch (err) {
        console.error("CodeMirror editor unavailable, falling back to the legacy editor", err);
      }
    }
    return window.IrisEditorLegacy.create(emit);
  }

  const api = {
    kind: "pending",
    ready: null,
    onChange(fn) { handlers.change.push(fn); },
    onCursor(fn) { handlers.cursor.push(fn); },
    focusTarget() { return impl ? impl.focusTarget() : null; },
    ownsTarget(node) { return impl ? impl.ownsTarget(node) : false; },
    getValue() { return impl ? impl.getValue() : ""; },
    selection() { return impl ? impl.selection() : { from: 0, to: 0, text: "" }; },
  };
  ["focus", "load", "applyText", "replaceRange", "select", "setWordWrap", "setAutoIndent", "setReadOnly", "highlightMatches"].forEach((method) => {
    api[method] = (...args) => { if (impl) impl[method](...args); };
  });
  api.ready = boot().then((instance) => {
    impl = instance;
    api.kind = instance.kind;
  });

  window.IrisEditor = api;
})();
