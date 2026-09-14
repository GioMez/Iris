const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("product branding and versions agree across package, lockfile and interface", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const html = read("public/Iris.html");

  assert.equal(pkg.name, "iris");
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.match(html, /<title>Iris<\/title>/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="iris_logo\.svg">/);
  assert.equal((html.match(/src="iris_logo_w\.svg"/g) || []).length, 4);
  assert.equal((html.match(/src="iris_text_logo_w\.svg" alt="Iris"/g) || []).length, 4);
  const labels = Array.from(html.matchAll(/<span class="v">([^<]+)<\/span>/g), match => match[1]);
  assert.ok(labels.length > 0);
  assert.deepEqual([...new Set(labels)], [pkg.version]);
  assert.match(html, /href="iris\.css"/);
  assert.match(html, /src="iris-app\.js"/);
});
