const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function sourceManifest() {
  const files = [];
  async function walk(dir) {
    for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${e.name}`;
      if (e.isDirectory()) await walk(file);
      else if (e.isFile()) files.push(file);
    }
  }
  for (const dir of ["public", "src", "scripts", "db"]) await walk(dir);
  files.push("package.json", "package-lock.json", ".gitattributes", "THIRD_PARTY_NOTICES.md",
    "test/helpers/language-browser.cjs", "test/helpers/language-performance.cjs", "test/helpers/language-fixtures.cjs",
    "test/helpers/language-metrics.cjs", "test/helpers/language-qualification.cjs", "test/language-performance.browser.test.js");
  const sourceHashes = {};
  for (const file of files.sort()) sourceHashes[file] = hash(await fs.readFile(path.join(root, file)));
  return { capturedAt: new Date().toISOString(), digest: hash(JSON.stringify(sourceHashes)), sourceHashes };
}
module.exports = { sourceManifest, hash };
