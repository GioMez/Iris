const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const { PDFDocument, PDFName, PDFString } = require("pdf-lib");
const { uuidv7 } = require("../src/ids");
const { composePdf } = require("../src/pipeline/pdf");
const { workspace } = require("../scripts/lib/disposable.cjs");
const { withBrowser } = require("../scripts/lib/browser.cjs");

test("PDF.js mounts imported links and independent fillable layers and saves edited values", {
  skip: process.env.IRIS_TEST_BROWSER !== "1", timeout: 30000,
}, async t => {
  const document = await PDFDocument.create(), basePage = document.addPage([400, 400]);
  const existing = document.getForm().createTextField("answer"); existing.setText("Base"); existing.addToPage(basePage, { x: 10, y: 10, width: 100, height: 20 });
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]);
  const field = layer.getForm().createTextField("answer"); field.setText("Imported"); field.addToPage(page, { x: 10, y: 50, width: 80, height: 20 });
  field.acroField.dict.set(PDFName.of("DV"), PDFString.of("Imported"));
  const link = layer.context.register(layer.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 80, 30], Border: [0, 0, 0],
    A: { S: "URI", URI: PDFString.of("https://example.test/logo") } }));
  page.node.addAnnot(link);
  page.node.addAnnot(layer.context.register(layer.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 32, 80, 45],
    Border: [0, 0, 0], A: { S: "ResetForm" } })));
  const identify = bytes => ({ id: uuidv7(), contentHash: createHash("sha256").update(bytes).digest("hex"), mediaType: "application/pdf", bytes });
  const base = identify(await document.save()), artifact = identify(await layer.save());
  const result = await composePdf({ base, layers: [20, 210].map(x => ({ base: { id: base.id, contentHash: base.contentHash }, artifact,
    sourcePage: 1, page: 1, units: "pdf-point", x, y: 30, width: 160, height: 160, position: "over" })) });
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const routes = new Map(await Promise.all(["build/pdf.mjs", "build/pdf.worker.mjs", "web/pdf_viewer.mjs", "web/pdf_viewer.css"].map(async file => [`/${file}`, await fs.readFile(path.join(root, file))])));
  const server = http.createServer((req, res) => {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><link rel="stylesheet" href="/web/pdf_viewer.css"><div id="page" style="position:relative;--scale-factor:1;--total-scale-factor:1;--user-unit:1;--scale-round-x:1px;--scale-round-y:1px"><canvas></canvas><div class="annotationLayer"></div></div>'); return; }
    const bytes = routes.get(req.url);
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", req.url.endsWith(".css") ? "text/css" : "text/javascript"); res.end(bytes);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const work = await workspace("iris-pdf-annotations-browser-");
  t.after(() => work.close());
  await withBrowser(work, { channel: "chrome" }, async browser => {
    t.diagnostic(`Browser ${browser.version()}; PDF.js ${require("pdfjs-dist/package.json").version}; isolated annotation fixture`);
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const annotations = await page.evaluate(async bytes => {
      const pdfjs = globalThis.pdfjsLib = await import("/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/build/pdf.worker.mjs";
      const { SimpleLinkService } = await import("/web/pdf_viewer.mjs");
      const task = window.pdfTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
      const pdf = window.pdf = await task.promise;
      const page = await pdf.getPage(1), viewport = page.getViewport({ scale: 1 }), canvas = document.querySelector("canvas");
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise;
      const annotations = await page.getAnnotations(), layer = new pdfjs.AnnotationLayer({ div: document.querySelector(".annotationLayer"),
        page, viewport: viewport.clone({ dontFlip: true }), annotationStorage: pdf.annotationStorage, linkService: new SimpleLinkService() });
      await layer.render({ annotations, renderForms: true, fieldObjects: await pdf.getFieldObjects() });
      return annotations.map(item => ({ id: item.id, fieldName: item.fieldName, rect: item.rect, url: item.url, resetForm: item.resetForm }));
    }, [...result.artifact.bytes]);
    assert.equal(annotations.filter(item => item.url === "https://example.test/logo").length, 2);
    const linkBounds = await page.locator('a[href="https://example.test/logo"]').first().boundingBox();
    assert.ok(linkBounds);
    for (const [key, value] of Object.entries({ x: 44, y: 150, width: 112, height: 32 })) assert.ok(Math.abs(linkBounds[key] - value) < .1, `${key}: ${linkBounds[key]}`);
    const fields = page.locator('input[name$=".answer"]');
    assert.equal(await fields.count(), 2);
    assert.equal(await fields.nth(0).inputValue(), "Imported"); assert.equal(await fields.nth(1).inputValue(), "Imported");
    await fields.nth(0).fill("Changed"); await fields.nth(0).blur();
    assert.equal(await fields.nth(1).inputValue(), "Imported");
    assert.equal(await page.locator('input[name="answer"]').inputValue(), "Base");
    await fields.nth(1).fill("Second copy"); await fields.nth(1).blur();
    const reset = annotations.find(item => item.resetForm);
    assert.ok(reset);
    await page.locator(`[data-annotation-id="${reset.id}"] a`).click({ timeout: 3000 });
    assert.equal(await fields.nth(0).inputValue(), "Imported");
    assert.equal(await fields.nth(1).inputValue(), "Second copy", "reset applies only to its own placed form");
    assert.equal(await page.locator('input[name="answer"]').inputValue(), "Base");
    await fields.nth(0).fill("Changed"); await fields.nth(0).blur();
    const saved = await page.evaluate(async () => [...await window.pdf.saveDocument()]);
    const edited = await PDFDocument.load(Uint8Array.from(saved)), texts = edited.getForm().getFields().map(field => field.getText()).sort();
    assert.deepEqual(texts, ["Base", "Changed", "Second copy"]);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.pdfTask.destroy());
  });
});
