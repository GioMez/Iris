/* Read-only original-page metadata; the owner terminates this worker on every exit. */
importScripts("/iris-source-navigation.js");
self.onmessage = async ({ data }) => {
  try {
    const { PDFDocument } = await import("/vendor/pdf-lib/pdf-lib.esm.min.js");
    const pages = await IrisSourceNavigation.readPdfGeometry(data, PDFDocument);
    self.postMessage({ pages });
  } catch {
    self.postMessage({ error: "PDF geometry unavailable" });
  }
};
