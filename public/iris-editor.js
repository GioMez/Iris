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
//   selection()                { from, to, text }
//   select(from, to, opts)     set selection and reveal it;
//                              opts { align: "top", margin: lines } for outline
//   highlightMatches(ranges, activeIndex)   find overlay + scrollbar ruler
//   setWordWrap / setAutoIndent / setReadOnly (booleans)
//   focus() / focusTarget() / ownsTarget(node)
// Events: onChange(fn) after any edit; onCursor(fn) with { line, column }.
(function () {
  const LINE_H = 21;
  const handlers = { change: [], cursor: [], sync: [], peers: [] };
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
    notice.textContent = window.IrisI18n ? window.IrisI18n.t("editor.unavailable") : "The editor could not be loaded.";
    editorEl.appendChild(notice);
  }

  async function createCodeMirror() {
    const [S, V, L, C, H, CO] = await Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/language"),
      import("@codemirror/commands"),
      import("@lezer/highlight"),
      import("@codemirror/collab"),
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
    // Identifies this tab's edits in the shared update stream for the lifetime of
    // the page, so the server and the other clients can tell them apart.
    const clientID = window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    let collaborative = false;

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

    /* ---- presence: where the other participants are working ---- */
    // Peer positions arrive expressed at the sender's version and are then
    // carried forward through every local transaction, so they stay attached to
    // the text they pointed at. Association 1 keeps a peer's caret after the
    // text that peer is typing, rather than being pushed back by its own insert.
    // They are shown per line, a granularity that stays right even while an
    // update is still in flight.
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

    // Line number (1-based) → the peers whose caret sits on it.
    function peersByLine(state) {
      const byLine = new Map();
      state.field(peersField).forEach((peer) => {
        if (peer.head == null) return;
        const pos = Math.max(0, Math.min(state.doc.length, peer.head));
        const line = state.doc.lineAt(pos);
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

    // What the app needs to draw the footer and warn about overlaps: identity
    // plus the line each participant is on, in this document's coordinates.
    function peerSummary(state) {
      return state.field(peersField).map((peer) => {
        const pos = peer.head == null ? null : Math.max(0, Math.min(state.doc.length, peer.head));
        return { ...peer, line: pos == null ? null : state.doc.lineAt(pos).number };
      });
    }
    const peerSignature = (summary) => summary.map((peer) => `${peer.id}@${peer.line}:${peer.role}`).join("|");
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
    function emitCursor(view) {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      emit("cursor", { line: line.number, column: head - line.from + 1 });
    }

    // `collabVersion` is the authoritative version this document starts from; it
    // is null for a document edited on its own, which is what keeps the ordinary
    // save path in charge when realtime is not available for a file.
    function makeState(content, collabVersion = null) {
      collaborative = collabVersion != null;
      return S.EditorState.create({
        doc: content,
        extensions: [
          V.lineNumbers(),
          V.highlightActiveLineGutter(),
          peersField,
          peerGutter,
          peerLines,
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
        emitCursor(view);
      },
      // Replaces the set of participants shown in the document. An empty list
      // clears them, which is what leaving or losing the connection does.
      setPeers(peers) {
        const max = view.state.doc.length;
        const normalized = (peers || []).map((peer) => ({
          id: String(peer.id || ""),
          userId: String(peer.userId || ""),
          name: peer.name || peer.username || "",
          username: peer.username || "",
          color: peer.color || "#7aa2f7",
          role: peer.role || "viewer",
          anchor: peer.anchor == null ? null : Math.max(0, Math.min(max, peer.anchor)),
          head: peer.head == null ? null : Math.max(0, Math.min(max, peer.head)),
        }));
        view.dispatch({ effects: peersEffect.of(normalized) });
      },
      peers() { return peerSummary(view.state); },
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
        view.dispatch(CO.receiveUpdates(view.state, updates.map((update) => ({
          changes: S.ChangeSet.fromJSON(update.changes),
          clientID: String(update.clientID || ""),
        }))));
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

  const api = {
    available: false,
    ready: null,
    onChange(fn) { handlers.change.push(fn); },
    onCursor(fn) { handlers.cursor.push(fn); },
    // Fires when local edits are waiting for the realtime transport to push.
    onSync(fn) { handlers.sync.push(fn); },
    // Fires when the participants, or the lines they are on, change.
    onPeers(fn) { handlers.peers.push(fn); },
    focusTarget() { return impl ? impl.focusTarget() : null; },
    ownsTarget(node) { return impl ? impl.ownsTarget(node) : false; },
    getValue() { return impl ? impl.getValue() : ""; },
    selection() { return impl ? impl.selection() : { from: 0, to: 0, text: "" }; },
    collaborative() { return impl ? impl.collaborative() : false; },
    collabVersion() { return impl ? impl.collabVersion() : 0; },
    collabPending() { return impl ? impl.collabPending() : null; },
    peers() { return impl ? impl.peers() : []; },
  };
  // Every mutating call is a no-op until the modules resolve, and stays one if
  // they never do, so the rest of the app needs no readiness checks.
  ["focus", "load", "loadCollab", "applyText", "replaceRange", "select", "setWordWrap", "setAutoIndent", "setReadOnly", "highlightMatches", "collabReceive", "setPeers"].forEach((method) => {
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
