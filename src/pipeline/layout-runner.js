const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { openCheckedFile } = require("./workspaces");
const { collectLayout } = require("./layout");
const { LUA_DATA_POLICY, fail } = require("./contracts");

const processPath = path.join(__dirname, "layout-process.js");
function layoutImplementationHash() {
  const root = path.dirname(require.resolve("mupdf"));
  const files = [__filename, processPath, path.join(__dirname, "layout.js"), path.join(__dirname, "layout-pdf.js"),
    ...["../package.json", "mupdf.js", "mupdf-wasm.js", "mupdf-wasm.wasm"].map(file => path.join(root, file))];
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest("hex");
}
function createLayoutTool(timeoutMs) { return { id: "iris-layout", path: process.execPath, timeoutMs }; }

async function runLayoutCollector({ runtime, worker, compilerResult, artifact, source, destination, maxArtifactBytes, implementationHash, requirements, signal }) {
  signal?.throwIfAborted();
  if (layoutImplementationHash() !== implementationHash) fail("PIPELINE_ADAPTER_CHANGED", "Layout collector identity changed");
  const output = path.join(worker.tempRoot, `${artifact.id}.layout.json`);
  const result = await runtime.runTool({ workspace: worker, tool: runtime.resolveTool("iris-layout"),
    args: [processPath, source, output, artifact.id, artifact.contentHash, String(maxArtifactBytes)], signal });
  signal?.throwIfAborted();
  if (result.code !== 0 || result.signal || result.timedOut) {
    fail(result.log === "PIPELINE_LAYOUT_LIMIT" ? result.log : "PIPELINE_LAYOUT_FAILED", "PDF layout collection failed");
  }
  const { input, before } = await openCheckedFile(worker.tempRoot, path.basename(output));
  let value;
  try {
    if (before.size > LUA_DATA_POLICY.maxPlanBytes) fail("PIPELINE_LAYOUT_LIMIT", "Layout exceeds its metadata limit");
    value = JSON.parse(await input.readFile("utf8"));
  } finally { await input.close(); }
  const layout = collectLayout({ compilerResult, artifact, collectorData: value, requirements });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(layout), { flag: "wx", mode: 0o400 });
}

module.exports = { createLayoutTool, layoutImplementationHash, runLayoutCollector };
