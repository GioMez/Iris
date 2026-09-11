/* Iris - bibliography view over the authoritative editor snapshot. */
(function () {
  const core = window.IrisBibliography;

  function create({ root, editor, t, onSource, onFormat, actions = null }) {
    const doc = root.ownerDocument, ui = {};
    for (const name of ["Tabs", "TableTab", "TextTab", "TablePanel", "Status", "Source", "Retry",
      "Query", "QueryLabel", "Sort", "SortLabel", "ColumnPicker", "ColumnsLabel", "Columns", "ShowAll",
      "Diagnostics", "DiagnosticsLabel", "DiagnosticsDisclosure", "Table", "Head", "Rows", "Cards", "State",
      "Total", "Previous", "Next", "Caption", "Results", "Add", "Edit", "Remove", "Undo"]) ui[name] = root.querySelector(`#bibliography${name}`);
    const sourcePanel = doc.getElementById("bibliographyTextPanel");
    const exclusions = new Map(), checks = new Map(), sortTriggers = new Map(), listeners = [];
    let hiddenColumns = new Set(), projection = { columns: [], rows: [] };
    let diagnostics = [], columnOrder = "";
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
      for (const { input, index } of selections) input.checked = index === selected;
    }
    function selectionControl(index, layout) {
      const wrapper = element("label", undefined, "bibliography-select"), input = element("input");
      input.type = "radio"; input.name = `bibliography-selection-${layout}`;
      input.addEventListener("change", () => { if (context()) { selected = index; syncActions(); } });
      wrapper.appendChild(input); wrapper.appendChild(element("span", t("bibliography.select", { number: index + 1 })));
      selections.push({ input, index });
      return wrapper;
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
    function renderDiagnostics(entryIndices) {
      const current = parsed ? diagnostics : [];
      const shown = current.filter((item) => item.entryIndex < 0 || entryIndices.has(item.entryIndex));
      ui.Diagnostics.replaceChildren();
      ui.DiagnosticsDisclosure.hidden = !current.length;
      ui.DiagnosticsLabel.textContent = t("bibliography.diagnosticCount", { count: shown.length, total: current.length });
      for (const diagnostic of shown) {
        const row = element("li");
        const { entryIndex } = diagnostic;
        row.dataset.entryIndex = String(entryIndex);
        row.className = `bibliography-diagnostic ${diagnostic.severity}`;
        let expected = diagnostic.params.expected;
        if (expected && /[a-z]/.test(expected)) expected = t(`bibliography.expected.${expected}`);
        const message = t(`bibliography.diagnostics.${diagnostic.code}`, { ...diagnostic.params, expected });
        const prefix = t(diagnostic.severity === "error" ? "bibliography.error" : "bibliography.warning");
        const location = entryIndex < 0 ? "" : t("bibliography.reference", { number: entryIndex + 1 }) + ": ";
        row.appendChild(button(`${location}${prefix}: ${message}`, () => {
          if (context()) onSource({ from: diagnostic.from, to: diagnostic.to });
        }));
        ui.Diagnostics.appendChild(row);
      }
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
          input.type = "checkbox"; input.dataset.columnId = column.id;
          input.addEventListener("change", () => setColumnVisible(column.id, input.checked));
          wrapper.appendChild(input); wrapper.appendChild(text);
          check = { wrapper, input, text }; checks.set(column.id, check); changed = true;
        }
        check.input.checked = !hiddenColumns.has(column.id); check.text.textContent = label(column);
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
      ui.ShowAll.disabled = !hiddenColumns.size;
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
        SortLabel: "sort", ColumnsLabel: "columns", ShowAll: "showAll", Source: "showSource", Retry: "retry",
        Previous: "previous", Next: "next", Caption: "references", Add: "add", Edit: "edit", Remove: "remove", Undo: "undo" })) ui[name].textContent = t(`bibliography.${key}`);
      ui.Tabs.setAttribute("aria-label", t("bibliography.views"));
      ui.Query.value = query;
      const pending = !parsed && !failed;
      ui.Status.textContent = pending ? t("bibliography.analyzing") : failed ? t("bibliography.parseFailed")
        : parsed.status === "invalid" ? t("bibliography.invalid") : parsed.status === "unrecognized" ? t("bibliography.unrecognized") : "";
      ui.Status.hidden = !ui.Status.textContent;
      ui.Retry.hidden = !failed;
      ui.Results.setAttribute("aria-busy", String(pending));
      if (sort && (!projection.columns.some((column) => column.id === sort.id) || hiddenColumns.has(sort.id))) sort = null;
      const columns = core.visibleColumns(projection.columns, hiddenColumns);
      renderColumns(columns);
      const rows = tableAvailable() ? core.queryRows(projection, query, sort) : [];
      if (tableAvailable()) page = Math.max(0, Math.min(page, Math.ceil(rows.length / 100) - 1));
      const start = page * 100, end = Math.min(rows.length, start + 100);
      const currentRows = rows.slice(start, end);
      renderDiagnostics(new Set(currentRows.map((row) => row.entryIndex)));
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
          const go = () => { if (context()) { const entry = parsed.entries[row.entryIndex]; onSource({ from: entry.from, to: entry.to }); } };
          const cell = element("td");
          if (actions) { cell.appendChild(selectionControl(row.entryIndex, "table")); card.appendChild(selectionControl(row.entryIndex, "cards")); }
          cell.appendChild(button(t("bibliography.showSource"), go)); tr.appendChild(cell);
          card.appendChild(button(t("bibliography.showSource"), go));
          ui.Rows.appendChild(tr); ui.Cards.appendChild(card);
        }
      }
      syncMode();
      syncActions();
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
          if (revealSource) { mode = "text"; ui.DiagnosticsDisclosure.open = true; }
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
      // Invalidate rows now, but do no complete parsing in the input callback.
      render();
      timer = setTimeout(dispatch, 150);
    }
    function activate(next) {
      if (disposed) return;
      if (documentKey === next.documentKey) { refresh(); return; }
      stop(); documentKey = next.documentKey; hint = next.hint; selected = null;
      if (!exclusions.has(documentKey)) exclusions.set(documentKey, new Set());
      hiddenColumns = exclusions.get(documentKey);
      parsed = null; snapshot = null; failed = false; scheduledRevision = null;
      projection = { columns: [], rows: [] }; query = ""; sort = null; page = 0;
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
      stop(); documentKey = newKey; selected = null;
      if (!parsed || snapshot.revision !== editor.snapshot().revision) { parsed = null; render(); dispatch(); }
      else render();
    }
    function deactivate() {
      stop(); documentKey = null; parsed = null; snapshot = null; scheduledRevision = null; selected = null;
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
    listen(ui.Source, "click", () => onSource(null));
    listen(ui.Retry, "click", () => { stop(); failed = false; parsed = null; render(); dispatch(); });
    listen(ui.Query, "input", () => setQuery(ui.Query.value));
    listen(ui.Sort, "change", () => setSort(ui.Sort.value ? JSON.parse(ui.Sort.value) : null));
    listen(ui.ShowAll, "click", showAllColumns);
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
