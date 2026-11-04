const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { uuidv7 } = require("../src/ids");
const { ConcurrencyGate } = require("../src/throttle");
const { createNativeRuntime } = require("../src/pipeline/runtime");
const { createCompilerTools, createCompilerAdapters } = require("../src/pipeline/compilers");
const { createRegistry } = require("../src/pipeline/registry");
const { validatePlan } = require("../src/pipeline/contracts");
const { createRunWorkspace, disposeRunWorkspace } = require("../src/pipeline/workspaces");
const { executePlan } = require("../src/pipeline/executor");
const { validateLayout } = require("../src/pipeline/layout");
const { redPixels } = require("./helpers/pdf-raster.cjs");
const services = require("../src/server");
const native = { skip: process.env.IRIS_TEST_COMPILERS !== "1", timeout: 180000 };

for (const rotation of [0, 90, 180, 270]) test(`rendered cropped PDF with rotation ${rotation} agrees with MediaBox layout points`, native, async t => {
  const { PDFDocument, PDFName, PDFNumber, rgb, degrees } = require("pdf-lib");
  const { extractPdfLayout } = require("../src/pipeline/layout-pdf");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-layout-rotation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const document = await PDFDocument.create(), page = document.addPage([200, 300]);
  page.setMediaBox(10, 20, 200, 300); page.setCropBox(20, 30, 180, 270); page.setRotation(degrees(rotation));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  page.drawRectangle({ x: 30, y: 200, width: 40, height: 50, color: rgb(0, 0, 0) });
  const bytes = await document.save(), pdf = path.join(root, "rotated.pdf"); await fs.writeFile(pdf, bytes);
  const layout = await extractPdfLayout(bytes, { artifact: { id: uuidv7(), contentHash: createHash("sha256").update(bytes).digest("hex"), mediaType: "application/pdf" } });
  assert.equal(layout.coverage, "complete");
  const [raster] = await redPixels(pdf, root, "rotated", "ink");
  assert.ok(raster.red.length > 1000);
  assert.deepEqual([raster.width, raster.height], rotation % 180 ? [600, 400] : [400, 600]);
  for (const [x, y] of raster.red) {
    const [mx, my] = rotation === 0 ? [x + .5, y + .5] : rotation === 90 ? [y + .5, 600 - x - .5]
      : rotation === 180 ? [400 - x - .5, 600 - y - .5] : [400 - y - .5, x + .5];
    assert.ok(layout.pages[0].occupied.some(({ bounds: b }) => mx >= b[0] - 1 && mx <= b[2] + 1 && my >= b[1] - 1 && my <= b[3] + 1));
  }
});

for (const engine of ["pdflatex", "xelatex", "lualatex", "xetex", "lilypond"]) {
  test(`${engine} exposes artifact-bound final layout with navigation disabled`, native, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-layout-native-"));
    let runtime, workspace;
    t.after(async () => {
      await runtime?.close();
      if (workspace) await disposeRunWorkspace(workspace);
      await fs.rm(root, { recursive: true, force: true });
    });
    const family = engine === "lilypond" ? "lilypond" : "latex";
    const main = engine === "lilypond" ? "layout.ly" : engine === "xetex" ? "layout-plain.tex" : "layout.tex";
    const source = path.join(root, "source"); await fs.mkdir(source);
    const files = [main, "layout-image.eps"];
    for (const file of files) await fs.copyFile(path.join(__dirname, "fixtures/pipelines", file), path.join(source, file));
    if (["pdflatex", "xelatex", "lualatex"].includes(engine)) {
      await require("node:util").promisify(require("node:child_process").execFile)("gs",
        ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dEPSCrop", "-sDEVICE=png16m", "-r72", `-sOutputFile=${path.join(source, "layout-image.png")}`, path.join(source, "layout-image.eps")],
        { timeout: 30000 });
      files.push("layout-image.png");
    }
    runtime = await createNativeRuntime({ root: path.join(root, "runtime"), coordinatorId: uuidv7(), tools: createCompilerTools() });
    workspace = await createRunWorkspace({ root: source, files: files.map(file => ({ id: uuidv7(), path: file })), directories: [],
      settings: { projectType: family, sourceMapping: false } }, { root: path.join(root, "runs") });
    const registry = createRegistry(createCompilerAdapters({ ...services, runtime, runId: uuidv7() }));
    const plan = validatePlan({ apiVersion: 1, pluginId: "layout-fixture", steps: [{ id: "compile", adapter: { id: `iris.${family}`, version: "1.0.0" },
      inputs: { source: { snapshot: true } }, options: { main, ...(family === "latex" ? { engine } : {}), sourceMapping: false },
      outputs: { output: { kind: "collection", mediaType: "application/pdf", path: "pdfs" },
        layout: { kind: "collection", mediaType: "application/vnd.iris.layout+json", path: "layouts" } } }],
      targets: { main: { steps: ["compile"], publish: [{ step: "compile", port: "output" }, { step: "compile", port: "layout" }] } },
    }, { registry });
    const result = await executePlan({ plan, target: "main", workspace, registry, gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }) });
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    const [pdfs, layouts] = result.artifacts;
    assert.equal(pdfs.files.length, engine === "lilypond" ? 2 : 1);
    assert.equal(layouts.files.length, pdfs.files.length);
    for (const file of layouts.files) {
      const value = JSON.parse(await fs.readFile(path.join(layouts.root, file.path), "utf8"));
      const pdf = pdfs.files.find(item => item.id === value.artifact.id);
      assert.ok(pdf, "layout must identify its actual immutable PDF artifact");
      const bytes = await fs.readFile(path.join(pdfs.root, pdf.path));
      assert.equal(value.artifact.contentHash, createHash("sha256").update(bytes).digest("hex"));
      const layout = validateLayout(value, { artifact: { ...pdf, mediaType: "application/pdf" } });
      assert.equal(layout.coverage, "complete", JSON.stringify(layout.reasons));
      if (["pdflatex", "xelatex", "lualatex"].includes(engine)) assert.ok(layout.pages.some(page => page.occupied.some(region => region.kind === "image")));
      const rendered = await redPixels(path.join(pdfs.root, pdf.path), root, pdf.id, "ink");
      assert.equal(layout.pageCount, rendered.length);
      for (const raster of rendered) {
        const page = layout.pages[raster.page - 1];
        assert.ok(raster.red.length > 100, "native fixture must render visible content");
        const missed = raster.red.filter(([x, y]) => !page.occupied.some(({ bounds: b }) => x + 0.5 >= b[0] - 1 && x + 0.5 <= b[2] + 1 && y + 0.5 >= b[1] - 1 && y + 0.5 <= b[3] + 1));
        assert.equal(missed.length, 0, `${engine} page ${page.page}: ink outside occupied bounds`);
        const corner = page.occupied.filter(({ bounds: b }) => b[0] <= 10 && b[1] <= 10 && b[2] >= 10 && b[3] >= 10);
        assert.deepEqual(corner, [], `${engine} page ${page.page}: known corner remains free`);
      }
    }
  });
}
