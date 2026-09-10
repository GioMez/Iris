const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const options = { timeout: 2000 };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

// The real preview flow, with only PDF decoding/painting and browser layout
// replaced. Removing the pages clamps scroll offsets just as a browser does.
function harness() {
  const nodes = new Map();
  let hidden = false, scrollTop = 0, scrollLeft = 0;
  function element(tag = "div") {
    const classes = new Set();
    const events = new Map();
    const node = {
      tag, children: [], dataset: {}, style: {}, textContent: "",
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); }, toggle(name, on) {
          if (on) classes.add(name); else classes.delete(name);
          if (node === get("pvStage") && name === "hide-pages") {
            hidden = on;
            if (on) scrollTop = scrollLeft = 0;
          }
        } },
      setAttribute() {}, addEventListener(type, fn) { events.set(type, fn); },
      querySelector: (tag) => node.children.find((child) => child.tag === tag), querySelectorAll: () => [],
      appendChild(child) { child.parent = node; node.children.push(child); },
      replaceChildren(...children) { node.children = []; children.forEach((child) => node.appendChild(child)); },
      getContext: () => ({}),
      parentElement: { classList: { add() {}, remove() {} } },
    };
    Object.defineProperties(node, {
      innerHTML: { set() { node.children = []; if (node === get("pvPages")) scrollTop = scrollLeft = 0; } },
      offsetHeight: { get() {
        if (hidden) return 0;
        if (node.style.height) return parseFloat(node.style.height);
        const image = node.querySelector("img");
        return image ? (parseFloat(node.style.width) - 60) * image.naturalHeight / image.naturalWidth + 60 : 0;
      } },
      offsetTop: { get() {
        const siblings = node.parent?.children || [];
        return 26 + siblings.slice(0, siblings.indexOf(node)).reduce((sum, sibling) => sum + sibling.offsetHeight + 22, 0);
      } },
      src: { set() { queueMicrotask(() => events.get("load")?.()); } },
    });
    if (tag === "img") { node.naturalWidth = 600; node.naturalHeight = 940; }
    return node;
  }
  function get(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }
  const stage = get("pvStage");
  stage.clientWidth = 652; stage.clientHeight = 700;
  Object.defineProperties(stage, {
    scrollTop: { get: () => scrollTop, set: (n) => { scrollTop = Math.max(0, Math.min(n, stage.scrollHeight - stage.clientHeight)); } },
    scrollLeft: { get: () => scrollLeft, set: (n) => { scrollLeft = Math.max(0, Math.min(n, stage.scrollWidth - stage.clientWidth)); } },
    scrollHeight: { get: () => hidden ? 0 : 52 + get("pvPages").children.reduce((sum, child, i) => sum + child.offsetHeight + (i ? 22 : 0), 0) },
    scrollWidth: { get: () => Math.max(stage.clientWidth, ...get("pvPages").children.map((child) => (parseFloat(child.style.width) || 0) + 52)) },
  });
  stage.scrollTo = ({ top, left = stage.scrollLeft }) => { stage.scrollTop = top; stage.scrollLeft = left; };
  let nextDocument, loadingGate = null, paintGate = null;
  const pdfjs = { GlobalWorkerOptions: {}, getDocument() {
    const doc = nextDocument;
    return { promise: loadingGate ? loadingGate.promise.then(() => doc) : Promise.resolve(doc), destroy: async () => {} };
  } };
  const context = vm.createContext({
    document: { getElementById: get, createElement: element, addEventListener() {}, querySelector: get, querySelectorAll: () => [] },
    window: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
      IrisI18n: { t: (key) => key, ready: new Promise(() => {}), formatDate: () => "today" },
      IrisIcons: { icon: () => "" }, IrisDiagnostics: { renderList() {} },
      IrisEditor: { getValue: () => "", setDiagnostics() {} },
      IrisCollab: { disconnect() {} },
    },
    getComputedStyle: () => ({ paddingTop: "26px" }),
    pdfjs, console, URL, Blob, Uint8Array, ArrayBuffer, atob, performance, setTimeout, clearTimeout,
  });
  let source = fs.readFileSync(path.join(__dirname, "../public/iris-app.js"), "utf8")
    .replace('import("/vendor/pdfjs/pdf.min.mjs")', "Promise.resolve(pdfjs)");
  const end = source.lastIndexOf("})();");
  source = source.slice(0, end) + "window.previewTest = { state, renderPdf, renderCompiledOutput, layoutPdfPages, layoutImagePages, setView, onStageScroll, gotoPage, compile, previewImage };\n" + source.slice(end);
  vm.runInContext(source, context, { filename: "iris-app.js" });
  const { state } = context.window.previewTest;
  state.fit = false; state.zoom = 0.75; // 1 PDF point = 1 CSS pixel.
  return {
    ...context.window.previewTest, app: context.window.IrisApp, stage, get,
    pdf(count, { width = 600, height = 1000, loading = null, painting = null } = {}) {
      loadingGate = loading; paintGate = painting;
      const capturedPaint = paintGate;
      nextDocument = { numPages: count, async getPage() { return {
        getViewport: ({ scale }) => ({ scale, width: width * scale, height: height * scale }),
        render: () => ({ promise: capturedPaint?.promise || Promise.resolve(), cancel() {} }),
      }; } };
      return { outputFormat: "pdf", artifacts: [{ name: "main.pdf", bytes: new Uint8Array([1]), mimeType: "application/pdf" }] };
    },
    images(format, count) { return { outputFormat: format, artifacts: Array.from({ length: count }, (_, i) => ({
      name: `main-${i + 1}.${format}`, bytes: new Uint8Array([1]), mimeType: `image/${format}`,
    })) }; },
    scroll(page, fraction = 0) {
      stage.scrollTop = state.pages[page - 1].offsetTop - 26 + fraction * state.pages[page - 1].offsetHeight;
      context.window.previewTest.onStageScroll();
    },
    assertPosition(page, fraction) {
      assert.equal(state.curPage, page);
      assert.ok(Math.abs(stage.scrollTop - (state.pages[page - 1].offsetTop - 26 + fraction * state.pages[page - 1].offsetHeight)) < 1,
        `unexpected scroll offset ${stage.scrollTop} on page ${page}`);
    },
  };
}

test("a recompiled PDF keeps the page and the relative reading position", options, async () => {
  const h = harness();
  await h.renderPdf(h.pdf(12));
  h.scroll(8, 0.35);
  await h.renderPdf(h.pdf(12, { height: 1200 }));
  h.assertPosition(8, 0.35);
});

test("a shorter PDF clamps the retained page to the last available one", options, async () => {
  const h = harness();
  await h.renderPdf(h.pdf(12));
  h.scroll(8, 0.2);
  await h.renderPdf(h.pdf(3));
  h.assertPosition(3, 0.2);
});

for (const format of ["png", "svg"]) {
  test(`recompiled LilyPond ${format} pages retain the same reading position`, options, async () => {
    const h = harness();
    await h.renderCompiledOutput(h.images(format, 8));
    h.scroll(5, 0.3);
    await h.renderCompiledOutput(h.images(format, 7));
    h.assertPosition(5, 0.3);
  });
}

test("Log and Diagnostics do not replace the saved PDF scroll position", options, async () => {
  for (const tab of ["log", "diagnostics"]) {
    const h = harness();
    await h.renderPdf(h.pdf(8));
    h.scroll(5, 0.3);
    h.setView(tab);
    h.onStageScroll(); // The browser clamps scroll when the page surface is hidden.
    await h.renderPdf(h.pdf(8));
    h.setView("preview");
    h.assertPosition(5, 0.3);
  }
});

test("restores reading position before slow canvas painting completes", options, async () => {
  const h = harness();
  await h.renderPdf(h.pdf(8));
  h.scroll(5, 0.3);
  const painting = deferred();
  const render = h.renderPdf(h.pdf(8, { painting }));
  await tick();
  h.assertPosition(5, 0.3);
  painting.resolve();
  await render;
});

test("an obsolete PDF load cannot reset the newest preview's position", options, async () => {
  const h = harness();
  await h.renderPdf(h.pdf(8));
  h.scroll(5, 0.3);
  const loading = deferred();
  const old = h.renderPdf(h.pdf(12, { loading }));
  await tick();
  await h.renderPdf(h.pdf(6));
  h.assertPosition(5, 0.3);
  loading.resolve();
  await old;
  h.assertPosition(5, 0.3);
  assert.equal(h.state.pages.length, 6);
});

test("explicitly clearing the output resets the retained reading position", options, async () => {
  const h = harness();
  await h.renderPdf(h.pdf(8));
  h.scroll(5, 0.3);
  await h.app.clearBuildOutput();
  await h.renderPdf(h.pdf(8));
  h.assertPosition(1, 0);
});
