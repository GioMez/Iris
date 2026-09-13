const crypto = require("node:crypto");
const path = require("node:path");
const { isUuid } = require("./ids");

const MAX_MAP_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 200000;
const MAX_MATCHES = 32;
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const normalizeText = (text) => text.replace(/\r\n?/g, "\n");
const failure = (reason) => Object.assign(new Error("Source mapping unavailable"), { reason });
const envelope = (status, reason) => ({ status, matches: [], ...(reason ? { reason } : {}) });
const positive = (n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const coordinate = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000000;

function normalizeSourceMapping(value) {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw Object.assign(new Error("Invalid source mapping setting"), { status: 400, errorCode: "SOURCE_MAPPING_INVALID" });
  return value;
}

function validateNavigationQuery(query) {
  const bad = () => { throw Object.assign(new Error("Invalid navigation query"), { status: 400, errorCode: "SOURCE_NAVIGATION_INVALID" }); };
  if (!query || typeof query !== "object" || Array.isArray(query)) bad();
  const allowed = query.direction === "forward" ? ["direction", "sourceFileId", "line", "column", "artifactId", "page"] : ["direction", "artifactId", "page", "x", "y"];
  if (Object.keys(query).some((key) => !allowed.includes(key))) bad();
  if (query.direction === "forward") {
    if (!isUuid(query.sourceFileId) || !positive(query.line) || !Number.isSafeInteger(query.column) || query.column < 0 || query.column > MAX_MAP_BYTES) bad();
    if (query.artifactId !== undefined && !isUuid(query.artifactId)) bad();
    if (query.page !== undefined && !positive(query.page)) bad();
  } else if (query.direction === "inverse") {
    if (!isUuid(query.artifactId) || !positive(query.page) || !coordinate(query.x) || !coordinate(query.y)) bad();
  } else bad();
  return query;
}

function canonicalPath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value)) return null;
  return path.posix.normalize(value).replace(/^\/private\/var\//, "/var/");
}

function sourceResolver(sources, snapshotRoot) {
  const root = canonicalPath(snapshotRoot);
  if (!root || !root.startsWith("/")) throw failure("malformed-map");
  const index = new Map(sources.map((s) => [path.posix.join(root, s.path), s]));
  return (input) => {
    const normalized = canonicalPath(input);
    return normalized ? index.get(normalized.startsWith("/") ? normalized : path.posix.resolve(root, normalized)) || null : null;
  };
}

// Per-read index, discarded with the manifest. Only astral characters affect
// LilyPond character -> UTF-16 conversion; tabs do not change character offsets.
function columnConverter() {
  const sources = new Map();
  let count = 0;
  return (source, line, column) => {
    if (!positive(line) || !Number.isSafeInteger(column) || column < 0) return null;
    let lines = sources.get(source);
    if (!lines) {
      lines = source.text.split("\n", MAX_ENTRIES + 1).map((text) => {
        const astral = [];
        let chars = 0;
        for (const char of text) {
          if (char.length === 2) { astral.push(chars); if (++count > MAX_ENTRIES) throw failure("map-limit"); }
          chars++;
        }
        if (++count > MAX_ENTRIES) throw failure("map-limit");
        return { astral, chars };
      });
      sources.set(source, lines);
    }
    const row = lines[line - 1];
    if (!row || column > row.chars) return null;
    let low = 0, high = row.astral.length;
    while (low < high) { const middle = (low + high) >>> 1; if (row.astral[middle] < column) low = middle + 1; else high = middle; }
    return column + low;
  };
}

function sourceMatch(source, line, column) {
  return { sourceFileId: source.sourceFileId, sourceRevisionId: source.sourceRevisionId, sourceHash: source.sourceHash, line, column };
}

function validMatch(m) {
  return m && isUuid(m.artifactId) && isUuid(m.sourceFileId) && isUuid(m.sourceRevisionId) && /^[a-f0-9]{64}$/.test(m.sourceHash)
    && positive(m.page) && positive(m.line) && (m.column === null || (Number.isSafeInteger(m.column) && m.column >= 0 && m.column <= MAX_MAP_BYTES))
    && [m.x, m.y, m.width, m.height].every(coordinate);
}

function compareNavigationMatches(a, b, query) {
  if (query.direction !== "forward") return 0;
  return Number(b.artifactId === query.artifactId && b.page === query.page) - Number(a.artifactId === query.artifactId && a.page === query.page)
    || Number(b.artifactId === query.artifactId) - Number(a.artifactId === query.artifactId)
    || Number(b.page === query.page) - Number(a.page === query.page);
}

// Keep only the best 32 while reading bounded native output. Equal-priority
// candidates retain native/artifact order, including after the set is full.
function retainNavigationMatch(matches, match, query) {
  const index = matches.findIndex((current) => compareNavigationMatches(match, current, query) < 0);
  if (index >= 0) matches.splice(index, 0, match);
  else if (matches.length < MAX_MATCHES) matches.push(match);
  if (matches.length > MAX_MATCHES) matches.pop();
}

module.exports = { MAX_MAP_BYTES, MAX_ENTRIES, MAX_MATCHES, hash, normalizeText, failure, envelope, positive, coordinate,
  normalizeSourceMapping, validateNavigationQuery, canonicalPath, sourceResolver, columnConverter, sourceMatch, validMatch,
  compareNavigationMatches, retainNavigationMatch };
