/* Iris - complete bibliography validation, without a DOM. */
importScripts("iris-bibtex.js", "iris-ris.js", "iris-bibliography.js");

/** Request: {requestId:number, documentKey:string, revision:number,
 * text:string, hint:"bib"|"ris"|null}. Response echoes the token with Parsed or error.
 */
self.onmessage = ({ data }) => {
  const { requestId, documentKey, revision, text, hint } = data;
  const token = { requestId, documentKey, revision };
  try {
    self.postMessage({ ...token, result: self.IrisBibliography.parse(text, hint) });
  } catch (_) {
    self.postMessage({ ...token, error: "BIBLIOGRAPHY_PARSE_FAILED" });
  }
};
