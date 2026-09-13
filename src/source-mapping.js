const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isUuid } = require("./ids");
const { resolveBuildFile, resolveBuildDirectory } = require("./builds");
const common = require("./source-mapping-common");
const { MAX_MAP_BYTES, MAX_ENTRIES, MAX_MATCHES, hash, normalizeText, failure, envelope, canonicalPath, validMatch } = common;
const { inspectSyncTeX, querySyncTeX } = require("./source-mapping-synctex");
const { parseLilyMap, queryLilyMap } = require("./source-mapping-lilypond");

const MANIFEST_NAME = ".iris-navigation.json";
const MAX_PDF_BYTES = 128 * 1024 * 1024;
let activeNavigation = 0;

async function readHandle(handle, limit) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > limit) throw failure("map-limit");
  // A bounded read also covers a file growing after stat.
  const bytes = Buffer.alloc(stat.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== stat.size) throw failure("malformed-map");
  return bytes.subarray(0, offset);
}

async function readLocalFile(directory, name, limit = MAX_MAP_BYTES) {
  if (path.basename(name) !== name) throw failure("malformed-map");
  let handle;
  try {
    handle = await fs.open(path.join(directory, name), fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK);
    return await readHandle(handle, limit);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  finally { await handle?.close(); }
}

async function captureMappingSources(snapshotRoot, files, versions) {
  if (files.length > MAX_ENTRIES) throw failure("map-limit");
  const sources = [];
  let bytes = 0;
  for (const file of files) {
    const revision = versions.get(file.id);
    if (!revision || file.binary || ["img", "font"].includes(file.kind)) continue;
    if (!isUuid(file.id) || !isUuid(revision) || !validSourcePath(file.path)) throw failure("malformed-map");
    const handle = await fs.open(path.join(snapshotRoot, file.path), fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    let buffer;
    try { buffer = await readHandle(handle, MAX_MAP_BYTES - bytes); } finally { await handle.close(); }
    if (buffer.includes(0)) continue;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { continue; }
    text = normalizeText(text);
    const source = { sourceFileId: file.id, sourceRevisionId: revision, sourceHash: hash(text), path: file.path, text };
    bytes += Buffer.byteLength(JSON.stringify(source));
    if (bytes > MAX_MAP_BYTES) throw failure("map-limit");
    sources.push(source);
  }
  return sources;
}

function lilypondMappingArgs(enabled, format) {
  return enabled && format === "pdf" ? [`-dinclude-settings=${path.join(__dirname, "lilypond", "source-mapping.ily")}`] : [];
}

function validSourcePath(value) {
  return canonicalPath(value) === value && !value.startsWith("/") && value !== ".." && !value.startsWith("../") && value !== ".";
}

function artifactRecord(a) {
  return { id: a.id, fileName: a.fileName, contentHash: a.contentHash, size: a.size };
}

// Only the private staging output is written. Publication and retention use the
// existing whole-directory lifecycle. Mapping failures never escape to compile.
async function publishSourceMapping({ outputDir, snapshotRoot, sources, projectId, buildId, artifacts, backend, enabled, format, mappingError, binPath = "" }) {
  if (!enabled || format !== "pdf") return envelope(!enabled ? "disabled" : "unsupported");
  let manifest = { version: 1, projectId, buildId, backend, status: "ready", snapshotRoot,
    ...(backend === "latex" ? { texBinPath: binPath ? path.resolve(snapshotRoot, binPath) : "" } : {}),
    sources: sources || [], artifacts: artifacts.map(artifactRecord), entries: [] };
  const rawMaps = [];
  try {
    if (mappingError) throw mappingError;
    if (artifacts.length > MAX_MATCHES) throw failure("map-limit");
    let nativeBytes = 0, decodedBytes = 0, count = manifest.sources.length, collected = false;
    for (const artifact of manifest.artifacts) {
      const stem = artifact.fileName.replace(/\.pdf$/i, "");
      if (backend === "latex") {
        for (const suffix of [".synctex.gz", ".synctex"]) {
          const name = stem + suffix;
          const buffer = await readLocalFile(outputDir, name, MAX_MAP_BYTES - nativeBytes);
          if (!buffer) continue;
          if (artifact.syncFile) throw failure("malformed-map");
          nativeBytes += buffer.length;
          artifact.syncFile = name;
          artifact.syncHash = hash(buffer);
          artifact.syncSize = buffer.length;
          const sync = inspectSyncTeX(buffer, manifest);
          artifact.inputs = sync.inputs;
          artifact.decodedBytes = sync.decodedBytes;
          artifact.entryCount = sync.entries;
          decodedBytes += sync.decodedBytes;
          count += sync.entries;
        }
      } else if (backend === "lilypond") {
        const name = `${stem}.iris-map.tsv`;
        rawMaps.push(name);
        const buffer = await readLocalFile(outputDir, name, MAX_MAP_BYTES - nativeBytes);
        if (!buffer) continue;
        collected = true;
        nativeBytes += buffer.length;
        const entries = parseLilyMap(buffer.toString("utf8"), { ...manifest, artifact });
        count += buffer.toString("utf8").split("\n").length;
        for (const entry of entries) manifest.entries.push(entry);
      } else { manifest.status = "unsupported"; }
      if (count > MAX_ENTRIES || nativeBytes > MAX_MAP_BYTES || decodedBytes > MAX_MAP_BYTES) throw failure("map-limit");
    }
    if (manifest.status === "ready" && (backend === "latex" ? !manifest.artifacts.some((a) => a.syncFile) : !collected)) {
      manifest.status = backend === "lilypond" ? "unsupported" : "missing";
    }
    // Lily TSV is replaced by the normalized map, SyncTeX remains alongside it.
    const retainedBytes = backend === "latex" ? Math.max(nativeBytes, decodedBytes) : 0;
    if (Buffer.byteLength(JSON.stringify(manifest)) + retainedBytes > MAX_MAP_BYTES) throw failure("map-limit");
  } catch (error) {
    manifest = { version: 1, projectId, buildId, backend, status: error.reason === "unsupported" ? "unsupported" : "unavailable",
      ...(error.reason === "unsupported" ? {} : { reason: stableReason(error) }) };
  }
  const temporary = path.join(outputDir, `.iris-navigation-${crypto.randomUUID()}.tmp`);
  try {
    // Compiler output is untrusted. Replace its reserved filename atomically;
    // never accept a compiler-authored manifest or follow its symlink.
    await fs.writeFile(temporary, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path.join(outputDir, MANIFEST_NAME));
  } catch { return envelope("unavailable", "storage-error"); }
  finally {
    await fs.unlink(temporary).catch(() => {});
    for (const name of rawMaps) await fs.unlink(path.join(outputDir, name)).catch(() => {});
    if (manifest.status === "unavailable" && backend === "latex") {
      for (const a of artifacts) for (const suffix of [".synctex", ".synctex.gz"]) {
        await fs.unlink(path.join(outputDir, a.fileName.replace(/\.pdf$/i, suffix))).catch(() => {});
      }
    }
  }
  return envelope(manifest.status, manifest.reason);
}

const reasons = new Set(["busy", "cancelled", "timeout", "output-limit", "engine-missing", "query-failed", "map-limit", "malformed-map", "collector-failed", "stale-artifact", "storage-error"]);
function stableReason(error) { return reasons.has(error?.reason) ? error.reason : "storage-error"; }

function validateManifest(m, { projectId, buildId, artifacts }) {
  if (!m || m.projectId !== projectId || m.buildId !== buildId) throw failure("malformed-map");
  if (Number.isSafeInteger(m.version) && m.version > 1) throw failure("unsupported");
  if (m.version !== 1) throw failure("malformed-map");
  if (!["ready", "missing", "unsupported", "unavailable"].includes(m.status)) throw failure("malformed-map");
  if (m.status !== "ready") return;
  if (!["latex", "lilypond"].includes(m.backend)) throw failure("unsupported");
  if (m.texBinPath !== undefined && (typeof m.texBinPath !== "string" || (m.texBinPath && (!canonicalPath(m.texBinPath) || !path.isAbsolute(m.texBinPath))))) throw failure("malformed-map");
  if (!Array.isArray(m.sources) || !Array.isArray(m.artifacts) || !Array.isArray(m.entries)
    || m.sources.length + m.entries.length > MAX_ENTRIES || m.artifacts.length > MAX_MATCHES
    || canonicalPath(m.snapshotRoot) === null || !m.snapshotRoot.startsWith("/")) throw failure("map-limit");
  const ids = new Set(), paths = new Set(), sourceIndex = new Map();
  for (const s of m.sources) {
    if (!s || !isUuid(s.sourceFileId) || !isUuid(s.sourceRevisionId) || !validSourcePath(s.path) || ids.has(s.sourceFileId) || paths.has(s.path)
      || typeof s.text !== "string" || s.text.includes("\r") || hash(s.text) !== s.sourceHash) throw failure("malformed-map");
    ids.add(s.sourceFileId); paths.add(s.path); sourceIndex.set(s.sourceFileId, s);
  }
  const artifactIds = new Set();
  const resolve = common.sourceResolver(m.sources, m.snapshotRoot);
  let count = m.sources.length + m.entries.length, decodedBytes = 0;
  for (const a of m.artifacts) {
    const current = artifacts.find((item) => item.id === a.id);
    if (!current || artifactIds.has(a.id) || !isUuid(a.id) || a.fileName !== path.basename(a.fileName) || !a.fileName.endsWith(".pdf")
      || a.fileName !== current.fileName || a.size !== current.size || a.contentHash !== current.contentHash) throw failure("stale-artifact");
    artifactIds.add(a.id);
    if (a.syncFile) {
      if (![a.fileName.slice(0, -4) + ".synctex", a.fileName.slice(0, -4) + ".synctex.gz"].includes(a.syncFile)
        || !/^[a-f0-9]{64}$/.test(a.syncHash) || !Number.isSafeInteger(a.syncSize) || a.syncSize < 0 || !Array.isArray(a.inputs)
        || !Number.isSafeInteger(a.entryCount) || a.entryCount < a.inputs.length || !Number.isSafeInteger(a.decodedBytes) || a.decodedBytes < 0) throw failure("malformed-map");
      count += a.entryCount;
      decodedBytes += a.decodedBytes;
      const tags = new Set();
      for (const input of a.inputs) {
        if (!Number.isSafeInteger(input.tag) || input.tag < 1 || tags.has(input.tag) || resolve(input.input)?.sourceFileId !== input.sourceFileId) throw failure("malformed-map");
        tags.add(input.tag);
      }
    }
  }
  if (count > MAX_ENTRIES || decodedBytes + Buffer.byteLength(JSON.stringify(m)) > MAX_MAP_BYTES) throw failure("map-limit");
  m.entries = m.entries.map((entry) => {
    const s = sourceIndex.get(entry.sourceFileId);
    if (!validMatch(entry) || !s || !artifactIds.has(entry.artifactId) || entry.sourceRevisionId !== s.sourceRevisionId || entry.sourceHash !== s.sourceHash) throw failure("malformed-map");
    const { artifactId, page, x, y, width, height, sourceFileId, sourceRevisionId, sourceHash, line, column } = entry;
    return { artifactId, page, x, y, width, height, sourceFileId, sourceRevisionId, sourceHash, line, column };
  });
}

async function readStored(context, name, limit = MAX_MAP_BYTES) {
  const file = await resolveBuildFile(context.projectStorageDir, context.buildId, context.storagePath, name);
  if (!file) return null;
  try { return await readHandle(file.handle, limit); } finally { await file.handle.close(); }
}

async function verifyArtifacts(context, manifest, deadline) {
  let remaining = MAX_PDF_BYTES, mapBytes = 0;
  for (const a of manifest.artifacts) {
    if (context.signal?.aborted) throw failure("cancelled");
    if (Date.now() >= deadline) throw failure("timeout");
    if (!Number.isSafeInteger(a.size) || a.size < 0 || a.size > remaining) throw failure("map-limit");
    const file = await resolveBuildFile(context.projectStorageDir, context.buildId, context.storagePath, a.fileName);
    if (!file) throw failure("stale-artifact");
    try {
      if (file.size !== a.size) throw failure("stale-artifact");
      const digest = crypto.createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset <= a.size) {
        if (context.signal?.aborted) throw failure("cancelled");
        if (Date.now() >= deadline) throw failure("timeout");
        const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, a.size - offset + 1), offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > a.size) throw failure("stale-artifact");
        digest.update(buffer.subarray(0, bytesRead));
      }
      if (offset !== a.size || digest.digest("hex") !== a.contentHash) throw failure("stale-artifact");
    } finally { await file.handle.close(); }
    remaining -= a.size;
    if (a.syncFile) {
      const sync = await readStored(context, a.syncFile, MAX_MAP_BYTES - mapBytes);
      if (!sync || sync.length !== a.syncSize || hash(sync) !== a.syncHash) throw failure("malformed-map");
      mapBytes += sync.length;
      // The CLI must not select an unchecked alternative of the same job.
      const alternate = a.syncFile.endsWith(".gz") ? a.syncFile.slice(0, -3) : a.syncFile + ".gz";
      const directory = await resolveBuildDirectory(context.projectStorageDir, context.buildId, context.storagePath);
      if (!directory || await fs.lstat(path.join(directory, alternate)).catch(() => null)) throw failure("malformed-map");
    }
  }
  return mapBytes;
}

async function navigateBuild(context) {
  if (!context.enabled) return envelope("disabled");
  if (context.signal?.aborted) return envelope("unavailable", "cancelled");
  if (activeNavigation >= 2) return envelope("unavailable", "busy");
  activeNavigation++;
  const deadline = Date.now() + 5000;
  try {
    const bytes = await readStored(context, MANIFEST_NAME);
    if (!bytes) return envelope("missing");
    let manifest;
    try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw failure("malformed-map"); }
    validateManifest(manifest, context);
    if (manifest.status !== "ready") return envelope(manifest.status, manifest.status === "unavailable" ? stableReason(manifest) : undefined);
    if (bytes.length + await verifyArtifacts(context, manifest, deadline) > MAX_MAP_BYTES) throw failure("map-limit");
    let matches = [];
    if (manifest.backend === "lilypond") matches = queryLilyMap(manifest.entries, context.query);
    else {
      const directory = await resolveBuildDirectory(context.projectStorageDir, context.buildId, context.storagePath);
      if (!directory) return envelope("missing");
      const artifacts = [...manifest.artifacts].sort((a, b) => Number(b.id === context.query.artifactId) - Number(a.id === context.query.artifactId));
      for (const artifact of artifacts) {
        if (!artifact.syncFile || (context.query.direction === "inverse" && artifact.id !== context.query.artifactId)) continue;
        if (Date.now() >= deadline) throw failure("timeout");
        const candidates = await querySyncTeX({ ...context, ...manifest, directory, artifact, query: context.query,
          binPath: context.binPath ?? manifest.texBinPath ?? "", timeoutMs: deadline - Date.now() });
        for (const match of candidates) common.retainNavigationMatch(matches, match, context.query);
        // A later PDF may improve a page hint even when an earlier one fills
        // the response. The artifact and shared elapsed-time limits still apply.
        if (matches.length >= MAX_MATCHES && (context.query.direction !== "forward" || context.query.page === undefined)) break;
      }
    }
    if (context.signal?.aborted) throw failure("cancelled");
    if (manifest.backend === "latex" && matches.length) await verifyArtifacts(context, manifest, deadline);
    if (context.query.direction === "forward") matches.sort((a, b) => common.compareNavigationMatches(a, b, context.query));
    return matches.length ? { status: "ready", matches: matches.slice(0, MAX_MATCHES) } : envelope("no-match");
  } catch (error) { return error.reason === "unsupported" ? envelope("unsupported") : envelope("unavailable", stableReason(error)); }
  finally { activeNavigation--; }
}

module.exports = { ...common, MANIFEST_NAME, captureMappingSources, lilypondMappingArgs, publishSourceMapping, navigateBuild };
