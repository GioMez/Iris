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
  await page.screenshot({ path: file, fullPage: true });
  t.diagnostic(`Screenshot: ${file}`);
}

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
