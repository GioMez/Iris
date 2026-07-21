/* ===================== WebTeX · projects ===================== */
/* Schermata di scelta progetti + persistenza backend.
   Il backend tiene auth/metadati in MariaDB e salva lo snapshot del progetto
   in una cartella dedicata sul filesystem. */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ti = (name, className = "", label = "") => window.WTIcons.icon(name, className, label);

  let index = [];
  let currentId = null;
  const cache = new Map();

  async function api(path, options) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(options && options.headers) },
      ...options,
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      if (res.status === 401 && window.WTAuth) window.WTAuth.showLogin();
      const err = new Error(data.error || "Errore di comunicazione con il server.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------------- blank content ---------------- */
  function blankNodes(name, projectType) {
    if (projectType === "lilypond") {
      const title = String(name || "Nuova partitura").replace(/["\\]/g, "");
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

\\title{${name}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduzione}


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
    const w = (ns) => (ns || []).forEach((x) => { if (x.type === "folder") w(x.children); else n++; });
    if (data && data.project && data.project.nodes) w(data.project.nodes);
    return n;
  }
  function fmtTime(ts) {
    if (!ts) return "-";
    const d = new Date(ts), now = new Date();
    const time = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return "oggi " + time;
    if (d.toDateString() === yest.toDateString()) return "ieri " + time;
    return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" });
  }
  function setProjName(name) {
    const el = $("projChipName");
    if (el) el.textContent = name || "-";
    document.title = name ? `${name} · WebTeX` : "WebTeX";
  }
  function setPickerLoading() {
    const grid = $("pkGrid"), empty = $("pkEmpty"), count = $("pkCount");
    if (count) count.textContent = "";
    if (empty) empty.style.display = "none";
    if (grid) {
      grid.style.display = "";
      grid.innerHTML = `<div class="pcard"><button class="pcard-open" type="button" disabled><span class="pcard-text"><span class="pcard-name">Caricamento...</span><span class="pcard-meta">recupero progetti dal server</span></span></button></div>`;
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

  /* ---------------- chooser render ---------------- */
  async function renderPicker() {
    const grid = $("pkGrid"), empty = $("pkEmpty"), count = $("pkCount");
    try {
      const idx = (await loadIndex()).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (count) count.textContent = idx.length ? `${idx.length} progett${idx.length > 1 ? "i" : "o"}` : "";
      grid.innerHTML = "";
      if (!idx.length) { empty.style.display = ""; grid.style.display = "none"; return; }
      empty.style.display = "none"; grid.style.display = "";
      idx.forEach((m) => {
        const nfiles = Number.isFinite(m.fileCount) ? m.fileCount : countFiles(cache.get(m.id));
        const card = document.createElement("div");
        card.className = "pcard";
        card.dataset.id = m.id;
        card.innerHTML =
          `<button class="pcard-open" type="button" title="Apri il progetto">` +
            `<span class="pcard-icon${m.projectType === "lilypond" ? " lilypond" : ""}">${ti(m.projectType === "lilypond" ? "music" : "file-code-2")}</span>` +
            `<span class="pcard-text">` +
              `<span class="pcard-name">${esc(m.name)}</span>` +
              `<span class="pcard-meta">${m.projectType === "lilypond" ? "LilyPond" : "LaTeX"} · ${nfiles} file · modificato ${fmtTime(m.updatedAt)}</span>` +
            `</span>` +
          `</button>` +
          `<div class="pcard-tools">` +
            `<button class="pcard-ic" type="button" data-act="rename" title="Rinomina" aria-label="Rinomina ${esc(m.name)}">${ti("edit")}</button>` +
            `<button class="pcard-ic danger" type="button" data-act="delete" title="Elimina" aria-label="Elimina ${esc(m.name)}">${ti("trash")}</button>` +
          `</div>`;
        card.querySelector(".pcard-open").addEventListener("click", () => openProject(m.id));
        card.querySelector('[data-act="rename"]').addEventListener("click", (e) => { e.stopPropagation(); askRename(m.id); });
        card.querySelector('[data-act="delete"]').addEventListener("click", (e) => { e.stopPropagation(); askDelete(m.id); });
        grid.appendChild(card);
      });
    } catch (err) {
      grid.style.display = "";
      empty.style.display = "none";
      grid.innerHTML = `<div class="picker-empty" style="display:block"><div class="pe-title">Impossibile caricare i progetti</div><div class="pe-sub">${esc(err.message)}</div></div>`;
    }
  }

  /* ---------------- open / close ---------------- */
  async function openProject(id) {
    try {
      const data = await loadData(id);
      if (!data || !window.WTApp) return;
      currentId = id;
      window.WTApp.load(data);
      const m = metaOf(id);
      setProjName(m ? m.name : (data.project && data.project.name) || "");
      document.documentElement.classList.add("wt-inproject");
    } catch (err) {
      console.error(err);
      await renderPicker();
    }
  }

  async function closeCurrent() {
    const dirty = !!(currentId && window.WTApp && window.WTApp.hasUnsavedChanges && window.WTApp.hasUnsavedChanges());
    if (dirty && !window.confirm("Il progetto contiene modifiche non salvate. Uscire e scartarle?")) return false;
    if (dirty) cache.delete(currentId);
    else await persistCurrent();
    currentId = null;
    document.documentElement.classList.remove("wt-inproject");
    await renderPicker();
    return true;
  }

  async function persistCurrent() {
    if (!currentId || !window.WTApp) return false;
    const data = window.WTApp.serialize();
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
      return false;
    }
  }

  async function compileCurrent(data, options) {
    if (!currentId) throw new Error("Nessun progetto aperto.");
    data = data && typeof data === "object" ? data : (window.WTApp ? window.WTApp.serialize() : {});
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

  /* ---------------- create / rename / delete ---------------- */
  async function createProject(name, projectType) {
    const now = Date.now();
    projectType = projectType === "lilypond" ? "lilypond" : "latex";
    const data = {
      project: { name, nodes: blankNodes(name, projectType) },
      projectType,
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
    if (id === currentId && window.WTApp) { window.WTApp.setName(name); setProjName(name); }
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
      document.documentElement.classList.remove("wt-inproject");
    }
  }

  /* ---------------- modals ---------------- */
  const openModal = (id) => $(id).classList.add("on");
  const closeModal = (id) => $(id).classList.remove("on");

  let projMode = "new", projTargetId = null, delTargetId = null;

  function askNew() {
    projMode = "new"; projTargetId = null;
    $("projModalTitle").textContent = "Nuovo progetto";
    $("projModalOk").textContent = "Crea progetto";
    $("projModalHint").textContent = "Verrà creato con un file main.tex iniziale.";
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
    $("projModalTitle").textContent = "Rinomina progetto";
    $("projModalOk").textContent = "Salva";
    $("projModalHint").textContent = "Il nome aiuta a riconoscere il progetto nell'elenco.";
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
        closeModal("projModal");
        await renderPicker();
        await openProject(id);
      } else {
        await renameProject(projTargetId, name);
        closeModal("projModal");
        await renderPicker();
      }
    } catch (err) {
      $("projNameInput").classList.add("nomatch");
      $("projModalHint").textContent = err.message || "Operazione non riuscita.";
    } finally {
      ok.disabled = false;
      ok.classList.remove("loading");
    }
  }
  function askDelete(id) {
    const m = metaOf(id);
    delTargetId = id;
    $("projDelName").textContent = m ? m.name : "questo progetto";
    openModal("projDelModal");
  }
  async function confirmDelete() {
    const ok = $("projDelOk");
    ok.disabled = true;
    try {
      await deleteProject(delTargetId);
      closeModal("projDelModal");
      await renderPicker();
    } catch (err) {
      console.error(err);
    } finally {
      ok.disabled = false;
    }
  }

  /* ---------------- public API ---------------- */
  async function showPicker() {
    const dirty = !!(currentId && window.WTApp && window.WTApp.hasUnsavedChanges && window.WTApp.hasUnsavedChanges());
    if (dirty && !window.confirm("Il progetto contiene modifiche non salvate. Uscire e scartarle?")) return false;
    if (dirty) cache.delete(currentId);
    else await persistCurrent();
    currentId = null;
    document.documentElement.classList.remove("wt-inproject");
    setPickerLoading();
    await renderPicker();
    return true;
  }
  function onLogout() {
    currentId = null;
    cache.clear();
    index = [];
    document.documentElement.classList.remove("wt-inproject");
  }

  window.WTProjects = { showPicker, openProject, closeCurrent, persistCurrent, compileCurrent, renderPicker, onLogout };

  /* ---------------- wiring ---------------- */
  function wire() {
    $("pkNew").addEventListener("click", askNew);
    const ne = $("pkNewEmpty"); if (ne) ne.addEventListener("click", askNew);

    const back = $("btnCloseProject");
    if (back) back.addEventListener("click", () => closeCurrent());

    const lo = $("pkLogout");
    if (lo) lo.addEventListener("click", () => openModal("logoutModal"));

    $("projModalOk").addEventListener("click", () => confirmProjModal());
    $("projNameInput").addEventListener("input", () => $("projNameInput").classList.remove("nomatch"));
    $("projTypeSelect").addEventListener("change", function () {
      $("projModalHint").textContent = this.value === "lilypond"
        ? "Verrà creato con un file main.ly testuale iniziale."
        : "Verrà creato con un file main.tex iniziale.";
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
  }

  wire();
})();
