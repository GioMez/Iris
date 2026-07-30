/* ===================== Iris · app ===================== */
(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  const openDialog = (target) => window.IrisMotion.openDialog(target);
  const closeDialog = (target, options) => window.IrisMotion.closeDialog(target, options);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ti = (name, className = "", label = "") => window.IrisIcons.icon(name, className, label);
  const activateOnKeyboard = (element, action) => element.addEventListener("keydown", (event) => {
    if (event.target !== element || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    action();
  });
  const PDF_CSS_UNITS = 96 / 72;
  const pdfjsReady = import("/vendor/pdfjs/pdf.min.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    return pdfjs;
  });

  /* ---------------- project (loaded by the projects layer) ---------------- */
  // The active project's file tree. Populated by IrisApp.load() when the user
  // opens a project from the chooser screen (see iris-projects.js).
  let project = { name: "", nodes: [] };

  /* ---------------- state ---------------- */
  const state = {
    activeId: "main",
    openTabs: ["main"],
    engine: "pdflatex",
    projectType: "latex",
    projectLanguage: "en",
    compileProfile: { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] },
    texPath: "",          // directory of the LaTeX binaries (empty = system PATH)
    texPathLocked: false,
    lilypondPath: "",     // directory of the LilyPond binary (empty = system PATH)
    lilypondPathLocked: false,
    lilypondArgs: "",
    lilypondFormat: "pdf",
    autoIndent: true,
    wordWrap: false,
    autoSave: false,
    autoSaveDelay: 600,
    zoom: 1, fit: true,
    view: "preview",
    previewKind: "empty",
    assets: {},           // path -> dataURL
    fonts: [],            // {family, name}
    previewFont: null,
    selectedFolder: "",   // for attach destination
    pdfBlobUrl: null,
    pdfName: "",
    pdfLoadingTask: null,
    pdfDocument: null,
    pdfRenderTasks: [],
    pdfRenderGeneration: 0,
    pdfLoadGeneration: 0,
    effectiveZoom: 1,
    pages: [],
    curPage: 1,
    untitledN: 0,
    attachFile: null,
    compiledArtifacts: [],
    lastCompile: null,
    previewBuildId: null,
    compileGeneration: 0,
    compiling: false,
    projectLoadGeneration: 0,
    outputGeneration: 0,
    dirtyFiles: new Map(), // file id -> edit revision not yet persisted
    editRevision: 0,
    role: "owner", // project role; "viewer" makes the workspace read-only
  };

  // The server enforces capabilities; this only shapes the UI. A viewer gets a
  // read-only workspace: no editing, saving, compiling or tree mutations.
  function isReadOnly() { return state.role === "viewer"; }

  /* ---------------- persistence (delegated to the projects layer) ---------------- */
  let persistQueue = Promise.resolve(true);
  function persist() {
    if (!window.IrisProjects || isReadOnly()) return Promise.resolve(false);
    const operation = async () => {
      const dirtyAtStart = new Map(state.dirtyFiles);
      const saved = await window.IrisProjects.persistCurrent();
      if (!saved) return false;
      let dirtyChanged = false;
      dirtyAtStart.forEach((revision, id) => {
        if (state.dirtyFiles.get(id) !== revision) return;
        state.dirtyFiles.delete(id);
        dirtyChanged = true;
      });
      if (dirtyChanged) {
        renderTabs();
        if (!state.dirtyFiles.size) clearTimeout(persistT);
      }
      // The save is what gives a file created in this session its canonical id,
      // and with it the ability to join a realtime room.
      syncRealtimeSession();
      return true;
    };
    persistQueue = persistQueue.then(operation, operation);
    return persistQueue;
  }
  function persistWhenDocumentClean() {
    return state.dirtyFiles.size ? Promise.resolve(false) : persist();
  }
  async function waitForPersistence() {
    let pending;
    do {
      pending = persistQueue;
      await pending;
    } while (pending !== persistQueue);
    return true;
  }
  function walk(nodes, fn) {
    nodes.forEach((n) => { if (n.type === "folder") walk(n.children, fn); else fn(n); });
  }
  function findFile(id) { let r = null; walk(project.nodes, (f) => { if (f.id === id) r = f; }); return r; }
  function inferProjectType(data) {
    if (data && (data.projectType === "latex" || data.projectType === "lilypond")) return data.projectType;
    let tex = 0, ly = 0;
    walk(project.nodes, (file) => {
      if (/\.ly$/i.test(file.path || file.name || "")) ly += 1;
      if (/\.tex$/i.test(file.path || file.name || "")) tex += 1;
    });
    return ly > 0 && tex === 0 ? "lilypond" : "latex";
  }

  function updateProjectTypeUi() {
    const lilypond = isLilyPondProject();
    const projectIcon = document.querySelector(".projchip .pdot");
    if (projectIcon) projectIcon.innerHTML = ti(lilypond ? "music" : "file-code-2");
    state.engine = lilypond ? "lilypond" : (state.engine === "lilypond" ? "pdflatex" : state.engine);
    $("engineName").textContent = state.engine;
    $("stLanguage").textContent = lilypond ? "LilyPond" : "LaTeX";
    $("engineBtn").title = t(lilypond ? "editor.lilypondCompiler" : "editor.latexEngine");
    $("engineBtn").disabled = lilypond;
    $("btnFormat").title = t(lilypond ? "editor.formatLilypond" : "editor.formatLatex");
    document.querySelectorAll("#engineMenu .mi").forEach((item) => {
      item.style.display = lilypond ? (item.dataset.engine === "lilypond" ? "" : "none") : (item.dataset.engine === "lilypond" ? "none" : "");
    });
    const newFileButton = document.querySelector('[data-new-type="file"]');
    if (newFileButton) newFileButton.textContent = t(lilypond ? "tree.fileLy" : "tree.fileTex");
    updateTexPathControl();
  }

  /* ---------------- editor (see iris-editor.js for the adapter) ---------------- */
  const ed = () => window.IrisEditor;
  function fileIcon(kind) {
    const icons = {
      tex: ["file-code-2", "tex"],
      ly: ["music", "ly"],
      img: ["photo", "img"],
      bib: ["book-2", "bib"],
      artifact: ["box", "artifact"],
    };
    const [name, tone = ""] = icons[kind] || ["file", ""];
    return `<span class="fi ${tone}">${ti(name)}</span>`;
  }

  // Caret position for the status bar, fed by the editor adapter's cursor
  // events and re-rendered on language switches.
  let lastCursor = { line: 1, column: 1 };
  function renderCursorStatus() {
    $("stCursor").textContent = t("status.cursor", { line: lastCursor.line, column: lastCursor.column });
  }

  function setWordWrap(enabled, save = false) {
    state.wordWrap = !!enabled;
    ed().setWordWrap(state.wordWrap);
    $("btnWrap").classList.toggle("on", state.wordWrap);
    $("btnWrap").setAttribute("aria-checked", state.wordWrap ? "true" : "false");
    const wrapLabel = t(state.wordWrap ? "status.wrapDisable" : "status.wrapEnable");
    $("btnWrap").setAttribute("aria-label", wrapLabel);
    $("btnWrap").title = wrapLabel;
    if (save) saveLayout();
  }

  const AUTOSAVE_MIN_SECONDS = 10;
  const AUTOSAVE_MAX_SECONDS = 86400;
  function normalizeAutoSaveDelay(value) {
    const seconds = Number.parseInt(value, 10);
    if (!Number.isFinite(seconds)) return 600;
    return Math.max(AUTOSAVE_MIN_SECONDS, Math.min(AUTOSAVE_MAX_SECONDS, seconds));
  }
  function updateAutoSaveControls() {
    const toggle = $("autoSave");
    const delay = $("autoSaveDelay");
    const group = $("autoSaveDelayGroup");
    if (!toggle || !delay || !group) return;
    toggle.classList.toggle("on", state.autoSave);
    toggle.setAttribute("aria-checked", state.autoSave ? "true" : "false");
    delay.disabled = !state.autoSave;
    delay.value = String(state.autoSaveDelay);
    group.setAttribute("aria-disabled", state.autoSave ? "false" : "true");
  }

  // Reflects the current project role in the workspace: CSS (via iris-readonly)
  // hides write controls and node tools, and the editor is locked so a viewer
  // cannot start editing and only discover the block on save.
  function applyRoleGate() {
    const ro = isReadOnly();
    document.documentElement.classList.toggle("iris-readonly", ro);
    ed().setReadOnly(ro);
    if (ro) { state.autoSave = false; clearTimeout(persistT); }
    updateAutoSaveControls();
  }

  // Every edit — typing, Tab/Enter inserts, find & replace, formatter — flows
  // through the adapter's change event; the app only owns the model side.
  //
  // In a realtime session the server owns persistence, so an edit is not "unsaved
  // work" the user must remember to save: the local tree is kept current for the
  // outline and the compiler, but the file is not marked dirty and no autosave is
  // scheduled. Without a session, the ordinary save path is unchanged.
  function wireEditorEvents() {
    ed().onChange(() => {
      const f = findFile(state.activeId);
      const realtime = isRealtimeFile(state.activeId);
      if (f) {
        f.content = ed().getValue();
        if (!realtime) markFileDirty(f.id);
      }
      renderOutline();
      if (!realtime) schedulePersist();
    });
    ed().onCursor((pos) => {
      lastCursor = pos;
      renderCursorStatus();
      // Moving onto or away from a line someone else is editing changes the
      // overlap warning without the participants themselves having changed.
      if (lastPeers.length) renderPresence(lastPeers);
    });
    ed().onPeers(renderPresence);
    window.IrisCollab.onStatus(renderSyncStatus);
    window.IrisCollab.onBuild(onRemoteBuild);
    // Losing write access mid-session drops the workspace to read-only in place,
    // exactly like the projects layer does when a write is refused.
    document.addEventListener("iris:collabrole", (event) => {
      if (event.detail.role === "viewer" && !isReadOnly()) {
        state.role = "viewer";
        applyRoleGate();
        toast(t("projects.writeForbidden"), "err");
      }
    });
    document.addEventListener("iris:collabrevoked", () => {
      toast(t("collab.revoked"), "err");
    });
    // A file the server will not share in realtime keeps the ordinary save path;
    // anything typed before that answer is still local, so it must be flagged.
    document.addEventListener("iris:collabunavailable", () => {
      const f = findFile(state.activeId);
      if (f && f.content !== undefined) markFileDirty(f.id);
      renderSyncStatus();
    });
  }

  /* ---------------- realtime session ---------------- */
  // Realtime needs the file's canonical id, so a document created in this session
  // joins only after the save that reconciles it (same rule as its history).
  function isRealtimeFile(id) {
    return !!id && window.IrisCollab.active() && window.IrisCollab.fileId() === canonicalFileId(id);
  }
  function canonicalFileId(id) {
    if (isCanonicalFileId(id)) return id;
    const node = findFile(id);
    const resolved = node && window.IrisProjects && window.IrisProjects.resolveFileId
      ? window.IrisProjects.resolveFileId(node.path)
      : null;
    return isCanonicalFileId(resolved) ? resolved : null;
  }
  // Joins the room for the open file, or leaves realtime behind for a file that
  // cannot have one yet.
  function syncRealtimeSession() {
    const node = findFile(state.activeId);
    if (!node || node.kind === "img" || node.generated || node.readOnly) {
      window.IrisCollab.leave();
      renderSyncStatus();
      return;
    }
    const fileId = canonicalFileId(node.id);
    if (!fileId) {
      window.IrisCollab.leave();
      renderSyncStatus();
      return;
    }
    window.IrisCollab.join(fileId, node.kind);
  }
  const SYNC_LABEL = {
    connecting: "collab.connecting",
    live: "collab.live",
    readonly: "collab.readonly",
    offline: "collab.offline",
    revoked: "collab.revoked",
    error: "collab.error",
  };
  function renderSyncStatus() {
    const chip = $("stSync");
    const label = $("stSyncLabel");
    if (!chip || !label) return;
    const status = window.IrisCollab.status();
    const key = SYNC_LABEL[status];
    chip.hidden = !key;
    if (!key) return;
    chip.dataset.sync = status;
    label.textContent = t(key);
    chip.title = t("collab.title");
  }

  /* ---------------- presence: who else is in this file ---------------- */
  // How close another participant has to be for the overlap warning. Editing the
  // same line, or one either side of it, is near enough that two people are
  // plausibly working on the same thing.
  const OVERLAP_LINES = 1;
  let lastPeers = [];

  // The same person in two tabs is two carets in the document but one entry in
  // the footer, listed by the line they are nearest to.
  function peopleFromPeers(peers) {
    const people = new Map();
    peers.forEach((peer) => {
      const key = peer.userId || peer.id;
      const existing = people.get(key);
      if (existing) {
        if (peer.line != null && (existing.line == null || peer.line < existing.line)) existing.line = peer.line;
        existing.carets += 1;
        return;
      }
      people.set(key, {
        name: peer.name || peer.username || t("collab.someone"),
        color: peer.color,
        role: peer.role,
        line: peer.line,
        carets: 1,
      });
    });
    return Array.from(people.values());
  }

  function overlappingPeers(peers) {
    return peers.filter((peer) => peer.line != null && Math.abs(peer.line - lastCursor.line) <= OVERLAP_LINES);
  }

  function renderPresence(peers) {
    lastPeers = Array.isArray(peers) ? peers : [];
    const chip = $("stPeers");
    if (!chip) return;
    const people = peopleFromPeers(lastPeers);
    chip.hidden = !people.length;
    if (!people.length) {
      chip.innerHTML = "";
      return;
    }
    const overlapping = overlappingPeers(lastPeers);
    const names = people.map((person) => person.name).join(", ");
    chip.classList.toggle("overlap", overlapping.length > 0);
    // The warning is deliberately non-blocking: it names the risk and leaves the
    // decision to the people involved, as agreed for semantic conflicts.
    chip.title = overlapping.length
      ? t("collab.overlapWarning", { names: overlappingPeers(lastPeers).map((peer) => peer.name || peer.username).join(", ") })
      : t("collab.peersTitle", { names });
    chip.setAttribute("aria-label", chip.title);
    chip.innerHTML =
      `<span class="peer-dots" aria-hidden="true">${people.slice(0, 4).map((person) =>
        `<span class="peer-dot" style="--peer-color:${esc(person.color)}" title="${esc(person.name)}">${esc(initialsOf(person.name))}</span>`).join("")}</span>` +
      `<span class="peer-count">${esc(people.length > 4 ? t("collab.peersMore", { count: people.length }) : names)}</span>` +
      (overlapping.length ? `<span class="peer-warn" aria-hidden="true">${ti("alert-triangle")}</span>` : "");
  }

  function initialsOf(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  /* ---------------- a newer compilation exists ---------------- */
  // The notice is driven by "there is a build newer than the one on screen",
  // not by "somebody compiled": that also covers arriving at a project whose
  // preview is already behind, and it stays silent for your own compilation.
  let newerBuild = null;
  function onRemoteBuild(build) {
    if (!build || !build.buildId) return;
    // Our own compilation is about to replace the preview by itself.
    if (state.compiling || build.buildId === state.previewBuildId) return;
    newerBuild = build;
    renderNewerBuild();
  }
  function clearNewerBuild() {
    if (!newerBuild) return;
    newerBuild = null;
    renderNewerBuild();
  }
  function renderNewerBuild() {
    const banner = $("pvNewer");
    const label = $("pvNewerText");
    if (!banner || !label) return;
    banner.hidden = !newerBuild;
    if (!newerBuild) return;
    const failed = newerBuild.status && newerBuild.status !== "succeeded";
    banner.classList.toggle("failed", !!failed);
    label.textContent = newerBuild.by
      ? t(failed ? "preview.newerFailedBy" : "preview.newerBy", { name: newerBuild.by })
      : t(failed ? "preview.newerFailed" : "preview.newer");
  }
  // Loads whatever the most recent finished build is, which is not necessarily
  // the one announced: several may have completed while the notice was up.
  async function loadNewerBuild() {
    const button = $("pvNewerLoad");
    const projectId = window.IrisProjects && window.IrisProjects.currentProjectId
      ? window.IrisProjects.currentProjectId()
      : null;
    if (!projectId || !window.IrisBuilds) return;
    button.disabled = true;
    button.classList.add("loading");
    try {
      await window.IrisBuilds.loadLatest(projectId);
      clearNewerBuild();
    } catch (err) {
      toast(window.IrisI18n.error(err, "preview.refreshFailed"), "err");
    } finally {
      button.disabled = false;
      button.classList.remove("loading");
    }
  }

  let persistT;
  function schedulePersist() {
    clearTimeout(persistT);
    if (!state.autoSave || !state.dirtyFiles.size) return;
    persistT = setTimeout(() => { void persist(); }, state.autoSaveDelay * 1000);
  }

  /* ---------------- compiler binaries path ---------------- */
  function isLilyPondProject() { return state.projectType === "lilypond"; }
  function currentCompilerPath() { return isLilyPondProject() ? state.lilypondPath : state.texPath; }
  function currentCompilerPathLocked() { return isLilyPondProject() ? state.lilypondPathLocked : state.texPathLocked; }
  function compileCommandPreview() {
    const engine = isLilyPondProject() ? "lilypond" : (state.engine || "pdflatex");
    const compilerPath = currentCompilerPath();
    const command = compilerPath ? compilerPath.replace(/[\/\\]+$/, "") + "/" + engine : engine;
    if (isLilyPondProject()) {
      return [command, `--${state.lilypondFormat}`, "--output=output/<name>", state.lilypondArgs.trim(), "file.ly"].filter(Boolean).join(" ");
    }
    return compilerPath ? command : `${command} (${t("editor.pathBackend")})`;
  }
  function updateCompileCommandPreview() {
    const el = $("compileCommandPreview");
    if (el) el.textContent = compileCommandPreview();
  }
  function presetCompileProfile(mode) {
    if (isLilyPondProject()) return { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] };
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
    if (isLilyPondProject()) return presetCompileProfile("quick");
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
    const controls = $("compilePipelineControls");
    if (!preset || !box || !add || !controls) return;
    const lilypond = isLilyPondProject();
    controls.hidden = lilypond;
    const profile = normalizeCompileProfile(state.compileProfile);
    state.compileProfile = profile;
    if (lilypond) {
      box.innerHTML = "";
      return;
    }
    preset.value = profile.mode || "quick";
    const custom = profile.mode === "custom";
    box.innerHTML = "";
    profile.steps.forEach((step, idx) => {
      const row = document.createElement("div");
      row.className = "compile-step";
      row.innerHTML = `<select class="select" data-step-tool>
          <option value="[engine]">${esc(t("settings.selectedEngine"))}</option>
          <option value="lilypond">lilypond</option>
          <option value="pdflatex">pdflatex</option>
          <option value="xelatex">xelatex</option>
          <option value="lualatex">lualatex</option>
          <option value="xetex">xetex</option>
          <option value="bibtex">bibtex</option>
          <option value="biber">biber</option>
          <option value="makeindex">makeindex</option>
        </select>
        <input class="input" data-step-args spellcheck="false" autocomplete="off">
        <button class="node-act danger" type="button" data-step-del title="${esc(t("settings.deleteStep"))}" aria-label="${esc(t("settings.deleteStep"))}">${ti("trash")}</button>`;
      row.querySelector("[data-step-tool]").value = step.tool;
      row.querySelectorAll('[data-step-tool] option[value="lilypond"]').forEach((option) => { option.hidden = true; });
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
    void persistWhenDocumentClean();
  }
  function updateTexPathControl() {
    const input = $("texPath");
    const hint = $("texPathHint");
    if (!input || !hint) return;
    const lilypond = isLilyPondProject();
    const compilerPath = currentCompilerPath();
    const locked = currentCompilerPathLocked();
    input.value = compilerPath;
    input.disabled = locked;
    $("projectTypeLabel").textContent = lilypond ? "LilyPond (.ly)" : "LaTeX (.tex)";
    $("compilerPathLabel").textContent = t(lilypond ? "settings.lilypondBinaryPath" : "settings.latexBinaryPath");
    $("compileSettingsDesc").textContent = t(lilypond ? "settings.compileDescriptionLilypond" : "settings.compileDescriptionLatex");
    $("lilypondArgsField").style.display = lilypond ? "" : "none";
    $("lilypondArgs").value = state.lilypondArgs;
    $("lilypondFormatField").style.display = lilypond ? "" : "none";
    $("lilypondFormat").value = state.lilypondFormat;
    const pathHint = locked
      ? t("settings.pathHintLocked")
      : t("settings.pathHintUnlocked", { executable: lilypond ? "lilypond" : "pdflatex" });
    hint.innerHTML = `${ti("info-circle", "hint-ti")}<span>${esc(pathHint)}</span>`;
    updateCompileCommandPreview();
  }
  async function loadRuntimeConfig() {
    try {
      const res = await fetch("/api/config", { credentials: "same-origin" });
      if (!res.ok) return;
      const cfg = await res.json();
      // Lets the operator retune how often this browser talks to the realtime
      // server without a code change.
      window.IrisCollab.configure(cfg.collab);
      const compile = cfg.compile || {};
      state.texPathLocked = !!compile.texPathLocked;
      if (state.texPathLocked) state.texPath = compile.texPath || "";
      state.lilypondPathLocked = !!compile.lilypondPathLocked;
      if (state.lilypondPathLocked) state.lilypondPath = compile.lilypondPath || "";
      updateTexPathControl();
    } catch (e) {}
  }

  /* ---------------- tabs ---------------- */
  function markFileDirty(id = state.activeId) {
    if (!id) return;
    const wasDirty = state.dirtyFiles.has(id);
    state.dirtyFiles.set(id, ++state.editRevision);
    if (!wasDirty) renderTabs();
  }

  function renderTabs() {
    const bar = $("ftabs");
    bar.innerHTML = "";
    state.openTabs.forEach((id) => {
      const f = findFile(id); if (!f) return;
      const t = document.createElement("div");
      const dirty = state.dirtyFiles.has(id);
      t.className = "ftab" + (id === state.activeId ? " on" : "") + (dirty ? " dirty" : "");
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", id === state.activeId ? "true" : "false");
      t.setAttribute("aria-label", dirty ? `${f.name}, ${window.IrisI18n.t("tree.dirty")}` : f.name);
      t.title = dirty ? `${f.name} — ${window.IrisI18n.t("tree.dirty")}` : f.name;
      t.tabIndex = 0;
      const closeLabel = window.IrisI18n.t(dirty ? "tree.closeDirtyTab" : "tree.closeTab", { name: f.name });
      t.innerHTML = `${fileIcon(f.kind)}<span class="tab-name"><span class="dot" aria-hidden="true"></span><span>${esc(f.name)}</span></span><button class="x" type="button" data-x aria-label="${esc(closeLabel)}">${ti("x")}</button>`;
      t.addEventListener("click", (e) => {
        if (e.target.closest("[data-x]")) { closeTab(id); return; }
        openFile(id);
      });
      activateOnKeyboard(t, () => openFile(id));
      bar.appendChild(t);
    });
  }
  function closeTab(id) {
    const i = state.openTabs.indexOf(id);
    state.openTabs.splice(i, 1);
    if (state.activeId === id) {
      const next = state.openTabs[Math.max(0, i - 1)] || state.openTabs[0];
      if (next) openFile(next);
      else {
        state.activeId = null;
        ed().load("", null);
        window.IrisCollab.leave();
        renderSyncStatus();
      }
    }
    renderTabs();
  }

  function openFile(id) {
    const f = findFile(id);
    if (!f) return;
    if (f.generated || f.readOnly) { toast(t("tree.generatedFile"), "err"); return; }
    closeResponsiveSidebar();
    if (f.kind === "img") { setWorkspaceView("preview"); previewImage(f); markTree(id); return; }
    setWorkspaceView("editor");
    state.activeId = id;
    if (!state.openTabs.includes(id)) state.openTabs.push(id);
    ed().load(f.content || "", f.kind);
    renderTabs();
    renderOutline();
    markTree(id);
    // Joining replaces the document just loaded with the authoritative one; the
    // local content stands in until the server answers.
    syncRealtimeSession();
    ed().focus();
  }

  /* ---------------- file tree ---------------- */
  const joinPath = (base, name) => (base ? base.replace(/\/+$/, "") + "/" : "") + name;
  const folderSlash = (p) => p ? p.replace(/\/+$/, "") + "/" : "";

  function validTreeName(name) {
    return !!name && name !== "." && name !== ".." && !/[\/\\]/.test(name);
  }
  function isReservedTreeName(name, parentPath = "") {
    return !parentPath && ["output", ".iris"].includes(String(name || "").toLowerCase());
  }
  function inferKind(name, prev) {
    if (prev === "img") return "img";
    if (/\.bib$/i.test(name)) return "bib";
    if (/\.ly$/i.test(name)) return "ly";
    if (/\.(tex|txt)$/i.test(name)) return "tex";
    return prev || "tex";
  }
  function hasSiblingNamed(parent, node, name) {
    return parent.some((x) => x !== node && x.name.toLowerCase() === name.toLowerCase());
  }
  function hasNamed(parent, name) {
    return (parent || []).some((x) => x.name.toLowerCase() === name.toLowerCase());
  }
  function walkNodeFiles(node, fn) {
    if (!node) return;
    if (node.type === "folder") (node.children || []).forEach((ch) => walkNodeFiles(ch, fn));
    else fn(node);
  }
  function firstFile() {
    let found = null;
    walk(project.nodes, (f) => { if (!found && !f.generated && f.kind !== "img") found = f; });
    if (!found) walk(project.nodes, (f) => { if (!found) found = f; });
    return found;
  }
  function moveAsset(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath || state.assets[oldPath] == null) return;
    state.assets[newPath] = state.assets[oldPath];
    delete state.assets[oldPath];
  }
  function isFontFilePath(filePath) {
    return /^fonts\/.+\.(?:ttf|otf|woff2?)$/i.test(String(filePath || ""));
  }
  function fontPreviewFamily(fileName) {
    return "IrisUser_" + String(fileName || "font").split("/").pop().replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");
  }
  function fontSettingsFromTree(fonts) {
    const existing = new Map((Array.isArray(fonts) ? fonts : []).filter((font) => font && font.path).map((font) => [font.path, font]));
    const found = [];
    const scan = (nodes, parentPath = "") => (nodes || []).forEach((node) => {
      if (!node || node.generated) return;
      if (node.type === "folder") {
        scan(node.children, joinPath(parentPath, node.name));
        return;
      }
      const filePath = node.path || joinPath(parentPath, node.name);
      if (!isFontFilePath(filePath)) return;
      const prior = existing.get(filePath) || {};
      found.push({
        ...prior,
        family: prior.family || fontPreviewFamily(filePath),
        name: String(filePath).split("/").pop(),
        path: filePath,
        ...(prior.data || node.data ? { data: prior.data || node.data } : {}),
      });
    });
    scan(project.nodes);
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }
  function moveFontSetting(oldPath, newPath) {
    const index = state.fonts.findIndex((font) => font.path === oldPath);
    if (index < 0) return;
    if (!isFontFilePath(newPath)) {
      state.fonts.splice(index, 1);
      return;
    }
    state.fonts[index].path = newPath;
    state.fonts[index].name = String(newPath).split("/").pop();
  }
  function removeFontSettings(paths) {
    const removed = new Set(paths);
    state.fonts = state.fonts.filter((font) => !removed.has(font.path));
    refreshFontSettingsUi();
  }
  function refreshFontSettingsUi() {
    state.fonts = fontSettingsFromTree(state.fonts);
    if (state.previewFont && !state.fonts.some((font) => font.family === state.previewFont)) setPreviewFont(null);
    else renderFontList();
  }
  function updateFolderChildPaths(node, oldPrefix, newPrefix) {
    walkNodeFiles(node, (f) => {
      const oldPath = f.path || "";
      if (!oldPath.startsWith(oldPrefix)) return;
      const next = newPrefix + oldPath.slice(oldPrefix.length);
      f.path = next;
      moveAsset(oldPath, next);
      moveFontSetting(oldPath, next);
    });
    Object.keys(state.assets).forEach((p) => {
      if (!p.startsWith(oldPrefix)) return;
      moveAsset(p, newPrefix + p.slice(oldPrefix.length));
    });
  }
  function clearEditorSelection() {
    state.activeId = null;
    state.openTabs = [];
    ed().load("", null);
    window.IrisCollab.leave();
    renderSyncStatus();
    renderTabs();
    renderOutline();
  }
  function removeTreeNode(target) {
    const idx = target.parent.indexOf(target.node);
    if (idx >= 0) target.parent.splice(idx, 1);
  }

  let treeAction = null;
  let newItemMode = "file";

  function folderNodeByPath(folderPath) {
    if (!folderPath) return { nodes: project.nodes, path: "" };
    const parts = folderPath.replace(/\/+$/, "").split("/").filter(Boolean);
    let nodes = project.nodes;
    let pathSoFar = "";
    for (const part of parts) {
      const folder = nodes.find((n) => n.type === "folder" && n.name === part);
      if (!folder || folder.generated || folder.readOnly) return null;
      folder.open = true;
      pathSoFar = folderSlash(joinPath(pathSoFar, folder.name));
      nodes = folder.children || (folder.children = []);
    }
    return { nodes, path: pathSoFar };
  }

  function writableSelectedFolderPath() {
    return folderNodeByPath(state.selectedFolder) ? state.selectedFolder : "";
  }

  function newItemDestPath() {
    const select = $("newItemDest");
    const value = select ? select.value : "";
    return folderNodeByPath(value) ? value : "";
  }

  function updateNewItemHint() {
    const dest = folderNodeByPath(newItemDestPath()) || { path: "" };
    $("newItemHint").textContent = t("tree.createdIn", { destination: dest.path || `/ (${t("common.root")})` });
  }

  function uniqueName(parent, base, ext) {
    let i = 1;
    let name = ext ? `${base}${ext}` : base;
    while (hasNamed(parent, name)) {
      i += 1;
      name = ext ? `${base}-${i}${ext}` : `${base}-${i}`;
    }
    return name;
  }

  function setNewItemMode(mode) {
    newItemMode = mode === "folder" ? "folder" : "file";
    document.querySelectorAll("[data-new-type]").forEach((b) => b.classList.toggle("on", b.dataset.newType === newItemMode));
    const dest = folderNodeByPath(newItemDestPath()) || { nodes: project.nodes, path: "" };
    const isFolder = newItemMode === "folder";
    $("newItemLabel").textContent = t(isFolder ? "tree.folderName" : "tree.fileName");
    $("newItemInput").value = isFolder
      ? uniqueName(dest.nodes, t("tree.newFolderBase"), "")
      : uniqueName(dest.nodes, t("tree.untitledBase", { number: state.untitledN + 1 }), ".tex");
    if (!isFolder && isLilyPondProject()) {
      $("newItemInput").value = uniqueName(dest.nodes, t("tree.untitledBase", { number: state.untitledN + 1 }), ".ly");
    }
    updateNewItemHint();
    $("newItemInput").classList.remove("nomatch");
  }

  function openNewItem(mode) {
    const destPath = writableSelectedFolderPath();
    $("newItemDest").innerHTML = folderOptions(destPath);
    $("newItemDest").value = destPath;
    setNewItemMode(mode);
    openDialog("treeNewModal");
    setTimeout(() => { const i = $("newItemInput"); i.focus(); i.select(); }, 40);
  }

  function closeNewItem() {
    void closeDialog("treeNewModal");
  }

  function confirmNewItem() {
    const input = $("newItemInput");
    const hint = $("newItemHint");
    const destPath = newItemDestPath();
    const dest = folderNodeByPath(destPath) || { nodes: project.nodes, path: "" };
    let name = input.value.trim();
    if (newItemMode === "file" && name && !/\.[A-Za-z0-9]{1,12}$/.test(name)) name += isLilyPondProject() ? ".ly" : ".tex";
    if (!validTreeName(name) || isReservedTreeName(name, dest.path)) {
      input.classList.add("nomatch");
      hint.textContent = t(isReservedTreeName(name, dest.path) ? "tree.rootNameReserved" : "tree.invalidName");
      input.focus();
      return;
    }
    if (hasNamed(dest.nodes, name)) {
      input.classList.add("nomatch");
      hint.textContent = t("tree.duplicateDestination");
      input.focus();
      return;
    }

    if (newItemMode === "folder") {
      dest.nodes.push({ type: "folder", name, open: true, children: [] });
      state.selectedFolder = folderSlash(joinPath(dest.path, name));
      closeNewItem();
      renderTree();
      void persistWhenDocumentClean();
      toast(t("tree.folderCreated", { name }));
      return;
    }

    state.untitledN++;
    const id = "untitled_" + state.untitledN;
    const filePath = joinPath(dest.path, name);
    const kind = inferKind(name, isLilyPondProject() ? "ly" : "tex");
    dest.nodes.push({ type: "file", id, name, kind, path: filePath, content: kind === "ly" ? NEWLY : newDocumentTemplate() });
    closeNewItem();
    renderTree();
    openFile(id);
    markFileDirty(id);
    schedulePersist();
    toast(t("tree.fileCreated", { path: filePath }));
  }

  function openTreeRename(node, parent, parentPath) {
    if (node.readOnly || node.generated) { toast(t("tree.generatedReadOnly"), "err"); return; }
    treeAction = { node, parent, parentPath };
    const isFolder = node.type === "folder";
    $("treeRenameTitle").textContent = t(isFolder ? "tree.renameFolder" : "tree.renameFile");
    $("treeRenameLabel").textContent = t(isFolder ? "tree.folderName" : "tree.fileName");
    $("treeRenameHint").textContent = t("tree.nameHint");
    $("treeRenameInput").value = node.name || "";
    $("treeRenameInput").classList.remove("nomatch");
    openDialog("treeRenameModal");
    setTimeout(() => { const i = $("treeRenameInput"); i.focus(); i.select(); }, 40);
  }
  function closeTreeRename() {
    void closeDialog("treeRenameModal");
    treeAction = null;
  }
  function confirmTreeRename() {
    if (!treeAction) return;
    const node = treeAction.node;
    const name = $("treeRenameInput").value.trim();
    const input = $("treeRenameInput");
    const hint = $("treeRenameHint");
    if (!validTreeName(name) || isReservedTreeName(name, treeAction.parentPath)) {
      input.classList.add("nomatch");
      hint.textContent = t(isReservedTreeName(name, treeAction.parentPath) ? "tree.rootNameReserved" : "tree.invalidName");
      input.focus();
      return;
    }
    if (hasSiblingNamed(treeAction.parent, node, name)) {
      input.classList.add("nomatch");
      hint.textContent = t("tree.duplicateSibling");
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
      moveFontSetting(oldPath, newPath);
      if (node.kind === "img" && node.data && !state.assets[newPath]) state.assets[newPath] = node.data;
    }
    closeTreeRename();
    renderTree();
    renderTabs();
    renderOutline();
    refreshFontSettingsUi();
    void persist();
    toast(t("tree.renamed", { name }));
  }

  function openTreeDelete(node, parent, parentPath) {
    if (node.readOnly || node.generated) { toast(t("tree.generatedOverwrite"), "err"); return; }
    treeAction = { node, parent, parentPath };
    const isFolder = node.type === "folder";
    $("treeDeleteTitle").textContent = t(isFolder ? "tree.deleteFolder" : "tree.deleteFile");
    $("treeDeleteText").textContent = t(isFolder ? "tree.deleteFolderConfirm" : "tree.deleteFileConfirm", { name: node.name });
    openDialog("treeDeleteModal");
  }
  function closeTreeDelete() {
    void closeDialog("treeDeleteModal");
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
    removeFontSettings(deletedPaths);
    if (node.type === "folder") {
      const prefix = folderSlash(joinPath(treeAction.parentPath, node.name));
      Object.keys(state.assets).forEach((p) => { if (p.startsWith(prefix)) delete state.assets[p]; });
      if (state.selectedFolder && state.selectedFolder.startsWith(prefix)) state.selectedFolder = "";
    }
    state.openTabs = state.openTabs.filter((id) => !deletedIds.has(id));
    deletedIds.forEach((id) => state.dirtyFiles.delete(id));
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
    void persist();
    toast(t("tree.deleted", { name: node.name }));
  }

  function renderTree() {
    const root = $("tree");
    root.innerHTML = "";
    const build = (nodes, depth, parentPath) => {
      nodes.forEach((n) => {
        if (n.type === "folder") {
          const curPath = joinPath(parentPath, n.name);
          const el = document.createElement("div");
          const folderPath = folderSlash(curPath);
          el.className = `node indent-${depth}` + (state.selectedFolder === folderPath ? " folder-selected" : "");
          el.dataset.folderPath = folderPath;
          el.setAttribute("role", "treeitem");
          el.setAttribute("aria-expanded", n.open ? "true" : "false");
          el.tabIndex = 0;
          el.innerHTML = `<span class="tw">${ti(n.open ? "chevron-down" : "chevron-right")}</span><span class="fi fold">${ti(n.open ? "folder-open" : "folder")}</span><span class="nm">${esc(n.name)}</span>` +
            (n.generated ? `<span class="tag">output</span>` : "") +
            (n.readOnly || n.generated ? "" : `<span class="node-tools">` +
              `<button class="node-act" type="button" data-act="rename" title="${esc(t("common.rename"))}" aria-label="${esc(t("tree.renameAria", { name: n.name }))}">${ti("edit")}</button>` +
              `<button class="node-act danger" type="button" data-act="delete" title="${esc(t("common.delete"))}" aria-label="${esc(t("tree.deleteAria", { name: n.name }))}">${ti("trash")}</button>` +
            `</span>`);
          const selectFolder = () => {
            n.open = !n.open;
            if (!n.readOnly && !n.generated) state.selectedFolder = folderPath;
            renderTree(); markFolder(n.name + "/");
          };
          el.addEventListener("click", selectFolder);
          activateOnKeyboard(el, selectFolder);
          const rename = el.querySelector('[data-act="rename"]');
          const del = el.querySelector('[data-act="delete"]');
          if (rename) rename.addEventListener("click", (e) => { e.stopPropagation(); openTreeRename(n, nodes, parentPath); });
          if (del) del.addEventListener("click", (e) => { e.stopPropagation(); openTreeDelete(n, nodes, parentPath); });
          root.appendChild(el);
          if (n.open) build(n.children, depth + 1, curPath);
        } else {
          if (!n.path) n.path = joinPath(parentPath, n.name);
          const el = document.createElement("div");
          el.className = `node indent-${depth}` + (n.id === state.activeId ? " active" : "");
          el.dataset.id = n.id;
          el.setAttribute("role", "treeitem");
          el.setAttribute("aria-selected", n.id === state.activeId ? "true" : "false");
          el.tabIndex = 0;
          // History exists only for versionable text sources: generated output
          // and binary assets (images, fonts) are never captured as revisions.
          const canHistory = !n.generated && n.kind !== "img" && n.kind !== "font";
          el.innerHTML = `<span class="tw"></span>${fileIcon(n.kind)}<span class="nm">${esc(n.name)}</span>` +
            (n.generated ? `<span class="tag">gen</span>` : (n.kind === "img" ? `<span class="tag">img</span>` : "")) +
            `<span class="node-tools">` +
              (canHistory ? `<button class="node-act" type="button" data-act="history" title="${esc(t("tree.history"))}" aria-label="${esc(t("tree.historyAria", { name: n.name }))}">${ti("history")}</button>` : "") +
              `<button class="node-act" type="button" data-act="download" title="${esc(t("common.download"))}" aria-label="${esc(t("tree.downloadAria", { name: n.name }))}">${ti("download")}</button>` +
            (n.readOnly || n.generated ? "" :
              `<button class="node-act" type="button" data-act="rename" title="${esc(t("common.rename"))}" aria-label="${esc(t("tree.renameAria", { name: n.name }))}">${ti("edit")}</button>` +
              `<button class="node-act danger" type="button" data-act="delete" title="${esc(t("common.delete"))}" aria-label="${esc(t("tree.deleteAria", { name: n.name }))}">${ti("trash")}</button>`) +
            `</span>`;
          const selectFile = () => {
            state.selectedFolder = folderSlash(parentPath);
            openFile(n.id);
          };
          el.addEventListener("click", selectFile);
          activateOnKeyboard(el, selectFile);
          const rename = el.querySelector('[data-act="rename"]');
          const del = el.querySelector('[data-act="delete"]');
          const download = el.querySelector('[data-act="download"]');
          const history = el.querySelector('[data-act="history"]');
          if (history) history.addEventListener("click", (e) => { e.stopPropagation(); void openFileHistory(n); });
          if (download) download.addEventListener("click", (e) => { e.stopPropagation(); void downloadTreeFile(n); });
          if (rename) rename.addEventListener("click", (e) => { e.stopPropagation(); openTreeRename(n, nodes, parentPath); });
          if (del) del.addEventListener("click", (e) => { e.stopPropagation(); openTreeDelete(n, nodes, parentPath); });
          root.appendChild(el);
        }
      });
    };
    build(project.nodes, 0, "");
  }

  function applyRefreshedFileTree(data) {
    if (!data || !data.project || !Array.isArray(data.project.nodes)) throw new Error("Invalid project tree");
    const previousActive = state.activeId;
    const previousPreviewFont = state.previewFont;
    project.name = data.project.name || project.name;
    project.nodes = data.project.nodes;
    state.assets = data.assets || {};
    state.fonts = fontSettingsFromTree(data.fonts);
    state.fonts.forEach((font) => { void registerProjectFont(font); });
    setPreviewFont(state.fonts.some((font) => font.family === previousPreviewFont) ? previousPreviewFont : null);

    state.openTabs = state.openTabs.filter((id) => {
      const file = findFile(id);
      return file && !file.generated && !file.readOnly;
    });
    let active = previousActive && findFile(previousActive);
    if (!active || active.generated || active.readOnly) active = firstFile();
    if (active && (active.generated || active.readOnly)) active = null;
    state.activeId = active ? active.id : null;
    if (state.activeId && !state.openTabs.includes(state.activeId)) state.openTabs.unshift(state.activeId);
    if (!folderNodeByPath(state.selectedFolder)) state.selectedFolder = "";

    renderTree();
    renderTabs();
    if (!active) {
      clearEditorSelection();
    } else if (active.kind === "img") {
      previewImage(active);
      markTree(active.id);
    } else {
      ed().load(active.content || "", active.kind);
      renderOutline();
      markTree(active.id);
      // Reloading the document leaves any realtime session behind, so it is
      // re-established for whichever file ended up active.
      syncRealtimeSession();
    }
  }

  async function refreshFileTree() {
    if (state.dirtyFiles.size) {
      toast(t("tree.refreshUnsaved"), "err");
      return;
    }
    const button = $("refreshTreeBtn");
    const revision = state.editRevision;
    const snapshot = JSON.stringify(projectSnapshot());
    button.disabled = true;
    button.classList.add("loading");
    try {
      if (!window.IrisProjects || !window.IrisProjects.refreshCurrent) throw new Error(t("editor.projectsBackendUnavailable"));
      const data = await window.IrisProjects.refreshCurrent();
      if (revision !== state.editRevision || state.dirtyFiles.size || JSON.stringify(projectSnapshot()) !== snapshot) {
        toast(t("tree.refreshChanged"), "err");
        return;
      }
      applyRefreshedFileTree(data);
      toast(t("tree.refreshed"));
    } catch (err) {
      if (err && err.stale) return;
      console.error("File tree refresh failed", err);
      toast(t("tree.refreshFailed"), "err");
    } finally {
      button.disabled = false;
      button.classList.remove("loading");
    }
  }

  async function downloadTreeFile(file) {
    try {
      if (!window.IrisProjects || !window.IrisProjects.downloadCurrentFile) throw new Error(t("editor.projectsBackendUnavailable"));
      await window.IrisProjects.downloadCurrentFile(file.path, file.name);
    } catch (err) {
      console.error("File download failed", err);
      toast(t("tree.downloadFailed", { name: file.name }), "err");
    }
  }
  function markTree(id) {
    document.querySelectorAll("#tree .node").forEach((el) => {
      const active = el.dataset.id === id;
      el.classList.toggle("active", active);
      el.classList.toggle("folder-selected", !!el.dataset.folderPath && el.dataset.folderPath === state.selectedFolder);
      if (el.dataset.id) el.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  function markFolder() {}

  /* ---------------- outline ---------------- */
  function renderOutline() {
    const f = findFile(state.activeId);
    const box = $("outline");
    if (!f || (f.kind !== "tex" && f.kind !== "ly")) { box.innerHTML = `<div class="ol-empty">${esc(t("tree.noOutline"))}</div>`; return; }
    const items = (f.kind === "ly" ? IrisLilyPond : IrisLatex).outline(f.content);
    if (!items.length) { box.innerHTML = `<div class="ol-empty">${esc(t("tree.noDocumentOutline"))}</div>`; return; }
    box.innerHTML = "";
    items.forEach((it) => {
      const el = document.createElement("div");
      const level = Math.max(1, Math.min(4, Number(it.level) || 1));
      el.className = "ol-item" + (level > 1 ? ` lvl${level}` : "");
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = it.num || "";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = it.title;
      label.title = it.title;
      el.append(num, label);
      el.addEventListener("click", () => gotoSection(it));
      activateOnKeyboard(el, () => gotoSection(it));
      box.appendChild(el);
    });
  }
  function gotoSection(item) {
    const value = ed().getValue();
    const idx = Number.isInteger(item.offset) ? item.offset : value.indexOf("{" + item.title + "}");
    if (idx < 0) return;
    const start = Number.isInteger(item.offset) ? idx : value.lastIndexOf("\\", idx);
    ed().focus();
    ed().select(start, start, { align: "top", margin: 2 });
  }

  /* ---------------- PDF preview ---------------- */
  function previewWidth() {
    return Math.max(320, $("pvStage").clientWidth - 52);
  }

  function cancelPdfRenders() {
    state.pdfRenderGeneration += 1;
    state.pdfRenderTasks.forEach((task) => task.cancel());
    state.pdfRenderTasks = [];
  }

  function releasePdfDocument() {
    cancelPdfRenders();
    const loadingTask = state.pdfLoadingTask;
    state.pdfLoadingTask = null;
    state.pdfDocument = null;
    if (!loadingTask || typeof loadingTask.destroy !== "function") return Promise.resolve();
    return loadingTask.destroy().catch((err) => {
      console.warn("PDF preview cleanup failed", err);
    });
  }

  async function layoutPdfPages() {
    if (!state.pdfDocument) return;
    cancelPdfRenders();
    const generation = state.pdfRenderGeneration;
    const doc = state.pdfDocument;
    const wrap = $("pvPages");
    let pages;
    try {
      pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    } catch (err) {
      if (generation !== state.pdfRenderGeneration || doc !== state.pdfDocument) return;
      throw err;
    }
    if (generation !== state.pdfRenderGeneration || doc !== state.pdfDocument) return;

    const availableWidth = previewWidth();
    const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
    const views = pages.map((page) => {
      const base = page.getViewport({ scale: 1 });
      const scale = state.fit ? availableWidth / base.width : PDF_CSS_UNITS * state.zoom;
      return { page, css: page.getViewport({ scale }), render: page.getViewport({ scale: scale * deviceScale }) };
    });
    state.effectiveZoom = views.length ? views[0].css.scale / PDF_CSS_UNITS : state.zoom;

    wrap.innerHTML = "";
    state.pages = views.map(({ css }) => {
      const pageEl = document.createElement("div");
      pageEl.className = "pdf-page";
      pageEl.style.width = `${Math.round(css.width)}px`;
      pageEl.style.height = `${Math.round(css.height)}px`;
      const canvas = document.createElement("canvas");
      pageEl.appendChild(canvas);
      wrap.appendChild(pageEl);
      return pageEl;
    });
    state.curPage = Math.min(Math.max(state.curPage, 1), state.pages.length || 1);
    $("pgTot").textContent = state.pages.length || "–";
    $("pgCur").textContent = state.pages.length ? state.curPage : "–";
    $("pvEmpty").style.display = state.pages.length ? "none" : "";
    updateZoomLabel();

    for (let i = 0; i < views.length; i++) {
      if (generation !== state.pdfRenderGeneration || doc !== state.pdfDocument) return;
      const canvas = state.pages[i].querySelector("canvas");
      const { page, render } = views[i];
      canvas.width = Math.ceil(render.width);
      canvas.height = Math.ceil(render.height);
      const task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: render });
      state.pdfRenderTasks.push(task);
      try {
        await task.promise;
      } catch (err) {
        if (err && err.name !== "RenderingCancelledException") throw err;
      } finally {
        state.pdfRenderTasks = state.pdfRenderTasks.filter((item) => item !== task);
      }
    }
  }

  function requestPdfLayout() {
    layoutPdfPages().catch((err) => {
      console.error("PDF preview render failed", err);
      toast(t("preview.refreshFailed"), "err");
    });
  }

  function layoutImagePages() {
    if (state.previewKind !== "image" || !state.pages.length) return;
    const availableWidth = previewWidth();
    const contentWidth = Math.max(1, availableWidth - 60);
    let firstScale = state.zoom;
    state.pages.forEach((page, index) => {
      const img = page.querySelector("img");
      if (!img) return;
      const naturalWidth = Number(img.dataset.naturalWidth) || img.naturalWidth || contentWidth;
      const scale = state.fit ? contentWidth / naturalWidth : state.zoom;
      if (index === 0) firstScale = scale;
      page.style.width = `${Math.max(80, Math.round(naturalWidth * scale + 60))}px`;
    });
    state.effectiveZoom = firstScale;
    updateZoomLabel();
  }

  function requestPreviewLayout() {
    if (state.pdfDocument) requestPdfLayout();
    else layoutImagePages();
  }

  function updateZoomLabel() {
    const pct = Math.round((state.fit ? state.effectiveZoom : state.zoom) * 100);
    $("zVal").textContent = pct + "%";
    $("fitBtn").classList.toggle("on", state.fit);
    const enabled = state.previewKind === "pdf" || state.previewKind === "image";
    $("zIn").disabled = !enabled;
    $("zOut").disabled = !enabled;
    $("fitBtn").disabled = !enabled;
  }

  function adjustPreviewZoom(delta) {
    if (state.previewKind !== "pdf" && state.previewKind !== "image") return;
    const current = state.fit ? state.effectiveZoom : state.zoom;
    state.fit = false;
    state.zoom = Math.max(0.1, Math.min(2.5, current + delta));
    requestPreviewLayout();
    updateZoomLabel();
  }

  function togglePreviewFit() {
    if (state.previewKind !== "pdf" && state.previewKind !== "image") return;
    if (state.fit) state.zoom = state.effectiveZoom;
    state.fit = !state.fit;
    requestPreviewLayout();
    updateZoomLabel();
  }

  /* ---------------- compile ---------------- */
  // A save carries the content of the files this client actually edited. Files it
  // only read are sent without content, and the server keeps the bytes already on
  // disk — which may be newer, written by a collaborator. This is what stops two
  // people with the same project open from overwriting each other's files.
  function snapshotNodes(nodes) {
    return (nodes || []).map((node) => {
      if (node.type === "folder") return { ...node, children: snapshotNodes(node.children) };
      const writable = state.dirtyFiles.has(node.id) || isRealtimeFile(node.id);
      if (writable || node.kind === "img" || node.data != null) return node;
      const { content, ...rest } = node;
      return rest;
    });
  }
  function projectSnapshot() {
    const f = findFile(state.activeId);
    if (f && (f.kind === "tex" || f.kind === "ly" || f.kind === "bib")) f.content = ed().getValue();
    return {
      project: { name: project.name, nodes: snapshotNodes(project.nodes) },
      projectType: state.projectType,
      language: state.projectLanguage,
      assets: state.assets,
      engine: state.engine,
      compileProfile: state.compileProfile,
      lilypondArgs: state.lilypondArgs,
      lilypondFormat: state.lilypondFormat,
      fonts: state.fonts,
      activeId: state.activeId,
      openTabs: state.openTabs.slice(),
      untitledN: state.untitledN,
      autoSave: state.autoSave,
      autoSaveDelay: state.autoSaveDelay,
    };
  }
  function docFileForCompile() {
    const f = findFile(state.activeId);
    if (isLilyPondProject()) {
      if (f && f.kind === "ly" && /\\score\b/.test(f.content || "")) return f;
      let score = null, first = null;
      walk(project.nodes, (x) => {
        if (!first && x.kind === "ly") first = x;
        if (!score && x.kind === "ly" && /\\score\b/.test(x.content || "")) score = x;
      });
      return score || first;
    }
    if (f && f.kind === "tex" && /\\begin\s*\{document\}/.test(f.content)) return f;
    let main = null;
    walk(project.nodes, (x) => { if (!main && x.kind === "tex" && /\\documentclass/.test(x.content)) main = x; });
    return main || f;
  }
  async function compile() {
    if (isReadOnly()) { toast(t("projects.readOnlyNotice")); return; }
    if (state.compiling) return;
    if (state.dirtyFiles.size) {
      toast(t("editor.saveBeforeCompile"), "err");
      $("btnSave").focus();
      return;
    }
    const f = docFileForCompile();
    if (!f) { toast(t("editor.nothingToCompile"), "err"); return; }
    const generation = ++state.compileGeneration;
    state.compiling = true;
    setWorkspaceView("preview");
    setView("preview");
    $("compiling").classList.add("on");
    $("compileMsg").textContent = `${state.engine} ${f.name}…`;
    $("stState").textContent = t("status.compiling");
    $("stDot").className = "dotok";
    $("btnCompile").disabled = true;
    const t0 = performance.now();
    try {
      if (!window.IrisProjects || !window.IrisProjects.compileCurrent) throw new Error(t("editor.projectsBackendUnavailable"));
      const res = await window.IrisProjects.compileCurrent(projectSnapshot(), {
        engine: state.engine,
        mainPath: f.path,
        texPath: state.texPath,
        lilypondPath: state.lilypondPath,
        lilypondArgs: state.lilypondArgs,
        lilypondFormat: state.lilypondFormat,
        compileProfile: state.compileProfile,
      });
      if (generation !== state.compileGeneration) return;
      const outputGeneration = ++state.outputGeneration;
      state.previewBuildId = res.buildId || null;
      clearNewerBuild();
      const ms = ((res.durationMs || (performance.now() - t0)) / 1000).toFixed(1);
      buildLog(f, res, ms);
      updateCompileStatus(res, ms);
      if (res.success && Array.isArray(res.artifacts) && res.artifacts.length) await renderCompiledOutput(res);
      else if (res.pdfBase64) await renderPdf(res);
      else {
        const loadGeneration = ++state.pdfLoadGeneration;
        await releasePdfDocument();
        if (outputGeneration !== state.outputGeneration || loadGeneration !== state.pdfLoadGeneration) return;
        clearCompiledArtifacts();
        state.previewKind = "empty";
        updateZoomLabel();
        $("pvEmpty").style.display = "";
        $("pvPages").innerHTML = "";
        state.pages = [];
        $("pgTot").textContent = "–";
        $("pgCur").textContent = "–";
        setView("log");
      }
    } catch (err) {
      if (generation !== state.compileGeneration) return;
      const outputGeneration = ++state.outputGeneration;
      const loadGeneration = ++state.pdfLoadGeneration;
      await releasePdfDocument();
      if (generation !== state.compileGeneration || outputGeneration !== state.outputGeneration || loadGeneration !== state.pdfLoadGeneration) return;
      clearCompiledArtifacts();
      state.previewBuildId = null;
      const ms = ((performance.now() - t0) / 1000).toFixed(1);
      const message = err.message || t("editor.compileFailed");
      const res = { success: false, log: t("editor.compileFailedLog", { message }), warnings: [], errors: [err.message || t("editor.compileError")] };
      buildLog(f, res, ms);
      updateCompileStatus(res, ms);
      setView("log");
      toast(t("editor.compileFailed"), "err");
    } finally {
      if (generation === state.compileGeneration) {
        state.compiling = false;
        $("compiling").classList.remove("on");
        $("btnCompile").disabled = false;
      }
    }
  }

  function cancelPendingBuild() {
    state.compileGeneration += 1;
    state.compiling = false;
    $("compiling").classList.remove("on");
    $("btnCompile").disabled = false;
  }

  // Called by the projects layer whenever the open project goes away (closed,
  // deleted, left, or replaced), which is also when the realtime session must go.
  function cancelPendingProjectLoad() {
    state.projectLoadGeneration += 1;
    window.IrisCollab.disconnect();
    clearNewerBuild();
    renderSyncStatus();
  }
  function buildLog(f, res, ms, remember = true) {
    if (remember) state.lastCompile = { f, res, ms, compiledAt: new Date() };
    const cls = res.success ? "ok" : "err";
    const artifacts = Array.isArray(res.artifacts) ? res.artifacts : [];
    const totalSize = artifacts.reduce((sum, artifact) => sum + (artifact.size || 0), 0) || res.pdfSize || 0;
    const outputLabel = res.outputName || res.pdfName || f.name.replace(/\.(tex|ly)$/, `.${res.outputFormat || "pdf"}`);
    const artifactSummary = artifacts.length > 1 ? t("editor.artifacts", { count: artifacts.length }) : "";
    const sizeSummary = totalSize ? ` · ${(totalSize / 1024).toFixed(0)} KB` : "";
    const summary = res.success
      ? `\n✓ ${t("editor.compileSuccessSummary", { seconds: ms, output: outputLabel, artifacts: artifactSummary, size: sizeSummary })}`
      : `\n! ${t("editor.compileFailureSummary", { seconds: ms, timeout: res.timedOut ? t("editor.timeout") : "" })}`;
    const raw = `${res.log || ""}${summary}`;
    $("logView").innerHTML = raw.split(/\r?\n/).map((line) => {
      const rowClass = /^!|error|fatal|failed|fallita/i.test(line) ? "err"
        : /warning|overfull|underfull/i.test(line) ? "warn"
        : line.startsWith("$") || line.startsWith("✓") ? cls
        : "";
      return `<div class="log-l ${rowClass}">${esc(line || " ")}</div>`;
    }).join("");
  }
  function updateCompileStatus(res, ms, compiledAt = state.lastCompile?.compiledAt || new Date()) {
    const errN = (res.errors || []).length || (res.success ? 0 : 1);
    const warnN = (res.warnings || []).length;
    const artifacts = Array.isArray(res.artifacts) ? res.artifacts : [];
    const totalSize = artifacts.reduce((sum, artifact) => sum + (artifact.size || 0), 0) || res.pdfSize || 0;
    const format = String(res.outputFormat || (res.pdfSize ? "pdf" : "")).toUpperCase();
    const time = window.IrisI18n.formatDate(compiledAt, { hour: "2-digit", minute: "2-digit" });
    $("stTime").textContent = t("status.compiled", { time, seconds: ms });
    $("stMath").textContent = totalSize ? `${format || t("toolbar.output")} ${(totalSize / 1024).toFixed(0)} KB${artifacts.length > 1 ? t("status.artifacts", { count: artifacts.length }) : ""}` : "";
    const we = $("stWarn"), ee = $("stErr");
    if (warnN) { we.style.display = ""; we.innerHTML = `${ti("alert-triangle")}<span>${esc(t("status.warnings", { count: warnN }))}</span>`; } else we.style.display = "none";
    if (!res.success || errN) {
      ee.style.display = ""; ee.innerHTML = `${ti("circle-x")}<span>${esc(t("status.errors", { count: errN }))}</span>`;
      $("stState").textContent = t("status.errors"); $("stDot").className = "doterr";
      $("stState").parentElement.classList.remove("accent"); $("stState").parentElement.classList.add("err");
    } else {
      ee.style.display = "none";
      $("stState").textContent = t("status.ready"); $("stDot").className = "dotok";
      $("stState").parentElement.classList.add("accent"); $("stState").parentElement.classList.remove("err");
    }
  }
  function artifactBytes(base64) {
    const bin = atob(base64 || "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function clearCompiledArtifacts() {
    const urls = new Set(state.compiledArtifacts.map((artifact) => artifact.blobUrl).filter(Boolean));
    if (state.pdfBlobUrl) urls.add(state.pdfBlobUrl);
    urls.forEach((url) => URL.revokeObjectURL(url));
    state.compiledArtifacts = [];
    state.pdfBlobUrl = null;
    state.pdfName = "";
    $("dlBtn").classList.remove("output-ready");
    $("dlBtn").innerHTML = `${ti("download", "ic")}<span class="dl-label workflow-label">${esc(t("toolbar.output"))}</span>`;
  }
  function prepareCompiledArtifacts(res) {
    clearCompiledArtifacts();
    state.compiledArtifacts = (res.artifacts || []).map((artifact) => {
      const { base64, bytes: suppliedBytes, ...metadata } = artifact;
      const bytes = suppliedBytes instanceof Uint8Array
        ? suppliedBytes
        : (suppliedBytes instanceof ArrayBuffer ? new Uint8Array(suppliedBytes) : artifactBytes(base64));
      const blob = new Blob([bytes], { type: metadata.mimeType || "application/octet-stream" });
      return {
        ...metadata,
        bytes,
        fileName: String(artifact.name || "output").split("/").pop(),
        blobUrl: URL.createObjectURL(blob),
      };
    });
    const format = String(res.outputFormat || "output").toUpperCase();
    $("dlBtn").classList.add("output-ready");
    $("dlBtn").innerHTML = `${ti("download", "ic")}<span class="dl-label workflow-label">${state.compiledArtifacts.length > 1 ? `${state.compiledArtifacts.length} ` : ""}${format}</span>`;
    return state.compiledArtifacts;
  }
  async function renderCompiledOutput(res) {
    const format = String(res.outputFormat || "pdf").toLowerCase();
    if (format === "pdf") return renderPdf(res);
    const loadGeneration = ++state.pdfLoadGeneration;
    await releasePdfDocument();
    if (loadGeneration !== state.pdfLoadGeneration) return;
    const artifacts = prepareCompiledArtifacts(res);
    state.previewKind = (format === "png" || format === "svg") ? "image" : "static";
    state.pages = [];
    state.curPage = 1;
    $("pvPages").innerHTML = "";
    if (format === "png" || format === "svg") {
      const imageLoads = [];
      artifacts.forEach((artifact) => {
        const page = document.createElement("div");
        page.className = "image-preview";
        const img = document.createElement("img");
        imageLoads.push(new Promise((resolve) => {
          img.addEventListener("load", () => {
            img.dataset.naturalWidth = String(img.naturalWidth || 0);
            resolve();
          }, { once: true });
          img.addEventListener("error", resolve, { once: true });
        }));
        img.src = artifact.blobUrl;
        img.alt = artifact.fileName;
        page.appendChild(img);
        $("pvPages").appendChild(page);
        state.pages.push(page);
      });
      await Promise.all(imageLoads);
      if (loadGeneration !== state.pdfLoadGeneration) return;
      layoutImagePages();
      $("pvEmpty").style.display = "none";
      $("pgTot").textContent = state.pages.length || "–";
      $("pgCur").textContent = state.pages.length ? "1" : "–";
    } else {
      $("pvEmpty").innerHTML = `<div class="big success">${ti("circle-check")}</div><span>${esc(t("preview.generated", { count: artifacts.length, format: format.toUpperCase() }))}</span>`;
      $("pvEmpty").style.display = "";
      $("pgTot").textContent = "–";
      $("pgCur").textContent = "–";
      updateZoomLabel();
    }
    setView("preview");
  }
  async function renderPdf(res) {
    const loadGeneration = ++state.pdfLoadGeneration;
    await releasePdfDocument();
    if (loadGeneration !== state.pdfLoadGeneration) return;
    const artifacts = Array.isArray(res.artifacts) && res.artifacts.length
      ? prepareCompiledArtifacts(res)
      : prepareCompiledArtifacts({ outputFormat: "pdf", artifacts: [{ name: res.pdfName || "output.pdf", base64: res.pdfBase64, size: res.pdfSize, mimeType: "application/pdf" }] });
    const primary = artifacts[0];
    state.previewKind = "pdf";
    const bytes = primary.bytes;
    state.pdfBlobUrl = primary.blobUrl;
    state.pdfName = primary.fileName;
    const pdfjs = await pdfjsReady;
    const loadingTask = pdfjs.getDocument({ data: bytes });
    state.pdfLoadingTask = loadingTask;
    let doc;
    try {
      doc = await loadingTask.promise;
    } catch (error) {
      if (loadGeneration !== state.pdfLoadGeneration || loadingTask !== state.pdfLoadingTask) return;
      throw error;
    }
    if (loadGeneration !== state.pdfLoadGeneration || loadingTask !== state.pdfLoadingTask) {
      if (loadingTask === state.pdfLoadingTask) state.pdfLoadingTask = null;
      await loadingTask.destroy();
      return;
    }
    state.pdfDocument = doc;
    state.curPage = 1;
    await layoutPdfPages();
  }

  /* ---------------- view toggle ---------------- */
  function setView(v) {
    state.view = v;
    $("pvSeg").querySelectorAll("button").forEach((b) => {
      const selected = b.dataset.view === v;
      b.classList.toggle("on", selected);
      b.setAttribute("aria-pressed", selected ? "true" : "false");
    });
    $("logView").classList.toggle("on", v === "log");
    $("pvStage").classList.toggle("hide-pages", v === "log");
  }

  function setWorkspaceView(view) {
    const preview = view === "preview";
    document.querySelector(".body").classList.toggle("workspace-preview", preview);
    $("workspaceSwitch").querySelectorAll("button").forEach((button) => {
      const selected = button.dataset.workspace === (preview ? "preview" : "editor");
      button.classList.toggle("on", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
      button.tabIndex = selected ? 0 : -1;
    });
    if (preview && state.fit) requestPreviewLayout();
  }

  function activateSettingsSection(section, focusTab = false) {
    const tabs = Array.from(document.querySelectorAll(".set-nav [role=tab]"));
    tabs.forEach((tab) => {
      const selected = tab.dataset.set === section;
      tab.classList.toggle("on", selected);
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focusTab) tab.focus();
    });
    document.querySelectorAll(".set-pane").forEach((panel) => {
      panel.hidden = panel.dataset.setpane !== section;
    });
    document.querySelectorAll(".set-accordion-trigger").forEach((trigger) => {
      const expanded = trigger.dataset.set === section;
      trigger.classList.toggle("on", expanded);
      trigger.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }

  function openSettings() {
    renderFontList();
    updateTexPathControl();
    renderCompileProfile();
    const selected = document.querySelector(".set-nav [role=tab].on")?.dataset.set || "fonts";
    activateSettingsSection(selected);
    openDialog("settingsModal");
    requestAnimationFrame(() => {
      const compact = window.matchMedia("(max-width: 700px)").matches;
      const target = compact
        ? document.querySelector(`.set-accordion-trigger[data-set="${selected}"]`)
        : document.querySelector(`.set-nav [data-set="${selected}"]`);
      target?.focus();
    });
  }

  /* ---------------- toast ---------------- */
  function toast(msg, type) {
    const t = document.createElement("div");
    t.className = "toast" + (type === "err" ? " err" : "");
    t.innerHTML = `<span class="ic">${ti(type === "err" ? "circle-x" : "circle-check")}</span><span>${esc(msg)}</span>`;
    $("toasts").appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 2200);
  }

  /* ---------------- attach ---------------- */
  function folderOptions(selectedPath = state.selectedFolder) {
    const opts = [`<option value="">/ (${esc(t("common.root"))})</option>`];
    const add = (nodes, parentPath) => {
      (nodes || []).forEach((n) => {
        if (n.type !== "folder") return;
        if (n.generated || n.readOnly) return;
        const rel = folderSlash(joinPath(parentPath, n.name));
        opts.push(`<option value="${esc(rel)}"${selectedPath === rel ? " selected" : ""}>${esc(rel)}</option>`);
        add(n.children, rel);
      });
    };
    add(project.nodes, "");
    return opts.join("");
  }
  function folderChildrenByPath(folderPath) {
    const folder = folderNodeByPath(folderPath);
    return folder ? folder.nodes : project.nodes;
  }
  function openAttach() {
    $("attachDest").innerHTML = folderOptions();
    if (state.selectedFolder) $("attachDest").value = state.selectedFolder;
    clearAttach();
    openDialog("attachModal");
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
    if (/\.ly$/i.test(name)) return "ly";
    if (/\.(tex|txt)$/i.test(name)) return "tex";
    return "file";
  }
  function uploadNameWithExtension(name, originalName) {
    const cleaned = (name || originalName || "").trim();
    const ext = (originalName || "").match(/(\.[A-Za-z0-9]{1,12})$/);
    if (!cleaned || !ext || /\.[A-Za-z0-9]{1,12}$/.test(cleaned)) return cleaned;
    return cleaned + ext[1];
  }
  function doUpload() {
    const af = state.attachFile;
    if (!af) return;
    const dest = $("attachDest").value;
    const name = uploadNameWithExtension($("attachRename").value, af.name);
    const path = dest + name;
    state.assets[path] = af.data;
    // add to tree
    let folder = folderChildrenByPath(dest);
    const kind = attachKind(name, af.isImg);
    folder.push({ type: "file", id: "file_" + Date.now(), name, kind, path, data: af.data });
    renderTree();
    void persistWhenDocumentClean();
    void closeDialog("attachModal");
    toast(t("attach.uploaded", { name, destination: dest || "/" }));
  }

  /* ---------------- fonts ---------------- */
  function syncFontInTree(font) {
    let folder = project.nodes.find((node) => node.name === "fonts");
    if (folder && folder.type !== "folder") throw new Error("fonts is not a folder");
    if (!folder) {
      folder = { type: "folder", name: "fonts", open: true, children: [] };
      project.nodes.push(folder);
    }
    folder.open = true;
    folder.children = Array.isArray(folder.children) ? folder.children : [];
    const name = String(font.path || font.name).split("/").pop();
    let node = folder.children.find((item) => item.type === "file" && (item.path === font.path || item.name === name));
    if (!node) {
      node = { type: "file", id: `font_${Date.now()}_${folder.children.length}`, name, kind: "file", path: font.path };
      folder.children.push(node);
    }
    Object.assign(node, {
      name,
      path: font.path,
      kind: "file",
      binary: true,
      encoding: "base64",
      data: font.data,
    });
    renderTree();
  }

  function pickFont(file) {
    if (!file) return;
    const fam = "IrisUser_" + file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_");
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = reader.result;
        const ff = new FontFace(fam, `url(${dataUrl})`);
        await ff.load();
        document.fonts.add(ff);
        const prev = state.fonts.findIndex((x) => x.name.toLowerCase() === file.name.toLowerCase());
        const path = prev >= 0 ? state.fonts[prev].path : uniqueFontPath(file.name);
        const font = { family: fam, name: file.name, path, data: dataUrl };
        if (prev >= 0) state.fonts.splice(prev, 1, font);
        else state.fonts.push(font);
        syncFontInTree(font);
        setPreviewFont(fam);
        if (!await persist()) throw new Error("Font persistence failed");
        toast(t("settings.uploadedFont", { name: file.name }));
      } catch (e) { toast(t("settings.fontUploadFailed"), "err"); }
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
      console.warn("Font could not be loaded", font.name, e);
      return false;
    }
  }
  function renderFontList() {
    const box = $("fontList");
    if (!state.fonts.length) { box.innerHTML = `<div class="hint" style="margin:0">${esc(t("settings.noCustomFonts"))}</div>`; return; }
    box.innerHTML = "";
    state.fonts.forEach((fo) => {
      const el = document.createElement("div");
      el.className = "fontcard";
      const active = state.previewFont === fo.family;
      el.innerHTML = `<div class="glyph" style="font-family:'${fo.family}'">Ag</div>
        <div><div class="nm" style="font-family:'${fo.family}'">${esc(fo.name)}</div><div class="fm">${esc(fo.path || fo.family)}</div></div>
        <div class="use"><button class="pill${active ? " active" : ""}">${active ? ti("check") : ""}<span>${esc(t("settings.fontPreviewAction"))}</span></button></div>`;
      el.querySelector(".pill").addEventListener("click", () => setPreviewFont(active ? null : fo.family));
      box.appendChild(el);
    });
  }
  function setPreviewFont(fam) {
    state.previewFont = fam;
    if (fam) document.documentElement.style.setProperty("--proj-font", `'${fam}', var(--font-document)`);
    else document.documentElement.style.removeProperty("--proj-font");
    $("fontPreviewBlock").hidden = !fam;
    renderFontList();
  }

  /* ---------------- download compiled output ---------------- */
  function downloadPdf() {
    if (!state.compiledArtifacts.length) {
      toast(t("editor.downloadFirst"), "err");
      return;
    }
    state.compiledArtifacts.forEach((artifact, index) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = artifact.blobUrl;
        a.download = artifact.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, index * 120);
    });
  }

  async function clearBuildOutput(buildId = null) {
    if (buildId && state.previewBuildId !== buildId) return false;
    const outputGeneration = ++state.outputGeneration;
    const loadGeneration = ++state.pdfLoadGeneration;
    await releasePdfDocument();
    if (outputGeneration !== state.outputGeneration || loadGeneration !== state.pdfLoadGeneration) return false;
    if (buildId && state.previewBuildId !== buildId) return false;
    clearCompiledArtifacts();
    state.previewBuildId = null;
    state.lastCompile = null;
    state.previewKind = "empty";
    state.pages = [];
    state.curPage = 1;
    $("pvPages").innerHTML = "";
    $("logView").innerHTML = "";
    $("pvEmpty").innerHTML = `<div class="big">${ti("file")}</div><span>${esc(t("preview.empty"))}</span>`;
    $("pvEmpty").style.display = "";
    $("pgTot").textContent = "–";
    $("pgCur").textContent = "–";
    $("stTime").textContent = t("status.neverCompiled");
    $("stMath").textContent = "";
    $("stWarn").style.display = "none";
    $("stErr").style.display = "none";
    $("stState").textContent = t("status.ready");
    $("stDot").className = "dotok";
    $("stState").parentElement.classList.add("accent");
    $("stState").parentElement.classList.remove("err");
    setView("preview");
    updateZoomLabel();
    return true;
  }

  async function showBuildOutput(payload, options = {}) {
    const build = payload && payload.build;
    if (!build) return false;
    const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    const succeeded = build.status === "succeeded" && artifacts.length > 0;
    const sourceName = String(build.mainPath || t("toolbar.output")).split("/").pop();
    const source = { name: sourceName, path: build.mainPath || sourceName };
    const seconds = ((Number(build.durationMs) || 0) / 1000).toFixed(1);
    const compiledAt = new Date(build.completedAt || build.createdAt || Date.now());
    const res = {
      success: succeeded,
      buildId: build.id,
      outputFormat: build.format,
      outputName: artifacts[0] ? artifacts[0].name : build.displayName,
      artifacts,
      durationMs: build.durationMs,
      exitCode: build.exitCode,
      signal: build.signal,
      timedOut: build.timedOut,
      log: build.log || "",
      warnings: build.warnings || [],
      errors: build.errors || [],
    };
    const outputGeneration = ++state.outputGeneration;
    state.previewBuildId = build.id;
    // Whatever brought this build on screen — our own compilation, the notice's
    // refresh, or the history dialog — the preview is no longer behind.
    clearNewerBuild();
    state.lastCompile = { f: source, res, ms: seconds, compiledAt };
    buildLog(source, res, seconds, false);
    updateCompileStatus(res, seconds, compiledAt);
    if (succeeded) {
      await renderCompiledOutput(res);
    } else {
      const loadGeneration = ++state.pdfLoadGeneration;
      await releasePdfDocument();
      if (outputGeneration !== state.outputGeneration || loadGeneration !== state.pdfLoadGeneration) return false;
      clearCompiledArtifacts();
      state.previewKind = "empty";
      state.pages = [];
      $("pvPages").innerHTML = "";
      $("pvEmpty").innerHTML = `<div class="big">${ti("terminal-2")}</div><span>${esc(t("builds.noArtifacts"))}</span>`;
      $("pvEmpty").style.display = "";
      $("pgTot").textContent = "–";
      $("pgCur").textContent = "–";
      setView("log");
      updateZoomLabel();
    }
    if (outputGeneration !== state.outputGeneration) return false;
    if (options.activateWorkspace !== false) setWorkspaceView("preview");
    return true;
  }

  /* ---------------- new / open / save ---------------- */
  const newDocumentTemplate = () => `\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\n\\title{${t("templates.newDocument")}}\n\\author{}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\n\\section{}\n\n\\end{document}`;
  const NEWLY = `\\version "2.24.0"\n\n\\score {\n  \\relative c' {\n    \\key c \\major\n    \\time 4/4\n    c4 d e f | g1 \\bar "|."\n  }\n  \\layout { }\n}`;
  function newFile() {
    openNewItem("file");
  }
  async function saveProject() {
    if (isReadOnly()) { toast(t("projects.readOnlyNotice")); return false; }
    clearTimeout(persistT);
    const saved = await persist();
    toast(t(saved ? "editor.documentSaved" : "editor.saveFailed"), saved ? "" : "err");
    return saved;
  }
  function openExternal(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const id = "open_" + Date.now();
      const kind = inferKind(file.name, isLilyPondProject() ? "ly" : "tex");
      project.nodes.push({ type: "file", id, name: file.name, kind, path: file.name, content: reader.result });
      renderTree(); openFile(id); markFileDirty(id); schedulePersist(); toast(t("editor.opened", { name: file.name }));
    };
    reader.readAsText(file);
  }
  function openExternalPicker() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".tex,.ly,.ily,.bib,.txt";
    input.onchange = () => input.files[0] && openExternal(input.files[0]);
    input.click();
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    // topbar
    $("btnCompile").addEventListener("click", compile);
    $("btnWrap").addEventListener("click", () => setWordWrap(!state.wordWrap, true));
    $("btnFormat").addEventListener("click", () => {
      const f = findFile(state.activeId);
      if (!f || (f.kind !== "tex" && f.kind !== "ly")) return;
      if (isReadOnly()) { toast(t("projects.readOnlyNotice")); return; }
      // Applied as a granular change by the adapter, so the caret survives and
      // the formatter stops counting as a whole-document edit.
      ed().applyText((f.kind === "ly" ? IrisLilyPond : IrisLatex).format(ed().getValue()));
      toast(t("editor.formatted"));
    });
    $("btnSave").addEventListener("click", saveProject);
    $("btnNew").addEventListener("click", newFile);
    $("newFileBtn").addEventListener("click", newFile);
    $("refreshTreeBtn").addEventListener("click", () => { void refreshFileTree(); });
    $("btnOpen").addEventListener("click", openExternalPicker);
    $("btnAttach").addEventListener("click", openAttach);
    $("dlBtn").addEventListener("click", downloadPdf);
    $("btnSettings").addEventListener("click", openSettings);

    // If the backend refuses a write mid-session (role downgraded to viewer),
    // the projects layer emits this; drop the workspace to read-only in place.
    document.addEventListener("iris:writeforbidden", () => {
      if (isReadOnly()) return;
      state.role = "viewer";
      applyRoleGate();
      toast(t("projects.writeForbidden"), "err");
    });

    // latex binaries path (in Impostazioni → Compilazione)
    $("texPath").addEventListener("input", function () {
      if (currentCompilerPathLocked()) return;
      if (isLilyPondProject()) state.lilypondPath = this.value.trim();
      else state.texPath = this.value.trim();
      updateCompileCommandPreview();
      saveLayout();
    });
    $("lilypondArgs").addEventListener("input", function () {
      state.lilypondArgs = this.value;
      updateCompileCommandPreview();
      schedulePersist();
    });
    $("lilypondFormat").addEventListener("change", function () {
      state.lilypondFormat = this.value;
      updateCompileCommandPreview();
      void persistWhenDocumentClean();
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
      ed().setAutoIndent(state.autoIndent);
      this.classList.toggle("on", state.autoIndent);
      this.setAttribute("aria-checked", state.autoIndent ? "true" : "false");
      saveLayout();
    });
    $("autoSave").addEventListener("click", function () {
      state.autoSave = !state.autoSave;
      updateAutoSaveControls();
      if (state.autoSave) schedulePersist();
      else clearTimeout(persistT);
      void persistWhenDocumentClean();
    });
    $("autoSaveDelay").addEventListener("input", function () {
      const seconds = Number.parseInt(this.value, 10);
      if (!Number.isFinite(seconds)) return;
      state.autoSaveDelay = normalizeAutoSaveDelay(seconds);
      if (state.autoSave) schedulePersist();
    });
    $("autoSaveDelay").addEventListener("change", function () {
      state.autoSaveDelay = normalizeAutoSaveDelay(this.value);
      updateAutoSaveControls();
      if (state.autoSave) schedulePersist();
      void persistWhenDocumentClean();
    });
    $("settingsLanguage").addEventListener("change", async function () {
      const next = Object.prototype.hasOwnProperty.call(window.IrisI18n.SUPPORTED, this.value)
        ? this.value
        : window.IrisI18n.defaultLanguage;
      const previous = state.projectLanguage;
      this.disabled = true;
      try {
        state.projectLanguage = next;
        await window.IrisI18n.setLanguage(next);
        void persistWhenDocumentClean();
      } catch (error) {
        state.projectLanguage = previous;
        await window.IrisI18n.setLanguage(previous).catch(() => {});
        console.error("Project language change failed", error);
      } finally {
        this.disabled = false;
      }
    });

    // settings tabs + compact accordion
    const settingsTabs = Array.from(document.querySelectorAll(".set-nav [role=tab]"));
    settingsTabs.forEach((tab) => {
      tab.addEventListener("click", () => activateSettingsSection(tab.dataset.set));
      tab.addEventListener("keydown", (event) => {
        const current = settingsTabs.indexOf(tab);
        let next = current;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (current + 1) % settingsTabs.length;
        else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (current - 1 + settingsTabs.length) % settingsTabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = settingsTabs.length - 1;
        else return;
        event.preventDefault();
        activateSettingsSection(settingsTabs[next].dataset.set, true);
      });
    });
    document.querySelectorAll(".set-accordion-trigger").forEach((trigger) => {
      trigger.addEventListener("click", () => activateSettingsSection(trigger.dataset.set));
    });

    // engine menu
    const em = $("engineMenu");
    $("engineBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const r = $("engineBtn").getBoundingClientRect();
      em.classList.toggle("on");
      $("engineBtn").setAttribute("aria-expanded", em.classList.contains("on") ? "true" : "false");
      if (em.classList.contains("on")) {
        // statusbar sits at the bottom: open the menu upward
        em.style.left = r.left + "px";
        em.style.top = (r.top - em.offsetHeight - 6) + "px";
      }
      em.querySelectorAll(".mi").forEach((m) => m.classList.toggle("on", m.dataset.engine === state.engine));
    });
    em.querySelectorAll(".mi").forEach((m) => m.addEventListener("click", () => {
      state.engine = m.dataset.engine; $("engineName").textContent = state.engine; em.classList.remove("on"); $("engineBtn").setAttribute("aria-expanded", "false"); updateCompileCommandPreview(); void persistWhenDocumentClean();
    }));
    document.addEventListener("click", () => { em.classList.remove("on"); $("engineBtn").setAttribute("aria-expanded", "false"); });

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
    $("workspaceSwitch").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => setWorkspaceView(button.dataset.workspace)));
    $("zIn").addEventListener("click", () => adjustPreviewZoom(0.1));
    $("zOut").addEventListener("click", () => adjustPreviewZoom(-0.1));
    $("fitBtn").addEventListener("click", togglePreviewFit);
    $("pgPrev").addEventListener("click", () => gotoPage(state.curPage - 1));
    $("pgNext").addEventListener("click", () => gotoPage(state.curPage + 1));
    $("pvStage").addEventListener("scroll", onStageScroll);
    $("pvNewerLoad").addEventListener("click", () => { void loadNewerBuild(); });
    $("pvNewerDismiss").addEventListener("click", clearNewerBuild);
    $("stErr").addEventListener("click", () => { setWorkspaceView("preview"); setView("log"); });
    $("stWarn").addEventListener("click", () => { setWorkspaceView("preview"); setView("log"); });

    // modal close
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => {
      const closingSettings = $("settingsModal").classList.contains("on") && !!b.closest("#settingsModal");
      const scrim = b.closest(".scrim");
      if (scrim) void closeDialog(scrim);
      if (closingSettings) $("btnSettings").focus();
    }));
    document.querySelectorAll(".scrim").forEach((s) => s.addEventListener("click", (e) => {
      if (e.target !== s) return;
      const closingSettings = s.id === "settingsModal" && s.classList.contains("on");
      void closeDialog(s);
      if (closingSettings) $("btnSettings").focus();
    }));
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // Dialog Escape handling belongs to IrisMotion, which closes only the top
      // dialog and restores its opener. This handler owns the responsive drawer.
      if (document.querySelector(".scrim.on")) return;
      if (document.querySelector(".body").classList.contains("drawer-open")) {
        closeResponsiveSidebar();
        $("btnSidebar").focus();
      }
    });

    // file tree modals
    document.querySelectorAll("[data-new-type]").forEach((b) => b.addEventListener("click", () => setNewItemMode(b.dataset.newType)));
    $("treeNewOk").addEventListener("click", confirmNewItem);
    $("newItemDest").addEventListener("change", () => setNewItemMode(newItemMode));
    $("newItemInput").addEventListener("input", () => {
      $("newItemInput").classList.remove("nomatch");
      updateNewItemHint();
    });
    $("newItemInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); confirmNewItem(); }
      else if (e.key === "Escape") { e.preventDefault(); closeNewItem(); }
    });
    $("treeRenameOk").addEventListener("click", confirmTreeRename);
    $("treeRenameInput").addEventListener("input", () => {
      $("treeRenameInput").classList.remove("nomatch");
      $("treeRenameHint").textContent = t("tree.nameHint");
    });
    $("treeRenameInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); confirmTreeRename(); }
      else if (e.key === "Escape") { e.preventDefault(); closeTreeRename(); }
    });
    $("treeDeleteOk").addEventListener("click", confirmTreeDelete);
    document.querySelectorAll("[data-tree-close]").forEach((b) => b.addEventListener("click", () => {
      closeNewItem();
      closeTreeRename();
      closeTreeDelete();
    }));
    ["treeNewModal", "treeRenameModal", "treeDeleteModal"].forEach((id) => {
      const modal = $(id);
      modal.addEventListener("click", (e) => {
        if (e.target !== modal) return;
        if (id === "treeNewModal") closeNewItem();
        else if (id === "treeRenameModal") closeTreeRename();
        else closeTreeDelete();
      });
    });

    // file history (versions). Close/click-outside/Escape are handled by the
    // generic scrim wiring above; only the in-dialog controls need binding.
    $("btnSnapshot").addEventListener("click", () => { void snapshotProject($("btnSnapshot")); });
    $("versionsSnapshot").addEventListener("click", () => { void snapshotProject($("versionsSnapshot")); });
    $("versionsViewSwitch").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-ver-view]");
      if (btn) setVersionView(btn.dataset.verView);
    });
    $("versionsViewSwitch").addEventListener("keydown", (e) => {
      const btn = e.target.closest("[data-ver-view]");
      if (!btn || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const tabs = [...$("versionsViewSwitch").querySelectorAll("[data-ver-view]")];
      let index = tabs.indexOf(btn);
      if (e.key === "Home") index = 0;
      else if (e.key === "End") index = tabs.length - 1;
      else index = (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      e.preventDefault();
      setVersionView(tabs[index].dataset.verView);
      tabs[index].focus();
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

    let previewResizeTimer;
    window.addEventListener("resize", () => {
      if (state.previewKind !== "pdf" && state.previewKind !== "image") return;
      if (!state.fit) return;
      clearTimeout(previewResizeTimer);
      previewResizeTimer = setTimeout(requestPreviewLayout, 120);
    });

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
    $("sideBackdrop").addEventListener("click", closeResponsiveSidebar);
    drawerMedia.addEventListener("change", syncResponsiveLayout);

    // ---- global shortcuts ----
    document.addEventListener("keydown", (e) => {
      if (!document.documentElement.classList.contains("iris-inproject")) return;
      if (document.querySelector(".scrim.on")) return;
      if (document.querySelector(".menu.on")) return;
      if (e.target && e.target.closest("input,textarea,select,[contenteditable='true']") && !ed().ownsTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (!mod || e.altKey || e.repeat) return;
      if (key === "s") { e.preventDefault(); void saveProject(); }
      else if (key === "n") { e.preventDefault(); newFile(); }
      else if (key === "o") { e.preventDefault(); openExternalPicker(); }
      else if (e.key === "Enter") { e.preventDefault(); void compile(); }
      else if (key === "f") { e.preventDefault(); findOpen(false); }
      else if (key === "h") { e.preventDefault(); findOpen(true); }
    });
    window.addEventListener("beforeunload", (event) => {
      if (!state.dirtyFiles.size) return;
      event.preventDefault();
      event.returnValue = "";
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
    state.pdfLoadGeneration += 1;
    void releasePdfDocument();
    state.previewKind = "image";
    $("pvEmpty").style.display = "none";
    const page = document.createElement("div");
    page.className = "image-preview";
    const img = document.createElement("img");
    img.alt = f.name || "";
    img.addEventListener("load", () => {
      img.dataset.naturalWidth = String(img.naturalWidth || 0);
      layoutImagePages();
    }, { once: true });
    img.src = f.data;
    page.appendChild(img);
    $("pvPages").replaceChildren(page);
    state.pages = Array.from($("pvPages").children); state.curPage = 1;
    $("pgTot").textContent = "1"; $("pgCur").textContent = "1";
  }

  /* ---------------- layout: resize + collapse ---------------- */
  const LS_LAYOUT = "iris_layout";
  const drawerMedia = window.matchMedia("(max-width: 1180px)");
  function loadLayout() {
    let L = {};
    try { L = JSON.parse(localStorage.getItem(LS_LAYOUT) || "{}") || {}; } catch (e) {}
    const body = document.querySelector(".body");
    if (L.sideW) body.style.setProperty("--side-w", L.sideW + "px");
    if (L.pvW) body.style.setProperty("--pv-w", Math.max(440, L.pvW) + "px");
    if (L.sideCollapsed) body.classList.add("side-collapsed");
    syncResponsiveLayout();
    if (typeof L.autoIndent === "boolean") state.autoIndent = L.autoIndent;
    ed().setAutoIndent(state.autoIndent);
    $("autoIndent").classList.toggle("on", state.autoIndent);
    $("autoIndent").setAttribute("aria-checked", state.autoIndent ? "true" : "false");
    setWordWrap(typeof L.wordWrap === "boolean" ? L.wordWrap : false);
    if (typeof L.texPath === "string") state.texPath = L.texPath;
    if (typeof L.lilypondPath === "string") state.lilypondPath = L.lilypondPath;
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
      wordWrap: state.wordWrap,
      texPath: state.texPathLocked ? "" : state.texPath,
      lilypondPath: state.lilypondPathLocked ? "" : state.lilypondPath,
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
      if (state.fit) { requestPreviewLayout(); updateZoomLabel(); }
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
    if (drawerMedia.matches) body.classList.toggle("drawer-open");
    else {
      body.classList.toggle("side-collapsed");
      saveLayout();
    }
    updateSidebarToggle();
    setTimeout(() => { if (state.fit) { requestPreviewLayout(); updateZoomLabel(); } }, 200);
  }
  function closeResponsiveSidebar() {
    if (!drawerMedia.matches) return;
    document.querySelector(".body").classList.remove("drawer-open");
    updateSidebarToggle();
  }
  function updateSidebarToggle() {
    const body = document.querySelector(".body");
    const open = drawerMedia.matches ? body.classList.contains("drawer-open") : !body.classList.contains("side-collapsed");
    const button = $("btnSidebar");
    const iconHost = button.querySelector("[data-icon]");
    const iconName = open ? "layout-sidebar-left-collapse" : "layout-sidebar-left-expand";
    if (iconHost.dataset.icon !== iconName) {
      iconHost.dataset.icon = iconName;
      iconHost.innerHTML = ti(iconName);
    }
    button.classList.toggle("on", open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }
  function syncResponsiveLayout() {
    const body = document.querySelector(".body");
    if (!drawerMedia.matches) body.classList.remove("drawer-open");
    updateSidebarToggle();
    if (state.fit) requestPreviewLayout();
  }

  /* ---------------- find / replace ---------------- */
  const fState = { matches: [], idx: 0, caseSensitive: false };
  function findOpen(focusReplace) {
    $("findBar").classList.add("on");
    const sel = ed().selection().text;
    if (sel && !sel.includes("\n")) $("findInput").value = sel;
    fState.idx = 0;
    findCompute();
    if (fState.matches.length) findSelect();
    const inp = focusReplace ? $("replaceInput") : $("findInput");
    inp.focus(); inp.select();
  }
  function findClose() {
    $("findBar").classList.remove("on");
    ed().highlightMatches([], -1);
    ed().focus();
  }
  // Paints every occurrence in the editor, with the current one emphasised;
  // stays visible while the focus is in the find bar.
  function findHighlight() {
    const q = $("findInput").value;
    ed().highlightMatches(fState.matches.map((m) => ({ from: m, to: m + q.length })), fState.idx);
  }
  function findCompute() {
    const q = $("findInput").value;
    fState.matches = [];
    if (q) {
      const value = ed().getValue();
      const hay = fState.caseSensitive ? value : value.toLowerCase();
      const needle = fState.caseSensitive ? q : q.toLowerCase();
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) { fState.matches.push(i); i += q.length || 1; }
    }
    if (fState.idx >= fState.matches.length) fState.idx = 0;
    updateFindCount();
    findHighlight();
  }
  function updateFindCount() {
    const q = $("findInput").value, n = fState.matches.length;
    $("findCount").textContent = n ? `${fState.idx + 1}/${n}` : (q ? "0/0" : "");
    $("findInput").classList.toggle("nomatch", !!q && !n);
  }
  function findSelect() {
    const n = fState.matches.length; if (!n) return;
    const q = $("findInput").value, start = fState.matches[fState.idx];
    ed().select(start, start + q.length);
    updateFindCount();
    findHighlight();
  }
  function findStep(dir) {
    const n = fState.matches.length; if (!n) return;
    fState.idx = (fState.idx + dir + n) % n;
    findSelect();
  }
  function findReplaceOne() {
    if (isReadOnly()) return;
    const n = fState.matches.length; if (!n) return;
    const q = $("findInput").value, rep = $("replaceInput").value, start = fState.matches[fState.idx];
    ed().replaceRange(start, start + q.length, rep);
    findCompute();
    if (fState.matches.length) {
      let ni = fState.matches.findIndex((m) => m >= start + rep.length);
      fState.idx = ni < 0 ? 0 : ni;
      findSelect();
    } else updateFindCount();
  }
  function findReplaceAll() {
    if (isReadOnly()) return;
    const q = $("findInput").value; if (!q) return;
    const n = fState.matches.length; if (!n) return;
    const rep = $("replaceInput").value;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), fState.caseSensitive ? "g" : "gi");
    ed().applyText(ed().getValue().replace(re, () => rep));
    fState.idx = 0; findCompute();
    toast(t("find.replaced", { count: n }));
  }

  /* ---------------- IrisApp: bridge used by the projects layer ---------------- */
  /* ---------------- file history (versions) ---------------- */
  // A file's revision history is keyed on its canonical project_files UUID. Files
  // created this session keep a client-ref id until the server reconciles them on
  // save, so the entry point resolves the canonical id before opening.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isCanonicalFileId = (id) => typeof id === "string" && UUID_RE.test(id);
  const REASON_KEY = { initial: "reasonInitial", manual: "reasonManual", compile: "reasonCompile", rollback: "reasonRollback" };
  const verState = { fileId: null, node: null, versions: [], selectedId: null, view: "preview", detail: null, confirm: null, busy: false, listSeq: 0, detailSeq: 0 };

  function reasonLabel(reason) {
    return REASON_KEY[reason] ? t(`versions.${REASON_KEY[reason]}`) : String(reason || "");
  }
  function formatVersionTime(ts) {
    if (!ts) return "";
    return window.IrisI18n.formatDate(new Date(ts), { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function formatVersionBytes(size) {
    const bytes = Number(size) || 0;
    if (bytes < 1024) return t("versions.unit_bytes", { value: window.IrisI18n.formatNumber(bytes) });
    return t("versions.unit_kilobytes", { value: window.IrisI18n.formatNumber(Math.round(bytes / 102.4) / 10) });
  }
  // The current live content of the file whose history is open: the editor buffer
  // when it is the active file, otherwise the node's stored content.
  function currentVersionFileContent() {
    const node = verState.node;
    if (!node) return "";
    if (node.id === state.activeId) return ed().getValue();
    return node.content || "";
  }

  function setVersionsListState(html) {
    const el = $("versionsListState");
    el.innerHTML = html || "";
    el.style.display = html ? "" : "none";
  }

  async function openFileHistory(node) {
    if (!node) return;
    let fileId = node.id;
    if (!isCanonicalFileId(fileId)) {
      // Not yet reconciled: persist so the server assigns the canonical id, then
      // look it up by path from the refreshed project cache.
      await persist();
      const resolved = window.IrisProjects && window.IrisProjects.resolveFileId
        ? window.IrisProjects.resolveFileId(node.path)
        : null;
      if (isCanonicalFileId(resolved)) fileId = resolved;
    }
    if (!isCanonicalFileId(fileId)) { toast(t("versions.unsavedFile"), "err"); return; }
    verState.fileId = fileId;
    verState.node = node;
    verState.versions = [];
    verState.selectedId = null;
    verState.detail = null;
    verState.view = "preview";
    verState.confirm = null;
    $("versionsSubtitle").textContent = node.name || node.path || "";
    $("versionsSnapshot").style.display = isReadOnly() ? "none" : "";
    openDialog("versionsModal");
    await loadVersionsList({ selectFirst: true });
  }

  async function loadVersionsList({ selectFirst = false } = {}) {
    const seq = ++verState.listSeq;
    setVersionsListState(`<div class="ver-state-msg">${esc(t("versions.loading"))}</div>`);
    $("versionsList").innerHTML = "";
    try {
      const versions = await window.IrisProjects.listFileVersions(verState.fileId);
      if (seq !== verState.listSeq) return;
      verState.versions = versions;
      if (!versions.length) {
        renderVersionList();
        setVersionsListState(`<div class="ve-title">${esc(t("versions.empty"))}</div><div class="ve-sub">${esc(t("versions.emptyHint"))}</div>`);
        verState.selectedId = null;
        verState.detail = null;
        renderVersionDetail();
        return;
      }
      setVersionsListState("");
      const keep = versions.some((v) => v.id === verState.selectedId)
        ? verState.selectedId
        : (selectFirst ? versions[0].id : null);
      renderVersionList();
      if (keep) await selectVersion(keep);
      else renderVersionDetail();
    } catch (err) {
      if (seq !== verState.listSeq) return;
      verState.versions = [];
      renderVersionList();
      setVersionsListState(`<div class="ve-title error">${esc(window.IrisI18n.error(err, "versions.loadFailed"))}</div>`);
      verState.selectedId = null;
      verState.detail = null;
      renderVersionDetail();
    }
  }

  function renderVersionList() {
    const list = $("versionsList");
    list.innerHTML = "";
    verState.versions.forEach((v) => {
      const item = document.createElement("button");
      item.type = "button";
      const on = v.id === verState.selectedId;
      item.className = "ver-item" + (on ? " on" : "");
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", on ? "true" : "false");
      item.innerHTML =
        `<span class="ver-reason reason-${esc(v.reason)}">${esc(reasonLabel(v.reason))}</span>` +
        `<span class="ver-when">${esc(formatVersionTime(v.createdAt))}</span>` +
        `<span class="ver-who">${esc(t("versions.byAuthor", { author: v.author }))}</span>`;
      item.addEventListener("click", () => { if (v.id !== verState.selectedId) void selectVersion(v.id); });
      list.appendChild(item);
    });
  }

  async function selectVersion(versionId) {
    verState.selectedId = versionId;
    verState.confirm = null;
    renderVersionList();
    const seq = ++verState.detailSeq;
    verState.detail = null;
    renderVersionDetail({ loading: true });
    try {
      const detail = await window.IrisProjects.getFileVersion(verState.fileId, versionId);
      if (seq !== verState.detailSeq) return;
      verState.detail = detail;
      renderVersionDetail();
    } catch (err) {
      if (seq !== verState.detailSeq) return;
      verState.detail = null;
      renderVersionDetail({ error: window.IrisI18n.error(err, "versions.loadFailed") });
    }
  }

  function renderVersionDetail(opts = {}) {
    const meta = $("versionsMeta");
    const view = $("versionsView");
    const actions = $("versionsActions");
    const viewSwitch = $("versionsViewSwitch");
    const summary = verState.versions.find((v) => v.id === verState.selectedId);
    if (!summary) {
      meta.innerHTML = "";
      viewSwitch.hidden = true;
      const hint = verState.versions.length ? t("versions.select") : t("versions.emptyHint");
      view.innerHTML = `<div class="ver-placeholder">${esc(hint)}</div>`;
      actions.innerHTML = "";
      return;
    }
    meta.innerHTML =
      `<span class="ver-reason reason-${esc(summary.reason)}">${esc(reasonLabel(summary.reason))}</span>` +
      `<span class="ver-meta-line"><span class="ver-meta-when">${esc(formatVersionTime(summary.createdAt))}</span>` +
      `<span class="ver-meta-who">${esc(t("versions.byAuthor", { author: summary.author }))}</span>` +
      `<span class="ver-meta-size">${esc(formatVersionBytes(summary.size))}</span></span>`;
    viewSwitch.hidden = false;
    viewSwitch.querySelectorAll("[data-ver-view]").forEach((b) => {
      const active = b.dataset.verView === verState.view;
      b.classList.toggle("on", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
      if (active) view.setAttribute("aria-labelledby", b.id);
    });
    if (opts.loading) { view.innerHTML = `<div class="ver-placeholder">${esc(t("versions.loading"))}</div>`; actions.innerHTML = ""; return; }
    if (opts.error) { view.innerHTML = `<div class="ver-placeholder error">${esc(opts.error)}</div>`; actions.innerHTML = ""; return; }
    if (!verState.detail) { view.innerHTML = `<div class="ver-placeholder">${esc(t("versions.loading"))}</div>`; actions.innerHTML = ""; return; }
    renderVersionView();
    renderVersionActions();
  }

  function renderVersionView() {
    const view = $("versionsView");
    const content = String(verState.detail && verState.detail.content || "");
    if (verState.view === "diff") {
      const rows = lineDiff(content, currentVersionFileContent());
      if (!rows.some((r) => r.type !== "same")) {
        view.innerHTML = `<div class="ver-placeholder">${esc(t("versions.noChanges"))}</div>`;
        return;
      }
      const body = rows.map((r) => {
        const sign = r.type === "add" ? "+" : (r.type === "del" ? "-" : "");
        return `<div class="diff-line diff-${r.type}"><span class="diff-sign">${sign}</span><span class="diff-text">${esc(r.text) || "&#8203;"}</span></div>`;
      }).join("");
      view.innerHTML = `<div class="ver-diff-caption">${esc(t("versions.diffCaption"))}</div><div class="ver-diff">${body}</div>`;
    } else {
      view.innerHTML = `<pre class="ver-pre">${esc(content) || "&#8203;"}</pre>`;
    }
  }

  function renderVersionActions() {
    const actions = $("versionsActions");
    if (isReadOnly()) { actions.innerHTML = ""; return; }
    if (verState.confirm === "restore") {
      actions.innerHTML =
        `<span class="ver-confirm">${esc(t("versions.restoreConfirm"))} <span class="ver-confirm-hint">${esc(t("versions.restoreConfirmHint"))}</span></span>` +
        `<span class="ver-confirm-btns">` +
          `<button class="btn sm" type="button" data-ver-act="cancel">${esc(t("common.cancel"))}</button>` +
          `<button class="btn cta sm" type="button" data-ver-act="confirm-restore">${esc(t("versions.restoreConfirmYes"))}</button>` +
        `</span>`;
    } else {
      actions.innerHTML =
        `<button class="btn cta ver-restore" type="button" data-ver-act="restore" title="${esc(t("versions.restoreTitle"))}">${ti("arrow-back-up")}<span>${esc(t("versions.restore"))}</span></button>`;
    }
    actions.querySelectorAll("[data-ver-act]").forEach((b) => b.addEventListener("click", () => {
      const act = b.dataset.verAct;
      if (act === "restore") { verState.confirm = "restore"; renderVersionActions(); }
      else if (act === "cancel") { verState.confirm = null; renderVersionActions(); }
      else if (act === "confirm-restore") void confirmRestore();
    }));
  }

  async function confirmRestore() {
    if (verState.busy || !verState.selectedId || isReadOnly()) return;
    verState.busy = true;
    const confirmBtn = $("versionsActions").querySelector('[data-ver-act="confirm-restore"]');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.classList.add("loading"); }
    try {
      // Flush the editor to disk first so the backend's pre-rollback snapshot
      // captures the true current state before the file is overwritten.
      await persist();
      const out = await window.IrisProjects.restoreFileVersion(verState.fileId, verState.selectedId);
      const node = findFile(verState.node.id) || verState.node;
      if (node) {
        node.content = out.content;
        state.dirtyFiles.delete(node.id);
        // In a realtime session the server resets the room and pushes the
        // restored text to every participant, this tab included, so replacing the
        // document here would drop it out of the session.
        if (node.id === state.activeId && !isRealtimeFile(node.id)) {
          ed().load(out.content, node.kind);
          renderOutline();
        }
      }
      renderTabs();
      verState.confirm = null;
      verState.selectedId = null;
      toast(t("versions.restoreDone", { name: verState.node.name || verState.node.path }));
      await loadVersionsList({ selectFirst: true });
    } catch (err) {
      verState.confirm = null;
      renderVersionActions();
      toast(window.IrisI18n.error(err, "versions.restoreFailed"), "err");
    } finally {
      verState.busy = false;
    }
  }

  // Manual project-wide snapshot, shared by the toolbar button and the history
  // dialog. Persists first so the server captures the working copy from disk.
  async function snapshotProject(button) {
    if (verState.busy || isReadOnly()) return;
    verState.busy = true;
    if (button) { button.disabled = true; button.classList.add("loading"); }
    try {
      await persist();
      const out = await window.IrisProjects.checkpointCurrent();
      const created = (out && Number(out.created)) || 0;
      toast(created ? t("versions.snapshotDone", { count: created }) : t("versions.snapshotNone"));
      if ($("versionsModal").classList.contains("on")) {
        verState.selectedId = null;
        await loadVersionsList({ selectFirst: true });
      }
    } catch (err) {
      toast(window.IrisI18n.error(err, "versions.snapshotFailed"), "err");
    } finally {
      verState.busy = false;
      if (button) { button.disabled = false; button.classList.remove("loading"); }
    }
  }

  function setVersionView(mode) {
    verState.view = mode === "diff" ? "diff" : "preview";
    renderVersionDetail();
  }

  // Re-render the open history dialog after a language switch.
  function refreshVersionsUi() {
    if (!$("versionsModal").classList.contains("on")) return;
    if (verState.node) $("versionsSubtitle").textContent = verState.node.name || verState.node.path || "";
    $("versionsSnapshot").style.display = isReadOnly() ? "none" : "";
    if (!verState.versions.length) {
      setVersionsListState(`<div class="ve-title">${esc(t("versions.empty"))}</div><div class="ve-sub">${esc(t("versions.emptyHint"))}</div>`);
    }
    renderVersionList();
    renderVersionDetail();
  }

  // Line-based diff (LCS). Bounded by the 2 MB version cap; a coarse
  // prefix/suffix diff guards pathological line counts from a quadratic table.
  function lineDiff(oldText, newText) {
    const a = String(oldText).split("\n");
    const b = String(newText).split("\n");
    const n = a.length, m = b.length;
    if (n > 2000 || m > 2000 || n * m > 2000000) return simpleLineDiff(a, b);
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const rows = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { rows.push({ type: "same", text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: "del", text: a[i] }); i++; }
      else { rows.push({ type: "add", text: b[j] }); j++; }
    }
    while (i < n) { rows.push({ type: "del", text: a[i] }); i++; }
    while (j < m) { rows.push({ type: "add", text: b[j] }); j++; }
    return rows;
  }
  function simpleLineDiff(a, b) {
    const n = a.length, m = b.length;
    const head = [];
    let s = 0;
    while (s < n && s < m && a[s] === b[s]) { head.push({ type: "same", text: a[s] }); s++; }
    const tail = [];
    let ea = n - 1, eb = m - 1;
    while (ea >= s && eb >= s && a[ea] === b[eb]) { tail.unshift({ type: "same", text: a[ea] }); ea--; eb--; }
    const mid = [];
    for (let i = s; i <= ea; i++) mid.push({ type: "del", text: a[i] });
    for (let j = s; j <= eb; j++) mid.push({ type: "add", text: b[j] });
    return head.concat(mid, tail);
  }

  window.IrisApp = {
    // Load a project's data into the editor and render everything.
    async load(data) {
      const generation = ++state.projectLoadGeneration;
      data = data || {};
      cancelPendingBuild();
      const projectLanguage = Object.prototype.hasOwnProperty.call(window.IrisI18n.SUPPORTED, data.language)
        ? data.language
        : window.IrisI18n.defaultLanguage;
      await window.IrisI18n.setLanguage(projectLanguage, {
        silent: true,
        isCurrent: () => generation === state.projectLoadGeneration,
      });
      if (generation !== state.projectLoadGeneration) return false;
      state.projectLanguage = projectLanguage;
      project = (data.project && data.project.nodes) ? data.project : { name: data.name || "", nodes: [] };
      state.projectType = inferProjectType(data);
      state.assets = data.assets || {};
      // rebuild image assets from the tree if not stored separately
      walk(project.nodes, (f) => { if (f.kind === "img" && f.data && f.path && !state.assets[f.path]) state.assets[f.path] = f.data; });
      state.engine = state.projectType === "lilypond" ? "lilypond" : (data.engine || "pdflatex");
      state.lilypondArgs = state.projectType === "lilypond" ? String(data.lilypondArgs || "") : "";
      state.lilypondFormat = state.projectType === "lilypond" && ["pdf", "png", "svg", "ps", "eps"].includes(data.lilypondFormat)
        ? data.lilypondFormat
        : "pdf";
      state.compileProfile = normalizeCompileProfile(data.compileProfile);
      state.fonts = fontSettingsFromTree(data.fonts);
      state.fonts.forEach((font) => registerProjectFont(font).then(() => renderFontList()));
      setPreviewFont(null);
      state.outputGeneration += 1;
      state.pdfLoadGeneration += 1;
      void releasePdfDocument();
      clearCompiledArtifacts();
      state.lastCompile = null;
      state.previewBuildId = null;
      state.pages = []; state.curPage = 1;
      state.untitledN = data.untitledN || 0;
      state.autoSave = data.autoSave === true;
      state.autoSaveDelay = normalizeAutoSaveDelay(data.autoSaveDelay ?? 600);
      clearTimeout(persistT);
      state.dirtyFiles.clear();
      state.editRevision = 0;
      state.role = data.role || "owner";
      applyRoleGate();
      // Follow the project for build notifications, whatever file ends up open.
      clearNewerBuild();
      if (data.id) window.IrisCollab.watchProject(data.id);
      if (isReadOnly()) toast(t("projects.readOnlyNotice"));
      state.zoom = 1; state.effectiveZoom = 1; state.fit = true; state.view = "preview"; state.previewKind = "empty";
      setWorkspaceView("editor");
      updateProjectTypeUi();

      // resolve open tabs + active file
      let tabs = Array.isArray(data.openTabs) ? data.openTabs.filter((id) => findFile(id)) : [];
      let active = (data.activeId && findFile(data.activeId)) ? data.activeId : null;
      if (!active) walk(project.nodes, (f) => {
        if (!active && f.kind === (isLilyPondProject() ? "ly" : "tex")) active = f.id;
      });
      if (active && !tabs.includes(active)) tabs.unshift(active);
      state.openTabs = tabs;
      state.activeId = active;

      renderTree();
      renderTabs();
      // reset preview / status
      $("pvPages").innerHTML = ""; $("logView").innerHTML = "";
      $("pvEmpty").innerHTML = `<div class="big">${ti("file")}</div><span>${esc(t("preview.empty"))}</span>`;
      $("pvEmpty").style.display = ""; $("pgTot").textContent = "–"; $("pgCur").textContent = "–";
      $("stTime").textContent = t("status.neverCompiled");
      $("stWarn").style.display = "none"; $("stErr").style.display = "none"; $("stMath").textContent = "";
      setView("preview");

      if (active) openFile(active);
      else { ed().load("", null); renderOutline(); }
      updateZoomLabel();
      return true;
    },
    // Snapshot the active project for persistence. Source files this client did
    // not edit are sent without content so the server keeps what is on disk; see
    // snapshotNodes.
    serialize() {
      return projectSnapshot();
    },
    hasUnsavedChanges() { return state.dirtyFiles.size > 0; },
    waitForPersistence,
    persistChanges() { return persist(); },
    setName(name) { project.name = name; },
    setRole(role) {
      state.role = ["owner", "editor", "viewer"].includes(role) ? role : "viewer";
      applyRoleGate();
      if (isReadOnly()) toast(t("projects.readOnlyNotice"));
    },
    showBuildOutput,
    clearBuildOutput,
    currentBuildId() { return state.previewBuildId; },
    cancelPendingBuild,
    cancelPendingProjectLoad,
  };

  /* ---------------- boot ---------------- */
  function refreshLocalizedUi() {
    updateProjectTypeUi();
    renderCursorStatus();
    setWordWrap(state.wordWrap);
    renderCompileProfile();
    updateTexPathControl();
    renderTabs();
    renderTree();
    renderOutline();
    renderFontList();

    if ($("treeNewModal").classList.contains("on")) {
      const destination = $("newItemDest").value;
      const isFolder = newItemMode === "folder";
      $("newItemDest").innerHTML = folderOptions(destination);
      $("newItemDest").value = destination;
      $("newItemLabel").textContent = t(isFolder ? "tree.folderName" : "tree.fileName");
      updateNewItemHint();
    }

    if (treeAction && $("treeRenameModal").classList.contains("on")) {
      const isFolder = treeAction.node.type === "folder";
      $("treeRenameTitle").textContent = t(isFolder ? "tree.renameFolder" : "tree.renameFile");
      $("treeRenameLabel").textContent = t(isFolder ? "tree.folderName" : "tree.fileName");
      $("treeRenameHint").textContent = t("tree.nameHint");
    }

    if (treeAction && $("treeDeleteModal").classList.contains("on")) {
      const isFolder = treeAction.node.type === "folder";
      $("treeDeleteTitle").textContent = t(isFolder ? "tree.deleteFolder" : "tree.deleteFile");
      $("treeDeleteText").textContent = t(isFolder ? "tree.deleteFolderConfirm" : "tree.deleteFileConfirm", {
        name: treeAction.node.name,
      });
    }

    if ($("attachModal").classList.contains("on")) {
      const destination = $("attachDest").value;
      $("attachDest").innerHTML = folderOptions(destination);
      $("attachDest").value = destination;
    }

    refreshVersionsUi();
    renderNewerBuild();
    renderPresence(lastPeers);

    if (state.lastCompile) {
      const { f, res, ms, compiledAt } = state.lastCompile;
      buildLog(f, res, ms, false);
      updateCompileStatus(res, ms, compiledAt);
    } else if ($("compiling").classList.contains("on")) {
      $("stState").textContent = t("status.compiling");
    } else {
      $("stState").textContent = t("status.ready");
      $("stTime").textContent = t("status.neverCompiled");
      if (!state.compiledArtifacts.length && !state.pdfDocument) {
        $("pvEmpty").innerHTML = `<div class="big">${ti("file")}</div><span>${esc(t("preview.empty"))}</span>`;
      }
    }
    if (!state.compiledArtifacts.length) clearCompiledArtifacts();
  }

  document.addEventListener("iris:languagechange", refreshLocalizedUi);
  Promise.all([window.IrisI18n.ready, window.IrisEditor.ready]).then(() => {
    wireEditorEvents();
    loadLayout();
    loadRuntimeConfig();
    renderFontList();
    renderCompileProfile();
    updateZoomLabel();
    wire();
  });
})();
