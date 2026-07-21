const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public/webtex.css"), "utf8");

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
