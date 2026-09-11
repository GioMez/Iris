const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const fs = require("node:fs/promises");
const path = require("node:path");
const { CollabDocument } = require("../src/collab");
const { ChangeSet, Text } = require("@codemirror/state");

const enabled = !!process.env.IRIS_TEST_BASE_URL || process.env.IRIS_TEST_BROWSER === "1";
const options = { skip: !enabled, timeout: 30000 };
const artifacts = process.env.IRIS_TEST_ARTIFACT_DIR;
let browser, base;

test.before(async (t) => {
  if (!enabled) return;
  if (process.env.IRIS_TEST_BASE_URL) {
    base = new URL(process.env.IRIS_TEST_BASE_URL);
  } else {
    assert.ok(process.env.TEST_DATABASE_URL, "self-contained browser gate needs a disposable TEST_DATABASE_URL");
    const { serverFixture } = require("./helpers/server-fixture.cjs");
    base = new URL((await serverFixture(t)).baseUrl);
  }
  assert.equal(base.protocol, "http:");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname));
  browser = await chromium.launch({ headless: true, timeout: 10000,
    ...(process.env.IRIS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.IRIS_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
  t.after(() => browser.close());
  t.diagnostic(`Browser: ${browser.version()}; fixture: ${base.origin}`);
}, { timeout: 30000 });

function project(content, name = "refs.bib", extra = {}) {
  return { id: "bibliography-test", role: "owner", revision: 1,
    projectType: "latex", language: "en", activeId: "refs", openTabs: ["refs"],
    project: { name: "Bibliography test", nodes: [{ id: "refs", type: "file",
      name, path: name, kind: name.split(".").pop(), content }] },
    assets: {}, fonts: [], autoSave: false, autoSaveDelay: 600,
    engine: "pdflatex", lilypondArgs: "", lilypondFormat: "pdf",
    compileProfile: { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] }, ...extra };
}

async function pageFor(t, data, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(5000);
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "no browser runtime errors"));
  await page.addInitScript(() => {
    window.bibliographyRequests = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...args) {
        window.bibliographyRequests.push({ ...message, time: performance.now() });
        return super.postMessage(message, ...args);
      }
    };
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base.origin) return route.abort();
    if (url.pathname.startsWith("/api/")) {
      const fixtures = {
        "/api/config": { auth: { ssoEnabled: false } },
        "/api/auth/session": { user: { id: "browser-user", username: "browser-test", role: "user", authSource: "local", mustChangePassword: false } },
        "/api/projects": { projects: [] },
        "/api/project-templates": { templates: { latex: [], lilypond: [] } },
      };
      return route.fulfill({ status: Object.hasOwn(fixtures, url.pathname) ? 200 : 404,
        contentType: "application/json", body: JSON.stringify(fixtures[url.pathname] || { errorCode: "NOT_FOUND" }) });
    }
    return route.continue();
  });
  await page.routeWebSocket("**/*", (socket) => socket.close());
  await page.goto(base.href, { waitUntil: "networkidle", timeout: 10000 });
  await page.waitForFunction(() => document.documentElement.classList.contains("iris-authed"));
  await page.evaluate(async (data) => {
    await Promise.all([IrisEditor.ready, IrisI18n.ready]);
    await IrisI18n.setLanguage("en");
    IrisMotion.setActiveSurface("app");
    await IrisMotion.openProject();
    await IrisApp.load(data);
  }, data);
  return page;
}

async function settled(page) {
  await page.waitForFunction(() => document.querySelector("#bibliographyResults").getAttribute("aria-busy") === "false");
}

async function paste(page, text) {
  // Exercise CodeMirror's actual DOM paste handler without touching the OS clipboard.
  return page.locator(".cm-content").evaluate((target, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    return !target.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

async function noOverflow(page) {
  assert.equal(await page.locator("#loginScreen").isVisible(), false, "real authenticated workspace is visible");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no page-wide overflow");
  assert.equal(await page.evaluate(() => !!document.activeElement.closest("[hidden], [inert]")), false, "focus is on an interactive surface");
}

async function screenshot(t, page, name) {
  if (!artifacts) return;
  await fs.mkdir(artifacts, { recursive: true });
  const file = path.join(artifacts, name);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  t.diagnostic(`Screenshot: ${file}`);
}

async function selectReference(page, index = 0) {
  const radio = page.locator(`:is(#bibliographyRows, #bibliographyCards) [data-entry-index="${index}"] input[type="radio"]:visible`);
  assert.equal(await radio.count(), 1, "each visible reference has one native selection control");
  await radio.check();
}

test("form: empty bibliography offers add only, shared dialog cancels cleanly and validates inline", options, async (t) => {
  const page = await pageFor(t, project(""));
  await settled(page);
  assert.equal(await page.locator("#bibliographyAdd, #bibliographyEdit, #bibliographyRemove").count(), 3);
  assert.equal(await page.locator("#bibliographyEdit").isDisabled(), true);
  assert.equal(await page.locator("#bibliographyRemove").isDisabled(), true);
  assert.equal(await page.locator('#bibliographyPanel input[type="radio"]').count(), 0);
  const before = await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), saved: IrisApp.serialize(), dirty: IrisApp.hasUnsavedChanges() }));
  await page.locator("#bibliographyAdd").click();
  assert.equal(await page.getByRole("dialog", { name: "Add reference", exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyFormType");
  await page.locator("#bibliographyFormCancel").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyAdd");
  assert.deepEqual(await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), saved: IrisApp.serialize(), dirty: IrisApp.hasUnsavedChanges() })), before);
  await page.locator("#bibliographyAdd").click();
  await page.locator("#bibliographyFormType").fill("comment");
  await page.locator("#bibliographyFormApply").click();
  assert.equal(await page.locator("#bibliographyFormError").isVisible(), true, JSON.stringify(await page.evaluate(() => ({
    text: document.querySelector("#bibliographyFormError").textContent, hidden: document.querySelector("#bibliographyFormError").hidden,
    type: document.querySelector("#bibliographyFormType").value, focus: document.activeElement.id,
  }))));
  assert.match(await page.locator("#bibliographyFormError").textContent(), /type/i);
  assert.equal(await page.locator("#bibliographyFormType").getAttribute("aria-invalid"), "true");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "");
});

for (const format of ["bib", "ris"]) for (const kind of ["add", "edit"]) for (const language of ["en", "it"]) {
  test(`guided UTF-8 browser: ${language} ${format} ${kind} retains rejected drafts and permits correction`, options, async (t) => {
    const source = format === "bib" ? "@book{a,title={Old}}\r\n" : "TY  - BOOK\r\nTI  - Old\r\nER  -\r\n";
    const page = await pageFor(t, project(source, `refs.${format}`));
    await page.evaluate(async ({ source, format, language }) => {
      await IrisI18n.setLanguage(language);
      IrisEditor.loadCollab(source, format, { version: 0 });
      if (language === "it") IrisEditor.applyChanges([{ from: 0, to: 0, insert: "% pending\r\n" }], IrisEditor.snapshot());
    }, { source, format, language });
    await settled(page);
    if (kind === "edit") await selectReference(page);
    await page.locator(kind === "add" ? "#bibliographyAdd" : "#bibliographyEdit").click();
    const input = page.locator(`[data-native-name="${format === "bib" ? "title" : "TI"}"] textarea`);
    const before = await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), pending: IrisEditor.collabPending(),
      version: IrisEditor.collabVersion(), dirty: IrisApp.hasUnsavedChanges(), saved: IrisApp.serialize() }));
    for (const bad of [0, 0xD800, 0xDC00]) {
      // Create the exact code units inside the browser, not through UTF-8 transport.
      await input.evaluate((input, code) => {
        input.value = "Draft" + String.fromCharCode(code);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, bad);
      await page.locator("#bibliographyFormApply").click();
      assert.equal(await page.locator("#bibliographyFormError").isVisible(), true);
      assert.equal(await input.evaluate((input) => input.value.charCodeAt(5)), bad, "draft was not repaired or discarded");
      const feedback = await page.locator("#bibliographyFormError").textContent();
      const translated = await page.evaluate(() => IrisI18n.t("bibliography.diagnostics.bibliographyEdit.invalidText"));
      assert.equal(feedback, translated);
      assert.match(feedback, /NUL|Unicode/);
      assert.doesNotMatch(feedback, /bibliography\./);
      assert.deepEqual(await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), pending: IrisEditor.collabPending(),
        version: IrisEditor.collabVersion(), dirty: IrisApp.hasUnsavedChanges(), saved: IrisApp.serialize() })), before);
    }
    const corrected = "Normal 0007 \u{1F600} \uFFFD";
    await input.fill(corrected);
    await page.locator("#bibliographyFormApply").click();
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    const next = await page.evaluate(() => {
      const text = IrisEditor.getValue();
      return { text, decoded: IrisBibliography.decodeUtf8(new TextEncoder().encode(text)),
        revision: IrisEditor.snapshot().revision, pending: IrisEditor.collabPending() };
    });
    assert.equal(next.decoded, next.text);
    assert.equal(require("../public/iris-bibliography.js").decodeUtf8(Buffer.from(next.text)), next.text);
    assert.ok(next.text.includes(corrected));
    assert.equal(next.revision, before.snapshot.revision + 1);
    assert.equal(next.pending.updates.length, (before.pending?.updates.length || 0) + 1);
    await settled(page);
    await page.locator("#bibliographyUndo").click();
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), before.snapshot.text);
  });
}

test("form: scalar edits are atomic, preserve unknown and complex data, warn on key rename and undo from table", options, async (t) => {
  const source = '% retained\r\n@string{pub="Press"}\r\n@article{a,Title="A",journal={J},journaltitle={Alias},year=0007,date={2026-09-10},publisher=pub # "!",x_note={untouched},author={First},author={Second}}\r\n@book{b,title={B},crossref={a}}';
  const page = await pageFor(t, project(source));
  await settled(page);
  await selectReference(page);
  await page.locator("#bibliographyEdit").click();
  assert.equal(await page.getByRole("dialog", { name: "Edit reference", exact: true }).isVisible(), true);
  const field = (name) => page.locator(`[data-native-name="${name}"] textarea`);
  assert.deepEqual(await field("author").allTextContents(), ["First", "Second"]);
  assert.equal(await field("publisher").getAttribute("readonly"), "");
  await page.locator("#bibliographyFormMore summary").click();
  assert.equal(await field("x_note").inputValue(), "untouched");
  assert.ok((await page.locator("#bibliographyFormFields label").allTextContents()).includes("Journal (journal)"));
  await field("Title").fill("Changed");
  await field("year").fill("0008");
  await field("date").fill("2026/09/11");
  await page.locator("#bibliographyFormKey").fill("renamed");
  assert.equal(await page.locator("#bibliographyFormWarning").isVisible(), true);
  const before = await page.evaluate(() => IrisEditor.snapshot());
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  const expected = source.replace('@article{a,Title="A"', '@article{renamed,Title="Changed"').replace('year=0007', 'year=0008').replace('date={2026-09-10}', 'date={2026/09/11}');
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), expected);
  assert.equal((await page.evaluate(() => IrisEditor.snapshot())).revision, before.revision + 1);
  await settled(page);
  await noOverflow(page);
  await page.locator("#bibliographyUndo").click();
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
  await settled(page);
  await selectReference(page);
  await page.locator("#bibliographyEdit").click();
  const unchanged = await page.evaluate(() => IrisEditor.snapshot());
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => IrisEditor.snapshot()), unchanged);
});

test("form: removal requires confirmation of the selected parsed entry, not its sorted position", options, async (t) => {
  const source = '@book{a,title={Alpha}}\n@book{b,title={Zulu}}';
  const page = await pageFor(t, project(source));
  await settled(page);
  await page.locator("#bibliographySort").selectOption({ label: "Title: descending" });
  await selectReference(page, 1);
  await page.locator("#bibliographyRemove").click();
  assert.match(await page.locator("#bibliographyFormRemoval").textContent(), /Zulu/);
  assert.match(await page.locator("#bibliographyFormRemoval").textContent(), /b/);
  assert.match(await page.locator("#bibliographyFormWarning").textContent(), /citations|cross/i);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
  await page.locator("#bibliographyFormCancel").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyRemove");
  await page.locator("#bibliographyRemove").click();
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), '@book{a,title={Alpha}}\n');
  await settled(page);
  assert.equal(await page.locator("#bibliographyEdit").isDisabled(), true);
  await page.locator("#bibliographyUndo").click();
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
});

test("form: ordinary Motion close is cancellable, Escape and source navigation confirm discard, forced close never applies", options, async (t) => {
  const source = '@book{a,title={A}}';
  const page = await pageFor(t, project(source));
  await settled(page);
  await page.locator("#btnAttach").click();
  assert.equal(await page.evaluate(() => IrisMotion.closeDialog("attachModal")), true, "dialogs without listeners still close");
  await selectReference(page);
  await page.locator("#bibliographyEdit").click();
  await page.locator('[data-native-name="title"] textarea').fill("draft");
  assert.equal(await page.evaluate(() => IrisMotion.closeDialog("bibliographyModal", { immediate: true })), false);
  assert.equal(await page.locator("#bibliographyModal").isVisible(), true);
  assert.equal(await page.locator("#bibliographyFormDiscard").isVisible(), true);
  await page.locator("#bibliographyFormKeep").click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#bibliographyFormDiscard").isVisible(), true);
  await page.locator("#bibliographyFormKeep").click();
  await page.locator("#bibliographyFormSource").click();
  assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), false);
  await page.locator("#bibliographyFormDiscardConfirm").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement === IrisEditor.focusTarget()), true);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
  await page.locator("#bibliographyTableTab").click();
  await page.locator("#bibliographyEdit").click();
  await page.locator('[data-native-name="title"] textarea').fill("must not apply");
  assert.equal(await page.evaluate(() => IrisMotion.closeDialog("bibliographyModal", { force: true })), true);
  await page.locator("#bibliographyFormApply").evaluate((button) => button.click());
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
  await noOverflow(page);
});

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  test(`form: ${name} add/edit keyboard, RIS repeats, native aliases and type changes retain all data`, options, async (t) => {
    const source = "TY  - BOOK\r\nTI  - A\r\nT1  - Alias\r\nAU  - First\r\nAU  - Second\r\nPY  - 0007/09\r\nKW  - one\r\nKW  - two\r\nZZ  - unknown\r\nER  -\r\n";
    const page = await pageFor(t, project(source, "refs.ris"), viewport);
    await settled(page);
    assert.equal(await page.locator("#bibliographyAdd").count(), 1);
    await page.locator("#bibliographyAdd").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyFormType");
    assert.equal(await page.locator('#bibliographyFormFields [data-native-name="A1"]').count(), 0, "unused author aliases are not redundant main fields");
    assert.equal(await page.locator('#bibliographyFormFields [data-native-name="T1"]').count(), 0);
    await screenshot(t, page, `task-10-add-${name}.png`);
    await page.locator('[data-native-name="TI"] textarea').fill("New");
    await page.locator("#bibliographyFormApply").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyFormClose");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyFormApply");
    await page.keyboard.press("Enter");
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), source + "TY  - JOUR\r\nTI  - New\r\nER  -\r\n");
    await settled(page);
    await selectReference(page);
    await page.locator("#bibliographyEdit").click();
    await page.locator("#bibliographyFormType").fill("ELEC");
    await page.locator("#bibliographyFormType").press("Tab");
    await page.locator("#bibliographyFormMore summary").click();
    assert.equal(await page.locator('[data-native-name="ZZ"] textarea').inputValue(), "unknown");
    assert.deepEqual(await page.locator('[data-native-name="KW"] textarea').allTextContents(), ["one", "two"]);
    await page.locator('[data-native-name="AU"] textarea').nth(1).fill("Second changed");
    await page.locator('[data-native-name="PY"] textarea').fill("0008/10");
    await page.locator("#bibliographyFormNativeName").fill("AU");
    await page.locator("#bibliographyFormAddField").click();
    await page.locator('[data-native-name="AU"] textarea').last().fill("Third");
    await page.locator("#bibliographyFormNativeName").fill("XY");
    await page.locator("#bibliographyFormAddField").click();
    await page.locator('[data-native-name="XY"] textarea').fill("custom new");
    await page.locator("#bibliographyFormType").focus();
    await screenshot(t, page, `task-10-edit-${name}.png`);
    await noOverflow(page);
    const fields = await page.locator("#bibliographyFormFields").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
    assert.equal(fields, name === "mobile" ? 1 : 2);
    await page.locator("#bibliographyFormApply").click();
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), source.replace("TY  - BOOK", "TY  - ELEC").replace("AU  - Second", "AU  - Second changed").replace("PY  - 0007/09", "PY  - 0008/10").replace("ER  -", "AU  - Third\r\nXY  - custom new\r\nER  -") + "TY  - JOUR\r\nTI  - New\r\nER  -\r\n");
  });
}

for (const change of ["outside", "overlap", "identical overlap", "identical load", "permission", "maintenance"]) {
  test(`form: ${change} during a live draft never retargets or loses the draft`, options, async (t) => {
    const source = '@book{same,title={A}}\n@book{same,title={A}}';
    const page = await pageFor(t, project(source));
    await page.evaluate((text) => IrisEditor.loadCollab(text, "bib", { version: 0 }), source);
    await settled(page);
    await selectReference(page, 1);
    await page.locator("#bibliographyEdit").click();
    await page.locator('[data-native-name="title"] textarea').fill("draft");
    await page.evaluate(async (change) => {
      const { EditorView } = await import("@codemirror/view");
      const view = EditorView.findFromDOM(document.querySelector(".cm-content"));
      if (change === "permission") document.dispatchEvent(new CustomEvent("iris:collabrole", { detail: { role: "viewer" } }));
      else if (change === "maintenance") {
        window.IrisCollab.paused = () => true;
        document.dispatchEvent(new CustomEvent("iris:collabrole", { detail: { role: "owner" } }));
      } else if (change === "identical load") IrisEditor.loadCollab(IrisEditor.getValue(), "bib", { version: 0 });
      else if (change === "outside") view.dispatch({ changes: { from: 0, insert: "% peer\n" } });
      else { const from = IrisEditor.getValue().lastIndexOf("A"); view.dispatch({ changes: { from, to: from + 1, insert: change === "overlap" ? "B" : "A" } }); }
      // Apply before the async parser refresh: this must not destroy the draft.
      document.querySelector("#bibliographyFormApply").click();
    }, change);
    if (!["permission", "maintenance"].includes(change)) await settled(page);
    if (change === "outside") {
      assert.equal(await page.locator('[data-native-name="title"] textarea').inputValue(), "draft");
      await page.locator("#bibliographyFormApply").click();
      await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => IrisEditor.getValue()), '% peer\n@book{same,title={A}}\n@book{same,title={draft}}');
    } else {
      await page.locator("#bibliographyFormApply").click();
      assert.equal(await page.locator("#bibliographyModal").isVisible(), true);
      assert.equal(await page.locator('[data-native-name="title"] textarea').inputValue(), "draft");
      assert.equal(await page.locator("#bibliographyFormError").isVisible(), true);
      assert.equal(await page.evaluate(() => IrisEditor.getValue()), change === "overlap" ? '@book{same,title={A}}\n@book{same,title={B}}' : source);
      if (["permission", "maintenance"].includes(change)) {
        assert.equal(await page.locator("#bibliographyUndo").isDisabled(), true);
        assert.equal(await page.locator("#bibliographyAdd").isDisabled(), true);
      }
    }
  });
}

test("form: keyless no-op and unused placeholders do not create fields, dirty cancel keeps its focus", options, async (t) => {
  const page = await pageFor(t, project('@book{,title={A}}'));
  await settled(page);
  await selectReference(page);
  await page.locator("#bibliographyEdit").click();
  const before = await page.evaluate(() => IrisEditor.snapshot());
  await page.locator("#bibliographyFormApply").click();
  assert.equal(await page.locator("#bibliographyFormError").textContent(), "", "empty UI key represents the parser's null key");
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => IrisEditor.snapshot()), before);
  await page.locator("#bibliographyAdd").click();
  await page.locator("#bibliographyFormType").fill("book");
  await page.locator("#bibliographyFormType").fill("article");
  await page.locator('[data-native-name="title"] textarea').fill("new");
  await page.locator("#bibliographyFormCancel").click();
  assert.equal(await page.locator("#bibliographyFormDiscard").isVisible(), true);
  await page.locator("#bibliographyFormKeep").click();
  assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyFormCancel");
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), '@book{,title={A}}\n@article{,\n  title = {new}\n}\n');
});

test("form: candidate syntax errors keep source selection unchanged and new columns respect exclusions", options, async (t) => {
  const page = await pageFor(t, project('@book{k}\n@book{b,title={Other}}'));
  await settled(page);
  await page.locator("#bibliographyColumnsLabel").click();
  await page.locator('#bibliographyColumns input[data-column-id="bib:title"]').uncheck();
  await selectReference(page);
  await page.locator("#bibliographyEdit").click();
  const selection = await page.evaluate(() => IrisEditor.selection());
  await page.locator("#bibliographyFormKey").fill("%hidden");
  await page.locator("#bibliographyFormApply").click();
  assert.equal(await page.locator("#bibliographyFormError").isVisible(), true);
  assert.deepEqual(await page.evaluate(() => IrisEditor.selection()), selection);
  assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), false);
  await page.locator("#bibliographyFormKey").fill("k");
  await page.locator("#bibliographyFormNativeName").fill("x_new");
  await page.locator("#bibliographyFormAddField").click();
  await page.locator('[data-native-name="x_new"] textarea').fill("new value");
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  await settled(page);
  assert.equal(await page.locator('#bibliographyColumns input[data-column-id="bib:title"]').isChecked(), false);
  assert.equal(await page.locator('#bibliographyColumns input[data-column-id="bib:x_new"]').isChecked(), true);
  assert.equal(await page.locator('#bibliographyHead [data-sort-id="bib:x_new"]').count(), 1);
});

for (const transition of ["cancel", "force", "file", "image", "project", "sourceError"]) {
  test(`form: ${transition} disposes its live bookmark and cannot apply into another context`, options, async (t) => {
    const data = project('@book{a,title={A}}');
    data.openTabs.push("other");
    data.project.nodes.push({ id: "other", type: "file", name: "other.bib", path: "other.bib", kind: "bib", content: '@book{a,title={Other}}' });
    data.project.nodes.push({ id: "image", type: "file", name: "image.png", path: "image.png", kind: "img", data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" });
    const page = await pageFor(t, data);
    await settled(page);
    await page.evaluate(() => {
      const track = IrisEditor.trackRange;
      window.formBookmarks = [];
      IrisEditor.trackRange = (...args) => { const bookmark = track(...args); formBookmarks.push(bookmark); return bookmark; };
    });
    await selectReference(page);
    await page.locator("#bibliographyEdit").click();
    assert.deepEqual(await page.evaluate(() => formBookmarks.map((b) => b.read())), [{ from: 0, to: 18 }]);
    if (transition !== "cancel") await page.locator('[data-native-name="title"] textarea').fill("draft");
    if (transition === "cancel") await page.locator("#bibliographyFormCancel").click();
    else if (transition === "force") await page.evaluate(() => IrisMotion.closeAllDialogs());
    else if (transition === "file") await page.getByRole("tab", { name: /other\.bib/, includeHidden: true }).evaluate((node) => node.click());
    else if (transition === "image") await page.locator('.node[data-id="image"]').evaluate((node) => node.click());
    else {
      const replacement = project('@book{a,title={Replacement}}', "refs.bib", { id: transition === "project" ? "replacement" : data.id });
      if (transition === "sourceError") { delete replacement.project.nodes[0].content; replacement.project.nodes[0].sourceError = "BIBLIOGRAPHY_INVALID_ENCODING"; }
      await page.evaluate((data) => IrisApp.load(data), replacement);
    }
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => formBookmarks.map((b) => b.read())), [null]);
    const before = await page.evaluate(() => IrisEditor.snapshot());
    await page.locator("#bibliographyFormApply").evaluate((button) => button.click());
    assert.deepEqual(await page.evaluate(() => IrisEditor.snapshot()), before);
  });
}

for (const trigger of ["save acknowledgement", "Apply"]) for (const overlap of [false, true]) {
  test(`form round1: canonical ${trigger} preserves ${overlap ? "a conflicted" : "a mapped"} same-file draft`, options, async (t) => {
    const source = '@book{same,title={A}}\n@book{same,title={A}}';
    const data = project(source), canonical = "11111111-1111-4111-8111-111111111111";
    const page = await pageFor(t, data);
    let releaseSave;
    if (trigger === "save acknowledgement") {
      const gate = new Promise((resolve) => { releaseSave = resolve; });
      t.after(() => releaseSave());
      await page.route(`**/api/projects/${data.id}`, async (route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: data });
        const saved = route.request().postDataJSON().data;
        saved.project.nodes[0].id = canonical;
        await gate;
        return route.fulfill({ json: { data: saved, revision: 2, project: { id: data.id, revision: 2 } } });
      });
      await page.evaluate((id) => IrisProjects.openProject(id), data.id);
      const request = page.waitForRequest((req) => req.method() === "PUT");
      await page.evaluate(() => { window.pendingSave = IrisProjects.persistCurrent(); });
      await request;
    }
    await settled(page);
    await selectReference(page, 1);
    await page.locator("#bibliographyEdit").click();
    const title = page.locator('[data-native-name="title"] textarea');
    await title.fill("draft");
    // Leave an invalid key so even a reentrant Apply must retain the dialog.
    await page.locator("#bibliographyFormKey").fill("not a key");
    await title.focus();
    await page.evaluate((overlap) => {
      if (overlap) { const from = IrisEditor.getValue().lastIndexOf("A"); IrisEditor.replaceRange(from, from + 1, "A"); }
      else IrisEditor.replaceRange(0, 0, "% outside\n");
    }, overlap);
    await settled(page);
    const before = await page.evaluate(() => IrisEditor.snapshot());
    if (trigger === "save acknowledgement") {
      releaseSave();
      assert.equal(await page.evaluate(() => pendingSave), true);
    } else {
      await page.evaluate((canonical) => {
        IrisProjects.currentProjectId = () => "bibliography-test";
        IrisProjects.resolveFileId = (path) => path === "refs.bib" ? canonical : null;
      }, canonical);
      await page.locator("#bibliographyFormApply").click();
    }
    assert.equal(await page.locator("#bibliographyModal").isVisible(), true, "canonical assignment is not permission to discard");
    assert.equal(await title.inputValue(), "draft");
    assert.equal(await page.locator("#bibliographyFormKey").inputValue(), "not a key");
    assert.deepEqual(await page.evaluate(() => IrisEditor.snapshot()), before);
    if (trigger === "save acknowledgement") assert.equal(await title.evaluate((node) => node === document.activeElement), true);
    await page.locator("#bibliographyFormKey").fill("same");
    await page.locator("#bibliographyFormApply").click();
    if (overlap) {
      assert.equal(await page.locator("#bibliographyFormError").isVisible(), true);
      assert.equal(await title.inputValue(), "draft");
      assert.deepEqual(await page.evaluate(() => IrisEditor.snapshot()), before, "a rekey cannot revive an invalid bookmark");
    } else {
      await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => IrisEditor.getValue()), '% outside\n@book{same,title={A}}\n@book{same,title={draft}}');
    }
  });
}

for (const state of ["clean", "dirty", "conflicted"]) {
  test(`form round1: reduced-motion Show source navigates during pending analysis with a ${state} draft`, options, async (t) => {
    const dirty = state !== "clean";
    const source = '@book{a,title={A}}';
    const page = await pageFor(t, project(source));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await settled(page);
    await selectReference(page);
    await page.locator("#bibliographyEdit").click();
    if (dirty) {
      await page.locator('[data-native-name="title"] textarea').fill("discard me");
      await page.locator("#bibliographyFormSource").click();
      assert.equal(await page.locator("#bibliographyFormDiscard").isVisible(), true);
    }
    const pending = await page.evaluate((state) => {
      if (state === "conflicted") { const from = IrisEditor.getValue().indexOf("A"); IrisEditor.replaceRange(from, from + 1, "B"); }
      else IrisEditor.replaceRange(0, 0, "% peer\n");
      const pending = document.querySelector("#bibliographyResults").getAttribute("aria-busy");
      document.querySelector(state !== "clean" ? "#bibliographyFormDiscardConfirm" : "#bibliographyFormSource").click();
      return pending;
    }, state);
    assert.equal(pending, "true");
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true, "source access must not wait for the table projection");
    assert.equal(await page.evaluate(() => document.activeElement === IrisEditor.focusTarget()), true);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), state === "conflicted" ? '@book{a,title={B}}' : "% peer\n" + source);
    await settled(page);
    assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
  });
}

for (const destination of ["file", "image", "logout"]) {
  test(`form round1: ${destination} during source close cancels the old navigation`, options, async (t) => {
    const data = project('@book{a,title={A}}');
    data.openTabs.push("other");
    data.project.nodes.push({ id: "other", type: "file", name: "other.bib", path: "other.bib", kind: "bib", content: '@book{a,title={A}}' });
    data.project.nodes.push({ id: "image", type: "file", name: "image.png", path: "image.png", kind: "img", data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" });
    const page = await pageFor(t, data);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await settled(page);
    await selectReference(page);
    await page.locator("#bibliographyEdit").click();
    await page.locator('[data-native-name="title"] textarea').fill("discard");
    await page.locator("#bibliographyFormSource").click();
    await page.evaluate((destination) => {
      IrisEditor.replaceRange(0, 0, "% peer\n");
      window.beforeLeavingSelection = IrisEditor.selection();
      document.querySelector("#bibliographyFormDiscardConfirm").click();
      if (destination === "logout") IrisAuth.showLogin();
      else document.querySelector(`.node[data-id="${destination === "file" ? "other" : "image"}"]`).click();
    }, destination);
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    if (destination === "file") {
      await settled(page);
      assert.equal(await page.locator("#bibliographyTablePanel").isVisible(), true);
      assert.equal(await page.evaluate(() => IrisEditor.getValue()), '@book{a,title={A}}');
    } else if (destination === "image") {
      assert.equal(await page.locator(".image-preview").isVisible(), true);
      assert.equal(await page.locator("#bibliographyPanel").isVisible(), false);
    } else {
      assert.equal(await page.locator("#loginScreen").isVisible(), true);
      assert.deepEqual(await page.evaluate(() => IrisEditor.selection()), await page.evaluate(() => beforeLeavingSelection));
    }
  });
}

test("form round1: same-role and transport status updates retain the actual focused selection control", options, async (t) => {
  const page = await pageFor(t, project('@book{a,title={A}}'));
  await settled(page);
  await selectReference(page);
  const radio = page.locator('#bibliographyPanel input[type="radio"]:visible');
  await radio.focus();
  await radio.evaluate((node) => { window.selectedRadio = node; });
  const before = await page.evaluate(() => IrisEditor.snapshot());
  for (const event of ["role", "status"]) {
    await page.evaluate((event) => {
      if (event === "role") document.dispatchEvent(new CustomEvent("iris:collabrole", { detail: { role: "owner" } }));
      else IrisCollab.disconnect();
    }, event);
    assert.equal(await page.evaluate(() => selectedRadio.isConnected && selectedRadio === document.activeElement && selectedRadio.checked), true, event);
    assert.equal(await page.locator("#bibliographyEdit").isDisabled(), false);
  }
  assert.deepEqual(await page.evaluate(() => IrisEditor.snapshot()), before);
});

for (const language of ["en", "it"]) {
  test(`form round1: ${language} ordered occurrences have distinct native field and removal names`, options, async (t) => {
    const source = "TY  - BOOK\r\nAU  - First\r\nTI  - Title\r\nAU  - Second\r\nZZ  - One\r\nZZ  - Two\r\nER  -\r\n";
    const page = await pageFor(t, project(source, "refs.ris", { language }));
    await settled(page);
    await selectReference(page);
    await page.locator("#bibliographyEdit").click();
    const authors = language === "en" ? "Authors (AU), occurrence" : "Autori (AU), occorrenza";
    const second = page.getByRole("textbox", { name: `${authors} 2`, exact: true });
    assert.equal(await second.count(), 1, "the accessible name identifies the native occurrence");
    assert.equal(await page.getByRole("textbox", { name: `${authors} 1`, exact: true }).inputValue(), "First");
    assert.equal(await second.inputValue(), "Second");
    await second.fill("Second changed");
    await page.getByRole("checkbox", { name: `${language === "en" ? "Remove" : "Rimuovi"} ${authors} 1`, exact: true }).check();
    await page.locator("#bibliographyFormMore summary").click();
    assert.equal(await page.getByRole("textbox", { name: `ZZ, ${language === "en" ? "occurrence" : "occorrenza"} 2`, exact: true }).inputValue(), "Two");
    await page.locator("#bibliographyFormApply").click();
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), "TY  - BOOK\r\nTI  - Title\r\nAU  - Second changed\r\nZZ  - One\r\nZZ  - Two\r\nER  -\r\n");
  });
}

for (const format of ["bib", "ris"]) {
  test(`form round1: unchanged ${format} multiline CRLF values submit without a transaction after a native input roundtrip`, options, async (t) => {
    const source = format === "bib" ? '@book{a,title={First\r\nSecond},x_keep={untouched}}\r\n' : "TY  - BOOK\r\nTI  - First\r\n      Second\r\nZZ  - untouched\r\nER  -\r\n";
    const page = await pageFor(t, project(source, `refs.${format}`));
    await settled(page);
    await selectReference(page);
    await page.locator("#bibliographyEdit").click();
    const before = await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), pending: IrisEditor.collabPending(), dirty: IrisApp.hasUnsavedChanges() }));
    const input = page.locator(`[data-native-name="${format === "bib" ? "title" : "TI"}"] textarea`);
    const displayed = await input.inputValue();
    await input.focus();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("!");
    await page.keyboard.press("Backspace");
    assert.equal(await input.inputValue(), displayed);
    await page.locator("#bibliographyFormApply").click();
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), pending: IrisEditor.collabPending(), dirty: IrisApp.hasUnsavedChanges() })), before);
  });
}

test("form: live peer changes rebase the draft and one table undo retains the peer's text", options, async (t) => {
  const source = '@book{a,title={A}}\r\n@book{b,title={B}}';
  const page = await pageFor(t, project(source));
  await page.evaluate((text) => IrisEditor.loadCollab(text, "bib", { version: 0 }), source);
  await settled(page);
  const room = new CollabDocument({ fileId: "refs", projectId: "bibliography-test", content: source });
  await selectReference(page, 1);
  await page.locator("#bibliographyEdit").click();
  await page.locator('[data-native-name="title"] textarea').fill("Draft");
  const peer = [{ clientID: "peer", changes: ChangeSet.of({ from: 0, insert: Text.of(["% peer\r", ""]) }, source.length).toJSON() }];
  room.receive(0, peer);
  await page.evaluate((updates) => IrisEditor.collabReceive(updates), peer);
  await settled(page);
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  let pending = await page.evaluate(() => IrisEditor.collabPending());
  assert.equal(pending.updates.length, 1);
  let accepted = room.receive(pending.version, pending.updates);
  assert.equal(accepted.accepted, true);
  await page.evaluate((updates) => IrisEditor.collabReceive(updates), accepted.updates);
  assert.equal(room.text(), '% peer\r\n@book{a,title={A}}\r\n@book{b,title={Draft}}');
  await settled(page);
  await page.locator("#bibliographyUndo").click();
  pending = await page.evaluate(() => IrisEditor.collabPending());
  accepted = room.receive(pending.version, pending.updates);
  assert.equal(accepted.accepted, true);
  await page.evaluate((updates) => IrisEditor.collabReceive(updates), accepted.updates);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "% peer\r\n" + source);
  assert.equal(room.text(), "% peer\r\n" + source);
});

test("form: current snapshot guard rejects a peer edit between build and atomic apply without retry", options, async (t) => {
  const source = '@book{a,title={A}}';
  const page = await pageFor(t, project(source));
  await settled(page);
  await selectReference(page);
  await page.locator("#bibliographyEdit").click();
  await page.locator('[data-native-name="title"] textarea').fill("Draft");
  await page.evaluate(() => {
    const build = IrisBibliographyEdit.buildChanges;
    IrisBibliographyEdit.buildChanges = (...args) => {
      const result = build(...args);
      IrisBibliographyEdit.buildChanges = build;
      IrisEditor.replaceRange(0, 0, "% intervening\n");
      return result;
    };
  });
  await page.locator("#bibliographyFormApply").click();
  assert.equal(await page.locator("#bibliographyFormError").isVisible(), true);
  assert.equal(await page.locator('[data-native-name="title"] textarea').inputValue(), "Draft");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "% intervening\n" + source);
  await settled(page);
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), '% intervening\n@book{a,title={Draft}}');
});

test("form: scalar removal preserves repeated native order and Italian labels, reduced-motion close can be vetoed", options, async (t) => {
  const source = '@book{a,title={A},author={First},author={Second},x_custom={Keep}}';
  const page = await pageFor(t, project(source, "refs.bib", { language: "it" }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await settled(page);
  await selectReference(page);
  await page.locator("#bibliographyEdit").click();
  assert.equal(await page.getByRole("dialog", { name: "Modifica reference" }).isVisible(), true);
  await page.locator('[data-native-name="author"] input[type="checkbox"]').first().check();
  await page.locator('[data-native-name="title"] textarea').fill("");
  assert.equal(await page.evaluate(() => IrisMotion.closeDialog("bibliographyModal")), false);
  await page.locator("#bibliographyFormKeep").click();
  await page.locator("#bibliographyFormApply").click();
  await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), '@book{a,title={},author={Second},x_custom={Keep}}');
  await noOverflow(page);
});

test("all populated columns are visible and individually hideable", options, async (t) => {
  const source = "@article{a,title={A},journal={J}}\n@book{b,title={B},x_note={kept}}";
  const page = await pageFor(t, project(source));
  assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyTableTab");
  await page.locator("#btnSidebar").click();
  await page.getByRole("columnheader", { name: "x_note", exact: true }).waitFor();
  const before = await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), saved: IrisApp.serialize(), dirty: IrisApp.hasUnsavedChanges() }));
  assert.deepEqual(await page.locator("#bibliographyHead th").allTextContents(), ["Citation key", "Type", "Title", "Journal", "x_note", "Text"]);
  const summary = page.locator("#bibliographyColumnsLabel");
  await summary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#bibliographyColumnPicker").evaluate((el) => el.open), true);
  const note = page.getByRole("checkbox", { name: "x_note", exact: true });
  await note.focus();
  await page.keyboard.press("Space");
  assert.equal(await note.evaluate((el) => el === document.activeElement), true);
  assert.equal(await page.getByRole("columnheader", { name: "x_note", exact: true }).count(), 0);
  await page.keyboard.press("Space");
  assert.equal(await page.getByRole("columnheader", { name: "x_note", exact: true }).count(), 1);
  for (const check of await page.locator("#bibliographyColumns input").all()) await check.uncheck();
  assert.equal(await page.locator("#bibliographyTable").isVisible(), false);
  assert.match(await page.locator("#bibliographyState").textContent(), /hidden/i);
  await page.locator("#bibliographyShowAll").click();
  assert.equal(await page.locator("#bibliographyColumns input:checked").count(), 5);
  await summary.focus();
  await page.keyboard.press("Space");
  assert.equal(await page.locator("#bibliographyColumnPicker").evaluate((el) => el.open), false);
  await page.locator("#bibliographyHead").getByRole("button", { name: "Title", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator('#bibliographyHead th[aria-sort="ascending"]').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Title");
  assert.deepEqual(await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), saved: IrisApp.serialize(), dirty: IrisApp.hasUnsavedChanges() })), before);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
  assert.ok(await page.evaluate(() => bibliographyRequests.length > 0), "real Worker dispatched");
  await noOverflow(page);
});

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }], ["narrow-split", { width: 1440, height: 900 }]]) {
  test(`${name}: long values stay inert, selectable and readable in the panel`, options, async (t) => {
    const long = '<img src="/unexpected-image" onerror="window.executed=true"> ' + "unbroken".repeat(260) + " END";
    const page = await pageFor(t, project(`@book{a,title={A},author={Writer},year=2026,x_note={${long}}}`), viewport);
    await settled(page);
    if (name === "desktop") await page.locator("#btnSidebar").click();
    if (name === "narrow-split") {
      const handle = await page.locator("#rz2").boundingBox();
      await page.mouse.move(handle.x, handle.y + 100);
      await page.mouse.down();
      await page.mouse.move(handle.x - 180, handle.y + 100, { steps: 5 });
      await page.mouse.up();
      assert.ok((await page.locator("#bibliographyPanel").boundingBox()).width < 450);
    }
    const host = page.locator(name === "desktop" ? "#bibliographyRows" : "#bibliographyCards");
    await host.waitFor({ state: "visible" });
    const summary = host.locator(".bibliography-full-value summary").first();
    await summary.focus();
    await page.keyboard.press("Enter");
    const full = host.locator(".bibliography-full-value[open] > .bibliography-value").first();
    assert.equal(await full.textContent(), long);
    assert.equal(await page.locator("#bibliographyPanel img").count(), 0);
    assert.equal(await page.evaluate(() => window.executed), undefined);
    assert.equal(await full.evaluate((el) => { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); return sel.toString(); }), long);
    assert.equal(await summary.evaluate((el) => el === document.activeElement), true);
    const results = await page.locator("#bibliographyResults").boundingBox();
    assert.ok(await full.evaluate((el) => {
      const range = document.createRange(); range.selectNodeContents(el); range.setStart(el.firstChild, el.textContent.length - 3);
      return range.getBoundingClientRect().bottom > document.querySelector("#bibliographyResults").getBoundingClientRect().bottom;
    }), "the final characters start below the results viewport");
    await page.mouse.move(results.x + results.width / 2, results.y + results.height / 2);
    await page.mouse.wheel(name === "desktop" ? 10000 : 0, 10000);
    await page.waitForFunction((selector) => {
      const el = document.querySelector(selector);
      const range = document.createRange(); range.selectNodeContents(el); range.setStart(el.firstChild, el.textContent.length - 3);
      const tail = range.getBoundingClientRect(), panel = document.querySelector("#bibliographyResults").getBoundingClientRect();
      return range.toString() === "END" && tail.top >= panel.top && tail.bottom <= panel.bottom &&
        el.contains(document.elementFromPoint(tail.x + tail.width / 2, tail.y + tail.height / 2));
    }, `${name === "desktop" ? "#bibliographyRows" : "#bibliographyCards"} .bibliography-full-value[open] > .bibliography-value`).catch(async (error) => {
      t.diagnostic(JSON.stringify(await full.evaluate((el) => {
        const range = document.createRange(); range.selectNodeContents(el); range.setStart(el.firstChild, el.textContent.length - 3);
        const rect = range.getBoundingClientRect();
        return { tail: rect.toJSON(), hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML,
          scroll: ["#bibliographyResults", ".bibliography-table-scroll"].map((s) => { const n = document.querySelector(s); return { rect: n.getBoundingClientRect().toJSON(), top: n.scrollTop, height: n.scrollHeight, client: n.clientHeight }; }) };
      })));
      throw error;
    });
    await noOverflow(page);
    await screenshot(t, page, `task-7-${name}.png`);
  });
}

test("10,000 references remain responsive with full-file columns, search and explicit pagination", options, async (t) => {
  const source = Array.from({ length: 10000 }, (_, i) => `@book{k${i},title={Title ${i}},author={Writer},year=2026${i === 9999 ? ",x_last={only-last}" : ""}}`).join("\n");
  const page = await pageFor(t, project(""));
  await page.evaluate(() => {
    window.frameGaps = []; window.lastFrame = performance.now();
    window.frameTimer = setInterval(() => { const now = performance.now(); frameGaps.push(now - lastFrame); lastFrame = now; }, 16);
  });
  const start = Date.now();
  await page.evaluate((data) => IrisApp.load(data), project(source, "refs.bib", { id: "large-test" }));
  await settled(page);
  const duration = Date.now() - start;
  const gaps = await page.evaluate(() => { clearInterval(frameTimer); return frameGaps; });
  assert.ok(gaps.length >= 2, "UI event loop advances while the Worker parses");
  assert.ok(Math.max(...gaps) < 2000, `UI stall: ${Math.max(...gaps)}ms`);
  assert.ok(duration < 10000, `large-file opening: ${duration}ms`);
  t.diagnostic(`10,000 references: ${duration}ms; max UI interval ${Math.max(...gaps).toFixed(1)}ms`);
  assert.equal(await page.locator("#bibliographyRows tr").count(), 100);
  assert.match(await page.locator("#bibliographyTotal").textContent(), /1.*100.*10000.*10000/);
  await page.locator("#bibliographyColumnsLabel").click();
  const checks = await page.locator("#bibliographyColumns label").allTextContents();
  assert.ok(checks.includes("x_last"));
  assert.equal(await page.getByRole("checkbox", { name: "x_last", exact: true }).isChecked(), true);
  await page.getByRole("checkbox", { name: "x_last", exact: true }).uncheck();
  await page.locator("#bibliographyNext").click();
  assert.equal(await page.locator("#bibliographyRows tr").first().getAttribute("data-entry-index"), "100");
  assert.match(await page.locator("#bibliographyTotal").textContent(), /101.*200.*10000/);
  await page.locator("#bibliographyQuery").fill("only-last");
  assert.equal(await page.locator("#bibliographyRows tr").count(), 1);
  assert.equal(await page.locator("#bibliographyRows tr").getAttribute("data-entry-index"), "9999");
  assert.deepEqual(await page.locator("#bibliographyColumns label").allTextContents(), checks);
  assert.equal(await page.locator("#bibliographyNext").isDisabled(), true);
  await page.locator("#bibliographyQuery").fill("");
  await page.locator("#bibliographySort").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#bibliographySort").evaluate((el) => el === document.activeElement), true);
  await page.locator("#bibliographySort").selectOption({ label: "Title: descending" });
  assert.equal(await page.locator("#bibliographyRows tr").first().getAttribute("data-entry-index"), "9999");
  await page.locator("#bibliographySort").selectOption("");
  // Reach the actual last page, not just a filtered substitute for pagination.
  for (let i = 0; i < 99; i++) await page.locator("#bibliographyNext").click();
  assert.equal(await page.locator("#bibliographyRows tr").last().getAttribute("data-entry-index"), "9999");
  assert.match(await page.locator("#bibliographyTotal").textContent(), /9901.*10000.*10000/);
  assert.equal(await page.locator("#bibliographyNext").isDisabled(), true);
  assert.deepEqual(await page.locator("#bibliographyColumns label").allTextContents(), checks);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
});

test("table/text switching preserves CodeMirror identity, selection, scroll and undo", options, async (t) => {
  const source = Array.from({ length: 160 }, (_, i) => `@book{k${i},\r\n title={Title ${i}},\r\n author={Writer},year=2026}\r\n`).join("");
  const page = await pageFor(t, project(source));
  await page.evaluate((source) => IrisEditor.loadCollab(source, "bib", { version: 0 }), source);
  await settled(page);
  const entry = `@book{k80,\r\n title={Title 80},\r\n author={Writer},year=2026}`;
  await page.locator('#bibliographyCards [data-entry-index="80"] button').click();
  assert.deepEqual(await page.evaluate(() => IrisEditor.selection()), { from: source.indexOf(entry), to: source.indexOf(entry) + entry.length, text: entry, anchor: source.indexOf(entry), head: source.indexOf(entry) + entry.length });
  await page.evaluate(() => { const pos = IrisEditor.selection().from; IrisEditor.select(pos); IrisEditor.focus(); });
  await page.keyboard.type("% note");
  await page.keyboard.press("Enter");
  await settled(page);
  await page.waitForFunction(() => document.querySelector(".cm-scroller").scrollTop > 100);
  const before = await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view");
    window.testView = EditorView.findFromDOM(document.querySelector(".cm-content"));
    window.testDoc = testView.state.doc;
    return { snapshot: IrisEditor.snapshot(), selection: IrisEditor.selection(), scroll: testView.scrollDOM.scrollTop, saved: IrisApp.serialize(), pending: IrisEditor.collabPending() };
  });
  await page.locator("#bibliographyTableTab").click();
  await noOverflow(page);
  await page.locator("#bibliographyTableTab").press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyTextTab");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => testView.state.doc === testDoc), true);
  const after = await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), selection: IrisEditor.selection(), scroll: testView.scrollDOM.scrollTop, saved: IrisApp.serialize(), pending: IrisEditor.collabPending() }));
  assert.deepEqual(after, before);
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
});

for (const [kind, source] of [["bib", "% before\r\n@book{k,title={A\u{1f600}\rbare},author={Writer},year=2026}\r\n"], ["ris", "TY  - BOOK\r\nTI  - A\u{1f600}\rAU  - Writer\r\nPY  - 2026\r\nER  -\r\n"]]) {
  test(`${kind}: DOM paste, Enter, undo, OT rebase and resync preserve raw UTF-16`, options, async (t) => {
    const page = await pageFor(t, project(source, `refs.${kind}`));
    await settled(page);
    const room = new CollabDocument({ fileId: "refs", projectId: "bibliography-test", content: source });
    await page.evaluate(({ source, kind }) => IrisEditor.loadCollab(source, kind, { version: 0 }), { source, kind });
    await page.locator("#bibliographyTextTab").click();
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
    const from = source.indexOf("A\u{1f600}") + 3;
    await page.evaluate((from) => { IrisEditor.select(from); IrisEditor.focus(); }, from);
    const inserted = " pasted\u{1f680}\r\nnext\rtail";
    assert.equal(await paste(page, inserted), true);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), source.slice(0, from) + inserted + source.slice(from));
    const peer = [{ clientID: "peer", changes: ChangeSet.of({ from: 0, insert: Text.of(["% peer\r", ""]) }, source.length).toJSON() }];
    room.receive(0, peer);
    await page.evaluate((updates) => IrisEditor.collabReceive(updates), peer);
    let pending = await page.evaluate(() => IrisEditor.collabPending());
    let accepted = room.receive(pending.version, pending.updates);
    assert.equal(accepted.accepted, true);
    await page.evaluate((updates) => IrisEditor.collabReceive(updates), accepted.updates);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), room.text());
    assert.equal(await page.evaluate(() => IrisEditor.selection().head), from + inserted.length + 8);
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), "% peer\r\n" + source);
    pending = await page.evaluate(() => IrisEditor.collabPending());
    accepted = room.receive(pending.version, pending.updates);
    await page.evaluate((updates) => IrisEditor.collabReceive(updates), accepted.updates);
    await page.keyboard.press("Enter");
    const afterEnter = "% peer\r\n" + source.slice(0, from) + "\n" + source.slice(from);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), afterEnter);
    pending = await page.evaluate(() => IrisEditor.collabPending());
    accepted = room.receive(pending.version, pending.updates);
    await page.evaluate((updates) => IrisEditor.collabReceive(updates), accepted.updates);
    assert.equal(room.text(), afterEnter);
    const reset = source + "% reset\r";
    const version = room.reset(reset);
    await page.evaluate(({ text, kind, version }) => IrisEditor.loadCollab(text, kind, { version }), { text: reset, kind, version });
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), reset);
    assert.equal(await page.evaluate(() => IrisEditor.collabPending()), null);
    assert.equal(await page.evaluate(() => IrisEditor.collabVersion()), version);
    await noOverflow(page);
  });
}

for (const method of ["typing", "paste BibTeX", "paste RIS"]) {
  test(`first recognition by ${method} retains source focus and debounces Worker parsing`, options, async (t) => {
    const page = await pageFor(t, project("", "notes.txt"));
    if (method.startsWith("paste")) await page.evaluate(() => IrisEditor.loadCollab("", "tex", { version: 0 }));
    await page.locator(".cm-content").focus();
    const before = await page.evaluate(() => IrisEditor.snapshot());
    const source = method === "paste RIS" ? "TY  - BOOK\r\nTI  - A\u{1f600}\rAU  - Writer\r\nPY  - 2026\r\nER  -\r\n"
      : "@book{k,title={A\u{1f600}\rbare},author={Writer},year=2026}\r\n";
    await page.evaluate(() => { window.inputTimes = []; document.querySelector(".cm-content").addEventListener("input", () => inputTimes.push(performance.now())); window.inputStart = performance.now(); });
    if (method === "typing") {
      await page.keyboard.type("@");
      assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
      await page.keyboard.type("book{k,title={A},author={Writer},year=2026}", { delay: 1 });
    } else assert.equal(await paste(page, source), true);
    assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
    assert.equal(await page.evaluate(() => IrisEditor.focusTarget() === document.activeElement), true);
    await settled(page);
    assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
    assert.equal(await page.locator("#bibliographyTableTab").getAttribute("aria-disabled"), "false");
    if (method.startsWith("paste")) assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
    const timing = await page.evaluate(() => ({ requests: bibliographyRequests.map(({ time }) => time), input: inputTimes.at(-1) || inputStart }));
    assert.equal(timing.requests.length, 1, "one complete parse after the input burst");
    assert.ok(timing.requests[0] - timing.input >= 100, "input uses the edit debounce, not immediate opening dispatch");
    if (method.startsWith("paste")) {
      assert.equal((await page.evaluate(() => IrisEditor.snapshot())).revision, before.revision + 1);
      const room = new CollabDocument({ fileId: "refs", projectId: "bibliography-test" });
      const pending = await page.evaluate(() => IrisEditor.collabPending());
      const accepted = room.receive(pending.version, pending.updates);
      assert.equal(accepted.accepted, true);
      assert.equal(room.text(), source);
      await page.evaluate((updates) => IrisEditor.collabReceive(updates), accepted.updates);
      await page.keyboard.press("ControlOrMeta+z");
      assert.equal(await page.evaluate(() => IrisEditor.getValue()), "");
      assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
    }
  });
}

test("ordinary text paste keeps its existing newline policy", options, async (t) => {
  const page = await pageFor(t, project("ordinary ", "notes.txt"));
  await page.evaluate(() => { IrisEditor.select(9); IrisEditor.focus(); });
  assert.equal(await paste(page, "text\r\nnext\rtail"), true);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "ordinary text\nnext\ntail");
  assert.equal(await page.locator("#bibliographyPanel").isVisible(), false);
  await page.keyboard.press("ControlOrMeta+z");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "ordinary ");
});

test("file tabs open RIS with repeated and custom fields visible and focus outside hidden source", options, async (t) => {
  const data = project("plain", "notes.txt");
  data.openTabs.push("ris");
  const content = "TY  - BOOK\r\nTI  - Title\r\nAU  - First\r\nAU  - Second\r\nPY  - 2026\r\nZZ  - custom\r\nER  -\r\n";
  data.project.nodes.push({ id: "ris", type: "file", name: "library.ris", path: "library.ris", kind: "ris", content });
  const page = await pageFor(t, data, { width: 390, height: 844 });
  await page.getByRole("tab", { name: /library\.ris/ }).click();
  await settled(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), "bibliographyTableTab");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), content);
  await page.locator("#bibliographyColumnsLabel").click();
  assert.equal(await page.locator("#bibliographyColumns input").count(), 5);
  assert.equal(await page.locator("#bibliographyColumns input:checked").count(), 5);
  assert.equal(await page.getByRole("checkbox", { name: "ZZ", exact: true }).isChecked(), true);
  assert.match(await page.locator("#bibliographyCards").textContent(), /First\nSecond/);
  assert.match(await page.locator("#bibliographyCards").textContent(), /ZZcustom/);
  await noOverflow(page);
});

test("initial malformed source and encoding explanations cannot become partial tables or saves", options, async (t) => {
  const page = await pageFor(t, project("@book{good,title={A}}\r\n@book{broken,"));
  await settled(page);
  assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
  assert.equal(await page.evaluate(() => IrisEditor.focusTarget() === document.activeElement), true);
  assert.equal(await page.locator("#bibliographyRows tr").count(), 0);
  assert.equal(await page.locator("#bibliographyTableTab").getAttribute("aria-disabled"), "true");
  await page.evaluate(() => IrisEditor.applyText("@book{fixed,title={A}}"));
  await settled(page);
  assert.equal(await page.locator("#bibliographyTableTab").getAttribute("aria-disabled"), "false");
  assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), true);
  const bad = project(undefined);
  bad.project.nodes[0].sourceError = "BIBLIOGRAPHY_INVALID_ENCODING";
  await page.evaluate((data) => { bibliographyRequests.length = 0; return IrisApp.load(data); }, bad);
  assert.equal(await page.locator("#bibliographyPanel").isVisible(), false);
  assert.equal(await page.evaluate(async () => { const { EditorView } = await import("@codemirror/view"); return EditorView.findFromDOM(document.querySelector(".cm-content")).state.readOnly; }), true);
  const explanation = await page.evaluate(() => IrisEditor.getValue());
  assert.match(explanation, /UTF-8/);
  await page.keyboard.type("must-not-save");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), explanation);
  assert.deepEqual(await page.evaluate(() => bibliographyRequests), []);
  const saved = await page.evaluate(() => IrisApp.serialize());
  assert.equal(saved.project.nodes[0].content, undefined);
  assert.equal(JSON.stringify(saved).includes(explanation), false);
  assert.equal(await page.evaluate(() => IrisApp.hasUnsavedChanges()), false);
});

for (const moveFocus of [false, true]) {
  test(`chooser opening focuses the visible bibliography${moveFocus ? " without stealing a newer focus target" : ""}`, options, async (t) => {
    const page = await pageFor(t, project("", "notes.txt"));
    const data = project("@book{k,title={A},author={Writer},year=2026}", "refs.bib", { id: "chooser-test" });
    await page.route("**/api/projects/chooser-test", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) }));
    await page.evaluate(() => IrisProjects.showPicker());
    await page.evaluate(async (moveFocus) => {
      await IrisProjects.openProject("chooser-test");
      if (moveFocus) document.querySelector("#btnSettings").focus();
    }, moveFocus);
    await settled(page);
    await page.waitForFunction(() => !document.documentElement.classList.contains("iris-project-opening"));
    assert.equal(await page.evaluate(() => document.activeElement.id), moveFocus ? "btnSettings" : "bibliographyTableTab");
    assert.equal(await page.locator("#bibliographyTextPanel").isVisible(), false);
    await noOverflow(page);
  });
}

for (const format of ["bib", "ris"]) {
  test(`remembered ${format} generic file reopens without normalizing retained CRLF`, options, async (t) => {
    const data = project(format === "bib" ? "@book{a,title={A}}\r\n" : "TY  - BOOK\r\nTI  - A\r\nER  -\r\n", "refs.txt");
    data.openTabs.push("other");
    data.project.nodes.push({ type: "file", id: "other", name: "other.tex", path: "other.tex", kind: "tex", content: "ordinary" });
    const page = await pageFor(t, data);
    await settled(page);
    const retained = "% retained\r\n% astral\u{1f600}\r% bare\r\n";
    await page.locator("#bibliographyTextTab").click();
    await page.evaluate((text) => IrisEditor.applyText(text), retained);
    await settled(page);
    await page.getByRole("tab", { name: /other\.tex/ }).click();
    await page.getByRole("tab", { name: /refs\.txt/ }).click();
    await settled(page);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), retained);
    await page.locator("#bibliographyTextTab").click();
    await page.evaluate((text) => { IrisEditor.select(text.length); IrisEditor.focus(); }, retained);
    await page.keyboard.type(" ");
    const saved = await page.evaluate(() => IrisApp.serialize());
    assert.equal(saved.project.nodes[0].content, retained + " ");
    assert.equal(saved.project.nodes[0].kind, "txt");
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), retained);
    await noOverflow(page);
  });
}

for (const format of ["bib", "ris"]) for (const trivia of [false, true]) {
  test(`format memory browser: ${format} removal and reopen ignores conflicting extension (${trivia ? "remnants" : "empty"})`, options, async (t) => {
    const extension = format === "bib" ? "ris" : "bib";
    const record = format === "bib" ? "@book{a,title={A}}" : "TY  - BOOK\r\nTI  - A\r\nER  -";
    const prefix = trivia ? "% retained\r\n% astral\u{1F600}\r" : "", suffix = trivia ? "\r\n% end\n" : "";
    const source = prefix + record + suffix, retained = prefix + suffix;
    const data = project(source, `refs.${extension}`);
    data.openTabs.push("other");
    data.project.nodes.push({ type: "file", id: "other", name: "other.tex", path: "other.tex", kind: "tex", content: "ordinary" });
    const page = await pageFor(t, data);
    await settled(page);
    await selectReference(page);
    await page.locator("#bibliographyEdit").click();
    assert.equal(await page.locator("#bibliographyFormType").inputValue(), format === "bib" ? "book" : "BOOK");
    await page.locator("#bibliographyFormCancel").click();
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await settled(page); await selectReference(page);
      await page.locator("#bibliographyRemove").click();
      await page.locator("#bibliographyFormApply").click();
      await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => IrisEditor.getValue()), retained);
      await settled(page);
      if (attempt === 0) {
        await page.locator("#bibliographyUndo").click();
        assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
      }
    }
    await page.getByRole("tab", { name: /other\.tex/ }).click();
    await page.getByRole("tab", { name: new RegExp(`refs\\.${extension}`) }).click();
    await settled(page);
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), retained);
    const before = await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), saved: IrisApp.serialize(), dirty: IrisApp.hasUnsavedChanges() }));
    await page.locator("#bibliographyAdd").click();
    assert.equal(await page.locator("#bibliographyFormType").inputValue(), format === "bib" ? "article" : "JOUR");
    assert.deepEqual(await page.evaluate(() => ({ snapshot: IrisEditor.snapshot(), saved: IrisApp.serialize(), dirty: IrisApp.hasUnsavedChanges() })), before);
    await page.locator(`[data-native-name="${format === "bib" ? "title" : "TI"}"] textarea`).fill("New");
    await page.locator("#bibliographyFormApply").click();
    await page.locator("#bibliographyModal").waitFor({ state: "hidden" });
    const saved = await page.evaluate(() => IrisApp.serialize());
    const newline = /\r\n|\r|\n/.exec(retained)?.[0] || "\n";
    const added = format === "bib" ? ["@article{,", "  title = {New}", "}", ""].join(newline) : ["TY  - JOUR", "TI  - New", "ER  -", ""].join(newline);
    assert.equal(saved.project.nodes[0].content, retained + added);
    assert.equal(saved.project.nodes[0].kind, extension);
    assert.deepEqual(Object.keys(saved.project.nodes[0]).sort(), Object.keys(before.saved.project.nodes[0]).sort());
    await settled(page); await page.locator("#bibliographyUndo").click();
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), retained);
  });
}

for (const language of ["en", "it"]) {
  test(`${language} colliding column labels stay distinct across the full file union`, options, async (t) => {
    const page = await pageFor(t, project("@article{a,title={Needle},journal={Native journal},year=0007,date={2026-09-10}}\n@article{b,title={Other},journaltitle={Native title}}"));
    await page.evaluate((language) => IrisI18n.setLanguage(language), language);
    await settled(page);
    await page.locator("#btnSidebar").click();
    const journal = language === "en" ? "Journal" : "Rivista";
    await page.getByRole("columnheader", { name: `${journal} (journal)`, exact: true }).waitFor();
    await page.getByRole("columnheader", { name: `${journal} (journaltitle)`, exact: true }).waitFor();
    assert.equal(await page.locator("#bibliographyRows").getByText("0007", { exact: true }).textContent(), "0007");
    assert.equal(await page.locator("#bibliographyRows").getByText("2026-09-10", { exact: true }).textContent(), "2026-09-10");
    await page.locator("#bibliographyColumnsLabel").click();
    await page.getByRole("checkbox", { name: `${journal} (journaltitle)`, exact: true }).uncheck();
    await page.locator("#bibliographyQuery").fill("Needle");
    assert.equal(await page.getByRole("columnheader", { name: `${journal} (journal)`, exact: true }).count(), 1);
    assert.equal(await page.getByRole("checkbox", { name: `${journal} (journaltitle)`, exact: true }).count(), 1);
    assert.ok((await page.locator("#bibliographySort option").allTextContents()).includes(`${journal} (journal): ${language === "en" ? "ascending" : "crescente"}`));
    await page.getByRole("checkbox", { name: `${journal} (journaltitle)`, exact: true }).check();
    assert.ok((await page.locator("#bibliographySort option").allTextContents()).includes(`${journal} (journaltitle): ${language === "en" ? "ascending" : "crescente"}`));
    await noOverflow(page);
    if (language === "en") {
      await page.locator("#bibliographyQuery").fill("");
      await screenshot(t, page, "task-7-round-1-mixed.png");
    }
  });

  test(`${language} totals pluralize filtered results and whole-file references independently`, options, async (t) => {
    const first = "@book{a,title={Needle}}";
    const page = await pageFor(t, project(first));
    await page.evaluate((language) => IrisI18n.setLanguage(language), language);
    await settled(page);
    const totals = language === "en"
      ? ["1-1 of 1 result; 1 reference in the file", "0-0 of 0 results; 1 reference in the file", "1-1 of 1 result; 2 references in the file", "1-2 of 2 results; 2 references in the file"]
      : ["1-1 di 1 risultato; 1 reference nel file", "0-0 di 0 risultati; 1 reference nel file", "1-1 di 1 risultato; 2 reference nel file", "1-2 di 2 risultati; 2 reference nel file"];
    assert.equal(await page.locator("#bibliographyTotal").textContent(), totals[0]);
    await page.locator("#bibliographyQuery").fill("missing");
    assert.equal(await page.locator("#bibliographyTotal").textContent(), totals[1]);
    await page.evaluate((source) => IrisEditor.applyText(source), first + "\n@book{b,title={Other}}");
    await settled(page);
    await page.locator("#bibliographyQuery").fill("Needle");
    assert.equal(await page.locator("#bibliographyTotal").textContent(), totals[2]);
    await page.locator("#bibliographyQuery").fill("");
    assert.equal(await page.locator("#bibliographyTotal").textContent(), totals[3]);
  });
}

for (const format of ["bib", "ris"]) for (const route of ["open", "upload"]) {
  test(`generic ${format} ${route} uses original bytes at the browser FileReader boundary`, options, async (t) => {
    const page = await pageFor(t, project("ordinary", "main.tex"));
    const source = format === "bib" ? "\uFEFF@book{a,title={Caf\u00e9}}\r\n" : "\uFEFFTY  - BOOK\r\nTI  - Caf\u00e9\r\nER  -\r\n";
    const before = await page.evaluate(() => IrisApp.serialize());
    const damaged = [Buffer.concat([Buffer.from("\uFEFF"), Buffer.from(source.slice(1), "latin1")]), Buffer.from(source.replace("\u00e9", "\0"))];
    if (route === "open") damaged.push(Buffer.from(source, "utf16le"));
    for (const [i, buffer] of [...damaged, Buffer.from(source)].entries()) {
      const valid = i === damaged.length;
      const file = { name: valid ? "valid.txt" : `damaged-${i}.md`, mimeType: "application/octet-stream", buffer };
      const notices = await page.locator("#toasts > *").count();
      if (route === "open") {
        const chooser = page.waitForEvent("filechooser");
        await page.locator("#btnOpen").click();
        await (await chooser).setFiles(file);
      } else {
        if (!await page.locator("#attachModal").isVisible()) await page.locator("#btnAttach").click();
        await page.locator("#attachInput").setInputFiles(file);
        await page.locator("#attachUpload").click();
      }
      await page.waitForFunction((notices) => document.querySelector("#toasts").children.length > notices, notices);
      const saved = await page.evaluate(() => IrisApp.serialize());
      if (valid) assert.equal(saved.project.nodes.at(-1).content, source);
      else assert.deepEqual(saved, before, "damaged bibliography bytes must not enter project state");
    }
    if (route === "upload") {
      await page.locator("#attachModal").waitFor({ state: "hidden" });
      await page.locator(".node").getByText("valid.txt", { exact: true }).click();
    }
    await settled(page);
    assert.equal(await page.locator("#bibliographyTableTab").getAttribute("aria-disabled"), "false");
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), source);
  });
}

test("ordinary external open retains FileReader BOM decoding", options, async (t) => {
  const page = await pageFor(t, project("ordinary", "main.tex"));
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#btnOpen").click();
  await (await chooser).setFiles({ name: "ordinary.txt", mimeType: "text/plain", buffer: Buffer.from("\uFEFFordinary Caf\u00e9", "utf16le") });
  await page.waitForFunction(() => IrisApp.serialize().project.nodes.length === 2);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), "ordinary Caf\u00e9");
  assert.equal(await page.locator("#bibliographyPanel").isVisible(), false);
});
