/* ===================== Iris · editor adapter (CodeMirror 6) ===================== */
// Single entry point for everything the app needs from the source editor:
// CodeMirror 6, loaded as native ES modules through the import map in Iris.html
// and served from /vendor/codemirror.
//
// Contract:
//   load(content, kind)        fresh document, no change event ("ly"|"tex"|null)
//   getValue()                 current document text
//   applyText(text)            whole-document edit (formatter), applied granularly
//   replaceRange(from, to, s)  ranged edit (find & replace)
//   selection()                { from, to, text, anchor, head }
//                              from/to are ordered; anchor/head keep the caret's
//                              side of the range, which is what presence reports
//   select(from, to, opts)     set selection and reveal it;
//                              opts { align: "top", margin: lines } for outline
//   highlightMatches(ranges, activeIndex)   find overlay + scrollbar ruler
//   setWordWrap / setAutoIndent / setReadOnly (booleans)
//   setSharedRegion({from, to, color} | null)  band over a contested construct
//   setDiagnostics(items) / diagnostics()    compiler markers, mapped across edits
//   focus() / focusTarget() / ownsTarget(node)
// Events: onChange(fn) after any edit;
//         onCursor(fn) with { line, column, fromLine, toLine, head, from, to }.
(function () {
  const LINE_H = 21;
  // Spaces that read as an ordinary gap and are not one. CodeMirror wants a
  // global regex to scan lines with; the membership test needs a separate
  // non-global copy, because `test` on a /g regex carries lastIndex forward.
  const INVISIBLE_SPACE_CLASS = "[\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]";
  const INVISIBLE_SPACES = new RegExp(INVISIBLE_SPACE_CLASS, "g");
  const IS_INVISIBLE_SPACE = new RegExp(INVISIBLE_SPACE_CLASS);
  const codePointLabel = (code) => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  const handlers = { change: [], cursor: [], sync: [], peers: [], load: [] };
  let impl = null;

  function emit(type, payload) {
    handlers[type].forEach((fn) => {
      try { fn(payload); } catch (err) { console.error("IrisEditor handler failed", err); }
    });
  }

  // A failed module load leaves the workspace without an editor, so it must be
  // stated in the pane instead of failing silently in the console.
  function reportUnavailable(err) {
    console.error("The CodeMirror editor could not be loaded", err);
    const editorEl = document.querySelector(".editor");
    if (!editorEl || editorEl.querySelector(".cm-unavailable")) return;
    const notice = document.createElement("div");
    notice.className = "cm-unavailable";
    notice.setAttribute("role", "alert");
    notice.dataset.i18n = "editor.unavailable";
    notice.textContent = window.IrisI18n ? window.IrisI18n.t("editor.unavailable") : "The editor could not be loaded.";
    editorEl.appendChild(notice);
  }

  async function createCodeMirror() {
    const [S, V, L, C, H, CO, A] = await Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/language"),
      import("@codemirror/commands"),
      import("@lezer/highlight"),
      import("@codemirror/collab"),
      import("@codemirror/autocomplete"),
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
    const diagnostics = window.IrisDiagnostics.createGutter(S, V);

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
    let completionContext = {};
    let completionTitle = "";
    const completionPhrases = new S.Compartment();
    const completionSyntax = { tex: window.IrisLatex, ly: window.IrisLilyPond };
    const completionSources = Object.fromEntries(["tex", "ly"].map((kind) =>
      [kind, window.IrisCompletion.createSource(kind, () => completionContext, completionSyntax)]));
    const completions = A.autocompletion({
      activateOnTyping: true,
      override: [(context) => completionSources[flags.kind]?.(context) || null],
      defaultKeymap: false,
    });
    // Only curly braces are paired. Lexical checks run in the brace handlers.
    const bracketConfig = S.EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["{"] } }]);
    const braceEffect = S.StateEffect.define({
      map(value, changes) {
        const pos = changes.mapPos(value.pos, -1, S.MapMode.TrackAfter);
        return pos == null ? undefined : { ...value, pos };
      },
    });
    const braceMark = new class extends S.RangeValue {};
    braceMark.startSide = 1;
    braceMark.endSide = -1;
    // Retain markers on every caret's line, not just the primary selection's.
    const braceMarkers = S.StateField.define({
      create: () => S.RangeSet.empty,
      update(markers, tr) {
        markers = markers.map(tr.changes);
        for (const effect of tr.effects) if (effect.is(braceEffect)) {
          const { pos, add } = effect.value;
          markers = add ? markers.update({ add: [braceMark.range(pos, pos + 1)] })
            : markers.update({ filterFrom: pos, filterTo: pos + 1, filter: (from) => from !== pos });
        }
        return markers;
      },
    });
    const canPairAt = (state, pos) => window.IrisCompletion.canPairBrace(
      flags.kind === "bib" ? "tex" : flags.kind, state.sliceDoc(0, pos), completionSyntax
    );
    const singleSelection = (state, range) => state.update({ selection: S.EditorSelection.create([range]) }).state;
    const bracketInput = S.Prec.highest(V.EditorView.inputHandler.of((view, from, to, text) => {
      if ((text !== "{" && text !== "}") || view.state.readOnly || view.composing || view.compositionStarted) return false;
      const state = view.state;
      if (from !== state.selection.main.from || to !== state.selection.main.to) return false;
      const changes = state.changeByRange((range) => {
        const allowed = canPairAt(state, range.from);
        if (text === "}" && allowed && range.empty && state.sliceDoc(range.from, range.from + 1) === "}") {
          let marked = false;
          state.field(braceMarkers).between(range.from, range.from + 1, (from) => { if (from === range.from) marked = true; });
          if (marked) return { range: S.EditorSelection.cursor(range.from + 1), effects: braceEffect.of({ pos: range.from, add: false }) };
        }
        const tr = text === "{" && allowed ? A.insertBracket(singleSelection(state, range), text) : null;
        return tr ? { changes: tr.changes, range: tr.state.selection.main, effects: braceEffect.of({ pos: tr.state.selection.main.to, add: true }) }
          : { changes: { from: range.from, to: range.to, insert: text }, range: S.EditorSelection.cursor(range.from + text.length) };
      });
      view.dispatch(changes, { scrollIntoView: true, userEvent: "input.type" });
      return true;
    }));
    const deleteBracePair = (view) => {
      const state = view.state;
      const between = (range) => range.empty && range.from > 0 && state.sliceDoc(range.from - 1, range.from + 1) === "{}";
      if (state.readOnly || !state.selection.ranges.some(between)) return false;
      const changes = state.changeByRange((range) => {
        let tr = null;
        const target = { state: singleSelection(state, range), dispatch: (transaction) => { tr = transaction; } };
        if (between(range) && canPairAt(state, range.from - 1)) A.deleteBracketPair(target);
        else C.deleteCharBackward(target);
        return tr ? { changes: tr.changes, range: tr.state.selection.main, effects: tr.effects } : { range };
      });
      if (changes.changes.empty) return false;
      view.dispatch(changes, { scrollIntoView: true, userEvent: "delete.backward" });
      return true;
    };
    const syntax = () => (flags.kind === "ly" ? window.IrisLilyPond : window.IrisLatex);
    const languageCompartment = new S.Compartment();
    const wrapCompartment = new S.Compartment();
    const readOnlyCompartment = new S.Compartment();
    let suppressEvents = false;
    // Identifies this tab's edits in the shared update stream for the lifetime of
    // the page, so the server and the other clients can tell them apart.
    const clientID = window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    let collaborative = false;
    // Confirmed updates this replica has applied, oldest first, each recorded
    // with the version it takes the document from. A peer reports its position
    // at the version it was on; this is what carries that position forward to
    // the version being drawn. Bounded, because a report older than the log is
    // one the next report supersedes anyway.
    const COLLAB_LOG_LIMIT = 400;
    let collabLog = [];

    // Tab inserts two spaces; Enter uses the syntax modules to complete blocks
    // and indent the inner line. Mod-Enter stays unbound so the global
    // compile shortcut keeps working from inside the editor.
    const insertText = (view, text) => {
      if (view.state.readOnly) return true;
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.type" });
      return true;
    };
    const enterCommand = (view) => {
      if (view.state.readOnly) return true;
      let value = view.state.doc.toString();
      const language = syntax();
      const plans = new Map();
      const ranges = view.state.selection.ranges;
      // Plan from right to left: earlier carets see the closers already added
      // for inner blocks. Each original source prefix still has stable offsets.
      for (let i = ranges.length - 1; i >= 0; i--) {
        const range = ranges[i];
        const line = view.state.doc.lineAt(range.from);
        const nextLine = value.indexOf("\n", range.from);
        const lineTo = nextLine < 0 ? value.length : nextLine;
        const block = flags.kind === "tex" || flags.kind === "ly" ? language.blockAtEnter(value, range.from) : null;
        const lead = flags.autoIndent ? line.text.match(/^[\t ]*/)[0] : "";
        let insert = flags.autoIndent ? language.indentOnEnter(value, range.from, block) : "\n";
        const caret = range.from + insert.length;
        let to = range.to;
        if (range.empty && block) {
          if (block.closingFrom != null && /^[\t ]*$/.test(value.slice(range.from, block.closingFrom))) {
            // Expand an inline pair, preserving the existing closing token.
            to = block.closingFrom;
            insert += "\n" + lead;
          } else if (block.needsClose && /^[\t ]*$/.test(value.slice(range.from, lineTo))) {
            to = lineTo;
            insert += "\n" + lead + block.close;
          }
        }
        plans.set(range, { changes: { from: range.from, to, insert }, range: S.EditorSelection.cursor(caret) });
        value = value.slice(0, range.from) + insert + value.slice(to);
      }
      const changes = view.state.changeByRange((range) => plans.get(range));
      view.dispatch(changes, { scrollIntoView: true, userEvent: "input.type" });
      return true;
    };
    const editorKeymap = [
      ...A.completionKeymap,
      { key: "Tab", run: A.acceptCompletion },
      { key: "Backspace", run: deleteBracePair },
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

    /* ---- presence: where the other participants are working ---- */
    // Peer positions arrive expressed at the sender's version and are then
    // carried forward through every local transaction, so they stay attached to
    // the text they pointed at. Association 1 keeps a peer's caret after the
    // text that peer is typing, rather than being pushed back by its own insert.
    // A peer reports where it is at the version it was on, which may be behind
    // this replica. The gap is closed by replaying the confirmed updates it had
    // not seen, then this tab's own unconfirmed ones, so the position lands on
    // the text it was actually pointing at. Without this a report that lags by a
    // single insert is drawn against text that has moved — barely visible when
    // the unit is a line, and plainly wrong once a position is attributed to a
    // structural region and named in a warning.
    function rebasePeerPos(pos, version) {
      if (pos == null || !collaborative) return pos == null ? null : pos;
      const synced = CO.getSyncedVersion(view.state);
      let mapped = pos;
      // A report from ahead of us, or from older than the retained log, is used
      // as it stands: the next one supersedes it either way.
      if (Number.isInteger(version) && version >= 0 && version < synced) {
        for (const entry of collabLog) {
          if (entry.version < version) continue;
          if (entry.version >= synced) break;
          mapped = entry.changes.mapPos(mapped, 1);
        }
      }
      CO.sendableUpdates(view.state).forEach((update) => { mapped = update.changes.mapPos(mapped, 1); });
      return mapped;
    }

    // A participant is drawn twice: its caret line carries the gutter bar and the
    // tint — a granularity that stays right even while an update is still in
    // flight — and its selection, when it has one, is shaded over the exact range
    // so what somebody is about to replace is visible before they replace it.
    const peersEffect = S.StateEffect.define();
    const peersField = S.StateField.define({
      create: () => [],
      update(peers, tr) {
        for (const effect of tr.effects) if (effect.is(peersEffect)) return effect.value;
        if (!tr.docChanged || !peers.length) return peers;
        return peers.map((peer) => ({
          ...peer,
          anchor: tr.changes.mapPos(peer.anchor, 1),
          head: tr.changes.mapPos(peer.head, 1),
        }));
      },
    });

    // The peer's selection as an ordered pair of offsets inside this document,
    // or null when it reports no position at all. `head` is the caret; `anchor`
    // is the end it was dragged from, so a range read backwards is still the
    // same range.
    function peerRange(state, peer) {
      if (peer.head == null) return null;
      const max = state.doc.length;
      const clamp = (value) => Math.max(0, Math.min(max, value));
      const head = clamp(peer.head);
      const anchor = peer.anchor == null ? head : clamp(peer.anchor);
      return { from: Math.min(anchor, head), to: Math.max(anchor, head), head };
    }

    // Line number (1-based) → the peers whose caret sits on it.
    function peersByLine(state) {
      const byLine = new Map();
      state.field(peersField).forEach((peer) => {
        const range = peerRange(state, peer);
        if (!range) return;
        const line = state.doc.lineAt(range.head);
        const list = byLine.get(line.number);
        if (list) list.push(peer);
        else byLine.set(line.number, [peer]);
      });
      return byLine;
    }

    class PeerMarker extends V.GutterMarker {
      constructor(peers) {
        super();
        this.peers = peers;
        this.key = peers.map((peer) => `${peer.id}:${peer.color}`).join("|");
      }
      eq(other) { return other.key === this.key; }
      toDOM() {
        const mark = document.createElement("div");
        mark.className = "cm-iris-peer-mark";
        const colors = this.peers.map((peer) => peer.color);
        // Several people on one line share the bar, split evenly between them.
        mark.style.background = colors.length === 1 ? colors[0] : `linear-gradient(${colors.map((color, index) =>
          `${color} ${(index / colors.length) * 100}%, ${color} ${((index + 1) / colors.length) * 100}%`).join(",")})`;
        mark.title = this.peers.map((peer) => peer.name || peer.username).filter(Boolean).join(", ");
        return mark;
      }
    }
    const peerSpacer = new PeerMarker([{ id: "spacer", color: "transparent" }]);

    const peerGutter = V.gutter({
      class: "cm-iris-peer-gutter",
      markers(view) {
        const marks = [];
        const byLine = peersByLine(view.state);
        Array.from(byLine.keys()).sort((a, b) => a - b).forEach((number) => {
          marks.push(new PeerMarker(byLine.get(number)).range(view.state.doc.line(number).from));
        });
        return S.RangeSet.of(marks, true);
      },
      initialSpacer: () => peerSpacer,
    });

    const peerLines = V.EditorView.decorations.compute([peersField], (state) => {
      const byLine = peersByLine(state);
      if (!byLine.size) return V.Decoration.none;
      const marks = Array.from(byLine.keys()).sort((a, b) => a - b).map((number) => {
        const line = state.doc.line(number);
        return V.Decoration.line({
          class: "cm-iris-peer-line",
          attributes: { style: `--peer-color:${byLine.get(number)[0].color}` },
        }).range(line.from);
      });
      return V.Decoration.set(marks, true);
    });

    // A peer's selection, shaded over the range itself. One decoration per
    // participant however long the selection is, so selecting a whole chapter
    // costs no more than selecting a word.
    const peerSelections = V.EditorView.decorations.compute([peersField], (state) => {
      const marks = [];
      state.field(peersField).forEach((peer) => {
        const range = peerRange(state, peer);
        // A bare caret has no range to shade; the gutter bar and the line tint
        // are what show it.
        if (!range || range.to === range.from) return;
        marks.push(V.Decoration.mark({
          class: "cm-iris-peer-selection",
          attributes: { style: `--peer-color:${peer.color}` },
        }).range(range.from, range.to));
      });
      return marks.length ? V.Decoration.set(marks, true) : V.Decoration.none;
    });

    /* ---- the region two people are contesting ---- */
    // Set by the app when structure says a participant is inside the same
    // construct as the local caret. It marks the extent of what is shared, so
    // the warning in the status bar has something to point at.
    const REGION_LINE_CAP = 300;
    const regionEffect = S.StateEffect.define();
    const regionField = S.StateField.define({
      create: () => null,
      update(region, tr) {
        for (const effect of tr.effects) if (effect.is(regionEffect)) return effect.value;
        if (!region || !tr.docChanged) return region;
        // The ends move with the text, so the band stays on the construct while
        // it is being edited rather than drifting off it.
        const from = tr.changes.mapPos(region.from, 1);
        const to = tr.changes.mapPos(region.to, -1);
        return to > from ? { ...region, from, to } : null;
      },
    });

    const regionLines = V.EditorView.decorations.compute([regionField], (state) => {
      const region = state.field(regionField);
      if (!region) return V.Decoration.none;
      const max = state.doc.length;
      const from = Math.max(0, Math.min(max, region.from));
      const to = Math.max(from, Math.min(max, region.to));
      const first = state.doc.lineAt(from).number;
      const last = state.doc.lineAt(to).number;
      // A construct this long is the document, not something two people are
      // jointly holding: naming it in the status bar helps, painting it does not.
      if (last - first > REGION_LINE_CAP) return V.Decoration.none;
      const marks = [];
      for (let number = first; number <= last; number++) {
        marks.push(V.Decoration.line({
          class: "cm-iris-peer-region",
          // Its own property: this decoration can land on the same line as the
          // caret tint, and the two must not overwrite each other's colour.
          attributes: { style: `--region-color:${region.color || "#e0af68"}` },
        }).range(state.doc.line(number).from));
      }
      return V.Decoration.set(marks, true);
    });

    // What the app needs to draw the footer and warn about overlaps: identity,
    // the line each participant's caret is on and the span its selection covers,
    // all in this document's coordinates.
    function peerSummary(state) {
      return state.field(peersField).map((peer) => {
        const range = peerRange(state, peer);
        if (!range) return { ...peer, line: null, fromLine: null, toLine: null };
        return {
          ...peer,
          line: state.doc.lineAt(range.head).number,
          fromLine: state.doc.lineAt(range.from).number,
          toLine: state.doc.lineAt(range.to).number,
        };
      });
    }
    const peerSignature = (summary) =>
      summary.map((peer) => `${peer.id}@${peer.fromLine}-${peer.toLine}:${peer.line}:${peer.role}`).join("|");
    let lastPeerSignature = "";
    function emitPeers(state) {
      const summary = peerSummary(state);
      const signature = peerSignature(summary);
      if (signature === lastPeerSignature) return;
      lastPeerSignature = signature;
      emit("peers", summary);
    }
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
      if (update.startState.field(peersField) !== update.state.field(peersField)) emitPeers(update.state);
      if (suppressEvents) return;
      if (update.docChanged) emit("change");
      if (update.docChanged || update.selectionSet) emitCursor(update.view);
      // Local edits waiting to be pushed to the OT authority. Remote updates
      // land through collabReceive and leave nothing sendable, so this only
      // fires for work this tab originated.
      if (collaborative && update.docChanged && CO.sendableUpdates(update.state).length) emit("sync");
    });
    // The caret for the status bar, plus the lines the selection spans: the
    // overlap warning compares areas, and a selection is an area even when the
    // caret sits at one end of it.
    function emitCursor(view) {
      const range = view.state.selection.main;
      const line = view.state.doc.lineAt(range.head);
      emit("cursor", {
        line: line.number,
        column: range.head - line.from + 1,
        fromLine: view.state.doc.lineAt(range.from).number,
        toLine: view.state.doc.lineAt(range.to).number,
        // Offsets too: structural containment is resolved against the document,
        // which knows nothing about lines.
        head: range.head,
        from: range.from,
        to: range.to,
      });
    }

    // `collabVersion` is the authoritative version this document starts from; it
    // is null for a document edited on its own, which is what keeps the ordinary
    // save path in charge when realtime is not available for a file.
    function makeState(content, collabVersion = null) {
      collaborative = collabVersion != null;
      // A fresh document or a resync invalidates every recorded change: nothing
      // a peer reported against the old text can be replayed onto this one.
      collabLog = [];
      return S.EditorState.create({
        doc: content,
        extensions: [
          // Without this CodeMirror resolves its own defaults as a light
          // theme: the drawn selection came out lavender over a dark editor.
          V.EditorView.darkTheme.of(true),
          V.lineNumbers(),
          diagnostics.extension,
          V.highlightActiveLineGutter(),
          // Characters that are invisible in the source but break a build: a
          // control code, a bidi mark, or one of the exotic spaces a paste out
          // of a word processor carries in. CodeMirror flags the first two on
          // its own; the spaces have to be named.
          V.highlightSpecialChars({
            addSpecialChars: INVISIBLE_SPACES,
            render(code, description) {
              if (!IS_INVISIBLE_SPACE.test(String.fromCharCode(code))) return null;
              const label = window.IrisI18n
                ? window.IrisI18n.t("editor.invisibleSpace", { code: codePointLabel(code) })
                : description;
              const node = document.createElement("span");
              node.className = "cm-specialChar cm-iris-invisible";
              node.textContent = "\u00b7";
              node.title = label;
              node.setAttribute("aria-label", label);
              return node;
            },
          }),
          // Selection and caret drawn by CodeMirror rather than the browser:
          // it is what makes several cursors and a column selection visible,
          // and it keeps the selection on screen while the find bar has focus.
          V.drawSelection(),
          V.dropCursor(),
          V.rectangularSelection(),
          V.crosshairCursor(),
          // LaTeX is brace-dense; pairing them is the difference between
          // reading a nested macro and counting it.
          L.bracketMatching(),
          peersField,
          peerGutter,
          peerLines,
          peerSelections,
          regionField,
          regionLines,
          C.history(),
          completions,
          completionPhrases.of(S.EditorState.phrases.of({ Completions: completionTitle || "Completions" })),
          bracketConfig,
          bracketInput,
          braceMarkers,
          V.keymap.of(editorKeymap),
          languageCompartment.of(flags.kind === "ly" ? languages.ly : languages.tex),
          irisHighlight,
          L.indentUnit.of("  "),
          wrapCompartment.of(flags.wordWrap ? V.EditorView.lineWrapping : []),
          readOnlyCompartment.of(S.EditorState.readOnly.of(flags.readOnly)),
          matchesField,
          listener,
          V.EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
          collaborative ? CO.collab({ startVersion: collabVersion, clientID }) : [],
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
        emit("load");
        emitCursor(view);
      },
      // Realtime variant: the document starts from an authoritative version and
      // its edits flow through the OT update stream. Used on join and whenever
      // the server sends a full resync.
      loadCollab(content, kind, { version }) {
        flags.kind = kind || null;
        const wasFocused = view.hasFocus;
        const previous = view.state.selection.main;
        suppressEvents = true;
        try {
          view.setState(makeState(content || "", Number(version) || 0));
        } finally {
          suppressEvents = false;
        }
        clearRuler();
        // A resync of the file already open should not throw the caret away;
        // positions are clamped because the document may have shrunk.
        if (previous.from || previous.to) {
          const max = view.state.doc.length;
          view.dispatch({ selection: { anchor: Math.min(previous.anchor, max), head: Math.min(previous.head, max) } });
        }
        if (wasFocused) view.focus();
        emit("load");
        emitCursor(view);
      },
      setDiagnostics(items) { view.dispatch({ effects: diagnostics.effect.of(items) }); },
      diagnostics() { return diagnostics.read(view.state); },
      setCompletionContext(context) {
        completionContext = context || {};
        A.closeCompletion(view);
        if (completionContext.suggestionsLabel && completionContext.suggestionsLabel !== completionTitle) {
          completionTitle = completionContext.suggestionsLabel;
          view.dispatch({ effects: completionPhrases.reconfigure(S.EditorState.phrases.of({ Completions: completionTitle })) });
        }
      },
      // Replaces the set of participants shown in the document. An empty list
      // clears them, which is what leaving or losing the connection does.
      setPeers(peers) {
        const max = view.state.doc.length;
        const place = (value, version) => {
          const rebased = rebasePeerPos(value, version);
          return rebased == null ? null : Math.max(0, Math.min(max, rebased));
        };
        const normalized = (peers || []).map((peer) => {
          const version = Number(peer.version);
          return {
            id: String(peer.id || ""),
            userId: String(peer.userId || ""),
            name: peer.name || peer.username || "",
            username: peer.username || "",
            color: peer.color || "#7aa2f7",
            role: peer.role || "viewer",
            anchor: place(peer.anchor, version),
            head: place(peer.head, version),
          };
        });
        view.dispatch({ effects: peersEffect.of(normalized) });
      },
      peers() { return peerSummary(view.state); },
      // Marks the construct the local caret shares with a participant, or clears
      // it with null. Idempotent: presence ticks far more often than the shared
      // region changes.
      setSharedRegion(region) {
        const current = view.state.field(regionField);
        const max = view.state.doc.length;
        if (!region || region.from == null || region.to == null) {
          if (current) view.dispatch({ effects: regionEffect.of(null) });
          return;
        }
        const from = Math.max(0, Math.min(max, region.from));
        const to = Math.max(from, Math.min(max, region.to));
        const color = region.color || "";
        if (to <= from) {
          if (current) view.dispatch({ effects: regionEffect.of(null) });
          return;
        }
        if (current && current.from === from && current.to === to && current.color === color) return;
        view.dispatch({ effects: regionEffect.of({ from, to, color }) });
      },
      collaborative() { return collaborative; },
      collabVersion() { return collaborative ? CO.getSyncedVersion(view.state) : 0; },
      // Local updates the server has not confirmed yet, in wire form.
      collabPending() {
        if (!collaborative) return null;
        const sendable = CO.sendableUpdates(view.state);
        if (!sendable.length) return null;
        return {
          version: CO.getSyncedVersion(view.state),
          updates: sendable.map((update) => ({ changes: update.changes.toJSON(), clientID: update.clientID })),
        };
      },
      // Applies updates accepted by the server. @codemirror/collab rebases any
      // pending local work over them and recognises this tab's own updates,
      // which is how a confirmed push advances the synced version.
      collabReceive(updates) {
        if (!collaborative || !Array.isArray(updates) || !updates.length) return;
        const parsed = updates.map((update) => ({
          changes: S.ChangeSet.fromJSON(update.changes),
          clientID: String(update.clientID || ""),
        }));
        let version = CO.getSyncedVersion(view.state);
        parsed.forEach((update) => {
          collabLog.push({ version, changes: update.changes });
          version += 1;
        });
        if (collabLog.length > COLLAB_LOG_LIMIT) collabLog.splice(0, collabLog.length - COLLAB_LOG_LIMIT);
        view.dispatch(CO.receiveUpdates(view.state, parsed));
      },
      // Formatter output applied as one localized change: prefix/suffix diff
      // keeps the selection in place and the operation granular for history
      // (and, later, for collaborative editing).
      applyText(next) {
        if (view.state.readOnly) return;
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
        if (view.state.readOnly) return;
        view.dispatch({ changes: { from, to, insert }, userEvent: "input.replace" });
      },
      selection() {
        const range = view.state.selection.main;
        return {
          from: range.from,
          to: range.to,
          text: view.state.sliceDoc(range.from, range.to),
          anchor: range.anchor,
          head: range.head,
        };
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
        if (flags.readOnly) A.closeCompletion(view);
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

  const api = {
    available: false,
    ready: null,
    onChange(fn) { handlers.change.push(fn); },
    onLoad(fn) { handlers.load.push(fn); },
    onCursor(fn) { handlers.cursor.push(fn); },
    // Fires when local edits are waiting for the realtime transport to push.
    onSync(fn) { handlers.sync.push(fn); },
    // Fires when the participants, or the lines they are on, change.
    onPeers(fn) { handlers.peers.push(fn); },
    focusTarget() { return impl ? impl.focusTarget() : null; },
    ownsTarget(node) { return impl ? impl.ownsTarget(node) : false; },
    getValue() { return impl ? impl.getValue() : ""; },
    selection() { return impl ? impl.selection() : { from: 0, to: 0, text: "", anchor: 0, head: 0 }; },
    collaborative() { return impl ? impl.collaborative() : false; },
    collabVersion() { return impl ? impl.collabVersion() : 0; },
    collabPending() { return impl ? impl.collabPending() : null; },
    peers() { return impl ? impl.peers() : []; },
    diagnostics() { return impl ? impl.diagnostics() : []; },
  };
  // Every mutating call is a no-op until the modules resolve, and stays one if
  // they never do, so the rest of the app needs no readiness checks.
  ["focus", "load", "loadCollab", "applyText", "replaceRange", "select", "setWordWrap", "setAutoIndent", "setReadOnly", "highlightMatches", "collabReceive", "setPeers", "setSharedRegion", "setDiagnostics", "setCompletionContext"].forEach((method) => {
    api[method] = (...args) => { if (impl) impl[method](...args); };
  });
  // Resolves either way: the app still boots (tree, preview, builds, history)
  // when the editor itself is unavailable.
  api.ready = createCodeMirror().then((instance) => {
    impl = instance;
    api.available = true;
  }, reportUnavailable);

  window.IrisEditor = api;
})();
