const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public/iris.css"), "utf8");
const html = fs.readFileSync(path.join(root, "public/Iris.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/iris-app.js"), "utf8");
const projects = fs.readFileSync(path.join(root, "public/iris-projects.js"), "utf8");
const builds = fs.readFileSync(path.join(root, "public/iris-builds.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "public/iris-admin.js"), "utf8");
const adminProjects = fs.readFileSync(path.join(root, "public/iris-admin-projects.js"), "utf8");
const auth = fs.readFileSync(path.join(root, "public/iris-auth.js"), "utf8");
const motion = fs.readFileSync(path.join(root, "public/iris-motion.js"), "utf8");
const editorAdapter = fs.readFileSync(path.join(root, "public/iris-editor.js"), "utf8");
const en = fs.readFileSync(path.join(root, "public/locales/en/translation.json"), "utf8");
const it = fs.readFileSync(path.join(root, "public/locales/it/translation.json"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");

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
  assert.match(css, /\.seg\{[^}]*grid-template-columns:90px 58px;[^}]*width:154px;[^}]*height:32px/);
  assert.match(css, /@container \(max-width:540px\)\{[\s\S]*\.pvbar \.seg\{grid-template-columns:30px 30px;width:66px\}/);
  assert.match(app, /function layoutImagePages\(\)/);
  assert.match(app, /function requestPreviewLayout\(\)/);
  assert.match(css, /\.image-preview img\{[^}]*width:100%/);
});

test("all build files download from history instead of appearing in the source tree", () => {
  assert.doesNotMatch(app, /function syncOutputTree\(outputTree\)/);
  assert.doesNotMatch(app, /function removeBuildFromOutputTree\(buildId\)/);
  assert.match(projects, /function downloadBuildFile\(file\)/);
  assert.match(projects, /function downloadBuildArchive\(detail\)/);
  assert.match(builds, /data-build-file/);
  assert.match(builds, /data-build-act="download-archive"/);
  assert.match(server, /builds\/\(\$\{UUID_PATTERN\}\)\/files\/download/);
  assert.match(server, /builds\/\(\$\{UUID_PATTERN\}\)\/archive/);
  // Source namespace validation is exercised by compiler.test.js.
  assert.match(app, /\["output", "\.iris"\]\.includes/);
});

test("versioned builds are discoverable, previewable, and restored on project open", () => {
  const renderList = builds.slice(builds.indexOf("function renderList()"), builds.indexOf("function toggleBuildSelection"));
  assert.match(html, /id="btnBuilds"[^>]*data-i18n-title="toolbar\.buildsTitle"/);
  assert.match(html, /id="buildsRefresh"[^>]*data-i18n-aria-label="builds\.refresh"/);
  assert.match(html, /id="buildsModal"[\s\S]*role="dialog"[\s\S]*id="buildsList"[^>]*role="list"/);
  assert.match(projects, /\/api\/projects\/\$\{currentId\}\/builds\?\$\{query\}/);
  assert.match(projects, /\/api\/projects\/\$\{projectId\}\/builds\/\$\{buildId\}/);
  assert.match(projects, /IrisBuilds\.loadLatest\(id\)/);
  assert.match(builds, /latestSuccessfulId/);
  assert.match(builds, /IrisApp\.showBuildOutput\(payload, \{ activateWorkspace: false \}\)/);
  assert.match(builds, /currentRole\(\) === "owner"/);
  assert.match(builds, /deleteBuildOutput\(deletedId\)/);
  assert.match(builds, /function moveListSelection\(event\)/);
  assert.match(builds, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(builds, /reloadSelected: true/);
  assert.match(builds, /seq !== buildState\.previewSeq/);
  assert.match(builds, /clearBuildOutput\(latestCompleted\.id\)/);
  assert.doesNotMatch(renderList, /class="build-status"/);
  assert.doesNotMatch(renderList, /class="build-latest"/);
  assert.match(renderList, /class="build-when"[\s\S]*class="build-status-dot" role="img"/);
  assert.match(app, /async function showBuildOutput\(payload, options = \{\}\)/);
  assert.match(app, /suppliedBytes instanceof Uint8Array/);
  assert.match(css, /\.build-grid\{[^}]*grid-template-columns:292px minmax\(0,1fr\)/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*\.build-grid\{grid-template-columns:1fr/);
});

test("build history supports owner-only multiple selection and bulk deletion", () => {
  assert.match(html, /id="buildsBulk"[^>]*aria-live="polite"/);
  assert.match(builds, /selectedIds: new Set\(\)/);
  assert.match(builds, /const selectable = isOwner\(\)/);
  assert.match(builds, /data-build-select=/);
  assert.match(builds, /data-build-bulk-act="delete"/);
  assert.match(builds, /function deleteChecked\(\)/);
  assert.match(builds, /for \(const buildId of deleteIds\)[\s\S]*deleteBuildOutput\(buildId\)/);
  assert.match(builds, /failedIds\.some\([\s\S]*loadBuilds\(\{ append: true \}\)/);
  assert.match(builds, /const appended = await loadBuilds\(\{ append: true \}\);[\s\S]*if \(!appended\) break/);
  assert.match(builds, /currentBuildId\(\) !== previewedId/);
  assert.match(builds, /aria-busy/);
  assert.match(builds, /deleteSelectedPartial/);
  assert.match(css, /\.build-bulk\{/);
  assert.match(css, /\.build-select-wrap\{[^}]*min-height:44px/);
  assert.match(css, /\.build-select\{[^}]*accent-color/);
});

test("build metadata uses full-width rows without truncation", () => {
  assert.match(builds, /class="build-meta-flags"/);
  assert.match(builds, /class="build-meta-line"><span>/);
  assert.match(css, /\.build-detail-head\{[^}]*align-items:flex-start;[^}]*flex-direction:column/);
  assert.match(css, /\.build-facts\{[^}]*flex-direction:column;[^}]*border:1px solid var\(--border\)/);
  assert.match(css, /\.build-facts>div\{[^}]*grid-template-columns:minmax\(100px,28%\) minmax\(0,1fr\)/);
  assert.match(css, /\.build-facts b\{[^}]*white-space:normal;[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(css, /\.build-facts\{[^}]*repeat\(4/);
});

test("file history preview and changes are tabs of the content panel", () => {
  const metaIndex = html.indexOf('id="versionsMeta"');
  const tabsIndex = html.indexOf('id="versionsViewSwitch"');
  const viewIndex = html.indexOf('id="versionsView"');
  assert.ok(metaIndex < tabsIndex && tabsIndex < viewIndex);
  assert.match(html, /id="versionsPreviewTab"[^>]*role="tab"[^>]*aria-controls="versionsView"/);
  assert.match(html, /id="versionsDiffTab"[^>]*role="tab"[^>]*aria-controls="versionsView"/);
  assert.match(html, /id="versionsView"[^>]*role="tabpanel"[^>]*aria-labelledby="versionsPreviewTab"/);
  assert.match(app, /versionsViewSwitch[\s\S]*\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(css, /\.ver-viewswitch\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.ver-viewswitch button\.on\{[^}]*border-bottom-color:var\(--accent\)/);
});

test("file tree supports server refresh and font uploads sync immediately", () => {
  assert.match(html, /id="refreshTreeBtn"[^>]*data-i18n-title="sidebar\.refreshTree"/);
  assert.match(app, /function refreshFileTree\(\)/);
  // Refresh acceptance and revision guards are exercised in project-client.test.js.
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

test("project cards keep metadata readable beside persistent actions", () => {
  assert.match(css, /\.pcard\{[^}]*min-height:164px/);
  assert.match(css, /\.pcard-tools\{[^}]*position:static/);
  assert.match(css, /\.pcard-name\{[^}]*white-space:normal/);
  assert.match(css, /\.pcard-meta\{[^}]*white-space:normal/);
});

test("dialogs and project navigation share motion without animating the home", () => {
  const motionIndex = html.indexOf('<script src="iris-motion.js">');
  assert.ok(motionIndex > html.indexOf('<script src="iris-net.js">'));
  ["iris-app.js", "iris-projects.js", "iris-admin.js", "iris-auth.js"].forEach((script) => {
    assert.ok(motionIndex < html.indexOf(`<script src="${script}">`), `${script} must load after motion helpers`);
  });
  assert.match(css, /\.scrim\.on>\.modal\{animation:dialog-pop-in/);
  assert.match(css, /\.scrim\.is-closing>\.modal\{[^}]*animation:dialog-pop-out/);
  assert.match(css, /\.iris-project-opening \.app\{animation:project-open/);
  assert.match(css, /\.iris-project-closing \.app\{[^}]*animation:project-close/);
  assert.doesNotMatch(css, /\.picker-wrap\{[^}]*animation:/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)[\s\S]*\.iris-project-opening \.app/);
  assert.match(motion, /function openDialog\(target\)/);
  assert.match(motion, /async function closeProject\(\)/);
  assert.match(projects, /IrisMotion\.openProject\(\)/);
  assert.match(projects, /IrisMotion\.closeProject\(\)/);
  assert.doesNotMatch(projects, /window\.confirm/);
  assert.match(projects, /await confirmDiscardChanges\(\)/);
  assert.match(motion, /function closeTopDialog\(\)/);
  assert.match(motion, /const dialogStack = \[\]/);
  const dialogSurfaces = html.match(/<(?:div|form) class="modal[^"]*"[^>]*role="dialog"[^>]*aria-modal="true"/g) || [];
  assert.equal(dialogSurfaces.length, (html.match(/<div class="scrim"/g) || []).length);
});

test("new projects inherit the home language while existing projects retain their own", () => {
  assert.match(projects, /language:\s*window\.IrisI18n\.defaultLanguage/);
  assert.match(projects, /IrisI18n\.useDefaultLanguage\(\{ silent: true \}\)/);
  assert.match(app, /projectLanguage:\s*"en"/);
  assert.match(app, /language:\s*state\.projectLanguage/);
  assert.match(app, /data\.language[\s\S]*window\.IrisI18n\.defaultLanguage/);
  assert.match(app, /settingsLanguage[\s\S]*IrisI18n\.setLanguage\(next\)/);
});

test("sign out is exposed once through the shared account menu", () => {
  assert.doesNotMatch(html, /id="pkLogout"/);
  assert.match(html, /id="miLogout"[^>]*role="menuitem"/);
  assert.match(fs.readFileSync(path.join(root, "public/iris-auth.js"), "utf8"), /miLogout.*openDialog\("logoutModal"\)/);
  assert.doesNotMatch(projects, /pkLogout/);
});

test("home account controls reuse the project toolbar styling and order", () => {
  const homeHeader = html.slice(html.indexOf('<header class="picker-top">'), html.indexOf('<div class="picker-head">'));
  assert.match(homeHeader, /class="tbtn ghost-b admin-only" id="pkAdmin"/);
  assert.match(homeHeader, /class="userchip" id="pkAccount"/);
  assert.ok(homeHeader.indexOf('id="pkAdmin"') < homeHeader.indexOf('id="pkAccount"'));
  assert.match(homeHeader, /id="pkAccount"[\s\S]*class="avatar"[\s\S]*class="uname"[\s\S]*class="chev"/);
  assert.doesNotMatch(css, /\.picker-account|\.picker-user-txt|\.pu-name|\.pu-email/);
});

test("admin controls remain usable on desktop, mobile and keyboard", () => {
  assert.match(css, /\.admin-filters select\{[^}]*width:auto/);
  assert.match(css, /@media\(max-width:820px\)[\s\S]*\.admin-table tbody tr\{display:grid/);
  // Secondary columns hidden on small screens: two in the users table
  // (sign-in, last sign-in) and one in the projects table (updated).
  assert.equal((html.match(/<th class="admin-hide-sm"/g) || []).length, 3);
  assert.match(html, /id="adminCreateForm"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="adminEditForm"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="adminResetConfirmForm"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(admin, /adminResetConfirmText.*admin\.resetConfirm/);
  assert.match(admin, /adminCreateForm.*addEventListener\("submit"/);
  assert.match(admin, /adminEditForm.*addEventListener\("submit"/);
});

test("home and admin share one aligned responsive header system", () => {
  assert.match(css, /\.login-brand \.mark\{width:34px;height:34px/);
  assert.match(css, /\.admin-switch\{[^}]*height:34px;[^}]*padding:2px/);
  assert.match(css, /\.admin-switch button\{height:28px/);
  assert.match(css, /@media\(max-width:640px\)\{[\s\S]*\.picker-screen\{padding:30px 18px 48px/);
  assert.match(css, /@media\(max-width:640px\)\{[\s\S]*\.admin-screen\{padding:30px 18px 48px/);
  const adminHeader = html.slice(html.indexOf('<div class="admin-screen"'), html.indexOf('<!-- USERS PANEL -->'));
  assert.match(adminHeader, /class="login-brand"/);
  assert.match(adminHeader, /class="picker-user admin-header-actions"/);
  assert.match(adminHeader, /id="adminAccount"[\s\S]*class="avatar"[\s\S]*class="uname"/);
});

test("only the active application surface and top dialog are interactive", () => {
  assert.match(motion, /function setActiveSurface\(name\)/);
  assert.match(motion, /element\.inert = !interactive/);
  assert.match(motion, /function focusableElements\(dialog\)/);
  assert.match(motion, /event\.key !== "Tab"/);
  assert.match(motion, /dialog\.classList\.contains\("forced"\) && !options\.force/);
  assert.match(app, /if \(!document\.documentElement\.classList\.contains\("iris-inproject"\)\) return/);
  assert.match(app, /if \(document\.querySelector\("\.scrim\.on"\)\) return/);
  assert.match(app, /if \(document\.querySelector\("\.menu\.on"\)\) return/);
  assert.match(projects, /leaveSharedProject[\s\S]*setActiveSurface\("picker"\)/);
});

test("admin tabs, filters and forms expose complete accessible relationships", () => {
  assert.match(html, /id="adminTabUsers"[^>]*aria-controls="adminUsersPanel"[^>]*tabindex="0"/);
  assert.match(html, /id="adminTabProjects"[^>]*aria-controls="adminProjectsPanel"[^>]*tabindex="-1"/);
  assert.match(html, /id="adminUsersPanel"[^>]*role="tabpanel"[^>]*aria-labelledby="adminTabUsers"/);
  assert.match(html, /for="adminSearch"/);
  assert.match(html, /for="adminCreateUsername"/);
  assert.match(admin, /event\.key === "ArrowRight"/);
  assert.match(admin, /b\.tabIndex = on \? 0 : -1/);
});

test("loading, error and empty states preserve layout and meaning", () => {
  assert.match(css, /\.picker-import-status:empty\{visibility:hidden\}/);
  assert.match(css, /\.picker-grid>\.picker-empty\{grid-column:1\/-1/);
  assert.match(css, /\.admin-table-wrap>\.picker-empty\{border:0/);
  assert.match(projects, /grid\.setAttribute\("aria-busy", "true"\)/);
  assert.match(projects, /data-retry-projects/);
  assert.match(admin, /if \(loadFailed\) \{ empty\.style\.display = "none"; return; \}/);
});

test("account and credential controls retain names at every breakpoint", () => {
  ["userChip", "pkAccount", "adminAccount"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-i18n-aria-label="common\\.account"`));
  });
  ["passwordCurrent", "passwordNew", "passwordConfirm", "usernameNew", "usernameCurrent"].forEach((id) => {
    assert.match(html, new RegExp(`<label[^>]*for="${id}"`));
  });
  assert.match(auth, /const USER_MENU_TRIGGERS = \["userChip", "pkAccount", "adminAccount"\]/);
  assert.match(auth, /event\.stopImmediatePropagation\(\); closeUserMenu\(true\)/);
});

test("admin member mutations retain focus and expose in-modal status", () => {
  assert.match(adminProjects, /row\.dataset\.userId = m\.userId/);
  assert.match(adminProjects, /function focusMemberControl\(userId, selector\)/);
  assert.match(adminProjects, /adminProjectModalStatus/);
  assert.match(html, /id="adminProjectOwnerHint"/);
  assert.match(html, /id="projectShareOwnerHint"/);
});

test("editor suppresses native boundary bounce without custom motion", () => {
  assert.match(css, /\.cm-host \.cm-scroller\{[^}]*overscroll-behavior:none/);
  assert.doesNotMatch(css, /editor-bounce|bounce-push|bounce-return/);
  assert.doesNotMatch(app, /editorBoundaryWheel|boundaryBounceAmount|editorBounceTimer/);
});

test("the textarea editor is gone and CodeMirror is the only editor", () => {
  assert.ok(!fs.existsSync(path.join(root, "public/iris-editor-legacy.js")));
  // No DOM, CSS or temporary switch left over from the migration.
  ["codeArea", "codeWrap", "codeLayer", "lineMeasure", "curHl", 'id="gutter"'].forEach((leftover) => {
    assert.ok(!html.includes(leftover), `Iris.html still contains ${leftover}`);
  });
  assert.doesNotMatch(css, /\.code-area|\.code-wrap|\.code-layer|\.line-measure|\.cur-hl|editor-hscroll/);
  assert.doesNotMatch(editorAdapter, /legacyRequested|IrisEditorLegacy|iris_editor/);
  assert.doesNotMatch(app, /\barea\.value\b|IrisEditorLegacy/);
  // A failed module load has to be visible in the pane, not just the console.
  assert.match(editorAdapter, /function reportUnavailable\(err\)/);
  assert.match(editorAdapter, /cm-unavailable/);
  assert.match(css, /\.cm-unavailable\{/);
  assert.match(en, /"unavailable":/);
  assert.match(it, /"unavailable":/);
});

test("word wrap is an opt-in persistent footer control", () => {
  assert.match(html, /class="sb-wrap" id="btnWrap"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(app, /wordWrap:\s*false/);
  assert.match(app, /ed\(\)\.setWordWrap\(state\.wordWrap\)/);
  assert.match(app, /wordWrap:\s*state\.wordWrap/);
  // The wrap mechanics live behind the adapter, which reconfigures CodeMirror's
  // lineWrapping extension instead of touching the DOM.
  assert.match(editorAdapter, /wrapCompartment\.reconfigure\(flags\.wordWrap \? V\.EditorView\.lineWrapping : \[\]\)/);
});

test("find matches stay highlighted inside the editor viewport", () => {
  // CodeMirror only renders the DOM selection while focused, so the find bar
  // relies on decorations: all occurrences marked, the current one emphasised,
  // and the overlay cleared when the bar closes.
  assert.match(app, /function findHighlight\(\)/);
  assert.match(app, /ed\(\)\.highlightMatches\(fState\.matches\.map/);
  assert.match(app, /ed\(\)\.highlightMatches\(\[\], -1\)/);
  assert.match(editorAdapter, /highlightMatches\(ranges, activeIndex\)/);
  assert.match(editorAdapter, /cm-iris-match-active/);
  assert.match(css, /\.cm-host \.cm-iris-match\{/);
  assert.match(css, /\.cm-host \.cm-iris-match-active\{/);
  // The overview ruler mirrors the matches onto the vertical scrollbar; it is
  // measured through requestMeasure and hidden when nothing scrolls.
  assert.match(editorAdapter, /cm-iris-ruler/);
  assert.match(editorAdapter, /requestMeasure/);
  assert.match(editorAdapter, /scrollHeight <= scroller\.clientHeight/);
  assert.match(css, /\.cm-host \.cm-iris-ruler\{/);
  assert.match(css, /\.cm-host \.cm-iris-ruler-mark\{/);
  assert.match(css, /\.cm-host \.cm-iris-ruler-mark-active\{/);
});

test("open file tabs expose unsaved changes until persistence succeeds", () => {
  assert.match(app, /dirtyFiles:\s*new Map\(\)/);
  assert.match(app, /function markFileDirty\(id = state\.activeId\)/);
  assert.match(app, /tree\.dirty/);
  // Save acknowledgements and intervening edits are exercised in project-client.test.js.
  assert.match(css, /\.ftab\.dirty \.dot\{[^}]*opacity:1/);
  assert.match(css, /\.ftab \.dot\{[^}]*background:var\(--semantic-warning\)/);
});

test("project autosave is opt-in and uses a configurable long debounce", () => {
  assert.match(html, /id="autoSave"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="autoSaveDelay"[^>]*type="number"[^>]*value="600"[^>]*disabled/);
  assert.match(app, /autoSave:\s*false/);
  assert.match(app, /autoSaveDelay:\s*600/);
  // Behavioral tests cover autosave for both text and manifest changes.
  assert.match(app, /state\.autoSaveDelay \* 1000/);
  assert.match(app, /autoSave:\s*state\.autoSave/);
  assert.match(app, /data\.autoSave === true/);
  assert.match(app, /key === "s"/);
  assert.match(app, /beforeunload/);
  assert.match(app, /hasUnsavedChanges\(\)/);
  assert.match(app, /editor\.saveBeforeCompile/);
  assert.match(projects, /confirmDiscardChanges\(\)/);
});

test("fundamental project actions expose matching keyboard shortcuts", () => {
  assert.match(html, /id="btnSave"[^>]*aria-keyshortcuts="Control\+S Meta\+S"/);
  assert.match(html, /id="btnNew"[^>]*aria-keyshortcuts="Control\+N Meta\+N"/);
  assert.match(html, /id="btnOpen"[^>]*aria-keyshortcuts="Control\+O Meta\+O"/);
  assert.match(html, /id="btnCompile"[^>]*aria-keyshortcuts="Control\+Enter Meta\+Enter"/);
  assert.match(app, /key === "n"[^\n]*newFile\(\)/);
  assert.match(app, /key === "o"[^\n]*openExternalPicker\(\)/);
  assert.match(app, /e\.key === "Enter"[^\n]*compile\(\)/);
  assert.match(app, /if \(state\.compiling\) return/);
});

test("project and build requests ignore stale asynchronous completions", () => {
  assert.match(projects, /let openGeneration = 0/);
  assert.match(projects, /generation !== openGeneration/);
  assert.match(projects, /cancelPendingProjectLoad/);
  assert.match(projects, /const projectId = currentId;[\s\S]*currentId !== projectId/);
  assert.match(app, /compileGeneration/);
  assert.match(app, /generation !== state\.compileGeneration/);
  assert.match(app, /projectLoadGeneration/);
  assert.match(app, /outputGeneration/);
  assert.match(app, /loadGeneration !== state\.pdfLoadGeneration/);
  assert.match(builds, /const seq = \+\+buildState\.previewSeq/);
  assert.match(builds, /currentProjectId\(\) !== projectId/);
  assert.match(builds, /data-build-act="cancel-delete"[^\n]*\.focus\(\)/);
  assert.match(projects, /openGeneration !== sessionGeneration/);
  assert.match(app, /async function waitForPersistence\(\)/);
  // Shared queue ordering and stale completions are exercised in project-client.test.js.
  assert.match(app, /persistChanges\(\) \{ return persist\(\); \}/);
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
  assert.match(app, /settings\.fontPreviewAction/);
  assert.doesNotMatch(app, /settings\.showFontPreview|settings\.previewActive/);
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
