const { createHash } = require("node:crypto");
const { validateLayout, collectLayout } = require("./layout");
const { readPolicy, LUA_DATA_POLICY, fail } = require("./contracts");

// MuPDF.js 1.28.1 fill_shade wraps a borrowed pointer without keeping it (unlike
// its image/path/text callbacks). Neither destroy() nor its GC finalizer may
// drop that pointer. Pin these wrappers until this one-shot process exits;
// document destruction releases the actual resources. Do not patch the package
// or rely on its private FinalizationRegistry. The per-call budget bounds pins.
const borrowedShades = [];

// Called in the bounded native-tool process, never on the server event loop.
async function extractPdfLayout(bytes, { artifact, policy } = {}) {
  if (createHash("sha256").update(bytes).digest("hex") !== artifact?.contentHash) {
    fail("PIPELINE_LAYOUT_INVALID", "PDF bytes do not match their layout identity");
  }
  const budget = readPolicy({ ...LUA_DATA_POLICY, ...policy });
  const mupdf = (await import("mupdf")).default;
  let document, warning = false, regionCount = 0, regionBytes = 0;
  const firstShade = borrowedShades.length;
  const result = { version: 1, artifact: { id: artifact.id, contentHash: artifact.contentHash },
    units: "pdf-point", origin: "media-box-top-left", collector: { id: "mupdf", version: "1.28.1" },
    coverage: "complete", reasons: [], pageCount: null, pages: [] };
  const unavailable = () => collectLayout({ compilerResult: { code: 0 }, artifact, collectorData: null, policy });
  mupdf.setLog({ warning() { warning = true; }, error() { warning = true; } });
  try {
    document = mupdf.Document.openDocument(bytes, "application/pdf");
    if (!document.isPDF() || document.needsPassword()) return unavailable();
    const count = document.countPages();
    if (!count) return unavailable();
    if (count > budget.maxValues / 32) fail("PIPELINE_LAYOUT_LIMIT", "Layout exceeds its metadata limit");
    result.pageCount = count;
    const repaired = document.wasRepaired(), optional = document.countLayers() > 0;
    for (let index = 0; index < count; index++) {
      let page, object, device;
      try {
        page = document.loadPage(index); object = page.getObject();
        function read(key, fallback) {
          const value = object.getInheritable(key);
          try {
            if (value.isNull()) return fallback;
            if (value.isNumber()) return value.asNumber();
            if (value.isArray() && value.length === 4) {
              return Array.from({ length: 4 }, (_, i) => {
                const entry = value.get(i);
                try { return entry.isNumber() ? entry.asNumber() : NaN; } finally { entry.destroy(); }
              });
            }
            throw new Error("Invalid PDF page geometry");
          } finally { value.destroy(); }
        }
        const mediaBox = read("MediaBox"), cropBox = read("CropBox", mediaBox), userUnit = read("UserUnit", 1);
        const rawRotation = read("Rotate", 0), rotation = ((rawRotation % 360) + 360) % 360;
        const width = (mediaBox[2] - mediaBox[0]) * userUnit, height = (mediaBox[3] - mediaBox[1]) * userUnit;
        const record = { page: index + 1, mediaBox, cropBox, rotation, userUnit, width, height,
          coverage: "complete", reasons: [], occupied: [] };
        const reasons = new Set();
        if (repaired) reasons.add("repaired-pdf");
        if (optional) reasons.add("optional-content");
        // MuPDF's native page transform includes CropBox, rotation and UserUnit.
        // Undo it, then map raw PDF user space to physical MediaBox coordinates.
        const matrix = mupdf.Matrix.concat(mupdf.Matrix.invert(page.getTransform()),
          [userUnit, 0, 0, -userUnit, -mediaBox[0] * userUnit, mediaBox[3] * userUnit]);
        const clips = [[0, 0, width, height]];
        const intersect = bounds => {
          const clip = clips[clips.length - 1];
          return [Math.max(clip[0], bounds[0]), Math.max(clip[1], bounds[1]), Math.min(clip[2], bounds[2]), Math.min(clip[3], bounds[3])];
        };
        function add(kind, bounds) {
          if (!bounds.every(Number.isFinite)) throw new Error("Nonfinite drawing bounds");
          bounds = intersect(bounds);
          if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return;
          const region = { kind, bounds };
          regionBytes += Buffer.byteLength(JSON.stringify(region)) + 1;
          if (++regionCount * 7 > budget.maxValues || regionBytes > budget.maxPlanBytes) {
            fail("PIPELINE_LAYOUT_LIMIT", "Layout exceeds its metadata limit");
          }
          record.occupied.push(region);
        }
        function drawing(kind, shape, stroke, transform, colorSpace) {
          try { add(kind, shape.getBounds(stroke, transform)); }
          finally { shape.destroy(); stroke?.destroy(); colorSpace?.destroy(); }
        }
        function clip(shape, stroke, transform) {
          try { clips.push(intersect(shape.getBounds(stroke, transform))); }
          finally { shape.destroy(); stroke?.destroy(); }
        }
        device = new mupdf.Device({
          fillPath(p, even, m, cs) { drawing("path", p, null, m, cs); },
          strokePath(p, s, m, cs) { drawing("stroke", p, s, m, cs); },
          fillText(t, m, cs) { drawing("text", t, null, m, cs); },
          strokeText(t, s, m, cs) { drawing("text-stroke", t, s, m, cs); },
          clipPath(p, even, m) { clip(p, null, m); },
          clipStrokePath(p, s, m) { clip(p, s, m); },
          clipText(t, m) { clip(t, null, m); },
          clipStrokeText(t, s, m) { clip(t, s, m); },
          clipImageMask(image, m) { try { clips.push(intersect(mupdf.Rect.transform([0, 0, 1, 1], m))); } finally { image.destroy(); } },
          popClip() { if (clips.length < 2) throw new Error("Unbalanced PDF clipping"); clips.pop(); },
          fillImage(image, m) { try { add("image", mupdf.Rect.transform([0, 0, 1, 1], m)); } finally { image.destroy(); } },
          fillImageMask(image, m, cs) { try { add("image-mask", mupdf.Rect.transform([0, 0, 1, 1], m)); } finally { image.destroy(); cs.destroy(); } },
          fillShade(shade, m) {
            borrowedShades.push(shade);
            if (borrowedShades.length - firstShade > budget.maxValues) fail("PIPELINE_LAYOUT_LIMIT", "Layout exceeds its metadata limit");
            add("shade", mupdf.Rect.transform(shade.getBounds(), m));
          },
          beginMask(bounds, luminosity, cs) { reasons.add("unqualified-mask"); cs.destroy(); },
          endMask() { clips.push(clips[clips.length - 1]); },
          beginGroup(bounds, cs) { reasons.add("unqualified-group"); cs.destroy(); },
          beginTile() { reasons.add("unqualified-tile"); return 0; },
        });
        try { page.run(device, matrix); device.close(); }
        catch (error) {
          if (error.code === "PIPELINE_LAYOUT_LIMIT") throw error;
          record.occupied = []; record.coverage = "unavailable"; reasons.add("collector-error");
        }
        if (warning) reasons.add("pdf-warning");
        record.reasons = [...reasons].sort();
        if (record.coverage !== "unavailable" && reasons.size) record.coverage = "partial";
        result.pages.push(record);
      } finally { device?.destroy(); object?.destroy(); page?.destroy(); }
    }
    result.reasons = [...new Set(result.pages.flatMap(page => page.reasons))].sort();
    result.coverage = result.pages.every(page => page.coverage === "unavailable") ? "unavailable"
      : result.reasons.length ? "partial" : "complete";
    return validateLayout(result, { artifact, policy });
  } catch (error) {
    if (error.code?.startsWith("PIPELINE_")) throw error;
    return unavailable();
  } finally { document?.destroy(); mupdf.setLog(null); }
}

module.exports = { extractPdfLayout };
