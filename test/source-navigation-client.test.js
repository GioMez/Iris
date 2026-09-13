const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const Navigation = require("../public/iris-source-navigation");
const hash = (text) => createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex");
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const text = "A é😀 note\nSecond row\n";
const match = { artifactId: "pdf-2", page: 2, x: 40, y: 60, width: 8, height: 6,
  sourceFileId: "part", sourceRevisionId: "revision", sourceHash: hash(text), line: 1, column: 5 };
const forward = { direction: "forward", sourceFileId: "part", line: 1, column: 5 };

function fixture(overrides = {}) {
  const context = { projectId: "project", buildId: "build", artifactId: "pdf-1", fileId: "main", revision: 1, enabled: true, format: "pdf" };
  const applied = [], statuses = [], requests = [];
  let content = text, available = true, disposed = 0;
  const controller = Navigation.create({
    context: () => ({ ...context }),
    request: async (buildId, query, options) => { requests.push({ buildId, query, ...options }); return { status: "ready", matches: [match] }; },
    source: async () => {
      if (!available) return null;
      const snapshot = content;
      return { text: snapshot, current: () => available && snapshot === content, dispose: () => disposed++ };
    },
    prepare: async () => null,
    apply: (result, source, prepared) => applied.push({ result, text: source.text, prepared }),
    status: (status) => statuses.push(status), ...overrides,
  });
  return { controller, context, applied, statuses, requests, edit: (value) => { content = value; }, remove: () => { available = false; }, disposed: () => disposed };
}

test("navigation applies an exact normalized authoritative source match without changing text", async () => {
  const f = fixture(); f.edit(text.replace(/\n/g, "\r\n"));
  assert.equal(await f.controller.navigate(forward), true);
  assert.equal(f.applied.length, 1);
  assert.deepEqual(f.applied[0].result, match);
  assert.equal(f.requests[0].buildId, "build");
  assert.deepEqual(f.requests[0].query, forward);
  assert.ok(f.requests[0].signal instanceof AbortSignal);
  assert.equal(f.disposed(), 1);
});

test("hash mismatch and deleted source reject before either view is applied", async () => {
  const f = fixture(); f.edit(text + "dirty");
  assert.equal(await f.controller.navigate(forward), false);
  assert.deepEqual(f.statuses, ["stale"]); assert.deepEqual(f.applied, []);
  f.remove(); await f.controller.navigate(forward);
  assert.deepEqual(f.statuses, ["stale", "missing"]); assert.deepEqual(f.applied, []);
});

for (const key of ["projectId", "buildId", "artifactId", "fileId", "revision", "renderGeneration", "page"]) {
  test(`a delayed response cannot navigate after ${key} changes`, async () => {
    const gate = deferred(); const f = fixture({ request: () => gate.promise });
    const pending = f.controller.navigate(forward); f.context[key] = "changed";
    gate.resolve({ status: "ready", matches: [match] });
    assert.equal(await pending, false); assert.deepEqual(f.applied, []); assert.deepEqual(f.statuses, []);
  });
}

test("a newer navigation aborts the older operation even if the transport ignores abort", async () => {
  const gate = deferred(); const signals = []; let calls = 0;
  const f = fixture({ request: (_build, _query, { signal }) => {
    signals.push(signal); return ++calls === 1 ? gate.promise : Promise.resolve({ status: "ready", matches: [match] });
  } });
  const old = f.controller.navigate(forward);
  await f.controller.navigate(forward); assert.equal(signals[0].aborted, true);
  gate.resolve({ status: "ready", matches: [{ ...match, page: 9 }] });
  assert.equal(await old, false); assert.equal(f.applied.length, 1); assert.equal(f.applied[0].result.page, 2);
});

test("authoritative loading and PDF preparation must finish, with a final source guard", async () => {
  const gate = deferred(); const f = fixture({ prepare: () => gate.promise });
  const pending = f.controller.navigate(forward);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(f.applied, []); f.edit("changed while PDF loaded"); gate.resolve(null);
  assert.equal(await pending, false); assert.deepEqual(f.applied, []); assert.deepEqual(f.statuses, ["stale"]);
});

test("navigation owns its source and cancellation through the final asynchronous apply", async () => {
  const entered = deferred(), finish = deferred(); let operation;
  const f = fixture({ apply: (_match, _source, _pdf, _query, context) => {
    operation = context; entered.resolve(); return finish.promise;
  } });
  let settled = false;
  const pending = f.controller.navigate(forward).then((result) => { settled = true; return result; });
  await entered.promise; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "rendering must remain part of the navigation operation");
  assert.equal(f.disposed(), 0, "the checked source must stay live until reveal completes");
  assert.equal(operation.current(), true);
  f.controller.cancel();
  assert.equal(operation.current(), false); assert.equal(operation.signal.aborted, true);
  finish.resolve(false);
  assert.equal(await pending, false); assert.equal(f.disposed(), 1);
});

for (const status of ["disabled", "missing", "unsupported", "no-match", "unavailable"]) {
  test(`${status} responses preserve both views and report their state`, async () => {
    const f = fixture({ request: async () => ({ status, matches: [] }) });
    assert.equal(await f.controller.navigate(forward), false);
    assert.deepEqual(f.statuses, [status]); assert.deepEqual(f.applied, []);
  });
}

test("current disabled/non-PDF settings skip the navigation transport", async () => {
  const f = fixture(); f.context.enabled = false;
  await f.controller.navigate(forward); f.context.enabled = true; f.context.format = "svg";
  await f.controller.navigate(forward);
  assert.deepEqual(f.statuses, ["disabled", "unsupported"]); assert.deepEqual(f.requests, []);
});

test("lazy inverse geometry is gated and stale acquisition cannot start a map query", async () => {
  let acquired = 0;
  const gate = deferred(), entered = deferred();
  const locate = async () => { acquired++; entered.resolve(); await gate.promise; return { direction: "inverse", artifactId: "pdf-1", page: 1, x: 70, y: 130 }; };
  const f = fixture(); f.context.enabled = false;
  await f.controller.navigate(locate);
  assert.equal(acquired, 0);
  f.context.enabled = true; f.context.format = "svg";
  await f.controller.navigate(locate); assert.equal(acquired, 0);
  f.context.format = "pdf";
  const pending = f.controller.navigate(locate);
  await entered.promise;
  f.context.artifactId = "replacement"; gate.resolve();
  assert.equal(await pending, false);
  assert.deepEqual(f.requests, []);
});

test("original geometry resolves inherited indirect boxes in compressed PDFs without changing bytes", async () => {
  const { PDFDocument, PDFName } = require("pdf-lib");
  // New fixture document; saving here does not transform compiler output.
  const doc = await PDFDocument.create();
  const first = doc.addPage([300, 400]); doc.addPage([600, 700]);
  const parent = first.node.Parent();
  parent.set(PDFName.of("MediaBox"), doc.context.register(doc.context.obj([-10, -20, 290, 380])));
  first.node.delete(PDFName.of("MediaBox"));
  first.setCropBox(20, 30, 200, 300);
  const bytes = await doc.save({ useObjectStreams: true }), original = bytes.slice();
  const boxes = await Navigation.readPdfGeometry(bytes, PDFDocument);
  assert.deepEqual(boxes, [[-10, -20, 290, 380], [0, 0, 600, 700]]);
  assert.deepEqual(bytes, original);
  const viewport = { transform: [1, 0, 0, -1, -20, 330], width: 200, height: 300, viewBox: [20, 30, 220, 330] };
  assert.deepEqual(Navigation.pdfPoint(viewport, { left: 0, top: 0, width: 200, height: 300 }, 50, 60, boxes[0]), { x: 80, y: 110 });
  assert.deepEqual(Navigation.pdfBox(viewport, { x: 80, y: 110, width: 10, height: 8 }, boxes[0]), { left: 50, top: 60, width: 10, height: 8 });
  assert.equal(Navigation.pdfBox(viewport, match), null, "missing original geometry cannot fall back to the crop");
});

test("invalid original geometry rejects rather than guessing a page from the cropped view", async () => {
  const { PDFDocument, PDFName } = require("pdf-lib");
  await assert.rejects(Navigation.readPdfGeometry(new Uint8Array(), PDFDocument));
  await assert.rejects(Navigation.readPdfGeometry(Buffer.from("%PDF-broken"), PDFDocument));
  for (const box of [[0, 0, 0, 400], [0, 0, 300, -1], [0, 0, 300, 1000001]]) {
    const doc = await PDFDocument.create(), page = doc.addPage();
    page.node.set(PDFName.of("MediaBox"), doc.context.obj(box));
    await assert.rejects(Navigation.readPdfGeometry(await doc.save(), PDFDocument), /Invalid PDF MediaBox/);
  }
});

test("inverse row precision selects the row; UTF-16 columns select the exact caret", () => {
  assert.deepEqual(Navigation.sourceRange(text, { line: 1, column: null }), { from: 0, to: 10 });
  assert.deepEqual(Navigation.sourceRange(text, { line: 1, column: 5 }), { from: 5, to: 5 });
  assert.equal(Navigation.sourceRange(text, { line: 4, column: 0 }), null);
  assert.equal(Navigation.sourceRange(text, { line: 1, column: 99 }), null);
});

test("normalized mapping rows resolve to original CRLF/CR editor offsets", () => {
  assert.deepEqual(Navigation.sourceRange("first\r\né😀\rthird", { line: 2, column: 3 }), { from: 10, to: 10 });
  assert.deepEqual(Navigation.sourceRange("first\r\né😀\rthird", { line: 3, column: null }), { from: 11, to: 16 });
});

test("only the platform accelerator and primary button trigger source navigation", () => {
  const event = { button: 0, ctrlKey: true };
  assert.equal(Navigation.isGesture(event, "Linux x86_64"), true);
  assert.equal(Navigation.isGesture({ button: 0, metaKey: true }, "MacIntel"), true);
  for (const extra of [{ altKey: true }, { shiftKey: true }, { button: 1 }, { button: 2 }, { metaKey: true }]) {
    assert.equal(Navigation.isGesture({ ...event, ...extra }, "Linux"), false);
  }
  assert.equal(Navigation.isGesture(event, "MacIntel"), false);
});

for (const [rotation, transform, width, height, point] of [
  [0, [2, 0, 0, -2, -40, 660], 400, 600, [100, 120]],
  [90, [0, 2, 2, 0, -60, -40], 600, 400, [480, 100]],
  [180, [-2, 0, 0, 2, 440, -60], 400, 600, [300, 480]],
  [270, [0, -2, -2, 0, 660, 440], 600, 400, [120, 300]],
]) test(`cropped ${rotation}° PDF coordinates handle CSS scaling without multiplying DPR`, () => {
  const viewport = { transform, viewBox: [20, 30, 220, 330], width, height };
  const rect = { left: 13, top: 17, width: width * 1.25, height: height * 1.25 };
  const mediaBox = [0, 0, 300, 400];
  const result = Navigation.pdfPoint(viewport, rect, 13 + point[0] * 1.25, 17 + point[1] * 1.25, mediaBox);
  assert.deepEqual(result, { x: 70, y: 130 });
  const box = Navigation.pdfBox(viewport, { x: 70, y: 130, width: 10, height: 8 }, mediaBox);
  assert.ok(box.left >= 0 && box.top >= 0);
  assert.equal(box.width, rotation % 180 ? 16 : 20);
  assert.equal(box.height, rotation % 180 ? 20 : 16);
});
