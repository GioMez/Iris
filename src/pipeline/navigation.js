const fs = require("node:fs/promises");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { isUuid } = require("../ids");
const mapping = require("../source-mapping");
const { checkedPath, openCheckedFile } = require("./workspaces");
const { logicalPath, fail } = require("./contracts");
const { MEDIA_TYPE: LAYOUT_TYPE } = require("./layout");
const { checkedComposition } = require("./pdf-runner");

// Compiler paths are private. Each native sidecar receives an artifact-ID alias
// so equal native filenames from different steps/ports cannot select another PDF.
async function collectCompilerMapping({ context, compiled, products, projectId, runId, sourceCache }) {
  if (!isUuid(projectId) || !isUuid(runId) || compiled.stepId !== context.step.id || !["latex", "lilypond"].includes(compiled.family)) {
    fail("PIPELINE_MAPPING_INVALID", "Invalid compiler mapping context");
  }
  const base = { version: 1, projectId, buildId: runId, backend: compiled.family }, usage = { nativeRecords: 0, nativeBytes: 0 };
  if (!compiled.mappingEnabled || compiled.format !== "pdf") {
    return { manifest: { ...base, status: !compiled.mappingEnabled ? "disabled" : "unsupported" }, nativeFiles: [], mappedArtifacts: [], usage };
  }
  const byOutput = new Map(compiled.outputs.map(file => [`${file.outputPort}:${file.path}`, file]));
  const artifacts = [], aliases = new Map(), nativeFiles = new Map(), mappedArtifacts = new Set();
  let sources, mappingError;
  try {
    for (const product of products.filter(product => product.mediaType !== LAYOUT_TYPE)) for (const file of product.files) {
      const origin = byOutput.get(`${product.outputPort}:${file.path}`);
      if (!origin || origin.contentHash !== file.contentHash || origin.size !== file.size || !isUuid(file.id)
        || file.producerStep !== compiled.stepId || file.outputPort !== product.outputPort) throw mapping.failure("stale-artifact");
      logicalPath(origin.compiledPath, "PIPELINE_MAPPING_INVALID");
      if (!origin.compiledPath.endsWith(".pdf")) continue;
      artifacts.push({ id: file.id, fileName: `${file.id}.pdf`, size: file.size, contentHash: file.contentHash });
      for (const suffix of [".synctex", ".synctex.gz", ".iris-map.tsv"]) aliases.set(`${file.id}${suffix}`, origin.compiledPath.slice(0, -4) + suffix);
    }
    const input = context.inputs.source;
    let captured = sourceCache?.get(input.files);
    if (!captured) {
      captured = mapping.captureMappingSources(input.root, input.files, new Map(input.files.map(file => [file.id, file.sourceRevisionId])));
      sourceCache?.set(input.files, captured);
    }
    sources = await captured;
  } catch (error) { mappingError = error; }
  context.signal?.throwIfAborted();
  const manifest = await mapping.collectSourceMapping({ ...base, artifacts, sources, mappingError,
    snapshotRoot: compiled.snapshotRoot, backend: compiled.family,
    async readMap(name, limit) {
      context.signal?.throwIfAborted();
      const relative = aliases.get(name);
      if (!relative) throw mapping.failure("malformed-map");
      let handle;
      try {
        ({ input: handle } = await openCheckedFile(compiled.outputDir, relative));
        const bytes = await mapping.readMappingHandle(handle, limit);
        usage.nativeBytes += bytes.length;
        mappedArtifacts.add(name.slice(0, 36));
        if (compiled.family === "lilypond") {
          usage.nativeRecords++;
          for (let offset = bytes.indexOf(10); offset !== -1; offset = bytes.indexOf(10, offset + 1)) usage.nativeRecords++;
        }
        if (compiled.family === "latex") nativeFiles.set(name, { name, root: compiled.outputDir,
          path: relative, size: bytes.length, contentHash: mapping.hash(bytes) });
        return bytes;
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      finally { await handle?.close(); }
    },
  });
  context.signal?.throwIfAborted();
  if (compiled.family === "latex") usage.nativeRecords = manifest.artifacts?.reduce((sum, artifact) => sum + (artifact.entryCount || 0), 0) || 0;
  return { manifest, nativeFiles: manifest.status === "ready" ? [...nativeFiles.values()] : [], mappedArtifacts: [...mappedArtifacts], usage };
}

const pdfMembers = products => products.flatMap(product => product.files.filter(file => product.mediaType === "application/pdf" || /\.pdf$/i.test(file.path)));

// Collection descriptors remain host-only. The versioned manifest shares source
// text and records each published PDF's own backend and mapping availability.
function assembleRunMapping({ projectId, runId, collections, products, compositions = [] }) {
  const base = { version: 2, projectId, buildId: runId };
  try {
    if (!isUuid(projectId) || !isUuid(runId)) throw mapping.failure("malformed-map");
    const sources = new Map(), paths = new Map(), origins = new Map(), nativeFiles = new Map();
    let nativeRecords = 0, nativeReadBytes = 0, decodedReadBytes = 0;
    for (const { navigation, products: produced } of collections) {
      const { manifest, usage } = navigation;
      if (manifest.projectId !== projectId || manifest.buildId !== runId || manifest.version !== 1) throw mapping.failure("malformed-map");
      if (manifest.status === "unavailable" && manifest.reason === "map-limit") throw mapping.failure("map-limit");
      if (!Number.isSafeInteger(usage.nativeRecords) || usage.nativeRecords < 0 || !Number.isSafeInteger(usage.nativeBytes) || usage.nativeBytes < 0) throw mapping.failure("malformed-map");
      nativeRecords += usage.nativeRecords; nativeReadBytes += usage.nativeBytes;
      decodedReadBytes += (manifest.artifacts || []).reduce((sum, artifact) => sum + (artifact.decodedBytes || 0), 0);
      for (const source of manifest.sources || []) {
        const previous = sources.get(source.sourceFileId);
        if ((previous && !isDeepStrictEqual(previous, source)) || (paths.has(source.path) && paths.get(source.path) !== source.sourceFileId)) throw mapping.failure("malformed-map");
        sources.set(source.sourceFileId, source); paths.set(source.path, source.sourceFileId);
      }
      if (sources.size + nativeRecords > mapping.MAX_ENTRIES || nativeReadBytes > mapping.MAX_MAP_BYTES
        || decodedReadBytes > mapping.MAX_MAP_BYTES) throw mapping.failure("map-limit");
      for (const file of pdfMembers(produced)) {
        if (origins.has(file.id)) throw mapping.failure("malformed-map");
        origins.set(file.id, { navigation, file });
      }
    }
    const derived = new Map();
    for (const item of compositions) {
      const relation = checkedComposition(item.context, item.relation, item.products);
      if (derived.has(relation.output.id) || origins.has(relation.output.id)) throw mapping.failure("malformed-map");
      derived.set(relation.output.id, { relation, base: item.context.inputs.base });
    }
    const artifacts = [], entries = [], ids = new Set();
    let pdfBytes = 0, retainedBytes = 0, decodedBytes = 0;
    for (const file of pdfMembers(products)) {
      if (ids.has(file.id)) throw mapping.failure("malformed-map");
      ids.add(file.id); pdfBytes += file.size;
      if (ids.size > mapping.MAX_MATCHES || pdfBytes > 128 * 1024 * 1024) throw mapping.failure("map-limit");
      let source = file;
      const visited = new Set();
      while (derived.has(source.id)) {
        if (visited.has(source.id)) throw mapping.failure("malformed-map");
        visited.add(source.id);
        const { relation, base } = derived.get(source.id);
        if (relation.output.contentHash !== source.contentHash || relation.output.size !== source.size) throw mapping.failure("stale-artifact");
        source = base;
      }
      const origin = origins.get(source.id), m = origin?.navigation.manifest;
      if (origin && (origin.file.size !== source.size || origin.file.contentHash !== source.contentHash)) throw mapping.failure("stale-artifact");
      const original = m?.artifacts?.find(artifact => artifact.id === source.id);
      let status = m?.status === "disabled" ? "missing" : m?.status || "unsupported";
      if (status === "ready" && !origin.navigation.mappedArtifacts.includes(source.id)) status = m.backend === "latex" ? "missing" : "unsupported";
      if (status === "ready" && (!original || original.size !== source.size || original.contentHash !== source.contentHash)) throw mapping.failure("stale-artifact");
      const artifact = { ...(status === "ready" ? original : {}), id: file.id, fileName: `${file.id}.pdf`, size: file.size, contentHash: file.contentHash,
        backend: m?.backend || null, status, ...(status === "ready" ? { snapshotRoot: m.snapshotRoot } : {}),
        ...(status === "unavailable" ? { reason: m.reason } : {}) };
      artifacts.push(artifact);
      if (status !== "ready") continue;
      for (const entry of m.entries) if (entry.artifactId === source.id) entries.push(source.id === file.id ? entry : { ...entry, artifactId: file.id });
      if (artifact.syncFile) {
        const native = origin.navigation.nativeFiles.find(item => item.name === artifact.syncFile);
        if (!native || native.contentHash !== artifact.syncHash || native.size !== artifact.syncSize) throw mapping.failure("malformed-map");
        const name = `${file.id}${native.name.endsWith(".gz") ? ".synctex.gz" : ".synctex"}`;
        artifact.syncFile = name;
        nativeFiles.set(name, { ...native, name }); retainedBytes += native.size; decodedBytes += artifact.decodedBytes;
      }
    }
    // Several retained PDFs can share one compiler map after composition. Count
    // both the collection work and the expanded retained mapping, without
    // charging a private intermediate twice when only its final PDF is retained.
    const recordCount = Math.max(sources.size + nativeRecords,
      sources.size + entries.length + artifacts.reduce((sum, artifact) => sum + (artifact.entryCount || 0), 0));
    decodedReadBytes = Math.max(decodedReadBytes, decodedBytes);
    if (recordCount > mapping.MAX_ENTRIES || decodedReadBytes > mapping.MAX_MAP_BYTES) throw mapping.failure("map-limit");
    const manifest = { ...base, status: artifacts.length ? "ready" : "unsupported", sources: [...sources.values()], artifacts, entries,
      recordCount, nativeReadBytes, decodedReadBytes };
    if (Buffer.byteLength(JSON.stringify(manifest)) + Math.max(retainedBytes, decodedBytes) > mapping.MAX_MAP_BYTES) throw mapping.failure("map-limit");
    return { manifest, nativeFiles: [...nativeFiles.values()] };
  } catch (error) {
    return { manifest: { ...base, status: "unavailable", reason: ["map-limit", "stale-artifact"].includes(error.reason) ? error.reason : "malformed-map" }, nativeFiles: [] };
  }
}

function createRunMappingCollector({ projectId, runId }) {
  let collections = [], compositions = [], sourceCache = new WeakMap(), exhausted;
  return {
    async collect(options) {
      options.context.signal?.throwIfAborted();
      if (exhausted) return exhausted;
      const navigation = await collectCompilerMapping({ ...options, projectId, runId, sourceCache });
      if (exhausted) return exhausted;
      collections.push({ navigation, products: options.products });
      const combined = assembleRunMapping({ projectId, runId, collections, products: collections.flatMap(item => item.products) });
      if (combined.manifest.status === "unavailable") {
        exhausted = combined; collections = []; sourceCache = new WeakMap();
      }
      return navigation;
    },
    collectComposition(options) {
      options.context.signal?.throwIfAborted();
      checkedComposition(options.context, options.relation, options.products);
      if (!exhausted) compositions.push(options);
    },
    assemble(products) { return exhausted || assembleRunMapping({ projectId, runId, collections, products, compositions }); },
  };
}

function createNavigationTools({ texBinPath = "" } = {}) {
  return [{ id: "synctex", path: texBinPath ? path.resolve(texBinPath, "synctex") : "synctex", timeoutMs: 5000,
    env: { SYNCTEX_EDITOR: "", SYNCTEX_VIEWER: "" } }];
}

// This provider consumes host-owned collection descriptors. Native tools see
// artifact-ID aliases for checked PDFs/maps only, without the compiled sources.
async function navigateCompilerMapping({ navigation, products, runtime, projectId, runId, query, enabled, signal }) {
  let worker, timer, effective, recoveryFailure;
  const aliases = new Map(), artifacts = [], budget = new AbortController();
  const deadlineAt = Date.now() + 5000;
  function add(name, source, size, contentHash) {
    if (aliases.has(name)) throw mapping.failure("malformed-map");
    logicalPath(source.path, "PIPELINE_MAPPING_INVALID");
    aliases.set(name, { path: name, source, size, contentHash });
  }
  const storage = {
    async readManifest() {
      if (!navigation) return null;
      const manifest = navigation.manifest;
      if (manifest.status === "disabled") return null;
      for (const product of products) for (const file of product.files) {
        const name = `${file.id}.pdf`;
        if (!manifest.artifacts?.some(artifact => artifact.id === file.id)) continue;
        add(name, { root: product.root, path: file.path }, file.size, file.contentHash);
        artifacts.push({ id: file.id, fileName: name, size: file.size, contentHash: file.contentHash });
      }
      for (const file of navigation.nativeFiles) add(file.name, { root: file.root, path: file.path }, file.size, file.contentHash);
      return Buffer.from(JSON.stringify(manifest));
    },
    async read(name) {
      const file = aliases.get(name);
      if (!file) return null;
      try {
        const { input, before } = await openCheckedFile(file.source.root, file.source.path);
        return { handle: input, size: before.size };
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async exists(name) {
      if (aliases.has(name)) return true;
      const alternate = name.endsWith(".gz") ? name.slice(0, -3) : name + ".gz";
      const file = aliases.get(alternate);
      if (!file) return false;
      const relative = name.endsWith(".gz") ? file.source.path + ".gz" : file.source.path.slice(0, -3);
      try { await fs.lstat(path.join(file.source.root, relative)); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    },
    async directory() {
      try {
        if (!worker) {
          effective = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) throw mapping.failure("timeout");
          timer = setTimeout(() => budget.abort(mapping.failure("timeout")), remaining);
          const selected = navigation.manifest.artifacts.filter(artifact => artifact.syncFile && (query.direction === "inverse"
            ? artifact.id === query.artifactId : artifact.inputs.some(input => input.sourceFileId === query.sourceFileId)));
          const files = selected.flatMap(artifact => [aliases.get(artifact.fileName), aliases.get(artifact.syncFile)]);
          worker = await runtime.createWorkspace({ runId, stepId: "navigation", queue: false, signal: effective, deadlineAt,
            input: { directories: [], files } });
        }
        effective.throwIfAborted();
        return worker.inputRoot;
      } catch (error) { rejectQuery(error); }
    },
    async close() {
      clearTimeout(timer);
      try { if (worker) await runtime.disposeWorkspace(worker); }
      catch { fail("PIPELINE_WORKER_RECOVERY_REQUIRED", "Navigation worker cleanup is unconfirmed"); }
      if (recoveryFailure) throw recoveryFailure;
    },
  };
  function rejectQuery(error) {
    if (error.code === "PIPELINE_WORKER_RECOVERY_REQUIRED") { recoveryFailure = error; throw error; }
    if (signal?.aborted) throw mapping.failure("cancelled");
    if (budget.signal.aborted) throw budget.signal.reason;
    const reason = { PIPELINE_WORKER_BUSY: "busy", PIPELINE_RUN_DEADLINE: "timeout",
      PIPELINE_RUNTIME_UNAVAILABLE: "engine-missing", PIPELINE_INPUT_CHANGED: "stale-artifact" }[error.code];
    if (reason) throw mapping.failure(reason);
    throw error;
  }
  async function runQuery(command, args) {
    try {
      effective.throwIfAborted();
      let tool;
      try { tool = runtime.resolveTool("synctex"); } catch { throw mapping.failure("engine-missing"); }
      const result = await runtime.runTool({ workspace: worker, tool, args, signal: effective, captureStreams: true, outputLimitBytes: 1048576 });
      effective.throwIfAborted();
      if (result.outputLimited || result.truncated) throw mapping.failure("output-limit");
      if (result.timedOut) throw mapping.failure("timeout");
      if (result.cancelled) throw mapping.failure("cancelled");
      if (result.code !== 0 || !result.drained) throw mapping.failure("query-failed");
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) { rejectQuery(error); }
  }
  return mapping.navigateSourceMapping({ projectId, buildId: runId, artifacts, query, enabled, signal, runQuery }, storage);
}

async function navigatePublishedPipeline({ projectStorageDir, storagePath, projectId, buildId, artifacts, runtime, query, signal }) {
  let input;
  try {
    signal?.throwIfAborted();
    if (storagePath !== `output/${buildId}`) throw mapping.failure("stale-artifact");
    const root = (await checkedPath(projectStorageDir, storagePath, true)).file;
    ({ input } = await openCheckedFile(root, mapping.MANIFEST_NAME));
    const manifest = JSON.parse((await mapping.readMappingHandle(input, mapping.MAX_MAP_BYTES)).toString("utf8"));
    const nativeFiles = (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).filter(artifact => artifact.syncFile)
      .map(artifact => ({ name: artifact.syncFile, path: artifact.syncFile, root, size: artifact.syncSize, contentHash: artifact.syncHash }));
    const products = artifacts.map(artifact => ({ root, mediaType: "application/pdf", files: [{ ...artifact, path: artifact.fileName }] }));
    return await navigateCompilerMapping({ navigation: { manifest, nativeFiles }, products, runtime, projectId, runId: buildId, query, signal, enabled: true });
  } catch (error) {
    if (error.code === "PIPELINE_WORKER_RECOVERY_REQUIRED") throw error;
    return mapping.envelope(error.code === "ENOENT" ? "missing" : "unavailable", error.code === "ENOENT" ? undefined : signal?.aborted ? "cancelled" : "malformed-map");
  } finally { await input?.close(); }
}

module.exports = { collectCompilerMapping, createRunMappingCollector, assembleRunMapping, createNavigationTools, navigateCompilerMapping, navigatePublishedPipeline };
