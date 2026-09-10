/* ===================== Iris · admin project templates ===================== */
/* Template source is editable only through the administrator API. Metadata is
   rendered as text and source is assigned to a textarea value, never to HTML. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  const api = (path, options) => window.IrisNet.request(path, options);
  const openDialog = (id) => window.IrisMotion.openDialog(id);
  const closeDialog = (id, options) => window.IrisMotion.closeDialog(id, options);
  const MAX_SOURCE_BYTES = 1024 * 1024;
  const TYPES = ["latex", "lilypond"];

  let templates = [];
  let loadSequence = 0;
  let detailSequence = 0;
  let loadFailed = false;
  let formBusy = false;
  let formLocked = false;
  let formReady = false;
  let editTarget = null;
  let loadedDetail = null;
  let deleteTarget = null;
  let deleteBusy = false;

  function isAdmin() {
    return document.documentElement.dataset.role === "admin";
  }

  function extensionFor(type) {
    return type === "lilypond" ? ".ly" : ".tex";
  }

  function typeLabel(type) {
    return t(type === "lilypond" ? "adminTemplates.typeLilypond" : "adminTemplates.typeLatex");
  }

  function formatSize(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return t("adminTemplates.unitBytes", { value: window.IrisI18n.formatNumber(bytes) });
    if (bytes < MAX_SOURCE_BYTES) {
      return t("adminTemplates.unitKilobytes", { value: window.IrisI18n.formatNumber(Math.round(bytes / 102.4) / 10) });
    }
    return t("adminTemplates.unitMegabytes", { value: window.IrisI18n.formatNumber(Math.round(bytes / 104857.6) / 10) });
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function status(message, isError = false, retry = null) {
    const output = $("adminTemplateStatusMsg");
    const button = $("adminTemplateStatusRetry");
    output.textContent = message || "";
    output.classList.toggle("error", isError);
    output.setAttribute("role", isError ? "alert" : "status");
    output.setAttribute("aria-live", isError ? "assertive" : "polite");
    button.hidden = !retry;
    button.onclick = retry ? () => {
      $("adminTemplatesTitle").focus();
      retry();
    } : null;
  }

  function modalStatus(message) {
    $("adminTemplateModalStatus").textContent = message || "";
  }

  function modalError(error, retry = false) {
    const output = $("adminTemplateError");
    output.textContent = error ? window.IrisI18n.error(error, "adminTemplates.detailLoadFailed") : "";
    output.style.display = error ? "flex" : "none";
    $("adminTemplateDetailRetry").hidden = !retry;
  }

  function sourceBytes() {
    return new TextEncoder().encode($("adminTemplateContent").value).byteLength;
  }

  function updateCounter() {
    const bytes = sourceBytes();
    const tooLarge = bytes > MAX_SOURCE_BYTES;
    const counter = $("adminTemplateCounter");
    counter.textContent = t("adminTemplates.sourceCounter", {
      size: t("adminTemplates.unitBytes", { value: window.IrisI18n.formatNumber(bytes) }),
      limit: formatSize(MAX_SOURCE_BYTES),
    });
    counter.classList.toggle("error", tooLarge);
    if (tooLarge) $("adminTemplateContent").setAttribute("aria-invalid", "true");
    else $("adminTemplateContent").removeAttribute("aria-invalid");
    $("adminTemplateSave").disabled = formBusy || !formReady || tooLarge;
  }

  function setFormBusy(value, lockDialog = false) {
    formBusy = value;
    formLocked = value && lockDialog;
    const disabled = formBusy || !formReady;
    $("adminTemplateForm").querySelectorAll("input,select,textarea").forEach((control) => {
      control.disabled = disabled;
    });
    $("adminTemplateForm").toggleAttribute("aria-busy", formBusy);
    $("adminTemplateSave").classList.toggle("loading", formBusy);
    $("adminTemplateDelete").hidden = !editTarget || !formReady;
    $("adminTemplateDelete").disabled = formBusy || !formReady;
    $("adminTemplateDetailRetry").disabled = formBusy;
    $("adminTemplateClose").disabled = formLocked;
    $("adminTemplateCancel").disabled = formLocked;
    updateCounter();
  }

  function updateExtension() {
    $("adminTemplateExtension").textContent = extensionFor($("adminTemplateType").value);
  }

  function updateFormLabels() {
    const editing = !!editTarget;
    $("adminTemplateModalTitle").textContent = t(editing ? "adminTemplates.editTitle" : "adminTemplates.newTitle");
    $("adminTemplateSave").textContent = t(editing ? "adminTemplates.saveButton" : "adminTemplates.createButton");
  }

  function fillForm(template) {
    $("adminTemplateTitle").value = template.title || "";
    $("adminTemplateId").value = template.id || "";
    $("adminTemplateType").value = TYPES.includes(template.type) ? template.type : "latex";
    $("adminTemplateDescription").value = template.description || "";
    $("adminTemplateDefault").checked = !!template.default;
    $("adminTemplateContent").value = template.content || "";
    updateExtension();
    updateCounter();
  }

  function bodyFromForm() {
    return {
      id: $("adminTemplateId").value.trim(),
      title: $("adminTemplateTitle").value.trim(),
      description: $("adminTemplateDescription").value.trim(),
      type: $("adminTemplateType").value,
      default: $("adminTemplateDefault").checked,
      content: $("adminTemplateContent").value,
    };
  }

  function render() {
    const body = $("adminTemplateRows");
    const empty = $("adminTemplateEmpty");
    const filter = $("adminTemplateTypeFilter").value;
    const visible = filter ? templates.filter((template) => template.type === filter) : templates;
    body.replaceChildren();
    if (loadFailed) {
      empty.style.display = "none";
      return;
    }
    if (!visible.length) {
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";

    visible.forEach((template) => {
      const row = document.createElement("tr");
      row.dataset.templateType = template.type;
      row.dataset.templateId = template.id;

      const identityCell = document.createElement("td");
      identityCell.appendChild(node("div", "admin-template-name", template.title || template.id));
      identityCell.appendChild(node("code", "admin-template-file", `${template.id}${extensionFor(template.type)}`));
      if (template.description) identityCell.appendChild(node("p", "admin-template-description", template.description));
      row.appendChild(identityCell);

      const typeCell = document.createElement("td");
      typeCell.appendChild(node("span", `admin-badge admin-template-type type-${template.type}`, typeLabel(template.type)));
      row.appendChild(typeCell);

      const defaultCell = document.createElement("td");
      if (template.default) defaultCell.appendChild(node("span", "admin-badge admin-template-default", t("adminTemplates.defaultBadge")));
      row.appendChild(defaultCell);

      row.appendChild(node("td", "admin-template-size", formatSize(template.size)));

      const actionCell = node("td", "admin-col-actions");
      const edit = node("button", "admin-row-edit");
      edit.type = "button";
      // Icon through the declarative hydrator: this module never assigns HTML.
      edit.appendChild(document.createElement("span")).dataset.icon = "edit";
      edit.appendChild(node("span", null, t("adminTemplates.edit")));
      window.IrisIcons.hydrate(edit);
      edit.setAttribute("aria-label", t("adminTemplates.editAria", { name: template.title || template.id }));
      edit.addEventListener("click", () => openEdit(template));
      actionCell.appendChild(edit);
      row.appendChild(actionCell);
      body.appendChild(row);
    });
  }

  async function load({ preserveStatus = false } = {}) {
    if (!isAdmin()) return false;
    const sequence = ++loadSequence;
    loadFailed = false;
    if (!preserveStatus) status(t("common.loading"));
    $("adminTemplateTableWrap").classList.add("loading");
    $("adminTemplateTableWrap").setAttribute("aria-busy", "true");
    try {
      const data = await api("/api/admin/templates");
      if (sequence !== loadSequence) return false;
      const groups = data && data.templates ? data.templates : {};
      templates = TYPES.flatMap((type) => Array.isArray(groups[type])
        ? groups[type].map((template) => ({ ...template, type }))
        : []);
      loadFailed = false;
      render();
      if (!preserveStatus) status("");
      return true;
    } catch (error) {
      if (sequence !== loadSequence) return false;
      templates = [];
      loadFailed = true;
      render();
      status(window.IrisI18n.error(error, "adminTemplates.loadFailed"), true, () => { void load(); });
      return false;
    } finally {
      if (sequence === loadSequence) {
        $("adminTemplateTableWrap").classList.remove("loading");
        $("adminTemplateTableWrap").removeAttribute("aria-busy");
      }
    }
  }

  function openCreate() {
    detailSequence += 1;
    editTarget = null;
    loadedDetail = null;
    formReady = true;
    modalError(null);
    modalStatus("");
    fillForm({ type: "latex" });
    updateFormLabels();
    setFormBusy(false);
    openDialog("adminTemplateModal");
    setTimeout(() => $("adminTemplateTitle").focus(), 50);
  }

  async function loadDetail() {
    if (!editTarget) return;
    const target = { ...editTarget };
    const sequence = ++detailSequence;
    formReady = false;
    modalError(null);
    modalStatus(t("adminTemplates.loadingTemplate"));
    setFormBusy(true);
    try {
      const data = await api(`/api/admin/templates/${target.type}/${encodeURIComponent(target.id)}`);
      if (sequence !== detailSequence) return;
      loadedDetail = data.template;
      fillForm(loadedDetail);
      formReady = true;
      modalStatus("");
      setFormBusy(false);
      if ($("adminTemplateModal").classList.contains("on")) $("adminTemplateTitle").focus();
    } catch (error) {
      if (sequence !== detailSequence) return;
      loadedDetail = null;
      formReady = false;
      modalStatus("");
      modalError(error, true);
      setFormBusy(false);
    }
  }

  function openEdit(template) {
    editTarget = { type: template.type, id: template.id };
    loadedDetail = null;
    formReady = false;
    modalError(null);
    fillForm(template);
    updateFormLabels();
    setFormBusy(true);
    openDialog("adminTemplateModal");
    void loadDetail();
  }

  function focusTemplate(template) {
    const row = Array.from($("adminTemplateRows").children).find((candidate) =>
      candidate.dataset.templateType === template.type && candidate.dataset.templateId === template.id);
    const action = row && row.querySelector(".admin-row-edit");
    if (action) action.focus();
    else $("adminTemplatesTitle").focus();
  }

  async function submitTemplate(event) {
    event.preventDefault();
    if (formBusy || !formReady) return;
    if (sourceBytes() > MAX_SOURCE_BYTES) {
      modalError({ code: "PROJECT_TEMPLATE_TOO_LARGE" });
      $("adminTemplateContent").focus();
      return;
    }
    const previous = editTarget ? { ...editTarget } : null;
    const payload = bodyFromForm();
    setFormBusy(true, true);
    try {
      const data = await api(previous
        ? `/api/admin/templates/${previous.type}/${encodeURIComponent(previous.id)}`
        : "/api/admin/templates", {
        method: previous ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      const saved = data.template || payload;
      await closeDialog("adminTemplateModal");
      editTarget = null;
      loadedDetail = null;
      formReady = false;
      if (await load({ preserveStatus: true })) {
        status(t(previous ? "adminTemplates.updated" : "adminTemplates.created", { name: saved.title || saved.id }));
        focusTemplate(saved);
      }
    } catch (error) {
      modalError(error);
    } finally {
      setFormBusy(false);
    }
  }

  function updateDeleteText() {
    if (!deleteTarget) return;
    $("adminTemplateDeleteText").textContent = t("adminTemplates.deleteText", {
      name: deleteTarget.title || deleteTarget.id,
    });
  }

  function askDelete() {
    if (!editTarget || !loadedDetail || formBusy) return;
    deleteTarget = {
      type: editTarget.type,
      id: editTarget.id,
      title: loadedDetail.title,
    };
    $("adminTemplateDeleteError").style.display = "none";
    updateDeleteText();
    openDialog("adminTemplateDeleteModal");
    setTimeout(() => $("adminTemplateDeleteOk").focus(), 50);
  }

  async function cancelDelete() {
    if (deleteBusy) return;
    await closeDialog("adminTemplateDeleteModal");
    deleteTarget = null;
  }

  function setDeleteBusy(value) {
    deleteBusy = value;
    ["adminTemplateDeleteClose", "adminTemplateDeleteCancel", "adminTemplateDeleteOk"].forEach((id) => {
      $(id).disabled = deleteBusy;
    });
    $("adminTemplateDeleteOk").classList.toggle("loading", deleteBusy);
    $("adminTemplateDeleteForm").toggleAttribute("aria-busy", deleteBusy);
  }

  async function confirmDelete(event) {
    event.preventDefault();
    if (!deleteTarget || deleteBusy) return;
    const target = { ...deleteTarget };
    setDeleteBusy(true);
    try {
      await api(`/api/admin/templates/${target.type}/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      await closeDialog("adminTemplateDeleteModal");
      await closeDialog("adminTemplateModal");
      deleteTarget = null;
      editTarget = null;
      loadedDetail = null;
      formReady = false;
      if (await load({ preserveStatus: true })) {
        status(t("adminTemplates.deleted", { name: target.title || target.id }));
        $("adminTemplatesTitle").focus();
      }
    } catch (error) {
      const output = $("adminTemplateDeleteError");
      output.textContent = window.IrisI18n.error(error);
      output.style.display = "flex";
    } finally {
      setDeleteBusy(false);
    }
  }

  function activate() {
    if (isAdmin()) void load();
  }

  function wire() {
    $("adminTemplateNew").addEventListener("click", openCreate);
    $("adminTemplateTypeFilter").addEventListener("change", render);
    $("adminTemplateType").addEventListener("change", updateExtension);
    $("adminTemplateContent").addEventListener("input", updateCounter);
    $("adminTemplateForm").addEventListener("submit", (event) => { void submitTemplate(event); });
    $("adminTemplateForm").addEventListener("input", () => modalError(null));
    $("adminTemplateForm").addEventListener("change", () => modalError(null));
    $("adminTemplateDetailRetry").addEventListener("click", () => { void loadDetail(); });
    $("adminTemplateDelete").addEventListener("click", askDelete);
    $("adminTemplateDeleteForm").addEventListener("submit", (event) => { void confirmDelete(event); });
    $("adminTemplateDeleteCancel").addEventListener("click", () => { void cancelDelete(); });
    $("adminTemplateDeleteClose").addEventListener("click", () => { void cancelDelete(); });
    ["adminTemplateClose", "adminTemplateCancel"].forEach((id) => {
      $(id).addEventListener("click", () => { detailSequence += 1; });
    });
    $("adminTemplateModal").addEventListener("click", (event) => {
      if (event.target === $("adminTemplateModal") && !formBusy) void closeDialog("adminTemplateModal");
    });
    $("adminTemplateDeleteModal").addEventListener("click", (event) => {
      if (event.target === $("adminTemplateDeleteModal")) void cancelDelete();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const writeLocked = formLocked && $("adminTemplateModal").classList.contains("on");
      const deleteLocked = deleteBusy && $("adminTemplateDeleteModal").classList.contains("on");
      if (!writeLocked && !deleteLocked) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  window.IrisAdminTemplates = { activate };
  window.IrisI18n.ready.then(() => {
    wire();
    document.addEventListener("iris:languagechange", () => {
      if (templates.length) render();
      updateFormLabels();
      updateCounter();
      updateDeleteText();
    });
  });
})();
