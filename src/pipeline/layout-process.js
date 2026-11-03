const fs = require("node:fs/promises");
const path = require("node:path");
const { openCheckedFile } = require("./workspaces");
const { extractPdfLayout } = require("./layout-pdf");
const { LUA_DATA_POLICY, fail } = require("./contracts");

async function main() {
  const [source, destination, id, contentHash, limit] = process.argv.slice(2);
  const { input, before } = await openCheckedFile(path.dirname(source), path.basename(source));
  let bytes;
  try {
    if (!Number.isSafeInteger(Number(limit)) || before.size > Number(limit)) fail("PIPELINE_OUTPUT_LIMIT", "PDF exceeds its artifact limit");
    bytes = await input.readFile();
  } finally { await input.close(); }
  const value = await extractPdfLayout(bytes, { artifact: { id, contentHash, mediaType: "application/pdf" } });
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > LUA_DATA_POLICY.maxPlanBytes) fail("PIPELINE_LAYOUT_LIMIT", "Layout exceeds its metadata limit");
  await fs.writeFile(destination, encoded, { flag: "wx", mode: 0o400 });
}
main().catch(error => {
  process.stderr.write(/^PIPELINE_[A-Z_]+$/.test(error.code || "") ? error.code : "PIPELINE_LAYOUT_FAILED");
  process.exitCode = 1;
});
