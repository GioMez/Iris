const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Iris Beta 1 branding is consistent across package and interface", () => {
  const pkg = JSON.parse(read("package.json"));
  const html = read("public/Iris.html");

  assert.equal(pkg.name, "iris");
  assert.equal(pkg.version, "1.0.0-beta.1");
  assert.match(html, /<title>Iris<\/title>/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="iris_logo\.svg">/);
  assert.equal((html.match(/src="iris_logo_w\.svg"/g) || []).length, 3);
  assert.equal((html.match(/src="iris_text_logo_w\.svg" alt="Iris"/g) || []).length, 3);
  assert.equal((html.match(/<span class="v">Beta 1<\/span>/g) || []).length, 3);
  assert.match(html, /href="iris\.css"/);
  assert.match(html, /src="iris-app\.js"/);
});
