const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PDFDocument, rgb } = require("pdf-lib");
const { uuidv7 } = require("../src/ids");
const { createNativeRuntime } = require("../src/pipeline/runtime");
const { createLayoutTool, layoutImplementationHash, runLayoutCollector } = require("../src/pipeline/layout-runner");
const { until } = require("../scripts/lib/disposable.cjs");

test("repeated PDF shading keeps borrowed MuPDF resources alive through extraction", { timeout: 20000 }, async t => {
  const { PDFName } = require("pdf-lib");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-layout-shading-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pdf = await PDFDocument.create(), ctx = pdf.context;
  const shade = ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: "DeviceRGB", Coords: [0, 0, 100, 0], Extend: [true, true],
    Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 } }));
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage([200, 300]);
    page.node.set(PDFName.of("Resources"), ctx.obj({ Shading: { Gradient: shade } }));
    page.node.addContentStream(ctx.register(ctx.flateStream("q 10 20 80 90 re W n /Gradient sh Q q 100 150 50 50 re W n /Gradient sh Q")));
  }
  const bytes = await pdf.save(), source = path.join(root, "input.pdf"), output = path.join(root, "layout.json");
  await fs.writeFile(source, bytes);
  await require("node:util").promisify(require("node:child_process").execFile)(process.execPath,
    [path.resolve(__dirname, "../src/pipeline/layout-process.js"), source, output, uuidv7(), createHash("sha256").update(bytes).digest("hex"), String(bytes.length)],
    { timeout: 10000 });
  const layout = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(layout.coverage, "complete");
  assert.equal(layout.pageCount, 2);
  for (const page of layout.pages) assert.deepEqual(page.occupied, [
    { kind: "shade", bounds: [10, 190, 90, 280] }, { kind: "shade", bounds: [100, 100, 150, 150] },
  ]);
});

for (const mode of ["timeout", "cancel", "changed-collector", "size-limit"]) test(`layout collector ${mode} publishes no layout and drains its native workspace`, { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-layout-runtime-"));
  let runtime;
  t.after(async () => { await runtime?.close(); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"); await fs.mkdir(source);
  const pdf = await PDFDocument.create();
  for (let i = 0; i < (mode === "cancel" ? 100 : 1); i++) {
    const page = pdf.addPage([200, 300]);
    for (let j = 0; j < 50; j++) page.drawRectangle({ x: j, y: j, width: 20, height: 20, color: rgb(0, 0, 0) });
  }
  const bytes = await pdf.save(), contentHash = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(source, "input.pdf"), bytes);
  runtime = await createNativeRuntime({ root: path.join(root, "runtime"), coordinatorId: uuidv7(), tools: [createLayoutTool(mode === "timeout" ? 1 : 10000)] });
  const worker = await runtime.createWorkspace({ runId: uuidv7(), stepId: "layout", input: { root: source,
    files: [{ path: "input.pdf", size: bytes.length, contentHash }], directories: [] } });
  const controller = new AbortController(), destination = path.join(root, "layout.json");
  const operation = runLayoutCollector({ runtime, worker, compilerResult: { code: 0 },
    artifact: { id: uuidv7(), contentHash, mediaType: "application/pdf" }, source: path.join(worker.inputRoot, "input.pdf"), destination,
    maxArtifactBytes: mode === "size-limit" ? bytes.length - 1 : bytes.length,
    implementationHash: mode === "changed-collector" ? "0".repeat(64) : layoutImplementationHash(), signal: controller.signal });
  const rejected = assert.rejects(operation, mode === "cancel" ? { name: "AbortError" }
    : { code: mode === "changed-collector" ? "PIPELINE_ADAPTER_CHANGED" : "PIPELINE_LAYOUT_FAILED" });
  if (mode === "cancel") {
    await until(async () => JSON.parse(await fs.readFile(path.join(root, "runtime", `${worker.id}.json`), "utf8")).pid !== null, "active layout process", 5000);
    controller.abort();
  }
  await rejected;
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "runtime", `${worker.id}.json`), "utf8")).phase, "idle");
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  await runtime.disposeWorkspace(worker);
  assert.deepEqual(await fs.readdir(path.join(root, "runtime")), ["installation.json"]);
});
