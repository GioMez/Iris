// Keeps the three legs of the CodeMirror vendoring in sync: the import map in
// Iris.html, the /vendor/codemirror whitelist in server.js and the ES modules
// actually installed under node_modules.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/Iris.html"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");

function importMap() {
  const match = html.match(/<script type="importmap">\s*([\s\S]*?)<\/script>/);
  assert.ok(match, "Iris.html must declare an import map");
  return JSON.parse(match[1]).imports;
}

// Mirrors the CODEMIRROR_MODULES table in server.js.
function vendorFiles() {
  return {
    "state.js": path.join(path.dirname(require.resolve("@codemirror/state")), "index.js"),
    "view.js": path.join(path.dirname(require.resolve("@codemirror/view")), "index.js"),
    "language.js": path.join(path.dirname(require.resolve("@codemirror/language")), "index.js"),
    "commands.js": path.join(path.dirname(require.resolve("@codemirror/commands")), "index.js"),
    "lezer-common.js": path.join(path.dirname(require.resolve("@lezer/common")), "index.js"),
    "lezer-highlight.js": path.join(path.dirname(require.resolve("@lezer/highlight")), "index.js"),
    "style-mod.js": path.join(path.dirname(require.resolve("style-mod")), "..", "src", "style-mod.js"),
    "w3c-keyname.js": path.join(path.dirname(require.resolve("w3c-keyname")), "index.js"),
    "crelt.js": path.join(path.dirname(require.resolve("crelt")), "..", "index.js"),
    "find-cluster-break.js": path.join(path.dirname(require.resolve("@marijn/find-cluster-break")), "..", "src", "index.js"),
  };
}

test("the import map points every bare specifier at the vendor route", () => {
  const imports = importMap();
  const expected = {
    "@codemirror/state": "state.js",
    "@codemirror/view": "view.js",
    "@codemirror/language": "language.js",
    "@codemirror/commands": "commands.js",
    "@lezer/common": "lezer-common.js",
    "@lezer/highlight": "lezer-highlight.js",
    "style-mod": "style-mod.js",
    "w3c-keyname": "w3c-keyname.js",
    "crelt": "crelt.js",
    "@marijn/find-cluster-break": "find-cluster-break.js",
  };
  assert.deepEqual(Object.keys(imports).sort(), Object.keys(expected).sort());
  Object.entries(expected).forEach(([specifier, file]) => {
    assert.equal(imports[specifier], `/vendor/codemirror/${file}`);
  });
});

test("the server whitelists exactly the import map's vendor files", () => {
  const imports = importMap();
  Object.values(imports).forEach((url) => {
    const name = url.replace("/vendor/codemirror/", "");
    assert.match(server, new RegExp(`"${name.replace(/[.-]/g, "\\$&")}":`),
      `server.js must whitelist ${name}`);
  });
  const whitelisted = [...server.matchAll(/^\s*"([a-z0-9.-]+\.js)": (?:path\.join|require\.resolve)/gm)]
    .map((m) => m[1]);
  assert.deepEqual(
    whitelisted.sort(),
    Object.values(imports).map((url) => url.replace("/vendor/codemirror/", "")).sort(),
    "server whitelist and import map must list the same files",
  );
});

test("every vendored module resolves to an installed ES module", () => {
  Object.entries(vendorFiles()).forEach(([name, file]) => {
    assert.ok(fs.existsSync(file), `${name} missing at ${file}`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /export /, `${name} must be an ES module`);
    // Any bare import used by a vendored module must itself be mapped,
    // otherwise the browser cannot resolve it.
    const imports = importMap();
    for (const m of source.matchAll(/from '([^'.\/][^']*)'/g)) {
      assert.ok(imports[m[1]], `${name} imports unmapped specifier ${m[1]}`);
    }
  });
});

test("the editor scripts load before the app and after the syntax modules", () => {
  const order = [...html.matchAll(/<script src="(iris-[a-z-]+\.js)"><\/script>/g)].map((m) => m[1]);
  const position = (nameToFind) => order.indexOf(nameToFind);
  assert.ok(position("iris-latex.js") < position("iris-editor-legacy.js"));
  assert.ok(position("iris-lilypond.js") < position("iris-editor-legacy.js"));
  assert.ok(position("iris-editor-legacy.js") < position("iris-editor.js"));
  assert.ok(position("iris-editor.js") < position("iris-app.js"));
});
