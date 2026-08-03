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
  let saveQueue = Promise.resolve(false);
  const cache = new Map();

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
  function blankNodes(name, projectType, latexTemplate = "article") {
    if (projectType === "lilypond") {
      const title = String(name || t("templates.newScore")).replace(/["\\]/g, "");
      const tpl = `\\version "2.24.0"

\\header {
  title = "${title}"
  composer = ""
}

\\score {
  \\relative c' {
    \\key c \\major
    \\time 4/4
    c4 d e f | g1 \\bar "|."
  }
  \\layout { }
  \\midi { }
}`;
      return [
        { type: "file", id: "main", name: "main.ly", kind: "ly", path: "main.ly", content: tpl },
      ];
    }
    const title = name || t("templates.newDocument");
    let tpl;
    if (latexTemplate === "beamer") {
      tpl = `\\documentclass{beamer}
\\usepackage[utf8]{inputenc}

\\title{${title}}
\\author{}
\\date{\\today}

\\begin{document}
\\frame{\\titlepage}

\\begin{frame}{${t("templates.introduction")}}

\\end{frame}
\\end{document}`;
    } else if (latexTemplate === "letter") {
      tpl = `\\documentclass[11pt]{letter}
\\usepackage[utf8]{inputenc}

\\signature{}
\\address{}

\\begin{document}
\\begin{letter}{${t("templates.recipient")}}
\\opening{${t("templates.letterOpening")}}

${t("templates.letterBody")}

\\closing{${t("templates.letterClosing")}}
\\end{letter}
\\end{document}`;
    } else {
      const documentClass = latexTemplate === "book" || latexTemplate === "report" ? latexTemplate : "article";
      const heading = documentClass === "article" ? "section" : "chapter";
      tpl = `\\documentclass[11pt]{${documentClass}}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}

\\title{${title}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\${heading}{${t("templates.introduction")}}


\\end{document}`;
    }
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
    const data = await api(`/api/projects/${id}`);
    cache.set(id, data);
    return data;
  }

  async function refreshCurrent() {
    const projectId = currentId;
    const sessionGeneration = openGeneration;
    if (!projectId) throw new Error(t("projects.noneOpen"));
    const data = await api(`/api/projects/${projectId}`);
    if (currentId !== projectId || openGeneration !== sessionGeneration) {
      const error = new Error(t("projects.noneOpen"));
      error.stale = true;
      throw error;
    }
    cache.set(projectId, data);
    const meta = metaOf(projectId);
    if (meta) {
      meta.name = (data.project && data.project.name) || meta.name;
      meta.projectType = data.projectType || meta.projectType;
      meta.fileCount = countFiles(data);
      meta.updatedAt = data.updatedAt || meta.updatedAt;
    }
    return data;
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
    const generation = ++openGeneration;
    if (window.IrisApp && window.IrisApp.cancelPendingProjectLoad) window.IrisApp.cancelPendingProjectLoad();
    try {
      const data = await loadData(id);
      if (generation !== openGeneration) return;
      if (!data || !window.IrisApp) return;
      const m = metaOf(id);
      data.role = data.role || (m && m.role) || "owner";
      if (m) m.role = data.role;
      currentId = id;
      if (window.IrisBuilds) window.IrisBuilds.reset();
      const loaded = await window.IrisApp.load(data);
      if (generation !== openGeneration || loaded === false) return;
      setProjName(m ? m.name : (data.project && data.project.name) || "");
      syncShareTrigger(data.role);
      window.IrisMotion.setActiveSurface("app");
      window.IrisMotion.openProject();
      setTimeout(() => window.IrisEditor.focus(), 0);
      if (window.IrisBuilds) void window.IrisBuilds.loadLatest(id);
    } catch (err) {
      if (generation !== openGeneration) return;
      console.error(err);
      currentId = null;
      syncShareTrigger(null);
      window.IrisMotion.setActiveSurface("picker");
      await window.IrisI18n.useDefaultLanguage({ silent: true });
      await renderPicker();
      const meta = metaOf(id);
      setPickerStatus(t("projects.openFailed", { name: meta ? meta.name : t("projects.thisProject"), error: window.IrisI18n.error(err) }), true);
      focusPicker();
    }
  }

  async function closeCurrent() {
    const dirty = !!(currentId && window.IrisApp && window.IrisApp.hasUnsavedChanges && window.IrisApp.hasUnsavedChanges());
    if (dirty && !(await confirmDiscardChanges())) return false;
    window.IrisMotion.setActiveSurface("picker");
    if (window.IrisApp && window.IrisApp.waitForPersistence) await window.IrisApp.waitForPersistence();
    if (dirty) cache.delete(currentId);
    else await persistCurrent();
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
    return true;
  }

  function persistCurrent() {
    if (!currentId || !window.IrisApp) return Promise.resolve(false);
    const projectId = currentId;
    const sessionGeneration = openGeneration;
    const data = window.IrisApp.serialize();
    const now = Date.now();
    data.updatedAt = now;
    cache.set(projectId, data);
    const m = metaOf(projectId);
    if (m) {
      m.name = (data.project && data.project.name) || m.name;
      m.updatedAt = now;
      m.fileCount = countFiles(data);
      m.projectType = data.projectType || m.projectType || "latex";
    }
    const name = m ? m.name : data.project.name;
    const operation = async () => {
      try {
        const out = await api(`/api/projects/${projectId}`, {
          method: "PUT",
          body: JSON.stringify({ name, data }),
        });
        const staleReopen = currentId === projectId && openGeneration !== sessionGeneration;
        if (!staleReopen && out && out.data) cache.set(projectId, out.data);
        if (!staleReopen && out && out.project && m) Object.assign(m, out.project);
        return currentId === projectId && openGeneration === sessionGeneration;
      } catch (err) {
        console.error("Salvataggio progetto fallito", err);
        // Write refused (role downgraded to viewer while the project was open):
        // let the editor drop to read-only and tell the user, instead of failing
        // silently and risking lost edits.
        if (currentId === projectId && openGeneration === sessionGeneration && err && err.status === 403) {
          document.dispatchEvent(new CustomEvent("iris:writeforbidden"));
        }
        return false;
      }
    };
    saveQueue = saveQueue.then(operation, operation);
    return saveQueue;
  }

  async function compileCurrent(data, options) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    const projectId = currentId;
    const sessionGeneration = openGeneration;
    data = data && typeof data === "object" ? data : (window.IrisApp ? window.IrisApp.serialize() : {});
    const now = Date.now();
    data.updatedAt = now;
    cache.set(projectId, data);
    const m = metaOf(projectId);
    if (m) {
      m.name = (data.project && data.project.name) || m.name;
      m.updatedAt = now;
      m.fileCount = countFiles(data);
      m.projectType = data.projectType || m.projectType || "latex";
    }
    const out = await api(`/api/projects/${projectId}/compile`, {
      method: "POST",
      body: JSON.stringify({
        name: m ? m.name : data.project.name,
        data,
        engine: options && options.engine,
        mainPath: options && options.mainPath,
        texPath: options && options.texPath,
        lilypondPath: options && options.lilypondPath,
        lilypondArgs: options && options.lilypondArgs,
        lilypondFormat: options && options.lilypondFormat,
        compileProfile: options && options.compileProfile,
      }),
    });
    if (currentId !== projectId || openGeneration !== sessionGeneration) throw new Error(t("projects.noneOpen"));
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
    if (!currentId) throw new Error(t("projects.noneOpen"));
    return api(`/api/projects/${currentId}/files/${fileId}/versions/${versionId}/restore`, {
      method: "POST",
      body: "{}",
    });
  }

  // Manual project-wide checkpoint. The current editor state is expected to be
  // persisted already (callers save first), so the server snapshots from disk.
  async function checkpointCurrent() {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    return api(`/api/projects/${currentId}/checkpoint`, { method: "POST", body: "{}" });
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
  async function createProject(name, projectType, latexTemplate) {
    const now = Date.now();
    projectType = projectType === "lilypond" ? "lilypond" : "latex";
    const data = {
      project: { name, nodes: blankNodes(name, projectType, latexTemplate) },
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
    const m = metaOf(id);
    const data = cache.get(id);
    if (m) { m.name = name; m.updatedAt = Date.now(); }
    if (data && data.project) { data.project.name = name; data.updatedAt = Date.now(); }
    if (id === currentId && window.IrisApp) { window.IrisApp.setName(name); setProjName(name); }
    const out = await api(`/api/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, data }),
    });
    if (out && out.project && m) Object.assign(m, out.project);
    if (out && out.data) cache.set(id, out.data);
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

  function syncProjectTypeFields() {
    const isLatex = $("projTypeSelect").value === "latex";
    $("projTemplateField").style.display = isLatex ? "" : "none";
    $("projModalHint").textContent = t(isLatex ? "projects.newLatexHint" : "projects.newLilypondHint");
  }

  function askNew() {
    if (isExternalUser()) return;
    projMode = "new"; projTargetId = null;
    $("projModalTitle").textContent = t("projects.newTitle");
    $("projModalOk").textContent = t("projects.create");
    $("projModalHint").textContent = t("projects.newLatexHint");
    $("projTypeField").style.display = "";
    $("projTypeSelect").value = "latex";
    $("projTemplateSelect").value = "article";
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
    const dirty = !!(currentId && window.IrisApp && window.IrisApp.hasUnsavedChanges && window.IrisApp.hasUnsavedChanges());
    if (dirty && !(await confirmDiscardChanges())) return false;
    window.IrisMotion.setActiveSurface("picker");
    if (window.IrisApp && window.IrisApp.waitForPersistence) await window.IrisApp.waitForPersistence();
    if (dirty) cache.delete(currentId);
    else await persistCurrent();
    const hadProject = !!currentId;
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
    showPicker, openProject, closeCurrent, persistCurrent, compileCurrent,
    downloadCurrentFile, refreshCurrent, renderPicker, onLogout, resolveFileId,
    listFileVersions, getFileVersion, restoreFileVersion, checkpointCurrent,
    currentProjectId, currentRole, listBuildOutputs, getBuildOutput, loadBuildOutput,
    downloadBuildArtifact, downloadBuildFile, downloadBuildArchive, deleteBuildOutput,
  };

  /* ---------------- wiring ---------------- */
  function wire() {
    $("pkNew").addEventListener("click", askNew);
    const ne = $("pkNewEmpty"); if (ne) ne.addEventListener("click", askNew);
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
      if (projMode === "new") askNew();
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
