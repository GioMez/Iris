const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public/webtex.css"), "utf8");
const html = fs.readFileSync(path.join(root, "public/WebTeX.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/wt-app.js"), "utf8");

function token(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  assert.ok(match, `Missing color token --${name}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("muted interface and syntax text keep at least 4.5:1 contrast", () => {
  const muted = token("txt-mut");
  ["bg", "editor-bg", "panel", "panel-2", "topbar"].forEach((background) => {
    assert.ok(contrast(muted, token(background)) >= 4.5, `--txt-mut fails on --${background}`);
  });
  assert.ok(contrast(token("s-comment"), token("editor-bg")) >= 4.5);
  assert.ok(contrast(token("s-brace"), token("editor-bg")) >= 4.5);
});

test("keyboard focus and persistent contextual actions are styled", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.node\.active \.node-tools/);
  assert.match(css, /\.node\.folder-selected \.node-tools/);
  assert.match(css, /\.pcard-tools\{[^}]*opacity:\s*\.76/);
});

test("the editor has tablet and compact workspace breakpoints", () => {
  assert.match(css, /@media\(max-width:1180px\)/);
  assert.match(css, /@media\(max-width:820px\)/);
  assert.match(css, /\.body\.workspace-preview>\.edpane\{display:none\}/);
  assert.match(css, /\.body\.drawer-open>\.side/);
  assert.match(app, /matchMedia\("\(max-width: 1180px\)"\)/);
  assert.match(app, /function setWorkspaceView\(view\)/);
});

test("save, compile and output form one ordered workflow", () => {
  const workflow = html.match(/<div class="workflow-actions"[\s\S]*?<\/div>/)?.[0] || "";
  const save = workflow.indexOf('id="btnSave"');
  const compile = workflow.indexOf('id="btnCompile"');
  const output = workflow.indexOf('id="dlBtn"');
  assert.ok(save >= 0 && save < compile && compile < output);
  assert.match(css, /\.workflow-compile\{[^}]*background:var\(--accent\)/);
  assert.doesNotMatch(css, /\.seg button\.on\{[^}]*background:var\(--accent\)/);
  assert.doesNotMatch(css, /\.pvbar \.mini\.fit\.on\{[^}]*background:var\(--accent\)/);
  assert.match(css, /\.workflow-output\.output-ready/);
});

test("editor suppresses native boundary bounce without custom motion", () => {
  assert.match(css, /\.code-area\{[^}]*overscroll-behavior:none/);
  assert.doesNotMatch(css, /editor-bounce|bounce-push|bounce-return/);
  assert.doesNotMatch(app, /editorBoundaryWheel|boundaryBounceAmount|editorBounceTimer/);
});

test("word wrap is an opt-in persistent footer control", () => {
  assert.match(html, /class="sb-wrap" id="btnWrap"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="codeArea"[^>]*wrap="off"/);
  assert.match(css, /\.editor\.wrap-on \.code-layer,\.editor\.wrap-on \.code-area/);
  assert.match(css, /\.line-measure \.measure-line/);
  assert.match(app, /wordWrap:\s*false/);
  assert.match(app, /area\.setAttribute\("wrap", state\.wordWrap \? "soft" : "off"\)/);
  assert.match(app, /wordWrap:\s*state\.wordWrap/);
  assert.match(app, /function sourcePositionTop\(index\)/);
  assert.match(app, /selectionDirection === "backward" \? area\.selectionStart : area\.selectionEnd/);
});
