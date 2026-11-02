// Explicit maintenance tool; never called by application startup or npm install.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../public/fonts");
const manifest = require("../public/fonts/manifest.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const args = process.argv.slice(2);
  assert.ok(!args.length || args.length === 1 && args[0] === "--download", "Usage: node scripts/vendor-fonts.cjs [--download]");
  assert.ok((await fs.stat(root)).isDirectory(), "font parent must exist");
  for (const license of manifest.licenses) assert.equal(hash(await fs.readFile(path.join(root, license.file))), license.sha256, license.file);
  let total = 0;
  for (const asset of manifest.assets) {
    assert.match(asset.file, /^[a-z0-9.-]+\.woff2?$/);
    const destination = path.join(root, asset.file);
    let bytes;
    if (args.length) {
      assert.match(asset.source, /^https:\/\/(fonts\.gstatic\.com|fonts\.cdnfonts\.com)\//);
      const response = await fetch(asset.source, { signal: AbortSignal.timeout(30000) });
      assert.ok(response.ok, `${response.status}: ${asset.source}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } else bytes = await fs.readFile(destination);
    assert.equal(bytes.length, asset.bytes, asset.file);
    assert.equal(bytes.toString("ascii", 0, 4), asset.file.endsWith("woff2") ? "wOF2" : "wOFF", asset.file);
    assert.equal(bytes.readUInt32BE(8), bytes.length, asset.file);
    assert.equal(hash(bytes), asset.sha256, asset.file);
    if (args.length) await fs.writeFile(destination, bytes);
    total += bytes.length;
  }
  console.log(`Verified ${manifest.assets.length} unmodified font binaries (${total} bytes) and ${manifest.licenses.length} full licenses${args.length ? " against pinned downloads" : " offline"}.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
