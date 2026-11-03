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

module.exports = { collectCompilerMapping };
