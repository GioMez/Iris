/* Iris · guarded PDF/source navigation. Positions are 1-based rows, UTF-16 columns. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IrisSourceNavigation = api;
})(typeof window === "object" ? window : globalThis, function () {
  const normalize = (text) => text.replace(/\r\n?/g, "\n");
  async function sourceHash(text) {
    const bytes = new TextEncoder().encode(normalize(text));
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function isGesture(event, platform = navigator.platform) {
    const mac = /Mac|iPhone|iPad/.test(platform);
    return event.button === 0 && !event.altKey && !event.shiftKey &&
      (mac ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey);
  }
  function sourceRange(text, { line, column }) {
    const lines = text.split(/\r\n?|\n/);
    if (!Number.isInteger(line) || line < 1 || line > lines.length ||
      (column !== null && (!Number.isInteger(column) || column < 0 || column > lines[line - 1].length))) return null;
    let from = 0, row = 1;
    for (const separator of text.matchAll(/\r\n?|\n/g)) {
      if (row++ >= line) break;
      from = separator.index + separator[0].length;
    }
    return column === null ? { from, to: from + lines[line - 1].length } : { from: from + column, to: from + column };
  }
  // Use the CSS viewport's affine transform, never the raster's DPR-scaled one.
  // Native API points start at the unrotated MediaBox's top-left, in PDF
  // default user-space units (1/72 inch for the qualified native engines).
  // PDF.js viewBox is the visible crop, never a substitute for the MediaBox.
  function pdfPoint(viewport, rect, clientX, clientY, mediaBox) {
    if (!mediaBox || !rect.width || !rect.height) return null;
    const [a, b, c, d, e, f] = viewport.transform, determinant = a * d - b * c;
    if (!determinant) return null;
    const x = (clientX - rect.left) * viewport.width / rect.width - e;
    const y = (clientY - rect.top) * viewport.height / rect.height - f;
    return { x: (d * x - c * y) / determinant - mediaBox[0],
      y: mediaBox[3] - (-b * x + a * y) / determinant };
  }
  function pdfBox(viewport, box, mediaBox) {
    if (!mediaBox) return null;
    const [a, b, c, d, e, f] = viewport.transform;
    const points = [box.x, box.x + box.width].flatMap((x) => [box.y, box.y + box.height].map((y) => {
      const px = x + mediaBox[0], py = mediaBox[3] - y;
      return [a * px + c * py + e, b * px + d * py + f];
    }));
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  async function readPdfGeometry(bytes, PDFDocument) {
    if (!bytes?.length || bytes.length > 128 * 1024 * 1024) throw new Error("PDF geometry byte limit");
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (doc.getPageCount() > 200000) throw new Error("PDF geometry page limit");
    return doc.getPages().map((page) => {
      // Resolves inherited boxes and indirect/compressed objects through the
      // parser. No document mutation, serialization or annotation access.
      const { x, y, width, height } = page.getMediaBox();
      if (![x, y, width, height, x + width, y + height].every((n) => Number.isFinite(n) && Math.abs(n) <= 1000000) || width <= 0 || height <= 0) {
        throw new Error("Invalid PDF MediaBox");
      }
      return [x, y, x + width, y + height];
    });
  }
  function loadPdfGeometry(bytes, { signal } = {}) {
    signal?.throwIfAborted();
    if (!bytes?.length || bytes.length > 128 * 1024 * 1024) return Promise.reject(new Error("PDF geometry byte limit"));
    return new Promise((resolve, reject) => {
      const worker = new Worker("/iris-pdf-geometry-worker.js");
      const finish = (error, pages) => {
        clearTimeout(timer); signal?.removeEventListener("abort", cancel);
        worker.terminate();
        if (error) reject(error); else resolve(pages);
      };
      const cancel = () => finish(signal.reason || new Error("PDF geometry cancelled"));
      const timer = setTimeout(() => finish(new Error("PDF geometry timeout")), 5000);
      signal?.addEventListener("abort", cancel, { once: true });
      worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.pages);
      worker.onerror = () => finish(new Error("PDF geometry unavailable"));
      try {
        const copy = bytes.slice(); // Never transfer/detach the viewer/download bytes.
        worker.postMessage(copy, [copy.buffer]);
      } catch (error) { finish(error); }
    });
  }
  function create({ context, request, source, prepare, apply, status }) {
    let generation = 0, pending = null;
    function cancel() { generation++; pending?.abort(); pending = null; }
    async function navigate(query) {
      cancel();
      const snapshot = context(), token = generation;
      const current = () => token === generation && Object.entries(snapshot).every(([key, value]) => context()[key] === value) &&
        Object.keys(context()).length === Object.keys(snapshot).length;
      if (!snapshot.enabled) { status("disabled"); return false; }
      if (snapshot.format !== "pdf") { status("unsupported"); return false; }
      if (!snapshot.projectId || !snapshot.buildId) { status("missing"); return false; }
      const abort = pending = new AbortController();
      let document, prepared;
      try {
        // An inverse click may need lazy original-page geometry. Keep that
        // acquisition inside the same off/currency/cancellation boundary.
        if (typeof query === "function") {
          query = await query({ signal: abort.signal });
          if (!current() || !query) return false;
        }
        const result = await request(snapshot.buildId, query, { signal: abort.signal });
        if (!current()) return false;
        if (result.status !== "ready") { status(result.status); return false; }
        const match = result.matches?.[0];
        if (!match) { status("no-match"); return false; }
        document = await source(match.sourceFileId, { signal: abort.signal });
        if (!current()) return false;
        if (!document) { status("missing"); return false; }
        const hash = await sourceHash(document.text);
        if (!current()) return false;
        if (!document.current() || hash !== match.sourceHash || !sourceRange(document.text, match)) { status("stale"); return false; }
        prepared = await prepare(match, query, { signal: abort.signal });
        if (!current()) return false;
        // The authority can change while hashing or preparing another PDF.
        if (!document.current()) { status("stale"); return false; }
        // Applying a forward match includes the eventual reveal, not just
        // installing its artifact. Keep cancellation and source ownership alive
        // while the app performs its own guarded layout transition.
        const applied = await apply(match, document, prepared, query, {
          signal: abort.signal, current: () => token === generation && !abort.signal.aborted,
        });
        return applied !== false && token === generation && !abort.signal.aborted;
      } catch (error) {
        if (current() && !abort.signal.aborted && !error.stale) status(error.status === 404 ? "missing" : "unavailable");
        return false;
      } finally {
        document?.dispose?.(); prepared?.dispose?.();
        if (pending === abort) pending = null;
      }
    }
    return { navigate, cancel };
  }
  return { create, sourceHash, sourceRange, isGesture, pdfPoint, pdfBox, readPdfGeometry, loadPdfGeometry };
});
