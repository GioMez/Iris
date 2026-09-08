const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ChangeSet } = require("@codemirror/state");

const read = (name) => fs.readFileSync(path.join(__dirname, "../public", name), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const options = { timeout: 2000 };

function projectData(revision = 4, content = "original") {
  return {
    id: "p1", revision, role: "owner", projectType: "latex", language: "en",
    project: { name: "Score", nodes: [{ type: "file", id: "main", name: "main.tex", path: "main.tex", kind: "tex", content }] },
    activeId: "main", openTabs: ["main"], assets: {}, fonts: [], engine: "pdflatex",
    compileProfile: { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] },
    lilypondArgs: "", lilypondFormat: "pdf", autoSave: false, autoSaveDelay: 600,
  };
}

function element() {
  const classes = new Set();
  const listeners = new Map();
  return {
    children: [], dataset: {}, value: "", textContent: "", innerHTML: "",
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; },
    },
    setAttribute() {}, removeAttribute() {}, focus() {}, select() {}, remove() {},
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    querySelector() { return element(); }, querySelectorAll() { return []; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach((fn) => fn.call(this, event)); },
  };
}

function harness(language = "en", realtime = false) {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const document = Object.assign(element(), { getElementById: get, createElement: element, documentElement: element(), body: element(), querySelector: get });
  const translations = JSON.parse(read(`locales/${language}/translation.json`));
  const t = (key) => key.split(".").reduce((value, part) => value && value[part], translations) || key;
  const requests = [];
  const timers = [];
  const windowEvents = element();
  const events = [];
  const dispatch = document.dispatchEvent;
  document.dispatchEvent = (event) => { events.push(event); dispatch(event); };
  let surface = "picker";
  let change = () => {};
  let editor = {
    value: "", ready: new Promise(() => {}),
    load(value) { this.value = value; }, getValue() { return this.value; },
    onChange(fn) { change = fn; }, onCursor() {}, onPeers() {},
    setReadOnly() {}, setWordWrap() {}, focus() {},
  };
  const sockets = [];
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 0; this.sent = []; this.handlers = {}; sockets.push(this); }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    fire(type, event = {}) {
      if (type === "open") this.readyState = 1;
      for (const fn of this.handlers[type] || []) fn(event);
    }
    deliver(message) { this.fire("message", { data: JSON.stringify(message) }); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
    of(type) { return this.sent.filter((m) => m.t === type); }
  }
  const context = vm.createContext({
    console: { error() {}, warn() {} }, document, URL, URLSearchParams, performance, WebSocket: Socket,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; }, requestAnimationFrame() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    IrisLatex: { outline() { return []; } },
    fetch(url, init = {}) {
      return new Promise((resolve, reject) => requests.push({
        url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined,
        reply(data, status = 200) { resolve({ ok: status < 400, status, json: async () => clone(data) }); }, reject,
      }));
    },
    window: {
      location: { protocol: "http:", host: "test" },
      addEventListener: windowEvents.addEventListener,
      matchMedia() { return { matches: false, addEventListener() {} }; },
      IrisEditor: editor, IrisIcons: { icon() { return ""; } },
      IrisI18n: {
        t, error(err, fallback) { return err.code ? t(`api.${err.code}`) : (err.message || t(fallback)); },
        ready: new Promise(() => {}), SUPPORTED: { en: true, it: true }, defaultLanguage: language,
        setLanguage: async () => {}, useDefaultLanguage: async () => {}, formatDate: () => "today",
      },
      IrisMotion: {
        activeSurface: () => surface, setActiveSurface(value) { surface = value; },
        openDialog(id) { get(id).classList.add("on"); }, closeDialog: async (id) => get(id).classList.remove("on"),
        openProject() {}, closeProject: async () => {}, resetProject() {},
      },
      IrisCollab: {
        active: () => false, status: () => "offline", leave() {}, join() {}, disconnect() {},
        watchProject() {}, onStatus() {}, onBuild() {},
      },
    },
  });
  // Expose lexical entry points only in the VM; the shipping API stays focused.
  function run(name, exposure = "") {
    let source = read(name).replace('import("/vendor/pdfjs/pdf.min.mjs")', 'Promise.resolve({ GlobalWorkerOptions: {} })');
    if (name === "iris-editor.js") source = source.replace(/import\("([^"]+)"\)/g, 'Promise.resolve(editorModules["$1"])');
    const end = source.lastIndexOf("})();");
    source = source.slice(0, end) + exposure + source.slice(end);
    vm.runInContext(source, context, { filename: name });
  }
  run("iris-net.js");
  if (realtime) {
    // Run the shipping adapter and real CM extensions; only view rendering is
    // headless. Like EditorView.dispatch, this does not enforce state.readOnly.
    const viewModule = require("@codemirror/view");
    let view;
    class HeadlessView {
      constructor({ state }) {
        this.state = state;
        this.scrollDOM = { getBoundingClientRect: () => ({ top: 0, bottom: 500 }) };
        view = this;
      }
      setState(state) { this.state = state; }
      dispatch(...specs) {
        const startState = this.state;
        const tr = specs.length === 1 && specs[0].state ? specs[0] : startState.update(...specs);
        this.state = tr.state;
        for (const listener of this.state.facet(viewModule.EditorView.updateListener)) {
          listener({ startState, state: this.state, view: this, transactions: [tr], changes: tr.changes, docChanged: tr.docChanged, selectionSet: !!tr.selection });
        }
      }
      focus() {}
      requestMeasure() {}
      coordsAtPos() { return null; }
    }
    Object.setPrototypeOf(HeadlessView, viewModule.EditorView);
    context.editorModules = {
      "@codemirror/state": require("@codemirror/state"),
      "@codemirror/view": { ...viewModule, EditorView: HeadlessView },
      "@codemirror/language": require("@codemirror/language"),
      "@codemirror/commands": require("@codemirror/commands"),
      "@lezer/highlight": require("@lezer/highlight"),
      "@codemirror/collab": require("@codemirror/collab"),
    };
    // StringStream checks instanceof RegExp, so syntax runs in CM's realm.
    vm.compileFunction(read("iris-latex.js"), ["window"])(context.window);
    context.IrisLatex = context.window.IrisLatex;
    vm.compileFunction(read("iris-lilypond.js"), ["window", "IrisLatex"])(context.window, context.IrisLatex);
    context.IrisLilyPond = context.window.IrisLilyPond;
    run("iris-editor.js");
    editor = context.window.IrisEditor;
    Object.defineProperty(editor, "value", { get: () => editor.getValue() });
    editor.isReadOnly = () => view.state.readOnly;
    run("iris-collab.js");
  }
  run("iris-app.js", "window.appTest = { state, findFile, wire, wireEditorEvents, openFile, syncRealtimeSession, canonicalFileId, refreshFileTree, saveProject, openFileHistory, snapshotProject, confirmRestore, verState, openTreeRename, confirmTreeRename, folderNodeByPath };\n");
  run("iris-projects.js", "window.projectsTest = { renameProject, cache, metaOf, finishDiscardDecision };\n");
  context.window.appTest.wireEditorEvents();
  return {
    window: context.window,
    app: context.window.IrisApp, projects: context.window.IrisProjects,
    a: context.window.appTest, p: context.window.projectsTest,
    editor, requests, events, get, timers, windowEvents, surface: () => surface, t,
    socket: () => sockets.at(-1),
    edit(value) {
      if (realtime) editor.applyText(value);
      else { editor.value = value; change(); }
    },
    async open(data = projectData()) {
      if (realtime) { await editor.ready; assert.equal(editor.available, true); }
      const pending = this.projects.openProject(data.id);
      await tick(); requests.at(-1).reply(data); await pending;
      assert.equal(this.projects.currentProjectId(), data.id);
    },
    ack(request, revision, extra = {}) {
      const data = clone(request.body.data);
      data.revision = revision;
      request.reply({ project: { id: "p1", name: data.project.name, revision }, data, revision, ...extra });
    },
  };
}

test("saves capture the current tree at queue start and acknowledge only included edits", options, async () => {
  const h = harness(); await h.open(); h.edit("first");
  const first = h.app.persistChanges(); await tick();
  const req1 = h.requests.at(-1);
  assert.equal(req1.body.baseRevision, 4);
  h.edit("second");
  const second = h.app.persistChanges();
  h.edit("third"); await tick();
  assert.equal(h.requests.length, 2);
  h.ack(req1, 5); assert.equal(await first, true); await tick();
  assert.equal(h.app.hasUnsavedChanges(), true);
  const req2 = h.requests.at(-1);
  assert.equal(req2.body.baseRevision, 5);
  assert.equal(req2.body.data.project.nodes[0].content, "third");
  assert.equal(h.p.cache.get("p1").project.nodes[0].content, "first");
  h.ack(req2, 6); assert.equal(await second, true);
  assert.equal(h.editor.value, "third");
  assert.equal(h.app.hasUnsavedChanges(), false);
  assert.equal(h.app.serialize().revision, 6);
});

test("409 preserves buffers, base, cache and metadata and shows the localized explanation", options, async () => {
  for (const language of ["en", "it"]) {
    const h = harness(language); await h.open(); h.edit("local work");
    const pending = h.a.saveProject(); await tick();
    h.requests.at(-1).reply({ errorCode: "PROJECT_REVISION_CONFLICT", params: { currentRevision: 9 } }, 409);
    assert.equal(await pending, false);
    assert.equal(h.editor.value, "local work");
    assert.equal(h.app.hasUnsavedChanges(), true);
    assert.equal(h.app.serialize().revision, 4);
    assert.equal(h.p.cache.get("p1").project.nodes[0].content, "original");
    assert.equal(h.requests.length, 2, "no fresh GET and no retry");
    assert.ok(h.get("toasts").children.some((node) => node.innerHTML.includes(h.t("api.PROJECT_REVISION_CONFLICT"))));
    assert.notEqual(h.t("api.PROJECT_REVISION_CONFLICT"), "api.PROJECT_REVISION_CONFLICT");
  }
});

test("failed structural saves stay dirty, but caret/tab state does not", options, async () => {
  const h = harness(); await h.open();
  h.a.state.openTabs = []; h.a.state.activeId = null;
  assert.equal(h.app.hasUnsavedChanges(), false);
  h.a.openTreeRename(h.a.findFile("main"), [], "");
  h.get("treeRenameInput").value = "renamed.tex"; h.a.confirmTreeRename(); await tick();
  h.requests.at(-1).reply({ errorCode: "PROJECT_RECOVERY_REQUIRED" }, 503);
  await h.app.waitForPersistence();
  assert.equal(h.a.state.dirtyFiles.size, 0);
  assert.equal(h.app.hasUnsavedChanges(), true);
  assert.equal(h.a.findFile("main").path, "renamed.tex");
});

test("compile and checkpoint serialize behind saves and failed builds still acknowledge the save", options, async () => {
  const h = harness(); await h.open(); h.edit("first");
  const save = h.app.persistChanges(); await tick(); const req1 = h.requests.at(-1);
  const compile = h.projects.compileCurrent(() => ({ engine: "pdflatex", mainPath: "main.tex" }));
  const checkpoint = h.projects.checkpointCurrent();
  h.edit("queued text"); await tick(); assert.equal(h.requests.length, 2);
  h.ack(req1, 5); await save; await tick();
  const req2 = h.requests.at(-1);
  assert.equal(req2.url, "/api/projects/p1/compile");
  assert.equal(req2.body.baseRevision, 5);
  assert.equal(req2.body.data.project.nodes[0].content, "queued text");
  h.ack(req2, 6, { success: false, errors: ["build failed"] }); await compile; await tick();
  assert.equal(h.requests.at(-1).url, "/api/projects/p1/checkpoint");
  assert.deepEqual(h.requests.at(-1).body, {});
  h.requests.at(-1).reply({ created: 1 }); await checkpoint;
  assert.equal(h.app.serialize().revision, 6);
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("post-save compile errors acknowledge savedRevision without fetching or losing newer edits", options, async () => {
  const h = harness(); await h.open(); h.edit("compiled text");
  const pending = h.projects.compileCurrent(() => ({}));
  const rejected = assert.rejects(pending, { code: "BUILD_SETUP_FAILED" });
  await tick(); h.edit("new text");
  h.requests.at(-1).reply({ errorCode: "BUILD_SETUP_FAILED", params: { savedRevision: 5 } }, 500);
  await rejected;
  assert.equal(h.app.serialize().revision, 5);
  assert.equal(h.editor.value, "new text");
  assert.equal(h.app.hasUnsavedChanges(), true);
  assert.equal(h.p.cache.get("p1").project.nodes[0].content, "compiled text");
  assert.equal(h.requests.length, 2);
});

test("refused refresh never advances cached tree or browser base", options, async () => {
  const h = harness(); await h.open();
  const pending = h.a.refreshFileTree(); await tick();
  h.edit("during refresh");
  h.requests.at(-1).reply(projectData(8, "remote")); await pending;
  assert.equal(h.editor.value, "during refresh");
  assert.equal(h.p.cache.get("p1").revision, 4);
  assert.equal(h.app.serialize().revision, 4);
});

test("accepted refresh updates manifest, tree, revision and cache together", options, async () => {
  const h = harness(); await h.open();
  const pending = h.a.refreshFileTree(); await tick();
  const remote = projectData(8, "remote"); remote.engine = "xelatex";
  h.requests.at(-1).reply(remote); await pending;
  assert.equal(h.editor.value, "remote");
  assert.equal(h.app.serialize().engine, "xelatex");
  assert.equal(h.app.serialize().revision, 8);
  assert.equal(h.p.cache.get("p1").revision, 8);
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("clean close does not write a tree", options, async () => {
  const h = harness(); await h.open();
  const pending = h.projects.closeCurrent(); await tick();
  assert.equal(h.requests.at(-1).url, "/api/projects");
  assert.equal(h.requests.at(-1).method, "GET");
  h.requests.at(-1).reply({ projects: [] }); assert.equal(await pending, true);
  assert.equal(h.projects.currentProjectId(), null);
});

test("close waits for pending persistence and keeps failed work visible unless explicitly discarded", options, async () => {
  for (const method of ["closeCurrent", "showPicker"]) {
    const h = harness(); await h.open(); h.app.setName("local name");
    const save = h.app.persistChanges(); await tick(); const request = h.requests.at(-1);
    const closing = h.projects[method](); await tick();
    assert.equal(h.surface(), "app");
    request.reply({ errorCode: "PROJECT_REVISION_CONFLICT", params: { currentRevision: 8 } }, 409);
    assert.equal(await save, false); await tick();
    assert.equal(h.get("projUnsavedModal").classList.contains("on"), true);
    await h.p.finishDiscardDecision(false);
    assert.equal(await closing, false);
    assert.equal(h.projects.currentProjectId(), "p1");
    assert.equal(h.app.serialize().project.name, "local name");
    assert.equal(h.surface(), "app");
  }
});

test("checkpoint, history and restore abort after a failed prerequisite save", options, async () => {
  for (const action of ["checkpoint", "history", "restore"]) {
    const h = harness(); await h.open(); h.edit("unsaved");
    h.a.verState.node = h.a.findFile("main"); h.a.verState.fileId = "canonical"; h.a.verState.selectedId = "v1";
    const pending = action === "checkpoint" ? h.a.snapshotProject(h.get("btnSnapshot"))
      : action === "history" ? h.a.openFileHistory(h.a.findFile("main")) : h.a.confirmRestore();
    await tick(); h.requests.at(-1).reply({ errorCode: "PROJECT_REVISION_CONFLICT" }, 409);
    await tick();
    assert.equal(h.requests.length, 2, `${action} must not issue its dependent request`);
    await pending;
    assert.equal(h.editor.value, "unsaved");
  }
});

test("dashboard rename sends only name and the index revision, with no optimistic metadata changes", options, async () => {
  const h = harness();
  h.p.cache.set("p1", projectData(2, "old cached tree"));
  const listing = h.projects.renderPicker(); await tick();
  h.requests.at(-1).reply({ projects: [{ id: "p1", name: "Score", revision: 7, role: "owner" }] }); await listing;
  const failed = h.p.renameProject("p1", "Refused");
  const rejected = assert.rejects(failed, { code: "PROJECT_REVISION_CONFLICT" }); await tick();
  assert.deepEqual(h.requests.at(-1).body, { name: "Refused", baseRevision: 7 });
  assert.equal(h.p.metaOf("p1").name, "Score");
  assert.equal(h.p.cache.get("p1").project.name, "Score");
  h.requests.at(-1).reply({ errorCode: "PROJECT_REVISION_CONFLICT", params: { currentRevision: 8 } }, 409); await rejected;
  assert.equal(h.p.metaOf("p1").revision, 7);
  assert.equal(h.p.metaOf("p1").name, "Score");
  const pending = h.p.renameProject("p1", "Renamed"); await tick();
  const data = projectData(8); data.project.name = "Renamed";
  h.requests.at(-1).reply({ data, project: { id: "p1", name: "Renamed", revision: 8 } }); await pending;
  assert.equal(h.p.metaOf("p1").name, "Renamed");
  assert.equal(h.p.cache.get("p1").revision, 8);
});

test("active rename shares the save queue without acknowledging unsent structural changes", options, async () => {
  const h = harness(); await h.open(); h.edit("saved text");
  const save = h.app.persistChanges(); await tick(); const first = h.requests.at(-1);
  const rename = h.p.renameProject("p1", "Renamed"); await tick(); assert.equal(h.requests.length, 2);
  h.ack(first, 5); await save; await tick();
  assert.deepEqual(h.requests.at(-1).body, { name: "Renamed", baseRevision: 5 });
  h.a.state.engine = "xelatex";
  const data = projectData(6, "saved text"); data.project.name = "Renamed";
  h.requests.at(-1).reply({ data, project: { id: "p1", name: "Renamed", revision: 6 } }); await rename;
  assert.equal(h.app.serialize().project.name, "Renamed");
  assert.equal(h.app.serialize().revision, 6);
  assert.equal(h.app.hasUnsavedChanges(), true);
  const next = h.app.persistChanges(); await tick();
  assert.equal(h.requests.at(-1).body.data.engine, "xelatex");
  h.ack(h.requests.at(-1), 7); await next;
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("rename acknowledgement preserves a newer local name", options, async () => {
  const h = harness(); await h.open();
  const pending = h.p.renameProject("p1", "Submitted"); await tick();
  h.app.setName("Newer local name");
  const data = projectData(5); data.project.name = "Submitted";
  h.requests.at(-1).reply({ data, project: { id: "p1", name: "Submitted", revision: 5 } }); await pending;
  assert.equal(h.app.serialize().project.name, "Newer local name");
  assert.equal(h.app.hasUnsavedChanges(), true);
  assert.equal(h.app.serialize().revision, 5);
});

test("checkpoint-with-data acknowledges only its saved snapshot", options, async () => {
  const h = harness(); await h.open(); h.edit("checkpoint text");
  const pending = h.projects.checkpointCurrent({ withData: true }); await tick();
  const request = h.requests.at(-1);
  assert.equal(request.body.baseRevision, 4);
  assert.equal(request.body.data.project.nodes[0].content, "checkpoint text");
  h.a.state.engine = "xelatex";
  h.ack(request, 5, { created: 1 }); await pending;
  assert.equal(h.app.serialize().revision, 5);
  assert.equal(h.a.state.dirtyFiles.size, 0);
  assert.equal(h.app.hasUnsavedChanges(), true);
});

test("stale GET responses cannot replace the cache after logout and reopen", options, async () => {
  const h = harness();
  const oldOpen = h.projects.openProject("p1"); await tick(); const oldGet = h.requests.at(-1);
  h.projects.onLogout();
  const reopening = h.projects.openProject("p1");
  oldGet.reply(projectData(4, "stale")); await oldOpen;
  await tick();
  assert.equal(h.p.cache.has("p1"), false);
  h.requests.at(-1).reply(projectData(10, "new session")); await reopening;
  assert.equal(h.editor.value, "new session");
  assert.equal(h.p.cache.get("p1").revision, 10);
  assert.equal(h.app.serialize().revision, 10);
});

test("stale save acknowledgements cannot update a replacement editor session", options, async () => {
  const h = harness(); await h.open(); h.edit("old session");
  const pending = h.app.persistChanges(); await tick();
  await h.app.load(projectData(12, "replacement"));
  h.ack(h.requests.at(-1), 5);
  assert.equal(await pending, false);
  assert.equal(h.editor.value, "replacement");
  assert.equal(h.app.serialize().revision, 12);
  assert.equal(h.p.cache.get("p1").revision, 4);
});

test("a reload refuses edits made while its GET is pending", options, async () => {
  const h = harness(); await h.open();
  const pending = h.projects.openProject("p1"); await tick();
  h.edit("typed during reload"); h.requests.at(-1).reply(projectData(7, "remote")); await pending;
  assert.equal(h.editor.value, "typed during reload");
  assert.equal(h.app.serialize().revision, 4);
  assert.equal(h.p.cache.get("p1").revision, 4);
  assert.equal(h.app.hasUnsavedChanges(), true);
});

test("restore keeps local edits made after its prerequisite save", options, async () => {
  const h = harness(); await h.open(); h.edit("saved before restore");
  h.a.verState.node = h.a.findFile("main"); h.a.verState.fileId = "canonical"; h.a.verState.selectedId = "v1";
  const pending = h.a.confirmRestore(); await tick();
  h.ack(h.requests.at(-1), 5); await tick();
  assert.ok(h.requests.at(-1).url.endsWith("/restore"));
  h.edit("new edit during restore");
  h.requests.at(-1).reply({ content: "restored text" }); await tick();
  if (h.requests.at(-1).url.endsWith("/versions")) h.requests.at(-1).reply({ versions: [] });
  await pending;
  assert.equal(h.editor.value, "new edit during restore");
  assert.equal(h.app.hasUnsavedChanges(), true);
});

test("428 and recovery errors retain the base and local manifest", options, async () => {
  for (const [code, status] of [["PROJECT_REVISION_REQUIRED", 428], ["PROJECT_RECOVERY_REQUIRED", 503]]) {
    const h = harness(); await h.open(); h.a.state.engine = "xelatex";
    const pending = h.app.persistChanges(); await tick();
    h.requests.at(-1).reply({ errorCode: code }, status); assert.equal(await pending, false);
    assert.equal(h.app.serialize().revision, 4);
    assert.equal(h.app.hasUnsavedChanges(), true);
    assert.equal(h.app.serialize().engine, "xelatex");
    assert.notEqual(h.t(`api.${code}`), `api.${code}`);
  }
});

test("a queued save after refused refresh keeps its old base and current local buffer", options, async () => {
  const h = harness(); await h.open();
  const refreshing = h.a.refreshFileTree(); await tick(); const request = h.requests.at(-1);
  h.edit("local buffer"); const saving = h.app.persistChanges();
  request.reply(projectData(12, "remote buffer")); await refreshing; await tick();
  assert.equal(h.requests.at(-1).body.baseRevision, 4);
  assert.equal(h.requests.at(-1).body.data.project.nodes[0].content, "local buffer");
  h.requests.at(-1).reply({ errorCode: "PROJECT_REVISION_CONFLICT", params: { currentRevision: 12 } }, 409);
  assert.equal(await saving, false);
  assert.equal(h.editor.value, "local buffer");
  assert.equal(h.p.cache.get("p1").revision, 4);
});

test("explicit discard allows reload, while a failed reload never hides newer local work", options, async () => {
  const h = harness(); await h.open(); h.edit("discarded work");
  const reopening = h.projects.openProject("p1"); await tick();
  assert.equal(h.get("projUnsavedModal").classList.contains("on"), true);
  await h.p.finishDiscardDecision(true); await tick();
  h.requests.at(-1).reply(projectData(9, "reloaded")); await reopening;
  assert.equal(h.editor.value, "reloaded");
  assert.equal(h.app.serialize().revision, 9);
  assert.equal(h.app.hasUnsavedChanges(), false);
  const failed = h.projects.openProject("p1"); await tick();
  h.edit("keep this work"); h.requests.at(-1).reply({ errorCode: "PROJECT_RECOVERY_REQUIRED" }, 503); await tick();
  assert.equal(h.projects.currentProjectId(), "p1");
  assert.equal(h.surface(), "app");
  assert.equal(h.requests.length, 3);
  await failed;
  assert.equal(h.editor.value, "keep this work");
  assert.equal(h.p.cache.get("p1").revision, 9);
});

test("editor refusal during asynchronous load cannot advance tree or cache", options, async () => {
  const h = harness(); await h.open();
  let finishLanguage;
  h.window.IrisI18n.setLanguage = () => new Promise((resolve) => { finishLanguage = resolve; });
  const reopening = h.projects.openProject("p1"); await tick();
  h.requests.at(-1).reply(projectData(9, "remote")); await tick();
  h.edit("typed while locale loads"); finishLanguage(); await reopening;
  assert.equal(h.editor.value, "typed while locale loads");
  assert.equal(h.app.serialize().revision, 4);
  assert.equal(h.p.cache.get("p1").revision, 4);
});

test("savedRevision must identify this request's exact commit, not an unrelated revision", options, async () => {
  for (const savedRevision of ["5", 12, null]) {
    const h = harness(); await h.open(); h.edit("unsaved");
    const pending = h.projects.compileCurrent(() => ({}));
    const rejected = assert.rejects(pending); await tick();
    h.requests.at(-1).reply({ errorCode: "BUILD_SETUP_FAILED", params: { savedRevision } }, 500); await rejected;
    assert.equal(h.app.serialize().revision, 4);
    assert.equal(h.app.hasUnsavedChanges(), true);
    assert.equal(h.requests.length, 2);
  }
});

test("autosave keeps its configured delay and persists manifest edits without a dirty file", options, async () => {
  const h = harness(); await h.open(); h.a.wire();
  h.get("autoSave").dispatchEvent({ type: "click" }); await tick();
  h.ack(h.requests.at(-1), 5); await h.app.waitForPersistence();
  h.get("autoSaveDelay").value = "25";
  h.get("autoSaveDelay").dispatchEvent({ type: "input" });
  assert.equal(h.a.state.dirtyFiles.size, 0);
  assert.equal(h.app.hasUnsavedChanges(), true);
  const timer = h.timers.filter((item) => !item.cleared).at(-1);
  assert.equal(timer.delay, 25000);
  timer.fn(); await tick();
  assert.equal(h.requests.at(-1).body.data.autoSaveDelay, 25);
  h.ack(h.requests.at(-1), 6); await h.app.waitForPersistence();
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("beforeunload protects failed structural edits only while their project remains open", options, async () => {
  const h = harness(); await h.open(); h.a.wire(); h.app.setName("unsaved name");
  let prevented = 0;
  h.windowEvents.dispatchEvent({ type: "beforeunload", preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  const closing = h.projects.closeCurrent(); await tick();
  await h.p.finishDiscardDecision(true); await tick();
  h.requests.at(-1).reply({ projects: [] }); await closing;
  h.windowEvents.dispatchEvent({ type: "beforeunload", preventDefault() { prevented++; } });
  assert.equal(prevented, 1, "explicitly discarded work must not trigger another leave warning");
});

test("reconciling a new file must not join realtime over newer unsaved text", options, async () => {
  const h = harness(); await h.open(); h.edit("submitted text");
  // Joining a canonical file loads server text, as the editor adapter does.
  h.window.IrisCollab.join = () => h.editor.load(h.p.cache.get("p1").project.nodes[0].content);
  const saving = h.app.persistChanges(); await tick();
  const request = h.requests.at(-1); h.edit("newer unsaved text");
  const data = clone(request.body.data); data.revision = 5;
  data.project.nodes[0].id = "11111111-1111-4111-8111-111111111111";
  request.reply({ project: { id: "p1", revision: 5, name: "Score" }, data }); await saving;
  assert.equal(h.projects.resolveFileId("main.tex"), "11111111-1111-4111-8111-111111111111");
  assert.equal(h.editor.value, "newer unsaved text");
  assert.equal(h.app.hasUnsavedChanges(), true);
});

for (const completionOrder of ["rename-first", "open-first"]) {
  test(`initial open and dashboard rename keep one base when ${completionOrder}`, options, async () => {
    const h = harness(); h.p.cache.set("p1", projectData());
    const opening = h.projects.openProject("p1"); await tick(); const get = h.requests.at(-1);
    const renaming = h.p.renameProject("p1", "Renamed"); await tick();
    const concurrentRename = h.requests.find((request) => request.method === "PUT");
    const data = projectData(5); data.project.name = "Renamed";
    const response = { data, project: { id: "p1", name: "Renamed", revision: 5 } };
    // On the buggy client both requests exist, so exercise either reply order.
    // With serialization, the rename cannot start until the open is adopted.
    if (concurrentRename && completionOrder === "rename-first") {
      concurrentRename.reply(response); await renaming;
    }
    get.reply(projectData()); await opening; await tick();
    if (!concurrentRename || completionOrder === "open-first") {
      h.requests.at(-1).reply(response); await renaming;
    }
    assert.equal(h.app.serialize().revision, 5);
    assert.equal(h.p.cache.get("p1").revision, 5);
    assert.equal(h.app.serialize().project.name, "Renamed");
    assert.equal(concurrentRename, undefined, "GET/load/adoption must own the mutation queue");
    h.edit("next save"); const saving = h.app.persistChanges(); await tick();
    assert.equal(h.requests.at(-1).body.baseRevision, 5);
    assert.equal(h.requests.at(-1).body.data.project.nodes[0].content, "next save");
    h.ack(h.requests.at(-1), 6); assert.equal(await saving, true);
  });
}

const mainFileId = "11111111-1111-4111-8111-111111111111";
const otherFileId = "22222222-2222-4222-8222-222222222222";
function sharedProject() {
  const data = projectData();
  data.project.nodes[0].id = mainFileId;
  data.project.nodes.push({ type: "file", id: otherFileId, name: "other.tex", path: "other.tex", kind: "tex", content: "other" });
  data.activeId = mainFileId; data.openTabs = [mainFileId];
  return data;
}
async function openShared(h) {
  await h.open(sharedProject());
  h.socket().fire("open");
  h.socket().deliver({ t: "opened", fileId: mainFileId, version: 0, doc: "original", role: "owner" });
}

for (const language of ["en", "it"]) {
  test(`deleted active text stays copyable and dirty with only that file read-only (${language})`, options, async () => {
    const h = harness(language, true); await openShared(h);
    h.edit("original with unconfirmed work");
    h.window.IrisCollab.flush();
    assert.equal(h.app.hasUnsavedChanges(), false, "live OT text is not on the ordinary save path");
    const socket = h.socket();
    socket.deliver({ t: "file-closed", fileId: mainFileId });
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.editor.value, "original with unconfirmed work");
    assert.equal(h.editor.collabPending().updates.length, 1);
    assert.equal(h.a.findFile(mainFileId).content, "original with unconfirmed work");
    assert.equal(h.app.hasUnsavedChanges(), true);
    assert.equal(h.a.state.role, "owner");
    assert.equal(h.window.IrisCollab.watching(), "p1");
    assert.equal(socket.readyState, 1);
    assert.equal(h.app.serialize().revision, 4);
    assert.equal(h.p.cache.get("p1").revision, 4);
    assert.equal(h.get("stSyncLabel").textContent, h.t("collab.fileUnavailable"));
    assert.notEqual(h.t("collab.fileUnavailable"), "collab.fileUnavailable");
    assert.equal(h.get("stSync").title, h.t("collab.fileUnavailableHint"));
    const revision = h.a.state.editRevision;
    socket.deliver({ t: "file-closed", fileId: mainFileId });
    assert.equal(h.a.state.editRevision, revision);
    h.app.setRole("owner");
    assert.equal(h.editor.isReadOnly(), true, "project role updates must not unlock the missing file");
    assert.equal(await h.a.saveProject(), false);
    assert.equal(h.requests.length, 1, "neither refetch nor ordinary-save fallback");
    const node = h.app.serialize().project.nodes[0];
    assert.equal(node.content, undefined, "unconfirmed deleted text must never enter a normal-save payload");
    assert.equal(Object.hasOwn(node, "readOnly"), false, "the gate is not persisted in the tree");
    h.a.openFile(otherFileId);
    socket.deliver({ t: "opened", fileId: otherFileId, version: 0, doc: "other", role: "owner" });
    assert.equal(h.editor.isReadOnly(), false);
    h.edit("other edited"); h.window.IrisCollab.flush();
    assert.equal(socket.of("push").at(-1).fileId, otherFileId);
    const snapshot = h.app.capturePersistence();
    h.app.acknowledgePersistence(snapshot, 5);
    assert.equal(h.app.hasUnsavedChanges(), true, "a normal save cannot acknowledge excluded missing-file text");
    h.a.openFile(mainFileId);
    assert.equal(h.editor.value, "original with unconfirmed work");
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(socket.of("open").filter((m) => m.fileId === mainFileId).length, 1);
    const closing = h.projects.closeCurrent(); await tick();
    assert.equal(h.get("projUnsavedModal").classList.contains("on"), true);
    await h.p.finishDiscardDecision(false); assert.equal(await closing, false);
  });
}

test("missing-file open preserves pre-open typing without enabling normal save or rejoin", options, async () => {
  const h = harness("en", true); await h.open({ ...sharedProject(), autoSave: true }); h.a.wire();
  const socket = h.socket(); socket.fire("open");
  h.edit("typed before open");
  assert.equal(h.timers.filter((timer) => !timer.cleared && timer.delay === 600000).length, 1);
  socket.deliver({ t: "error", request: "open", fileId: mainFileId, code: "COLLAB_FILE_NOT_FOUND" });
  assert.equal(h.editor.isReadOnly(), true);
  assert.equal(h.editor.value, "typed before open");
  assert.equal(h.app.hasUnsavedChanges(), true);
  assert.equal(await h.app.persistChanges(), false);
  h.a.syncRealtimeSession();
  assert.equal(socket.of("open").length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.events.some((event) => event.type === "iris:collabunavailable"), false);
  assert.equal(h.timers.filter((timer) => !timer.cleared && timer.delay === 600000).length, 0);
  h.get("autoSaveDelay").value = "25";
  h.get("autoSaveDelay").dispatchEvent({ type: "input" });
  assert.equal(h.timers.filter((timer) => !timer.cleared && timer.delay === 25000).length, 0, "settings must not restart autosave for the missing file");
});

for (const [renamed, closeFirst] of [["file", true], ["ancestor", true], ["file", false], ["ancestor", false]]) {
  test(`a reconciled local node stays unavailable after ${renamed} rename (${closeFirst ? "closure first" : "rename first"})`, options, async () => {
    const h = harness("en", true);
    const data = sharedProject();
    const local = data.project.nodes[0];
    local.id = "untitled_1"; local.path = "chapter/main.tex";
    data.project.nodes[0] = { type: "folder", name: "chapter", open: true, children: [local] };
    data.activeId = local.id; data.openTabs = [local.id];
    await h.open(data); h.socket().fire("open"); h.edit("saved text");
    const saving = h.app.persistChanges(); await tick();
    const request = h.requests.at(-1);
    const reconciled = clone(request.body.data); reconciled.revision = 5;
    reconciled.project.nodes[0].children[0].id = mainFileId;
    request.reply({ project: { id: "p1", name: "Score", revision: 5 }, data: reconciled });
    assert.equal(await saving, true);
    assert.equal(h.projects.resolveFileId("chapter/main.tex"), mainFileId);
    const cached = clone(h.p.cache.get("p1"));
    h.socket().deliver({ t: "opened", fileId: mainFileId, version: 0, doc: "saved text", role: "owner" });
    h.edit("saved text with pending work");
    const pending = clone(h.editor.collabPending());
    if (closeFirst) h.socket().deliver({ t: "file-closed", fileId: mainFileId });
    const root = h.a.folderNodeByPath("").nodes;
    h.a.openTreeRename(renamed === "file" ? h.a.findFile(local.id) : root[0], renamed === "file" ? root[0].children : root, renamed === "file" ? "chapter/" : "");
    h.get("treeRenameInput").value = renamed === "file" ? "renamed.tex" : "renamed";
    h.a.confirmTreeRename(); await tick();
    assert.equal(h.a.findFile(local.id).path, renamed === "file" ? "chapter/renamed.tex" : "renamed/main.tex");
    assert.equal(h.requests.length, closeFirst ? 2 : 3, "only a rename started before closure can issue its PUT");
    if (!closeFirst) {
      const renameRequest = h.requests.at(-1);
      assert.equal(renameRequest.method, "PUT");
      assert.equal(renameRequest.body.baseRevision, 5);
      h.socket().deliver({ t: "file-closed", fileId: mainFileId });
      renameRequest.reply({ errorCode: "PROJECT_REVISION_CONFLICT" }, 409);
      await h.app.waitForPersistence();
    }
    assert.equal(h.editor.isReadOnly(), true, "closure must find the local node even after its path changed");
    assert.equal(h.a.canonicalFileId(local.id), mainFileId);
    assert.equal(h.editor.value, "saved text with pending work");
    assert.deepEqual(clone(h.editor.collabPending()), pending);
    assert.equal(h.a.state.dirtyFiles.has(local.id), true);
    assert.equal(h.app.serialize().revision, 5);
    assert.deepEqual(clone(h.p.cache.get("p1")), cached);
    assert.equal(h.app.serialize().project.nodes[0].children[0].content, undefined);
    h.a.openFile(local.id);
    assert.equal(h.editor.isReadOnly(), true, "reopening must not depend on the old cached path");
    assert.equal(h.editor.value, "saved text with pending work");
    h.app.setRole("owner");
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.a.state.role, "owner");
    assert.equal(await h.app.persistChanges(), false);
    h.a.openFile(otherFileId);
    h.socket().deliver({ t: "opened", fileId: otherFileId, version: 0, doc: "other", role: "owner" });
    h.edit("other edited");
    const otherSave = h.app.persistChanges(); await tick();
    const next = h.requests.at(-1);
    assert.equal(next.method, "PUT");
    assert.equal(next.body.baseRevision, 5);
    assert.equal(next.body.data.project.nodes[0].children[0].content, undefined, "saving another file excludes the retained text too");
    assert.equal(next.body.data.project.nodes[1].content, "other edited");
    next.reply({ errorCode: "PROJECT_REVISION_CONFLICT" }, 409);
    assert.equal(await otherSave, false);
    assert.equal(h.app.serialize().revision, 5);
    assert.equal(h.p.cache.get("p1").revision, 5);
    h.app.acknowledgePersistence(h.app.capturePersistence(), 6);
    assert.equal(h.a.state.dirtyFiles.has(local.id), true, "excluded text cannot be acknowledged by a later save");
    h.a.openFile(local.id);
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.editor.value, "saved text with pending work");
    assert.equal(h.socket().of("open").filter((m) => m.fileId === mainFileId).length, 1);
    assert.equal(h.window.IrisCollab.watching(), "p1");
    assert.equal(await h.app.load({ ...data, revision: 8 }, { isCurrent: () => false }), false);
    assert.equal(h.a.canonicalFileId(local.id), mainFileId, "a refused load must retain the binding for the renamed path");
    const reloaded = clone(data); reloaded.revision = 8;
    reloaded.project.nodes[0].children[0].id = mainFileId;
    reloaded.activeId = mainFileId; reloaded.openTabs = [mainFileId];
    assert.equal(await h.app.load(reloaded), true);
    assert.equal(h.a.canonicalFileId(local.id), null, "an accepted load must retire bindings for replaced local nodes");
    assert.equal(h.editor.isReadOnly(), false, "an accepted load clears the local-id association too");
    h.edit("editable after accepted load");
    assert.equal(h.editor.value, "editable after accepted load");
  });
}

for (const [action, button, edited] of [
  ["Format", "btnFormat", "needle needle"],
  ["Replace One", "replaceOne", "  edited needle  "],
  ["Replace All", "replaceAll", "  edited edited  "],
]) {
  test(`${action} cannot change a closed buffer through the real editor adapter`, options, async () => {
    const h = harness("en", true); await openShared(h); h.a.wire();
    h.edit("  needle needle  ");
    h.get("findInput").value = "needle"; h.get("replaceInput").value = "edited";
    h.get("findInput").dispatchEvent({ type: "input" });
    const pending = clone(h.editor.collabPending());
    h.socket().deliver({ t: "file-closed", fileId: mainFileId });
    assert.equal(h.editor.isReadOnly(), true);
    h.get(button).dispatchEvent({ type: "click" });
    assert.equal(h.editor.value, "  needle needle  ");
    assert.deepEqual(clone(h.editor.collabPending()), pending, "programmatic edits must not alter the retained OT queue");
    assert.equal(h.a.findFile(mainFileId).content, "  needle needle  ");
    assert.equal(h.a.state.role, "owner");
    assert.equal(h.app.hasUnsavedChanges(), true);
    assert.equal(h.requests.length, 1);

    h.a.openFile(otherFileId);
    h.socket().deliver({ t: "opened", fileId: otherFileId, version: 0, doc: "  needle needle  ", role: "owner" });
    assert.equal(h.editor.isReadOnly(), false);
    h.get("findInput").dispatchEvent({ type: "input" });
    h.get(button).dispatchEvent({ type: "click" });
    assert.equal(h.editor.value, edited, `${action} must still work on another file`);
    assert.equal(h.editor.collabPending().updates.length, 1);
    h.window.IrisCollab.flush();
    assert.equal(h.socket().of("push").at(-1).fileId, otherFileId);
    assert.equal(h.a.findFile(mainFileId).content, "  needle needle  ");
  });
}

test("the real adapter still allows authoritative loads and remote updates while read-only", options, async () => {
  const h = harness("en", true); await openShared(h);
  h.editor.setReadOnly(true);
  h.editor.loadCollab("base", "tex", { version: 7 });
  h.editor.collabReceive([{ clientID: "remote", changes: ChangeSet.of({ from: 4, insert: "!" }, 4).toJSON() }]);
  assert.equal(h.editor.value, "base!");
  assert.equal(h.editor.collabVersion(), 8);
  assert.equal(h.editor.collabPending(), null);
  assert.equal(h.editor.isReadOnly(), true);
  h.editor.load("plain", "tex");
  assert.equal(h.editor.value, "plain");
  assert.equal(h.editor.isReadOnly(), true);
});

for (const reload of ["refresh", "project load"]) {
  test(`accepted ${reload} clears transient file read-only and allows a new room`, options, async () => {
    const h = harness("en", true); await openShared(h);
    if (reload === "project load") h.edit("explicitly discarded pending text");
    h.socket().deliver({ t: "file-closed", fileId: mainFileId });
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.app.hasUnsavedChanges(), reload === "project load", "only unconfirmed text requires discard");
    const pending = reload === "refresh" ? h.a.refreshFileTree() : h.projects.openProject("p1");
    await tick();
    if (reload === "project load") {
      assert.equal(h.get("projUnsavedModal").classList.contains("on"), true);
      await h.p.finishDiscardDecision(true); await tick();
    }
    const data = sharedProject(); data.revision = 8; data.project.nodes[0].content = "accepted";
    h.requests.at(-1).reply(data); await pending;
    assert.equal(h.editor.isReadOnly(), false);
    assert.equal(h.editor.value, "accepted");
    assert.equal(h.app.serialize().revision, 8);
    assert.equal(h.p.cache.get("p1").revision, 8);
    if (reload === "project load") h.socket().fire("open");
    assert.equal(h.socket().of("open").filter((m) => m.fileId === mainFileId).length, reload === "refresh" ? 2 : 1);
    h.socket().deliver({ t: "opened", fileId: mainFileId, version: 4, doc: "accepted", role: "owner" });
    h.edit("accepted edit"); h.window.IrisCollab.flush();
    assert.equal(h.socket().of("push").at(-1).version, 4);
  });
}

test("file closure during a refresh rejects its pre-deletion tree even without pending text", options, async () => {
  const h = harness("en", true); await openShared(h);
  const pending = h.a.refreshFileTree(); await tick();
  h.socket().deliver({ t: "file-closed", fileId: mainFileId });
  h.requests.at(-1).reply({ ...sharedProject(), revision: 8 }); await pending;
  assert.equal(h.editor.isReadOnly(), true);
  assert.equal(h.editor.value, "original");
  assert.equal(h.app.serialize().revision, 4);
  assert.equal(h.p.cache.get("p1").revision, 4);
  assert.equal(h.socket().of("open").length, 1);
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("a refused reload retains file unavailability, buffer, revision and cache", options, async () => {
  const h = harness("en", true); await openShared(h);
  h.edit("keep pending text");
  h.socket().deliver({ t: "file-closed", fileId: mainFileId });
  let finishLanguage;
  h.window.IrisI18n.setLanguage = () => new Promise((resolve) => { finishLanguage = resolve; });
  const pending = h.projects.openProject("p1"); await tick();
  await h.p.finishDiscardDecision(true); await tick();
  h.requests.at(-1).reply({ ...sharedProject(), revision: 8 }); await tick();
  h.app.setName("changed during reload");
  finishLanguage(); assert.equal(await pending, false);
  assert.equal(h.editor.value, "keep pending text");
  assert.equal(h.editor.isReadOnly(), true);
  assert.equal(h.app.hasUnsavedChanges(), true);
  assert.equal(h.app.serialize().revision, 4);
  assert.equal(h.p.cache.get("p1").revision, 4);
  h.a.syncRealtimeSession();
  assert.equal(h.socket().of("open").length, 1);
});

test("open retains the queue through asynchronous editor loading", options, async () => {
  const h = harness(); h.p.cache.set("p1", projectData());
  let finishLanguage;
  h.window.IrisI18n.setLanguage = () => new Promise((resolve) => { finishLanguage = resolve; });
  const opening = h.projects.openProject("p1"); await tick();
  h.requests.at(-1).reply(projectData()); await tick();
  const renaming = h.p.renameProject("p1", "Renamed"); await tick();
  assert.equal(h.requests.length, 1, "the GET alone does not release the queue");
  finishLanguage(); await opening; await tick();
  assert.deepEqual(h.requests.at(-1).body, { name: "Renamed", baseRevision: 4 });
  const data = projectData(5); data.project.name = "Renamed";
  h.requests.at(-1).reply({ data, project: { id: "p1", name: "Renamed", revision: 5 } }); await renaming;
  assert.equal(h.app.serialize().revision, 5);
  assert.equal(h.p.cache.get("p1").revision, 5);
});

test("an open queued before logout cannot load over replacement local work", options, async () => {
  const h = harness(); await h.open(); h.edit("old save");
  const saving = h.app.persistChanges(); await tick(); const request = h.requests.at(-1);
  const opening = h.projects.openProject("p2");
  h.projects.onLogout();
  await h.app.load(projectData(20, "replacement")); h.edit("replacement local work");
  h.ack(request, 5); assert.equal(await saving, false); await tick();
  assert.equal(h.requests.length, 2, "a stale queued open must not issue a GET");
  assert.equal(await opening, false);
  assert.equal(h.editor.value, "replacement local work");
  assert.equal(h.app.hasUnsavedChanges(), true);
  assert.equal(h.app.serialize().revision, 20);
});

test("the latest queued open supersedes older opens without invalidating the preceding save", options, async () => {
  const h = harness(); await h.open(); h.edit("submitted");
  const saving = h.app.persistChanges(); await tick(); const request = h.requests.at(-1);
  const older = h.projects.openProject("p2");
  const newer = h.projects.openProject("p3");
  h.ack(request, 5); assert.equal(await saving, true); await tick();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests.at(-1).url, "/api/projects/p3");
  assert.equal(await older, false);
  h.edit("new local work");
  const data = projectData(8, "other project"); data.id = "p3";
  h.requests.at(-1).reply(data); assert.equal(await newer, false);
  assert.equal(h.projects.currentProjectId(), "p1");
  assert.equal(h.app.serialize().revision, 5);
  assert.equal(h.editor.value, "new local work");
  assert.equal(h.app.hasUnsavedChanges(), true);
});

for (const stage of ["GET", "language load"]) {
  test(`an open superseded during ${stage} never replaces the previous project even if its successor fails`, options, async () => {
    const h = harness(); await h.open();
    h.p.cache.set("p2", { ...projectData(2, "cached older work"), id: "p2" });
    const previous = clone(h.app.serialize());
    const previousCache = clone([...h.p.cache]);
    let acceptedLanguage = "en", finishLanguage;
    h.window.IrisI18n.setLanguage = (language, settings) => new Promise((resolve) => {
      const finish = () => {
        if (settings.isCurrent()) acceptedLanguage = language;
        resolve();
      };
      if (stage === "language load") finishLanguage = finish;
      else finish();
    });
    const older = h.projects.openProject("p2"); await tick(); const get = h.requests.at(-1);
    const data = { ...projectData(8, "superseded document"), id: "p2", language: "it" };
    if (stage === "language load") { get.reply(data); await tick(); }
    const newer = h.projects.openProject("p3");
    if (stage === "GET") get.reply(data);
    else finishLanguage();
    await older; await tick();
    const afterOlder = { id: h.projects.currentProjectId(), data: clone(h.app.serialize()), cache: clone([...h.p.cache]), text: h.editor.value };
    assert.equal(h.requests.at(-1).url, "/api/projects/p3");
    h.requests.at(-1).reply({ errorCode: "PROJECT_RECOVERY_REQUIRED" }, 503);
    assert.equal(await newer, false);
    assert.equal(afterOlder.id, "p1");
    assert.equal(afterOlder.text, "original");
    assert.deepEqual(afterOlder.data, previous);
    assert.deepEqual(afterOlder.cache, previousCache);
    assert.equal(h.projects.currentProjectId(), "p1");
    assert.equal(h.editor.value, "original");
    assert.deepEqual(clone(h.app.serialize()), previous);
    assert.deepEqual(clone([...h.p.cache]), previousCache);
    assert.equal(acceptedLanguage, "en", "superseded language loads must not change the interface");
  });
}
