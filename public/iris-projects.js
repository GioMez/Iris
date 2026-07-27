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
  const cache = new Map();

  const ROLE_KEY = { owner: "roleOwner", editor: "roleEditor", viewer: "roleViewer" };
  const roleLabel = (role) => t(`projects.${ROLE_KEY[role] || "roleOwner"}`);

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
    status.textContent = message || "";
    status.classList.toggle("error", !!isError);
  }

  /* ---------------- blank content ---------------- */
  function blankNodes(name, projectType) {
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
    const tpl = `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}

\\title{${name || t("templates.newDocument")}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{${t("templates.introduction")}}


\\end{document}`;
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
  function setPickerLoading() {
    const grid = $("pkGrid"), empty = $("pkEmpty"), count = $("pkCount");
    if (count) count.textContent = "";
    if (empty) empty.style.display = "none";
    if (grid) {
      grid.style.display = "";
      grid.innerHTML = `<div class="pcard"><button class="pcard-open" type="button" disabled><span class="pcard-text"><span class="pcard-name">${esc(t("projects.loading"))}</span><span class="pcard-meta">${esc(t("projects.loadingDescription"))}</span></span></button></div>`;
    }
  }

  async function loadIndex() {
    const data = await api("/api/projects");
    index = Array.isArray(data.projects) ? data.projects : [];
    return index;
  }
  async function loadData(id) {
    if (cache.has(id)) return cache.get(id);
    const data = await api(`/api/projects/${id}`);
    cache.set(id, data);
    return data;
  }

  async function refreshCurrent() {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    const data = await api(`/api/projects/${currentId}`);
    cache.set(currentId, data);
    const meta = metaOf(currentId);
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
      grid.innerHTML = `<div class="picker-empty" style="display:block"><div class="pe-title">${esc(t("projects.loadFailed"))}</div><div class="pe-sub">${esc(window.IrisI18n.error(err))}</div></div>`;
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
    try {
      const data = await loadData(id);
      if (!data || !window.IrisApp) return;
      currentId = id;
      await window.IrisApp.load(data);
      const m = metaOf(id);
      setProjName(m ? m.name : (data.project && data.project.name) || "");
      window.IrisMotion.openProject();
    } catch (err) {
      console.error(err);
      await window.IrisI18n.useDefaultLanguage({ silent: true });
      await renderPicker();
    }
  }

  async function closeCurrent() {
    const dirty = !!(currentId && window.IrisApp && window.IrisApp.hasUnsavedChanges && window.IrisApp.hasUnsavedChanges());
    if (dirty && !(await confirmDiscardChanges())) return false;
    if (dirty) cache.delete(currentId);
    else await persistCurrent();
    currentId = null;
    await window.IrisI18n.useDefaultLanguage({ silent: true });
    setPickerLoading();
    await Promise.all([window.IrisMotion.closeProject(), renderPicker()]);
    return true;
  }

  async function persistCurrent() {
    if (!currentId || !window.IrisApp) return false;
    const data = window.IrisApp.serialize();
    const now = Date.now();
    data.updatedAt = now;
    cache.set(currentId, data);
    const m = metaOf(currentId);
    if (m) {
      m.name = (data.project && data.project.name) || m.name;
      m.updatedAt = now;
      m.fileCount = countFiles(data);
      m.projectType = data.projectType || m.projectType || "latex";
    }
    try {
      const out = await api(`/api/projects/${currentId}`, {
        method: "PUT",
        body: JSON.stringify({ name: m ? m.name : data.project.name, data }),
      });
      if (out && out.data) cache.set(currentId, out.data);
      if (out && out.project && m) Object.assign(m, out.project);
      return true;
    } catch (err) {
      console.error("Salvataggio progetto fallito", err);
      // Write refused (role downgraded to viewer while the project was open):
      // let the editor drop to read-only and tell the user, instead of failing
      // silently and risking lost edits.
      if (err && err.status === 403) document.dispatchEvent(new CustomEvent("iris:writeforbidden"));
      return false;
    }
  }

  async function compileCurrent(data, options) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    data = data && typeof data === "object" ? data : (window.IrisApp ? window.IrisApp.serialize() : {});
    const now = Date.now();
    data.updatedAt = now;
    cache.set(currentId, data);
    const m = metaOf(currentId);
    if (m) {
      m.name = (data.project && data.project.name) || m.name;
      m.updatedAt = now;
      m.fileCount = countFiles(data);
      m.projectType = data.projectType || m.projectType || "latex";
    }
    const out = await api(`/api/projects/${currentId}/compile`, {
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
    return out;
  }

  async function downloadCurrentFile(filePath, fileName) {
    if (!currentId) throw new Error(t("projects.noneOpen"));
    const query = new URLSearchParams({ path: String(filePath || "") });
    const res = await fetch(`/api/projects/${currentId}/files/download?${query}`, { credentials: "same-origin" });
    if (!res.ok) throw await errorFromResponse(res);
    saveBlob(await res.blob(), fileName || String(filePath || "download").split("/").pop());
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
  async function createProject(name, projectType) {
    const now = Date.now();
    projectType = projectType === "lilypond" ? "lilypond" : "latex";
    const data = {
      project: { name, nodes: blankNodes(name, projectType) },
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
      currentId = null;
      await window.IrisI18n.useDefaultLanguage({ silent: true });
      await window.IrisMotion.closeProject();
    }
  }

  /* ---------------- modals ---------------- */
  let projMode = "new", projTargetId = null, delTargetId = null;

  function askNew() {
    projMode = "new"; projTargetId = null;
    $("projModalTitle").textContent = t("projects.newTitle");
    $("projModalOk").textContent = t("projects.create");
    $("projModalHint").textContent = t("projects.newLatexHint");
    $("projTypeField").style.display = "";
    $("projTypeSelect").value = "latex";
    $("projNameInput").value = "";
    $("projNameInput").classList.remove("nomatch");
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
    $("projNameInput").value = m ? m.name : "";
    $("projNameInput").classList.remove("nomatch");
    openModal("projModal");
    setTimeout(() => { const i = $("projNameInput"); i.focus(); i.select(); }, 40);
  }
  async function confirmProjModal() {
    const name = $("projNameInput").value.trim();
    if (!name) {
      const i = $("projNameInput");
      i.classList.add("nomatch"); i.focus();
      return;
    }
    const ok = $("projModalOk");
    ok.disabled = true;
    ok.classList.add("loading");
    try {
      if (projMode === "new") {
        const id = await createProject(name, $("projTypeSelect").value);
        await closeModal("projModal");
        await renderPicker();
        await openProject(id);
      } else {
        await renameProject(projTargetId, name);
        await closeModal("projModal");
        await renderPicker();
      }
    } catch (err) {
      $("projNameInput").classList.add("nomatch");
      $("projModalHint").textContent = window.IrisI18n.error(err, "projects.operationFailed");
    } finally {
      ok.disabled = false;
      ok.classList.remove("loading");
    }
  }
  function askDelete(id) {
    const m = metaOf(id);
    delTargetId = id;
    $("projDeleteText").textContent = t("projects.deleteConfirm", { name: m ? m.name : t("projects.thisProject") });
    openModal("projDelModal");
  }
  async function confirmDelete() {
    const ok = $("projDelOk");
    ok.disabled = true;
    try {
      await deleteProject(delTargetId);
      await closeModal("projDelModal");
      await renderPicker();
    } catch (err) {
      console.error(err);
    } finally {
      ok.disabled = false;
    }
  }

  /* ---------------- public API ---------------- */
  async function showPicker() {
    const dirty = !!(currentId && window.IrisApp && window.IrisApp.hasUnsavedChanges && window.IrisApp.hasUnsavedChanges());
    if (dirty && !(await confirmDiscardChanges())) return false;
    if (dirty) cache.delete(currentId);
    else await persistCurrent();
    const hadProject = !!currentId;
    currentId = null;
    await window.IrisI18n.useDefaultLanguage({ silent: true });
    setPickerLoading();
    if (hadProject) await Promise.all([window.IrisMotion.closeProject(), renderPicker()]);
    else await renderPicker();
    return true;
  }
  function onLogout() {
    if (unsavedDecision) {
      unsavedDecision.resolve(false);
      unsavedDecision = null;
    }
    currentId = null;
    cache.clear();
    index = [];
    void window.IrisI18n.useDefaultLanguage({ silent: true });
    window.IrisMotion.resetProject();
  }

  window.IrisProjects = { showPicker, openProject, closeCurrent, persistCurrent, compileCurrent, downloadCurrentFile, refreshCurrent, renderPicker, onLogout };

  /* ---------------- wiring ---------------- */
  function wire() {
    $("pkNew").addEventListener("click", askNew);
    const ne = $("pkNewEmpty"); if (ne) ne.addEventListener("click", askNew);
    $("pkImport").addEventListener("click", () => $("projectImportInput").click());
    $("projectImportInput").addEventListener("change", function () {
      const file = this.files && this.files[0];
      this.value = "";
      void handleProjectImport(file);
    });

    const back = $("btnCloseProject");
    if (back) back.addEventListener("click", () => closeCurrent());

    $("projModalOk").addEventListener("click", () => confirmProjModal());
    $("projNameInput").addEventListener("input", () => $("projNameInput").classList.remove("nomatch"));
    $("projTypeSelect").addEventListener("change", function () {
      $("projModalHint").textContent = t(this.value === "lilypond" ? "projects.newLilypondHint" : "projects.newLatexHint");
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
      if (event.key === "Escape" && unsavedDecision) void finishDiscardDecision(false);
    });
  }

  document.addEventListener("iris:languagechange", () => {
    if (document.documentElement.classList.contains("iris-authed") && !currentId) void renderPicker();
    if ($("projModal").classList.contains("on")) {
      if (projMode === "new") askNew();
      else if (projTargetId) askRename(projTargetId);
    }
    if (delTargetId && $("projDelModal").classList.contains("on")) askDelete(delTargetId);
  });
  window.IrisI18n.ready.then(wire);
})();
