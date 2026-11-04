const test = require("node:test");
const assert = require("node:assert/strict");
const { validateLayout } = require("../src/pipeline/layout");

const artifact = { id: "019a4b00-0000-7000-8000-000000000001", contentHash: "a".repeat(64), mediaType: "application/pdf" };
function manifest() {
  return { version: 1, artifact: { id: artifact.id, contentHash: artifact.contentHash },
    units: "pdf-point", origin: "media-box-top-left", collector: { id: "mupdf", version: "1.28.1" },
    coverage: "complete", reasons: [], pageCount: 1, pages: [{ page: 1,
      mediaBox: [10, 20, 210, 320], cropBox: [20, 30, 200, 300], rotation: 90, userUnit: 2,
      width: 400, height: 600, coverage: "complete", reasons: [],
      occupied: [{ kind: "path", bounds: [20, 40, 80, 100] }],
    }] };
}

test("layout preserves fractional physical coordinates and detaches mutable collector data", () => {
  const value = manifest(); value.pages[0].occupied[0].bounds[0] = 20.125;
  const result = validateLayout(value, { artifact, requirements: ["layout.occupied.complete"] });
  value.pages[0].occupied[0].bounds[0] = 999;
  assert.equal(result.pages[0].occupied[0].bounds[0], 20.125);
  assert.deepEqual(result.pages[0].mediaBox, [10, 20, 210, 320]);
  assert.ok(Object.isFrozen(result.pages[0].occupied[0].bounds));
});

for (const [label, change] of [
  ["different PDF digest", m => { m.artifact.contentHash = "b".repeat(64); }],
  ["different PDF identity", m => { m.artifact.id = "019a4b00-0000-7000-8000-000000000002"; }],
  ["mixed units", m => { m.pages[0].units = "mm"; }],
  ["wrong coordinate origin", m => { m.origin = "crop-box-top-left"; }],
  ["unsupported version", m => { m.version = 2; }],
  ["zero page index", m => { m.pages[0].page = 0; }],
  ["fractional page index", m => { m.pages[0].page = 1.5; }],
  ["missing physical page", m => { m.pageCount = 2; }],
  ["duplicate physical page", m => { m.pageCount = 2; m.pages.push(structuredClone(m.pages[0])); }],
  ["nonfinite bounds", m => { m.pages[0].occupied[0].bounds[0] = Infinity; }],
  ["inverted bounds", m => { m.pages[0].occupied[0].bounds[2] = 0; }],
  ["bounds outside MediaBox", m => { m.pages[0].occupied[0].bounds[2] = 401; }],
  ["unscaled page dimensions", m => { m.pages[0].width = 200; }],
  ["empty MediaBox", m => { m.pages[0].mediaBox[2] = 10; }],
  ["invalid rotation", m => { m.pages[0].rotation = 45; }],
  ["zero UserUnit", m => { m.pages[0].userUnit = 0; }],
  ["complete page despite collector error", m => { m.pages[0].reasons = ["collector-error"]; }],
  ["complete document despite partial page", m => { m.pages[0].coverage = "partial"; m.pages[0].reasons = ["unsupported-operator"]; }],
  ["partial coverage without reason", m => { m.coverage = m.pages[0].coverage = "partial"; }],
  ["unavailable page carrying usable bounds", m => { m.coverage = m.pages[0].coverage = "unavailable"; m.reasons = m.pages[0].reasons = ["collector-error"]; }],
]) test(`layout rejects ${label}`, () => {
  const value = manifest(); change(value);
  assert.throws(() => validateLayout(value, { artifact }), { code: "PIPELINE_LAYOUT_INVALID" });
});

test("partial occupied geometry remains inspectable but cannot satisfy a complete-layout requirement", () => {
  const value = manifest();
  value.coverage = value.pages[0].coverage = "partial";
  value.reasons = value.pages[0].reasons = ["unsupported-operator"];
  assert.equal(validateLayout(value, { artifact }).pages[0].occupied.length, 1);
  assert.throws(() => validateLayout(value, { artifact, requirements: ["layout.occupied.complete"] }), { code: "PIPELINE_LAYOUT_CAPABILITY_UNAVAILABLE" });
  assert.throws(() => validateLayout(manifest(), { artifact, requirements: ["layout.music.systems"] }), { code: "PIPELINE_LAYOUT_CAPABILITY_UNAVAILABLE" });
});

test("an unavailable PDF cannot masquerade as an empty complete document", () => {
  const value = manifest();
  Object.assign(value, { coverage: "unavailable", reasons: ["collector-error"], pageCount: null, pages: [] });
  assert.equal(validateLayout(value, { artifact }).coverage, "unavailable");
  value.coverage = "complete"; value.reasons = [];
  assert.throws(() => validateLayout(value, { artifact }), { code: "PIPELINE_LAYOUT_INVALID" });
});

test("layout metadata bounds reject oversized data and getters without executing authored code", () => {
  assert.throws(() => validateLayout(manifest(), { artifact, policy: { maxPlanBytes: 100 } }), { code: "PIPELINE_LAYOUT_INVALID" });
  const value = manifest(); let called = false;
  Object.defineProperty(value.pages[0], "occupied", { enumerable: true, get() { called = true; return []; } });
  assert.throws(() => validateLayout(value, { artifact }), { code: "PIPELINE_LAYOUT_INVALID" });
  assert.equal(called, false);
});

test("layout collection requires a successful compiler pass and preserves failure coverage", () => {
  const { collectLayout } = require("../src/pipeline/layout");
  const compilerResult = { code: 0, signal: null, timedOut: false };
  assert.equal(collectLayout({ compilerResult, artifact, collectorData: manifest() }).coverage, "complete");
  for (const failed of [{ code: 1 }, { code: 0, signal: "SIGKILL" }, { code: 0, timedOut: true }]) {
    assert.throws(() => collectLayout({ compilerResult: failed, artifact, collectorData: manifest() }), { code: "PIPELINE_LAYOUT_COMPILE_FAILED" });
  }
  const unavailable = collectLayout({ compilerResult, artifact, collectorData: null });
  assert.equal(unavailable.coverage, "unavailable");
  assert.deepEqual(unavailable.reasons, ["collector-error"]);
  assert.deepEqual(unavailable.pages, []);
});

test("PDF drawing extraction reports actual occupied geometry without source-navigation data", async () => {
  const { PDFDocument, rgb } = require("pdf-lib");
  const { createHash } = require("node:crypto");
  const { extractPdfLayout } = require("../src/pipeline/layout-pdf");
  const pdf = await PDFDocument.create(), page = pdf.addPage([200, 300]);
  page.drawRectangle({ x: 20, y: 180, width: 30, height: 40, color: rgb(0, 0, 0) });
  const bytes = await pdf.save(), input = { ...artifact, contentHash: createHash("sha256").update(bytes).digest("hex") };
  const result = await extractPdfLayout(bytes, { artifact: input });
  assert.equal(result.coverage, "complete");
  assert.equal(result.pageCount, 1);
  assert.ok(result.pages[0].occupied.some(({ bounds: b }) => b[0] <= 20 && b[1] <= 80 && b[2] >= 50 && b[3] >= 120));
  assert.ok(result.pages[0].occupied.every(({ bounds: b }) => b[2] < 100 && b[3] < 200));
  await assert.rejects(extractPdfLayout(bytes, { artifact }), { code: "PIPELINE_LAYOUT_INVALID" });
});

for (const rotation of [0, 90, 180, 270]) test(`PDF layout removes ${rotation}-degree display rotation and preserves physical MediaBox coordinates`, async () => {
  const { PDFDocument, PDFName, PDFNumber, rgb, degrees } = require("pdf-lib");
  const { createHash } = require("node:crypto");
  const { extractPdfLayout } = require("../src/pipeline/layout-pdf");
  const pdf = await PDFDocument.create(), page = pdf.addPage([200, 300]);
  page.setMediaBox(10, 20, 200, 300); page.setCropBox(20, 30, 180, 270); page.setRotation(degrees(rotation));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  page.drawRectangle({ x: 30, y: 200, width: 40, height: 50, color: rgb(0, 0, 0) });
  const bytes = await pdf.save(), input = { ...artifact, contentHash: createHash("sha256").update(bytes).digest("hex") };
  const result = await extractPdfLayout(bytes, { artifact: input });
  assert.equal(result.coverage, "complete");
  assert.deepEqual(result.pages[0].mediaBox, [10, 20, 210, 320]);
  assert.deepEqual(result.pages[0].cropBox, [20, 30, 200, 300]);
  assert.equal(result.pages[0].rotation, rotation);
  assert.deepEqual([result.pages[0].width, result.pages[0].height], [400, 600]);
  assert.deepEqual(result.pages[0].occupied, [{ kind: "path", bounds: [40, 140, 120, 240] }]);
});

test("malformed PDF bytes report unavailable coverage and extraction limits never return truncated complete data", async () => {
  const { PDFDocument, rgb } = require("pdf-lib");
  const { createHash } = require("node:crypto");
  const { extractPdfLayout } = require("../src/pipeline/layout-pdf");
  const broken = Buffer.from("%PDF-1.7\ninvalid"), identity = bytes => ({ ...artifact, contentHash: createHash("sha256").update(bytes).digest("hex") });
  assert.equal((await extractPdfLayout(broken, { artifact: identity(broken) })).coverage, "unavailable");
  const pdf = await PDFDocument.create(), page = pdf.addPage([200, 300]);
  for (let i = 0; i < 50; i++) page.drawRectangle({ x: i, y: i, width: 1, height: 1, color: rgb(0, 0, 0) });
  const bytes = await pdf.save();
  await assert.rejects(extractPdfLayout(bytes, { artifact: identity(bytes), policy: { maxValues: 100 } }), { code: "PIPELINE_LAYOUT_LIMIT" });
});

for (const feature of ["group", "mask", "tile"]) test(`unqualified PDF ${feature} drawing cannot claim complete occupancy`, async () => {
  const { PDFDocument, PDFName } = require("pdf-lib");
  const { createHash } = require("node:crypto");
  const { extractPdfLayout } = require("../src/pipeline/layout-pdf");
  const pdf = await PDFDocument.create(), page = pdf.addPage([200, 300]), ctx = pdf.context;
  const group = ctx.register(ctx.flateStream("0 0 40 40 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 40, 40],
    Resources: {}, Group: { S: "Transparency", I: true, K: false } }));
  let commands, resources;
  if (feature === "group") {
    resources = { XObject: { Layer: group } }; commands = "q 1 0 0 1 20 100 cm /Layer Do Q";
  } else if (feature === "mask") {
    resources = { ExtGState: { Mask: { Type: "ExtGState", SMask: { S: "Luminosity", G: group } } } };
    commands = "q /Mask gs 0 0 80 80 re f Q";
  } else {
    const tile = ctx.register(ctx.flateStream("1 0 0 rg 0 0 5 5 re f", { Type: "Pattern", PatternType: 1, PaintType: 1,
      TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {} }));
    resources = { Pattern: { Tile: tile } }; commands = "/Pattern cs /Tile scn 10 10 100 100 re f";
  }
  page.node.set(PDFName.of("Resources"), ctx.obj(resources));
  page.node.addContentStream(ctx.register(ctx.flateStream(commands)));
  const bytes = await pdf.save(), input = { ...artifact, contentHash: createHash("sha256").update(bytes).digest("hex") };
  const result = await extractPdfLayout(bytes, { artifact: input });
  assert.equal(result.coverage, "partial");
  assert.ok(result.reasons.includes(`unqualified-${feature}`));
  assert.throws(() => validateLayout(result, { artifact: input, requirements: ["layout.occupied.complete"] }), { code: "PIPELINE_LAYOUT_CAPABILITY_UNAVAILABLE" });
});

for (const damage of ["none", "pdf", "layout"]) test(`output validation binds layout to checked PDF bytes (${damage})`, async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const { createHash } = require("node:crypto");
  const { createRunWorkspace, materializeInputs, reserveOutputId, validateOutputs, disposeRunWorkspace } = require("../src/pipeline/workspaces");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-layout-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); await fs.mkdir(source);
  const workspace = await createRunWorkspace({ root: source, files: [], directories: [], settings: {} }, { root: path.join(root, "runs") });
  t.after(() => disposeRunWorkspace(workspace));
  const step = { id: "compile", inputs: {}, outputs: { output: { kind: "file", mediaType: "application/pdf", path: "result.pdf" },
    layout: { kind: "layout", mediaType: "application/vnd.iris.layout+json", path: "layout.json" } } };
  const context = await materializeInputs(workspace, step, new Map());
  const bytes = Buffer.from("checked artifact fixture"), id = reserveOutputId(context, "output", "result.pdf");
  const value = manifest(); value.artifact = { id, contentHash: createHash("sha256").update(bytes).digest("hex") };
  await fs.writeFile(path.join(context.outputDir, "result.pdf"), damage === "pdf" ? Buffer.from("changed artifact fixture") : bytes);
  if (damage === "layout") value.artifact.id = artifact.id;
  await fs.writeFile(path.join(context.outputDir, "layout.json"), JSON.stringify(value));
  if (damage !== "none") await assert.rejects(validateOutputs(workspace, step), { code: "PIPELINE_LAYOUT_INVALID" });
  else {
    const [pdf] = await validateOutputs(workspace, step);
    assert.equal(pdf.id, id); assert.equal(pdf.contentHash, value.artifact.contentHash);
  }
});
