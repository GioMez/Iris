const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { PDFDocument, PDFName, PDFNumber, PDFString, rgb, degrees } = require("pdf-lib");
const { uuidv7 } = require("../src/ids");
const { composePdf } = require("../src/pipeline/pdf");

const identity = bytes => ({ id: uuidv7(), contentHash: createHash("sha256").update(bytes).digest("hex"), mediaType: "application/pdf", bytes });
async function fixture() {
  const base = await PDFDocument.create(), page = base.addPage([300, 400]);
  page.setMediaBox(-10, 5, 300, 400); page.setCropBox(-5, 10, 280, 380); page.setRotation(degrees(90));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  page.drawText("Original text", { x: 40, y: 200, size: 12 });
  page.node.set(PDFName.of("Annots"), base.context.obj([base.context.register(base.context.obj({
    Type: "Annot", Subtype: "Link", Rect: [40, 40, 80, 60], A: { S: "URI", URI: PDFString.of("https://example.test/retained") },
  }))]));
  base.addPage([600, 400]).drawText("Second page", { x: 40, y: 100 });
  const layer = await PDFDocument.create();
  layer.addPage([20, 20]).drawRectangle({ x: 0, y: 0, width: 20, height: 20, color: rgb(1, 0, 0), opacity: .5 });
  const source = identity(await base.save()), overlay = identity(await layer.save());
  return { base: source, layers: [{ artifact: overlay, base: { id: source.id, contentHash: source.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 50, height: 40, position: "over" }] };
}

test("composition retains base page geometry, annotations and source bytes while binding the new PDF", async () => {
  const request = await fixture(), before = Buffer.from(request.base.bytes);
  const { artifact, geometryRelation } = await composePdf(request);
  assert.deepEqual(Buffer.from(request.base.bytes), before);
  assert.equal(artifact.mediaType, "application/pdf");
  assert.equal(artifact.contentHash, createHash("sha256").update(artifact.bytes).digest("hex"));
  assert.notEqual(artifact.contentHash, request.base.contentHash);
  const output = await PDFDocument.load(artifact.bytes), pages = output.getPages();
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].getMediaBox(), { x: -10, y: 5, width: 300, height: 400 });
  assert.deepEqual(pages[0].getCropBox(), { x: -5, y: 10, width: 280, height: 380 });
  assert.equal(pages[0].getRotation().angle, 90);
  assert.equal(pages[0].node.lookup(PDFName.of("UserUnit")).asNumber(), 2);
  assert.deepEqual(pages[1].getMediaBox(), { x: 0, y: 0, width: 600, height: 400 });
  const annotations = pages[0].node.lookup(PDFName.of("Annots"));
  assert.equal(annotations.size(), 1);
  const link = annotations.lookup(0);
  assert.equal(link.lookup(PDFName.of("A")).lookup(PDFName.of("URI")).decodeText(), "https://example.test/retained");
  assert.equal(link.lookup(PDFName.of("Rect")).toString(), "[ 40 40 80 60 ]");
  assert.deepEqual(geometryRelation.base, { id: request.base.id, contentHash: request.base.contentHash });
  assert.equal(geometryRelation.output.contentHash, artifact.contentHash);
  assert.deepEqual(geometryRelation.pages.map(page => [page.sourcePage, page.outputPage]), [[1, 1], [2, 2]]);
});

for (const [label, change] of [
  ["base bytes changed", r => { r.base.contentHash = "0".repeat(64); }],
  ["layer bytes changed", r => { r.layers[0].artifact.contentHash = "0".repeat(64); }],
  ["layer targets another PDF", r => { r.layers[0].base.id = uuidv7(); }],
  ["layer targets an older PDF digest", r => { r.layers[0].base.contentHash = "0".repeat(64); }],
  ["non-PDF layer", r => { r.layers[0].artifact.mediaType = "image/png"; }],
  ["missing target page", r => { r.layers[0].page = 3; }],
  ["zero target page", r => { r.layers[0].page = 0; }],
  ["fractional source page", r => { r.layers[0].sourcePage = 1.5; }],
  ["missing source page", r => { r.layers[0].sourcePage = 2; }],
  ["mixed units", r => { r.layers[0].units = "mm"; }],
  ["placement outside physical MediaBox", r => { r.layers[0].x = 590; }],
  ["negative placement", r => { r.layers[0].y = -1; }],
  ["nonfinite placement", r => { r.layers[0].width = NaN; }],
  ["zero layer size", r => { r.layers[0].height = 0; }],
  ["unknown stacking position", r => { r.layers[0].position = "replace"; }],
]) test(`composition rejects ${label}`, async () => {
  const request = await fixture(); change(request);
  await assert.rejects(composePdf(request), { code: "PIPELINE_PDF_INVALID" });
});

test("cancelled composition returns no replacement artifact", async () => {
  const request = await fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(composePdf({ ...request, signal: controller.signal }), { name: "AbortError" });
});

for (const family of ["latex", "lilypond"]) test(`two-pass ${family} fixture declares both compiles before inspecting layout`, {
  skip: process.env.IRIS_TEST_LUA !== "1",
}, async () => {
  const fs = require("node:fs/promises"), path = require("node:path");
  const { executeLua } = require("../src/pipeline/lua-vm");
  const modules = { "iris.lua": await fs.readFile(path.join(__dirname, "fixtures/pipelines/adjust-layout.lua"), "utf8"),
    "decorate.lua": await fs.readFile(path.join(__dirname, "fixtures/pipelines/decorate.lua"), "utf8") };
  const plan = await executeLua({ mode: "plan", script: "iris.lua", modules, context: { parameters: { family } } });
  assert.deepEqual(plan.steps.filter(step => step.adapter.id === `iris.${family}`).map(step => step.id), ["measure", "compile"]);
  const step = id => plan.steps.find(item => item.id === id);
  assert.deepEqual(step("adjust").inputs.layout, { step: "measure", port: "layout" });
  assert.deepEqual(step("compile").inputs.generated, { step: "adjust", port: "include" });
  assert.deepEqual(step("decorate").inputs.layout, { step: "compile", port: "layout" });
  assert.deepEqual(step("compose").inputs.base, { step: "compile", port: "output" });
});

for (const [rotation, expectedRect, expectedQuad] of [
  [0, [20, 130, 70, 170], [20, 170, 70, 170, 20, 130, 70, 130]],
  [90, [70, 130, 120, 170], [120, 170, 120, 130, 70, 170, 70, 130]],
  [180, [70, 90, 120, 130], [120, 90, 70, 90, 120, 130, 70, 130]],
  [270, [20, 90, 70, 130], [20, 90, 20, 130, 70, 90, 70, 130]],
]) test(`layer link annotations follow ${rotation}-degree crop/placement without changing their URI`, async () => {
  const document = await PDFDocument.create(); document.addPage([200, 200]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 150]);
  page.setMediaBox(10, 20, 100, 150); page.setCropBox(20, 40, 80, 100); page.setRotation(degrees(rotation));
  page.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
  page.drawText("Linked layer", { x: 20, y: 90 });
  page.node.set(PDFName.of("Annots"), layer.context.obj([layer.context.register(layer.context.obj({ Type: "Annot", Subtype: "Link",
    P: page.ref, Rect: [20, 90, 60, 140], QuadPoints: [20, 140, 60, 140, 20, 90, 60, 90], Border: [0, 0, 0],
    A: { S: "URI", URI: PDFString.of("https://example.test/layer") }, Contents: PDFString.of("Layer link") }))]));
  const base = identity(await document.save()), artifact = identity(await layer.save()), before = Buffer.from(artifact.bytes);
  const result = await composePdf({ base, layers: [{ base: { id: base.id, contentHash: base.contentHash }, artifact,
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 100, height: 80, position: "over" }] });
  const output = await PDFDocument.load(result.artifact.bytes), target = output.getPage(0), annots = target.node.Annots();
  assert.equal(annots?.size(), 1, "the imported link must remain an annotation");
  const annotation = annots.lookup(0), numbers = key => annotation.lookup(PDFName.of(key)).asArray().map(item => item.asNumber());
  assert.deepEqual(numbers("Rect"), expectedRect); assert.deepEqual(numbers("QuadPoints"), expectedQuad);
  assert.equal(annotation.get(PDFName.of("P")).toString(), target.ref.toString());
  assert.equal(annotation.lookup(PDFName.of("A")).lookup(PDFName.of("URI")).decodeText(), "https://example.test/layer");
  assert.equal(annotation.lookup(PDFName.of("Contents")).decodeText(), "Layer link");
  assert.deepEqual(Buffer.from(artifact.bytes), before);
});

test("repeated annotated layers keep separate comment/popup relationships and ink coordinates", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context;
  page.drawText("Notes", { x: 10, y: 10 });
  const comment = ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 20, 20, 30], P: page.ref, Contents: PDFString.of("Keep this note") });
  const commentRef = ctx.register(comment), popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [20, 20, 80, 70], Parent: commentRef, P: page.ref }));
  comment.set(PDFName.of("Popup"), popup);
  const ink = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Ink", Rect: [10, 10, 30, 40], InkList: [[10, 10, 20, 40, 30, 20]], P: page.ref, IRT: commentRef }));
  page.node.set(PDFName.of("Annots"), ctx.obj([commentRef, popup, ink]));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const layers = [20, 150].map(x => ({ artifact, base: { id: base.id, contentHash: base.contentHash }, sourcePage: 1, page: 1, units: "pdf-point", x, y: 30, width: 100, height: 100, position: "over" }));
  const result = await composePdf({ base, layers }), output = await PDFDocument.load(result.artifact.bytes), annotations = output.getPage(0).node.Annots();
  assert.equal(annotations?.size(), 6);
  for (const offset of [0, 3]) {
    const note = annotations.lookup(offset), popup = annotations.lookup(offset + 1), ink = annotations.lookup(offset + 2);
    assert.equal(note.get(PDFName.of("Popup")).toString(), annotations.get(offset + 1).toString());
    assert.equal(popup.get(PDFName.of("Parent")).toString(), annotations.get(offset).toString());
    assert.equal(ink.get(PDFName.of("IRT")).toString(), annotations.get(offset).toString());
    assert.equal(note.lookup(PDFName.of("Contents")).decodeText(), "Keep this note");
    assert.deepEqual(ink.lookup(PDFName.of("InkList")).lookup(0).asArray().map(item => item.asNumber()), offset ? [160, 180, 170, 210, 180, 190] : [30, 180, 40, 210, 50, 190]);
  }
});

for (const mode of ["direct", "named", "missing", "ambiguous"]) test(`layer internal links resolve ${mode} destinations to placed output pages`, async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), first = layer.addPage([100, 100]), second = layer.addPage([100, 100]), ctx = layer.context;
  const destination = mode === "named" ? ctx.obj([second.ref, "FitR", 10, 20, 50, 60]) : ctx.obj([second.ref, "XYZ", 5, 90, null]);
  if (mode === "named") layer.catalog.set(PDFName.of("Names"), ctx.obj({ Dests: { Names: [PDFString.of("detail"), { D: destination }] } }));
  first.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 20, 40, 40],
    A: { S: "GoTo", D: mode === "named" ? PDFString.of("detail") : destination } }))]));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const make = (sourcePage, page, x, y, width) => ({ artifact, base: { id: base.id, contentHash: base.contentHash }, sourcePage, page,
    units: "pdf-point", x, y, width, height: 100, position: "over" });
  const layers = [make(1, 1, 10, 20, 100)];
  if (mode !== "missing") layers.push(make(2, 2, 40, 50, 200));
  if (mode === "ambiguous") layers.push(make(2, 1, 150, 100, 100));
  if (["missing", "ambiguous"].includes(mode)) {
    await assert.rejects(composePdf({ base, layers }), { code: "PIPELINE_PDF_INVALID" }); return;
  }
  const result = await composePdf({ base, layers }), output = await PDFDocument.load(result.artifact.bytes);
  const link = output.getPage(0).node.Annots().lookup(0), dest = link.lookup(PDFName.of("A")).lookup(PDFName.of("D"));
  assert.equal(dest.get(0).toString(), output.getPage(1).ref.toString(), "link must refer to a real output page");
  assert.equal(dest.get(1).toString(), mode === "named" ? "/FitR" : "/XYZ");
  assert.deepEqual(dest.asArray().slice(2).map(item => item.asNumber?.() ?? null), mode === "named" ? [60, 170, 140, 210] : [50, 240, null]);
});

test("imported form copies retain values and edit independently without overwriting base fields", async () => {
  const document = await PDFDocument.create(), page = document.addPage([400, 400]);
  const baseField = document.getForm().createTextField("answer"); baseField.setText("Base value");
  baseField.addToPage(page, { x: 10, y: 10, width: 80, height: 20 });
  const layer = await PDFDocument.create(), formPage = layer.addPage([100, 100]), form = layer.getForm();
  const text = form.createTextField("answer"); text.setText("Layer value"); text.addToPage(formPage, { x: 10, y: 50, width: 80, height: 20 });
  const checked = form.createCheckBox("enabled"); checked.addToPage(formPage, { x: 10, y: 10, width: 15, height: 15 }); checked.check();
  const choice = form.createRadioGroup("choice"); choice.addOptionToPage("one", formPage, { x: 40, y: 10, width: 15, height: 15 });
  choice.addOptionToPage("two", formPage, { x: 70, y: 10, width: 15, height: 15 }); choice.select("two");
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const layers = [20, 200].map(x => ({ artifact, base: { id: base.id, contentHash: base.contentHash }, sourcePage: 1, page: 1,
    units: "pdf-point", x, y: 30, width: 150, height: 150, position: "over" }));
  const result = await composePdf({ base, layers }), output = await PDFDocument.load(result.artifact.bytes), final = output.getForm();
  assert.equal(final.getFields().length, 7);
  assert.equal(final.getTextField("answer").getText(), "Base value");
  const imported = final.getFields().filter(field => field.getName().endsWith(".answer"));
  assert.equal(imported.length, 2); assert.notEqual(imported[0].getName(), imported[1].getName());
  assert.deepEqual(imported.map(field => field.getText()), ["Layer value", "Layer value"]);
  for (const field of imported) {
    const prefix = field.getName().slice(0, -"answer".length);
    assert.equal(final.getCheckBox(prefix + "enabled").isChecked(), true);
    assert.equal(final.getRadioGroup(prefix + "choice").getSelected(), "two");
  }
  imported[0].setText("Edited copy");
  const saved = await PDFDocument.load(await output.save()), savedForm = saved.getForm();
  assert.equal(savedForm.getTextField(imported[0].getName()).getText(), "Edited copy");
  assert.equal(savedForm.getTextField(imported[1].getName()).getText(), "Layer value");
  assert.equal(savedForm.getTextField("answer").getText(), "Base value");
  assert.equal(saved.getPage(0).node.Annots().size(), 9);
});

test("combined field/widget annotations remain editable after importing a rotated layer", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context;
  page.setRotation(degrees(90));
  const widget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: PDFString.of("answer"),
    V: PDFString.of("Original"), Rect: [10, 20, 90, 40], P: page.ref, DA: PDFString.of("/Helv 10 Tf 0 g"), F: 4 }));
  page.node.set(PDFName.of("Annots"), ctx.obj([widget]));
  layer.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [widget], DR: { Font: { Helv: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" } } } }));
  const base = identity(await document.save({ updateFieldAppearances: false })), artifact = identity(await layer.save({ updateFieldAppearances: false }));
  const result = await composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 200, height: 200, position: "over" }] });
  const output = await PDFDocument.load(result.artifact.bytes), [field] = output.getForm().getFields();
  assert.equal(field.getText(), "Original");
  const annotation = output.getPage(0).node.Annots().lookup(0);
  assert.deepEqual(annotation.lookup(PDFName.of("Rect")).asArray().map(item => item.asNumber()), [60, 90, 100, 250]);
  assert.equal(annotation.lookup(PDFName.of("MK")).lookup(PDFName.of("R")).asNumber(), 270);
  assert.match(field.acroField.getDefaultAppearance(), /20 Tf/);
  assert.match(field.acroField.getDefaultAppearance(), /\/iris_layer_1_Helv/);
  field.setText("Edited");
  const saved = await PDFDocument.load(await output.save());
  assert.equal(saved.getForm().getTextField(field.getName()).getText(), "Edited");
});

test("widgets sharing appearance characteristics keep the same rotation after placement", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context;
  const form = layer.getForm();
  for (const [label, y] of [["first", 20], ["second", 60]]) {
    const field = form.createTextField(label); field.setText(label); field.addToPage(page, { x: 10, y, width: 80, height: 15 });
  }
  const mk = ctx.register(ctx.obj({ R: 0, BC: [0, 0, 0], BG: [1, 1, 1] }));
  for (const annot of page.node.Annots().asArray()) ctx.lookup(annot).set(PDFName.of("MK"), mk);
  page.setRotation(degrees(90));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 100, height: 100, position: "over" }] });
  const output = await PDFDocument.load(result.artifact.bytes), annotations = output.getPage(0).node.Annots();
  assert.deepEqual(annotations.asArray().map(ref => output.context.lookup(ref).lookup(PDFName.of("MK")).lookup(PDFName.of("R")).asNumber()), [270, 270]);
});

for (const target of ["base", "layer"]) for (const feature of ["xfa", "script", "signature"]) test(`composition refuses ${feature} preservation on the ${target} with an explicit error`, async () => {
  const document = await PDFDocument.create(); const page = document.addPage([300, 300]);
  const layer = await PDFDocument.create(); const layerPage = layer.addPage([100, 100]);
  const pdf = target === "base" ? document : layer, owner = target === "base" ? page : layerPage;
  const field = pdf.getForm().createTextField("answer"); field.addToPage(owner, { x: 10, y: 20, width: 80, height: 15 });
  if (feature === "xfa") pdf.getForm().acroForm.dict.set(PDFName.of("XFA"), pdf.context.register(pdf.context.flateStream("<xfa/>")));
  if (feature === "script") field.acroField.dict.set(PDFName.of("AA"), pdf.context.obj({ K: { S: "JavaScript", JS: PDFString.of('this.getField("answer").value="changed"') } }));
  if (feature === "signature") {
    field.acroField.dict.set(PDFName.of("FT"), PDFName.of("Sig"));
    field.acroField.dict.set(PDFName.of("V"), pdf.context.obj({ Type: "Sig", ByteRange: [0, 10, 20, 30], Contents: PDFString.of("signed bytes") }));
  }
  const base = identity(await document.save({ updateFieldAppearances: false })), artifact = identity(await layer.save({ updateFieldAppearances: false }));
  await assert.rejects(composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 100, height: 100, position: "over" }] }), { code: "PIPELINE_PDF_UNSUPPORTED" });
});

test("composition refuses partially cropped editable widgets instead of changing their interactive geometry", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]); page.setCropBox(20, 20, 60, 60);
  const field = layer.getForm().createTextField("answer"); field.addToPage(page, { x: 10, y: 50, width: 80, height: 15 });
  const base = identity(await document.save()), artifact = identity(await layer.save());
  await assert.rejects(composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 100, height: 100, position: "over" }] }), { code: "PIPELINE_PDF_UNSUPPORTED" });
});

test("imported forms keep default font resources when DR also declares a ProcSet", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), form = layer.getForm();
  const field = form.createTextField("answer"); field.setText("Original"); field.addToPage(page, { x: 10, y: 20, width: 80, height: 15 });
  form.acroForm.dict.set(PDFName.of("DR"), layer.context.obj({ ProcSet: ["PDF", "Text"], Font: { Helv: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" } } }));
  field.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 10 Tf 0 g"));
  const base = identity(await document.save({ updateFieldAppearances: false })), artifact = identity(await layer.save({ updateFieldAppearances: false }));
  const result = await composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 20, y: 30, width: 100, height: 100, position: "over" }] });
  const output = await PDFDocument.load(result.artifact.bytes), [copied] = output.getForm().getFields();
  assert.equal(copied.getText(), "Original");
  const resources = output.getForm().acroForm.dict.lookup(PDFName.of("DR"));
  assert.equal(resources.lookup(PDFName.of("Font")).lookup(PDFName.of("iris_layer_1_Helv")).lookup(PDFName.of("BaseFont")).toString(), "/Helvetica");
});

for (const kind of ["ResetForm", "SubmitForm"]) for (const mode of ["name", "reference", "exclude"]) test(`imported ${kind} actions rebind ${mode} targets to independent fields`, async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context, form = layer.getForm();
  const fields = ["answer", "other"].map((label, i) => {
    const field = form.createTextField(label); field.addToPage(page, { x: 10, y: 20 + i * 30, width: 80, height: 15 }); return field;
  });
  const action = { S: kind, Fields: [mode === "reference" ? fields[0].ref : PDFString.of(mode === "exclude" ? "other" : "answer")], Flags: mode === "exclude" ? 1 : 0,
    ...(kind === "SubmitForm" ? { F: PDFString.of("https://example.test/form") } : {}) };
  // The reset link comes before the widgets in Annots; remapping must not depend
  // on their input ordering.
  page.node.Annots().insert(0, ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 5, 90, 15], A: action })));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const layers = [20, 150].map(x => ({ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x, y: 30, width: 100, height: 100, position: "over" }));
  const result = await composePdf({ base, layers }), output = await PDFDocument.load(result.artifact.bytes), annots = output.getPage(0).node.Annots();
  for (const [i, prefix] of [[0, "iris_layer_1"], [3, "iris_layer_2"]]) {
    const reset = annots.lookup(i).lookup(PDFName.of("A"));
    assert.deepEqual(reset.lookup(PDFName.of("Fields")).asArray().map(item => item.decodeText()), [`${prefix}.answer`]);
    assert.equal(reset.lookup(PDFName.of("Flags")).asNumber(), 0);
  }
});

test("cropped layer links stay within their source viewport and wholly excluded widgets stay hidden", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context; page.setCropBox(20, 20, 60, 60);
  const field = layer.getForm().createTextField("hidden"); field.setText("Retained value"); field.addToPage(page, { x: 1, y: 1, width: 10, height: 10 });
  page.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 40, 40], Border: [0, 0, 0],
    QuadPoints: [10, 40, 40, 40, 10, 10, 40, 10], A: { S: "URI", URI: PDFString.of("https://example.test/cropped") } })));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 50, y: 50, width: 60, height: 60, position: "over" }] });
  const output = await PDFDocument.load(result.artifact.bytes), annotations = output.getPage(0).node.Annots(), widget = annotations.lookup(0), link = annotations.lookup(1);
  assert.ok(widget.lookup(PDFName.of("F")).asNumber() & 2, "excluded widgets remain hidden in the larger target page");
  assert.equal(output.getForm().getFields()[0].getText(), "Retained value");
  assert.deepEqual(link.lookup(PDFName.of("Rect")).asArray().map(item => item.asNumber()), [50, 190, 70, 210]);
  assert.deepEqual(link.lookup(PDFName.of("QuadPoints")).asArray().map(item => item.asNumber()), [50, 210, 70, 210, 50, 190, 70, 190]);
});

test("Hide actions and field additional actions target the placed copy rather than donor objects", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context;
  const field = layer.getForm().createTextField("answer"); field.addToPage(page, { x: 10, y: 20, width: 80, height: 15 });
  field.acroField.dict.set(PDFName.of("AA"), ctx.obj({ Bl: { S: "ResetForm", Fields: [PDFString.of("answer")] } }));
  page.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 5, 90, 15],
    A: { S: "Hide", T: [PDFString.of("answer"), page.node.Annots().get(0)], H: true } })));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash },
    sourcePage: 1, page: 1, units: "pdf-point", x: 50, y: 50, width: 100, height: 100, position: "over" }] });
  const output = await PDFDocument.load(result.artifact.bytes), annotations = output.getPage(0).node.Annots();
  const targets = annotations.lookup(1).lookup(PDFName.of("A")).lookup(PDFName.of("T"));
  assert.equal(targets.lookup(0).decodeText(), "iris_layer_1.answer");
  assert.equal(targets.get(1).toString(), annotations.get(0).toString());
  const copied = output.getForm().getFields()[0], reset = copied.acroField.dict.lookup(PDFName.of("AA")).lookup(PDFName.of("Bl"));
  assert.deepEqual(reset.lookup(PDFName.of("Fields")).asArray().map(item => item.decodeText()), ["iris_layer_1.answer"]);
});

test("line, polygon and callout coordinates transform with their annotation appearance", async () => {
  const document = await PDFDocument.create(); document.addPage([300, 300]);
  const layer = await PDFDocument.create(), page = layer.addPage([100, 100]), ctx = layer.context;
  const data = { Type: "Annot", Subtype: "Line", Rect: [10, 20, 80, 90], L: [10, 20, 80, 90], Vertices: [10, 20, 30, 40, 80, 90],
    CL: [10, 20, 30, 40, 80, 90], RD: [1, 2, 3, 4] };
  page.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj(data))]));
  const base = identity(await document.save()), artifact = identity(await layer.save());
  const result = await composePdf({ base, layers: [{ artifact, base: { id: base.id, contentHash: base.contentHash }, sourcePage: 1, page: 1,
    units: "pdf-point", x: 20, y: 30, width: 200, height: 200, position: "over" }] });
  const output = await PDFDocument.load(result.artifact.bytes), annotation = output.getPage(0).node.Annots().lookup(0);
  const numbers = key => annotation.lookup(PDFName.of(key)).asArray().map(item => item.asNumber());
  assert.deepEqual(numbers("L"), [40, 110, 180, 250]);
  assert.deepEqual(numbers("Vertices"), [40, 110, 80, 150, 180, 250]);
  assert.deepEqual(numbers("CL"), [40, 110, 80, 150, 180, 250]);
  assert.deepEqual(numbers("RD"), [2, 4, 6, 8]);
});

for (const limit of ["artifact", "aggregate-input", "aggregate-output"]) test(`composition enforces its ${limit} byte limit`, async () => {
  const request = await fixture(), bytes = request.base.bytes.length + request.layers[0].artifact.bytes.length;
  if (limit === "aggregate-output") request.layers = Array.from({ length: 100 }, () => request.layers[0]);
  request.policy = limit === "artifact" ? { maxArtifactBytes: request.base.bytes.length - 1 }
    : { maxOutputBytes: bytes - (limit === "aggregate-input" ? 1 : 0) };
  await assert.rejects(composePdf(request), { code: "PIPELINE_OUTPUT_LIMIT" });
});

test("changing the installed composition helper invalidates the adapter identity before execution", async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pdf-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.join(__dirname, "../src"), path.join(root, "src"), { recursive: true });
  await fs.symlink(path.resolve(__dirname, "../node_modules"), path.join(root, "node_modules"), "dir");
  const { createPdfAdapter } = require(path.join(root, "src/pipeline/pdf-runner.js")), adapter = createPdfAdapter();
  await fs.appendFile(path.join(root, "src/pipeline/pdf-forms.js"), "\n// Changed installed implementation.\n");
  assert.notEqual(createPdfAdapter().implementationHash, adapter.implementationHash);
  await assert.rejects(adapter.execute({}), { code: "PIPELINE_ADAPTER_CHANGED" });
});

for (const damage of ["none", "base", "layer", "placement", "timeout", "cancel"]) test(`PDF adapter binds declared placements and exports only the composed PDF (${damage})`, async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const { createPdfAdapter, createPdfTool, checkedComposition } = require("../src/pipeline/pdf-runner");
  const { createNativeRuntime } = require("../src/pipeline/runtime");
  const { createRunWorkspace, materializeInputs, validateOutputs, disposeRunWorkspace } = require("../src/pipeline/workspaces");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pdf-adapter-"));
  let workspace, runtime;
  t.after(async () => { await runtime?.close(); if (workspace) await disposeRunWorkspace(workspace); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"); await fs.mkdir(source);
  workspace = await createRunWorkspace({ root: source, files: [], directories: [], settings: {} }, { root: path.join(root, "runs") });
  runtime = await createNativeRuntime({ root: path.join(root, "runtime"), coordinatorId: uuidv7(), tools: [createPdfTool(damage === "timeout" ? 1 : 120000)] });
  const request = await fixture();
  const seed = { id: "seed", outputs: { base: { kind: "file", mediaType: "application/pdf", path: "base.pdf" },
    layers: { kind: "collection", mediaType: "application/pdf", path: "layers" } } };
  const seedContext = await materializeInputs(workspace, seed, new Map());
  await fs.writeFile(path.join(seedContext.outputDir, "base.pdf"), request.base.bytes);
  await fs.mkdir(path.join(seedContext.outputDir, "layers"));
  await fs.writeFile(path.join(seedContext.outputDir, "layers/layer.pdf"), request.layers[0].artifact.bytes);
  const [base, layers] = await validateOutputs(workspace, seed), artifacts = new Map([["seed:base", base], ["seed:layers", layers]]);
  const placements = { version: 1, base: { id: base.id, contentHash: base.contentHash }, layers: [{
    ...request.layers[0], artifact: { id: layers.files[0].id, contentHash: layers.files[0].contentHash }, base: undefined,
  }] };
  if (damage === "base") placements.base.contentHash = "0".repeat(64);
  if (damage === "layer") placements.layers[0].artifact.id = uuidv7();
  if (damage === "placement") placements.layers[0].page = 999;
  if (damage === "cancel") placements.layers = Array.from({ length: 5000 }, () => placements.layers[0]);
  const place = { id: "place", outputs: { placement: { kind: "file", mediaType: "application/json", path: "placements.json" } } };
  const placeContext = await materializeInputs(workspace, place, artifacts);
  await fs.writeFile(path.join(placeContext.outputDir, "placements.json"), JSON.stringify(placements));
  const [placement] = await validateOutputs(workspace, place); artifacts.set("place:placement", placement);
  const step = { id: "compose", inputs: { base: { step: "seed", port: "base" }, layers: { step: "seed", port: "layers" }, placements: { step: "place", port: "placement" } },
    outputs: { output: { kind: "file", mediaType: "application/pdf", path: "composed.pdf" } } };
  const controller = new AbortController(), context = await materializeInputs(workspace, step, artifacts, { signal: controller.signal });
  let composed;
  const adapter = createPdfAdapter({ runtime, runId: uuidv7(), onComposed: (ctx, value) => { assert.equal(ctx, context); composed = value; } });
  if (damage === "none") {
    await adapter.execute(context);
    const [product] = await validateOutputs(workspace, step);
    assert.equal(composed.output.id, product.id);
    assert.equal(composed.output.contentHash, product.contentHash);
    assert.deepEqual(composed.base, placements.base);
    assert.equal(composed.pages.length, 2);
    assert.equal(checkedComposition(context, composed, [product]), composed);
    assert.throws(() => checkedComposition(context, structuredClone(composed), [product]), { code: "PIPELINE_PDF_INVALID" });
    assert.throws(() => checkedComposition(context, composed, [{ ...product, contentHash: "0".repeat(64) }]), { code: "PIPELINE_PDF_INVALID" });
    assert.throws(() => checkedComposition({ ...context, inputs: { ...context.inputs, base: { ...base, contentHash: "0".repeat(64) } } }, composed, [product]), { code: "PIPELINE_PDF_INVALID" });
    assert.deepEqual(await fs.readdir(context.outputDir), ["composed.pdf"]);
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(product.root, product.path)))).getPageCount(), 2);
  } else {
    const operation = adapter.execute(context);
    const rejected = assert.rejects(operation, damage === "cancel" ? { name: "AbortError" }
      : { code: damage === "timeout" ? "PIPELINE_PDF_TIMEOUT" : "PIPELINE_PDF_INVALID" });
    let pid;
    if (damage === "cancel") {
      const { until } = require("../scripts/lib/disposable.cjs");
      await until(async () => {
        for (const file of await fs.readdir(path.join(root, "runtime"))) if (file.endsWith(".json") && file !== "installation.json") {
          const receipt = JSON.parse(await fs.readFile(path.join(root, "runtime", file), "utf8"));
          if (receipt.pid) { pid = receipt.pid; return true; }
        }
        return false;
      }, "active PDF composition process", 5000);
      controller.abort();
    }
    await rejected;
    if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(composed, undefined);
    assert.deepEqual(await fs.readdir(context.outputDir), []);
  }
  assert.deepEqual(await fs.readdir(path.join(root, "runtime")), ["installation.json"]);
});
