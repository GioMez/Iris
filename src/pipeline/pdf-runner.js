const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { cloneValue, LUA_DATA_POLICY, record, freeze, fail } = require("./contracts");
const { openCheckedFile, copyFile, reserveOutputId } = require("./workspaces");

const processPath = path.join(__dirname, "pdf-process.js"), verified = new WeakSet();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const INVALID = "PIPELINE_PDF_INVALID";
function implementationHash() {
  const digest = createHash("sha256");
  for (const file of [__filename, processPath, ...["pdf.js", "pdf-annotations.js", "pdf-forms.js"].map(file => path.join(__dirname, file)), require.resolve("pdf-lib/dist/pdf-lib.min.js")]) digest.update(readFileSync(file));
  return digest.digest("hex");
}
function createPdfTool(timeoutMs = 120000) { return { id: "iris-pdf-compose", path: process.execPath, timeoutMs }; }

function validateRelation(value, base, output) {
  const result = cloneValue(value, LUA_DATA_POLICY, INVALID);
  record(result, ["version", "base", "output", "pages"], INVALID, "PDF correspondence");
  record(result.base, ["id", "contentHash"], INVALID, "base PDF");
  record(result.output, ["contentHash"], INVALID, "composed PDF");
  if (result.version !== 1 || result.base.id !== base.id || result.base.contentHash !== base.contentHash || result.output.contentHash !== output.contentHash
    || !Array.isArray(result.pages) || !result.pages.length) fail(INVALID, "PDF correspondence does not match its artifacts");
  for (const [index, page] of result.pages.entries()) {
    record(page, ["sourcePage", "outputPage", "mediaBox", "cropBox", "rotation", "userUnit"], INVALID, "PDF page correspondence");
    if (page.sourcePage !== index + 1 || page.outputPage !== index + 1 || ![0, 90, 180, 270].includes(page.rotation)
      || !(page.userUnit > 0 && page.userUnit <= 75000)) fail(INVALID, "PDF page geometry changed");
    for (const box of [page.mediaBox, page.cropBox]) {
      if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite) || box[0] >= box[2] || box[1] >= box[3]) fail(INVALID, "Invalid PDF page box");
    }
  }
  return result;
}

// Only an executed trusted adapter can supply navigation correspondence. A Lua
// JSON artifact with the same shape cannot confer source-mapping authority.
function checkedComposition(context, relation, products) {
  const base = context.inputs.base, output = products.find(product => product.outputPort === "output");
  if (!verified.has(relation) || base.id !== relation.base.id || base.contentHash !== relation.base.contentHash
    || output?.id !== relation.output.id || output.contentHash !== relation.output.contentHash || output.size !== relation.output.size) {
    fail(INVALID, "PDF correspondence is stale or unverified");
  }
  return relation;
}

function createPdfAdapter({ runtime, runId, deadlineAt, onComposed } = {}) {
  const identity = implementationHash();
  return { id: "iris.pdf-compose", version: "1.0.0", implementationHash: identity, capabilities: ["pdf.compose.page-preserving"],
    inputs: { base: { kinds: ["file"], mediaTypes: ["application/pdf"], required: true },
      layers: { kinds: ["file", "collection"], mediaTypes: ["application/pdf"], required: true },
      placements: { kinds: ["file"], mediaTypes: ["application/json"], required: true } },
    outputs: { output: { kinds: ["file"], mediaTypes: ["application/pdf"], required: true } },
    async execute(context) {
      const { signal, limits } = context;
      signal?.throwIfAborted();
      if (implementationHash() !== identity) fail("PIPELINE_ADAPTER_CHANGED", "PDF composer identity changed");
      const { base, layers, placements } = context.inputs;
      if (base.files.length !== 1 || placements.files.length !== 1) fail(INVALID, "Composition requires one base and one placement manifest");
      const files = [], request = { version: 1, limits };
      function add(input, file, relative) {
        if (file.size > limits.maxArtifactBytes) fail("PIPELINE_OUTPUT_LIMIT", "PDF input exceeds its byte limit");
        files.push({ path: relative, size: file.size, contentHash: file.contentHash, source: { root: input.root, path: file.path } });
        return { id: file.id, path: relative, size: file.size, contentHash: file.contentHash };
      }
      request.base = add(base, base.files[0], "base.pdf");
      request.layers = layers.files.map(file => add(layers, file, `${file.id}.pdf`));
      request.placements = add(placements, placements.files[0], "placements.json");
      if (request.placements.size > LUA_DATA_POLICY.maxPlanBytes) fail("PIPELINE_OUTPUT_LIMIT", "PDF placements exceed their metadata limit");
      const bytes = Buffer.from(JSON.stringify(request));
      if (bytes.length > LUA_DATA_POLICY.maxPlanBytes) fail("PIPELINE_OUTPUT_LIMIT", "PDF request exceeds its metadata limit");
      await fs.writeFile(path.join(context.workDir, "request.json"), bytes, { flag: "wx", mode: 0o400 });
      files.push({ path: "request.json", size: bytes.length, contentHash: hash(bytes) });
      const worker = await runtime.createWorkspace({ runId, stepId: context.step.id, deadlineAt, signal, input: { root: context.workDir, files, directories: [] } });
      try {
        const result = await runtime.runTool({ workspace: worker, tool: runtime.resolveTool("iris-pdf-compose"), args: [processPath, worker.inputRoot, worker.workRoot], signal });
        signal?.throwIfAborted();
        if (!result.drained) fail("PIPELINE_WORKER_RECOVERY_REQUIRED", "PDF worker drain is unconfirmed");
        if (result.timedOut) fail("PIPELINE_PDF_TIMEOUT", "PDF composition exceeded its time limit");
        if (result.code !== 0 || result.signal || result.cancelled || result.truncated) {
          fail([INVALID, "PIPELINE_PDF_UNSUPPORTED", "PIPELINE_OUTPUT_LIMIT", "PIPELINE_PATH_INVALID"].includes(result.log) ? result.log : "PIPELINE_PDF_FAILED", "PDF composition failed");
        }
        const reply = await runtime.exportWorkspace({ workspace: worker, directory: "response", destination: path.join(context.workDir, "reply"), signal });
        if (reply.files.length !== 1 || reply.files[0].path !== "response/relation.json" || reply.files[0].size > LUA_DATA_POLICY.maxPlanBytes) fail(INVALID, "Invalid PDF correspondence response");
        const { input } = await openCheckedFile(reply.root, reply.files[0].path);
        let value;
        try { value = JSON.parse(await input.readFile("utf8")); } finally { await input.close(); }
        const exported = await runtime.exportWorkspace({ workspace: worker, directory: "output", destination: path.join(context.workDir, "products"), signal });
        if (exported.files.length !== 1 || exported.files[0].path !== "output/result.pdf") fail(INVALID, "Unexpected PDF composition output");
        const file = exported.files[0], relation = validateRelation(value, base, file), out = context.step.outputs.output;
        relation.output = { id: reserveOutputId(context, "output", out.path), contentHash: file.contentHash, size: file.size };
        await fs.mkdir(path.dirname(path.join(context.outputDir, out.path)), { recursive: true });
        await copyFile(exported.root, file.path, path.join(context.outputDir, out.path), limits.maxArtifactBytes, file, signal);
        freeze(relation); verified.add(relation);
        await onComposed?.(context, relation);
      } finally {
        try { await runtime.disposeWorkspace(worker); }
        catch { fail("PIPELINE_WORKER_RECOVERY_REQUIRED", "PDF worker cleanup is unconfirmed"); }
      }
    },
  };
}

module.exports = { createPdfAdapter, createPdfTool, checkedComposition };
