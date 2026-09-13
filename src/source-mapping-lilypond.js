const { MAX_MAP_BYTES, MAX_ENTRIES, MAX_MATCHES, failure, positive, coordinate, sourceResolver, columnConverter, sourceMatch, validMatch } = require("./source-mapping-common");

function parseLilyMap(raw, { sources, snapshotRoot, artifact }) {
  if (Buffer.byteLength(raw) > MAX_MAP_BYTES) throw failure("map-limit");
  const lines = raw.split("\n", MAX_ENTRIES + 3);
  if (lines.shift() !== "IRIS-LILYPOND\t1") throw failure("malformed-map");
  if (lines.length > MAX_ENTRIES + 1) throw failure("map-limit");
  const pages = new Map(), entries = [];
  const resolve = sourceResolver(sources, snapshotRoot), convert = columnConverter();
  for (const line of lines) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields[0] === "E") throw failure(fields[1] === "budget" ? "map-limit" : "collector-failed");
    if (fields[0] === "P") {
      const [page, width, height] = fields.slice(1).map(Number);
      if (fields.length !== 4 || !positive(page) || page !== pages.size + 1 || !coordinate(width) || !coordinate(height) || !width || !height) throw failure("malformed-map");
      pages.set(page, { width, height });
      continue;
    }
    if (fields[0] !== "G" || fields.length !== 10) throw failure("malformed-map");
    const page = Number(fields[1]), row = Number(fields[3]);
    let input;
    try { input = decodeURIComponent(fields[2]); } catch { throw failure("malformed-map"); }
    const [x, y, width, height] = fields.slice(6).map(Number);
    const paper = pages.get(page);
    if (!paper || !positive(row) || ![x, y, width, height].every(coordinate) || x + width > paper.width + 2 || y + height > paper.height + 2) throw failure("malformed-map");
    const source = resolve(input);
    if (!source) continue;
    const column = convert(source, row, Number(fields[4]));
    if (column === null) throw failure("malformed-map");
    const match = { artifactId: artifact.id, page, x, y, width, height, ...sourceMatch(source, row, column) };
    if (!validMatch(match)) throw failure("malformed-map");
    entries.push(match);
  }
  if (!pages.size) throw failure("malformed-map");
  return entries;
}

function queryLilyMap(entries, query) {
  let matches;
  if (query.direction === "forward") {
    const order = new Map();
    for (const m of entries) if (!order.has(m.artifactId)) order.set(m.artifactId, order.size);
    matches = entries.filter((m) => m.sourceFileId === query.sourceFileId && m.line === query.line);
    const distance = (m) => m.column === null ? Infinity : Math.abs(m.column - query.column);
    const best = matches.reduce((d, m) => Math.min(d, distance(m)), Infinity);
    matches = matches.filter((m) => distance(m) === best);
    matches.sort((a, b) => Number(b.artifactId === query.artifactId && b.page === query.page) - Number(a.artifactId === query.artifactId && a.page === query.page)
      || Number(b.artifactId === query.artifactId) - Number(a.artifactId === query.artifactId)
      || Number(b.page === query.page) - Number(a.page === query.page)
      || order.get(a.artifactId) - order.get(b.artifactId) || a.page - b.page || a.y - b.y || a.x - b.x);
  } else {
    const distance = (m) => Math.hypot(Math.max(m.x - query.x, 0, query.x - m.x - m.width), Math.max(m.y - query.y, 0, query.y - m.y - m.height));
    matches = entries.filter((m) => m.artifactId === query.artifactId && m.page === query.page && distance(m) <= 3);
    matches.sort((a, b) => distance(a) - distance(b) || a.width * a.height - b.width * b.height);
  }
  const seen = new Set();
  return matches.filter((m) => { const key = JSON.stringify(m); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, MAX_MATCHES);
}

module.exports = { parseLilyMap, queryLilyMap };
