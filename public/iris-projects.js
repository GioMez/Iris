/* ===================== Iris · projects ===================== */
/* Schermata di scelta progetti + persistenza backend.
   Il backend tiene auth/metadati in PostgreSQL e salva lo snapshot del progetto
   in una cartella dedicata sul filesystem. */
(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  const openModal = (id) => window.IrisMotion.openDialog(id);
  const closeModal = (id) => window.IrisMotion.closeDialog(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ti = (name, className = "", label = "") => window.IrisIcons.icon(name, className, label);

  let index = [];
  let currentId = null;
  let unsavedDecision = null;
  let openGeneration = 0;
  let openRequestGeneration = 0;
  let saveQueue = Promise.resolve(false);
  const cache = new Map();
  const clone = (data) => JSON.parse(JSON.stringify(data));

  const ROLE_KEY = { owner: "roleOwner", editor: "roleEditor", viewer: "roleViewer" };
  const PROJECT_ROLES = ["owner", "editor", "viewer"];
  const roleLabel = (role) => t(`projects.${ROLE_KEY[role] || "roleOwner"}`);
  // Mirrors the server rule: ownership answers for the project and stays with the
  // organisation, so an external member is never offered it. The refusal is the
  // server's; this only keeps the menu from proposing something that would fail.
  const isExternalUser = () => document.documentElement.dataset.role === "external";
  const rolesForMember = (external) => (external ? PROJECT_ROLES.filter((role) => role !== "owner") : PROJECT_ROLES);

  const api = (path, options) => window.IrisNet.request(path, options);
  const errorFromResponse = (res) => window.IrisNet.errorFromResponse(res);

  function saveBlob(blob, fileName) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName || "download";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  function setPickerStatus(message, isError = false) {
    const status = $("pkImportStatus");
    if (!status) return;
    status.setAttribute("role", isError ? "alert" : "status");
    status.setAttribute("aria-live", isError ? "assertive" : "polite");
    status.classList.toggle("error", !!isError);
    status.textContent = message || "";
  }

  /* ---------------- blank content ---------------- */
  let projectTemplates = { latex: [], lilypond: [] };

  function normalizeProjectTemplates(value) {
    const templates = value && typeof value === "object" ? value : {};
    const normalize = (type) => (Array.isArray(templates[type]) ? templates[type] : []).filter((template) =>
      template && typeof template.id === "string" && typeof template.url === "string" && template.url.startsWith("/api/project-templates/"));
    return { latex: normalize("latex"), lilypond: normalize("lilypond") };
  }

  async function refreshProjectTemplates() {
    const out = await api("/api/project-templates");
    projectTemplates = normalizeProjectTemplates(out && out.templates);
    return projectTemplates;
  }

  function renderProjectTemplate(source, values) {
    return source.replace(/@@([A-Z_]+)@@/g, (placeholder, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : placeholder);
  }

  async function loadProjectTemplate(projectType, templateId) {
    const templates = projectTemplates[projectType] || [];
    const template = templates.find((item) => item.id === templateId)
      || templates.find((item) => item.default)
      || templates[0];
    if (!template) throw new Error(`No ${projectType} project template is available`);
    const response = await fetch(template.url, { credentials: "same-origin", cache: "no-cache" });
    if (!response.ok) throw new Error(`Unable to load project template: ${template.url}`);
    return response.text();
  }

  async function blankNodes(name, projectType, templateId) {
    if (projectType === "lilypond") {
      const title = String(name || t("templates.newScore")).replace(/["\\]/g, "");
      const tpl = renderProjectTemplate(await loadProjectTemplate(projectType, templateId), { TITLE: title });
      return [
        { type: "file", id: "main", name: "main.ly", kind: "ly", path: "main.ly", content: tpl },
      ];
    }
    const source = await loadProjectTemplate(projectType, templateId);
    const tpl = renderProjectTemplate(source, {
      TITLE: name || t("templates.newDocument"),
      INTRODUCTION: t("templates.introduction"),
      RECIPIENT: t("templates.recipient"),
      LETTER_OPENING: t("templates.letterOpening"),
      LETTER_BODY: t("templates.letterBody"),
      LETTER_CLOSING: t("templates.letterClosing"),
    });
    return [
      { type: "file", id: "main", name: "main.tex", kind: "tex", path: "main.tex", content: tpl },
      { type: "folder", name: "figure", open: true, children: [] },
      { type: "file", id: "refs", name: "references.bib", kind: "bib", path: "references.bib", content: "" },
    ];
  }

  /* ---------------- helpers ---------------- */
  function metaOf(id) {
    return index.find((x) => x.id === id) || null;
  }
  function countFiles(data) {
    let n = 0;
    const w = (ns) => (ns || []).forEach((x) => {
      if (x.generated) return;
      if (x.type === "folder") w(x.children);
      else n++;
    });
    if (data && data.project && data.project.nodes) w(data.project.nodes);
    return n;
  }
  function fmtTime(ts) {
    if (!ts) return "-";
    const d = new Date(ts), now = new Date();
    const time = window.IrisI18n.formatDate(d, { hour: "2-digit", minute: "2-digit" });
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return t("projects.today", { time });
    if (d.toDateString() === yest.toDateString()) return t("projects.yesterday", { time });
    return window.IrisI18n.formatDate(d, { day: "2-digit", month: "short", year: "numeric" });
  }
  function setProjName(name) {
    const el = $("projChipName");
    if (el) el.textContent = name || "-";
    document.title = name ? `${name} · Iris` : "Iris";
  }
  function currentRole() {
    const meta = metaOf(currentId);
    const data = cache.get(currentId);
    return (data && data.role) || (meta && meta.role) || null;
  }
  function syncShareTrigger(role = currentRole()) {
    const button = $("btnShareProject");
    if (button) button.hidden = !currentId || role !== "owner";
  }
  function setPickerLoading() {
    const grid = $("pkGrid"), empty = $("pkEmpty"), count = $("pkCount");
    if (count) count.textContent = "";
    if (empty) empty.style.display = "none";
    if (grid) {
      grid.style.display = "";
      grid.setAttribute("aria-busy", "true");
      grid.innerHTML = `<div class="pcard loading" role="status" aria-live="polite" aria-label="${esc(t("projects.loading"))}"><div class="pcard-open"><span class="pcard-icon">${ti("file-code-2")}</span><span class="pcard-text"><span class="pcard-name">${esc(t("projects.loading"))}</span><span class="pcard-meta">${esc(t("projects.loadingDescription"))}</span></span></div><div class="pcard-tools" aria-hidden="true"><span class="pcard-tool-placeholder"></span><span class="pcard-tool-placeholder"></span><span class="pcard-tool-placeholder"></span></div></div>`;
    }
  }

  function focusPicker() {
    if (window.IrisMotion.activeSurface() !== "picker") return;
    setTimeout(() => $("projectPickerTitle").focus(), 0);
  }

  async function loadIndex() {
    const data = await api("/api/projects");
    index = Array.isArray(data.projects) ? data.projects : [];
    return index;
  }
  // Always read the project from the server when opening it. Another member may
  // have changed it since this tab last looked, and the cached copy only carries
  // the content of the files this client itself wrote (see IrisApp.serialize);
  // the cache remains the source for ids, role and counts.
  async function loadData(id) {
    return api(`/api/projects/${id}`);
  }

  function acceptData(id, data, summary) {
    cache.set(id, clone(data));
    const meta = metaOf(id);
    if (meta) Object.assign(meta, {
      name: data.project.name, revision: data.revision,
      role: data.role || meta.role,
      projectType: data.projectType, fileCount: countFiles(data),
      updatedAt: data.updatedAt || meta.updatedAt,
    }, summary);
  }

  function staleSession() {
    const error = new Error(t("projects.noneOpen"));
    error.stale = true;
    return error;
  }

  function enqueueMutation(operation) {
    const result = saveQueue.then(operation, operation);
    saveQueue = result.catch(() => false);
    return result;
  }

  async function waitForPersistence() {
    let pending;
    do {
      pending = saveQueue;
      await pending;
    } while (pending !== saveQueue);
  }

  function refreshCurrent(accept) {
    const projectId = currentId;
    const sessionGeneration = openGeneration;
    return enqueueMutation(async () => {
      if (!projectId || currentId !== projectId || openGeneration !== sessionGeneration) throw staleSession();
      const data = await loadData(projectId);
      if (currentId !== projectId || openGeneration !== sessionGeneration) throw staleSession();
      // The editor must accept the tree before its revision or cache can advance.
      if (typeof accept !== "function" || accept(clone(data)) !== true) throw staleSession();
      acceptData(projectId, data);
      setProjName(data.project.name);
      return data;
    });
  }

  /* ---------------- chooser render ---------------- */
  async function renderPicker() {
    const grid = $("pkGrid"), empty = $("pkEmpty"), count = $("pkCount");
    grid.setAttribute("aria-busy", "true");
    try {
      const idx = (await loadIndex()).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (count) count.textContent = idx.length ? t("projects.count", { count: idx.length }) : "";
      grid.innerHTML = "";
      if (!idx.length) { empty.style.display = ""; grid.style.display = "none"; return; }
      empty.style.display = "none"; grid.style.display = "";
      idx.forEach((m) => {
        const nfiles = Number.isFinite(m.fileCount) ? m.fileCount : countFiles(cache.get(m.id));
        const card = document.createElement("div");
        card.className = "pcard";
        card.dataset.id = m.id;
        // The server is the authority on capabilities; the card only reflects the
        // role so owners get manage tools and viewers/editors don't see actions
        // they can't perform.
        const isOwner = m.role === "owner";
        card.innerHTML =
          `<button class="pcard-open" type="button" title="${esc(t("projects.openTitle"))}">` +
            `<span class="pcard-icon${m.projectType === "lilypond" ? " lilypond" : ""}">${ti(m.projectType === "lilypond" ? "music" : "file-code-2")}</span>` +
            `<span class="pcard-text">` +
              `<span class="pcard-name">${esc(m.name)}</span>` +
              `<span class="pcard-role role-${esc(m.role || "owner")}" title="${esc(t("projects.roleBadgeTitle"))}">${esc(roleLabel(m.role))}</span>` +
              `<span class="pcard-meta">${m.projectType === "lilypond" ? "LilyPond" : "LaTeX"} · ${esc(t("projects.fileCount", { count: nfiles }))} · ${esc(t("projects.modified", { time: fmtTime(m.updatedAt) }))}</span>` +
            `</span>` +
          `</button>` +
          `<div class="pcard-tools">` +
            `<button class="pcard-ic" type="button" data-act="download" title="${esc(t("common.download"))}" aria-label="${esc(t("projects.downloadAria", { name: m.name }))}">${ti("download")}</button>` +
            (isOwner
              ? `<button class="pcard-ic" type="button" data-act="rename" title="${esc(t("common.rename"))}" aria-label="${esc(t("projects.renameAria", { name: m.name }))}">${ti("edit")}</button>` +
                `<button class="pcard-ic danger" type="button" data-act="delete" title="${esc(t("common.delete"))}" aria-label="${esc(t("projects.deleteAria", { name: m.name }))}">${ti("trash")}</button>`
              : "") +
          `</div>`;
        card.querySelector(".pcard-open").addEventListener("click", () => openProject(m.id));
        card.querySelector('[data-act="download"]').addEventListener("click", async (e) => {
          e.stopPropagation();
          const button = e.currentTarget;
          button.disabled = true;
          setPickerStatus("");
          try {
            await downloadProjectArchive(m.id, m.name);
          } catch (err) {
            setPickerStatus(t("projects.downloadFailed", { name: m.name, error: window.IrisI18n.error(err) }), true);
          } finally {
            button.disabled = false;
          }
        });
        const renameBtn = card.querySelector('[data-act="rename"]');
        if (renameBtn) renameBtn.addEventListener("click", (e) => { e.stopPropagation(); askRename(m.id); });
        const deleteBtn = card.querySelector('[data-act="delete"]');
        if (deleteBtn) deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); askDelete(m.id); });
        grid.appendChild(card);
      });
    } catch (err) {
      grid.style.display = "";
      empty.style.display = "none";
      grid.innerHTML = `<div class="picker-empty error"><div role="alert"><div class="pe-title">${esc(t("projects.loadFailed"))}</div><div class="pe-sub">${esc(window.IrisI18n.error(err))}</div></div><button class="btn" type="button" data-retry-projects>${esc(t("common.retry"))}</button></div>`;
      grid.querySelector("[data-retry-projects]").addEventListener("click", () => {
        $("projectPickerTitle").focus();
        setPickerLoading();
        void renderPicker();
      });
    } finally {
      grid.removeAttribute("aria-busy");
    }
  }

  /* ---------------- open / close ---------------- */
  function confirmDiscardChanges() {
    if (unsavedDecision) return unsavedDecision.promise;
    let resolveDecision;
    const promise = new Promise((resolve) => { resolveDecision = resolve; });
    unsavedDecision = { promise, resolve: resolveDecision };
    openModal("projUnsavedModal");
    setTimeout(() => $("projUnsavedCancel").focus(), 50);
    return promise;
  }

  async function finishDiscardDecision(discard) {
    const decision = unsavedDecision;
    if (!decision) return;
    unsavedDecision = null;
    await closeModal("projUnsavedModal");
    decision.resolve(!!discard);
  }

  async function openProject(id) {
    const requestGeneration = ++openRequestGeneration;
    const sessionGeneration = openGeneration;
    // Opening adopts a revision just like a write: hold the queue through load,
    // without invalidating earlier saves while this request waits its turn.
    return enqueueMutation(async () => {
      if (requestGeneration !== openRequestGeneration || sessionGeneration !== openGeneration) return false;
      if (currentId && window.IrisApp.hasUnsavedChanges() && !(await confirmDiscardChanges())) return false;
      if (requestGeneration !== openRequestGeneration || sessionGeneration !== openGeneration) return false;
      const generation = ++openGeneration;
      const isCurrent = () => requestGeneration === openRequestGeneration && generation === openGeneration;
      if (window.IrisApp && window.IrisApp.cancelPendingProjectLoad) window.IrisApp.cancelPendingProjectLoad();
      const previous = window.IrisApp && window.IrisApp.capturePersistence();
      try {
        const data = await loadData(id);
        if (!isCurrent()) return false;
        if (!data || !window.IrisApp) return;
        const latest = window.IrisApp.capturePersistence();
        if (previous.generation !== latest.generation || previous.editRevision !== latest.editRevision || previous.manifest !== latest.manifest) return false;
        const m = metaOf(id);
        data.role = data.role || (m && m.role) || "owner";
        if (window.IrisBuilds) window.IrisBuilds.reset();
        const loaded = await window.IrisApp.load(clone(data), { isCurrent });
        if (!isCurrent() || loaded === false) return false;
        currentId = id;
        acceptData(id, data);
        setProjName((data.project && data.project.name) || "");
        syncShareTrigger(data.role);
        window.IrisMotion.setActiveSurface("app");
        window.IrisMotion.openProject();
        setTimeout(() => window.IrisEditor.focus(), 0);
        if (window.IrisBuilds) void window.IrisBuilds.loadLatest(id);
      } catch (err) {
        if (!isCurrent()) return false;
        console.error(err);
        if (currentId) {
          document.dispatchEvent(new CustomEvent("iris:projecterror", { detail: err }));
          return false;
        }
        currentId = null;
        syncShareTrigger(null);
        window.IrisMotion.setActiveSurface("picker");
        await window.IrisI18n.useDefaultLanguage({ silent: true });
        await renderPicker();
        const meta = metaOf(id);
        setPickerStatus(t("projects.openFailed", { name: meta ? meta.name : t("projects.thisProject"), error: window.IrisI18n.error(err) }), true);
        focusPicker();
      }
    });
  }

  async function closeCurrent() {
    return showPicker();
  }

  function mutateCurrent(suffix, method, options, withData = true) {
    const projectId = currentId;
    const sessionGeneration = openGeneration;
    return enqueueMutation(async () => {
      const isCurrent = () => currentId === projectId && openGeneration === sessionGeneration;
      if (!projectId || !isCurrent()) throw staleSession();
      // Capture only when this operation owns the queue, paired with its base.
      const snapshot = withData ? window.IrisApp.capturePersistence() : null;
      const body = typeof options === "function" ? options() : (options || {});
      const retention = snapshot && suffix === "" ? window.IrisApp.pendingRetention() : null;
      if (retention) body.retention = retention;
      if (snapshot) Object.assign(body, {
        name: snapshot.data.project.name, data: snapshot.data, baseRevision: snapshot.data.revision,
      });
      const acknowledge = (revision, data, summary) => {
        if (!isCurrent() || snapshot.generation !== window.IrisApp.capturePersistence().generation) throw staleSession();
        if (!Number.isInteger(revision) || revision !== snapshot.data.revision + 1) throw new Error(t("projects.operationFailed"));
        acceptData(projectId, { ...data, revision }, summary);
        window.IrisApp.acknowledgePersistence(snapshot, revision);
      };
      let out;
      try {
        out = await api(`/api/projects/${projectId}${suffix}`, { method, body: JSON.stringify(body) });
      } catch (err) {
        if (!isCurrent()) throw staleSession();
        // Build setup can fail after the exact submitted snapshot was committed.
        // Never fetch a new base and replay a tree that the editor has not seen.
        if (snapshot && Number.isInteger(err.params?.savedRevision) && err.params.savedRevision === snapshot.data.revision + 1) {
          acknowledge(err.params.savedRevision, snapshot.data);
        }
        if (err.status === 403) {
          document.dispatchEvent(new CustomEvent("iris:writeforbidden"));
        }
        throw err;
      }
      if (!isCurrent()) throw staleSession();
      if (snapshot) acknowledge(out.revision ?? out.data?.revision ?? out.project?.revision, out.data, out.project);
      if (snapshot && out.retention) window.IrisApp.applyRetention(out.retention, retention);
      return out;
    });
  }

  async function persistCurrent() {
    if (!currentId || !window.IrisApp || currentRole() === "viewer") return false;
    try {
      await mutateCurrent("", "PUT");
      return true;
    } catch (err) {
      if (!err.stale) document.dispatchEvent(new CustomEvent("iris:projecterror", { detail: err }));
      return false;
    }
  }

  async function compileCurrent(options) {
    const out = await mutateCurrent("/compile", "POST", options);
    document.dispatchEvent(new CustomEvent("iris:buildcompleted", { detail: out }));
    return out;
  }

  async function downloadCurrentFile(filePath, fileName) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    const query = new URLSearchParams({ path: String(filePath || "") });
    const res = await fetch(`/api/projects/${currentId}/files/download?${query}`, { credentials: "same-origin" });
    if (!res.ok) throw await errorFromResponse(res);
    saveBlob(await res.blob(), fileName || String(filePath || "download").split("/").pop());
  }

  /* ---------------- file history / versions ---------------- */
  // Resolves a live tree node's canonical file id (project_files UUID) from its
  // path, using the cached server data. Files created this session keep a client
  // ref id until reconciliation, so callers persist() first to refresh the cache.
  function resolveFileId(filePath) {
    const data = cache.get(currentId);
    if (!data || !data.project || !Array.isArray(data.project.nodes)) return null;
    const target = String(filePath || "");
    let found = null;
    const walk = (nodes) => (nodes || []).forEach((node) => {
      if (found) return;
      if (node.type === "folder") walk(node.children);
      else if (node.path === target) found = node.id;
    });
    walk(data.project.nodes);
    return found || null;
  }

  async function listFileVersions(fileId) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    const out = await api(`/api/projects/${currentId}/files/${fileId}/versions`);
    return Array.isArray(out.versions) ? out.versions : [];
  }

  async function getFileVersion(fileId, versionId) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    return api(`/api/projects/${currentId}/files/${fileId}/versions/${versionId}`);
  }

  async function restoreFileVersion(fileId, versionId) {
    return mutateCurrent(`/files/${fileId}/versions/${versionId}/restore`, "POST", null, false);
  }

  // Manual project-wide checkpoint. The current editor state is expected to be
  // persisted already (callers save first), so the server snapshots from disk.
  async function checkpointCurrent({ withData = false } = {}) {
    return mutateCurrent("/checkpoint", "POST", null, withData);
  }

  /* ---------------- versioned build outputs ---------------- */
  function currentProjectId() { return currentId; }

  async function listBuildOutputs({ limit = 50, offset = 0 } = {}) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    return api(`/api/projects/${currentId}/builds?${query}`);
  }

  async function getBuildOutput(buildId) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    return api(`/api/projects/${currentId}/builds/${buildId}`);
  }

  async function loadBuildOutput(buildId) {
    const projectId = currentId;
    if (!projectId) throw new Error(t("projects.noneOpen"));
    const detail = await api(`/api/projects/${projectId}/builds/${buildId}`);
    const artifacts = await Promise.all((detail.artifacts || []).map(async (artifact) => {
      const response = await fetch(artifact.url, { credentials: "same-origin" });
      if (!response.ok) throw await errorFromResponse(response);
      return {
        ...artifact,
        name: artifact.path || artifact.name,
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    }));
    if (currentId !== projectId) throw new Error(t("projects.noneOpen"));
    return { build: detail.build, artifacts };
  }

  async function downloadBuildArtifact(artifact) {
    const response = await fetch(artifact.downloadUrl || artifact.url, { credentials: "same-origin" });
    if (!response.ok) throw await errorFromResponse(response);
    saveBlob(await response.blob(), artifact.name || "output");
  }

  async function downloadBuildFile(file) {
    const response = await fetch(file.downloadUrl, { credentials: "same-origin" });
    if (!response.ok) throw await errorFromResponse(response);
    saveBlob(await response.blob(), file.name || "build-file");
  }

  async function downloadBuildArchive(detail) {
    const response = await fetch(detail.archiveUrl, { credentials: "same-origin" });
    if (!response.ok) throw await errorFromResponse(response);
    saveBlob(await response.blob(), detail.archiveName || "build-output.zip");
  }

  async function deleteBuildOutput(buildId) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    return api(`/api/projects/${currentId}/builds/${buildId}`, { method: "DELETE" });
  }

  async function downloadProjectArchive(id, projectName) {
    const res = await fetch(`/api/projects/${id}/archive`, { credentials: "same-origin" });
    if (!res.ok) throw await errorFromResponse(res);
    const safeName = String(projectName || "project").replace(/[\\/:*?"<>|]+/g, "-").trim() || "project";
    saveBlob(await res.blob(), `${safeName}.zip`);
  }

  async function importProjectArchive(file) {
    const query = new URLSearchParams({ filename: file.name || "project.zip" });
    const res = await fetch(`/api/projects/import?${query}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/zip" },
      body: file,
    });
    if (!res.ok) throw await errorFromResponse(res);
    return res.json();
  }

  async function handleProjectImport(file) {
    if (!file) return;
    const button = $("pkImport");
    button.disabled = true;
    button.classList.add("loading");
    setPickerStatus(t("projects.importing"));
    try {
      const out = await importProjectArchive(file);
      if (out.project) index.unshift(out.project);
      if (out.project && out.data) cache.set(out.project.id, out.data);
      await renderPicker();
      setPickerStatus(t("projects.imported", { name: out.project ? out.project.name : file.name }));
    } catch (err) {
      setPickerStatus(t("projects.importFailed", { error: window.IrisI18n.error(err) }), true);
    } finally {
      button.disabled = false;
      button.classList.remove("loading");
    }
  }

  /* ---------------- create / rename / delete ---------------- */
  async function createProject(name, projectType, templateId) {
    const now = Date.now();
    projectType = projectType === "lilypond" ? "lilypond" : "latex";
    const data = {
      project: { name, nodes: await blankNodes(name, projectType, templateId) },
      projectType,
      language: window.IrisI18n.defaultLanguage,
      engine: projectType === "lilypond" ? "lilypond" : "pdflatex",
      compileProfile: { mode: "quick" },
      lilypondArgs: "",
      lilypondFormat: "pdf",
      activeId: "main", openTabs: ["main"], assets: {},
      createdAt: now, updatedAt: now,
    };
    const out = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, data }),
    });
    const meta = out.project;
    index.unshift(meta);
    cache.set(meta.id, out.data || data);
    return meta.id;
  }

  async function renameProject(id, name) {
    const generation = openGeneration;
    return enqueueMutation(async () => {
      if (generation !== openGeneration) throw staleSession();
      const m = metaOf(id);
      const active = id === currentId;
      const snapshot = active ? window.IrisApp.capturePersistence() : null;
      const baseRevision = snapshot ? snapshot.data.revision : (m?.revision ?? cache.get(id)?.revision);
      const out = await api(`/api/projects/${id}`, {
        method: "PUT", body: JSON.stringify({ name, baseRevision }),
      });
      if (generation !== openGeneration || (snapshot && snapshot.generation !== window.IrisApp.capturePersistence().generation)) throw staleSession();
      acceptData(id, out.data, out.project);
      if (active) {
        window.IrisApp.setName(name, out.data.revision, snapshot.data.project.name);
        setProjName(window.IrisApp.serialize().project.name);
      }
      return out;
    });
  }

  async function deleteProject(id) {
    await api(`/api/projects/${id}`, { method: "DELETE" });
    index = index.filter((x) => x.id !== id);
    cache.delete(id);
    if (id === currentId) {
      openGeneration += 1;
      if (window.IrisApp && window.IrisApp.cancelPendingBuild) window.IrisApp.cancelPendingBuild();
      if (window.IrisApp && window.IrisApp.cancelPendingProjectLoad) window.IrisApp.cancelPendingProjectLoad();
      currentId = null;
      if (window.IrisBuilds) window.IrisBuilds.reset();
      syncShareTrigger(null);
      await window.IrisI18n.useDefaultLanguage({ silent: true });
      await window.IrisMotion.closeProject();
    }
  }

  /* ---------------- modals ---------------- */
  let projMode = "new", projTargetId = null, delTargetId = null;
  let templateSelectType = null;
  const selectedTemplates = { latex: null, lilypond: null };

  function projectTemplateLabel(template) {
    return template.label || template.title || template.id;
  }

  function renderProjectTemplateOptions(projectType) {
    const select = $("projTemplateSelect");
    if (templateSelectType && select.value) selectedTemplates[templateSelectType] = select.value;
    select.innerHTML = "";
    const templates = projectTemplates[projectType] || [];
    templates.forEach((template) => {
      const option = document.createElement("option");
      option.value = template.id;
      option.textContent = projectTemplateLabel(template);
      select.appendChild(option);
    });
    const selected = templates.find((template) => template.id === selectedTemplates[projectType])
      || templates.find((template) => template.default)
      || templates[0];
    select.value = selected ? selected.id : "";
    select.disabled = !selected;
    selectedTemplates[projectType] = select.value || null;
    templateSelectType = projectType;
    return !!selected;
  }

  function syncProjectTypeFields() {
    const projectType = $("projTypeSelect").value === "lilypond" ? "lilypond" : "latex";
    const hasTemplates = renderProjectTemplateOptions(projectType);
    $("projTemplateField").style.display = "";
    $("projModalHint").textContent = hasTemplates
      ? t(projectType === "latex" ? "projects.newLatexHint" : "projects.newLilypondHint")
      : t("projects.noTemplates", { type: projectType === "latex" ? "LaTeX" : "LilyPond" });
    if (projMode === "new") $("projModalOk").disabled = !hasTemplates;
  }

  async function askNew() {
    if (isExternalUser()) return;
    try {
      await refreshProjectTemplates();
    } catch (error) {
      setPickerStatus(t("projects.templatesLoadFailed"), true);
      return;
    }
    projMode = "new"; projTargetId = null;
    $("projModalTitle").textContent = t("projects.newTitle");
    $("projModalOk").textContent = t("projects.create");
    $("projModalHint").textContent = t("projects.newLatexHint");
    $("projTypeField").style.display = "";
    $("projTypeSelect").value = "latex";
    selectedTemplates.latex = null;
    selectedTemplates.lilypond = null;
    templateSelectType = null;
    syncProjectTypeFields();
    $("projNameInput").value = "";
    $("projNameInput").classList.remove("nomatch");
    $("projNameInput").removeAttribute("aria-invalid");
    $("projModalError").style.display = "none";
    openModal("projModal");
    setTimeout(() => $("projNameInput").focus(), 40);
  }
  function askRename(id) {
    const m = metaOf(id);
    projMode = "rename"; projTargetId = id;
    $("projModalTitle").textContent = t("projects.renameTitle");
    $("projModalOk").textContent = t("common.save");
    $("projModalHint").textContent = t("projects.renameHint");
    $("projTypeField").style.display = "none";
    $("projTemplateField").style.display = "none";
    $("projModalOk").disabled = false;
    $("projNameInput").value = m ? m.name : "";
    $("projNameInput").classList.remove("nomatch");
    $("projNameInput").removeAttribute("aria-invalid");
    $("projModalError").style.display = "none";
    openModal("projModal");
    setTimeout(() => { const i = $("projNameInput"); i.focus(); i.select(); }, 40);
  }
  async function confirmProjModal() {
    const name = $("projNameInput").value.trim();
    if (!name) {
      const i = $("projNameInput");
      i.classList.add("nomatch"); i.setAttribute("aria-invalid", "true"); i.focus();
      const error = $("projModalError");
      error.textContent = t("api.PROJECT_NAME_REQUIRED");
      error.style.display = "flex";
      return;
    }
    if (projMode === "new" && !$("projTemplateSelect").value) return;
    const ok = $("projModalOk");
    ok.disabled = true;
    ok.classList.add("loading");
    try {
      if (projMode === "new") {
        const id = await createProject(name, $("projTypeSelect").value, $("projTemplateSelect").value);
        await closeModal("projModal");
        await renderPicker();
        await openProject(id);
      } else {
        const renamedId = projTargetId;
        await renameProject(projTargetId, name);
        await closeModal("projModal");
        await renderPicker();
        const action = document.querySelector(`.pcard[data-id="${renamedId}"] [data-act="rename"]`);
        if (action) action.focus();
        else focusPicker();
      }
    } catch (err) {
      $("projNameInput").classList.add("nomatch");
      $("projNameInput").setAttribute("aria-invalid", "true");
      const error = $("projModalError");
      error.textContent = window.IrisI18n.error(err, "projects.operationFailed");
      error.style.display = "flex";
    } finally {
      ok.disabled = false;
      ok.classList.remove("loading");
    }
  }
  function askDelete(id) {
    const m = metaOf(id);
    delTargetId = id;
    $("projDeleteText").textContent = t("projects.deleteConfirm", { name: m ? m.name : t("projects.thisProject") });
    $("projDeleteError").style.display = "none";
    openModal("projDelModal");
  }
  async function confirmDelete() {
    const ok = $("projDelOk");
    ok.disabled = true;
    try {
      await deleteProject(delTargetId);
      await closeModal("projDelModal");
      await renderPicker();
      focusPicker();
    } catch (err) {
      const error = $("projDeleteError");
      error.textContent = window.IrisI18n.error(err, "projects.deleteFailed");
      error.style.display = "flex";
    } finally {
      ok.disabled = false;
    }
  }

  /* ---------------- project sharing ---------------- */
  let shareMembers = [];
  let shareSearchResults = [];
  let shareSelectedUser = null;
  let shareBusy = false;
  let shareSearchTimer = 0;
  let shareSearchGeneration = 0;

  function shareError(error) {
    const node = $("projectShareError");
    if (!error) {
      node.textContent = "";
      node.style.display = "none";
      return;
    }
    node.textContent = window.IrisI18n.error(error, "sharing.loadFailed");
    node.style.display = "flex";
  }

  function shareStatus(message) {
    $("projectShareStatus").textContent = message || "";
  }

  function renderShareMembers() {
    const host = $("projectShareMembers");
    host.innerHTML = "";
    if (!shareMembers.length) {
      host.innerHTML = `<div class="project-share-empty">${esc(t("sharing.noMembers"))}</div>`;
      return;
    }
    const ownerCount = shareMembers.filter((member) => member.role === "owner").length;
    const currentUserId = document.documentElement.dataset.uid || "";
    shareMembers.forEach((member) => {
      const isSelf = member.userId === currentUserId;
      const lastOwner = member.role === "owner" && ownerCount === 1;
      const row = document.createElement("div");
      row.className = "project-share-member";
      const options = rolesForMember(member.external).map((role) =>
        `<option value="${role}"${role === member.role ? " selected" : ""}>${esc(roleLabel(role))}</option>`
      ).join("");
      const lockedTitle = lastOwner ? ` title="${esc(t("api.PROJECT_LAST_OWNER"))}"` : "";
      const externalTag = member.external
        ? ` <span class="project-share-external" title="${esc(t("sharing.externalTitle"))}">${esc(t("sharing.external"))}</span>`
        : "";
      row.innerHTML =
        `<span class="project-share-member-id"><b>${esc(member.name || member.username)}${isSelf ? ` <span class="project-share-you">${esc(t("sharing.you"))}</span>` : ""}${externalTag}</b>` +
        `<span class="project-share-member-sub">@${esc(member.username)} · ${esc(member.email)}</span></span>` +
        `<select class="input project-share-role" aria-label="${esc(t("sharing.roleAria", { name: member.name || member.username }))}" aria-describedby="projectShareOwnerHint"${lastOwner || shareBusy ? " disabled" : ""}${lockedTitle}>${options}</select>` +
        `<button class="node-act danger project-share-remove" type="button" aria-label="${esc(t("sharing.removeAria", { name: member.username }))}" aria-describedby="projectShareOwnerHint" title="${esc(lastOwner ? t("api.PROJECT_LAST_OWNER") : t("sharing.removeAria", { name: member.username }))}"${lastOwner || shareBusy ? " disabled" : ""}>${ti("trash")}</button>`;
      const select = row.querySelector(".project-share-role");
      if (!lastOwner) select.addEventListener("change", () => { void changeSharedRole(member, select.value); });
      const remove = row.querySelector(".project-share-remove");
      if (!lastOwner) remove.addEventListener("click", () => { void removeSharedMember(member); });
      host.appendChild(row);
    });
  }

  function renderShareSearchResults() {
    const host = $("projectShareResults");
    host.innerHTML = "";
    shareSearchResults.forEach((user) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `project-share-result${shareSelectedUser && shareSelectedUser.userId === user.userId ? " selected" : ""}`;
      button.setAttribute("aria-pressed", shareSelectedUser && shareSelectedUser.userId === user.userId ? "true" : "false");
      const externalTag = user.external
        ? `<span class="project-share-external" title="${esc(t("sharing.externalTitle"))}">${esc(t("sharing.external"))}</span>`
        : "";
      button.innerHTML = `<b>${esc(user.name || user.username)}${externalTag ? ` ${externalTag}` : ""}</b><span>@${esc(user.username)} · ${esc(user.email)}</span>`;
      button.addEventListener("click", () => {
        shareSelectedUser = user;
        $("projectShareSearchStatus").textContent = "";
        renderShareSearchResults();
        syncShareRoleOptions();
        $("projectShareAdd").disabled = shareBusy;
      });
      host.appendChild(button);
    });
    $("projectShareAdd").disabled = shareBusy || !shareSelectedUser;
  }

  // Owner disappears from the invite menu while an external account is selected,
  // and a role already set to owner falls back to editor so the form never submits
  // a combination the server will refuse.
  function syncShareRoleOptions() {
    const select = $("projectShareRole");
    const ownerOption = select.querySelector('option[value="owner"]');
    if (!ownerOption) return;
    const external = !!(shareSelectedUser && shareSelectedUser.external);
    ownerOption.hidden = external;
    ownerOption.disabled = external;
    if (external && select.value === "owner") select.value = "editor";
  }

  function clearShareSearch() {
    clearTimeout(shareSearchTimer);
    shareSearchGeneration += 1;
    shareSearchResults = [];
    shareSelectedUser = null;
    $("projectShareSearch").value = "";
    $("projectShareSearchStatus").textContent = "";
    renderShareSearchResults();
    syncShareRoleOptions();
  }

  async function searchShareUsers() {
    const query = $("projectShareSearch").value.trim();
    shareSelectedUser = null;
    if (query.length < 2) {
      shareSearchResults = [];
      $("projectShareSearchStatus").textContent = "";
      renderShareSearchResults();
      return;
    }
    const generation = ++shareSearchGeneration;
    $("projectShareSearchStatus").textContent = t("sharing.searching");
    try {
      const params = new URLSearchParams({ q: query });
      const out = await api(`/api/projects/${currentId}/members/search?${params}`);
      if (generation !== shareSearchGeneration) return;
      shareSearchResults = Array.isArray(out.users) ? out.users : [];
      shareError(null);
      $("projectShareSearchStatus").textContent = shareSearchResults.length ? "" : t("sharing.noResults");
      renderShareSearchResults();
    } catch (error) {
      if (generation !== shareSearchGeneration) return;
      shareSearchResults = [];
      renderShareSearchResults();
      shareError(error);
      $("projectShareSearchStatus").textContent = "";
    }
  }

  function scheduleShareSearch() {
    clearTimeout(shareSearchTimer);
    shareSelectedUser = null;
    syncShareRoleOptions();
    $("projectShareAdd").disabled = true;
    shareSearchTimer = setTimeout(() => { void searchShareUsers(); }, 250);
  }

  async function loadShareMembers() {
    $("projectShareMembers").innerHTML = `<div class="project-share-empty">${esc(t("sharing.loadingMembers"))}</div>`;
    try {
      const out = await api(`/api/projects/${currentId}/members`);
      shareMembers = Array.isArray(out.members) ? out.members : [];
      shareError(null);
      renderShareMembers();
    } catch (error) {
      shareMembers = [];
      renderShareMembers();
      shareError(error);
    }
  }

  async function openProjectSharing() {
    if (!currentId || currentRole() !== "owner") return;
    const meta = metaOf(currentId);
    $("projectShareSubtitle").textContent = t("sharing.subtitle", { name: meta ? meta.name : t("projects.thisProject") });
    $("projectShareRole").value = "editor";
    shareError(null);
    shareStatus("");
    clearShareSearch();
    openModal("projectShareModal");
    await loadShareMembers();
    setTimeout(() => $("projectShareSearch").focus(), 40);
  }

  async function addSharedMember(event) {
    event.preventDefault();
    if (shareBusy || !shareSelectedUser || !currentId) {
      if (!shareSelectedUser) $("projectShareSearchStatus").textContent = t("sharing.selectUser");
      return;
    }
    shareBusy = true;
    const button = $("projectShareAdd");
    button.disabled = true;
    button.classList.add("loading");
    try {
      const selected = shareSelectedUser;
      await api(`/api/projects/${currentId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: selected.userId, role: $("projectShareRole").value }),
      });
      shareError(null);
      shareStatus(t("sharing.memberAdded", { name: selected.name || selected.username }));
      clearShareSearch();
      await loadShareMembers();
    } catch (error) {
      shareError(error);
    } finally {
      shareBusy = false;
      button.classList.remove("loading");
      renderShareMembers();
      renderShareSearchResults();
    }
  }

  function updateCurrentRole(role) {
    const meta = metaOf(currentId);
    const data = cache.get(currentId);
    if (meta) meta.role = role;
    if (data) data.role = role;
    if (window.IrisApp && window.IrisApp.setRole) window.IrisApp.setRole(role);
    syncShareTrigger(role);
  }

  async function changeSharedRole(member, nextRole) {
    if (shareBusy || nextRole === member.role || !currentId) return;
    const isSelf = member.userId === document.documentElement.dataset.uid;
    shareBusy = true;
    renderShareMembers();
    try {
      if (isSelf && window.IrisApp.hasUnsavedChanges && window.IrisApp.hasUnsavedChanges()) {
        const saved = window.IrisApp.persistChanges ? await window.IrisApp.persistChanges() : await persistCurrent();
        if (!saved) throw new Error(t("projects.operationFailed"));
      }
      await api(`/api/projects/${currentId}/members/${member.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
      shareError(null);
      if (isSelf) {
        updateCurrentRole(nextRole);
        await closeModal("projectShareModal");
      } else {
        shareStatus(t("sharing.roleChanged"));
        await loadShareMembers();
      }
    } catch (error) {
      shareError(error);
    } finally {
      shareBusy = false;
      renderShareMembers();
    }
  }

  async function leaveSharedProject() {
    const id = currentId;
    await closeModal("projectShareModal");
    index = index.filter((projectMeta) => projectMeta.id !== id);
    cache.delete(id);
    openGeneration += 1;
    if (window.IrisApp && window.IrisApp.cancelPendingBuild) window.IrisApp.cancelPendingBuild();
    if (window.IrisApp && window.IrisApp.cancelPendingProjectLoad) window.IrisApp.cancelPendingProjectLoad();
    currentId = null;
    if (window.IrisBuilds) window.IrisBuilds.reset();
    syncShareTrigger(null);
    await window.IrisI18n.useDefaultLanguage({ silent: true });
    document.title = `${t("projects.yourProjects")} · Iris`;
    setPickerLoading();
    window.IrisMotion.setActiveSurface("picker");
    await Promise.all([window.IrisMotion.closeProject(), renderPicker()]);
    focusPicker();
  }

  async function removeSharedMember(member) {
    if (shareBusy || !currentId) return;
    const isSelf = member.userId === document.documentElement.dataset.uid;
    shareBusy = true;
    renderShareMembers();
    try {
      if (isSelf && window.IrisApp.hasUnsavedChanges && window.IrisApp.hasUnsavedChanges()) {
        const saved = window.IrisApp.persistChanges ? await window.IrisApp.persistChanges() : await persistCurrent();
        if (!saved) throw new Error(t("projects.operationFailed"));
      }
      await api(`/api/projects/${currentId}/members/${member.userId}`, { method: "DELETE" });
      shareError(null);
      if (isSelf) await leaveSharedProject();
      else {
        shareStatus(t("sharing.memberRemoved"));
        await loadShareMembers();
      }
    } catch (error) {
      shareError(error);
    } finally {
      shareBusy = false;
      renderShareMembers();
    }
  }

  /* ---------------- public API ---------------- */
  async function showPicker() {
    await waitForPersistence();
    const dirty = !!(currentId && window.IrisApp && window.IrisApp.hasUnsavedChanges && window.IrisApp.hasUnsavedChanges());
    if (dirty && !(await confirmDiscardChanges())) return false;
    if (dirty) cache.delete(currentId);
    const hadProject = !!currentId;
    window.IrisMotion.setActiveSurface("picker");
    openGeneration += 1;
    if (window.IrisApp && window.IrisApp.cancelPendingBuild) window.IrisApp.cancelPendingBuild();
    if (window.IrisApp && window.IrisApp.cancelPendingProjectLoad) window.IrisApp.cancelPendingProjectLoad();
    currentId = null;
    if (window.IrisBuilds) window.IrisBuilds.reset();
    syncShareTrigger(null);
    await window.IrisI18n.useDefaultLanguage({ silent: true });
    document.title = `${t("projects.yourProjects")} · Iris`;
    setPickerLoading();
    if (hadProject) await Promise.all([window.IrisMotion.closeProject(), renderPicker()]);
    else await renderPicker();
    if (hadProject) focusPicker();
    return true;
  }
  function onLogout() {
    if (unsavedDecision) {
      unsavedDecision.resolve(false);
      unsavedDecision = null;
    }
    openGeneration += 1;
    if (window.IrisApp && window.IrisApp.cancelPendingBuild) window.IrisApp.cancelPendingBuild();
    if (window.IrisApp && window.IrisApp.cancelPendingProjectLoad) window.IrisApp.cancelPendingProjectLoad();
    currentId = null;
    syncShareTrigger(null);
    cache.clear();
    index = [];
    void window.IrisI18n.useDefaultLanguage({ silent: true });
    window.IrisMotion.resetProject();
    document.title = "Iris";
  }

  window.IrisProjects = {
    showPicker, openProject, closeCurrent, persistCurrent, compileCurrent, waitForPersistence,
    downloadCurrentFile, refreshCurrent, renderPicker, onLogout, resolveFileId,
    listFileVersions, getFileVersion, restoreFileVersion, checkpointCurrent,
    currentProjectId, currentRole, listBuildOutputs, getBuildOutput, loadBuildOutput,
    downloadBuildArtifact, downloadBuildFile, downloadBuildArchive, deleteBuildOutput,
  };

  /* ---------------- wiring ---------------- */
  function wire() {
    $("pkNew").addEventListener("click", () => { void askNew(); });
    const ne = $("pkNewEmpty"); if (ne) ne.addEventListener("click", () => { void askNew(); });
    $("pkImport").addEventListener("click", () => $("projectImportInput").click());
    $("projectImportInput").addEventListener("change", function () {
      const file = this.files && this.files[0];
      this.value = "";
      if (isExternalUser()) return;
      void handleProjectImport(file);
    });

    const back = $("btnCloseProject");
    if (back) back.addEventListener("click", () => closeCurrent());
    $("btnShareProject").addEventListener("click", () => { void openProjectSharing(); });
    $("projectShareForm").addEventListener("submit", (event) => { void addSharedMember(event); });
    $("projectShareSearch").addEventListener("input", scheduleShareSearch);

    $("projModalOk").addEventListener("click", () => confirmProjModal());
    $("projNameInput").addEventListener("input", () => {
      $("projNameInput").classList.remove("nomatch");
      $("projNameInput").removeAttribute("aria-invalid");
      $("projModalError").style.display = "none";
    });
    $("projTypeSelect").addEventListener("change", syncProjectTypeFields);
    $("projTemplateSelect").addEventListener("change", function () {
      selectedTemplates[$("projTypeSelect").value] = this.value;
    });
    $("projNameInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); confirmProjModal(); }
      else if (e.key === "Escape") { e.preventDefault(); closeModal("projModal"); }
    });
    $("projDelOk").addEventListener("click", () => confirmDelete());

    ["projModal", "projDelModal"].forEach((mid) => {
      const m = $(mid);
      m.addEventListener("click", (e) => { if (e.target === m) closeModal(mid); });
      m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(mid)));
    });
    $("projUnsavedCancel").addEventListener("click", () => { void finishDiscardDecision(false); });
    $("projUnsavedClose").addEventListener("click", () => { void finishDiscardDecision(false); });
    $("projUnsavedDiscard").addEventListener("click", () => { void finishDiscardDecision(true); });
    $("projUnsavedModal").addEventListener("click", (event) => {
      if (event.target === $("projUnsavedModal")) void finishDiscardDecision(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !unsavedDecision) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void finishDiscardDecision(false);
    }, true);
  }

  document.addEventListener("iris:languagechange", () => {
    if (document.documentElement.classList.contains("iris-authed") && !currentId) {
      document.title = `${t("projects.yourProjects")} · Iris`;
      void renderPicker();
    }
    if ($("projModal").classList.contains("on")) {
      if (projMode === "new") void askNew();
      else if (projTargetId) askRename(projTargetId);
    }
    if (delTargetId && $("projDelModal").classList.contains("on")) askDelete(delTargetId);
    if ($("projectShareModal").classList.contains("on")) {
      const meta = metaOf(currentId);
      $("projectShareSubtitle").textContent = t("sharing.subtitle", { name: meta ? meta.name : t("projects.thisProject") });
      renderShareMembers();
      renderShareSearchResults();
    }
  });
  window.IrisI18n.ready.then(wire);
})();
