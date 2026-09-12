/* Iris - bibliography view over the authoritative editor snapshot. */
(function () {
  const core = window.IrisBibliography;

  function create({ root, editor, t, onSource, onFormat, actions = null }) {
    const doc = root.ownerDocument, ui = {}, motion = window.IrisMotion;
    for (const name of ["Tabs", "TableTab", "TextTab", "TablePanel", "Status", "Notice", "Retry",
      "Query", "QueryLabel", "Sort", "SortLabel", "Filters", "FiltersLabel", "Columns", "ShowAll",
      "ColumnsButton", "ColumnsModal", "ColumnsClose", "ColumnsState", "Diagnostics", "DiagnosticsButton",
      "DiagnosticsModal", "DiagnosticsClose", "DiagnosticsState", "DiagnosticsTotal", "DiagnosticsPagination",
      "DiagnosticsPrevious", "DiagnosticsNext", "Table", "Head", "Rows", "Cards", "State",
      "Total", "Previous", "Next", "Caption", "Results", "Add", "Edit", "Remove", "Undo"]) ui[name] = doc.getElementById(`bibliography${name}`);
    const dialogs = ["Diagnostics", "Columns"];
    const sourcePanel = doc.getElementById("bibliographyTextPanel");
    const exclusions = new Map(), checks = new Map(), sortTriggers = new Map(), listeners = [];
    let hiddenColumns = new Set(), projection = { columns: [], rows: [] };
    let diagnostics = [], diagnosticReferences = [], columnOrder = "", diagnosticPage = 0, dialogGeneration = 0;
    let documentKey = null, hint = null, parsed = null, snapshot = null, scheduledRevision = null;
    let mode = "table", modeChosen = false, settled = false, query = "", sort = null, page = 0;
    let worker = null, busy = false, timer = null, latestRequestId = 0, failed = false, disposed = false;
    let selected = null, selections = [];

    function listen(node, event, fn) {
      node.addEventListener(event, fn);
      listeners.push(() => node.removeEventListener(event, fn));
    }
    function element(tag, text, className) {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function button(text, fn) {
      const node = element("button", text, "btn sm"); node.type = "button";
      node.addEventListener("click", fn);
      return node;
    }
    const columnLabels = new Map();
    const label = (column) => columnLabels.get(column.id);
    const tableAvailable = () => parsed && (parsed.status === "valid" || parsed.status === "empty");
    function context() {
      if (!documentKey || !parsed || snapshot.revision !== editor.snapshot().revision) return null;
      return { documentKey, parsed, snapshot };
    }
    function syncActions() {
      const writable = !!actions?.canWrite();
      ui.Add.disabled = !writable || !tableAvailable() || !context();
      ui.Edit.disabled = ui.Remove.disabled = ui.Add.disabled || selected === null;
      ui.Undo.disabled = !writable;
      for (const { node, index } of selections) node.setAttribute("aria-current", String(index === selected));
    }
    function selectable(node, index) {
      node.tabIndex = 0;
      node.setAttribute("aria-label", t("bibliography.select", { number: index + 1 }));
      const selection = { node, index }; selections.push(selection);
      const select = () => {
        if (context() && selections.includes(selection)) { selected = index; syncActions(); }
      };
      // Do not rerender or cancel clicks: native disclosures, focus and text Ranges survive.
      node.addEventListener("click", select);
      node.addEventListener("keydown", (event) => {
        if (event.target !== node || !["Enter", " "].includes(event.key)) return;
        event.preventDefault(); select();
      });
    }
    function syncMode() {
      root.hidden = !documentKey;
      root.classList.toggle("is-text", mode === "text");
      ui.TablePanel.hidden = mode !== "table";
      sourcePanel.hidden = !!documentKey && mode !== "text";
      if (documentKey) {
        sourcePanel.setAttribute("role", "tabpanel");
        sourcePanel.setAttribute("aria-labelledby", "bibliographyTextTab");
      } else {
        sourcePanel.removeAttribute("role"); sourcePanel.removeAttribute("aria-labelledby");
      }
      for (const [name, value] of [["TableTab", "table"], ["TextTab", "text"]]) {
        const selected = mode === value;
        ui[name].setAttribute("aria-selected", String(selected));
        ui[name].classList.toggle("on", selected); ui[name].tabIndex = selected ? 0 : -1;
      }
      ui.TableTab.setAttribute("aria-disabled", String(!tableAvailable()));
    }
    function setMode(next) {
      if (!documentKey || !["table", "text"].includes(next) || (next === "table" && !tableAvailable())) return;
      modeChosen = true;
      if (mode === next) return;
      mode = next; syncMode();
      if (mode === "text") { editor.requestMeasure(); editor.focus(); }
      else ui.TableTab.focus();
    }
    function focus() {
      if (!documentKey || disposed) return false;
      if (mode === "text") editor.focus();
      else ui.TableTab.focus();
      return true;
    }
    function closeDialogs(restoreFocus = false) {
      dialogGeneration++;
      for (const name of dialogs) {
        const modal = ui[`${name}Modal`];
        if (modal.classList.contains("on") || modal.classList.contains("is-closing")) {
          void motion.closeDialog(modal, { force: true, immediate: true, restoreFocus });
        }
      }
    }
    function restoreDialogFocus(name) {
      const modal = ui[`${name}Modal`];
      if (modal.classList.contains("on") && !modal.classList.contains("is-closing") && modal.getAttribute("aria-hidden") !== "true" &&
        (!modal.contains(doc.activeElement) || doc.activeElement.disabled)) ui[`${name}Close`].focus();
    }
    function renderDiagnostics() {
      const hadFocus = ui.DiagnosticsModal.contains(doc.activeElement);
      const current = context() ? diagnostics : [];
      diagnosticPage = Math.max(0, Math.min(diagnosticPage, Math.ceil(current.length / 100) - 1));
      const start = diagnosticPage * 100, end = Math.min(current.length, start + 100);
      const key = documentKey, result = parsed;
      const isCurrent = () => documentKey === key && parsed === result && context() && motion.activeSurface() === "app";
      ui.Diagnostics.replaceChildren();
      ui.DiagnosticsButton.disabled = !current.length;
      ui.DiagnosticsButton.classList.toggle("has-issues", !!current.length);
      ui.DiagnosticsButton.classList.toggle("has-errors", current.some((item) => item.severity === "error"));
      ui.DiagnosticsState.textContent = !parsed ? t(failed ? "bibliography.parseFailed" : "bibliography.analyzing")
        : !current.length ? t("bibliography.noDiagnostics") : "";
      ui.DiagnosticsState.hidden = !ui.DiagnosticsState.textContent;
      ui.DiagnosticsTotal.textContent = t("bibliography.diagnosticCount", { from: current.length ? start + 1 : 0, to: end, total: current.length });
      ui.DiagnosticsPagination.hidden = !current.length;
      ui.DiagnosticsPrevious.disabled = diagnosticPage === 0;
      ui.DiagnosticsNext.disabled = end >= current.length;
      for (const diagnostic of current.slice(start, end)) {
        const row = element("li");
        const { entryIndex } = diagnostic;
        row.dataset.entryIndex = String(entryIndex);
        row.className = `bibliography-diagnostic ${diagnostic.severity}`;
        let expected = diagnostic.params.expected;
        if (expected && /[a-z]/.test(expected)) expected = t(`bibliography.expected.${expected}`);
        const message = t(`bibliography.diagnostics.${diagnostic.code}`, { ...diagnostic.params, expected });
        const prefix = t(diagnostic.severity === "error" ? "bibliography.error" : "bibliography.warning");
        const reference = diagnosticReferences[entryIndex];
        let location = reference ? reference.value || t("bibliography.referenceWithoutIdentifier") : "";
        if (reference?.withLine) location = t("bibliography.referenceAtLine", { reference: location, line: reference.line });
        row.appendChild(button(`${location ? location + ": " : ""}${prefix}: ${message}`, async () => {
          const modal = ui.DiagnosticsModal;
          if (!isCurrent() || !ui.Diagnostics.contains(row) || !modal.classList.contains("on") || modal.classList.contains("is-closing")) return;
          const generation = dialogGeneration;
          const closed = await motion.closeDialog(modal);
          // Closing is asynchronous. A new revision, dialog or document cancels
          // this navigation rather than reusing an old offset in a new source.
          if (closed && generation === dialogGeneration && isCurrent()) onSource({ from: diagnostic.from, to: diagnostic.to });
        }));
        ui.Diagnostics.appendChild(row);
      }
      if (hadFocus) restoreDialogFocus("Diagnostics");
    }
    function renderColumns(columns) {
      const ids = new Set(projection.columns.map((column) => column.id));
      const order = JSON.stringify([...ids]);
      let changed = columnOrder !== order;
      for (const [id] of checks) if (!ids.has(id)) { checks.delete(id); changed = true; }
      for (const column of projection.columns) {
        let check = checks.get(column.id);
        if (!check) {
          const wrapper = element("label"), input = element("input"), text = element("span");
          const key = documentKey;
          input.type = "checkbox"; input.dataset.columnId = column.id;
          input.addEventListener("change", () => {
            if (documentKey === key && checks.get(column.id)?.input === input && context()) setColumnVisible(column.id, input.checked);
          });
          wrapper.appendChild(input); wrapper.appendChild(text);
          check = { wrapper, input, text }; checks.set(column.id, check); changed = true;
        }
        check.input.checked = !hiddenColumns.has(column.id); check.input.disabled = !context(); check.text.textContent = label(column);
      }
      // Ordinary visibility/search operations never detach the focused checkbox.
      if (changed) {
        columnOrder = order;
        const focused = doc.activeElement;
        ui.Columns.replaceChildren(...projection.columns.map((column) => checks.get(column.id).wrapper));
        if ([...checks.values()].some((check) => check.input === focused)) focused.focus();
      }
      ui.Sort.replaceChildren(element("option", t("bibliography.sourceOrder")));
      ui.Sort.children[0].value = "";
      for (const column of columns) for (const descending of [false, true]) {
        const option = element("option", t(descending ? "bibliography.sortDescending" : "bibliography.sortAscending", { field: label(column) }));
        option.value = JSON.stringify({ id: column.id, descending }); ui.Sort.appendChild(option);
      }
      ui.Sort.value = sort ? JSON.stringify(sort) : "";
      ui.ShowAll.disabled = !hiddenColumns.size || !context();
      ui.ColumnsButton.disabled = !projection.columns.length || !context();
      ui.ColumnsState.textContent = !parsed ? t(failed ? "bibliography.parseFailed" : "bibliography.analyzing")
        : !projection.columns.length ? t("bibliography.noColumns") : "";
      ui.ColumnsState.hidden = !ui.ColumnsState.textContent;
    }
    function valueNode(value, field) {
      if (!value) return element("span", t("bibliography.noValue"), "bibliography-missing");
      if (value.length <= 240) return element("span", value, "bibliography-value");
      const disclosure = element("details", undefined, "bibliography-full-value");
      const summary = element("summary");
      summary.appendChild(element("span", value.slice(0, 240).replace(/[\uD800-\uDBFF]$/, "") + "...", "bibliography-value-preview"));
      summary.appendChild(element("span", t("bibliography.fullValue", { field }), "bibliography-full-label"));
      disclosure.appendChild(summary);
      disclosure.appendChild(element("div", value, "bibliography-value"));
      return disclosure;
    }
    function render() {
      if (!documentKey) return;
      const focusedDialog = dialogs.find((name) => ui[`${name}Modal`].contains(doc.activeElement));
      const labels = new Map();
      for (const column of projection.columns) {
        const name = column.labelKey === null ? column.nativeName : t(column.labelKey);
        if (!labels.has(name)) labels.set(name, []);
        labels.get(name).push(column);
      }
      columnLabels.clear();
      for (const [name, columns] of labels) for (const column of columns) {
        columnLabels.set(column.id, columns.length > 1 ? `${name} (${column.nativeName})` : name);
      }
      for (const [name, key] of Object.entries({ TableTab: "table", TextTab: "text", QueryLabel: "searchAll",
        SortLabel: "sort", ShowAll: "showAll", Retry: "retry",
        Caption: "references" })) ui[name].textContent = t(`bibliography.${key}`);
      for (const [name, key] of Object.entries({ Previous: "previous", Next: "next", Add: "add", Edit: "edit", Remove: "remove", Undo: "undo" })) {
        ui[name].setAttribute("aria-label", t(`bibliography.${key}`));
        ui[name].title = t(`bibliography.${key}Title`);
      }
      ui.Tabs.setAttribute("aria-label", t("bibliography.views"));
      ui.Query.value = query;
      const pending = !parsed && !failed;
      ui.Status.textContent = pending ? t("bibliography.analyzing") : failed ? t("bibliography.parseFailed")
        : parsed.status === "invalid" ? t("bibliography.invalid") : parsed.status === "unrecognized" ? t("bibliography.unrecognized") : "";
      ui.Status.hidden = !ui.Status.textContent;
      ui.Retry.hidden = !failed;
      ui.Notice.hidden = ui.Status.hidden && ui.Retry.hidden;
      ui.Results.setAttribute("aria-busy", String(pending));
      if (sort && (!projection.columns.some((column) => column.id === sort.id) || hiddenColumns.has(sort.id))) sort = null;
      ui.FiltersLabel.textContent = [t("bibliography.filters"), query.trim() ? t("bibliography.searchActive") : "",
        sort ? t("bibliography.sortActive") : ""].filter(Boolean).join(" / ");
      ui.Filters.classList.toggle("is-active", !!query.trim() || !!sort);
      const columns = core.visibleColumns(projection.columns, hiddenColumns);
      renderColumns(columns);
      const rows = tableAvailable() ? core.queryRows(projection, query, sort) : [];
      if (tableAvailable()) page = Math.max(0, Math.min(page, Math.ceil(rows.length / 100) - 1));
      const start = page * 100, end = Math.min(rows.length, start + 100);
      const currentRows = rows.slice(start, end);
      renderDiagnostics();
      ui.Total.textContent = tableAvailable() ? t("bibliography.total", {
        from: rows.length ? start + 1 : 0, to: end,
        results: t("bibliography.resultCount", { count: rows.length }),
        references: t("bibliography.referenceCount", { count: projection.rows.length }),
      }) : "";
      ui.Previous.disabled = !tableAvailable() || page === 0; ui.Next.disabled = !tableAvailable() || end >= rows.length;
      ui.State.textContent = !tableAvailable() ? "" : parsed.status === "empty"
        ? t(parsed.text.trim() ? "bibliography.noReferences" : "bibliography.empty")
        : !columns.length ? t("bibliography.allHidden") : !rows.length ? t("bibliography.noResults") : "";
      ui.State.hidden = !ui.State.textContent;
      ui.Head.replaceChildren(); ui.Rows.replaceChildren(); ui.Cards.replaceChildren(); sortTriggers.clear();
      selections = [];
      ui.Table.hidden = !columns.length || !rows.length;
      if (columns.length && rows.length) {
        const header = element("tr");
        for (const column of columns) {
          const th = element("th"); th.scope = "col";
          th.setAttribute("aria-sort", sort?.id === column.id ? (sort.descending ? "descending" : "ascending") : "none");
          const trigger = button(label(column), () => {
            setSort(sort?.id !== column.id ? { id: column.id, descending: false } : sort.descending ? null : { id: column.id, descending: true });
            sortTriggers.get(column.id)?.focus();
          });
          trigger.dataset.sortId = column.id; sortTriggers.set(column.id, trigger); th.appendChild(trigger); header.appendChild(th);
        }
        const sourceHeader = element("th", t("bibliography.text")); sourceHeader.scope = "col"; header.appendChild(sourceHeader);
        ui.Head.appendChild(header);
        for (const row of currentRows) {
          const tr = element("tr"), card = element("article", undefined, "bibliography-card");
          tr.dataset.entryIndex = card.dataset.entryIndex = String(row.entryIndex);
          card.appendChild(element("h3", t("bibliography.reference", { number: row.entryIndex + 1 })));
          const list = element("dl"); card.appendChild(list);
          for (const column of columns) {
            const value = row.cells[column.id] || "", td = element("td");
            td.appendChild(valueNode(value, label(column))); tr.appendChild(td);
            list.appendChild(element("dt", label(column)));
            const dd = element("dd"); dd.appendChild(valueNode(value, label(column))); list.appendChild(dd);
          }
          const go = () => { if (context() && ui.Rows.contains(tr)) { const entry = parsed.entries[row.entryIndex]; onSource({ from: entry.from, to: entry.to }); } };
          const cell = element("td");
          if (actions) { selectable(tr, row.entryIndex); selectable(card, row.entryIndex); }
          cell.appendChild(button(t("bibliography.showSource"), go)); tr.appendChild(cell);
          card.appendChild(button(t("bibliography.showSource"), go));
          ui.Rows.appendChild(tr); ui.Cards.appendChild(card);
        }
      }
      syncMode();
      syncActions();
      if (focusedDialog) restoreDialogFocus(focusedDialog);
    }
    function stop() {
      clearTimeout(timer); timer = null; latestRequestId++;
      if (busy && worker) { worker.terminate(); worker = null; }
      busy = false;
    }
    function dispatch() {
      timer = null;
      if (!documentKey || disposed) return;
      const current = editor.snapshot(); snapshot = current; scheduledRevision = current.revision;
      const token = { documentKey, revision: current.revision, requestId: ++latestRequestId };
      const isCurrent = (message) => message.documentKey === documentKey &&
        message.revision === editor.snapshot().revision && message.requestId === latestRequestId;
      const fail = () => {
        if (!isCurrent(token)) return;
        busy = false; failed = true; parsed = null;
        if (worker) worker.terminate(); worker = null;
        render();
      };
      try {
        if (!worker) worker = new Worker("iris-bibliography-worker.js");
        worker.onmessage = ({ data: message }) => {
          if (!isCurrent(message)) return;
          if (message.error) { fail(); return; }
          busy = false; failed = false; parsed = message.result;
          projection = core.project(parsed);
          const counts = new Map();
          let offset = 0, line = 1;
          // Cache native labels and entry-start lines once per accepted source,
          // across the whole document, independently of either UI page or locale.
          diagnosticReferences = parsed.entries.map((entry) => {
            while (offset < entry.from) {
              if (parsed.text[offset] === "\r" || (parsed.text[offset] === "\n" && parsed.text[offset - 1] !== "\r")) line++;
              offset++;
            }
            let value = parsed.format === "bib" ? entry.key
              : entry.fields.find((field) => field.name === "ID" && field.value.trim())?.value;
            if (!value?.trim()) value = entry.fields.find((field) => field.value.trim() &&
              core.describeField(parsed.format, entry.type, field.name).labelKey === "bibliography.fields.title")?.value || "";
            counts.set(value, (counts.get(value) || 0) + 1);
            return { value, line };
          });
          for (const reference of diagnosticReferences) reference.withLine = !reference.value || counts.get(reference.value) > 1;
          diagnostics = [...parsed.diagnostics, ...core.metadataWarnings(parsed)].map((diagnostic) => {
            // Entry spans are source ordered; associate warnings once, without a
            // scan of every reference for every missing-metadata diagnostic.
            let low = 0, high = parsed.entries.length;
            while (low < high) {
              const mid = (low + high) >>> 1;
              if (parsed.entries[mid].from <= diagnostic.from) low = mid + 1; else high = mid;
            }
            const entryIndex = low - 1, entry = parsed.entries[entryIndex];
            return { ...diagnostic, entryIndex: entry && diagnostic.to <= entry.to ? entryIndex : -1 };
          });
          if (parsed.format) editor.setLanguage(parsed.format);
          // Tentative syntax can guide highlighting, but not remembered format.
          if (tableAvailable()) { hint = parsed.format; onFormat?.(documentKey, hint); }
          const revealSource = !settled && !modeChosen && !tableAvailable();
          const moveFocus = revealSource && (doc.activeElement === ui.TableTab || ui.TablePanel.contains(doc.activeElement));
          if (revealSource) mode = "text";
          settled = true;
          render();
          if (revealSource) {
            editor.requestMeasure();
            if (moveFocus) focus();
          }
        };
        worker.onerror = (event) => { event.preventDefault(); fail(); };
        worker.onmessageerror = fail;
        busy = true;
        worker.postMessage({ ...token, text: current.text, hint });
      } catch (_) { fail(); }
    }
    function refresh() {
      if (!documentKey || disposed) return;
      const current = editor.snapshot();
      if (current.revision === scheduledRevision) { render(); return; }
      stop(); parsed = null; snapshot = null; failed = false; scheduledRevision = current.revision; selected = null;
      diagnostics = []; diagnosticReferences = []; diagnosticPage = 0;
      // Invalidate rows now, but do no complete parsing in the input callback.
      render();
      timer = setTimeout(dispatch, 150);
    }
    function activate(next) {
      if (disposed) return;
      if (documentKey === next.documentKey) { refresh(); return; }
      closeDialogs(); checks.clear(); columnOrder = "";
      stop(); documentKey = next.documentKey; hint = next.hint; selected = null;
      if (!exclusions.has(documentKey)) exclusions.set(documentKey, new Set());
      hiddenColumns = exclusions.get(documentKey);
      parsed = null; snapshot = null; failed = false; scheduledRevision = null;
      projection = { columns: [], rows: [] }; query = ""; sort = null; page = 0;
      diagnostics = []; diagnosticReferences = []; diagnosticPage = 0; ui.Filters.open = false;
      const editing = next.editing === true;
      mode = editing ? "text" : "table"; modeChosen = editing; settled = false;
      if (editing) refresh();
      else { render(); dispatch(); }
    }
    function setColumnVisible(id, visible) {
      if (!projection.columns.some((column) => column.id === id)) return;
      if (visible) hiddenColumns.delete(id); else hiddenColumns.add(id);
      if (!visible && sort?.id === id) sort = null;
      render();
    }
    function showAllColumns() { hiddenColumns.clear(); render(); }
    function setQuery(text) { query = String(text); page = 0; selected = null; render(); }
    function setSort(next) {
      sort = next && projection.columns.some((column) => column.id === next.id && !hiddenColumns.has(column.id))
        ? { id: next.id, descending: !!next.descending } : null;
      page = 0; selected = null; render();
    }
    function setPage(index) { page = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0; selected = null; render(); }
    function rekey(oldKey, newKey) {
      if (oldKey === newKey) return;
      if (exclusions.has(oldKey)) { exclusions.set(newKey, exclusions.get(oldKey)); exclusions.delete(oldKey); }
      if (documentKey !== oldKey) return;
      closeDialogs(true); checks.clear(); columnOrder = "";
      stop(); documentKey = newKey; selected = null;
      if (!parsed || snapshot.revision !== editor.snapshot().revision) { parsed = null; render(); dispatch(); }
      else render();
    }
    function deactivate() {
      closeDialogs(); checks.clear(); columnOrder = "";
      stop(); documentKey = null; parsed = null; snapshot = null; scheduledRevision = null; selected = null;
      diagnostics = []; diagnosticReferences = []; diagnosticPage = 0;
      ui.Diagnostics.replaceChildren(); ui.Columns.replaceChildren();
      ui.DiagnosticsButton.disabled = ui.ColumnsButton.disabled = true;
      ui.DiagnosticsButton.classList.remove("has-issues", "has-errors");
      selections = [];
      projection = { columns: [], rows: [] }; ui.Rows.replaceChildren(); ui.Cards.replaceChildren();
      syncMode(); editor.requestMeasure();
    }
    listen(ui.TableTab, "click", () => setMode("table"));
    listen(ui.TextTab, "click", () => { setMode("text"); ui.TextTab.focus(); });
    listen(ui.Tabs, "keydown", (event) => {
      if (![ui.TableTab, ui.TextTab].includes(event.target) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = !tableAvailable() || event.key === "End" ? "text" : event.key === "Home" ? "table" : mode === "table" ? "text" : "table";
      setMode(next); ui[next === "table" ? "TableTab" : "TextTab"].focus();
    });
    for (const name of dialogs) {
      const modal = ui[`${name}Modal`];
      listen(ui[`${name}Button`], "click", () => {
        if (ui[`${name}Button`].disabled || !documentKey || disposed || motion.activeSurface() !== "app") return;
        dialogGeneration++; motion.openDialog(modal);
      });
      listen(ui[`${name}Close`], "click", () => { void motion.closeDialog(modal); });
      listen(modal, "click", (event) => { if (event.target === modal) void motion.closeDialog(modal); });
      listen(modal, "iris:before-dialog-close", (event) => { if (event.detail.force) dialogGeneration++; });
    }
    for (const [name, step] of [["DiagnosticsPrevious", -1], ["DiagnosticsNext", 1]]) {
      listen(ui[name], "click", () => { if (!ui[name].disabled) { diagnosticPage += step; renderDiagnostics(); } });
    }
    listen(ui.Retry, "click", () => { stop(); failed = false; parsed = null; render(); dispatch(); });
    listen(ui.Query, "input", () => setQuery(ui.Query.value));
    listen(ui.Sort, "change", () => setSort(ui.Sort.value ? JSON.parse(ui.Sort.value) : null));
    listen(ui.ShowAll, "click", () => { if (!ui.ShowAll.disabled) showAllColumns(); });
    listen(ui.Previous, "click", () => setPage(page - 1));
    listen(ui.Next, "click", () => setPage(page + 1));
    listen(ui.Add, "click", () => { if (!ui.Add.disabled) actions.add(); });
    listen(ui.Edit, "click", () => { if (!ui.Edit.disabled && context()) actions.edit(selected); });
    listen(ui.Remove, "click", () => { if (!ui.Remove.disabled && context()) actions.remove(selected); });
    listen(ui.Undo, "click", () => { if (actions?.canWrite()) editor.undo(); });
    return { activate, refresh, refreshAvailability: syncActions, setMode, focus, setColumnVisible, showAllColumns, setQuery, setSort, setPage, rekey, deactivate, context,
      dispose() { deactivate(); disposed = true; if (worker) worker.terminate(); worker = null; listeners.forEach((remove) => remove()); exclusions.clear(); } };
  }
  window.IrisBibliographyView = { create };
})();
