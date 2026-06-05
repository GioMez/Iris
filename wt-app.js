/* ===================== WebTeX · app ===================== */
(function () {
  const $ = (id) => document.getElementById(id);
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
    texPath: "",          // directory of the LaTeX binaries (empty = system PATH)
    autoIndent: true,
    zoom: 1, fit: true,
    view: "preview",
    assets: {},           // path -> dataURL
    fonts: [],            // {family, name}
    appliedFont: null,
    selectedFolder: "",   // for attach destination
    lastRender: null,     // {html, math}
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
  function joinBin(dir, name) {
    if (!dir) return name;
    return dir.replace(/[\/\\]+$/, "") + "/" + name;
  }
  function updateBinResolved() {
    const el = $("binResolved");
    if (el) el.textContent = joinBin(state.texPath, state.engine);
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
  function renderTree() {
    const root = $("tree");
    root.innerHTML = "";
    const build = (nodes, depth, parentPath) => {
      nodes.forEach((n) => {
        if (n.type === "folder") {
          const el = document.createElement("div");
          el.className = `node indent-${depth}`;
          el.innerHTML = `<span class="tw">${n.open ? "▾" : "▸"}</span><span class="fi fold">▤</span><span class="nm">${n.name}</span>`;
          el.addEventListener("click", () => {
            n.open = !n.open;
            state.selectedFolder = n.name + "/";
            renderTree(); markFolder(n.name + "/");
          });
          root.appendChild(el);
          if (n.open) build(n.children, depth + 1, n.name + "/");
        } else {
          const el = document.createElement("div");
          el.className = `node indent-${depth}` + (n.id === state.activeId ? " active" : "");
          el.dataset.id = n.id;
          el.innerHTML = `<span class="tw"></span>${fileIcon(n.kind)}<span class="nm">${n.name}</span>` +
            (n.kind === "img" ? `<span class="tag">img</span>` : "");
          el.addEventListener("click", () => openFile(n.id));
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
  function docFileForCompile() {
    const f = findFile(state.activeId);
    if (f && f.kind === "tex" && /\\begin\s*\{document\}/.test(f.content)) return f;
    let main = null;
    walk(project.nodes, (x) => { if (!main && x.kind === "tex" && /\\documentclass/.test(x.content)) main = x; });
    return main || f;
  }
  function compile() {
    const f = docFileForCompile();
    if (!f) { toast("Nessun documento da compilare", "err"); return; }
    setView("preview");
    $("compiling").classList.add("on");
    $("compileMsg").textContent = `${state.engine} ${f.name}…`;
    $("stState").textContent = "compilazione…";
    $("stDot").className = "dotok";
    const t0 = performance.now();
    setTimeout(() => {
      const res = WTRender.compile(f.content, { assets: state.assets });
      state.lastRender = { html: res.html, math: res.math };
      try { layoutPages(); } catch (e) { console.error(e); }
      const ms = ((performance.now() - t0) / 1000 + 0.4).toFixed(1);
      buildLog(f, res, ms);
      updateStatus(res, ms);
      $("compiling").classList.remove("on");
    }, 620);
  }
  function buildLog(f, res, ms) {
    const L = [];
    const add = (cls, txt) => L.push(`<div class="log-l ${cls || ""}">${txt}</div>`);
    add("cmd", `$ ${state.engine} ${f.path}`);
    add("dim", `This is ${state.engine}, Version 3.141592653 (WebTeX)`);
    add("", `(./${f.path}  LaTeX2e &lt;2024-06-01&gt;`);
    add("dim", `Document Class: article 2024/01/01 v1.4 Standard LaTeX`);
    res.warnings.forEach((w) => add("warn", `! Warning: ${w.msg}${w.line ? ` (riga ${w.line})` : ""}`));
    if (res.errors.length) {
      res.errors.forEach((er) => {
        add("err", `! LaTeX Error: ${er.msg}.`);
        add("dim", `l.${er.line}`);
      });
      add("err", `\n! Compilazione fallita con ${res.errors.length} error${res.errors.length > 1 ? "i" : "e"}.`);
    } else {
      add("dim", `Output written on ${f.name.replace(/\.tex$/, ".pdf")} (${state.pages.length} pagine).`);
      add("ok", `\n✓ Compilazione completata in ${ms}s — ${state.pages.length} pagine, ${res.warnings.length} warning.`);
    }
    $("logView").innerHTML = L.join("");
  }
  function updateStatus(res, ms) {
    const errN = res.errors.length, warnN = res.warnings.length;
    $("stTime").textContent = `compilato ${new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })} · ${ms}s`;
    $("stMath").textContent = res.math.length ? `${res.math.length} formule` : "";
    const we = $("stWarn"), ee = $("stErr");
    if (warnN) { we.style.display = ""; we.textContent = `⚠ ${warnN} warning`; } else we.style.display = "none";
    if (errN) {
      ee.style.display = ""; ee.textContent = `✗ ${errN} error${errN > 1 ? "i" : "e"}`;
      $("stState").textContent = "errori"; $("stDot").className = "doterr";
      $("stState").parentElement.classList.remove("accent"); $("stState").parentElement.classList.add("err");
    } else {
      ee.style.display = "none";
      $("stState").textContent = "pronto"; $("stDot").className = "dotok";
      $("stState").parentElement.classList.add("accent"); $("stState").parentElement.classList.remove("err");
    }
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
    project.nodes.forEach((n) => { if (n.type === "folder") opts.push(`<option value="${n.name}/"${state.selectedFolder === n.name + "/" ? " selected" : ""}>${n.name}/</option>`); });
    return opts.join("");
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
  function doUpload() {
    const af = state.attachFile;
    if (!af) return;
    const dest = $("attachDest").value;
    const name = ($("attachRename").value || af.name).trim();
    const path = dest + name;
    state.assets[path] = af.data;
    // add to tree
    let folder = project.nodes;
    if (dest) { const fn = project.nodes.find((n) => n.type === "folder" && n.name + "/" === dest); if (fn) { fn.open = true; folder = fn.children; } }
    folder.push({ type: "file", id: "img_" + Date.now(), name, kind: "img", path, data: af.data });
    renderTree();
    // insert includegraphics
    if ($("attachInsert").classList.contains("on")) {
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
        const ff = new FontFace(fam, reader.result);
        await ff.load();
        document.fonts.add(ff);
        state.fonts.push({ family: fam, name: file.name });
        renderFontList();
        applyFont(fam);
        toast(`Font “${file.name}” caricato`);
      } catch (e) { toast("Impossibile caricare il font", "err"); }
    };
    reader.readAsArrayBuffer(file);
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
        <div><div class="nm" style="font-family:'${fo.family}'">${fo.name}</div><div class="fm">${fo.family}</div></div>
        <div class="use"><button class="pill${active ? " active" : ""}">${active ? "✓ in uso" : "usa nel progetto"}</button></div>`;
      el.querySelector(".pill").addEventListener("click", () => applyFont(active ? null : fo.family));
      box.appendChild(el);
    });
  }
  function applyFont(fam) {
    state.appliedFont = fam;
    if (fam) document.documentElement.style.setProperty("--proj-font", `'${fam}', 'CMU Serif', Georgia, serif`);
    else document.documentElement.style.removeProperty("--proj-font");
    renderFontList();
  }

  /* ---------------- download (print to PDF) ---------------- */
  function downloadPdf() {
    if (!state.pages.length) { toast("Compila prima di scaricare", "err"); return; }
    toast("Apro la finestra di stampa → Salva come PDF");
    const w = window.open("", "_blank");
    if (!w) { toast("Popup bloccato dal browser", "err"); return; }
    const pagesHTML = state.pages.map((p) => {
      const c = p.cloneNode(true);
      const pn = c.querySelector(".pagenum"); if (pn) pn.remove();
      return `<div class="sheet">${c.innerHTML}</div>`;
    }).join("");
    const katexCss = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">`;
    const font = state.appliedFont ? `'${state.appliedFont}', ` : "";
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${project.name}.pdf</title>${katexCss}
      <style>
        @page{size:A4;margin:18mm}
        body{margin:0;font-family:${font}'CMU Serif',Georgia,serif;color:#111;font-size:11pt;line-height:1.5}
        .sheet{page-break-after:always}
        .doc-title{text-align:center;font-size:1.9em;font-weight:700;margin:.3em 0}
        .doc-auth,.doc-date{text-align:center}.doc-date{color:#444;margin-bottom:1.6em}
        h2{font-size:1.35em}h3{font-size:1.12em}p{text-align:justify}
        .figbox{border:1px dashed #bbb;aspect-ratio:16/10;display:grid;place-items:center;color:#999;max-width:72%;margin:1em auto}
        img.fig{max-width:78%;display:block;margin:1em auto}.cap{text-align:center;font-size:.85em;color:#555}
        .tt{font-family:monospace}.eqn{text-align:center;margin:1em 0}
      </style></head><body>${pagesHTML}</body></html>`);
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 500);
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
    $("btnSettings").addEventListener("click", () => { renderFontList(); $("texPath").value = state.texPath; updateBinResolved(); $("settingsModal").classList.add("on"); });

    // latex binaries path (in Impostazioni → Compilazione)
    $("texPath").addEventListener("input", function () {
      state.texPath = this.value.trim();
      updateBinResolved();
      saveLayout();
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
      state.engine = m.dataset.engine; $("engineName").textContent = state.engine; em.classList.remove("on"); updateBinResolved(); persist();
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
    $("texPath").value = state.texPath;
    updateBinResolved();
  }
  function saveLayout() {
    const body = document.querySelector(".body");
    const cs = getComputedStyle(body);
    const out = {
      sideW: Math.round(parseFloat(cs.getPropertyValue("--side-w")) || 262),
      pvW: Math.round(parseFloat(cs.getPropertyValue("--pv-w")) || 600),
      sideCollapsed: body.classList.contains("side-collapsed"),
      autoIndent: state.autoIndent,
      texPath: state.texPath,
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

  /* ---------------- first compile (after KaTeX is ready) ---------------- */
  function firstCompile() {
    if (window.katex) compile();
    else setTimeout(firstCompile, 120);
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
      state.appliedFont = null; applyFont(null);
      state.lastRender = null; state.pages = []; state.curPage = 1;
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
      setTimeout(firstCompile, 140);
    },
    // Snapshot the active project for persistence.
    serialize() {
      const f = findFile(state.activeId);
      if (f && (f.kind === "tex" || f.kind === "bib")) f.content = area.value;
      return {
        project: { name: project.name, nodes: project.nodes },
        assets: state.assets,
        engine: state.engine,
        activeId: state.activeId,
        openTabs: state.openTabs.slice(),
        untitledN: state.untitledN,
      };
    },
    setName(name) { project.name = name; },
  };

  /* ---------------- boot ---------------- */
  loadLayout();
  renderFontList();
  updateZoomLabel();
  wire();
})();
