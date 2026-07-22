const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEditorSupport() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/iris-latex.js"), "utf8"), context);
  context.IrisLatex = context.window.IrisLatex;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/iris-lilypond.js"), "utf8"), context);
  return context.window.IrisLilyPond;
}

test("highlights LilyPond commands and comments as text", () => {
  const lilypond = loadEditorSupport();
  const html = lilypond.highlight('\\relative c\' { c4 d } % theme');
  assert.match(html, /t-cmd/);
  assert.match(html, /t-comment/);
  assert.match(html, /\\relative/);
});

test("formats and outlines LilyPond source blocks", () => {
  const lilypond = loadEditorSupport();
  const source = '\\score {\n\\relative c\' {\nc1\n}\n\\layout { }\n}';
  const formatted = lilypond.format(source);
  assert.match(formatted, /\n  \\relative/);
  assert.match(formatted, /\n    c1/);
  const outline = lilypond.outline(formatted);
  assert.equal(outline[0].title, "Partitura 1");
  assert.ok(outline.some((item) => item.title === "\\layout"));
});
