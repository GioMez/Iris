const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { PDFDocument, PDFName, PDFNumber, rgb, degrees } = require("pdf-lib");
const { uuidv7 } = require("../src/ids");
const { composePdf } = require("../src/pipeline/pdf");
const { redPixels } = require("./helpers/pdf-raster.cjs");
const native = { skip: process.env.IRIS_TEST_COMPILERS !== "1", timeout: 60000 };
const identity = bytes => ({ id: uuidv7(), contentHash: createHash("sha256").update(bytes).digest("hex"), mediaType: "application/pdf", bytes });
const pixel = (raster, x, y) => [...raster.pixels.subarray(3 * (y * raster.width + x), 3 * (y * raster.width + x) + 3)];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-compose-render-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return async (bytes, label) => {
    const file = path.join(root, `${label}.pdf`); await fs.writeFile(file, bytes);
    return redPixels(file, root, label, "rgb");
  };
}
function placement(base, artifact, options = {}) {
  return { base: { id: base.id, contentHash: base.contentHash }, artifact,
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 100, height: 80, position: "over", ...options };
}

for (const rotation of [0, 90, 180, 270]) test(`composition renders a cropped ${rotation}-degree layer at physical placement`, native, async t => {
  const render = await fixture(t), document = await PDFDocument.create(); document.addPage([200, 200]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 150]);
  page.setMediaBox(10, 20, 100, 150); page.setCropBox(20, 40, 80, 100); page.setRotation(degrees(rotation));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  // Blue outside the crop must not leak. Red occupies its raw upper-left quarter.
  page.drawRectangle({ x: 10, y: 20, width: 100, height: 150, color: rgb(0, 0, 1) });
  page.drawRectangle({ x: 20, y: 40, width: 80, height: 100, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 20, y: 90, width: 40, height: 50, color: rgb(1, 0, 0) });
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [placement(base, artifact)] });
  const [raster] = await render(result.artifact.bytes, "composed");
  const locations = [[45, 50], [95, 50], [95, 90], [45, 90]];
  for (let i = 0; i < 4; i++) assert.deepEqual(pixel(raster, ...locations[i]), i === rotation / 90 ? [255, 0, 0] : [255, 255, 255]);
  assert.deepEqual(pixel(raster, 15, 50), [255, 255, 255]);
  assert.deepEqual(pixel(raster, 125, 50), [255, 255, 255]);
});

for (const rotation of [0, 90, 180, 270]) test(`imported annotation appearance rotates ${rotation} degrees with its layer`, native, async t => {
  const render = await fixture(t), document = await PDFDocument.create(); document.addPage([200, 200]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 150]), ctx = layer.context;
  page.setMediaBox(10, 20, 100, 150); page.setCropBox(20, 40, 80, 100); page.setRotation(degrees(rotation));
  const appearance = ctx.register(ctx.flateStream("1 0 0 rg 0 50 40 50 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 80, 100], Resources: {} }));
  page.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [20, 40, 100, 140], F: 4, AP: { N: appearance } }))]));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [placement(base, artifact)] });
  const [raster] = await render(result.artifact.bytes, "composed");
  for (const [i, location] of [[45, 50], [95, 50], [95, 90], [45, 90]].entries()) {
    assert.deepEqual(pixel(raster, ...location), i === rotation / 90 ? [255, 0, 0] : [255, 255, 255]);
  }
});

for (const position of ["under", "over"]) test(`imported ${position} annotations keep their order relative to base annotations`, native, async t => {
  const render = await fixture(t), document = await PDFDocument.create(), page = document.addPage([200, 200]);
  function stamp(pdf, page, rect, color) {
    const ctx = pdf.context, appearance = ctx.register(ctx.flateStream(`${color} rg 0 0 100 80 re f`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 80], Resources: {} }));
    page.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: rect, F: 4, AP: { N: appearance } })));
  }
  stamp(document, page, [20, 90, 120, 170], "0 0 1");
  const layer = await PDFDocument.create(), layerPage = layer.addPage([100, 80]); stamp(layer, layerPage, [0, 0, 100, 80], "1 0 0");
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [placement(base, artifact, { position })] });
  const [raster] = await render(result.artifact.bytes, "composed");
  assert.deepEqual(pixel(raster, 50, 50), position === "under" ? [0, 0, 255] : [255, 0, 0]);
});

for (const rotation of [0, 90, 180, 270]) test(`imported ${rotation}-degree stamp appearance respects the source crop boundary`, native, async t => {
  const render = await fixture(t), document = await PDFDocument.create(); document.addPage([200, 200]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context;
  page.setCropBox(20, 20, 60, 60); page.setRotation(degrees(rotation));
  const appearance = ctx.register(ctx.flateStream("1 0 0 rg 0 0 100 100 re f 0 0 1 rg 20 20 60 60 re f",
    { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100], Resources: {} }));
  page.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Stamp", Rect: [0, 0, 100, 100], F: 4, AP: { N: appearance } })));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [placement(base, artifact, { x: 50, y: 50, width: 60, height: 60 })] });
  const [raster] = await render(result.artifact.bytes, "composed");
  assert.deepEqual(pixel(raster, 70, 70), [0, 0, 255], "cropping must not rescale the annotation's original appearance");
  for (const location of [[40, 70], [120, 70], [70, 40], [70, 120]]) assert.deepEqual(pixel(raster, ...location), [255, 255, 255]);
});

for (const rotation of [0, 90, 180, 270]) test(`composition preserves rendered base content outside its layer with target rotation ${rotation}`, native, async t => {
  const render = await fixture(t), document = await PDFDocument.create(), page = document.addPage([200, 300]);
  page.setMediaBox(10, 20, 200, 300); page.setCropBox(20, 30, 180, 270); page.setRotation(degrees(rotation));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  page.drawText("Retained font and content", { x: 40, y: 150, size: 12 });
  page.drawRectangle({ x: 30, y: 200, width: 30, height: 40, color: rgb(0, 0, 0) });
  const layer = await PDFDocument.create(); layer.addPage([10, 10]).drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(1, 0, 0), opacity: .5 });
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [placement(base, artifact, { x: 40, y: 120 })] });
  const [before] = await render(base.bytes, "before"), [after] = await render(result.artifact.bytes, "after");
  assert.deepEqual([after.width, after.height], [before.width, before.height]);
  let changed = 0;
  for (let y = 0; y < after.height; y++) for (let x = 0; x < after.width; x++) {
    const [mx, my] = rotation === 0 ? [x + .5, y + .5] : rotation === 90 ? [y + .5, 600 - x - .5]
      : rotation === 180 ? [400 - x - .5, 600 - y - .5] : [400 - y - .5, x + .5];
    const index = 3 * (y * after.width + x);
    if (!after.pixels.subarray(index, index + 3).equals(before.pixels.subarray(index, index + 3))) {
      changed++;
      assert.ok(mx >= 39 && mx <= 141 && my >= 119 && my <= 201, `changed base pixel ${mx},${my}`);
    }
  }
  assert.ok(changed > 1000);
});

for (const position of ["over", "under"]) test(`composition ${position} layers retain ordered transparency and isolate base graphics state`, native, async t => {
  const render = await fixture(t), document = await PDFDocument.create(), page = document.addPage([200, 200]);
  // Deliberately leave the base CTM translated: the layer must use its own coordinates.
  page.node.addContentStream(document.context.register(document.context.flateStream("1 0 0 1 5 0 cm 0 0 1 rg 25 100 20 70 re f")));
  const layer = await PDFDocument.create(); layer.addPage([10, 10]).drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(1, 0, 0), opacity: .5 });
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [placement(base, artifact, { position }), placement(base, artifact, { position })] });
  const [raster] = await render(result.artifact.bytes, "composed");
  assert.deepEqual(pixel(raster, 35, 50), position === "under" ? [0, 0, 255] : [192, 0, 63]);
  assert.deepEqual(pixel(raster, 70, 50), [255, 63, 63]);
  assert.deepEqual(pixel(raster, 18, 50), [255, 255, 255]);
});

test("composition preserves an isolated transparency group on the imported layer", native, async t => {
  const render = await fixture(t), document = await PDFDocument.create();
  document.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(0, 0, 1) });
  const layer = await PDFDocument.create(), page = layer.addPage([100, 80]);
  page.node.set(PDFName.of("Group"), layer.context.obj({ S: "Transparency", I: true, K: false, CS: "DeviceRGB" }));
  page.node.set(PDFName.of("Resources"), layer.context.obj({ ExtGState: { Blend: { Type: "ExtGState", BM: "Multiply" } } }));
  page.node.addContentStream(layer.context.register(layer.context.flateStream("/Blend gs 1 0 0 rg 0 0 100 80 re f")));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [placement(base, artifact)] });
  const [raster] = await render(result.artifact.bytes, "composed");
  assert.deepEqual(pixel(raster, 50, 50), [255, 0, 0]);
  assert.deepEqual(pixel(raster, 10, 10), [0, 0, 255]);
});

for (const family of ["latex", "lilypond"]) test(`composed ${family} output retains native forward and inverse navigation`, native, async t => {
  const { ConcurrencyGate } = require("../src/throttle");
  const { createRegistry } = require("../src/pipeline/registry");
  const { validatePlan } = require("../src/pipeline/contracts");
  const { createRunWorkspace, disposeRunWorkspace } = require("../src/pipeline/workspaces");
  const { createNativeRuntime } = require("../src/pipeline/runtime");
  const { createCompilerTools, createCompilerAdapters } = require("../src/pipeline/compilers");
  const { createPdfTool, createPdfAdapter } = require("../src/pipeline/pdf-runner");
  const { createRunMappingCollector, createNavigationTools, navigateCompilerMapping } = require("../src/pipeline/navigation");
  const { executePlan } = require("../src/pipeline/executor");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-compose-native-")), source = path.join(root, "source");
  let runtime, workspace;
  t.after(async () => { await runtime?.close(); if (workspace) await disposeRunWorkspace(workspace); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(source);
  const main = family === "latex" ? "main.tex" : "main.ly", sourceId = uuidv7(), runId = uuidv7(), projectId = uuidv7();
  await fs.writeFile(path.join(source, main), family === "latex"
    ? "\\documentclass{article}\n\\begin{document}\nMapped composition text.\n\\end{document}\n"
    : '\\version "2.26.0"\n\\score { \\new Staff {\nc\'1 d\'1\n} }\n');
  workspace = await createRunWorkspace({ root: source, files: [{ id: sourceId, path: main, sourceRevisionId: uuidv7() }], directories: [], settings: { projectType: family } }, { root: path.join(root, "runs") });
  runtime = await createNativeRuntime({ root: path.join(root, "runtime"), coordinatorId: uuidv7(), tools: [...createCompilerTools(), createPdfTool(), ...createNavigationTools()] });
  const compiled = new Map(), composed = new Map(), collector = createRunMappingCollector({ projectId, runId });
  const layer = await PDFDocument.create(); layer.addPage([10, 10]).drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(1, 0, 0) });
  const layerBytes = await layer.save(); let originalProducts;
  const registry = createRegistry([
    ...createCompilerAdapters({ ...require("../src/server"), runtime, runId, onCompiled: (context, value) => compiled.set(context.step.id, value) }),
    createPdfAdapter({ runtime, runId, onComposed: (context, value) => composed.set(context.step.id, value) }),
    { id: "test.layer", version: "1.0.0", implementationHash: "a".repeat(64), outputs: { output: { kinds: ["file"], mediaTypes: ["application/pdf"], required: true } },
      execute: context => fs.writeFile(path.join(context.outputDir, "layer.pdf"), layerBytes) },
    { id: "test.place", version: "1.0.0", implementationHash: "b".repeat(64), inputs: { base: { kinds: ["file"], mediaTypes: ["application/pdf"], required: true },
      layer: { kinds: ["file"], mediaTypes: ["application/pdf"], required: true } }, outputs: { output: { kinds: ["file"], mediaTypes: ["application/json"], required: true } },
      execute: context => {
        const base = context.inputs.base, layer = context.inputs.layer;
        return fs.writeFile(path.join(context.outputDir, "placements.json"), JSON.stringify({ version: 1, base: { id: base.id, contentHash: base.contentHash },
          layers: [{ artifact: { id: layer.id, contentHash: layer.contentHash }, page: 1, sourcePage: 1, units: "pdf-point", x: 5, y: 5, width: 10, height: 10, position: "over" }] }));
      } },
  ]);
  const output = (mediaType, file) => ({ kind: "file", mediaType, path: file }), ref = (step, port = "output") => ({ step, port });
  const plan = validatePlan({ apiVersion: 1, pluginId: "composition-native", steps: [
    { id: "compile", adapter: { id: `iris.${family}`, version: "1.0.0" }, inputs: { source: { snapshot: true } }, options: { main, sourceMapping: true }, outputs: { output: output("application/pdf", "base.pdf") } },
    { id: "layer", adapter: { id: "test.layer", version: "1.0.0" }, outputs: { output: output("application/pdf", "layer.pdf") } },
    { id: "place", adapter: { id: "test.place", version: "1.0.0" }, inputs: { base: ref("compile"), layer: ref("layer") }, outputs: { output: output("application/json", "placements.json") } },
    { id: "compose", adapter: { id: "iris.pdf-compose", version: "1.0.0" }, inputs: { base: ref("compile"), layers: ref("layer"), placements: ref("place") }, outputs: { output: output("application/pdf", "composed.pdf") } },
  ], targets: { main: { steps: ["compose"], publish: [ref("compose")] } } }, { registry });
  const result = await executePlan({ plan, target: "main", workspace, registry, gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }),
    onArtifacts: async (context, products) => {
      if (compiled.has(context.step.id)) { originalProducts = products; await collector.collect({ context, products, compiled: compiled.get(context.step.id) }); }
      if (composed.has(context.step.id)) collector.collectComposition({ context, products, relation: composed.get(context.step.id) });
    } });
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  const navigation = collector.assemble(result.artifacts), original = collector.assemble(originalProducts);
  assert.equal(navigation.manifest.artifacts[0].status, "ready", JSON.stringify(navigation.manifest));
  assert.equal(navigation.manifest.artifacts[0].contentHash, result.artifacts[0].contentHash);
  const query = { direction: "forward", sourceFileId: sourceId, line: 3, column: 0 };
  const before = await navigateCompilerMapping({ navigation: original, products: originalProducts, runtime, projectId, runId, query, enabled: true });
  const after = await navigateCompilerMapping({ navigation, products: result.artifacts, runtime, projectId, runId, query, enabled: true });
  assert.equal(before.status, "ready", JSON.stringify(before)); assert.equal(after.status, "ready", JSON.stringify(after));
  assert.deepEqual(after.matches.map(({ artifactId, ...item }) => item), before.matches.map(({ artifactId, ...item }) => item));
  assert.ok(after.matches.every(item => item.artifactId === result.artifacts[0].id));
  const selected = after.matches[0];
  const inverse = await navigateCompilerMapping({ navigation, products: result.artifacts, runtime, projectId, runId, enabled: true,
    query: { direction: "inverse", artifactId: selected.artifactId, page: selected.page, x: selected.x, y: selected.y } });
  assert.equal(inverse.status, "ready", JSON.stringify(inverse));
  assert.ok(inverse.matches.some(item => item.sourceFileId === sourceId && item.line === 3));
  const retainedProducts = [...originalProducts, ...result.artifacts], retained = collector.assemble(retainedProducts);
  const both = await navigateCompilerMapping({ navigation: retained, products: retainedProducts, runtime, projectId, runId, query, enabled: true });
  assert.equal(both.status, "ready", JSON.stringify(both));
  assert.deepEqual(new Set(both.matches.map(item => item.artifactId)), new Set(retainedProducts.map(product => product.id)));
  const changed = result.artifacts.map(product => ({ ...product, files: product.files.map(file => ({ ...file, contentHash: "0".repeat(64) })) }));
  assert.equal(collector.assemble(changed).manifest.reason, "stale-artifact");
  assert.deepEqual((await fs.readdir(result.artifacts[0].root)), ["composed.pdf"]);
});
