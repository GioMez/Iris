const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { composePdf } = require("./pdf");
const { cloneValue, LUA_DATA_POLICY, record, fail } = require("./contracts");
const { openCheckedFile, readWorkspaceLimits } = require("./workspaces");
const INVALID = "PIPELINE_PDF_INVALID";

async function main() {
  const [inputRoot, workRoot] = process.argv.slice(2);
  async function read(file, limit) {
    const { input, before } = await openCheckedFile(inputRoot, file.path);
    try {
      if (before.size > limit) fail("PIPELINE_OUTPUT_LIMIT", "PDF input exceeds its byte limit");
      const bytes = await input.readFile();
      if (file.contentHash && (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.contentHash)) {
        fail(INVALID, "PDF input identity changed");
      }
      return bytes;
    } finally { await input.close(); }
  }
  const json = bytes => cloneValue(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), LUA_DATA_POLICY, INVALID);
  const request = json(await read({ path: "request.json" }, LUA_DATA_POLICY.maxPlanBytes));
  record(request, ["version", "base", "layers", "placements", "limits"], INVALID, "PDF request");
  if (request.version !== 1 || !Array.isArray(request.layers)) fail(INVALID, "Invalid PDF request version");
  const budget = readWorkspaceLimits(request.limits);
  const placements = json(await read(request.placements, Math.min(budget.maxArtifactBytes, LUA_DATA_POLICY.maxPlanBytes)));
  record(placements, ["version", "base", "layers"], INVALID, "PDF placements");
  record(placements.base, ["id", "contentHash"], INVALID, "PDF base identity");
  if (placements.version !== 1 || placements.base.id !== request.base.id || placements.base.contentHash !== request.base.contentHash
    || !Array.isArray(placements.layers) || placements.layers.length > budget.maxOutputEntries) fail(INVALID, "Invalid PDF placement identity");
  const available = new Map(request.layers.map(file => [file.id, file])), loaded = new Map();
  const base = { ...request.base, mediaType: "application/pdf", bytes: await read(request.base, budget.maxArtifactBytes) };
  let total = base.bytes.length;
  const layers = [];
  for (const item of placements.layers) {
    record(item, ["artifact", "sourcePage", "page", "units", "x", "y", "width", "height", "position"], INVALID, "PDF placement");
    record(item.artifact, ["id", "contentHash"], INVALID, "PDF layer identity");
    const file = available.get(item.artifact.id);
    if (!file || file.contentHash !== item.artifact.contentHash) fail(INVALID, "Unknown PDF layer");
    if (!loaded.has(file.id)) {
      total += file.size;
      if (total > budget.maxOutputBytes) fail("PIPELINE_OUTPUT_LIMIT", "PDF inputs exceed their byte limit");
      loaded.set(file.id, { ...file, mediaType: "application/pdf", bytes: await read(file, budget.maxArtifactBytes) });
    }
    layers.push({ ...item, artifact: loaded.get(file.id), base: placements.base });
  }
  const { artifact, geometryRelation } = await composePdf({ base, layers, policy: budget });
  const metadata = JSON.stringify(geometryRelation);
  if (Buffer.byteLength(metadata) > LUA_DATA_POLICY.maxPlanBytes) fail("PIPELINE_OUTPUT_LIMIT", "PDF correspondence exceeds its metadata limit");
  await fs.mkdir(path.join(workRoot, "output")); await fs.mkdir(path.join(workRoot, "response"));
  await fs.writeFile(path.join(workRoot, "output/result.pdf"), artifact.bytes, { flag: "wx", mode: 0o400 });
  await fs.writeFile(path.join(workRoot, "response/relation.json"), metadata, { flag: "wx", mode: 0o400 });
}
main().catch(error => {
  process.stderr.write(["PIPELINE_PDF_INVALID", "PIPELINE_PDF_UNSUPPORTED", "PIPELINE_OUTPUT_LIMIT", "PIPELINE_PATH_INVALID"].includes(error.code) ? error.code : "PIPELINE_PDF_INVALID");
  process.exitCode = 1;
});
