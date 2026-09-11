/* Iris - draft-only bibliography dialog; the editor owns every mutation. */
(function () {
  // getContext returns the current view's {documentKey, parsed, snapshot, canWrite}
  // or null while analysis is pending. getDocumentKey supplies the live session
  // identity independently of parsing and canonical IDs. Transitions invalidateContext.
  function create({ root, editor, t, getContext, getDocumentKey, onSource }) {
    const core = window.IrisBibliography, builder = window.IrisBibliographyEdit, motion = window.IrisMotion;
    const doc = root.ownerDocument, ui = {};
    for (const name of ["Title", "Type", "Types", "Key", "KeyRow", "Editing", "Fields", "More", "OtherFields",
      "NativeName", "Names", "AddField", "Error", "Warning", "Removal", "Discard", "Keep", "DiscardConfirm",
      "Close", "Cancel", "Apply", "Source"]) ui[name] = root.querySelector(`#bibliographyForm${name}`);
    let opened = null, fields = [], initial = "", serial = 0, leaving = false, sourceRequested = false, discardFocus = null;

    function element(tag, text, className) {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function draft() {
      return { type: ui.Type.value, key: opened.format === "bib" ? ui.Key.value || null : null,
        fields: fields.filter((field) => field.index !== null || field.value !== "")
          .filter((field) => field.editable)
          .map(({ index, name, value, remove }) => ({ index, name, value, remove })) };
    }
    function dirty() { return opened && opened.kind !== "remove" && JSON.stringify(draft()) !== initial; }
    function release() {
      opened?.bookmark?.dispose();
      opened = null; fields = []; sourceRequested = false; leaving = false;
    }
    function showError(key, params, control) {
      ui.Error.textContent = t(key, params); ui.Error.hidden = false;
      if (control) {
        control.setAttribute("aria-invalid", "true");
        if (ui.OtherFields.contains(control)) ui.More.open = true;
      }
      (control || ui.Error).focus();
      return false;
    }
    function clearError() {
      ui.Error.hidden = true; ui.Error.textContent = "";
      for (const input of [ui.Type, ui.Key, ...fields.map((field) => field.input).filter(Boolean)]) input.removeAttribute("aria-invalid");
    }
    function warning() {
      if (!opened) return;
      const renamed = opened.kind === "edit" && (opened.format === "bib" ? ui.Key.value !== (opened.entry.key || "") :
        fields.some((field) => field.name.toUpperCase() === "ID" &&
          (field.index === null ? field.value !== "" : field.remove || field.value !== opened.entry.fields[field.index].value)));
      ui.Warning.hidden = opened.kind !== "remove" && !renamed;
      ui.Warning.textContent = t(opened.kind === "remove" ? "bibliography.form.removeWarning" : "bibliography.form.renameWarning");
    }
    function renderFields() {
      const descriptors = core.fieldsForType(opened.format, ui.Type.value);
      // Suggest one native spelling per meaning, without hiding existing aliases.
      const meanings = new Set(fields.map((field) => core.describeField(opened.format, ui.Type.value, field.name).labelKey || field.name));
      for (const descriptor of descriptors) {
        const meaning = descriptor.labelKey || descriptor.name;
        if (meanings.has(meaning)) continue;
        meanings.add(meaning);
        fields.push({ index: null, name: descriptor.name, value: "", remove: false, editable: true });
      }
      const primary = new Set(descriptors.filter((field) => field.primary).map((field) => field.labelKey || field.name).slice(0, 10));
      ui.Fields.replaceChildren(); ui.OtherFields.replaceChildren(); ui.Names.replaceChildren();
      for (const descriptor of descriptors) {
        const option = element("option"); option.value = descriptor.name; ui.Names.appendChild(option);
      }
      const totals = new Map(), occurrences = new Map();
      for (const field of fields) {
        const native = field.name.toLowerCase();
        totals.set(native, (totals.get(native) || 0) + 1);
      }
      fields.forEach((field, position) => {
        const descriptor = core.describeField(opened.format, ui.Type.value, field.name);
        const native = field.name.toLowerCase(), number = (occurrences.get(native) || 0) + 1;
        occurrences.set(native, number);
        const name = descriptor.labelKey ? `${t(descriptor.labelKey)} (${field.name})` : field.name;
        const labelText = totals.get(native) > 1 ? t("bibliography.form.occurrence", { field: name, number }) : name;
        const wrapper = element("div", undefined, "field bibliography-form-field"), label = element("label", labelText, "label");
        wrapper.dataset.nativeName = field.name;
        const input = element("textarea", field.value, "input"); input.value = field.value; input.rows = 2;
        input.id = `bibliographyField${position}`; label.htmlFor = input.id;
        input.readOnly = !field.editable; input.disabled = field.remove;
        input.spellcheck = false; input.setAttribute("aria-describedby", "bibliographyFormError");
        const originalValue = opened.entry?.fields[field.index]?.value || "";
        input.addEventListener("input", () => {
          // Textareas expose LF even for CRLF/bare-CR values. A display no-op
          // must retain the original scalar rather than normalize source bytes.
          field.value = input.value === originalValue.replace(/\r\n?/g, "\n") ? originalValue : input.value;
          clearError(); warning();
        });
        field.input = input;
        wrapper.appendChild(label); wrapper.appendChild(input);
        if (!field.editable) {
          input.value = opened.entry.fields[field.index].raw;
          const source = element("button", t("bibliography.form.sourceOnly"), "btn sm"); source.type = "button";
          source.addEventListener("click", () => requestClose(true)); wrapper.appendChild(source);
        } else if (field.index !== null || field.value !== "") {
          const remove = element("input"); remove.type = "checkbox"; remove.checked = field.remove;
          const removeLabel = element("label", undefined, "bibliography-field-remove");
          removeLabel.appendChild(remove); removeLabel.appendChild(element("span", t("bibliography.form.removeField", { field: labelText })));
          remove.addEventListener("change", () => { field.remove = remove.checked; input.disabled = field.remove; clearError(); warning(); });
          wrapper.appendChild(removeLabel);
        }
        const main = descriptor.primary && primary.has(descriptor.labelKey || field.name);
        (main ? ui.Fields : ui.OtherFields).appendChild(wrapper);
      });
    }
    function open(kind, entryIndex) {
      if (opened || root.classList.contains("is-closing")) return false;
      const context = getContext(), snapshot = editor.snapshot();
      if (!context?.canWrite || !["valid", "empty"].includes(context.parsed.status) ||
        context.snapshot.revision !== snapshot.revision || context.snapshot.text !== snapshot.text) return false;
      const documentKey = getDocumentKey();
      if (!documentKey) return false;
      const entry = kind === "add" ? null : context.parsed.entries[entryIndex];
      if (kind !== "add" && (!Number.isInteger(entryIndex) || !entry)) return false;
      const bookmark = entry ? editor.trackRange(entry.from, entry.to) : null;
      if (entry && !bookmark.read()) { bookmark.dispose(); return false; }
      opened = { kind, entry, bookmark, format: context.parsed.format, documentKey, invalid: false };
      serial++; sourceRequested = false; leaving = false; ui.Discard.hidden = true; ui.More.open = false;
      ui.Title.textContent = t(`bibliography.form.${kind}`);
      ui.Type.value = entry?.type || (opened.format === "bib" ? "article" : "JOUR");
      ui.Key.value = entry?.key || ""; ui.KeyRow.hidden = opened.format !== "bib";
      ui.Types.replaceChildren();
      for (const type of (opened.format === "bib" ? "article book incollection inproceedings thesis report online misc" : "JOUR BOOK EDBOOK CHAP CONF THES RPRT ELEC GEN").split(" ")) {
        const option = element("option"); option.value = type; ui.Types.appendChild(option);
      }
      ui.Editing.hidden = kind === "remove"; ui.Removal.hidden = kind !== "remove";
      ui.Apply.textContent = t(kind === "remove" ? "bibliography.remove" : "common.apply");
      ui.Apply.classList.toggle("danger", kind === "remove");
      ui.NativeName.value = "";
      fields = (entry?.fields || []).map((field, index) => ({ index, name: field.rawName, value: field.value, remove: false, editable: field.editable }));
      if (kind === "remove") {
        const title = entry.fields.find((field) => core.describeField(opened.format, entry.type, field.name).labelKey === "bibliography.fields.title")?.value || "";
        const key = entry.key || entry.fields.find((field) => field.name === "ID")?.value || t("bibliography.reference", { number: entryIndex + 1 });
        ui.Removal.textContent = t("bibliography.form.removeEntry", { title, key });
      } else renderFields();
      clearError(); warning(); initial = JSON.stringify(draft());
      motion.openDialog(root);
      (kind === "remove" ? ui.Cancel : ui.Type).focus();
      return true;
    }
    async function finish(source = false) {
      const current = opened;
      if (!current) return false;
      const generation = serial, snapshot = editor.snapshot(), target = current.bookmark?.read() || null;
      leaving = true;
      const closed = await motion.closeDialog(root, { restoreFocus: !source });
      if (closed && source && serial === generation && getDocumentKey() === current.documentKey) {
        onSource(editor.snapshot().revision === snapshot.revision ? target : null);
      }
      return closed;
    }
    function confirmDiscard() {
      if (!ui.Discard.hidden) return;
      discardFocus = doc.activeElement; ui.Discard.hidden = false; ui.Keep.focus();
    }
    function requestClose(source = false) {
      if (!opened) return Promise.resolve(false);
      sourceRequested = source;
      if (dirty()) { confirmDiscard(); return Promise.resolve(false); }
      return finish(source);
    }
    function apply() {
      if (!opened || leaving || !ui.Discard.hidden) return false;
      clearError();
      const current = opened;
      const context = getContext();
      // A genuine context transition can synchronously close this dialog.
      if (opened !== current) return false;
      const target = opened.bookmark?.read();
      if (getDocumentKey() !== opened.documentKey || opened.invalid || (opened.bookmark && !target)) return showError("bibliography.form.conflict");
      if (!context) return showError("bibliography.form.pending");
      if (!context.canWrite) return showError("bibliography.form.conflict");
      const snapshot = editor.snapshot();
      const parsed = core.parse(snapshot.text, opened.format);
      if (parsed.format !== opened.format) return showError("bibliography.form.conflict");
      const result = builder.buildChanges(parsed, opened.kind === "remove" ? { kind: "remove", target } :
        { kind: opened.kind === "add" ? "add" : "update", target, draft: draft() });
      if (result.status === "conflict") return showError("bibliography.form.conflict");
      if (result.status === "invalid") {
        const diagnostic = result.diagnostics[0];
        const control = diagnostic.code === "bibliographyEdit.invalidType" ? ui.Type :
          ["bibliographyEdit.invalidKey", "bibliographyEdit.duplicateKey"].includes(diagnostic.code) ? ui.Key :
            fields.find((field) => field.index === diagnostic.params.index)?.input;
        // Reparse errors may describe the candidate, not the live buffer. Never
        // use these offsets for source navigation or an editor selection.
        return showError(`bibliography.diagnostics.${diagnostic.code}`, diagnostic.params, control);
      }
      if (result.status === "ready" && editor.applyChanges(result.changes, snapshot) !== "applied") return showError("bibliography.form.conflict");
      // Our own successful transaction invalidates the bookmark too. Still close.
      return finish();
    }
    function invalidateContext() {
      serial++;
      if (!opened) return;
      release();
      void motion.closeDialog(root, { force: true, immediate: true, restoreFocus: false });
    }
    root.addEventListener("iris:before-dialog-close", (event) => {
      if (event.detail?.force) { serial++; release(); return; }
      if (!opened) return;
      if (!leaving && dirty()) { event.preventDefault(); confirmDiscard(); return; }
      release();
    });
    root.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); void apply(); });
    ui.Close.addEventListener("click", () => requestClose());
    ui.Cancel.addEventListener("click", () => requestClose());
    ui.Source.addEventListener("click", () => requestClose(true));
    ui.Keep.addEventListener("click", () => { ui.Discard.hidden = true; sourceRequested = false; (discardFocus || ui.Type).focus(); });
    ui.DiscardConfirm.addEventListener("click", () => finish(sourceRequested));
    ui.Type.addEventListener("input", () => { if (opened) { clearError(); renderFields(); warning(); } });
    ui.Key.addEventListener("input", () => { clearError(); warning(); });
    ui.AddField.addEventListener("click", () => {
      if (!opened || !ui.NativeName.value.trim()) return;
      const name = opened.format === "bib" ? ui.NativeName.value.trim().toLowerCase() : ui.NativeName.value.trim().toUpperCase();
      fields.push({ index: null, name, value: "", remove: false, editable: true });
      ui.NativeName.value = ""; renderFields(); ui.More.open = true; fields.at(-1).input.focus();
    });
    editor.onLoad(() => { if (opened) { opened.invalid = true; opened.bookmark?.dispose(); } });
    return { openAdd: () => open("add"), openEdit: (index) => open("edit", index), openRemove: (index) => open("remove", index),
      apply, cancel: () => requestClose(), invalidateContext };
  }
  window.IrisBibliographyForm = { create };
})();
