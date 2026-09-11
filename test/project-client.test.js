const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { ChangeSet } = require("@codemirror/state");
const { CollabDocument } = require("../src/collab");

// Keep CM's installed paste handler and facets in one realm. Only DOM rendering
// is replaced below; clipboard conversion, transactions, history and OT are real.
const cmView = (() => {
  const filename = require.resolve("@codemirror/view");
  const exports = {};
  const paste = vm.compileFunction(fs.readFileSync(filename, "utf8") + "\nreturn handlers.paste;",
    ["exports", "require"], { filename })(exports, createRequire(filename));
  return { exports, paste };
})();

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

function retentionData(buildKeep = 20) {
  return {
    buildKeep: { value: buildKeep, effective: buildKeep, min: 3, max: 200, default: 20 },
    buildDays: { value: 30, effective: 30, min: 1, max: 365, default: 30 },
    versionKeep: { value: 100, effective: 100, min: 10, max: 1000, default: 100 },
    versionDays: { value: 180, effective: 180, min: 7, max: 1095, default: 180 },
  };
}

function element() {
  const classes = new Set();
  const listeners = new Map();
  const attributes = new Map();
  const slots = new Map();
  let html = "";
  return {
    children: [], dataset: {}, value: "", textContent: "",
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; this.children = []; slots.clear(); },
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; },
    },
    setAttribute(key, value) { attributes.set(key, value); }, getAttribute(key) { return attributes.get(key); }, click() { this.clicked = true; },
    removeAttribute(key) { attributes.delete(key); }, focus() {}, select() {}, remove() {},
    parentElement: { classList: { add() {}, remove() {} } },
    appendChild(child) { this.children.push(child); return child; },
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); },
    replaceChildren(...children) { this.children = children; },
    querySelector(selector) {
      if (selector === ".node-main") {
        if (!html.includes('class="node-main"')) return null;
        if (!slots.has(selector)) slots.set(selector, element());
        return slots.get(selector);
      }
      return element();
    },
    querySelectorAll(selector) { return selector === ".node[data-id]" ? this.children.filter((child) => child.dataset.id) : []; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn)); },
    dispatchEvent(event) { (listeners.get(event.type) || []).forEach((fn) => fn.call(this, event)); },
  };
}

function harness(language = "en", realtime = false) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) {
      const node = element(); node.id = id; node.focus = () => { document.activeElement = node; };
      nodes.set(id, node);
    }
    return nodes.get(id);
  };
  const document = Object.assign(element(), {
    getElementById: get, createElement: element, documentElement: element(), body: element(), querySelector: get,
    querySelectorAll(selector) {
      if (selector !== "[data-retention]") return [];
      return ["buildKeep", "buildDays", "versionKeep", "versionDays"].map((field) => {
        const input = get(`retention${field[0].toUpperCase()}${field.slice(1)}`);
        input.dataset.retention = field;
        return input;
      });
    },
  });
  const translations = JSON.parse(read(`locales/${language}/translation.json`));
  const t = (key, params = {}) => {
    const keys = params.count == null ? [key] : [`${key}_${new Intl.PluralRules(language).select(params.count)}`, key];
    const value = keys.map((key) => key.split(".").reduce((value, part) => value && value[part], translations)).find((value) => typeof value === "string");
    return String(value || key).replace(/{{(\w+)}}/g, (match, name) => params[name] ?? match);
  };
  const requests = [];
  const timers = [];
  const windowEvents = element();
  const events = [];
  const dispatch = document.dispatchEvent;
  document.dispatchEvent = (event) => { events.push(event); dispatch(event); };
  let surface = "picker";
  let change = () => {};
  let load = () => {};
  let editor = {
    value: "", revision: 0, ready: new Promise(() => {}),
    load(value) { this.value = value; this.revision++; load(); }, getValue() { return this.value; },
    snapshot() { return { text: this.value, revision: this.revision }; }, setLanguage() {}, requestMeasure() {},
    onChange(fn) { change = fn; }, onCursor() {}, onPeers() {},
    setReadOnly() {}, setWordWrap() {}, setSharedRegion() {}, setDiagnostics() {}, setCompletionContext() {}, onLoad(fn) { load = fn; }, focus() {},
  };
  const sockets = [];
  const workers = [];
  class WorkerTransport {
    constructor() { this.requests = []; workers.push(this); }
    postMessage(message) { this.requests.push(message); }
    terminate() { this.terminated = true; }
    deliver(request = this.requests.at(-1), extra = {}) {
      const { requestId, documentKey, revision, text, hint } = request;
      this.onmessage({ data: { requestId, documentKey, revision,
        result: context.window.IrisBibliography.parse(text, hint), ...extra } });
    }
  }
  const inputs = [];
  document.createElement = (tag) => {
    const node = element(); node.tagName = tag.toUpperCase(); node.focus = () => { document.activeElement = node; };
    if (tag === "input") inputs.push(node); return node;
  };
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
    console: { error() {}, warn() {} }, document, URL, URLSearchParams, performance, WebSocket: Socket, Worker: WorkerTransport, TextDecoder, Uint8Array, atob,
    FileReader: class {
      readAsText(file) { this.result = new TextDecoder().decode(file.bytes); this.onload(); }
      readAsArrayBuffer(file) { this.result = Uint8Array.from(file.bytes).buffer; this.onload(); }
      readAsDataURL(file) { this.result = `data:application/octet-stream;base64,${Buffer.from(file.bytes).toString("base64")}`; this.onload(); }
    },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; }, requestAnimationFrame() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    IrisLatex: { outline() { return []; } },
    IrisLilyPond: { outline() { return []; } },
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
        watchProject() {}, onStatus() {}, onBuild() {}, onFilePeers() {},
        filePeers: () => [], pending: () => false, paused: () => false,
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
  run("iris-diagnostics.js");
  run("iris-completion.js");
  for (const name of ["iris-bibtex.js", "iris-ris.js", "iris-bibliography.js"]) vm.runInContext(read(name), context, { filename: name });
  // Static panel slots only, not a browser emulator. Rendering assertions inspect
  // the nodes the real controller appends; layout and native behavior gate at Task 7.
  get("bibliographyPanel").querySelector = (selector) => get(selector.slice(1));
  get("bibliographyPanel").ownerDocument = document;
  vm.runInContext(read("iris-bibliography-view.js"), context, { filename: "iris-bibliography-view.js" });
  if (realtime) {
    // Run the shipping adapter and real CM extensions; only view rendering is
    // headless. Like EditorView.dispatch, this does not enforce state.readOnly.
    const viewModule = cmView.exports;
    let view;
    class HeadlessView {
      constructor({ state }) {
        this.state = state;
        this.dispatch = this.dispatch.bind(this);
        this.scrollDOM = { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, bottom: 500 }) };
        this.contentDOM = element();
        this.focusRequests = [];
        this.observer = { flush() {} };
        this.measures = 0;
        this.loads = 0;
        view = this;
      }
      setState(state) { this.state = state; this.loads++; }
      dispatch(...specs) {
        const startState = this.state;
        const tr = specs.length === 1 && specs[0].state ? specs[0] : startState.update(...specs);
        this.state = tr.state;
        for (const listener of this.state.facet(viewModule.EditorView.updateListener)) {
          listener({ startState, state: this.state, view: this, transactions: [tr], changes: tr.changes, docChanged: tr.docChanged, selectionSet: !!tr.selection });
        }
      }
      focus() {
        this.focusRequests.push({ sourceHidden: !!get("bibliographyTextPanel").hidden });
        document.activeElement = this.contentDOM;
      }
      requestMeasure() { this.measures++; }
      coordsAtPos() { return null; }
    }
    Object.setPrototypeOf(HeadlessView, viewModule.EditorView);
    let completionConfig;
    const autocomplete = require("@codemirror/autocomplete");
    context.editorModules = {
      "@codemirror/state": require("@codemirror/state"),
      "@codemirror/view": { ...viewModule, EditorView: HeadlessView },
      "@codemirror/language": require("@codemirror/language"),
      "@codemirror/commands": require("@codemirror/commands"),
      "@lezer/highlight": require("@lezer/highlight"),
      "@codemirror/collab": require("@codemirror/collab"),
      "@codemirror/autocomplete": { ...autocomplete, autocompletion(config) {
        completionConfig = config;
        return autocomplete.autocompletion(config);
      } },
    };
    // StringStream checks instanceof RegExp, so syntax runs in CM's realm.
    vm.compileFunction(read("iris-latex.js"), ["window"])(context.window);
    context.IrisLatex = context.window.IrisLatex;
    vm.compileFunction(read("iris-lilypond.js"), ["window", "IrisLatex"])(context.window, context.IrisLatex);
    context.IrisLilyPond = context.window.IrisLilyPond;
    for (const name of ["iris-bibtex.js", "iris-ris.js", "iris-bibliography.js"]) {
      vm.compileFunction(read(name), ["window"])(context.window);
    }
    run("iris-editor.js");
    editor = context.window.IrisEditor;
    Object.defineProperty(editor, "value", { get: () => editor.getValue() });
    editor.isReadOnly = () => view.state.readOnly;
    editor.pressKey = (key) => {
      const bindings = view.state.facet(viewModule.keymap).flat().filter((binding) => binding.key === key);
      assert.ok(bindings.length, `Missing editor binding: ${key}`);
      return bindings.some((binding) => binding.run(view));
    };
    editor.typeText = (text) => {
      if (view.state.readOnly) return;
      const { from, to } = view.state.selection.main;
      if (!view.state.facet(viewModule.EditorView.inputHandler).some((handler) => handler(view, from, to, text))) {
        view.dispatch(view.state.replaceSelection(text), { userEvent: "input.type" });
      }
    };
    editor.undo = () => context.editorModules["@codemirror/commands"].undo(view);
    editor.paste = (text) => cmView.paste(view, { clipboardData: { getData: () => text } });
    editor.view = () => view;
    editor.complete = () => completionConfig.override.map((source) =>
      source(new autocomplete.CompletionContext(view.state, view.state.selection.main.head, true)));
    editor.selectCarets = (positions, main = 0) => {
      const S = context.editorModules["@codemirror/state"];
      view.dispatch({
        effects: S.StateEffect.appendConfig.of(S.EditorState.allowMultipleSelections.of(true)),
      });
      view.dispatch({ selection: S.EditorSelection.create(positions.map((pos) => S.EditorSelection.cursor(pos)), main) });
    };
    editor.carets = () => view.state.selection.ranges.map((range) => range.from);
    run("iris-collab.js");
  }
  run("iris-app.js", "window.appTest = { state, findFile, wire, wireEditorEvents, openFile, syncRealtimeSession, canonicalFileId, refreshFileTree, saveProject, openFileHistory, snapshotProject, confirmRestore, verState, openTreeRename, confirmTreeRename, folderNodeByPath, docFileForCompile, openExternal, openExternalPicker, pickAttach, doUpload, openNewItem, confirmNewItem, findOpen, findSelect, activateDiagnostic, get bibliography() { return bibliographyView; } };\n");
  run("iris-projects.js", "window.projectsTest = { renameProject, cache, metaOf, finishDiscardDecision };\n");
  context.window.appTest.wireEditorEvents();
  return {
    window: context.window,
    app: context.window.IrisApp, projects: context.window.IrisProjects,
    a: context.window.appTest, p: context.window.projectsTest,
    editor, requests, events, get, timers, windowEvents, document, inputs, workers, surface: () => surface, t,
    socket: () => sockets.at(-1),
    edit(value) {
      if (realtime) editor.applyText(value);
      else { editor.value = value; editor.revision++; change(); }
    },
    setRetention(field, value) {
      const input = get(`retention${field[0].toUpperCase()}${field.slice(1)}`);
      input.value = value;
      input.dispatchEvent({ type: "change" });
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

function diagnosticBuild(diagnostics, overrides = {}) {
  return { build: {
    id: "build-1", status: "failed", mainPath: "main.tex", format: "pdf", durationMs: 100,
    completedAt: 1000, log: "compiler raw output", diagnostics,
    errors: diagnostics.filter((d) => d.severity === "error").map((d) => d.message),
    warnings: diagnostics.filter((d) => d.severity === "warning").map((d) => d.message),
    ...overrides,
  }, artifacts: [] };
}

function diagnosticRows(h) { return h.get("diagnosticsList").children; }

function bibliographyData(text = "@book{a,title={A},xcustom={hidden needle}}", kind = "bib") {
  const data = projectData();
  Object.assign(data.project.nodes[0], { path: `refs.${kind}`, name: `refs.${kind}`, kind, content: text });
  return data;
}
function descendants(node) { return node.children.flatMap((child) => [child, ...descendants(child)]); }
function bibColumns(h) { return descendants(h.get("bibliographyColumns")).filter((node) => node.type === "checkbox"); }
function bibRows(h) { return h.get("bibliographyRows").children; }
function parseBibliography(h) {
  assert.ok(h.workers.length, "bibliographic app loads must dispatch the real controller's Worker");
  h.workers.at(-1).deliver();
}
function flushBibliography(h) {
  const timer = h.timers.findLast((timer) => timer.delay === 150 && !timer.cleared && !timer.ran);
  assert.ok(timer, "edits must schedule a 150 ms quiet-period parse");
  timer.ran = true; timer.fn(); parseBibliography(h);
}

for (const input of ["typing", "paste"]) {
  test(`bibliography first recognition by ${input} keeps source visible and debounces validation`, options, async () => {
    const h = harness("en", true); await h.open(bibliographyData("", "txt"));
    const ed = h.editor, view = ed.view(), loads = view.loads;
    ed.focus();
    if (input === "typing") ed.typeText("@");
    else ed.paste("@book{a,title={Pasted}}");
    assert.equal(h.get("bibliographyTextPanel").hidden, false, "recognition during input must not hide CodeMirror");
    assert.equal(h.document.activeElement, ed.focusTarget());
    assert.equal(h.workers.length, 0, "first recognition is an edit, not an immediate file-open parse");
    assert.equal(h.a.bibliography.context(), null);
    const before = ed.snapshot(), selection = ed.selection(), doc = view.state.doc;
    flushBibliography(h);
    assert.equal(h.a.bibliography.context().parsed.status, input === "typing" ? "invalid" : "valid");
    assert.equal(h.get("bibliographyTextPanel").hidden, false);
    assert.equal(h.document.activeElement, ed.focusTarget());
    assert.deepEqual(ed.snapshot(), before); assert.deepEqual(ed.selection(), selection);
    assert.equal(view.state.doc, doc); assert.equal(view.loads, loads);
    if (input === "typing") {
      ed.typeText("book{a,title={Corrected}}");
      const corrected = ed.snapshot();
      assert.equal(h.a.bibliography.context(), null);
      assert.equal(h.get("bibliographyTextPanel").hidden, false);
      flushBibliography(h);
      assert.equal(h.a.bibliography.context().parsed.status, "valid");
      assert.deepEqual(ed.snapshot(), corrected);
      assert.equal(h.get("bibliographyTextPanel").hidden, false, "a correction only enables the table");
      assert.equal(h.document.activeElement, ed.focusTarget());
    }
    assert.equal(h.get("bibliographyTableTab").getAttribute("aria-disabled"), "false");
    assert.equal(view.loads, loads);
  });
}

test("bibliography opening focuses the visible table for project and file activation", options, async () => {
  const h = harness("en", true), data = bibliographyData();
  data.project.nodes.push({ type: "file", id: "plain", kind: "tex", path: "plain.tex", name: "plain.tex", content: "Plain text" });
  await h.open(data);
  const ed = h.editor, view = ed.view(), snapshot = ed.snapshot(), loads = view.loads;
  assert.equal(view.focusRequests.length, 0, "opening must not request focus on the hidden editor");
  assert.equal(h.document.activeElement, h.get("bibliographyTableTab"));
  assert.equal(h.get("bibliographyTextPanel").hidden, true);
  parseBibliography(h);
  assert.equal(h.document.activeElement, h.get("bibliographyTableTab"));
  assert.equal(view.loads, loads); assert.deepEqual(ed.snapshot(), snapshot);
  h.a.openFile("plain");
  assert.equal(h.document.activeElement, ed.focusTarget());
  assert.equal(view.focusRequests.at(-1).sourceHidden, false);
  view.focusRequests.length = 0;
  h.a.openFile("main");
  assert.equal(view.focusRequests.length, 0);
  assert.equal(h.document.activeElement, h.get("bibliographyTableTab"));
});

test("bibliography delayed project opening focuses the visible mode instead of CodeMirror", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData());
  const deferred = h.timers.findLast((timer) => timer.delay === 0);
  const tab = h.get("bibliographyTableTab"); tab.focus();
  h.editor.view().focusRequests.length = 0;
  deferred.fn();
  assert.equal(h.editor.view().focusRequests.length, 0, "the projects-layer callback must route through the visible document mode");
  assert.equal(h.document.activeElement, tab);
});

test("bibliography delayed project focus preserves a user's newer focus target", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData());
  const deferred = h.timers.findLast((timer) => timer.delay === 0);
  h.get("btnSettings").focus();
  h.editor.view().focusRequests.length = 0;
  deferred.fn();
  assert.equal(h.document.activeElement, h.get("btnSettings"));
  assert.equal(h.editor.view().focusRequests.length, 0);
});

test("bibliography delayed project focus ignores a superseded project generation", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData());
  const deferred = h.timers.findLast((timer) => timer.delay === 0);
  const next = bibliographyData(); next.id = "p2"; await h.open(next);
  const tab = h.get("bibliographyTableTab"), focus = tab.focus;
  let tableFocuses = 0; tab.focus = () => { tableFocuses++; focus(); };
  h.editor.view().focusRequests.length = 0;
  deferred.fn();
  assert.equal(tableFocuses, 0, "even the same reused tab element must not accept old opening work");
  assert.equal(h.editor.view().focusRequests.length, 0);
});

for (const target of ["bibliographyTableTab", "bibliographyQuery", "btnSettings"]) {
  test(`bibliography initial invalid result transfers only displaced focus: ${target}`, options, async () => {
    const h = harness("en", true); await h.open(bibliographyData("@book a"));
    // Only the static containment needed by this assertion, not DOM emulation.
    h.get("bibliographyTablePanel").appendChild(h.get("bibliographyQuery"));
    h.get(target).focus(); h.editor.view().focusRequests.length = 0;
    const before = h.editor.snapshot(), loads = h.editor.view().loads;
    parseBibliography(h);
    assert.equal(h.get("bibliographyTextPanel").hidden, false);
    assert.deepEqual(h.editor.snapshot(), before); assert.equal(h.editor.view().loads, loads);
    if (target === "btnSettings") {
      assert.equal(h.document.activeElement, h.get(target));
      assert.equal(h.editor.view().focusRequests.length, 0);
    } else {
      assert.equal(h.document.activeElement, h.editor.focusTarget(), "validation must focus the source it revealed");
      assert.deepEqual(h.editor.view().focusRequests, [{ sourceHidden: false }]);
    }
  });
}

test("ordinary text retains editor focus in the delayed project opening callback", options, async () => {
  const h = harness("en", true); await h.open(projectData());
  h.editor.view().focusRequests.length = 0;
  h.timers.findLast((timer) => timer.delay === 0).fn();
  assert.equal(h.document.activeElement, h.editor.focusTarget());
  assert.deepEqual(h.editor.view().focusRequests, [{ sourceHidden: false }]);
});

test("bibliography view changes preserve the real editor document, selection, scroll, history and persistence", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData()); parseBibliography(h);
  const controller = h.a.bibliography, ed = h.editor, view = ed.view();
  assert.equal(controller.context().parsed.status, "valid");
  assert.equal(h.get("bibliographyTablePanel").hidden, false);
  controller.setMode("text");
  ed.replaceRange(ed.getValue().length, ed.getValue().length, "\n% local");
  flushBibliography(h);
  assert.equal(h.get("bibliographyTextPanel").hidden, false, "correction must not steal the source view");
  ed.select(8, 9); view.scrollDOM.scrollTop = 110; view.scrollDOM.scrollLeft = 18;
  const before = ed.snapshot(), selection = ed.selection(), doc = view.state.doc, loads = view.loads;
  const saved = clone(h.app.capturePersistence().data), dirty = [...h.a.state.dirtyFiles], requests = h.requests.length;
  const pending = ed.collabPending(), measures = view.measures;
  controller.setColumnVisible("bib:xcustom", false); controller.setQuery("needle");
  controller.setSort({ id: "bib:title", descending: true }); controller.setPage(1);
  controller.setMode("table"); controller.setMode("text");
  assert.deepEqual(ed.snapshot(), before); assert.deepEqual(ed.selection(), selection);
  assert.equal(view.state.doc, doc); assert.equal(view.loads, loads);
  assert.equal(view.scrollDOM.scrollTop, 110); assert.equal(view.scrollDOM.scrollLeft, 18);
  assert.ok(view.measures > measures);
  assert.deepEqual(clone(h.app.capturePersistence().data), saved);
  assert.deepEqual([...h.a.state.dirtyFiles], dirty); assert.equal(h.requests.length, requests);
  assert.deepEqual(ed.collabPending(), pending);
  assert.equal(ed.undo(), true); assert.equal(ed.getValue(), bibliographyData().project.nodes[0].content);
});

test("bibliography correlates reverse replies with file, revision and request generation, including reactivation", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData());
  assert.ok(h.workers.length, "file activation must start parsing immediately");
  const oldWorker = h.workers[0], oldRequest = oldWorker.requests[0];
  h.edit("@book{b,title={Current}}");
  assert.equal(h.a.bibliography.context(), null); assert.equal(bibRows(h).length, 0);
  flushBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.entries[0].key, "b");
  oldWorker.deliver(oldRequest);
  assert.equal(h.a.bibliography.context().parsed.entries[0].key, "b");
  const currentWorker = h.workers.at(-1), request = currentWorker.requests.at(-1);
  currentWorker.deliver(request, { requestId: request.requestId - 1, result: h.window.IrisBibliography.parse(oldRequest.text, "bib") });
  assert.equal(h.a.bibliography.context().parsed.entries[0].key, "b");
  currentWorker.deliver(request, { documentKey: "another-project" });
  assert.equal(h.a.bibliography.context().parsed.entries[0].key, "b");
  h.a.bibliography.deactivate();
  h.a.bibliography.activate({ documentKey: request.documentKey, hint: "bib" });
  currentWorker.deliver(request);
  assert.equal(h.a.bibliography.context(), null, "same file and revision in a new activation is still a different generation");
  parseBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.entries[0].key, "b");
  assert.equal(oldWorker.terminated, true);
});

test("bibliography uses the full-file column union, 100-row pages, hidden search and stable exclusions", options, async () => {
  const text = Array.from({ length: 101 }, (_, i) => `@book{k${i},title={Title ${i}}${i === 100 ? ",custom={needle},journal={Out of type}" : ""}}`).join("\n");
  const h = harness("en", true); await h.open(bibliographyData(text)); parseBibliography(h);
  const controller = h.a.bibliography;
  assert.equal(bibRows(h).length, 100);
  assert.equal(h.get("bibliographyDiagnostics").children.length, 200, "only the current page's metadata warnings are mounted");
  assert.ok(h.get("bibliographyTotal").textContent.includes("101"));
  const initialColumns = bibColumns(h);
  assert.deepEqual(initialColumns.map((node) => node.dataset.columnId), ["key", "type", "bib:title", "bib:journal", "bib:custom"]);
  assert.ok(initialColumns.every((node) => node.checked));
  const custom = initialColumns.at(-1); custom.focus(); custom.checked = false; custom.dispatchEvent({ type: "change" });
  assert.equal(h.document.activeElement, custom); assert.ok(bibColumns(h).includes(custom));
  h.get("bibliographyQuery").value = "needle"; h.get("bibliographyQuery").dispatchEvent({ type: "input" });
  assert.equal(bibRows(h).length, 1);
  assert.equal(bibRows(h)[0].dataset.entryIndex, "100");
  assert.deepEqual(bibColumns(h), initialColumns);
  controller.setQuery("not found"); assert.equal(bibRows(h).length, 0);
  assert.equal(h.get("bibliographyState").textContent, h.t("bibliography.noResults"));
  controller.setQuery(""); h.get("bibliographyNext").dispatchEvent({ type: "click" }); assert.equal(bibRows(h).length, 1);
  assert.equal(h.get("bibliographyDiagnostics").children.length, 2);
  controller.setSort({ id: "bib:title", descending: true });
  for (const column of initialColumns) controller.setColumnVisible(column.dataset.columnId, false);
  assert.equal(bibRows(h).length, 0);
  assert.equal(h.get("bibliographyState").textContent, h.t("bibliography.allHidden"));
  assert.equal(h.get("bibliographyShowAll").disabled, false);
  h.edit(text + "\n@misc{new,newfield={Visible}}"); flushBibliography(h);
  assert.deepEqual(bibColumns(h).filter((node) => node.checked).map((node) => node.dataset.columnId), ["bib:newfield"]);
  h.edit("@misc{only,newfield={Alone}}"); flushBibliography(h);
  h.edit(text); flushBibliography(h);
  assert.equal(bibColumns(h).find((node) => node.dataset.columnId === "bib:custom").checked, false, "disappearance must not erase an exclusion");
  h.get("bibliographyShowAll").dispatchEvent({ type: "click" }); assert.ok(bibColumns(h).every((node) => node.checked));
  controller.setPage(0); assert.equal(bibRows(h)[0].dataset.entryIndex, "0", "hiding the sorted column restores source order");
});

test("bibliography renders inert full values, native RIS labels and associated metadata warnings", options, async () => {
  const value = '<img src=x onerror="alert(1)">' + " long".repeat(100);
  const h = harness("en", true); await h.open(bibliographyData(`TY  - CONF\nT2  - Native\nZZ  - ${value}\nER  -`, "ris")); parseBibliography(h);
  const controller = h.a.bibliography;
  assert.equal(controller.context().parsed.status, "valid");
  const labels = descendants(h.get("bibliographyColumns")).filter((node) => node.tagName === "SPAN").map((node) => node.textContent);
  assert.ok(labels.includes("T2")); assert.ok(labels.includes("ZZ"));
  const nodes = descendants(h.get("bibliographyRows"));
  assert.ok(nodes.some((node) => node.tagName === "DETAILS"));
  assert.ok(nodes.some((node) => node.className === "bibliography-value-preview" && node.textContent.startsWith('<img src=x onerror="alert(1)">')), "long populated fields have a visible preview before expansion");
  assert.ok(nodes.some((node) => node.textContent === value));
  assert.ok(nodes.every((node) => !node.innerHTML));
  assert.equal(h.get("bibliographyDiagnostics").children.length, 3);
  assert.equal(h.get("bibliographyDiagnostics").children[0].dataset.entryIndex, "0");
  const warning = descendants(h.get("bibliographyDiagnostics")).find((node) => node.tagName === "BUTTON");
  warning.dispatchEvent({ type: "click" });
  assert.equal(h.get("bibliographyTextPanel").hidden, false);
  assert.equal(h.editor.selection().text, "CONF");
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("bibliography invalid remote updates clear stale rows, while load, empty and Worker failure remain distinct", options, async () => {
  const h = harness("en", true), data = bibliographyData(); data.project.nodes[0].id = mainFileId;
  data.activeId = mainFileId; data.openTabs = [mainFileId]; await h.open(data);
  h.socket().fire("open");
  const source = data.project.nodes[0].content;
  h.socket().deliver({ t: "opened", fileId: mainFileId, version: 0, doc: source, role: "owner" });
  flushBibliography(h);
  const socket = h.socket(), sent = socket.sent.length, loads = h.editor.view().loads;
  h.a.bibliography.setMode("text"); h.a.bibliography.setMode("table");
  h.a.bibliography.setQuery("A"); h.a.bibliography.showAllColumns();
  assert.equal(socket.sent.length, sent); assert.equal(h.editor.view().loads, loads);
  socket.deliver({ t: "updates", fileId: mainFileId, version: 1, updates: [
    { clientID: "peer", changes: ChangeSet.of({ from: source.length - 1, to: source.length }, source.length).toJSON() },
  ] });
  assert.equal(h.a.bibliography.context(), null); assert.equal(bibRows(h).length, 0);
  flushBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.status, "invalid");
  assert.equal(bibRows(h).length, 0);
  assert.equal(h.get("bibliographyTableTab").getAttribute("aria-disabled"), "true");
  assert.equal(h.app.hasUnsavedChanges(), false); assert.equal(socket.of("push").length, 0);
  h.a.bibliography.setMode("text");
  socket.deliver({ t: "resync", fileId: mainFileId, version: 2, doc: "" }); flushBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.status, "empty");
  assert.equal(h.get("bibliographyTextPanel").hidden, false);
  h.a.bibliography.setMode("table");
  assert.equal(h.get("bibliographyState").textContent, h.t("bibliography.empty"));
  h.editor.load("@book{a,title={New}}", "bib");
  const timer = h.timers.findLast((timer) => timer.delay === 150 && !timer.cleared); timer.fn();
  h.workers.at(-1).onerror({ preventDefault() {} });
  assert.equal(h.a.bibliography.context(), null);
  assert.equal(h.get("bibliographyStatus").textContent, h.t("bibliography.parseFailed"));
  h.get("bibliographySource").dispatchEvent({ type: "click" });
  assert.equal(h.get("bibliographyTextPanel").hidden, false);
  assert.equal(h.editor.getValue(), "@book{a,title={New}}");
});

test("bibliography source search and compiler diagnostics reveal the source before selecting offsets", options, async () => {
  const source = "@book{a,\n title={Needle}\n}";
  const h = harness("en", true); await h.open(bibliographyData(source)); parseBibliography(h);
  h.get("findInput").value = "Needle"; h.a.findOpen(false);
  assert.equal(h.get("bibliographyTextPanel").hidden, false); assert.equal(h.editor.selection().text, "Needle");
  // Native input focus is modeled narrowly here; no synthetic keyboard engine.
  let editorFocuses = 0;
  h.editor.focus = () => { editorFocuses++; };
  h.get("findInput").focus(); h.a.findSelect();
  assert.equal(editorFocuses, 0, "finding the next match must not take focus away from the search input");
  h.a.bibliography.setMode("table");
  h.a.activateDiagnostic({ file: "refs.bib", line: 2 });
  assert.equal(h.get("bibliographyTextPanel").hidden, false); assert.equal(h.editor.selection().text, " title={Needle}");
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("bibliography deactivates on non-source surfaces and preserves content recognition after deleting the last entry", options, async () => {
  const h = harness("en", true), data = bibliographyData("@book{a,title={A}}", "txt");
  data.project.nodes.push(...["sty", "cls", "img", "bin", "ris"].map((kind) => ({ type: "file", id: kind,
    kind, name: `file.${kind}`, path: `file.${kind}`, content: "@book{a,title={Not a bibliography surface}}",
    ...(kind === "ris" ? { sourceError: "BIBLIOGRAPHY_INVALID_ENCODING" } : {}) })));
  await h.open(data); parseBibliography(h);
  h.edit(""); flushBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.status, "empty");
  for (const id of ["sty", "cls", "bin", "ris", "img"]) {
    const count = h.workers.reduce((n, worker) => n + worker.requests.length, 0);
    h.a.openFile(id);
    assert.equal(h.a.bibliography.context(), null, id);
    assert.equal(h.get("bibliographyPanel").hidden, true, id);
    assert.equal(h.workers.reduce((n, worker) => n + worker.requests.length, 0), count, id);
  }
});

test("bibliography keeps exclusions across canonical assignment, rename and same-project reload without cross-project collisions", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData()); parseBibliography(h);
  const local = h.a.findFile("main"), originalKey = h.a.bibliography.context().documentKey;
  h.a.bibliography.setColumnVisible("bib:title", false);
  h.edit("@book{a,title={Saved},custom={Fresh}}"); flushBibliography(h);
  const saving = h.a.saveProject(); await tick();
  const put = h.requests.at(-1), reconciled = clone(put.body.data);
  reconciled.project.nodes[0].id = mainFileId; reconciled.revision = 5;
  put.reply({ project: { id: "p1", revision: 5 }, data: reconciled, revision: 5 }); await saving;
  assert.equal(h.a.canonicalFileId(local.id), mainFileId);
  // Rekey may invalidate an in-flight parse but never reloads the editor itself.
  if (!h.a.bibliography.context()) parseBibliography(h);
  const canonicalKey = h.a.bibliography.context().documentKey;
  assert.notEqual(canonicalKey, originalKey);
  assert.equal(bibColumns(h).find((node) => node.dataset.columnId === "bib:title").checked, false);
  h.a.openTreeRename(local, h.a.folderNodeByPath("").nodes, "");
  h.get("treeRenameInput").value = "renamed.bib"; h.a.confirmTreeRename(); await tick();
  const rename = h.requests.at(-1); h.ack(rename, 6); await tick();
  h.a.openFile(local.id); flushBibliography(h);
  assert.equal(h.a.bibliography.context().documentKey, canonicalKey);
  assert.equal(bibColumns(h).find((node) => node.dataset.columnId === "bib:title").checked, false);
  const accepted = bibliographyData(); accepted.project.nodes[0].id = mainFileId;
  accepted.activeId = mainFileId; accepted.openTabs = [mainFileId]; accepted.revision = 7;
  await h.open(accepted); parseBibliography(h);
  assert.equal(bibColumns(h).find((node) => node.dataset.columnId === "bib:title").checked, false);
  const other = bibliographyData(); other.id = "p2";
  await h.open(other); parseBibliography(h);
  assert.ok(bibColumns(h).every((node) => node.checked));
  assert.equal(h.a.canonicalFileId("main"), null, "a replacement project's local ID must not resolve through the previous project's cache");
});

test("bibliography keyboard tabs and relocalization retain query, checkbox focus and source selection", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData()); parseBibliography(h);
  const controller = h.a.bibliography;
  controller.setQuery("needle"); controller.setColumnVisible("bib:xcustom", false);
  h.editor.select(8, 9); const selection = h.editor.selection(), snapshot = h.editor.snapshot();
  const input = bibColumns(h).at(-1); input.focus();
  const it = JSON.parse(read("locales/it/translation.json"));
  h.window.IrisI18n.t = (key, params = {}) => String(key.split(".").reduce((v, part) => v?.[part], it) || key)
    .replace(/{{(\w+)}}/g, (match, name) => params[name] ?? match);
  h.document.dispatchEvent({ type: "iris:languagechange" });
  assert.equal(h.get("bibliographyTableTab").textContent, "Tabella");
  assert.equal(h.get("bibliographyQuery").value, "needle");
  assert.equal(h.document.activeElement, input); assert.equal(input.checked, false);
  assert.deepEqual(h.editor.snapshot(), snapshot); assert.deepEqual(h.editor.selection(), selection);
  h.get("bibliographyTabs").dispatchEvent({ type: "keydown", target: h.get("bibliographyTableTab"), key: "ArrowRight", preventDefault() {} });
  assert.equal(h.get("bibliographyTextTab").getAttribute("aria-selected"), "true");
  assert.equal(h.document.activeElement, h.get("bibliographyTextTab"));
  h.get("bibliographyTabs").dispatchEvent({ type: "keydown", target: h.get("bibliographyTextTab"), key: "Home", preventDefault() {} });
  assert.equal(h.get("bibliographyTableTab").getAttribute("aria-selected"), "true");
  assert.equal(h.get("bibliographyTableTab").tabIndex, 0); assert.equal(h.get("bibliographyTextTab").tabIndex, -1);
  controller.dispose();
  assert.equal(controller.context(), null); assert.equal(h.get("bibliographyPanel").hidden, true);
});

test("bibliography remembers a content-recognized format when an emptied generic file is reopened", options, async () => {
  const h = harness("en", true), data = bibliographyData("TY  - BOOK\nTI  - Title\nER  -", "txt");
  data.project.nodes.push({ type: "file", id: "other", kind: "tex", path: "other.tex", name: "other.tex", content: "Plain text" });
  await h.open(data); parseBibliography(h); h.edit(""); flushBibliography(h);
  h.a.openFile("other"); h.a.openFile("main");
  assert.equal(h.get("bibliographyPanel").hidden, false);
  parseBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.status, "empty");
  assert.equal(h.a.bibliography.context().parsed.format, "ris");
});

for (const format of ["bib", "ris"]) for (const transition of ["file", "reload", "refresh", "rejoin"]) {
  test(`remembered ${format} policy precedes generic ${transition} state creation`, options, async () => {
    const source = format === "bib" ? "@book{a,title={A}}\r\n" : "TY  - BOOK\r\nTI  - A\r\nER  -\r\n";
    const retained = "% retained\r\n% astral\u{1f600}\r% bare\r\n";
    const h = harness("en", true), data = bibliographyData(source, "txt");
    const id = "019f9910-0000-7000-8000-000000000009";
    data.project.nodes[0].id = id; data.activeId = id; data.openTabs = [id];
    data.project.nodes.push({ type: "file", id: "other", kind: "tex", path: "other.tex", name: "other.tex", content: "Plain text" });
    await h.open(data); parseBibliography(h); h.edit(retained); flushBibliography(h);
    assert.equal(h.editor.getValue(), retained);
    h.app.acknowledgePersistence(h.app.capturePersistence(), 5);
    const refreshed = clone(data); refreshed.revision = 5; refreshed.project.nodes[0].content = retained;
    if (transition === "reload") await h.app.load(refreshed);
    else if (transition === "refresh") {
      const pending = h.a.refreshFileTree(); await tick(); h.requests.at(-1).reply(refreshed); await pending;
    } else {
      h.a.openFile("other"); h.a.openFile(id);
      if (transition === "rejoin") {
        h.socket().fire("open");
        h.socket().deliver({ t: "opened", fileId: id, role: "owner", version: 7, doc: retained });
        assert.equal(h.editor.collabVersion(), 7);
      }
    }
    assert.equal(h.editor.getValue(), retained);
    assert.equal(h.a.findFile(id).kind, "txt");
    assert.equal(h.get("bibliographyPanel").hidden, false);
    h.edit(retained + " ");
    const saved = h.app.capturePersistence().data;
    assert.equal(saved.project.nodes[0].content, retained + " ");
    assert.equal(saved.project.nodes[0].kind, "txt");
    assert.equal(JSON.stringify(saved).includes("bibliographyHint"), false);
  });
}

test("bibliography header sorting retains keyboard focus and source buttons select the full entry", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData("@book{z,title={Z}}\n@book{a,title={A}}")); parseBibliography(h);
  const titleSort = () => descendants(h.get("bibliographyHead")).find((node) => node.dataset.sortId === "bib:title");
  titleSort().focus(); titleSort().dispatchEvent({ type: "click" });
  assert.equal(h.document.activeElement, titleSort());
  assert.deepEqual(bibRows(h).map((row) => row.dataset.entryIndex), ["1", "0"]);
  titleSort().dispatchEvent({ type: "click" });
  assert.deepEqual(bibRows(h).map((row) => row.dataset.entryIndex), ["0", "1"]);
  const source = descendants(bibRows(h)[1]).find((node) => node.tagName === "BUTTON");
  source.dispatchEvent({ type: "click" });
  assert.equal(h.editor.selection().text, "@book{a,title={A}}");
  assert.equal(h.get("bibliographyTextPanel").hidden, false);
  assert.equal(h.app.hasUnsavedChanges(), false);
});

test("bibliography initial invalidity reveals source before measuring and corrections do not switch back", options, async () => {
  const h = harness("it", true); await h.open(bibliographyData("@book a"));
  const measuredWhileHidden = [], measure = h.editor.requestMeasure;
  h.editor.requestMeasure = () => { measuredWhileHidden.push(h.get("bibliographyTextPanel").hidden); measure(); };
  parseBibliography(h);
  assert.equal(h.get("bibliographyTextPanel").hidden, false);
  assert.equal(measuredWhileHidden.at(-1), false);
  const message = descendants(h.get("bibliographyDiagnostics")).find((node) => node.tagName === "BUTTON").textContent;
  assert.ok(message.includes("{ oppure ("));
  h.edit("@book{a,title={Fixed}}"); flushBibliography(h);
  assert.equal(h.get("bibliographyTextPanel").hidden, false);
  assert.equal(h.get("bibliographyTableTab").getAttribute("aria-disabled"), "false");
});

test("bibliography coalesces rapid edits, ignores obsolete technical failures and supports retry without losing source", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData());
  const obsolete = h.workers[0];
  for (let i = 0; i < 20; i++) h.edit(`@book{k${i},title={Latest}}`);
  assert.equal(h.workers.length, 1);
  assert.equal(h.timers.filter((timer) => timer.delay === 150 && !timer.cleared).length, 1);
  flushBibliography(h);
  obsolete.onerror({ preventDefault() {} }); obsolete.deliver(undefined, { error: "BIBLIOGRAPHY_PARSE_FAILED" });
  assert.equal(h.a.bibliography.context().parsed.entries[0].key, "k19");
  const current = h.workers.at(-1);
  current.postMessage = () => { throw new Error("transport failure"); };
  h.edit("@book{new,title={Recover}}");
  h.timers.findLast((timer) => timer.delay === 150 && !timer.cleared).fn();
  assert.equal(h.a.bibliography.context(), null);
  assert.equal(h.get("bibliographyStatus").textContent, h.t("bibliography.parseFailed"));
  h.get("bibliographySource").dispatchEvent({ type: "click" });
  h.get("bibliographyRetry").dispatchEvent({ type: "click" }); parseBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.entries[0].key, "new");
  assert.equal(h.get("bibliographyTextPanel").hidden, false);
});

test("bibliography stays usable when project replacement is refused, then deactivates on close", options, async () => {
  const h = harness("en", true); await h.open(bibliographyData()); parseBibliography(h);
  h.a.bibliography.setQuery("needle"); h.a.bibliography.setColumnVisible("bib:title", false);
  const before = h.editor.snapshot(), key = h.a.bibliography.context().documentKey;
  const opening = h.projects.openProject("p2"); await tick();
  h.requests.at(-1).reply({ code: "SERVER_ERROR" }, 500); await opening;
  assert.equal(h.get("bibliographyPanel").hidden, false);
  assert.equal(h.a.bibliography.context().documentKey, key);
  assert.equal(h.get("bibliographyQuery").value, "needle");
  assert.deepEqual(h.editor.snapshot(), before);
  const closing = h.projects.closeCurrent(); await tick(); h.requests.at(-1).reply({ projects: [] }); await closing;
  assert.equal(h.a.bibliography.context(), null); assert.equal(h.get("bibliographyPanel").hidden, true);
});

test("bibliography recognizes ordinary hydrated text, but excludes bibliography styles and binary data", options, async () => {
  const h = harness("en", true), data = bibliographyData("@book{a,title={In a text file}}", "md");
  data.project.nodes[0].kind = "file"; data.project.nodes[0].encoding = "utf8";
  const styles = ["bst", "bbx", "cbx", "lbx"];
  data.project.nodes.push(...styles.map((ext) => ({ type: "file", id: ext, name: `style.${ext}`, path: `style.${ext}`,
    kind: "tex", content: "@book{a,title={A style comment}}" })));
  data.project.nodes.push({ type: "file", id: "binary", kind: "file", name: "binary.dat", path: "binary.dat",
    encoding: "base64", data: "data:application/octet-stream;base64,AA==" });
  await h.open(data); parseBibliography(h);
  assert.equal(h.a.bibliography.context().parsed.status, "valid");
  for (const id of [...styles, "binary"]) {
    h.a.openFile(id); assert.equal(h.get("bibliographyPanel").hidden, true, id);
  }
});

test("bibliography image preview stays deactivated when the retained editor receives remote text", options, async () => {
  const h = harness("en", true), data = bibliographyData();
  data.project.nodes.push({ type: "file", id: "image", kind: "img", name: "image.png", path: "image.png" });
  await h.open(data); parseBibliography(h);
  h.a.openFile("image");
  const count = h.workers.reduce((n, worker) => n + worker.requests.length, 0);
  h.editor.loadCollab("@book{peer,title={Remote}}", "bib", { version: 8 });
  assert.equal(h.get("bibliographyPanel").hidden, true);
  assert.equal(h.workers.reduce((n, worker) => n + worker.requests.length, 0), count);
  h.a.openFile("main"); parseBibliography(h);
  assert.equal(h.get("bibliographyPanel").hidden, false);
});

test("bibliography remains read-only for viewers while its full table and source stay readable", options, async () => {
  const h = harness("en", true), data = bibliographyData(); data.role = "viewer";
  await h.open(data); parseBibliography(h);
  const snapshot = h.editor.snapshot(), saved = clone(h.app.serialize());
  h.a.bibliography.setQuery("needle"); h.a.bibliography.setColumnVisible("bib:xcustom", false);
  h.a.bibliography.setMode("text"); h.editor.typeText("blocked"); h.a.bibliography.setMode("table");
  assert.equal(h.editor.isReadOnly(), true); assert.deepEqual(h.editor.snapshot(), snapshot);
  assert.deepEqual(clone(h.app.serialize()), saved); assert.equal(h.app.hasUnsavedChanges(), false);
  assert.equal(bibRows(h).length, 1);
  assert.ok(descendants(h.get("bibliographyRows")).filter((node) => node.tagName === "BUTTON")
    .every((node) => node.textContent === h.t("bibliography.showSource")), "phase 1 exposes reading, not CRUD controls");
});

test("bibliography retains the current page through a pending revision and clamps only against the new result", options, async () => {
  const text = Array.from({ length: 101 }, (_, i) => `@book{k${i},title={A}}`).join("\n");
  const h = harness("en", true); await h.open(bibliographyData(text)); parseBibliography(h);
  h.a.bibliography.setPage(1);
  h.edit(text + "\n@book{new,title={B}}");
  assert.equal(bibRows(h).length, 0); assert.equal(h.get("bibliographyPrevious").disabled, true);
  flushBibliography(h);
  assert.deepEqual(bibRows(h).map((row) => row.dataset.entryIndex), ["100", "101"]);
  h.edit("@book{one,title={Only}}"); flushBibliography(h);
  assert.equal(bibRows(h)[0].dataset.entryIndex, "0");
});

for (const [text, kind, status, stateKey] of [[" \r\n", "ris", "empty", "empty"],
  ['@string{month="Jan"}', "bib", "empty", "noReferences"], ["<html>foreign</html>", "bib", "unrecognized", null]]) {
  test(`bibliography distinguishes ${stateKey || status} without inventing rows`, options, async () => {
    const h = harness("en", true); await h.open(bibliographyData(text, kind)); parseBibliography(h);
    assert.equal(h.a.bibliography.context().parsed.status, status);
    assert.equal(bibRows(h).length, 0); assert.equal(h.editor.getValue(), text);
    if (stateKey) assert.equal(h.get("bibliographyState").textContent, h.t(`bibliography.${stateKey}`));
    else {
      assert.equal(h.get("bibliographyStatus").textContent, h.t("bibliography.unrecognized"));
      assert.equal(h.get("bibliographyTextPanel").hidden, false);
    }
  });
}

test("bibliography lexer changes preserve text, history, selection and revision", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  const ed = h.editor;
  assert.equal(typeof ed.snapshot, "function");
  assert.equal(typeof ed.setLanguage, "function");
  assert.equal(typeof ed.requestMeasure, "function");
  let changes = 0, loads = 0;
  ed.onChange((payload) => { assert.equal(payload, undefined); changes++; });
  ed.onLoad((payload) => { assert.equal(payload, undefined); loads++; });
  const source = "@book{a,\r\n title={A}\r\n}\r\n";
  ed.load(source, "bib");
  const before = ed.snapshot();
  assert.equal(before.text, source);
  ed.replaceRange(source.length, source.length, "% local\r\n");
  ed.select(10, 13);
  const edited = ed.snapshot(), selection = ed.selection();
  const view = ed.view(), doc = view.state.doc, loadCount = view.loads;
  for (const kind of ["ris", "tex", null, "bib"]) {
    ed.setLanguage(kind);
    ed.requestMeasure();
    ed.setWordWrap(true);
    assert.deepEqual(ed.snapshot(), edited);
    assert.deepEqual(ed.selection(), selection);
    assert.equal(view.state.doc, doc);
    assert.equal(view.loads, loadCount, "language/view changes must not rebuild EditorState");
  }
  assert.ok(view.measures >= 4);
  assert.ok(edited.revision > before.revision);
  assert.equal(ed.undo(), true);
  assert.equal(ed.getValue(), source);
  assert.ok(ed.snapshot().revision > edited.revision);
  const undone = ed.snapshot();
  ed.load(source, "bib");
  assert.ok(ed.snapshot().revision > undone.revision, "even identical reloads invalidate snapshots");
  assert.equal(changes, 2);
  assert.equal(loads, 2);
});

for (const [kind, sources, tokens] of [
  ["bib", ["% note\r@book{k,title={A\u{1f600}}}", "% note\r@book{k,\r\n title={A\u{1f600}}\n}\r"],
    [["@book", "t-cmd"], ["title", "t-special"], ["{A\u{1f600}}", "t-math"], ["% note", "t-comment"]]],
  ["ris", ["TY  - BOOK\rTI  - A\u{1f600}\rER  -", "TY  - BOOK\rTI  - A\u{1f600}\r\nN1  - note\nER  -\r"],
    [["TI", "t-special"], ["BOOK", "t-cmd"], ["A\u{1f600}", "t-math"], ["ER", "t-special"]]],
]) {
  test(`${kind} real adapter highlights bare-CR and mixed-ending bibliography at raw offsets`, options, async () => {
    const h = harness("en", true); await h.editor.ready;
    const { EditorState } = require("@codemirror/state");
    const { ensureSyntaxTree, highlightingFor } = require("@codemirror/language");
    const { highlightTree } = require("@lezer/highlight");
    for (const source of sources) {
      // Generic text entry points rely on content candidacy before state creation.
      h.editor.load(source, "tex");
      const state = h.editor.view().state, snapshot = h.editor.snapshot();
      assert.equal(h.editor.getValue(), source);
      assert.equal(state.facet(EditorState.lineSeparator), "\n");
      assert.equal(state.doc.length, source.length);
      const classes = new Array(source.length).fill(null);
      highlightTree(ensureSyntaxTree(state, state.doc.length, 1000), { style: (tags) => highlightingFor(state, tags) },
        (from, to, style) => classes.fill(style, from, to));
      for (const [literal, style] of tokens) {
        const from = source.indexOf(literal);
        assert.notEqual(from, -1);
        assert.deepEqual(classes.slice(from, from + literal.length), new Array(literal.length).fill(style), `${literal} in ${JSON.stringify(source)}`);
      }
      assert.deepEqual(h.editor.snapshot(), snapshot, "highlighting must not change raw text or revision");
    }
  });
}

for (const [kind, source] of [
  ["bib", "@book{a,\r\n title={A\u{1f600}B}\r\n}\r\n"],
  ["ris", "TY  - BOOK\r\nTI  - A\u{1f600}B\r\nER  - \r\n"],
  ["txt", "\uFEFF% refs\r\n@book{a,\r\n title={A\u{1f600}B}\r\n}\r\n"],
  ["txt", "\uFEFF% refs\r\nTY  - BOOK\r\nTI  - A\u{1f600}B\r\nER  - \r\n"],
]) {
  test(`${kind} raw bibliography agrees with authority through Enter, paste, undo and resync: ${source.includes("@") ? "BibTeX" : "RIS"}`, options, async () => {
    const h = harness("en", true), data = projectData();
    data.project.nodes[0] = { ...data.project.nodes[0], name: `refs.${kind}`, path: `refs.${kind}`, kind, content: source };
    await h.open(data);
    const ed = h.editor;
    assert.equal(ed.getValue(), source, "actual file load must preserve raw CRLF before room join");
    const { ensureSyntaxTree, highlightingFor } = require("@codemirror/language");
    const { highlightTree } = require("@lezer/highlight");
    const state = ed.view().state, classes = new Array(source.length).fill(null);
    highlightTree(ensureSyntaxTree(state, state.doc.length, 1000), { style: (tags) => highlightingFor(state, tags) },
      (from, to, style) => classes.fill(style, from, to));
    const tokens = source.includes("@") ? [["@book", "t-cmd"], ["a,", "t-env"], ["title", "t-special"], ["A", "t-math"]]
      : [["BOOK", "t-cmd"], ["TI", "t-special"], ["A", "t-math"]];
    for (const [literal, style] of tokens) assert.equal(classes[source.indexOf(literal)], style, literal);
    const room = new CollabDocument({ fileId: "main", projectId: "p1", path: `refs.${kind}`, content: source });
    // .txt entry points supply the generic TeX kind, not a bibliography hint.
    const editorKind = kind === "txt" ? "tex" : kind;
    ed.loadCollab(room.text(), editorKind, { version: room.version });
    assert.equal(ed.getValue(), source);
    const confirm = (expected) => {
      const pending = ed.collabPending();
      assert.ok(pending, "use the adapter's real wire updates");
      assert.equal(ChangeSet.fromJSON(pending.updates[0].changes).length, room.text().length);
      const result = room.receive(pending.version, pending.updates);
      assert.equal(result.accepted, true);
      const beforeEcho = ed.snapshot();
      ed.collabReceive(result.updates);
      assert.equal(ed.collabPending(), null);
      assert.deepEqual(ed.snapshot(), beforeEcho, "confirmation without a text change is not a new revision");
      assert.equal(ed.getValue(), expected);
      assert.equal(room.text(), expected);
      assert.equal(ed.collabVersion(), room.version);
    };
    const pos = source.indexOf("\u{1f600}") + 2;
    ed.select(pos, pos + 1);
    assert.equal(ed.selection().text, "B", "raw UTF-16 offset after an astral character");
    ed.replaceRange(pos, pos + 1, "C");
    const replaced = source.replace("\u{1f600}B", "\u{1f600}C");
    confirm(replaced);
    ed.setLanguage("ris");
    ed.select(pos);
    ed.pressKey("Enter");
    confirm(replaced.slice(0, pos) + "\n" + replaced.slice(pos));
    assert.equal(ed.undo(), true); confirm(replaced);
    ed.select(pos);
    assert.equal(ed.paste("P\r\n\u{1f680}Q\r\n"), true);
    const pending = clone(ed.collabPending()), snapshot = ed.snapshot();
    ed.setLanguage(null); ed.requestMeasure(); ed.setLanguage(kind);
    assert.deepEqual(clone(ed.collabPending()), pending, "reconfiguration retains pending OT");
    assert.deepEqual(ed.snapshot(), snapshot);
    confirm(replaced.slice(0, pos) + "P\r\n\u{1f680}Q\r\n" + replaced.slice(pos));
    assert.equal(ed.undo(), true); confirm(replaced);
    // A content-based .txt candidate may lose its header while still in this room.
    room.reset("changed\r\n\u{1f600}tail\r\n");
    const beforeResync = ed.snapshot();
    ed.loadCollab(room.text(), editorKind, { version: room.version });
    assert.equal(ed.getValue(), "changed\r\n\u{1f600}tail\r\n");
    assert.ok(ed.snapshot().revision > beforeResync.revision);
    ed.select(11); ed.paste("!\r\n");
    confirm("changed\r\n\u{1f600}!\r\ntail\r\n");
    assert.equal(ed.undo(), true); confirm("changed\r\n\u{1f600}tail\r\n");
    ed.load("ordinary\r\ntext", "tex");
    assert.equal(ed.getValue(), "ordinary\ntext", "raw policy must not leak to the next non-bibliographic file");
  });
}

for (const [kind, source] of [
  ["bib", "@book{a,\r\n title={A\u{1f600}B}\r\n}\r\n"],
  ["ris", "TY  - BOOK\r\nTI  - A\u{1f600}B\r\nER  - \r\n"],
]) {
  test(`${kind} real adapter rebases pending UTF-16 edits and undo preserves the peer's CRLF text`, options, async () => {
    const a = harness("en", true).editor, b = harness("en", true).editor;
    await Promise.all([a.ready, b.ready]);
    const room = new CollabDocument({ fileId: "f", projectId: "p", path: `refs.${kind}`, content: source });
    for (const ed of [a, b]) ed.loadCollab(source, kind, { version: 0 });
    const pos = source.indexOf("\u{1f600}") + 2;
    a.replaceRange(pos, pos + 1, "C");
    b.replaceRange(0, 0, "% peer\r\n");
    const peer = b.collabPending();
    assert.equal(room.receive(peer.version, peer.updates).accepted, true);
    b.collabReceive(room.since(0));
    const pending = a.collabPending(), local = a.snapshot();
    assert.equal(room.receive(pending.version, pending.updates).accepted, false);
    a.setLanguage(null); a.requestMeasure(); a.setLanguage(kind);
    assert.deepEqual(a.snapshot(), local);
    a.collabReceive(room.since(a.collabVersion()));
    assert.ok(a.snapshot().revision > local.revision, "remote text advances the snapshot revision");
    const rebased = a.collabPending();
    assert.equal(ChangeSet.fromJSON(rebased.updates[0].changes).length, room.text().length);
    assert.equal(room.receive(rebased.version, rebased.updates).accepted, true);
    for (const ed of [a, b]) ed.collabReceive(room.since(ed.collabVersion()));
    const expected = "% peer\r\n" + source.replace("\u{1f600}B", "\u{1f600}C");
    for (const ed of [a, b]) assert.equal(ed.getValue(), expected);
    assert.equal(room.text(), expected);
    assert.equal(a.undo(), true);
    const undo = a.collabPending();
    assert.equal(room.receive(undo.version, undo.updates).accepted, true);
    for (const ed of [a, b]) {
      ed.collabReceive(room.since(ed.collabVersion()));
      assert.equal(ed.getValue(), "% peer\r\n" + source);
    }
    assert.equal(room.text(), "% peer\r\n" + source);
  });
}

test("RIS has no TeX indentation, comment, completion or brace behavior", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  const ed = h.editor;
  ed.load("TY  - BOOK\nTI  - text\n  {\\begin{foo}", "ris");
  const state = ed.view().state;
  assert.deepEqual(state.languageDataAt("commentTokens", 0), []);
  ed.select(ed.getValue().length); ed.pressKey("Enter");
  assert.equal(ed.getValue(), "TY  - BOOK\nTI  - text\n  {\\begin{foo}\n");
  ed.typeText("{"); assert.equal(ed.getValue().endsWith("\n{"), true);
  ed.load("TY  - BOOK\nTI  - {}", "ris"); ed.select(ed.getValue().length - 1);
  ed.pressKey("Backspace"); assert.equal(ed.getValue(), "TY  - BOOK\nTI  - }");
  ed.load("TY  - BOOK\nTI  - \\sec", "ris"); ed.select(ed.getValue().length);
  assert.deepEqual(clone(ed.complete()), [null]);
});

test("switching to RIS cancels a pending TeX completion without changing the snapshot", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  const ed = h.editor, A = require("@codemirror/autocomplete");
  ed.load("\\sec", "tex"); ed.select(4);
  assert.ok(ed.complete()[0].options.some((option) => option.label === "\\section"));
  A.startCompletion(ed.view());
  assert.equal(A.completionStatus(ed.view().state), "pending");
  const snapshot = ed.snapshot();
  ed.setLanguage("ris");
  assert.equal(A.completionStatus(ed.view().state), null);
  assert.deepEqual(ed.snapshot(), snapshot);
  assert.deepEqual(clone(ed.complete()), [null]);
});

test("RIS is editable text and persists the exact buffer", options, async () => {
  const h = harness();
  const data = projectData();
  data.project.nodes[0] = {
    type: "file", id: "main", name: "refs.ris", path: "refs.ris", kind: "ris",
    content: "TY  - BOOK\r\nTI  - A\r\nER  - \r\n",
  };
  await h.open(data);
  const next = data.project.nodes[0].content.replace("TI  - A", "TI  - B");
  h.edit(next);
  assert.equal(h.app.capturePersistence().data.project.nodes[0].content, next);
  // Capture the current adapter buffer even before its change callback runs.
  h.editor.value = next + "\r\n";
  assert.equal(h.app.capturePersistence().data.project.nodes[0].content, next + "\r\n");
});

for (const kind of ["bib", "ris"]) {
  const source = kind === "bib" ? "\uFEFF@book{a, title={Perch\u00e9}}\r\n" : "\uFEFFTY  - BOOK\r\nTI  - Perch\u00e9\r\nER  - \r\n";
  test(`${kind} external open preserves UTF-8 BOM and CRLF without writing untouched sources`, options, async () => {
    const h = harness(); await h.open();
    const bytes = Buffer.from(source);
    h.a.openExternal({ name: `refs.${kind}`, bytes });
    const node = h.a.findFile(h.a.state.activeId);
    assert.equal(node.kind, kind);
    assert.equal(h.editor.value, source);
    assert.equal(h.app.capturePersistence().data.project.nodes.at(-1).content, source);
    assert.deepEqual(bytes, Buffer.from(source));
    assert.equal(h.app.capturePersistence().data.project.nodes[0].content, undefined, "untouched TeX is omitted");
  });

  test(`${kind} upload preserves its text rather than replaying a data URL`, options, async () => {
    const h = harness(); await h.open();
    h.a.pickAttach({ name: `refs.${kind}`, bytes: Buffer.from(source), size: Buffer.byteLength(source), type: "application/octet-stream" });
    h.a.doUpload(); await tick();
    const upload = h.requests.at(-1).body.data.project.nodes.at(-1);
    assert.equal(upload.kind, kind);
    assert.equal(upload.content, source);
    assert.equal(upload.data, undefined);
    assert.equal(h.requests.at(-1).body.data.assets[`refs.${kind}`], undefined);
    h.ack(h.requests.at(-1), 5); await tick();
    assert.equal(h.app.capturePersistence().data.project.nodes.at(-1).content, undefined, "no-op saves omit acknowledged text");
  });

  for (const route of ["open", "upload"]) {
    test(`${kind} ${route} rejects invalid encoding without adopting the file`, options, async () => {
      for (const language of ["en", "it"]) {
        const h = harness(language); await h.open(); h.edit("unsaved original");
        const before = clone(h.app.capturePersistence().data);
        const bytes = Buffer.from([0xc3, 0x28, 0xff]);
        const file = { name: `bad.${kind}`, bytes, size: bytes.length, type: "application/octet-stream" };
        if (route === "open") h.a.openExternal(file);
        else { h.a.pickAttach(file); h.a.doUpload(); }
        assert.deepEqual(clone(h.app.capturePersistence().data), before);
        assert.equal(h.editor.value, "unsaved original");
        assert.deepEqual(bytes, Buffer.from([0xc3, 0x28, 0xff]));
        const label = h.t("api.BIBLIOGRAPHY_INVALID_ENCODING");
        assert.notEqual(label, "api.BIBLIOGRAPHY_INVALID_ENCODING");
        assert.ok(h.get("toasts").children.some((node) => node.innerHTML.includes(label)));
        assert.equal(h.requests.length, 1);
      }
    });
  }

  test(`${kind} sourceError is transient, non-editable and cannot join or leak placeholder text into a save`, options, async () => {
    const h = harness("en", true);
    const data = projectData();
    const id = "019f9910-0000-7000-8000-000000000009";
    data.project.nodes.push({ type: "file", id, name: `bad.${kind}`, path: `bad.${kind}`, kind, sourceError: "BIBLIOGRAPHY_INVALID_ENCODING" });
    data.activeId = id; data.openTabs = [id];
    await h.open(data);
    h.socket().fire("open");
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.editor.getValue(), h.t("api.BIBLIOGRAPHY_INVALID_ENCODING"));
    assert.equal(h.a.findFile(id).content, undefined);
    assert.equal(h.a.findFile(id).readOnly, undefined);
    assert.equal(h.socket().of("open").length, 0);
    h.editor.applyText("must not replace bytes");
    h.document.dispatchEvent({ type: "iris:collabrole", detail: { role: "owner" } });
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.app.hasUnsavedChanges(), false);
    h.a.openFile("main"); h.edit("other source edited");
    const pending = h.app.persistChanges(); await tick();
    const saved = h.requests.at(-1).body.data.project.nodes;
    assert.equal(saved[0].content, "other source edited");
    assert.equal(saved[1].id, id);
    for (const key of ["content", "data", "sourceError", "readOnly"]) assert.equal(Object.hasOwn(saved[1], key), false, key);
    h.ack(h.requests.at(-1), 5); assert.equal(await pending, true);
    h.a.openFile(id);
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.socket().of("open").some((message) => message.fileId === id), false);
    const repaired = clone(data); delete repaired.project.nodes[1].sourceError;
    repaired.project.nodes[1].content = "repaired";
    await h.app.load(repaired);
    assert.equal(h.editor.isReadOnly(), false);
    assert.equal(h.editor.getValue(), "repaired");
  });

  test(`${kind} accepted tree refresh shows an encoding error without creating source content`, options, async () => {
    const h = harness("it", true);
    const data = projectData();
    data.project.nodes[0] = { ...data.project.nodes[0], name: `refs.${kind}`, path: `refs.${kind}`, kind };
    await h.open(data);
    const refreshed = clone(data);
    delete refreshed.project.nodes[0].content;
    refreshed.project.nodes[0].sourceError = "BIBLIOGRAPHY_INVALID_ENCODING";
    const pending = h.a.refreshFileTree(); await tick();
    h.requests.at(-1).reply(refreshed); await pending;
    assert.equal(h.editor.isReadOnly(), true);
    assert.equal(h.editor.getValue(), h.t("api.BIBLIOGRAPHY_INVALID_ENCODING"));
    assert.equal(h.a.findFile("main").content, undefined);
    assert.equal(h.app.capturePersistence().data.project.nodes[0].sourceError, undefined);
    assert.equal(h.app.hasUnsavedChanges(), false);
  });
}

for (const format of ["bib", "ris"]) for (const extension of ["txt", "md"]) {
  const source = format === "bib" ? "\uFEFF@book{a,title={Caf\u00e9}}\r\n" : "\uFEFFTY  - BOOK\r\nTI  - Caf\u00e9\r\nER  -\r\n";
  for (const route of ["open", "upload"]) {
    test(`generic ${format} ${extension} ${route} preserves original BOM and CRLF`, options, async () => {
      const h = harness(); await h.open();
      const file = { name: `refs.${extension}`, bytes: Buffer.from(source), size: Buffer.byteLength(source), type: "application/octet-stream" };
      if (route === "open") h.a.openExternal(file);
      else { h.a.pickAttach(file); h.a.doUpload(); }
      const node = h.app.capturePersistence().data.project.nodes.at(-1);
      assert.equal(node.content, source);
      assert.equal(node.kind, route === "upload" && extension === "md" ? "file" : "tex", "recognition does not rewrite the file kind");
      assert.equal(node.data, undefined);
    });

    test(`generic ${format} ${extension} ${route} refuses damaged bibliography without adoption`, options, async () => {
      for (const damaged of [Buffer.concat([Buffer.from("\uFEFF"), Buffer.from(source.slice(1), "latin1")]), Buffer.from(source.replace("\u00e9", "\0"))]) {
        const h = harness(); await h.open(); h.edit("unsaved original");
        const before = clone(h.app.capturePersistence().data);
        const file = { name: `refs.${extension}`, bytes: damaged, size: damaged.length, type: "application/octet-stream" };
        if (route === "open") h.a.openExternal(file);
        else { h.a.pickAttach(file); h.a.doUpload(); }
        assert.deepEqual(clone(h.app.capturePersistence().data), before);
        assert.equal(h.editor.value, "unsaved original");
        assert.ok(h.get("toasts").children.some((node) => node.innerHTML.includes(h.t("api.BIBLIOGRAPHY_INVALID_ENCODING"))));
        assert.equal(h.requests.length, 1);
      }
    });
  }
}

test("ordinary non-bibliography external open and upload keep their decoding behavior", options, async () => {
  const h = harness(); await h.open();
  h.a.openExternal({ name: "ordinary.txt", bytes: Buffer.from("Caf\u00e9", "latin1") });
  assert.equal(h.editor.value, "Caf\uFFFD");
  const file = { name: "ordinary.md", bytes: Buffer.from("Caf\u00e9", "latin1"), size: 4, type: "application/octet-stream" };
  h.a.pickAttach(file); h.a.doUpload();
  const node = h.app.capturePersistence().data.project.nodes.at(-1);
  assert.equal(node.content, undefined);
  assert.equal(node.data, "data:application/octet-stream;base64,Q2Fm6Q==");
});

test("new bibliography files are blank while TeX and LilyPond keep their templates", options, async () => {
  for (const kind of ["bib", "ris", "tex", "ly"]) {
    const h = harness(); await h.open(); h.a.openNewItem("file");
    h.get("newItemInput").value = `new.${kind}`; h.a.confirmNewItem();
    const node = h.a.findFile(h.a.state.activeId);
    assert.equal(node.kind, kind);
    if (kind === "bib" || kind === "ris") assert.equal(node.content, "");
    else assert.match(node.content, kind === "tex" ? /^\\documentclass/ : /^\\version/);
  }
});

test("external picker offers RIS alongside existing source formats", options, async () => {
  const h = harness(); await h.open(); h.a.openExternalPicker();
  assert.equal(h.inputs.at(-1).clicked, true);
  for (const extension of [".tex", ".ly", ".ily", ".bib", ".ris", ".txt"]) assert.ok(h.inputs.at(-1).accept.split(",").includes(extension));
});

test("custom completion commands load, apply and persist as project settings", options, async () => {
  const h = harness(); await h.open({ ...projectData(), customCommands: { tex: ["\\existing"], ly: [] } });
  assert.equal(h.get("completionTex").value, "\\existing");
  h.a.wire();
  h.get("completionTex").value = "myMacro\n\\myMacro";
  h.get("completionLy").value = "my-music";
  h.get("completionApply").dispatchEvent({ type: "click" });
  await tick();
  const request = h.requests.at(-1);
  assert.deepEqual(clone(h.app.serialize().customCommands), { tex: ["\\myMacro"], ly: ["\\my-music"] });
  assert.deepEqual(request.body.data.customCommands, { tex: ["\\myMacro"], ly: ["\\my-music"] });
  h.ack(request, 5); await tick();
  assert.equal(h.app.hasUnsavedChanges(), false);
  await h.app.load(projectData(6));
  assert.equal(h.get("completionTex").value, "");
  assert.deepEqual(clone(h.app.serialize().customCommands), { tex: [], ly: [] });
});

test("invalid custom commands stay in the form and do not replace valid project commands", options, async () => {
  const h = harness("it"); await h.open({ ...projectData(), customCommands: { tex: ["\\existing"], ly: [] } });
  h.a.wire();
  const before = h.requests.length;
  h.get("completionTex").value = "\\invalid{argument}";
  h.get("completionApply").dispatchEvent({ type: "click" });
  await tick();
  assert.deepEqual(clone(h.app.serialize().customCommands.tex), ["\\existing"]);
  assert.equal(h.get("completionTex").value, "\\invalid{argument}");
  assert.equal(h.get("completionTex").getAttribute("aria-invalid"), "true");
  assert.equal(h.get("completionNotice").hidden, false);
  assert.equal(h.requests.length, before);
  h.app.setRole("viewer");
  assert.equal(h.get("completionApply").disabled, true);
  h.get("completionTex").value = "\\forbidden";
  h.get("completionApply").dispatchEvent({ type: "click" });
  assert.deepEqual(clone(h.app.serialize().customCommands.tex), ["\\existing"]);
});

for (const kind of ["tex", "ly"]) {
  test(`${kind} typed braces pair, overtype and delete as an editor operation`, options, async () => {
    const h = harness("en", true); await h.editor.ready;
    h.editor.load("", kind);
    h.editor.typeText("{");
    assert.equal(sourceWithCaret(h.editor), "{¦}");
    h.editor.typeText("}");
    assert.equal(sourceWithCaret(h.editor), "{}¦");
    h.editor.select(1);
    h.editor.pressKey("Backspace");
    assert.equal(sourceWithCaret(h.editor), "¦");
    h.editor.load("% comment", kind); h.editor.select(9);
    h.editor.typeText("{");
    assert.equal(sourceWithCaret(h.editor), "% comment{¦");
    h.editor.load("\\", kind); h.editor.select(1);
    h.editor.typeText("{");
    assert.equal(sourceWithCaret(h.editor), "\\{¦");
  });
}

test("LilyPond octave apostrophes and Scheme openings are not automatically paired", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("c", "ly"); h.editor.select(1);
  h.editor.typeText("'");
  assert.equal(sourceWithCaret(h.editor), "c'¦");
  h.editor.load("#", "ly"); h.editor.select(1);
  h.editor.typeText("{");
  assert.equal(sourceWithCaret(h.editor), "#{¦");
});

test("Backspace after an escaped brace preserves the enclosing group's closing brace", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("\\textbf{\\{}", "tex"); h.editor.select(10);
  h.editor.pressKey("Backspace");
  assert.equal(h.editor.getValue(), "\\textbf{\\}");
});

test("paired Backspace handles mixed escaped and ordinary carets in one edit", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  const source = "{}\n\\textbf{\\{}";
  h.editor.load(source, "tex"); h.editor.selectCarets([1, 13]);
  h.editor.pressKey("Backspace");
  assert.equal(h.editor.getValue(), "\n\\textbf{\\}");
  h.editor.undo();
  assert.equal(h.editor.getValue(), source);
});

for (const [source, positions, expected] of [
  ["\\section\n\\", [8, 10], "\\section{}\n\\{"],
  ["\\section\n% comment", [8, 18], "\\section{}\n% comment{"],
  ["% comment\n\\section", [9, 18], "% comment{\n\\section{}"],
]) {
  test(`brace pairing evaluates every caret independently: ${JSON.stringify(source)}`, options, async () => {
    const h = harness("en", true); await h.editor.ready;
    h.editor.load(source, "tex"); h.editor.selectCarets(positions);
    h.editor.typeText("{");
    assert.equal(h.editor.getValue(), expected);
    assert.equal(h.editor.carets().length, 2);
    h.editor.undo();
    assert.equal(h.editor.getValue(), source);
  });
}

test("ordinary character input never scans the source to configure brace pairing", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("Text ", "tex"); h.editor.select(5);
  let scans = 0;
  const scan = h.window.IrisLatex.completionText;
  h.window.IrisLatex.completionText = (text) => { scans++; return scan(text); };
  h.editor.typeText("a");
  assert.equal(h.editor.getValue(), "Text a");
  assert.equal(scans, 0);
});

for (const main of [0, 1]) {
  test(`generated brace markers survive ordinary typing on every caret line (primary: ${main})`, options, async () => {
    const h = harness("en", true); await h.editor.ready;
    h.editor.load("\n", "tex"); h.editor.selectCarets([0, 1], main);
    h.editor.typeText("{");
    assert.equal(h.editor.getValue(), "{}\n{}");
    h.editor.typeText("a");
    assert.equal(h.editor.getValue(), "{a}\n{a}");
    h.editor.typeText("}");
    assert.equal(h.editor.getValue(), "{a}\n{a}");
    assert.deepEqual(clone(h.editor.carets()), [3, 7]);
  });
}

const ENTER_CASES = [
  ["LaTeX environment", "tex", "\\begin{itemize}¦", "\\begin{itemize}\n  ¦\n\\end{itemize}"],
  ["custom starred environment", "tex", "  \\begin {custom-env*}¦", "  \\begin {custom-env*}\n    ¦\n  \\end{custom-env*}"],
  ["LaTeX inline pair", "tex", "\\begin{align}¦ \\end{align}", "\\begin{align}\n  ¦\n\\end{align}"],
  ["LaTeX existing end", "tex", "\\begin{itemize}¦\n  \\item Text\n\\end{itemize}", "\\begin{itemize}\n  ¦\n  \\item Text\n\\end{itemize}"],
  ["nested LaTeX environment", "tex", "\\begin{document}\n  \\begin{itemize}¦\n\\end{document}", "\\begin{document}\n  \\begin{itemize}\n    ¦\n  \\end{itemize}\n\\end{document}"],
  ["nested same-name environment", "tex", "\\begin{itemize}\n  \\begin{itemize}¦\n\\end{itemize}", "\\begin{itemize}\n  \\begin{itemize}\n    ¦\n  \\end{itemize}\n\\end{itemize}"],
  ["wrapped same-name environment", "tex", "\\begin{document}\n\\begin{itemize}\n  \\begin{itemize}¦\n\\end{itemize}\n\\end{document}", "\\begin{document}\n\\begin{itemize}\n  \\begin{itemize}\n    ¦\n  \\end{itemize}\n\\end{itemize}\n\\end{document}"],
  ["earlier unclosed environment outside this scope", "tex", "\\begin{outer}\n\\begin{inner}\n\\end{outer}\n\\begin{inner}¦\n\\end{inner}", "\\begin{outer}\n\\begin{inner}\n\\end{outer}\n\\begin{inner}\n  ¦\n\\end{inner}"],
  ["nested LaTeX inline pair", "tex", "\\begin{itemize}\n  \\begin{itemize}¦ \\end{itemize}", "\\begin{itemize}\n  \\begin{itemize}\n    ¦\n  \\end{itemize}"],
  ["already balanced nested environments", "tex", "\\begin{itemize}\n  \\begin{itemize}¦\n  \\end{itemize}\n\\end{itemize}", "\\begin{itemize}\n  \\begin{itemize}\n    ¦\n  \\end{itemize}\n\\end{itemize}"],
  ["commented LaTeX end", "tex", "\\begin{itemize}¦\n% \\end{itemize}", "\\begin{itemize}\n  ¦\n\\end{itemize}\n% \\end{itemize}"],
  ["LaTeX trailing comment", "tex", "\\begin{itemize} % list¦", "\\begin{itemize} % list\n  ¦\n\\end{itemize}"],
  ["LaTeX comment text", "tex", "% \\begin{itemize}¦", "% \\begin{itemize}\n¦"],
  ["escaped begin command", "tex", "\\\\begin{itemize}¦", "\\\\begin{itemize}\n¦"],
  ["inline verbatim text", "tex", "\\verb|\\begin{itemize}|¦", "\\verb|\\begin{itemize}|\n¦"],
  ["verbatim environment body", "tex", "\\begin{verbatim}\n\\begin{itemize}¦", "\\begin{verbatim}\n\\begin{itemize}\n¦"],
  ["verbatim environment opener", "tex", "\\begin{verbatim}¦", "\\begin{verbatim}\n  ¦\n\\end{verbatim}"],
  ["LilyPond braces", "ly", "\\score {¦", "\\score {\n  ¦\n}"],
  ["LilyPond simultaneous music", "ly", "  \\new StaffGroup <<¦", "  \\new StaffGroup <<\n    ¦\n  >>"],
  ["LilyPond inline pair", "ly", "music = {¦ }", "music = {\n  ¦\n}"],
  ["LilyPond existing close", "ly", "\\score {¦\n  c1\n}", "\\score {\n  ¦\n  c1\n}"],
  ["nested LilyPond braces", "ly", "\\score {\n  \\new Staff {¦\n}", "\\score {\n  \\new Staff {\n    ¦\n  }\n}"],
  ["nested LilyPond inline pair", "ly", "\\score {\n  \\new Staff {¦ }", "\\score {\n  \\new Staff {\n    ¦\n  }"],
  ["nested LilyPond simultaneous music", "ly", "<<\n  <<¦\n>>", "<<\n  <<\n    ¦\n  >>\n>>"],
  ["wrapped LilyPond simultaneous music", "ly", "\\score {\n  <<\n    <<¦\n  >>\n}", "\\score {\n  <<\n    <<\n      ¦\n    >>\n  >>\n}"],
  ["earlier unclosed LilyPond block outside this scope", "ly", "{\n<<\n}\n<<¦\n>>", "{\n<<\n}\n<<\n  ¦\n>>"],
  ["Scheme music-literal opener is not an ordinary brace", "ly", "#{¦", "#{\n¦"],
  ["LilyPond mixed blocks", "ly", "\\score {\n  <<¦\n}", "\\score {\n  <<\n    ¦\n  >>\n}"],
  ["LilyPond comment text", "ly", "% \\score {¦", "% \\score {\n¦"],
  ["LilyPond trailing comment", "ly", "\\score { % music¦", "\\score { % music\n  ¦\n}"],
  ["LilyPond block comment", "ly", "%{\n\\score {¦\n%}", "%{\n\\score {\n¦\n%}"],
  ["LilyPond string", "ly", '\\markup "text {¦"', '\\markup "text {\n¦"'],
  ["LilyPond escaped brace", "ly", "\\{¦", "\\{\n¦"],
  ["LilyPond string after opener", "ly", '\\markup { "Text"¦', '\\markup { "Text"\n¦'],
  ["ordinary text", "tex", "  Text¦", "  Text\n  ¦"],
  ["inline body text", "tex", "\\begin{itemize}¦body", "\\begin{itemize}\n  ¦body"],
  ["unrelated unclosed later block", "ly", "{¦}\n{", "{\n  ¦\n}\n{"],
];

function sourceWithCaret(editor) {
  const { from, to } = editor.selection();
  assert.equal(from, to, "Enter leaves a caret, not a selected generated block");
  return editor.getValue().slice(0, from) + "¦" + editor.getValue().slice(from);
}

for (const [label, kind, before, after] of ENTER_CASES) {
  test(`Enter completion: ${label}`, { timeout: 5000 }, async () => {
    const h = harness("en", true); await h.editor.ready;
    h.editor.load(before.replace("¦", ""), kind);
    h.editor.select(before.indexOf("¦"));
    h.editor.pressKey("Enter");
    assert.equal(sourceWithCaret(h.editor), after);
  });
}

test("Enter completion respects disabled auto-indent and remains one undoable edit", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  const source = "  \\begin{itemize}";
  h.editor.load(source, "tex"); h.editor.select(source.length);
  h.editor.setAutoIndent(false);
  let changes = 0;
  h.editor.onChange(() => { changes++; });
  h.editor.pressKey("Enter");
  assert.equal(sourceWithCaret(h.editor), source + "\n¦\n\\end{itemize}");
  assert.equal(changes, 1);
  h.editor.undo();
  assert.equal(sourceWithCaret(h.editor), source + "¦");
});

test("Enter completion respects read-only documents and ordinary selection replacement", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("\\score {", "ly"); h.editor.select(8); h.editor.setReadOnly(true);
  h.editor.pressKey("Enter");
  assert.equal(sourceWithCaret(h.editor), "\\score {¦");
  h.editor.setReadOnly(false);
  h.editor.load("first\nsecond", "tex"); h.editor.select(0, 12);
  h.editor.pressKey("Enter");
  assert.equal(sourceWithCaret(h.editor), "\n¦");
  h.editor.load("\\begin{itemize}replace this", "tex");
  h.editor.select(15, 27);
  h.editor.pressKey("Enter");
  assert.equal(sourceWithCaret(h.editor), "\\begin{itemize}\n  ¦");
});

test("Enter completion sends the entire generated block as one collaborative update", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.loadCollab("<<", "ly", { version: 5 }); h.editor.select(2);
  h.editor.pressKey("Enter");
  const pending = h.editor.collabPending();
  assert.equal(pending.version, 5);
  assert.equal(pending.updates.length, 1);
  assert.equal(sourceWithCaret(h.editor), "<<\n  ¦\n>>");
});

test("Enter completion uses each caret's own environment and keeps both inner cursors", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("\\begin{a}\n\\begin{b}", "tex");
  h.editor.selectCarets([9, 19]);
  assert.equal(h.editor.carets().length, 2);
  h.editor.pressKey("Enter");
  assert.equal(h.editor.getValue(), "\\begin{a}\n  \n\\end{a}\n\\begin{b}\n  \n\\end{b}");
  assert.deepEqual(clone(h.editor.carets()), [12, 33]);
});

test("Enter completion keeps nearby carets from consuming the same closing gap", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("{   }", "ly");
  h.editor.selectCarets([1, 3]);
  assert.equal(h.editor.carets().length, 2);
  assert.doesNotThrow(() => h.editor.pressKey("Enter"));
  assert.equal(h.editor.getValue().replace(/\s/g, ""), "{}");
  assert.equal(new Set(h.editor.carets()).size, 2);
});

test("Enter completion adds only one closer when two carets share an unclosed opener", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("{   ", "ly");
  h.editor.selectCarets([1, 3]);
  h.editor.pressKey("Enter");
  assert.equal(h.editor.getValue().replace(/\s/g, ""), "{}");
  assert.equal(new Set(h.editor.carets()).size, 2);
});

test("Enter completion coordinates nested caret completions with an existing outer end", options, async () => {
  const h = harness("en", true); await h.editor.ready;
  h.editor.load("\\begin{a}\n\\begin{a}\n\\end{a}", "tex");
  h.editor.selectCarets([9, 19]);
  h.editor.pressKey("Enter");
  assert.equal(h.editor.getValue(), "\\begin{a}\n  \n\\begin{a}\n  \n\\end{a}\n\\end{a}");
  assert.equal(new Set(h.editor.carets()).size, 2);
});

for (const [extension, source, closing] of [["ily", "\\score {", "}"], ["sty", "\\begin{itemize}", "\\end{itemize}"], ["cls", "\\begin{itemize}", "\\end{itemize}"]]) {
  for (const shared of [false, true]) {
    test(`Enter completion in included .${extension} sources (shared: ${shared})`, options, async () => {
      const h = harness("en", true);
      const data = projectData();
      const id = "019f9910-0000-7000-8000-000000000008";
      data.project.nodes.push({ type: "file", id, name: `included.${extension}`, path: `included.${extension}`, kind: "file", content: source });
      data.activeId = id; data.openTabs = [id];
      await h.open(data);
      if (shared) {
        h.socket().fire("open");
        h.socket().deliver({ t: "opened", fileId: id, version: 0, doc: source, role: "owner" });
      }
      h.editor.select(source.length);
      h.editor.pressKey("Enter");
      assert.equal(sourceWithCaret(h.editor), source + "\n  ¦\n" + closing);
    });
  }
}

function mainMarkerRows(h) {
  return h.get("tree").children.filter((row) => row.dataset.id && row.querySelector(".node-main")?.hidden === false);
}

function mainMarkerProject(kind) {
  const data = projectData();
  data.projectType = kind === "ly" ? "lilypond" : "latex";
  data.engine = kind === "ly" ? "lilypond" : "pdflatex";
  const complete = kind === "ly" ? "\\score { { c1 } }" : "\\documentclass{article}\n\\begin{document}\nText\n\\end{document}";
  data.project.nodes = [
    { type: "file", id: "main", name: `main.${kind}`, path: `main.${kind}`, kind, content: complete },
    { type: "folder", name: "sections", open: true, children: [
      { type: "file", id: "chapter", name: `intro.${kind}`, path: `sections/intro.${kind}`, kind, content: "fragment" },
      { type: "file", id: "alternate", name: `alternate.${kind}`, path: `sections/alternate.${kind}`, kind, content: complete },
    ] },
  ];
  data.activeId = "chapter"; data.openTabs = ["chapter"];
  return data;
}

for (const kind of ["tex", "ly"]) {
  test(`${kind} main-file icon distinguishes the configured source from the open fragment`, options, async () => {
    const h = harness("it");
    await h.open({ ...mainMarkerProject(kind), mainPath: `main.${kind}` });
    const marked = mainMarkerRows(h);
    assert.deepEqual(marked.map((row) => row.dataset.id), ["main"]);
    const icon = marked[0].querySelector(".node-main");
    assert.equal(icon.title, `File principale per la compilazione: main.${kind}`);
    assert.equal(icon.getAttribute("aria-label"), icon.title);
    h.a.openFile("alternate");
    assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["main"]);
    assert.equal(h.a.state.dirtyFiles.size, 0, "displaying a marker does not edit the project");
  });

  test(`${kind} automatic main-file icon follows the compilation target in place`, options, async () => {
    const h = harness(); await h.open(mainMarkerProject(kind));
    assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["main"]);
    const originalRows = h.get("tree").children.slice();
    h.a.openFile("alternate");
    assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["alternate"]);
    assert.equal(mainMarkerRows(h)[0].querySelector(".node-main").title,
      `Main file for compilation (automatic): sections/alternate.${kind}`);
    h.edit("fragment");
    assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["main"]);
    assert.deepEqual(h.get("tree").children, originalRows, "the tree is not rebuilt while editing");
  });

  test(`${kind} main-file settings update the marker immediately and missing choices use detection`, options, async () => {
    const h = harness(); await h.open({ ...mainMarkerProject(kind), mainPath: `missing.${kind}` });
    assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["main"]);
    h.a.wire();
    h.get("compileMainPath").value = `sections/alternate.${kind}`;
    h.get("compileMainPath").dispatchEvent({ type: "change" });
    assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["alternate"]);
    assert.equal(mainMarkerRows(h)[0].querySelector(".node-main").title,
      `Main file for compilation: sections/alternate.${kind}`);
  });
}

test("an authoritative source reload updates automatic main-file detection without marking edits", options, async () => {
  const h = harness("en", true); await h.open(mainMarkerProject("tex"));
  assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["main"]);
  h.editor.loadCollab("\\documentclass{book}\n\\begin{document}\nnew", "tex", { version: 5 });
  assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["chapter"]);
  assert.equal(h.a.docFileForCompile().id, "chapter");
  assert.equal(h.a.state.dirtyFiles.size, 0);
});

test("only real compile sources can receive the main-file marker", options, async () => {
  const h = harness();
  const data = projectData(4, "plain TeX without a document class yet");
  data.project.nodes.push(
    { type: "file", id: "bib", name: "refs.bib", path: "refs.bib", kind: "bib", content: "references" },
    { type: "file", id: "text", name: "notes.txt", path: "notes.txt", kind: "tex", content: "\\documentclass{article}" },
    { type: "file", id: "foreign", name: "score.ly", path: "score.ly", kind: "ly", content: "\\score {}" }
  );
  data.activeId = "bib"; data.openTabs = ["bib"];
  await h.open(data);
  assert.equal(h.a.docFileForCompile().id, "main");
  assert.deepEqual(mainMarkerRows(h).map((row) => row.dataset.id), ["main"]);
  data.project.nodes.shift();
  await h.app.load(data);
  assert.equal(h.a.docFileForCompile(), null);
  assert.deepEqual(mainMarkerRows(h), []);
});

test("build diagnostics use the compiled revision when edits arrive before the result", options, async () => {
  const h = harness("en", true); await h.open(projectData(4, "first\nbroken\nlast"));
  h.editor.replaceRange(0, 0, "new\n");
  const before = h.requests.length;
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "main.tex", line: 2, column: null, message: "bad", sourceFileId: "source-id", sourceRevisionId: "revision-id" },
  ]));
  await tick();
  assert.equal(h.requests.length, before + 1, "loads the existing immutable source revision");
  assert.match(h.requests.at(-1).url, /\/files\/source-id\/versions\/revision-id$/);
  h.requests.at(-1).reply({ content: "first\nbroken\nlast" });
  await tick();
  diagnosticRows(h)[0].children[0].dispatchEvent({ type: "click" });
  await tick();
  assert.equal(h.editor.selection().text, "broken");
  assert.equal(h.editor.selection().from, 10);
  assert.equal(h.editor.diagnostics()[0].line, 3);
});

test("a changed authoritative reload remaps diagnostics before navigation", options, async () => {
  const h = harness("en", true); await h.open(projectData(4, "first\nbroken\nlast"));
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "main.tex", line: 2, column: null, message: "bad" },
  ]));
  h.editor.loadCollab("new\nfirst\nbroken\nlast", "tex", { version: 2 });
  await tick();
  diagnosticRows(h)[0].children[0].dispatchEvent({ type: "click" });
  assert.equal(h.editor.selection().text, "broken");
  assert.equal(h.editor.selection().from, 10);
});

for (const order of ["revision-first", "room-first"]) {
  test(`inactive versioned diagnostic waits for the authoritative open (${order})`, options, async () => {
    const h = harness("en", true);
    const data = projectData();
    const partId = "019f9910-0000-7000-8000-000000000002";
    data.project.nodes.push({ type: "file", id: partId, path: "part.tex", name: "part.tex", kind: "tex", content: "first\nbroken\nlast" });
    await h.open(data);
    await h.app.showBuildOutput(diagnosticBuild([
      { severity: "error", file: "part.tex", line: 2, column: null, message: "bad", sourceFileId: partId, sourceRevisionId: "revision-id" },
    ]));
    diagnosticRows(h)[0].children[0].dispatchEvent({ type: "click" });
    await tick();
    const revision = h.requests.at(-1);
    const loadRoom = () => h.editor.loadCollab("new\nfirst\nbroken\nlast", "tex", { version: 2 });
    if (order === "room-first") loadRoom();
    revision.reply({ content: "first\nbroken\nlast" });
    await tick();
    if (order === "revision-first") loadRoom();
    await tick();
    assert.equal(h.editor.diagnostics()[0].line, 3);
    assert.equal(h.editor.selection().text, "broken");
    assert.equal(h.editor.selection().from, 10);
  });
}

test("a diagnostic can open an inactive source whose cached content lacks the reported line", options, async () => {
  const h = harness("en", true);
  const data = projectData();
  data.project.nodes.push({ type: "file", id: "part", path: "part.tex", name: "part.tex", kind: "tex", content: "first" });
  await h.open(data);
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "part.tex", line: 3, column: null, message: "bad" },
  ]));
  const button = diagnosticRows(h)[0].children[0];
  assert.equal(button.disabled, false);
  button.dispatchEvent({ type: "click" });
  assert.equal(h.a.state.activeId, "part");
  h.editor.loadCollab("first\nsecond\nbroken", "tex", { version: 2 });
  await tick();
  assert.equal(h.editor.selection().text, "broken");
});

test("deleting the diagnosed line removes its marker and disables its source link", options, async () => {
  const h = harness("en", true); await h.open(projectData(4, "first\nbroken\nlast"));
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "main.tex", line: 2, column: null, message: "bad" },
  ]));
  h.editor.replaceRange(6, 13, "");
  assert.equal(h.editor.diagnostics().length, 0);
  assert.equal(diagnosticRows(h)[0].children[0].disabled, true);
});

test("compiler messages are rendered as inert text and remain readable without a location", options, async () => {
  const h = harness("it", true); await h.open();
  const message = '<img src=x onerror="alert(1)">';
  await h.app.showBuildOutput(diagnosticBuild([{ severity: "error", file: null, line: null, column: null, message }]));
  const button = diagnosticRows(h)[0].children[0];
  const body = button.children[1];
  assert.equal(button.disabled, true);
  assert.equal(body.children[0].textContent, "Errore");
  assert.equal(body.children[2].textContent, message);
  assert.equal(body.children[2].innerHTML, "");
});

for (const [kind, filePath] of [["tex", "chapters/intro.tex"], ["ly", "parts/voice.ily"]]) {
  test(`${kind} diagnostic opens the exact nested source and selects its full line`, options, async () => {
    const h = harness("en", true);
    const data = projectData();
    data.project.nodes.push({ type: "folder", name: filePath.split("/")[0], children: [
      { type: "file", id: "included", path: filePath, name: filePath.split("/")[1], kind, content: "first\nbroken command\nlast" },
    ] });
    await h.open(data);
    await h.app.showBuildOutput(diagnosticBuild([
      { severity: "error", file: filePath, line: 2, column: 3, message: "Unknown command <x>" },
    ]));
    assert.equal(h.a.state.view, "diagnostics", "a failed build opens the diagnostic list");
    assert.equal(diagnosticRows(h).length, 1);
    const button = diagnosticRows(h)[0].children[0];
    assert.equal(button.disabled, false);
    button.dispatchEvent({ type: "click" });
    assert.equal(h.a.state.activeId, "included");
    assert.deepEqual(clone(h.editor.selection()), { from: 6, to: 20, text: "broken command", anchor: 6, head: 20 });
    assert.equal(h.editor.diagnostics()[0].line, 2);
    assert.equal(h.a.state.dirtyFiles.size, 0, "navigation must not edit the source");
  });
}

test("diagnostic list and gutter follow inserted lines and reset with the build or project", options, async () => {
  const h = harness("en", true); await h.open(projectData(4, "first\nbroken\nlast"));
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "main.tex", line: 2, column: null, message: "Bad command" },
    { severity: "warning", file: "main.tex", line: 2, column: null, message: "Undefined reference" },
  ]));
  h.editor.replaceRange(0, 0, "new\n");
  assert.deepEqual(clone(h.editor.diagnostics().map((d) => d.line)), [3, 3]);
  diagnosticRows(h)[0].children[0].dispatchEvent({ type: "click" });
  assert.equal(h.editor.selection().text, "broken");
  assert.equal(h.editor.selection().from, 10);
  await h.app.showBuildOutput(diagnosticBuild([], { id: "build-2" }));
  assert.equal(h.editor.diagnostics().length, 0);
  assert.equal(diagnosticRows(h).length, 0);
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "main.tex", line: 1, column: null, message: "bad" },
  ]));
  await h.app.clearBuildOutput();
  assert.equal(h.editor.diagnostics().length, 0);
  assert.equal(diagnosticRows(h).length, 0);
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "main.tex", line: 1, column: null, message: "bad" },
  ]));
  await h.app.load(projectData(5, "new project"));
  assert.equal(h.editor.diagnostics().length, 0);
  assert.equal(diagnosticRows(h).length, 0);
});

test("missing, external and unlocated diagnostics cannot jump to a same-named file", options, async () => {
  const h = harness("en", true); await h.open();
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "/external/main.tex", line: 1, column: null, message: "external error" },
    { severity: "error", file: "../main.tex", line: 1, column: null, message: "outside error" },
    { severity: "error", file: "deleted/main.tex", line: 1, column: null, message: "missing source" },
    { severity: "warning", file: null, line: null, column: null, message: "rerun needed" },
    { severity: "error", file: "main.tex", line: 100, column: null, message: "removed line" },
  ]));
  assert.equal(diagnosticRows(h).length, 5);
  assert.ok(diagnosticRows(h).every((row) => row.children[0].disabled));
  assert.equal(h.editor.diagnostics().length, 0);
});

test("returning to a source and collaborative reloads restore its markers", options, async () => {
  const h = harness("en", true);
  const data = projectData(4, "first\nbroken\nlast");
  data.project.nodes.push({ type: "file", id: "other", path: "other.tex", name: "other.tex", kind: "tex", content: "other" });
  await h.open(data);
  await h.app.showBuildOutput(diagnosticBuild([
    { severity: "error", file: "main.tex", line: 2, column: null, message: "bad" },
  ]));
  h.a.openFile("other");
  assert.equal(h.editor.diagnostics().length, 0);
  h.a.openFile("main");
  assert.equal(h.editor.diagnostics()[0].line, 2);
  h.editor.loadCollab("first\nbroken\nlast", "tex", { version: 2 });
  assert.equal(h.editor.diagnostics()[0].line, 2);
  h.editor.collabReceive([{ changes: ChangeSet.of({ from: 0, insert: "peer\n" }, 17).toJSON(), clientID: "peer" }]);
  assert.equal(h.editor.diagnostics()[0].line, 3);
  diagnosticRows(h)[0].children[0].dispatchEvent({ type: "click" });
  assert.equal(h.editor.selection().text, "broken");
});

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

test("retention saves capture queued edits and acknowledge only the submitted settings", options, async () => {
  const h = harness(); await h.open({ ...projectData(), retention: retentionData() }); h.a.wire();
  h.edit("submitted text");
  h.setRetention("buildKeep", "40");
  const first = h.app.persistChanges(); await tick();
  const req1 = h.requests.at(-1);
  assert.equal(req1.body.baseRevision, 4);
  assert.deepEqual(req1.body.retention, { buildKeep: 40 });

  h.setRetention("buildKeep", "50");
  const second = h.app.persistChanges();
  h.setRetention("buildKeep", "60");
  h.setRetention("versionDays", "");
  await tick(); assert.equal(h.requests.length, 2, "the second save waits for the first");
  h.ack(req1, 5, { retention: retentionData(40) }); assert.equal(await first, true); await tick();
  assert.deepEqual(clone(h.app.pendingRetention()), { buildKeep: 60, versionDays: null });
  assert.equal(h.a.state.retention.buildKeep.value, 40);
  assert.equal(h.get("retentionBuildKeep").value, "60", "an older acknowledgement must not overwrite the panel");
  assert.equal(h.get("retentionVersionDays").value, "");
  assert.equal(h.a.state.dirtyFiles.size, 0);
  assert.equal(h.app.hasUnsavedChanges(), true, "settings alone remain unsaved after the text is acknowledged");

  const req2 = h.requests.at(-1);
  assert.equal(req2.body.baseRevision, 5);
  assert.deepEqual(req2.body.retention, { buildKeep: 60, versionDays: null }, "capture at queue start, not enqueue time");
  const stored = retentionData(55);
  stored.buildKeep.max = 55;
  stored.versionDays.value = null;
  h.ack(req2, 6, { retention: stored }); assert.equal(await second, true);
  assert.equal(h.app.pendingRetention(), null);
  assert.equal(h.app.hasUnsavedChanges(), false);
  assert.equal(h.app.serialize().revision, 6);
  assert.equal(h.get("retentionBuildKeep").value, "55", "show the server's clamped value, not the requested 60");
  assert.equal(h.get("retentionVersionDays").value, "", "an explicit default remains distinct from its effective value");
});

test("a retention-only 409 preserves the pending settings, server view and revision", options, async () => {
  const h = harness(); await h.open({ ...projectData(), retention: retentionData() }); h.a.wire();
  h.setRetention("buildKeep", "40"); await tick();
  const request = h.requests.at(-1);
  assert.equal(request.method, "PUT", "settings save even with autosave disabled");
  assert.equal(request.body.baseRevision, 4);
  assert.deepEqual(request.body.retention, { buildKeep: 40 });
  request.reply({ errorCode: "PROJECT_REVISION_CONFLICT", params: { currentRevision: 8 } }, 409);
  await h.app.waitForPersistence();
  assert.deepEqual(clone(h.app.pendingRetention()), { buildKeep: 40 });
  assert.equal(h.get("retentionBuildKeep").value, "40");
  assert.equal(h.a.state.retention.buildKeep.value, 20);
  assert.equal(h.a.state.dirtyFiles.size, 0);
  assert.equal(h.app.hasUnsavedChanges(), true);
  assert.equal(h.app.serialize().revision, 4);
  assert.equal(h.p.cache.get("p1").revision, 4);
  assert.equal(h.p.cache.get("p1").retention.buildKeep.value, 20);
  await h.a.refreshFileTree();
  assert.equal(h.requests.length, 2, "no retry or refresh may discard the pending settings");
});

test("losing ownership clears unsavable retention edits without discarding document changes", options, async () => {
  for (const realtime of [false, true]) {
    const h = harness(); await h.open({ ...projectData(), retention: retentionData() }); h.a.wire();
    h.setRetention("buildKeep", "40"); await tick();
    h.requests.at(-1).reply({ errorCode: "PROJECT_RECOVERY_REQUIRED" }, 503);
    await h.app.waitForPersistence();
    h.edit("unsaved document");

    if (realtime) h.document.dispatchEvent({ type: "iris:collabrole", detail: { role: "editor" } });
    else h.app.setRole("editor");
    assert.equal(h.app.pendingRetention(), null);
    assert.equal(h.get("retentionBuildKeep").disabled, true);
    assert.equal(h.get("retentionBuildKeep").value, "20", "show the stored policy after losing ownership");
    assert.equal(h.editor.value, "unsaved document");
    assert.equal(h.app.hasUnsavedChanges(), true, "document edits must still need saving");

    const pending = h.app.persistChanges(); await tick();
    const request = h.requests.at(-1);
    assert.equal(request.body.retention, undefined);
    assert.equal(request.body.data.project.nodes[0].content, "unsaved document");
    h.ack(request, 5, { retention: retentionData() });
    assert.equal(await pending, true);
    assert.equal(h.app.hasUnsavedChanges(), false);
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

test("a refreshed mainPath selects the configured file and survives the next save", options, async () => {
  const h = harness();
  const data = projectData(4, "\\documentclass{article}");
  data.mainPath = "main.tex";
  data.project.nodes.push({ type: "file", id: "book", name: "book.tex", path: "book.tex", kind: "tex", content: "\\documentclass{book}" });
  await h.open(data);
  const pending = h.a.refreshFileTree(); await tick();
  h.requests.at(-1).reply({ ...data, revision: 8, mainPath: "book.tex" }); await pending;
  assert.equal(h.a.state.activeId, "main", "refresh need not open the configured main file");
  assert.equal(h.a.docFileForCompile().path, "book.tex");
  assert.equal(h.get("compileMainPath").value, "book.tex");
  assert.equal(h.app.serialize().mainPath, "book.tex");
  assert.equal(h.p.cache.get("p1").mainPath, "book.tex");
  assert.equal(h.app.hasUnsavedChanges(), false);
  h.edit("updated chapter");
  const saving = h.app.persistChanges(); await tick();
  const request = h.requests.at(-1);
  assert.equal(request.body.baseRevision, 8);
  assert.equal(request.body.data.mainPath, "book.tex", "saving must not replay the pre-refresh setting");
  h.ack(request, 9); assert.equal(await saving, true);
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
  test(`maintenance locks the real editor and preserves pending text, preferences and status (${language})`, options, async () => {
    const h = harness(language, true);
    await h.open({ ...sharedProject(), autoSave: true, autoSaveDelay: 25, retention: retentionData() });
    h.a.wire();
    const socket = h.socket(); socket.fire("open");
    socket.deliver({ t: "opened", fileId: mainFileId, version: 0, doc: "original", role: "owner" });
    h.setRetention("buildKeep", "40");
    h.edit("original first"); h.window.IrisCollab.flush();
    h.edit("original first second");
    const pending = clone(h.editor.collabPending());
    const snapshot = clone(h.app.serialize());
    socket.deliver({ t: "maintenance", active: true });
    assert.equal(h.editor.isReadOnly(), true);
    h.edit("must not replace retained text");
    assert.equal(h.editor.value, "original first second");
    assert.deepEqual(clone(h.editor.collabPending()), pending);
    assert.equal(h.window.IrisCollab.pending(), true);
    assert.equal(h.a.state.role, "owner");
    assert.equal(h.a.state.autoSave, true);
    assert.equal(h.a.state.autoSaveDelay, 25);
    assert.deepEqual(clone(h.app.pendingRetention()), { buildKeep: 40 });
    assert.deepEqual(clone(h.app.serialize()), snapshot, "maintenance must not change the manifest");
    assert.equal(h.get("stSyncLabel").textContent, h.t("collab.maintenance"));
    assert.notEqual(h.t("collab.maintenance"), "collab.maintenance");
    assert.equal(h.get("stSync").hidden, false);
    assert.equal(h.get("stSync").classList.contains("pending"), true);
    assert.ok(h.get("stSync").title.includes(h.t("collab.maintenanceHint")));
    assert.ok(h.get("stSync").title.includes(h.t("collab.pendingTitle")));
    h.app.setRole("owner");
    assert.equal(h.editor.isReadOnly(), true, "role refresh cannot unlock maintenance");
    socket.deliver({ t: "error", code: "MAINTENANCE_MODE", request: "push", fileId: mainFileId });
    h.window.IrisCollab.flush();
    assert.equal(socket.of("push").length, 1);
    socket.deliver({ t: "maintenance", active: false });
    assert.equal(h.editor.isReadOnly(), false);
    assert.equal(socket.of("push").length, 2);
    assert.deepEqual(socket.of("push")[1].updates, pending.updates);
    assert.equal(h.get("stSyncLabel").textContent, h.t("collab.pending"));
    const updates = socket.of("push")[1].updates;
    socket.deliver({ t: "updates", fileId: mainFileId, version: 2, updates });
    socket.deliver({ t: "pushed", fileId: mainFileId, accepted: true, version: 2 });
    assert.equal(h.editor.value, "original first second");
    assert.equal(h.editor.collabVersion(), 2);
    assert.equal(h.window.IrisCollab.pending(), false);
    assert.equal(h.get("stSyncLabel").textContent, h.t("collab.live"));
    assert.equal(h.a.state.autoSave, true);
    assert.deepEqual(clone(h.app.pendingRetention()), { buildKeep: 40 });
    assert.equal(h.requests.length, 1, "pause/resume needs no metadata writes or reloads");
  });
}

test("maintenance survives file switches and authoritative loads, but reads still update the editor", options, async () => {
  const h = harness("en", true); await openShared(h);
  const socket = h.socket();
  socket.deliver({ t: "maintenance", active: true });
  h.a.openFile(otherFileId);
  assert.equal(h.editor.isReadOnly(), true);
  socket.deliver({ t: "opened", fileId: otherFileId, version: 3, doc: "other", role: "owner" });
  socket.deliver({ t: "updates", fileId: otherFileId, version: 4, updates: [{ clientID: "remote", changes: ChangeSet.of({ from: 5, insert: "!" }, 5).toJSON() }] });
  assert.equal(h.editor.value, "other!");
  assert.equal(h.editor.isReadOnly(), true);
  socket.deliver({ t: "resync", fileId: otherFileId, version: 5, doc: "accepted" });
  h.edit("blocked");
  assert.equal(h.editor.value, "accepted");
  assert.equal(h.editor.isReadOnly(), true);
  socket.deliver({ t: "maintenance", active: false });
  assert.equal(h.editor.isReadOnly(), false);
  h.edit("accepted edit"); h.window.IrisCollab.flush();
  assert.equal(socket.of("push").at(-1).version, 5);
});

for (const reload of ["refresh", "project load"]) {
  test(`maintenance remains read-only across an accepted ${reload} until active false`, options, async () => {
    const h = harness("en", true); await openShared(h);
    const old = h.socket();
    old.deliver({ t: "maintenance", active: true });
    old.deliver({ t: "file-closed", fileId: mainFileId });
    const loading = reload === "refresh" ? h.a.refreshFileTree() : h.projects.openProject("p1");
    await tick();
    h.requests.at(-1).reply({ ...sharedProject(), revision: 8 }); await loading;
    assert.equal(h.editor.isReadOnly(), true, "accepted data clears file unavailability, not global maintenance");
    if (reload === "project load") h.socket().fire("open");
    h.socket().deliver({ t: "opened", fileId: mainFileId, version: 4, doc: "accepted", role: "owner" });
    assert.equal(h.editor.isReadOnly(), true);
    h.socket().deliver({ t: "maintenance", active: false });
    assert.equal(h.editor.isReadOnly(), false, "initial active false also clears a retained pause");
    if (reload === "project load") old.deliver({ t: "maintenance", active: true });
    assert.equal(h.editor.isReadOnly(), false);
    h.edit("accepted edit"); h.window.IrisCollab.flush();
    assert.equal(h.socket().of("push").at(-1).version, 4);
  });
}

test("maintenance resume retains a missing-file lock but other files remain writable", options, async () => {
  const h = harness("en", true); await openShared(h);
  const socket = h.socket();
  socket.deliver({ t: "maintenance", active: true });
  socket.deliver({ t: "file-closed", fileId: mainFileId });
  socket.deliver({ t: "maintenance", active: false });
  assert.equal(h.editor.isReadOnly(), true);
  assert.equal(h.get("stSyncLabel").textContent, h.t("collab.fileUnavailable"));
  h.a.openFile(otherFileId);
  socket.deliver({ t: "opened", fileId: otherFileId, version: 0, doc: "other", role: "owner" });
  assert.equal(h.editor.isReadOnly(), false);
  h.edit("other edited"); h.window.IrisCollab.flush();
  assert.equal(socket.of("push").at(-1).fileId, otherFileId);
  h.a.openFile(mainFileId);
  assert.equal(h.editor.isReadOnly(), true);
});

for (const downgrade of ["role event", "opened viewer"]) {
  test(`maintenance resume checks current permissions after ${downgrade}`, options, async () => {
    const h = harness("en", true); await openShared(h);
    const socket = h.socket();
    socket.deliver({ t: "maintenance", active: true });
    if (downgrade === "role event") socket.deliver({ t: "role", fileId: mainFileId, role: "viewer" });
    else {
      h.a.openFile(otherFileId);
      socket.deliver({ t: "opened", fileId: otherFileId, version: 0, doc: "other", role: "viewer" });
    }
    socket.deliver({ t: "maintenance", active: false });
    assert.equal(h.editor.isReadOnly(), true);
    h.edit("blocked"); h.window.IrisCollab.flush();
    assert.equal(socket.of("push").length, 0);
    h.a.openFile(mainFileId);
    assert.equal(h.editor.isReadOnly(), true, "switching cannot bypass the latest viewer permission");
  });
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
