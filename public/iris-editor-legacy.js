/* ===================== Iris · legacy textarea editor ===================== */
// The pre-CodeMirror editor: a transparent textarea layered over a highlighted
// <pre> with a hand-synchronised gutter. Kept behind the temporary
// `?editor=legacy` switch while the CodeMirror 6 editor is validated; it is
// scheduled for removal at the end of the migration (NEXT_STEPS, fase 5).
//
// Implements the same contract as the CodeMirror editor in iris-editor.js:
// load/getValue/applyText/replaceRange/selection/select plus the wordWrap,
// autoIndent and readOnly switches. `emit("change")` fires on every edit;
// `emit("cursor", {line, column})` follows the caret.
(function () {
  const $ = (id) => document.getElementById(id);
  const LINE_H = 21;

  function create(emit) {
    const area = $("codeArea"), layer = $("codeLayer"), gutter = $("gutter");
    const codeWrap = $("codeWrap"), lineMeasure = $("lineMeasure");
    const editor = codeWrap.closest(".editor");
    const flags = { wordWrap: false, autoIndent: true, readOnly: false, kind: null };

    const syntax = () => (flags.kind === "ly" ? window.IrisLilyPond : window.IrisLatex);

    function paint() {
      layer.innerHTML = syntax().highlight(area.value) + "\n";
      updateEditorViewportInsets();
      renderGutter(area.value);
      syncScroll();
      updateCursor();
    }
    function wrappedLineHeights(lines) {
      if (!flags.wordWrap) {
        lineMeasure.replaceChildren();
        return null;
      }
      const style = getComputedStyle(area);
      const contentWidth = Math.max(1, area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
      lineMeasure.style.width = `${contentWidth}px`;
      const fragment = document.createDocumentFragment();
      lines.forEach((line) => {
        const row = document.createElement("span");
        row.className = "measure-line";
        row.textContent = line || "\u200b";
        fragment.appendChild(row);
      });
      lineMeasure.replaceChildren(fragment);
      return Array.from(lineMeasure.children, (row) => Math.max(LINE_H, row.offsetHeight));
    }
    function renderGutter(value = area.value) {
      const lines = value.split("\n");
      const heights = wrappedLineHeights(lines);
      const cur = curLine();
      let g = "";
      for (let i = 1; i <= lines.length; i++) {
        const height = heights ? heights[i - 1] : LINE_H;
        g += `<div class="gl${i === cur ? " cur" : ""}" style="height:${height}px">${i}</div>`;
      }
      gutter.innerHTML = g;
    }
    function sourcePositionTop(index) {
      const before = area.value.slice(0, Math.max(0, index));
      const lineNumber = before.split("\n").length;
      const gutterLine = gutter.children[lineNumber - 1];
      let top = gutterLine ? gutterLine.offsetTop : (lineNumber - 1) * LINE_H;
      if (!flags.wordWrap) return top;
      const prefix = before.slice(before.lastIndexOf("\n") + 1);
      const probe = document.createElement("span");
      probe.className = "measure-line";
      probe.textContent = prefix || "\u200b";
      lineMeasure.appendChild(probe);
      top += Math.max(0, probe.offsetHeight - LINE_H);
      probe.remove();
      return top;
    }
    function curLine() {
      return area.value.slice(0, cursorPosition()).split("\n").length;
    }
    function cursorPosition() {
      return area.selectionDirection === "backward" ? area.selectionStart : area.selectionEnd;
    }
    function updateCursor() {
      const pos = cursorPosition();
      const before = area.value.slice(0, pos);
      const line = before.split("\n").length;
      const column = pos - before.lastIndexOf("\n");
      gutter.querySelectorAll(".gl").forEach((el, i) => el.classList.toggle("cur", i + 1 === line));
      emit("cursor", { line, column });
    }
    function syncScroll() {
      layer.scrollTop = area.scrollTop;
      layer.scrollLeft = area.scrollLeft;
      gutter.scrollTop = area.scrollTop;
    }
    function updateEditorViewportInsets() {
      const horizontalScrollbar = Math.max(0, area.offsetHeight - area.clientHeight);
      const verticalScrollbar = Math.max(0, area.offsetWidth - area.clientWidth);
      editor.style.setProperty("--editor-hscroll", `${horizontalScrollbar}px`);
      editor.style.setProperty("--editor-vscroll", `${verticalScrollbar}px`);
    }

    let editorSyncFrame = 0;
    let editorSyncFramesRemaining = 0;
    let selectionDragActive = false;
    function runScrollSync() {
      syncScroll();
      if (!selectionDragActive && editorSyncFramesRemaining > 0) editorSyncFramesRemaining -= 1;
      if (selectionDragActive || editorSyncFramesRemaining > 0) {
        editorSyncFrame = requestAnimationFrame(runScrollSync);
      } else {
        editorSyncFrame = 0;
      }
    }
    function scheduleScrollSync() {
      // Native caret/selection auto-scroll can be committed after the current frame.
      editorSyncFramesRemaining = Math.max(editorSyncFramesRemaining, 2);
      if (!editorSyncFrame) editorSyncFrame = requestAnimationFrame(runScrollSync);
    }
    function startSelectionDrag(e) {
      if (e.button !== 0) return;
      selectionDragActive = true;
      scheduleScrollSync();
    }
    function stopSelectionDrag() {
      if (!selectionDragActive) return;
      selectionDragActive = false;
      scheduleScrollSync();
    }

    function insertAtCursor(text) {
      const s = area.selectionStart, e = area.selectionEnd;
      area.value = area.value.slice(0, s) + text + area.value.slice(e);
      area.selectionStart = area.selectionEnd = s + text.length;
      paint();
      emit("change");
    }

    area.addEventListener("input", () => { paint(); emit("change"); });
    area.addEventListener("scroll", () => { syncScroll(); scheduleScrollSync(); });
    area.addEventListener("select", () => { updateCursor(); scheduleScrollSync(); });
    area.addEventListener("pointerdown", startSelectionDrag);
    document.addEventListener("pointerup", stopSelectionDrag, true);
    document.addEventListener("pointercancel", stopSelectionDrag, true);
    window.addEventListener("blur", stopSelectionDrag);
    area.addEventListener("keyup", () => { updateCursor(); scheduleScrollSync(); });
    area.addEventListener("click", () => { updateCursor(); scheduleScrollSync(); });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        if (!flags.readOnly) insertAtCursor("  ");
      } else if (e.key === "Enter" && flags.autoIndent && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!flags.readOnly) insertAtCursor(syntax().indentOnEnter(area.value, area.selectionStart));
      }
      scheduleScrollSync();
    });
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === area) { updateCursor(); scheduleScrollSync(); }
    });
    if (window.ResizeObserver) {
      const editorResizeObserver = new ResizeObserver(() => {
        updateEditorViewportInsets();
        if (flags.wordWrap) renderGutter();
        scheduleScrollSync();
      });
      editorResizeObserver.observe(area);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        updateEditorViewportInsets();
        if (flags.wordWrap) renderGutter();
        scheduleScrollSync();
      });
    }

    return {
      kind: "legacy",
      focus() { area.focus(); },
      focusTarget() { return area; },
      ownsTarget(node) { return node === area; },
      getValue() { return area.value; },
      // Fresh document: no change event, caret at start, highlighting by kind.
      load(content, kind) {
        flags.kind = kind || null;
        area.value = content || "";
        paint();
      },
      // Whole-document replacement as an edit (formatter): the legacy editor
      // swaps the value and clamps the caret, like it always did.
      applyText(next) {
        if (next === area.value) return;
        const pos = area.selectionStart;
        area.value = next;
        area.selectionStart = area.selectionEnd = Math.min(pos, next.length);
        paint();
        emit("change");
      },
      replaceRange(from, to, insert) {
        area.value = area.value.slice(0, from) + insert + area.value.slice(to);
        paint();
        emit("change");
      },
      selection() {
        const from = area.selectionStart, to = area.selectionEnd;
        return { from, to, text: area.value.slice(from, to) };
      },
      select(from, to = from, opts = {}) {
        const len = area.value.length;
        const a = Math.max(0, Math.min(len, from));
        const b = Math.max(a, Math.min(len, to));
        area.setSelectionRange(a, b);
        if (opts.align === "top") {
          area.scrollTop = Math.max(0, sourcePositionTop(a) - (opts.margin || 0) * LINE_H);
        } else {
          const target = sourcePositionTop(a), viewH = area.clientHeight;
          if (target < area.scrollTop + 30 || target > area.scrollTop + viewH - 50) {
            area.scrollTop = Math.max(0, target - viewH / 2);
          }
        }
        syncScroll();
        updateCursor();
      },
      setWordWrap(on) {
        flags.wordWrap = !!on;
        editor.classList.toggle("wrap-on", flags.wordWrap);
        area.setAttribute("wrap", flags.wordWrap ? "soft" : "off");
        if (flags.wordWrap) area.scrollLeft = 0;
        paint();
        scheduleScrollSync();
      },
      setAutoIndent(on) { flags.autoIndent = !!on; },
      setReadOnly(on) {
        flags.readOnly = !!on;
        area.readOnly = flags.readOnly;
      },
      // The textarea cannot render match overlays; the current match stays
      // visible through the (inactive) native selection, as it always did.
      highlightMatches() {},
    };
  }

  window.IrisEditorLegacy = { create };
})();
