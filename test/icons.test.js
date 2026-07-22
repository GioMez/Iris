const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("every referenced Tabler icon is bundled locally", () => {
  const icons = read("public/iris-icons.js");
  const html = read("public/Iris.html");
  const app = read("public/iris-app.js");
  const projects = read("public/iris-projects.js");
  const fileIconBlock = app.slice(app.indexOf("function fileIcon"), app.indexOf("function paint"));
  const definitions = new Set(Array.from(icons.matchAll(/^\s+"([a-z0-9-]+)": "</gm), (match) => match[1]));
  const references = new Set([
    ...Array.from(html.matchAll(/data-icon="([a-z0-9-]+)"/g), (match) => match[1]),
    ...Array.from(`${app}\n${projects}`.matchAll(/ti\("([a-z0-9-]+)"/g), (match) => match[1]),
    ...Array.from(fileIconBlock.matchAll(/:\s*\["([a-z0-9-]+)"/g), (match) => match[1]),
  ]);
  const missing = Array.from(references).filter((name) => !definitions.has(name));
  assert.deepEqual(missing, []);
});

test("the icon runtime loads before UI modules", () => {
  const html = read("public/Iris.html");
  assert.ok(html.indexOf('src="iris-icons.js"') < html.indexOf('src="iris-app.js"'));
  assert.ok(html.indexOf('src="iris-icons.js"') < html.indexOf('src="iris-projects.js"'));
});

test("legacy interface glyphs are no longer used as icons", () => {
  const sources = ["public/Iris.html", "public/iris-app.js", "public/iris-projects.js"]
    .map(read)
    .join("\n");
  assert.doesNotMatch(sources, /[▤☰◆＋▢⤓⊕‹›⌕⇄✕▣≣−✦▶⚙⚿🅰▾▴✎⚠✗✷➜♪◦▸]/u);
});
