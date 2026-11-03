const fs = require("node:fs/promises");
const path = require("node:path");
const { isUuid } = require("../ids");
const mapping = require("../source-mapping");
const { openCheckedFile } = require("./workspaces");
const { logicalPath, fail } = require("./contracts");

// Compiler paths are private. Each native sidecar receives an artifact-ID alias
// so equal native filenames from different steps/ports cannot select another PDF.
async function collectCompilerMapping({ context, compiled, products, projectId, runId }) {
  if (!isUuid(projectId) || !isUuid(runId) || compiled.stepId !== context.step.id || !["latex", "lilypond"].includes(compiled.family)) {
    fail("PIPELINE_MAPPING_INVALID", "Invalid compiler mapping context");
  }
  const base = { version: 1, projectId, buildId: runId, backend: compiled.family };
  if (!compiled.mappingEnabled || compiled.format !== "pdf") {
    return { manifest: { ...base, status: !compiled.mappingEnabled ? "disabled" : "unsupported" }, nativeFiles: [] };
  }
  const byOutput = new Map(compiled.outputs.map(file => [`${file.outputPort}:${file.path}`, file]));
  const artifacts = [], aliases = new Map(), nativeFiles = new Map();
  let sources, mappingError;
  try {
    for (const product of products) for (const file of product.files) {
      const origin = byOutput.get(`${product.outputPort}:${file.path}`);
      if (!origin || origin.contentHash !== file.contentHash || origin.size !== file.size || !isUuid(file.id)
        || file.producerStep !== compiled.stepId || file.outputPort !== product.outputPort) throw mapping.failure("stale-artifact");
      logicalPath(origin.compiledPath, "PIPELINE_MAPPING_INVALID");
      if (!origin.compiledPath.endsWith(".pdf")) continue;
      artifacts.push({ id: file.id, fileName: `${file.id}.pdf`, size: file.size, contentHash: file.contentHash });
      for (const suffix of [".synctex", ".synctex.gz", ".iris-map.tsv"]) aliases.set(`${file.id}${suffix}`, origin.compiledPath.slice(0, -4) + suffix);
    }
    const input = context.inputs.source;
    sources = await mapping.captureMappingSources(input.root, input.files, new Map(input.files.map(file => [file.id, file.sourceRevisionId])));
  } catch (error) { mappingError = error; }
  context.signal?.throwIfAborted();
  const manifest = await mapping.collectSourceMapping({ ...base, artifacts, sources, mappingError,
    snapshotRoot: compiled.family === "latex" ? "/work" : "/input", backend: compiled.family,
    async readMap(name, limit) {
      context.signal?.throwIfAborted();
      const relative = aliases.get(name);
      if (!relative) throw mapping.failure("malformed-map");
      let handle;
      try {
        ({ input: handle } = await openCheckedFile(compiled.outputDir, relative));
        const bytes = await mapping.readMappingHandle(handle, limit);
        if (compiled.family === "latex") nativeFiles.set(name, { name, root: compiled.outputDir,
          path: relative, size: bytes.length, contentHash: mapping.hash(bytes) });
        return bytes;
      } catch (error) { if (error.code === "ENOENT") return null; throw error; }
      finally { await handle?.close(); }
    },
  });
  context.signal?.throwIfAborted();
  return { manifest, nativeFiles: manifest.status === "ready" ? [...nativeFiles.values()] : [] };
}

function createNavigationTools({ texBinPath = "/usr/bin" } = {}) {
  return [{ id: "synctex", path: path.posix.join(texBinPath, "synctex"), timeoutMs: 5000,
    env: { SYNCTEX_EDITOR: "", SYNCTEX_VIEWER: "" } }];
}

// This provider consumes host-owned collection descriptors. Native tools see
// artifact-ID aliases for checked PDFs/maps only, without the compiled sources.
async function navigateCompilerMapping({ navigation, products, runtime, projectId, runId, query, enabled, signal }) {
  let worker, timer, effective;
  const aliases = new Map(), artifacts = [], budget = new AbortController();
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
    directory: async () => "/input",
    async close() {
      clearTimeout(timer);
      if (worker) await runtime.disposeWorkspace(worker);
    },
  };
  async function runQuery(command, args, { timeoutMs }) {
    try {
      if (!worker) {
        const deadlineAt = Date.now() + timeoutMs;
        effective = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
        timer = setTimeout(() => budget.abort(mapping.failure("timeout")), timeoutMs);
        const selected = navigation.manifest.artifacts.filter(artifact => artifact.syncFile && (query.direction === "inverse"
          ? artifact.id === query.artifactId : artifact.inputs.some(input => input.sourceFileId === query.sourceFileId)));
        const files = selected.flatMap(artifact => [aliases.get(artifact.fileName), aliases.get(artifact.syncFile)]);
        worker = await runtime.createWorkspace({ runId, stepId: "navigation", queue: false, signal: effective, deadlineAt,
          input: { directories: [], files } });
      }
      effective.throwIfAborted();
      let tool;
      try { tool = runtime.resolveTool("synctex"); } catch { throw mapping.failure("engine-missing"); }
      const result = await runtime.runContained({ workspace: worker, tool, args, signal: effective, captureStreams: true, outputLimitBytes: 1048576 });
      effective.throwIfAborted();
      if (result.outputLimited || result.truncated) throw mapping.failure("output-limit");
      if (result.timedOut) throw mapping.failure("timeout");
      if (result.cancelled) throw mapping.failure("cancelled");
      if (result.code !== 0 || !result.drained) throw mapping.failure("query-failed");
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (signal?.aborted) throw mapping.failure("cancelled");
      if (budget.signal.aborted) throw budget.signal.reason;
      const reason = { PIPELINE_WORKER_BUSY: "busy", PIPELINE_RUN_DEADLINE: "timeout", PIPELINE_CONTROL_TIMEOUT: "timeout",
        PIPELINE_RUNTIME_UNAVAILABLE: "engine-missing", PIPELINE_INPUT_CHANGED: "stale-artifact" }[error.code];
      if (reason) throw mapping.failure(reason);
      throw error;
    }
  }
  return mapping.navigateSourceMapping({ projectId, buildId: runId, artifacts, query, enabled, signal, runQuery }, storage);
}

module.exports = { collectCompilerMapping, createNavigationTools, navigateCompilerMapping };
