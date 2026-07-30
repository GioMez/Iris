/* ===================== Iris · versioned builds ===================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  const ti = (name, className = "") => window.IrisIcons.icon(name, className);
  const PAGE_SIZE = 50;

  const buildState = {
    builds: [],
    latestSuccessfulId: null,
    selectedId: null,
    detail: null,
    nextOffset: null,
    confirmDelete: false,
    busy: false,
    busyKind: null,
    busySeq: 0,
    listSeq: 0,
    detailSeq: 0,
    previewSeq: 0,
    operationSeq: 0,
  };

  const STATUS_KEY = {
    running: "statusRunning",
    succeeded: "statusSucceeded",
    failed: "statusFailed",
  };

  function statusLabel(status) {
    return t(`builds.${STATUS_KEY[status] || "statusFailed"}`);
  }

  function formatTime(value) {
    if (!value) return "";
    return window.IrisI18n.formatDate(new Date(value), {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function formatSize(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return t("builds.unitBytes", { value: window.IrisI18n.formatNumber(bytes) });
    if (bytes < 1024 * 1024) {
      return t("builds.unitKilobytes", { value: window.IrisI18n.formatNumber(Math.round(bytes / 102.4) / 10) });
    }
    return t("builds.unitMegabytes", { value: window.IrisI18n.formatNumber(Math.round(bytes / 104857.6) / 10) });
  }

  function isOwner() {
    return window.IrisProjects && window.IrisProjects.currentRole() === "owner";
  }

  function setListState(message, error = false) {
    const node = $("buildsListState");
    node.textContent = message || "";
    node.classList.toggle("error", !!error);
    node.setAttribute("role", error ? "alert" : "status");
    node.style.display = message ? "" : "none";
  }

  function setNotice(message, error = false) {
    const node = $("buildsNotice");
    node.textContent = message || "";
    node.classList.toggle("error", !!error);
    node.setAttribute("role", error ? "alert" : "status");
  }

  function reset() {
    buildState.listSeq += 1;
    buildState.detailSeq += 1;
    buildState.previewSeq += 1;
    buildState.operationSeq += 1;
    buildState.busySeq += 1;
    buildState.builds = [];
    buildState.latestSuccessfulId = null;
    buildState.selectedId = null;
    buildState.detail = null;
    buildState.nextOffset = null;
    buildState.confirmDelete = false;
    buildState.busy = false;
    buildState.busyKind = null;
    if ($("buildsModal").classList.contains("on")) {
      void window.IrisMotion.closeDialog("buildsModal", { immediate: true, restoreFocus: false });
    }
  }

  async function loadLatest(projectId) {
    const seq = ++buildState.previewSeq;
    try {
      const listed = await window.IrisProjects.listBuildOutputs({ limit: 50, offset: 0 });
      if (seq !== buildState.previewSeq || window.IrisProjects.currentProjectId() !== projectId) return;
      const latest = (listed.builds || []).find((build) => build.status !== "running");
      if (!latest) return;
      const payload = await window.IrisProjects.loadBuildOutput(latest.id);
      if (seq !== buildState.previewSeq || window.IrisProjects.currentProjectId() !== projectId) return;
      await window.IrisApp.showBuildOutput(payload, { activateWorkspace: false });
      if (seq !== buildState.previewSeq || window.IrisProjects.currentProjectId() !== projectId) return;
    } catch (error) {
      if (seq === buildState.previewSeq) console.warn("Unable to load the latest build preview", error);
    }
  }

  async function openHistory() {
    if (!window.IrisProjects.currentProjectId()) return;
    buildState.builds = [];
    buildState.selectedId = null;
    buildState.detail = null;
    buildState.nextOffset = null;
    buildState.confirmDelete = false;
    setNotice("");
    $("buildsList").innerHTML = "";
    renderDetail();
    window.IrisMotion.openDialog("buildsModal");
    await loadBuilds({ selectFirst: true });
  }

  async function loadBuilds({ append = false, selectFirst = false, reloadSelected = false } = {}) {
    const seq = ++buildState.listSeq;
    if (!append) {
      buildState.builds = [];
      buildState.nextOffset = null;
      setListState(t("builds.loading"));
      renderList();
    }
    const offset = append ? (buildState.nextOffset || 0) : 0;
    const more = $("buildsMore");
    more.disabled = true;
    try {
      const out = await window.IrisProjects.listBuildOutputs({ limit: PAGE_SIZE, offset });
      if (seq !== buildState.listSeq) return;
      const incoming = Array.isArray(out.builds) ? out.builds : [];
      const known = new Set(buildState.builds.map((build) => build.id));
      buildState.builds = append
        ? buildState.builds.concat(incoming.filter((build) => !known.has(build.id)))
        : incoming;
      buildState.latestSuccessfulId = out.latestSuccessfulId || null;
      buildState.nextOffset = out.nextOffset == null ? null : Number(out.nextOffset);
      setListState(buildState.builds.length ? "" : t("builds.empty"));
      renderList();
      const selectedExists = buildState.builds.some((build) => build.id === buildState.selectedId);
      if (!selectedExists) buildState.selectedId = null;
      if (!buildState.selectedId && selectFirst && buildState.builds.length) {
        await selectBuild(buildState.builds[0].id);
      } else if (buildState.selectedId && reloadSelected) {
        await selectBuild(buildState.selectedId);
      } else {
        renderDetail();
      }
    } catch (error) {
      if (seq !== buildState.listSeq) return;
      setListState(window.IrisI18n.error(error, "builds.loadFailed"), true);
      renderList();
    } finally {
      if (seq === buildState.listSeq) more.disabled = false;
    }
  }

  function renderList() {
    const host = $("buildsList");
    host.innerHTML = "";
    buildState.builds.forEach((build, index) => {
      const selected = build.id === buildState.selectedId;
      const latest = build.id === (buildState.builds[0] && buildState.builds[0].id);
      const item = document.createElement("button");
      item.type = "button";
      item.className = `build-item status-${build.status}${selected ? " on" : ""}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.dataset.buildId = build.id;
      item.tabIndex = selected || (!buildState.selectedId && index === 0) ? 0 : -1;
      item.innerHTML =
        `<span class="build-status-dot" aria-hidden="true"></span>` +
        `<span class="build-item-body">` +
          `<span class="build-item-top"><span class="build-status">${esc(statusLabel(build.status))}</span>` +
          (latest ? `<span class="build-latest">${esc(t("builds.latest"))}</span>` : "") + `</span>` +
          `<span class="build-when">${esc(formatTime(build.completedAt || build.createdAt))}</span>` +
          `<span class="build-who">${esc(build.author)} · ${esc(build.compiler)} · ${esc(String(build.format || "").toUpperCase())}</span>` +
        `</span>`;
      item.addEventListener("click", () => { if (!selected) void selectBuild(build.id); });
      host.appendChild(item);
    });
    $("buildsMore").hidden = buildState.nextOffset == null;
  }

  function beginBusy(kind) {
    const seq = ++buildState.busySeq;
    buildState.busy = true;
    buildState.busyKind = kind;
    return seq;
  }

  function finishBusy(seq) {
    if (seq !== buildState.busySeq) return;
    buildState.busy = false;
    buildState.busyKind = null;
    renderActions();
  }

  function cancelPreviewRequest() {
    buildState.previewSeq += 1;
    if (buildState.busyKind !== "preview") return;
    buildState.busySeq += 1;
    buildState.busy = false;
    buildState.busyKind = null;
    renderActions();
  }

  async function selectBuild(buildId) {
    cancelPreviewRequest();
    buildState.selectedId = buildId;
    buildState.detail = null;
    buildState.confirmDelete = false;
    setNotice("");
    renderList();
    renderDetail({ loading: true });
    const seq = ++buildState.detailSeq;
    try {
      const detail = await window.IrisProjects.getBuildOutput(buildId);
      if (seq !== buildState.detailSeq) return;
      buildState.detail = detail;
      renderDetail();
    } catch (error) {
      if (seq !== buildState.detailSeq) return;
      renderDetail({ error: window.IrisI18n.error(error, "builds.detailFailed") });
    }
  }

  function renderDetail(options = {}) {
    const summary = buildState.builds.find((build) => build.id === buildState.selectedId);
    const meta = $("buildsMeta");
    const view = $("buildsView");
    const actions = $("buildsActions");
    if (!summary) {
      meta.innerHTML = "";
      view.innerHTML = `<div class="build-placeholder">${esc(buildState.builds.length ? t("builds.select") : t("builds.emptyHint"))}</div>`;
      actions.innerHTML = "";
      return;
    }
    const latest = summary.id === buildState.latestSuccessfulId;
    meta.innerHTML =
      `<div class="build-meta-flags">` +
        `<span class="build-status-pill status-${esc(summary.status)}">${esc(statusLabel(summary.status))}</span>` +
        (latest ? `<span class="build-latest">${esc(t("builds.latestSuccessful"))}</span>` : "") +
      `</div>` +
      `<div class="build-meta-line"><span>${esc(formatTime(summary.completedAt || summary.createdAt))}</span><span>${esc(summary.author)}</span></div>`;
    if (options.loading) {
      view.innerHTML = `<div class="build-placeholder">${esc(t("builds.loadingDetail"))}</div>`;
      actions.innerHTML = "";
      return;
    }
    if (options.error) {
      view.innerHTML = `<div class="build-placeholder error">${esc(options.error)}</div>`;
      actions.innerHTML = "";
      return;
    }
    if (!buildState.detail) {
      view.innerHTML = `<div class="build-placeholder">${esc(t("builds.loadingDetail"))}</div>`;
      actions.innerHTML = "";
      return;
    }
    const build = buildState.detail.build;
    const files = buildState.detail.files || [];
    const warnings = Array.isArray(build.warnings) ? build.warnings.length : 0;
    const errors = Array.isArray(build.errors) ? build.errors.length : 0;
    const revision = build.sourceRevisionId ? build.sourceRevisionId.slice(0, 8) : t("builds.hashOnly");
    const fileRows = files.length
      ? files.map((file, index) =>
        `<div class="build-artifact">` +
          `<span class="build-artifact-icon">${ti("file")}</span>` +
          `<span class="build-artifact-name"><b>${esc(file.path)}</b><span>${esc(formatSize(file.size))} · ${esc(file.mimeType)}</span></span>` +
          `<button class="node-act" type="button" data-build-file="${index}" aria-label="${esc(t("builds.downloadAria", { name: file.path }))}" title="${esc(t("common.download"))}">${ti("download")}</button>` +
        `</div>`).join("")
      : `<div class="build-empty-block">${esc(t("builds.noFiles"))}</div>`;
    const log = build.log
      ? `<details class="build-log"${build.status === "failed" ? " open" : ""}><summary>${esc(t("builds.compilerLog"))}</summary><pre>${esc(build.log)}</pre></details>`
      : "";
    view.innerHTML =
      `<div class="build-overview">` +
        `<div class="build-facts">` +
          `<div><span>${esc(t("builds.compiler"))}</span><b>${esc(build.compiler)}</b></div>` +
          `<div><span>${esc(t("builds.format"))}</span><b>${esc(String(build.format || "").toUpperCase())}</b></div>` +
          `<div><span>${esc(t("builds.duration"))}</span><b>${esc(t("builds.seconds", { value: ((Number(build.durationMs) || 0) / 1000).toFixed(1) }))}</b></div>` +
          `<div><span>${esc(t("builds.totalSize"))}</span><b>${esc(formatSize(buildState.detail.directorySize == null ? build.size : buildState.detail.directorySize))}</b></div>` +
        `</div>` +
        `<div class="build-source"><span>${ti("file-code-2")}</span><div><span>${esc(t("builds.source"))}</span><b>${esc(build.mainPath)}</b><code>${esc(t("builds.revision", { id: revision }))}</code></div></div>` +
        `<div class="build-diagnostics">` +
          `<span class="${warnings ? "warn" : ""}">${ti("alert-triangle")} ${esc(t("builds.warningCount", { count: warnings }))}</span>` +
          `<span class="${errors ? "error" : ""}">${ti("circle-x")} ${esc(t("builds.errorCount", { count: errors }))}</span>` +
        `</div>` +
        `<h4>${esc(t("builds.files", { count: files.length }))}</h4>` +
        `<div class="build-artifacts">${fileRows}</div>` +
        log +
      `</div>`;
    view.querySelectorAll("[data-build-file]").forEach((button) => button.addEventListener("click", () => {
      const file = files[Number(button.dataset.buildFile)];
      if (file) void downloadFile(file, button);
    }));
    renderActions();
  }

  function renderActions() {
    const actions = $("buildsActions");
    const detail = buildState.detail;
    if (!detail) { actions.innerHTML = ""; return; }
    const build = detail.build;
    const disabled = buildState.busy ? " disabled" : "";
    if (buildState.confirmDelete) {
      actions.innerHTML =
        `<span class="build-confirm">${esc(t("builds.deleteConfirm"))}</span>` +
        `<button class="btn sm" type="button" data-build-act="cancel-delete"${disabled}>${esc(t("common.cancel"))}</button>` +
        `<button class="btn danger sm" type="button" data-build-act="confirm-delete"${disabled}>${esc(t("common.delete"))}</button>`;
    } else {
      actions.innerHTML =
        (isOwner()
          ? `<button class="btn danger sm build-delete" type="button" data-build-act="delete"${disabled}>${ti("trash")}<span>${esc(t("common.delete"))}</span></button>`
          : "") +
        `<span class="spring"></span>` +
        (detail.archiveUrl
          ? `<button class="btn sm" type="button" data-build-act="download-archive"${disabled}>${ti("download")}<span>${esc(t("builds.downloadArchive"))}</span></button>`
          : "") +
        `<button class="btn cta sm" type="button" data-build-act="preview"${build.status === "running" || buildState.busy ? " disabled" : ""}>${ti("file")}<span>${esc(t("builds.showPreview"))}</span></button>`;
    }
    actions.querySelectorAll("[data-build-act]").forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.buildAct;
      if (action === "preview") void previewSelected();
      else if (action === "download-archive") void downloadArchive();
      else if (action === "delete") {
        buildState.confirmDelete = true;
        renderActions();
        actions.querySelector('[data-build-act="cancel-delete"]')?.focus();
      }
      else if (action === "cancel-delete") {
        buildState.confirmDelete = false;
        renderActions();
        actions.querySelector('[data-build-act="delete"]')?.focus();
      }
      else if (action === "confirm-delete") void deleteSelected();
    }));
  }

  async function previewSelected() {
    if (buildState.busy || !buildState.selectedId) return;
    const buildId = buildState.selectedId;
    const projectId = window.IrisProjects.currentProjectId();
    const seq = ++buildState.previewSeq;
    const busySeq = beginBusy("preview");
    setNotice(t("builds.loadingPreview"));
    renderActions();
    try {
      const payload = await window.IrisProjects.loadBuildOutput(buildId);
      if (seq !== buildState.previewSeq || window.IrisProjects.currentProjectId() !== projectId) return;
      await window.IrisApp.showBuildOutput(payload);
      if (seq !== buildState.previewSeq || window.IrisProjects.currentProjectId() !== projectId) return;
      setNotice("");
      await window.IrisMotion.closeDialog("buildsModal");
    } catch (error) {
      if (seq !== buildState.previewSeq) return;
      setNotice(window.IrisI18n.error(error, "builds.previewFailed"), true);
    } finally {
      finishBusy(busySeq);
    }
  }

  async function downloadFile(file, button = null) {
    if (button) button.disabled = true;
    try {
      await window.IrisProjects.downloadBuildFile(file);
      setNotice("");
    } catch (error) {
      setNotice(window.IrisI18n.error(error, "builds.downloadFailed"), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function downloadArchive() {
    if (buildState.busy || !buildState.detail) return;
    const busySeq = beginBusy("download");
    renderActions();
    try {
      await window.IrisProjects.downloadBuildArchive(buildState.detail);
      setNotice("");
    } catch (error) {
      setNotice(window.IrisI18n.error(error, "builds.archiveFailed"), true);
    } finally {
      finishBusy(busySeq);
    }
  }

  async function deleteSelected() {
    if (buildState.busy || !buildState.selectedId || !isOwner()) return;
    const deletedId = buildState.selectedId;
    const projectId = window.IrisProjects.currentProjectId();
    const operationSeq = ++buildState.operationSeq;
    const busySeq = beginBusy("delete");
    renderActions();
    try {
      try {
        await window.IrisProjects.deleteBuildOutput(deletedId);
      } catch (error) {
        if (operationSeq !== buildState.operationSeq) return;
        buildState.confirmDelete = false;
        setNotice(window.IrisI18n.error(error, "builds.deleteFailed"), true);
        renderActions();
        return;
      }
      if (operationSeq !== buildState.operationSeq || window.IrisProjects.currentProjectId() !== projectId) return;

      const wasPreviewed = window.IrisApp.currentBuildId() === deletedId;
      buildState.selectedId = null;
      buildState.detail = null;
      buildState.confirmDelete = false;
      await loadBuilds({ selectFirst: true });
      if (operationSeq !== buildState.operationSeq || window.IrisProjects.currentProjectId() !== projectId) return;
      setNotice(t("builds.deleted"));
      if (!wasPreviewed) return;

      const latestCompleted = buildState.builds.find((build) => build.status !== "running");
      if (!latestCompleted) {
        await window.IrisApp.clearBuildOutput(deletedId);
        return;
      }
      const previewSeq = ++buildState.previewSeq;
      try {
        const payload = await window.IrisProjects.loadBuildOutput(latestCompleted.id);
        if (previewSeq !== buildState.previewSeq || window.IrisProjects.currentProjectId() !== projectId) return;
        await window.IrisApp.showBuildOutput(payload, { activateWorkspace: false });
      } catch (error) {
        if (previewSeq !== buildState.previewSeq) return;
        await window.IrisApp.clearBuildOutput(latestCompleted.id);
        await window.IrisApp.clearBuildOutput(deletedId);
        setNotice(t("builds.deletedPreviewFailed"), true);
      }
    } finally {
      finishBusy(busySeq);
    }
  }

  async function refreshBuilds() {
    const button = $("buildsRefresh");
    button.disabled = true;
    try {
      await loadBuilds({ selectFirst: true, reloadSelected: true });
    } finally {
      button.disabled = false;
    }
  }

  function moveListSelection(event) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !buildState.builds.length) return;
    event.preventDefault();
    let index = buildState.builds.findIndex((build) => build.id === buildState.selectedId);
    if (event.key === "Home") index = 0;
    else if (event.key === "End") index = buildState.builds.length - 1;
    else if (event.key === "ArrowDown") index = Math.min(buildState.builds.length - 1, Math.max(-1, index) + 1);
    else index = Math.max(0, index < 0 ? buildState.builds.length - 1 : index - 1);
    const buildId = buildState.builds[index].id;
    void selectBuild(buildId);
    requestAnimationFrame(() => {
      const option = $("buildsList").querySelector(`[data-build-id="${buildId}"]`);
      if (option) option.focus();
    });
  }

  function refreshLocalizedUi() {
    if (!$("buildsModal").classList.contains("on")) return;
    renderList();
    renderDetail();
  }

  function wire() {
    $("btnBuilds").addEventListener("click", () => { void openHistory(); });
    $("buildsRefresh").addEventListener("click", () => { void refreshBuilds(); });
    $("buildsMore").addEventListener("click", () => { void loadBuilds({ append: true }); });
    $("buildsList").addEventListener("keydown", moveListSelection);
    document.addEventListener("iris:buildcompleted", () => {
      cancelPreviewRequest();
      if ($("buildsModal").classList.contains("on")) void loadBuilds({ selectFirst: true, reloadSelected: true });
    });
    document.addEventListener("iris:languagechange", refreshLocalizedUi);
  }

  window.IrisBuilds = { loadLatest, openHistory, reset };
  window.IrisI18n.ready.then(wire);
})();
