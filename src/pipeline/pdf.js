const { createHash } = require("node:crypto");
// Use the pinned, self-contained distribution so the execution identity covers
// the exact parser, compressor and font code loaded by the native process.
const { PDFDocument, PDFPage, PDFObjectCopier, PDFName, PDFNumber, drawPage, degrees } = require("pdf-lib/dist/pdf-lib.min.js");
const { isUuid } = require("../ids");
const { cloneValue, LUA_DATA_POLICY, record, freeze, fail } = require("./contracts");
const { readWorkspaceLimits } = require("./workspaces");
const { copyLayerAnnotations } = require("./pdf-annotations");
const { validateFormPreservation } = require("./pdf-forms");

const INVALID = "PIPELINE_PDF_INVALID";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const requireValue = value => { if (!value) fail(INVALID, "Invalid PDF composition input"); };
function geometry(page) {
  const media = page.getMediaBox(), crop = page.getCropBox(), rawRotation = page.getRotation().angle;
  const value = page.node.getInheritableAttribute(PDFName.of("UserUnit"));
  const userUnit = value ? page.doc.context.lookup(value, PDFNumber).asNumber() : 1;
  const rotation = ((rawRotation % 360) + 360) % 360;
  for (const box of [media, crop]) requireValue(Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0);
  requireValue([0, 90, 180, 270].includes(rotation) && Number.isFinite(userUnit) && userUnit > 0 && userUnit <= 75000);
  return { mediaBox: [media.x, media.y, media.x + media.width, media.y + media.height],
    cropBox: [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height], rotation, userUnit };
}

// Runs in the native PDF process. The workspace owner assigns the returned
// candidate bytes their published artifact ID after checked output validation.
async function composePdf({ base, layers, policy = {}, signal } = {}) {
  signal?.throwIfAborted();
  const budget = readWorkspaceLimits(policy);
  requireValue(Array.isArray(layers) && layers.length <= budget.maxOutputEntries);
  const inputs = new Map();
  let inputBytes = 0;
  function input(value) {
    requireValue(value && isUuid(value.id) && value.mediaType === "application/pdf"
      && /^[a-f0-9]{64}$/.test(value.contentHash) && value.bytes instanceof Uint8Array);
    if (value.bytes.length > budget.maxArtifactBytes) fail("PIPELINE_OUTPUT_LIMIT", "PDF exceeds its artifact limit");
    requireValue(hash(value.bytes) === value.contentHash);
    const previous = inputs.get(value.id);
    if (previous) requireValue(previous.contentHash === value.contentHash);
    else { inputs.set(value.id, value); inputBytes += value.bytes.length; }
    if (inputBytes > budget.maxOutputBytes) fail("PIPELINE_OUTPUT_LIMIT", "PDF inputs exceed their byte limit");
    return value;
  }
  input(base);
  const placements = cloneValue(layers.map(({ artifact, ...placement }) => placement), LUA_DATA_POLICY, INVALID);
  for (const [index, placement] of placements.entries()) {
    record(placement, ["base", "sourcePage", "page", "units", "x", "y", "width", "height", "position"], INVALID, "PDF placement");
    record(placement.base, ["id", "contentHash"], INVALID, "base PDF identity");
    requireValue(placement.base.id === base.id && placement.base.contentHash === base.contentHash
      && placement.units === "pdf-point" && ["over", "under"].includes(placement.position)
      && Number.isSafeInteger(placement.sourcePage) && placement.sourcePage > 0 && Number.isSafeInteger(placement.page) && placement.page > 0
      && [placement.x, placement.y, placement.width, placement.height].every(Number.isFinite)
      && placement.x >= 0 && placement.y >= 0 && placement.width > 0 && placement.height > 0);
    input(layers[index].artifact);
  }
  try {
    const document = await PDFDocument.load(base.bytes, { updateMetadata: false, throwOnInvalidObject: true });
    validateFormPreservation(document);
    signal?.throwIfAborted();
    const pages = document.getPages(), original = pages.map(geometry), sources = new Map(), embedded = new Map(), underlays = new Map(), placed = [];
    requireValue(pages.length > 0);
    for (const [index, placement] of placements.entries()) {
      signal?.throwIfAborted();
      const { artifact } = layers[index], target = pages[placement.page - 1];
      requireValue(target);
      const targetGeometry = original[placement.page - 1], [left, , right, top] = targetGeometry.mediaBox;
      const unit = targetGeometry.userUnit, height = (top - targetGeometry.mediaBox[1]) * unit;
      requireValue(placement.x + placement.width <= (right - left) * unit && placement.y + placement.height <= height);
      if (!sources.has(artifact.id)) {
        const source = await PDFDocument.load(artifact.bytes, { updateMetadata: false, throwOnInvalidObject: true });
        validateFormPreservation(source); sources.set(artifact.id, source);
      }
      const source = sources.get(artifact.id), sourcePage = source.getPages()[placement.sourcePage - 1];
      requireValue(sourcePage);
      const key = `${artifact.id}:${placement.sourcePage}`;
      if (!embedded.has(key)) {
        const g = geometry(sourcePage), [ml, mb, mr, mt] = g.mediaBox, [cl, cb, cr, ct] = g.cropBox;
        const l = Math.max(ml, cl), b = Math.max(mb, cb), r = Math.min(mr, cr), t = Math.min(mt, ct);
        requireValue(l < r && b < t);
        const matrix = g.rotation === 0 ? [1, 0, 0, 1, -l, -b] : g.rotation === 90 ? [0, -1, 1, 0, -b, r]
          : g.rotation === 180 ? [-1, 0, 0, -1, r, t] : [0, 1, -1, 0, t, -l];
        const drawing = sourcePage.node.clone();
        drawing.delete(PDFName.of("Annots"));
        const node = PDFObjectCopier.for(source.context, document.context).copy(drawing);
        if (!node.Contents()) node.addContentStream(document.context.register(document.context.flateStream("")));
        const copy = PDFPage.of(node, document.context.register(node), document);
        const pdf = await document.embedPage(copy, { left: l, bottom: b, right: r, top: t }, matrix);
        await pdf.embed();
        const group = copy.node.get(PDFName.of("Group"));
        if (group) document.context.lookup(pdf.ref).dict.set(PDFName.of("Group"), group);
        embedded.set(key, { pdf, matrix, crop: [l, b, r, t], width: g.rotation % 180 ? t - b : r - l, height: g.rotation % 180 ? r - l : t - b });
      }
      const layer = embedded.get(key), name = target.node.newXObject("IrisLayer", layer.pdf.ref);
      const sx = placement.width / unit / layer.width, sy = placement.height / unit / layer.height;
      const x = left + placement.x / unit, y = top - (placement.y + placement.height) / unit, m = layer.matrix;
      placed.push({ source, sourcePage, target, position: placement.position, crop: layer.crop,
        matrix: [m[0] * sx, m[1] * sy, m[2] * sx, m[3] * sy, m[4] * sx + x, m[5] * sy + y] });
      const stream = document.context.register(document.context.contentStream(drawPage(name, {
        x: left + placement.x / unit, y: top - (placement.y + placement.height) / unit,
        xScale: placement.width / unit / layer.width, yScale: placement.height / unit / layer.height,
        rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0),
      })));
      target.node.addContentStream(stream);
      if (placement.position === "under") {
        const contents = target.node.Contents(), offset = underlays.get(target) || 0;
        contents.remove(contents.size() - 1); contents.insert(offset, stream); underlays.set(target, offset + 1);
      }
    }
    copyLayerAnnotations(document, placed);
    signal?.throwIfAborted();
    const bytes = await document.save({ updateFieldAppearances: false });
    signal?.throwIfAborted();
    if (bytes.length > Math.min(budget.maxArtifactBytes, budget.maxOutputBytes)) fail("PIPELINE_OUTPUT_LIMIT", "Composed PDF exceeds its byte limit");
    for (const value of inputs.values()) requireValue(hash(value.bytes) === value.contentHash);
    const output = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    requireValue(JSON.stringify(output.getPages().map(geometry)) === JSON.stringify(original));
    const contentHash = hash(bytes);
    return { artifact: { mediaType: "application/pdf", contentHash, size: bytes.length, bytes },
      geometryRelation: freeze({ version: 1, base: { id: base.id, contentHash: base.contentHash }, output: { contentHash },
        pages: original.map((page, index) => ({ sourcePage: index + 1, outputPage: index + 1, ...page })) }) };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error.code?.startsWith("PIPELINE_")) throw error;
    fail(INVALID, "PDF composition could not preserve its inputs");
  }
}

module.exports = { composePdf };
