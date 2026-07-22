const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public/iris.css"), "utf8");
const html = fs.readFileSync(path.join(root, "public/Iris.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/iris-app.js"), "utf8");
const projects = fs.readFileSync(path.join(root, "public/iris-projects.js"), "utf8");

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
  assert.ok(contrast(token("syntax-comment"), token("editor-bg")) >= 4.5);
  assert.ok(contrast(token("syntax-bracket"), token("editor-bg")) >= 4.5);
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

test("preview controls support PDFs and image artifacts without format-specific branding", () => {
  assert.doesNotMatch(html, /data-icon="file-type-pdf"/);
  assert.doesNotMatch(app, /ti\("file-type-pdf"\)/);
  assert.match(app, /function layoutImagePages\(\)/);
  assert.match(app, /function requestPreviewLayout\(\)/);
  assert.match(css, /\.image-preview img\{[^}]*width:100%/);
});

test("compiled outputs sync into the tree and every file exposes download", () => {
  assert.match(app, /function syncOutputTree\(outputTree\)/);
  assert.match(app, /data-act="download"/);
  assert.match(projects, /function downloadCurrentFile\(filePath, fileName\)/);
});

test("file tree supports server refresh and font uploads sync immediately", () => {
  assert.match(html, /id="refreshTreeBtn"[^>]*data-i18n-title="sidebar\.refreshTree"/);
  assert.match(app, /function refreshFileTree\(\)/);
  assert.match(projects, /async function refreshCurrent\(\)/);
  assert.match(app, /function syncFontInTree\(font\)/);
  assert.match(app, /syncFontInTree\(font\)/);
  assert.match(app, /function removeFontSettings\(paths\)/);
  assert.match(app, /state\.fonts = fontSettingsFromTree\(state\.fonts\)/);
  assert.match(app, /removeFontSettings\(deletedPaths\)/);
});

test("project chooser supports portable ZIP downloads and imports", () => {
  assert.match(html, /id="pkImport"[\s\S]*?data-icon="upload"/);
  assert.match(html, /id="projectImportInput"[^>]*accept="\.zip,application\/zip"/);
  assert.match(html, /id="pkImportStatus"[^>]*aria-live="polite"/);
  assert.match(projects, /data-act="download"/);
  assert.match(projects, /\/api\/projects\/\$\{id\}\/archive/);
  assert.match(projects, /\/api\/projects\/import\?\$\{query\}/);
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

test("open file tabs expose unsaved changes until persistence succeeds", () => {
  assert.match(app, /dirtyFiles:\s*new Map\(\)/);
  assert.match(app, /function markFileDirty\(id = state\.activeId\)/);
  assert.match(app, /tree\.dirty/);
  assert.match(app, /if \(!saved\) return false/);
  assert.match(css, /\.ftab\.dirty \.dot\{[^}]*opacity:1/);
  assert.match(css, /\.ftab \.dot\{[^}]*background:var\(--semantic-warning\)/);
});

test("project autosave is opt-in and uses a configurable long debounce", () => {
  assert.match(html, /id="autoSave"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="autoSaveDelay"[^>]*type="number"[^>]*value="600"[^>]*disabled/);
  assert.match(app, /autoSave:\s*false/);
  assert.match(app, /autoSaveDelay:\s*600/);
  assert.match(app, /if \(!state\.autoSave \|\| !state\.dirtyFiles\.size\) return/);
  assert.match(app, /state\.autoSaveDelay \* 1000/);
  assert.match(app, /autoSave:\s*state\.autoSave/);
  assert.match(app, /data\.autoSave === true/);
  assert.match(app, /key === "s"/);
  assert.match(app, /beforeunload/);
  assert.match(app, /hasUnsavedChanges\(\)/);
  assert.match(app, /editor\.saveBeforeCompile/);
  assert.match(projects, /projects\.unsavedConfirm/);
});

test("fundamental project actions expose matching keyboard shortcuts", () => {
  assert.match(html, /id="btnSave"[^>]*aria-keyshortcuts="Control\+S Meta\+S"/);
  assert.match(html, /id="btnNew"[^>]*aria-keyshortcuts="Control\+N Meta\+N"/);
  assert.match(html, /id="btnOpen"[^>]*aria-keyshortcuts="Control\+O Meta\+O"/);
  assert.match(html, /id="btnCompile"[^>]*aria-keyshortcuts="Control\+Enter Meta\+Enter"/);
  assert.match(app, /key === "n"[^\n]*newFile\(\)/);
  assert.match(app, /key === "o"[^\n]*openExternalPicker\(\)/);
  assert.match(app, /e\.key === "Enter"[^\n]*compile\(\)/);
});

test("settings use accessible tabs and a compact accordion", () => {
  const settings = html.slice(html.indexOf('id="settingsModal"'), html.indexOf('<div class="toasts"'));
  assert.match(settings, /role="tablist"[^>]*aria-orientation="vertical"/);
  assert.equal((settings.match(/role="tab"/g) || []).length, 4);
  assert.equal((settings.match(/role="tabpanel"/g) || []).length, 4);
  assert.equal((settings.match(/class="set-accordion-trigger"/g) || []).length, 4);
  assert.equal((settings.match(/data-close/g) || []).length, 1);
  assert.doesNotMatch(settings, /PRESTO|data-set="general"/);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*\.set-nav\{display:none\}/);
  assert.match(app, /function activateSettingsSection\(section, focusTab = false\)/);
  assert.match(app, /event\.key === "ArrowDown"/);
  assert.match(app, /event\.key === "Home"/);
});

test("settings typography and compiler guidance keep their visual alignment", () => {
  assert.match(html, /id="fontDrop"[\s\S]*class="fontdrop-copy"/);
  assert.match(css, /#fontDrop\{display:flex;align-items:center;justify-content:center/);
  assert.match(css, /\.binresolve\+\.field\{margin-top:20px\}/);
  assert.match(css, /\.hint\{[^}]*display:block/);
  assert.doesNotMatch(css, /\.hint\{[^}]*display:flex/);
});

test("font selection is preview-only and LilyPond has no pipeline editor", () => {
  assert.match(app, /settings\.showFontPreview/);
  assert.match(app, /settings\.previewActive/);
  assert.doesNotMatch(app, /settings\.useFont|state\.appliedFont/);
  assert.match(html, /id="fontPreviewBlock" hidden/);
  assert.match(html, /data-i18n="settings\.fontPreviewTitle">Font preview/);
  assert.match(app, /\$\("fontPreviewBlock"\)\.hidden = !fam/);
  assert.match(html, /id="compilePipelineControls"/);
  assert.match(app, /controls\.hidden = lilypond/);
  assert.match(app, /if \(isLilyPondProject\(\)\) return presetCompileProfile\("quick"\)/);
});

test("interface semantics, syntax colors and font roles are independent", () => {
  ["semantic-success", "semantic-danger", "semantic-warning", "semantic-info"].forEach((name) => token(name));
  ["syntax-command", "syntax-environment", "syntax-comment", "syntax-text"].forEach((name) => token(name));
  assert.doesNotMatch(html + app, /var\(--syntax-/);
  assert.doesNotMatch(css + html + app, /var\(--(?:green|danger|warn|purple|s-[a-z]+)/);
  assert.match(css, /--font-ui:/);
  assert.match(css, /--font-code:/);
  assert.match(css, /--font-document:/);
  assert.match(css, /\.node-act\{width:30px;height:30px/);
  assert.match(css, /\.m-x\{[^}]*width:36px;height:36px/);
});
