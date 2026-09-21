const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../public");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("interface font stylesheet is local and loads before application styles without CDN hints", async () => {
  const html = await fs.readFile(path.join(root, "Iris.html"), "utf8");
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic|cdnfonts)\.com|rel=["'](?:preconnect|dns-prefetch)["']/i);
  assert.ok(html.indexOf('href="iris-fonts.css"') >= 0, "local font stylesheet is linked");
  assert.ok(html.indexOf('href="iris-fonts.css"') < html.indexOf('href="iris.css"'));
});

test("font inventory pins every local CSS binary and complete redistributable license", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "fonts/manifest.json"), "utf8"));
  const css = await fs.readFile(path.join(root, "iris-fonts.css"), "utf8");
  assert.doesNotMatch(css, /@import|https?:|local\(/i, "no network or installed-font bypass");
  const references = [...css.matchAll(/url\(['"]?(fonts\/[a-z0-9.-]+)['"]?\)/g)].map(m => m[1].slice(6));
  assert.deepEqual([...new Set(references)].sort(), manifest.assets.map(a => a.file).sort());
  assert.equal(manifest.assets.length, 30, "26 IBM subset binaries and four original CMU faces");
  assert.equal(references.length, 42, "Sans shares six variable binaries across three declared weights");
  const files = (await fs.readdir(path.join(root, "fonts"))).filter(f => /\.woff2?$/.test(f));
  assert.deepEqual(files.sort(), manifest.assets.map(a => a.file).sort(), "no unlisted fonts");
  const notices = await fs.readFile(path.resolve(root, "../THIRD_PARTY_NOTICES.md"), "utf8");
  for (const license of manifest.licenses) {
    const bytes = await fs.readFile(path.join(root, "fonts", license.file));
    assert.equal(digest(bytes), license.sha256, license.file);
    assert.equal(license.spdx, "OFL-1.1");
    assert.match(license.source, /^https:\/\//);
    const text = bytes.toString();
    assert.match(text, /Copyright/);
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
    assert.match(text, /PERMISSION & CONDITIONS/);
    assert.match(text, /TERMINATION/);
    assert.match(text, /OTHER DEALINGS IN THE FONT SOFTWARE\./);
    assert.ok(notices.includes(`public/fonts/${license.file}`));
  }
  for (const asset of manifest.assets) {
    assert.match(asset.file, /^[a-z0-9.-]+\.woff2?$/);
    const bytes = await fs.readFile(path.join(root, "fonts", asset.file));
    assert.equal(bytes.length, asset.bytes, asset.file);
    assert.equal(bytes.toString("ascii", 0, 4), asset.file.endsWith("woff2") ? "wOF2" : "wOFF");
    assert.equal(bytes.readUInt32BE(8), bytes.length, "WOFF container length");
    assert.equal(digest(bytes), asset.sha256, asset.file);
    assert.match(asset.source, /^https:\/\/(?:fonts\.gstatic\.com\/s\/ibmplex(?:sans|mono)\/v\d+\/|fonts\.cdnfonts\.com\/s\/19926\/)/);
    assert.ok(manifest.licenses.some(l => l.file === asset.license), asset.file);
  }
});
