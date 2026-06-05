/* ===================== WebTeX · app ===================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const LINE_H = 13 * 1.65;

  /* ---------------- project (loaded by the projects layer) ---------------- */
  // The active project's file tree. Populated by WTApp.load() when the user
  // opens a project from the chooser screen (see wt-projects.js).
  let project = { name: "", nodes: [] };

  /* ---------------- state ---------------- */
  const state = {
    activeId: "main",
    openTabs: ["main"],
    engine: "pdflatex",
    compileProfile: { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] },
    texPath: "",          // directory of the LaTeX binaries (empty = system PATH)
    texPathLocked: false,
    autoIndent: true,
    zoom: 1, fit: true,
    view: "preview",
    assets: {},           // path -> dataURL
    fonts: [],            // {family, name}
    appliedFont: null,
    selectedFolder: "",   // for attach destination
    lastRender: null,     // {html, math}
    pdfDataUrl: null,
    pdfBlobUrl: null,
    pdfName: "",
    pages: [],
    curPage: 1,
    untitledN: 0,
    attachFile: null,
  };

  /* ---------------- persistence (delegated to the projects layer) ---------------- */
  function persist() {
    if (window.WTProjects) window.WTProjects.persistCurrent();
  }
  function walk(nodes, fn) {
    nodes.forEach((n) => { if (n.type === "folder") walk(n.children, fn); else fn(n); });
  }
  function findFile(id) { let r = null; walk(project.nodes, (f) => { if (f.id === id) r = f; }); return r; }

  /* ---------------- elements ---------------- */
  const area = $("codeArea"), layer = $("codeLayer"), gutter = $("gutter"), codeWrap = $("codeWrap");

  /* ---------------- editor ---------------- */
  function fileIcon(kind) {
    return kind === "tex" ? '<span class="fi tex">◆</span>'
      : kind === "img" ? '<span class="fi img">▣</span>'
      : kind === "bib" ? '<span class="fi bib">≣</span>'
      : '<span class="fi">▢</span>';
  }

  function paint() {
    const v = area.value;
    layer.innerHTML = WTLatex.highlight(v) + "\n";
    const lines = v.split("\n").length;
    const cur = curLine();
    let g = "";
    for (let i = 1; i <= lines; i++) g += `<div class="gl${i === cur ? " cur" : ""}">${i}</div>`;
    gutter.innerHTML = g;
    syncScroll();
    updateCursor();
  }
  function curLine() {
    return area.value.slice(0, area.selectionStart).split("\n").length;
  }
  function updateCursor() {
    const pos = area.selectionStart;
    const before = area.value.slice(0, pos);
    const ln = before.split("\n").length;
    const col = pos - before.lastIndexOf("\n");
    $("stCursor").textContent = `Ln ${ln}, Col ${col}`;
    // re-mark current gutter line
    const cur = before.split("\n").length;
    gutter.querySelectorAll(".gl").forEach((el, i) => el.classList.toggle("cur", i + 1 === cur));
  }
  function syncScroll() {
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
    gutter.scrollTop = area.scrollTop;
  }

  area.addEventListener("input", () => {
    const f = findFile(state.activeId);
    if (f) f.content = area.value;
    paint();
    renderOutline();
    schedulePersist();
  });
  area.addEventListener("scroll", syncScroll);
  area.addEventListener("keyup", updateCursor);
  area.addEventListener("click", updateCursor);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      insertAtCursor("  ");
    } else if (e.key === "Enter" && state.autoIndent) {
      e.preventDefault();
      insertAtCursor(WTLatex.indentOnEnter(area.value, area.selectionStart));
    }
  });
  function insertAtCursor(text) {
    const s = area.selectionStart, e = area.selectionEnd;
    area.value = area.value.slice(0, s) + text + area.value.slice(e);
    area.selectionStart = area.selectionEnd = s + text.length;
    const f = findFile(state.activeId); if (f) f.content = area.value;
    paint(); schedulePersist();
  }

  let persistT;
  function schedulePersist() { clearTimeout(persistT); persistT = setTimeout(persist, 400); }

  /* ---------------- LaTeX binaries path ---------------- */
  function compileCommandPreview() {
    const engine = state.engine || "pdflatex";
    if (!state.texPath) return engine + " (dal PATH del backend)";
    return state.texPath.replace(/[\/\\]+$/, "") + "/" + engine;
  }
  function updateCompileCommandPreview() {
    const el = $("compileCommandPreview");
    if (el) el.textContent = compileCommandPreview();
  }
  function presetCompileProfile(mode) {
    const presets = {
      quick: { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] },
      bibtex: { mode: "bibtex", steps: [
        { tool: "[engine]", args: ["[main]"] },
        { tool: "bibtex", args: ["output/[jobname]"] },
        { tool: "[engine]", args: ["[main]"] },
        { tool: "[engine]", args: ["[main]"] },
      ] },
      biber: { mode: "biber", steps: [
        { tool: "[engine]", args: ["[main]"] },
        { tool: "biber", args: ["--input-directory=output", "--output-directory=output", "[jobname]"] },
        { tool: "[engine]", args: ["[main]"] },
        { tool: "[engine]", args: ["[main]"] },
      ] },
      index: { mode: "index", steps: [
        { tool: "[engine]", args: ["[main]"] },
        { tool: "makeindex", args: ["-o", "output/[jobname].ind", "output/[jobname].idx"] },
        { tool: "[engine]", args: ["[main]"] },
      ] },
    };
    return JSON.parse(JSON.stringify(presets[mode] || presets.quick));
  }
  function normalizeCompileProfile(profile) {
    if (!profile || typeof profile !== "object") return presetCompileProfile("quick");
    const steps = Array.isArray(profile.steps) && profile.steps.length ? profile.steps : presetCompileProfile(profile.mode || "quick").steps;
    return {
      mode: profile.mode || "quick",
      steps: steps.slice(0, 12).map((s) => ({
        tool: s.tool || "[engine]",
        args: Array.isArray(s.args) ? s.args.map(String) : String(s.args || "[main]").split(/\s+/).filter(Boolean),
      })),
    };
  }
  function renderCompileProfile() {
    const preset = $("compilePreset");
    const box = $("compileSteps");
    const add = $("compileAddStep");
    if (!preset || !box || !add) return;
    const profile = normalizeCompileProfile(state.compileProfile);
    state.compileProfile = profile;
    preset.value = profile.mode || "quick";
    const custom = profile.mode === "custom";
    box.innerHTML = "";
    profile.steps.forEach((step, idx) => {
      const row = document.createElement("div");
      row.className = "compile-step";
      row.innerHTML = `<select class="select" data-step-tool>
          <option value="[engine]">motore scelto</option>
          <option value="pdflatex">pdflatex</option>
          <option value="xelatex">xelatex</option>
          <option value="lualatex">lualatex</option>
          <option value="xetex">xetex</option>
          <option value="bibtex">bibtex</option>
          <option value="biber">biber</option>
          <option value="makeindex">makeindex</option>
        </select>
        <input class="input" data-step-args spellcheck="false" autocomplete="off">
        <button class="node-act danger" type="button" data-step-del title="Elimina step">✕</button>`;
      row.querySelector("[data-step-tool]").value = step.tool;
      row.querySelector("[data-step-args]").value = (step.args || []).join(" ");
      row.querySelectorAll("select,input,button").forEach((el) => { el.disabled = !custom; });
      row.querySelector("[data-step-tool]").addEventListener("change", (e) => { step.tool = e.target.value; saveCompileProfile(); });
      row.querySelector("[data-step-args]").addEventListener("input", (e) => { step.args = e.target.value.trim().split(/\s+/).filter(Boolean); saveCompileProfile(); });
      row.querySelector("[data-step-del]").addEventListener("click", () => {
        state.compileProfile.steps.splice(idx, 1);
        if (!state.compileProfile.steps.length) state.compileProfile.steps.push({ tool: "[engine]", args: ["[main]"] });
        saveCompileProfile();
        renderCompileProfile();
      });
      box.appendChild(row);
    });
    add.disabled = !custom;
  }
  function saveCompileProfile() {
    state.compileProfile = normalizeCompileProfile(state.compileProfile);
    persist();
  }
  function updateTexPathControl() {
    const input = $("texPath");
    const hint = $("texPathHint");
    if (!input || !hint) return;
    input.value = state.texPath;
    input.disabled = state.texPathLocked;
    hint.innerHTML = state.texPathLocked
      ? `↳ configurato dal deployment Docker Compose; modifica il mapping nel file <b style="color:var(--s-cmd);margin:0 3px">docker-compose.yml</b>.`
      : `↳ la cartella che contiene gli eseguibili <b style="color:var(--s-cmd);margin:0 3px">pdflatex</b> <b style="color:var(--s-cmd);margin-right:3px">xelatex</b> <b style="color:var(--s-cmd)">lualatex</b>.`;
    updateCompileCommandPreview();
  }
  async function loadRuntimeConfig() {
    try {
      const res = await fetch("/api/config", { credentials: "same-origin" });
      if (!res.ok) return;
      const cfg = await res.json();
      const compile = cfg.compile || {};
      state.texPathLocked = !!compile.texPathLocked;
      if (state.texPathLocked) state.texPath = compile.texPath || "";
      updateTexPathControl();
    } catch (e) {}
  }

  /* ---------------- tabs ---------------- */
  function renderTabs() {
    const bar = $("ftabs");
    bar.innerHTML = "";
    state.openTabs.forEach((id) => {
      const f = findFile(id); if (!f) return;
      const t = document.createElement("div");
      t.className = "ftab" + (id === state.activeId ? " on" : "");
      t.innerHTML = `${fileIcon(f.kind)}<span>${f.name}</span><span class="x" data-x>✕</span>`;
      t.addEventListener("click", (e) => {
        if (e.target.closest("[data-x]")) { closeTab(id); return; }
        openFile(id);
      });
      bar.appendChild(t);
    });
  }
  function closeTab(id) {
    const i = state.openTabs.indexOf(id);
    state.openTabs.splice(i, 1);
    if (state.activeId === id) {
      const next = state.openTabs[Math.max(0, i - 1)] || state.openTabs[0];
      if (next) openFile(next);
      else { state.activeId = null; area.value = ""; paint(); }
    }
    renderTabs();
  }

  function openFile(id) {
    const f = findFile(id);
    if (!f) return;
    if (f.kind === "img") { previewImage(f); markTree(id); return; }
    state.activeId = id;
    if (!state.openTabs.includes(id)) state.openTabs.push(id);
    area.value = f.content || "";
    paint();
    renderTabs();
    renderOutline();
    markTree(id);
    area.focus();
  }

  /* ---------------- file tree ---------------- */
  const joinPath = (base, name) => (base ? base.replace(/\/+$/, "") + "/" : "") + name;
  const folderSlash = (p) => p ? p.replace(/\/+$/, "") + "/" : "";

  function validTreeName(name) {
    return !!name && name !== "." && name !== ".." && !/[\/\\]/.test(name);
  }
  function inferKind(name, prev) {
    if (prev === "img") return "img";
    if (/\.bib$/i.test(name)) return "bib";
    if (/\.(tex|txt)$/i.test(name)) return "tex";
    return prev || "tex";
  }
  function hasSiblingNamed(parent, node, name) {
    return parent.some((x) => x !== node && x.name.toLowerCase() === name.toLowerCase());
  }
  function walkNodeFiles(node, fn) {
    if (!node) return;
    if (node.type === "folder") (node.children || []).forEach((ch) => walkNodeFiles(ch, fn));
    else fn(node);
  }
  function firstFile() {
    let found = null;
    walk(project.nodes, (f) => { if (!found && f.kind !== "img") found = f; });
    if (!found) walk(project.nodes, (f) => { if (!found) found = f; });
    return found;
  }
  function moveAsset(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath || state.assets[oldPath] == null) return;
    state.assets[newPath] = state.assets[oldPath];
    delete state.assets[oldPath];
  }
  function updateFolderChildPaths(node, oldPrefix, newPrefix) {
    walkNodeFiles(node, (f) => {
      const oldPath = f.path || "";
      if (!oldPath.startsWith(oldPrefix)) return;
      const next = newPrefix + oldPath.slice(oldPrefix.length);
      f.path = next;
      moveAsset(oldPath, next);
    });
    Object.keys(state.assets).forEach((p) => {
      if (!p.startsWith(oldPrefix)) return;
      moveAsset(p, newPrefix + p.slice(oldPrefix.length));
    });
  }
  function clearEditorSelection() {
    state.activeId = null;
    state.openTabs = [];
    area.value = "";
    paint();
    renderTabs();
    renderOutline();
  }
  function removeTreeNode(target) {
    const idx = target.parent.indexOf(target.node);
    if (idx >= 0) target.parent.splice(idx, 1);
  }

  let treeAction = null;

  function openTreeRename(node, parent, parentPath) {
    treeAction = { node, parent, parentPath };
    const isFolder = node.type === "folder";
    $("treeRenameTitle").textContent = isFolder ? "Rinomina cartella" : "Rinomina file";
    $("treeRenameLabel").textContent = isFolder ? "Nome cartella" : "Nome file";
    $("treeRenameHint").textContent = "Usa un nome senza separatori di cartella.";
    $("treeRenameInput").value = node.name || "";
    $("treeRenameInput").classList.remove("nomatch");
    $("treeRenameModal").classList.add("on");
    setTimeout(() => { const i = $("treeRenameInput"); i.focus(); i.select(); }, 40);
  }
  function closeTreeRename() {
    $("treeRenameModal").classList.remove("on");
    treeAction = null;
  }
  function confirmTreeRename() {
    if (!treeAction) return;
    const node = treeAction.node;
    const name = $("treeRenameInput").value.trim();
    const input = $("treeRenameInput");
    const hint = $("treeRenameHint");
    if (!validTreeName(name)) {
      input.classList.add("nomatch");
      hint.textContent = "Il nome non puo' essere vuoto e non puo' contenere / o \\.";
      input.focus();
      return;
    }
    if (hasSiblingNamed(treeAction.parent, node, name)) {
      input.classList.add("nomatch");
      hint.textContent = "Esiste gia' un elemento con questo nome nella stessa cartella.";
      input.focus();
      return;
    }
    const oldName = node.name;
    if (node.type === "folder") {
      const oldPrefix = folderSlash(joinPath(treeAction.parentPath, oldName));
      const newPrefix = folderSlash(joinPath(treeAction.parentPath, name));
      node.name = name;
      updateFolderChildPaths(node, oldPrefix, newPrefix);
      if (state.selectedFolder && state.selectedFolder.startsWith(oldPrefix)) {
        state.selectedFolder = newPrefix + state.selectedFolder.slice(oldPrefix.length);
      }
    } else {
      const oldPath = node.path || joinPath(treeAction.parentPath, oldName);
      const newPath = joinPath(treeAction.parentPath, name);
      node.name = name;
      node.path = newPath;
      node.kind = inferKind(name, node.kind);
      moveAsset(oldPath, newPath);
      if (node.kind === "img" && node.data && !state.assets[newPath]) state.assets[newPath] = node.data;
    }
    closeTreeRename();
    renderTree();
    renderTabs();
    renderOutline();
    persist();
    toast(`Rinominato “${name}”`);
  }

  function openTreeDelete(node, parent, parentPath) {
    treeAction = { node, parent, parentPath };
    const isFolder = node.type === "folder";
    $("treeDeleteTitle").textContent = isFolder ? "Elimina cartella" : "Elimina file";
    $("treeDeleteText").innerHTML = isFolder
      ? `Vuoi eliminare la cartella <b>${esc(node.name)}</b> e tutto il suo contenuto? L'azione non e' reversibile.`
      : `Vuoi eliminare il file <b>${esc(node.name)}</b>? L'azione non e' reversibile.`;
    $("treeDeleteModal").classList.add("on");
  }
  function closeTreeDelete() {
    $("treeDeleteModal").classList.remove("on");
    treeAction = null;
  }
  function confirmTreeDelete() {
    if (!treeAction) return;
    const node = treeAction.node;
    const deletedIds = new Set();
    const deletedPaths = [];
    walkNodeFiles(node, (f) => {
      if (f.id) deletedIds.add(f.id);
      if (f.path) deletedPaths.push(f.path);
    });
    removeTreeNode(treeAction);
    deletedPaths.forEach((p) => delete state.assets[p]);
    if (node.type === "folder") {
      const prefix = folderSlash(joinPath(treeAction.parentPath, node.name));
      Object.keys(state.assets).forEach((p) => { if (p.startsWith(prefix)) delete state.assets[p]; });
      if (state.selectedFolder && state.selectedFolder.startsWith(prefix)) state.selectedFolder = "";
    }
    state.openTabs = state.openTabs.filter((id) => !deletedIds.has(id));
    const activeDeleted = deletedIds.has(state.activeId);
    closeTreeDelete();
    renderTree();
    if (activeDeleted) {
      const next = firstFile();
      if (next) openFile(next.id);
      else clearEditorSelection();
    } else {
      renderTabs();
      renderOutline();
    }
    persist();
    toast(`Eliminato “${node.name}”`);
  }

  function renderTree() {
    const root = $("tree");
    root.innerHTML = "";
    const build = (nodes, depth, parentPath) => {
      nodes.forEach((n) => {
        if (n.type === "folder") {
          const curPath = joinPath(parentPath, n.name);
          const el = document.createElement("div");
          el.className = `node indent-${depth}`;
          el.innerHTML = `<span class="tw">${n.open ? "▾" : "▸"}</span><span class="fi fold">▤</span><span class="nm">${esc(n.name)}</span>` +
            `<span class="node-tools">` +
              `<button class="node-act" type="button" data-act="rename" title="Rinomina">✎</button>` +
              `<button class="node-act danger" type="button" data-act="delete" title="Elimina">✕</button>` +
            `</span>`;
          el.addEventListener("click", () => {
            n.open = !n.open;
            state.selectedFolder = folderSlash(curPath);
            renderTree(); markFolder(n.name + "/");
          });
          el.querySelector('[data-act="rename"]').addEventListener("click", (e) => { e.stopPropagation(); openTreeRename(n, nodes, parentPath); });
          el.querySelector('[data-act="delete"]').addEventListener("click", (e) => { e.stopPropagation(); openTreeDelete(n, nodes, parentPath); });
          root.appendChild(el);
          if (n.open) build(n.children, depth + 1, curPath);
        } else {
          if (!n.path) n.path = joinPath(parentPath, n.name);
          const el = document.createElement("div");
          el.className = `node indent-${depth}` + (n.id === state.activeId ? " active" : "");
          el.dataset.id = n.id;
          el.innerHTML = `<span class="tw"></span>${fileIcon(n.kind)}<span class="nm">${esc(n.name)}</span>` +
            (n.kind === "img" ? `<span class="tag">img</span>` : "") +
            `<span class="node-tools">` +
              `<button class="node-act" type="button" data-act="rename" title="Rinomina">✎</button>` +
              `<button class="node-act danger" type="button" data-act="delete" title="Elimina">✕</button>` +
            `</span>`;
          el.addEventListener("click", () => openFile(n.id));
          el.querySelector('[data-act="rename"]').addEventListener("click", (e) => { e.stopPropagation(); openTreeRename(n, nodes, parentPath); });
          el.querySelector('[data-act="delete"]').addEventListener("click", (e) => { e.stopPropagation(); openTreeDelete(n, nodes, parentPath); });
          root.appendChild(el);
        }
      });
    };
    build(project.nodes, 0, "");
  }
  function markTree(id) {
    document.querySelectorAll("#tree .node").forEach((el) => el.classList.toggle("active", el.dataset.id === id));
  }
  function markFolder() {}

  /* ---------------- outline ---------------- */
  function renderOutline() {
    const f = findFile(state.activeId);
    const box = $("outline");
    if (!f || f.kind !== "tex") { box.innerHTML = `<div class="ol-empty">Nessuna struttura</div>`; return; }
    const items = WTLatex.outline(f.content);
    if (!items.length) { box.innerHTML = `<div class="ol-empty">Nessuna sezione nel documento</div>`; return; }
    box.innerHTML = "";
    items.forEach((it) => {
      const el = document.createElement("div");
      el.className = "ol-item" + (it.level === 2 ? " lvl2" : "");
      el.innerHTML = `<span class="num">${it.num}</span><span>${it.title}</span>`;
      el.addEventListener("click", () => gotoSection(it.title));
      box.appendChild(el);
    });
  }
  function gotoSection(title) {
    const idx = area.value.indexOf("{" + title + "}");
    if (idx < 0) return;
    const start = area.value.lastIndexOf("\\", idx);
    area.focus();
    area.selectionStart = area.selectionEnd = start;
    const ln = area.value.slice(0, start).split("\n").length;
    area.scrollTop = Math.max(0, (ln - 3) * LINE_H);
    syncScroll(); updateCursor();
  }

  /* ---------------- preview / pagination ---------------- */
  function pageWidthPx() {
    const stage = $("pvStage");
    if (state.fit) return Math.max(360, stage.clientWidth - 52);
    return Math.round(720 * state.zoom);
  }
  function renderMath(root, math) {
    root.querySelectorAll(".kx").forEach((el) => {
      const m = math[+el.dataset.idx];
      if (!m) return;
      try { katex.render(m.tex, el, { displayMode: m.display, throwOnError: false, errorColor: "#c0392b" }); }
      catch (e) { el.textContent = m.tex; }
    });
  }
  function layoutPages() {
    if (!state.lastRender) return;
    const { html, math } = state.lastRender;
    const wrap = $("pvPages");
    wrap.innerHTML = "";
    const w = pageWidthPx();
    const pageH = Math.round(w * 1.414);
    const budget = pageH - 128 - 28;

    const temp = document.createElement("div");
    temp.innerHTML = html;
    renderMath(temp, math);
    const children = Array.from(temp.children);

    const makePage = () => {
      const p = document.createElement("div");
      p.className = "page";
      p.style.width = w + "px";
      p.style.minHeight = pageH + "px";
      wrap.appendChild(p);
      return p;
    };
    let page = makePage(), used = 0, pageNo = 1;
    const stamp = (p, no) => {
      const f = document.createElement("div");
      f.className = "pagenum";
      f.textContent = no;
      p.appendChild(f);
    };
    children.forEach((ch) => {
      page.appendChild(ch);
      const cs = getComputedStyle(ch);
      const h = ch.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      if (used > 0 && used + h > budget) {
        page.removeChild(ch);
        stamp(page, pageNo++);
        page = makePage();
        page.appendChild(ch);
        used = ch.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      } else {
        used += h;
      }
    });
    stamp(page, pageNo);

    state.pages = Array.from(wrap.children);
    $("pgTot").textContent = state.pages.length;
    state.curPage = 1;
    $("pgCur").textContent = 1;
    $("pvEmpty").style.display = "none";
  }

  function updateZoomLabel() {
    const pct = Math.round((pageWidthPx() / 720) * 100);
    $("zVal").textContent = pct + "%";
    $("fitBtn").classList.toggle("on", state.fit);
  }

  /* ---------------- compile ---------------- */
  function projectSnapshot() {
    const f = findFile(state.activeId);
    if (f && (f.kind === "tex" || f.kind === "bib")) f.content = area.value;
    return {
      project: { name: project.name, nodes: project.nodes },
      assets: state.assets,
      engine: state.engine,
      compileProfile: state.compileProfile,
      fonts: state.fonts,
      appliedFont: state.appliedFont,
      activeId: state.activeId,
      openTabs: state.openTabs.slice(),
      untitledN: state.untitledN,
    };
  }
  function docFileForCompile() {
    const f = findFile(state.activeId);
    if (f && f.kind === "tex" && /\\begin\s*\{document\}/.test(f.content)) return f;
    let main = null;
    walk(project.nodes, (x) => { if (!main && x.kind === "tex" && /\\documentclass/.test(x.content)) main = x; });
    return main || f;
  }
  async function compile() {
    const f = docFileForCompile();
    if (!f) { toast("Nessun documento da compilare", "err"); return; }
    setView("preview");
    $("compiling").classList.add("on");
    $("compileMsg").textContent = `${state.engine} ${f.name}…`;
    $("stState").textContent = "compilazione…";
    $("stDot").className = "dotok";
    $("btnCompile").disabled = true;
    const t0 = performance.now();
    try {
      if (!window.WTProjects || !window.WTProjects.compileCurrent) throw new Error("Backend progetti non disponibile.");
      const res = await window.WTProjects.compileCurrent(projectSnapshot(), {
        engine: state.engine,
        mainPath: f.path,
        texPath: state.texPath,
        compileProfile: state.compileProfile,
      });
      const ms = ((res.durationMs || (performance.now() - t0)) / 1000).toFixed(1);
      buildLog(f, res, ms);
      updateCompileStatus(res, ms);
      if (res.pdfBase64) renderPdf(res);
      else {
        $("pvEmpty").style.display = "";
        $("pvPages").innerHTML = "";
        state.pages = [];
        $("pgTot").textContent = "–";
        $("pgCur").textContent = "–";
        setView("log");
      }
    } catch (err) {
      const ms = ((performance.now() - t0) / 1000).toFixed(1);
      const res = { success: false, log: `WebTeX: ${err.message || "compilazione non riuscita"}`, warnings: [], errors: [err.message || "Errore di compilazione"] };
      buildLog(f, res, ms);
      updateCompileStatus(res, ms);
      setView("log");
      toast("Compilazione non riuscita", "err");
    } finally {
      $("compiling").classList.remove("on");
      $("btnCompile").disabled = false;
    }
  }
  function buildLog(f, res, ms) {
    const cls = res.success ? "ok" : "err";
    const summary = res.success
      ? `\n✓ Compilazione completata in ${ms}s — ${res.pdfName || f.name.replace(/\.tex$/, ".pdf")}${res.pdfSize ? ` · ${(res.pdfSize / 1024).toFixed(0)} KB` : ""}.`
      : `\n! Compilazione fallita in ${ms}s${res.timedOut ? " · timeout" : ""}.`;
    const raw = `${res.log || ""}${summary}`;
    $("logView").innerHTML = raw.split(/\r?\n/).map((line) => {
      const rowClass = /^!|error|fatal|failed|fallita/i.test(line) ? "err"
        : /warning|overfull|underfull/i.test(line) ? "warn"
        : line.startsWith("$") || line.startsWith("✓") ? cls
        : "";
      return `<div class="log-l ${rowClass}">${esc(line || " ")}</div>`;
    }).join("");
  }
  function updateCompileStatus(res, ms) {
    const errN = (res.errors || []).length || (res.success ? 0 : 1);
    const warnN = (res.warnings || []).length;
    $("stTime").textContent = `compilato ${new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} · ${ms}s`;
    $("stMath").textContent = res.pdfSize ? `PDF ${(res.pdfSize / 1024).toFixed(0)} KB` : "";
    const we = $("stWarn"), ee = $("stErr");
    if (warnN) { we.style.display = ""; we.textContent = `⚠ ${warnN} warning`; } else we.style.display = "none";
    if (!res.success || errN) {
      ee.style.display = ""; ee.textContent = `✗ ${errN} error${errN > 1 ? "i" : "e"}`;
      $("stState").textContent = "errori"; $("stDot").className = "doterr";
      $("stState").parentElement.classList.remove("accent"); $("stState").parentElement.classList.add("err");
    } else {
      ee.style.display = "none";
      $("stState").textContent = "pronto"; $("stDot").className = "dotok";
      $("stState").parentElement.classList.add("accent"); $("stState").parentElement.classList.remove("err");
    }
  }
  function renderPdf(res) {
    if (state.pdfBlobUrl) URL.revokeObjectURL(state.pdfBlobUrl);
    const bin = atob(res.pdfBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/pdf" });
    state.pdfBlobUrl = URL.createObjectURL(blob);
    state.pdfDataUrl = `data:application/pdf;base64,${res.pdfBase64}`;
    state.pdfName = (res.pdfName || "output.pdf").split("/").pop();
    $("pvEmpty").style.display = "none";
    $("pvPages").innerHTML = `<div class="pdf-frame"><embed src="${state.pdfBlobUrl}" type="application/pdf"></div>`;
    state.pages = [];
    $("pgTot").textContent = "PDF";
    $("pgCur").textContent = "1";
    updateZoomLabel();
  }

  /* ---------------- view toggle ---------------- */
  function setView(v) {
    state.view = v;
    $("pvSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    $("logView").classList.toggle("on", v === "log");
    $("pvStage").classList.toggle("hide-pages", v === "log");
  }

  /* ---------------- toast ---------------- */
  function toast(msg, type) {
    const t = document.createElement("div");
    t.className = "toast" + (type === "err" ? " err" : "");
    t.innerHTML = `<span class="ic">${type === "err" ? "✕" : "✓"}</span>${msg}`;
    $("toasts").appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2200);
  }

  /* ---------------- attach ---------------- */
  function folderOptions() {
    const opts = [`<option value="">/ (radice)</option>`];
    const add = (nodes, parentPath) => {
      (nodes || []).forEach((n) => {
        if (n.type !== "folder") return;
        const rel = folderSlash(joinPath(parentPath, n.name));
        opts.push(`<option value="${esc(rel)}"${state.selectedFolder === rel ? " selected" : ""}>${esc(rel)}</option>`);
        add(n.children, rel);
      });
    };
    add(project.nodes, "");
    return opts.join("");
  }
  function folderChildrenByPath(folderPath) {
    if (!folderPath) return project.nodes;
    const parts = folderPath.replace(/\/+$/, "").split("/").filter(Boolean);
    let nodes = project.nodes;
    for (const part of parts) {
      const folder = nodes.find((n) => n.type === "folder" && n.name === part);
      if (!folder) return project.nodes;
      folder.open = true;
      nodes = folder.children || (folder.children = []);
    }
    return nodes;
  }
  function openAttach() {
    $("attachDest").innerHTML = folderOptions();
    if (state.selectedFolder) $("attachDest").value = state.selectedFolder;
    clearAttach();
    $("attachModal").classList.add("on");
  }
  function clearAttach() {
    state.attachFile = null;
    $("attachPicked").style.display = "none";
    $("attachRename").value = "";
    $("attachUpload").disabled = true;
  }
  function pickAttach(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.attachFile = { name: file.name, size: file.size, data: reader.result, isImg: file.type.startsWith("image/") };
      $("attachName").textContent = file.name;
      $("attachMeta").textContent = (file.size / 1024).toFixed(0) + " KB";
      $("attachRename").value = file.name;
      const thumb = $("attachThumb");
      if (state.attachFile.isImg) { thumb.style.display = ""; thumb.src = reader.result; }
      else thumb.style.display = "none";
      $("attachPicked").style.display = "";
      $("attachUpload").disabled = false;
    };
    reader.readAsDataURL(file);
  }
  function attachKind(name, isImg) {
    if (isImg) return "img";
    if (/\.bib$/i.test(name)) return "bib";
    if (/\.(tex|txt)$/i.test(name)) return "tex";
    return "file";
  }
  function doUpload() {
    const af = state.attachFile;
    if (!af) return;
    const dest = $("attachDest").value;
    const name = ($("attachRename").value || af.name).trim();
    const path = dest + name;
    state.assets[path] = af.data;
    // add to tree
    let folder = folderChildrenByPath(dest);
    const kind = attachKind(name, af.isImg);
    folder.push({ type: "file", id: "file_" + Date.now(), name, kind, path, data: af.data });
    renderTree();
    // insert includegraphics
    if (af.isImg && $("attachInsert").classList.contains("on")) {
      const f = findFile(state.activeId);
      if (f && f.kind === "tex") insertAtCursor(`\\includegraphics[width=0.7\\linewidth]{${path}}`);
    }
    persist();
    $("attachModal").classList.remove("on");
    toast(`“${name}” caricato in ${dest || "/"}`);
  }

  /* ---------------- fonts ---------------- */
  function pickFont(file) {
    if (!file) return;
    const fam = "WTUser_" + file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = reader.result;
        const path = uniqueFontPath(file.name);
        const ff = new FontFace(fam, `url(${dataUrl})`);
        await ff.load();
        document.fonts.add(ff);
        const prev = state.fonts.findIndex((x) => x.name.toLowerCase() === file.name.toLowerCase());
        const font = { family: fam, name: file.name, path, data: dataUrl };
        if (prev >= 0) state.fonts.splice(prev, 1, font);
        else state.fonts.push(font);
        renderFontList();
        applyFont(fam);
        persist();
        toast(`Font “${file.name}” caricato`);
      } catch (e) { toast("Impossibile caricare il font", "err"); }
    };
    reader.readAsDataURL(file);
  }
  function uniqueFontPath(name) {
    const clean = String(name || "font.ttf").replace(/[\/\\]/g, "-");
    let candidate = "fonts/" + clean;
    let n = 1;
    const taken = () => state.fonts.some((f) => f.path === candidate);
    while (taken()) {
      const dot = clean.lastIndexOf(".");
      candidate = "fonts/" + (dot > 0 ? `${clean.slice(0, dot)}-${n}${clean.slice(dot)}` : `${clean}-${n}`);
      n++;
    }
    return candidate;
  }
  async function registerProjectFont(font) {
    if (!font || !font.family || !font.data) return false;
    try {
      const ff = new FontFace(font.family, `url(${font.data})`);
      await ff.load();
      document.fonts.add(ff);
      return true;
    } catch (e) {
      console.warn("Font non caricabile", font.name, e);
      return false;
    }
  }
  function renderFontList() {
    const box = $("fontList");
    if (!state.fonts.length) { box.innerHTML = `<div class="hint" style="margin:0">Nessun font personalizzato. Quelli di sistema restano disponibili.</div>`; return; }
    box.innerHTML = "";
    state.fonts.forEach((fo) => {
      const el = document.createElement("div");
      el.className = "fontcard";
      const active = state.appliedFont === fo.family;
      el.innerHTML = `<div class="glyph" style="font-family:'${fo.family}'">Ag</div>
        <div><div class="nm" style="font-family:'${fo.family}'">${esc(fo.name)}</div><div class="fm">${esc(fo.path || fo.family)}</div></div>
        <div class="use"><button class="pill${active ? " active" : ""}">${active ? "✓ in uso" : "usa nel progetto"}</button></div>`;
      el.querySelector(".pill").addEventListener("click", () => applyFont(active ? null : fo.family));
      box.appendChild(el);
    });
  }
  function applyFont(fam, save) {
    if (save == null) save = true;
    state.appliedFont = fam;
    if (fam) document.documentElement.style.setProperty("--proj-font", `'${fam}', 'CMU Serif', Georgia, serif`);
    else document.documentElement.style.removeProperty("--proj-font");
    renderFontList();
    if (save) persist();
  }

  /* ---------------- download compiled PDF ---------------- */
  function downloadPdf() {
    if (!state.pdfBlobUrl) {
      toast("Compila prima di scaricare il PDF", "err");
      return;
    }
    const a = document.createElement("a");
    a.href = state.pdfBlobUrl;
    a.download = state.pdfName || `${project.name || "documento"}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------------- new / open / save ---------------- */
  const NEWDOC = `\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\n\\title{Nuovo documento}\n\\author{}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\section{}\n\n\\end{document}`;
  function newFile() {
    state.untitledN++;
    const id = "untitled_" + state.untitledN;
    const name = `senza-nome-${state.untitledN}.tex`;
    project.nodes.push({ type: "file", id, name, kind: "tex", path: name, content: NEWDOC });
    renderTree();
    openFile(id);
    persist();
    toast(`Creato ${name}`);
  }
  function openExternal(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const id = "open_" + Date.now();
      project.nodes.push({ type: "file", id, name: file.name, kind: file.name.endsWith(".bib") ? "bib" : "tex", path: file.name, content: reader.result });
      renderTree(); openFile(id); persist(); toast(`Aperto ${file.name}`);
    };
    reader.readAsText(file);
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    // topbar
    $("btnCompile").addEventListener("click", compile);
    $("btnFormat").addEventListener("click", () => {
      const f = findFile(state.activeId);
      if (!f || f.kind !== "tex") return;
      const pos = area.selectionStart;
      area.value = WTLatex.format(area.value);
      f.content = area.value;
      area.selectionStart = area.selectionEnd = Math.min(pos, area.value.length);
      paint(); schedulePersist();
      toast("Codice formattato");
    });
    $("btnSave").addEventListener("click", () => { persist(); toast("Documento salvato"); });
    $("btnNew").addEventListener("click", newFile);
    $("newFileBtn").addEventListener("click", newFile);
    $("btnOpen").addEventListener("click", () => { const i = document.createElement("input"); i.type = "file"; i.accept = ".tex,.bib,.txt"; i.onchange = () => i.files[0] && openExternal(i.files[0]); i.click(); });
    $("btnAttach").addEventListener("click", openAttach);
    $("dlBtn").addEventListener("click", downloadPdf);
    $("btnSettings").addEventListener("click", () => { renderFontList(); updateTexPathControl(); renderCompileProfile(); $("settingsModal").classList.add("on"); });

    // latex binaries path (in Impostazioni → Compilazione)
    $("texPath").addEventListener("input", function () {
      if (state.texPathLocked) return;
      state.texPath = this.value.trim();
      updateCompileCommandPreview();
      saveLayout();
    });
    $("compilePreset").addEventListener("change", function () {
      state.compileProfile = this.value === "custom"
        ? { mode: "custom", steps: normalizeCompileProfile(state.compileProfile).steps }
        : presetCompileProfile(this.value);
      saveCompileProfile();
      renderCompileProfile();
    });
    $("compileAddStep").addEventListener("click", () => {
      state.compileProfile = normalizeCompileProfile(state.compileProfile);
      state.compileProfile.mode = "custom";
      state.compileProfile.steps.push({ tool: "[engine]", args: ["[main]"] });
      saveCompileProfile();
      renderCompileProfile();
    });

    // auto-indent (in Impostazioni → Editor)
    $("autoIndent").addEventListener("click", function () {
      state.autoIndent = !state.autoIndent;
      this.classList.toggle("on", state.autoIndent);
      saveLayout();
    });

    // settings nav (tab switching)
    document.querySelectorAll(".set-nav .item").forEach((it) => {
      if (it.classList.contains("soon")) return;
      it.addEventListener("click", () => {
        document.querySelectorAll(".set-nav .item").forEach((x) => x.classList.toggle("on", x === it));
        const which = it.dataset.set;
        document.querySelectorAll(".set-pane").forEach((p) => { p.style.display = p.dataset.setpane === which ? "" : "none"; });
      });
    });

    // engine menu
    const em = $("engineMenu");
    $("engineBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const r = $("engineBtn").getBoundingClientRect();
      em.classList.toggle("on");
      if (em.classList.contains("on")) {
        // statusbar sits at the bottom: open the menu upward
        em.style.left = r.left + "px";
        em.style.top = (r.top - em.offsetHeight - 6) + "px";
      }
      em.querySelectorAll(".mi").forEach((m) => m.classList.toggle("on", m.dataset.engine === state.engine));
    });
    em.querySelectorAll(".mi").forEach((m) => m.addEventListener("click", () => {
      state.engine = m.dataset.engine; $("engineName").textContent = state.engine; em.classList.remove("on"); updateCompileCommandPreview(); persist();
    }));
    document.addEventListener("click", () => em.classList.remove("on"));

    // side tabs
    document.querySelectorAll(".side-tab").forEach((t) => t.addEventListener("click", () => {
      document.querySelectorAll(".side-tab").forEach((x) => x.classList.toggle("on", x === t));
      const which = t.dataset.side;
      document.querySelector('[data-panel="files"]').style.display = which === "files" ? "" : "none";
      document.querySelector('[data-panel="outline"]').style.display = which === "outline" ? "" : "none";
      if (which === "outline") renderOutline();
    }));

    // preview controls
    $("pvSeg").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    $("zIn").addEventListener("click", () => { state.fit = false; state.zoom = Math.min(2.5, state.zoom + 0.1); layoutPages(); updateZoomLabel(); });
    $("zOut").addEventListener("click", () => { state.fit = false; state.zoom = Math.max(0.4, state.zoom - 0.1); layoutPages(); updateZoomLabel(); });
    $("fitBtn").addEventListener("click", () => { state.fit = !state.fit; layoutPages(); updateZoomLabel(); });
    $("pgPrev").addEventListener("click", () => gotoPage(state.curPage - 1));
    $("pgNext").addEventListener("click", () => gotoPage(state.curPage + 1));
    $("pvStage").addEventListener("scroll", onStageScroll);
    $("stErr").addEventListener("click", () => setView("log"));
    $("stWarn").addEventListener("click", () => setView("log"));

    // modal close
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => {
      $("attachModal").classList.remove("on"); $("settingsModal").classList.remove("on");
    }));
    document.querySelectorAll(".scrim").forEach((s) => s.addEventListener("click", (e) => { if (e.target === s) s.classList.remove("on"); }));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".scrim.on").forEach((s) => s.classList.remove("on")); });

    // file tree modals
    $("treeRenameOk").addEventListener("click", confirmTreeRename);
    $("treeRenameInput").addEventListener("input", () => {
      $("treeRenameInput").classList.remove("nomatch");
      $("treeRenameHint").textContent = "Usa un nome senza separatori di cartella.";
    });
    $("treeRenameInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); confirmTreeRename(); }
      else if (e.key === "Escape") { e.preventDefault(); closeTreeRename(); }
    });
    $("treeDeleteOk").addEventListener("click", confirmTreeDelete);
    document.querySelectorAll("[data-tree-close]").forEach((b) => b.addEventListener("click", () => {
      closeTreeRename();
      closeTreeDelete();
    }));
    ["treeRenameModal", "treeDeleteModal"].forEach((id) => {
      const modal = $(id);
      modal.addEventListener("click", (e) => {
        if (e.target !== modal) return;
        if (id === "treeRenameModal") closeTreeRename();
        else closeTreeDelete();
      });
    });

    // attach modal
    $("attachDrop").addEventListener("click", () => $("attachInput").click());
    $("attachInput").addEventListener("change", () => $("attachInput").files[0] && pickAttach($("attachInput").files[0]));
    $("attachClear").addEventListener("click", clearAttach);
    $("attachUpload").addEventListener("click", doUpload);
    dnd($("attachDrop"), pickAttach);
    dnd($("sideDrop"), (f) => { openAttach(); pickAttach(f); });
    $("sideDrop").addEventListener("click", openAttach);

    // settings fonts
    $("fontDrop").addEventListener("click", () => $("fontInput").click());
    $("fontInput").addEventListener("change", () => $("fontInput").files[0] && pickFont($("fontInput").files[0]));
    dnd($("fontDrop"), pickFont);

    window.addEventListener("resize", () => { if (state.lastRender && state.fit) { layoutPages(); updateZoomLabel(); } });

    // ---- find / replace ----
    $("btnFind").addEventListener("click", () => findOpen(false));
    $("findClose").addEventListener("click", findClose);
    $("findNext").addEventListener("click", () => findStep(1));
    $("findPrev").addEventListener("click", () => findStep(-1));
    $("findCase").addEventListener("click", function () {
      fState.caseSensitive = !fState.caseSensitive;
      this.classList.toggle("on", fState.caseSensitive);
      fState.idx = 0; findCompute(); if (fState.matches.length) findSelect(false);
    });
    $("findInput").addEventListener("input", () => { fState.idx = 0; findCompute(); if (fState.matches.length) findSelect(false); });
    $("findInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); findClose(); }
    });
    $("replaceInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); findReplaceOne(); }
      else if (e.key === "Escape") { e.preventDefault(); findClose(); }
    });
    $("replaceOne").addEventListener("click", findReplaceOne);
    $("replaceAll").addEventListener("click", findReplaceAll);

    // ---- layout: resizers + collapse ----
    setupResizer($("rz1"), "side");
    setupResizer($("rz2"), "pv");
    $("btnSidebar").addEventListener("click", toggleSidebar);

    // ---- global shortcuts ----
    document.addEventListener("keydown", (e) => {
      if (!document.documentElement.classList.contains("wt-authed")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "f" || e.key === "F")) { e.preventDefault(); findOpen(false); }
      else if (mod && (e.key === "h" || e.key === "H")) { e.preventDefault(); findOpen(true); }
    });
  }
  function dnd(el, cb) {
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag"); });
    el.addEventListener("dragleave", () => el.classList.remove("drag"));
    el.addEventListener("drop", (e) => { e.preventDefault(); el.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f) cb(f); });
  }
  function gotoPage(n) {
    n = Math.max(1, Math.min(state.pages.length, n));
    state.curPage = n;
    const p = state.pages[n - 1];
    if (p) $("pvStage").scrollTo({ top: p.offsetTop - 26, behavior: "smooth" });
    $("pgCur").textContent = n;
  }
  function onStageScroll() {
    if (!state.pages.length) return;
    const top = $("pvStage").scrollTop + 80;
    let cur = 1;
    state.pages.forEach((p, i) => { if (p.offsetTop <= top) cur = i + 1; });
    if (cur !== state.curPage) { state.curPage = cur; $("pgCur").textContent = cur; }
  }
  function previewImage(f) {
    setView("preview");
    $("pvEmpty").style.display = "none";
    $("pvPages").innerHTML = `<div class="page" style="width:${pageWidthPx()}px;min-height:auto;display:grid;place-items:center;padding:30px"><img src="${f.data}" style="max-width:100%;border-radius:3px"></div>`;
    state.pages = []; $("pgTot").textContent = "1"; $("pgCur").textContent = "1";
  }

  /* ---------------- layout: resize + collapse ---------------- */
  const LS_LAYOUT = "webtex_layout";
  function loadLayout() {
    let L = {};
    try { L = JSON.parse(localStorage.getItem(LS_LAYOUT) || "{}") || {}; } catch (e) {}
    const body = document.querySelector(".body");
    if (L.sideW) body.style.setProperty("--side-w", L.sideW + "px");
    if (L.pvW) body.style.setProperty("--pv-w", Math.max(440, L.pvW) + "px");
    if (L.sideCollapsed) body.classList.add("side-collapsed");
    $("btnSidebar").classList.toggle("on", body.classList.contains("side-collapsed"));
    if (typeof L.autoIndent === "boolean") state.autoIndent = L.autoIndent;
    $("autoIndent").classList.toggle("on", state.autoIndent);
    if (typeof L.texPath === "string") state.texPath = L.texPath;
    updateTexPathControl();
  }
  function saveLayout() {
    const body = document.querySelector(".body");
    const cs = getComputedStyle(body);
    const out = {
      sideW: Math.round(parseFloat(cs.getPropertyValue("--side-w")) || 262),
      pvW: Math.round(parseFloat(cs.getPropertyValue("--pv-w")) || 600),
      sideCollapsed: body.classList.contains("side-collapsed"),
      autoIndent: state.autoIndent,
      texPath: state.texPathLocked ? "" : state.texPath,
    };
    try { localStorage.setItem(LS_LAYOUT, JSON.stringify(out)); } catch (e) {}
  }
  function setupResizer(el, which) {
    let startX = 0, startVal = 0, body = null;
    const onMove = (e) => {
      const dx = e.clientX - startX;
      if (which === "side") {
        body.style.setProperty("--side-w", Math.max(190, Math.min(460, startVal + dx)) + "px");
      } else {
        body.style.setProperty("--pv-w", Math.max(440, Math.min(window.innerWidth - 480, startVal - dx)) + "px");
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      el.classList.remove("drag");
      body.classList.remove("resizing");
      if (state.lastRender && state.fit) { layoutPages(); updateZoomLabel(); }
      saveLayout();
    };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      body = document.querySelector(".body");
      startX = e.clientX;
      const cs = getComputedStyle(body);
      startVal = parseFloat(cs.getPropertyValue(which === "side" ? "--side-w" : "--pv-w")) || (which === "side" ? 262 : 600);
      el.classList.add("drag");
      body.classList.add("resizing");
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }
  function toggleSidebar() {
    const body = document.querySelector(".body");
    body.classList.toggle("side-collapsed");
    $("btnSidebar").classList.toggle("on", body.classList.contains("side-collapsed"));
    saveLayout();
    setTimeout(() => { if (state.lastRender && state.fit) { layoutPages(); updateZoomLabel(); } }, 200);
  }

  /* ---------------- find / replace ---------------- */
  const fState = { matches: [], idx: 0, caseSensitive: false };
  function findOpen(focusReplace) {
    $("findBar").classList.add("on");
    const sel = area.value.slice(area.selectionStart, area.selectionEnd);
    if (sel && !sel.includes("\n")) $("findInput").value = sel;
    fState.idx = 0;
    findCompute();
    if (fState.matches.length) findSelect(false);
    const inp = focusReplace ? $("replaceInput") : $("findInput");
    inp.focus(); inp.select();
  }
  function findClose() {
    $("findBar").classList.remove("on");
    area.focus();
  }
  function findCompute() {
    const q = $("findInput").value;
    fState.matches = [];
    if (q) {
      const hay = fState.caseSensitive ? area.value : area.value.toLowerCase();
      const needle = fState.caseSensitive ? q : q.toLowerCase();
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) { fState.matches.push(i); i += q.length || 1; }
    }
    if (fState.idx >= fState.matches.length) fState.idx = 0;
    updateFindCount();
  }
  function updateFindCount() {
    const q = $("findInput").value, n = fState.matches.length;
    $("findCount").textContent = n ? `${fState.idx + 1}/${n}` : (q ? "0/0" : "");
    $("findInput").classList.toggle("nomatch", !!q && !n);
  }
  function findSelect() {
    const n = fState.matches.length; if (!n) return;
    const q = $("findInput").value, start = fState.matches[fState.idx];
    area.setSelectionRange(start, start + q.length);
    const ln = area.value.slice(0, start).split("\n").length;
    const target = (ln - 1) * LINE_H, view = area.clientHeight;
    if (target < area.scrollTop + 30 || target > area.scrollTop + view - 50)
      area.scrollTop = Math.max(0, target - view / 2);
    syncScroll();
    updateFindCount();
  }
  function findStep(dir) {
    const n = fState.matches.length; if (!n) return;
    fState.idx = (fState.idx + dir + n) % n;
    findSelect();
  }
  function commitEditor() {
    const f = findFile(state.activeId);
    if (f) f.content = area.value;
    paint(); renderOutline(); schedulePersist();
  }
  function findReplaceOne() {
    const n = fState.matches.length; if (!n) return;
    const q = $("findInput").value, rep = $("replaceInput").value, start = fState.matches[fState.idx];
    area.value = area.value.slice(0, start) + rep + area.value.slice(start + q.length);
    commitEditor();
    findCompute();
    if (fState.matches.length) {
      let ni = fState.matches.findIndex((m) => m >= start + rep.length);
      fState.idx = ni < 0 ? 0 : ni;
      findSelect();
    } else updateFindCount();
  }
  function findReplaceAll() {
    const q = $("findInput").value; if (!q) return;
    const n = fState.matches.length; if (!n) return;
    const rep = $("replaceInput").value;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), fState.caseSensitive ? "g" : "gi");
    area.value = area.value.replace(re, () => rep);
    commitEditor();
    fState.idx = 0; findCompute();
    toast(`${n} occorrenz${n > 1 ? "e sostituite" : "a sostituita"}`);
  }

  /* ---------------- WTApp: bridge used by the projects layer ---------------- */
  window.WTApp = {
    // Load a project's data into the editor and render everything.
    load(data) {
      data = data || {};
      project = (data.project && data.project.nodes) ? data.project : { name: data.name || "", nodes: [] };
      state.assets = data.assets || {};
      // rebuild image assets from the tree if not stored separately
      walk(project.nodes, (f) => { if (f.kind === "img" && f.data && f.path && !state.assets[f.path]) state.assets[f.path] = f.data; });
      state.engine = data.engine || "pdflatex";
      state.compileProfile = normalizeCompileProfile(data.compileProfile);
      state.fonts = Array.isArray(data.fonts) ? data.fonts : [];
      state.fonts.forEach((font) => registerProjectFont(font).then(() => renderFontList()));
      applyFont(data.appliedFont || null, false);
      if (state.pdfBlobUrl) URL.revokeObjectURL(state.pdfBlobUrl);
      state.lastRender = null; state.pdfDataUrl = null; state.pdfBlobUrl = null; state.pdfName = "";
      state.pages = []; state.curPage = 1;
      state.untitledN = data.untitledN || 0;
      state.zoom = 1; state.fit = true; state.view = "preview";
      $("engineName").textContent = state.engine;

      // resolve open tabs + active file
      let tabs = Array.isArray(data.openTabs) ? data.openTabs.filter((id) => findFile(id)) : [];
      let active = (data.activeId && findFile(data.activeId)) ? data.activeId : null;
      if (!active) walk(project.nodes, (f) => { if (!active && f.kind === "tex") active = f.id; });
      if (active && !tabs.includes(active)) tabs.unshift(active);
      state.openTabs = tabs;
      state.activeId = active;

      renderTree();
      renderTabs();
      // reset preview / status
      $("pvPages").innerHTML = ""; $("logView").innerHTML = "";
      $("pvEmpty").style.display = ""; $("pgTot").textContent = "–"; $("pgCur").textContent = "–";
      $("stTime").textContent = "non ancora compilato";
      $("stWarn").style.display = "none"; $("stErr").style.display = "none"; $("stMath").textContent = "";
      setView("preview");

      if (active) openFile(active);
      else { area.value = ""; paint(); renderOutline(); }
      updateZoomLabel();
    },
    // Snapshot the active project for persistence.
    serialize() {
      return projectSnapshot();
    },
    setName(name) { project.name = name; },
  };

  /* ---------------- boot ---------------- */
  loadLayout();
  loadRuntimeConfig();
  renderFontList();
  renderCompileProfile();
  updateZoomLabel();
  wire();
})();
