const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");

const enabled = process.env.IRIS_TEST_BROWSER === "1";
const options = { skip: !enabled, timeout: 30000 };
const projectId = "visibility-project";
const fileId = "11111111-1111-4111-8111-111111111111";
const source = "\\documentclass{article}\n\\begin{document}\nVisibility\n\\end{document}\n";
const template = { id: "visibility", type: "latex", title: "Visibility template",
  description: "Browser fixture", default: true, size: Buffer.byteLength(source), content: source };
const version = { id: "22222222-2222-4222-8222-222222222222", reason: "initial",
  createdAt: "2026-09-12T10:00:00.000Z", author: "Browser fixture", size: Buffer.byteLength(source) };
const peer = { id: "peer-session", userId: "peer-user", username: "ada", name: "Ada",
  color: "#9ece6a", role: "viewer", anchor: 0, head: 0, version: 0 };
const variants = [
  { name: "desktop / EN", viewport: { width: 1440, height: 900 }, language: "en",
    live: "Realtime", maintenance: "Maintenance · read-only", peers: "Also editing this file: Ada",
    remove: "Delete template", diff: "Changes" },
  { name: "compact / IT", viewport: { width: 390, height: 844 }, language: "it",
    live: "Tempo reale", maintenance: "Manutenzione · sola lettura", peers: "Stanno modificando questo file anche: Ada",
    remove: "Elimina modello", diff: "Modifiche" },
];
let browser, base, deferred;

async function bounded(work, label, ms = 5000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Browser wait timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function cleanup(steps) {
  const errors = [];
  for (const [label, work] of steps) {
    try { await bounded(work, label); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Visibility browser cleanup failed");
}

test.before(async (t) => {
  if (!enabled) return;
  assert.ok(process.env.TEST_DATABASE_URL, "browser gate needs a disposable TEST_DATABASE_URL");
  const helpers = require("./helpers/server-fixture.cjs");
  deferred = helpers.deferred;
  base = new URL((await helpers.serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public") })).baseUrl);
  browser = await chromium.launch({ headless: true, timeout: 10000,
    ...(process.env.IRIS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.IRIS_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
  t.after(() => bounded(() => browser.close(), "browser close", 10000), { timeout: 15000 });
  t.diagnostic(`Browser: ${browser.version()}; isolated fixture: ${base.origin}`);
}, { timeout: 30000 });

async function pageFor(t, variant, { openProject = true, authenticated = true, projects = [], extraFiles = [], documentSource = source } = {}) {
  const context = await browser.newContext({ viewport: variant.viewport, deviceScaleFactor: variant.scale || 1,
    hasTouch: !!variant.touch, reducedMotion: "reduce" });
  const sockets = new Set(), gates = new Set(), errors = [];
  let page, closing = false;
  t.after(async () => {
    closing = true;
    gates.forEach((gate) => gate.resolve({ status: 503, body: { errorCode: "NOT_FOUND" } }));
    await cleanup([
      ["collaboration disconnect", () => page && !page.isClosed() && page.evaluate(() => window.IrisCollab?.disconnect())],
      ["routed sockets", () => Promise.all([...sockets].map((socket) => socket.close({ code: 1000, reason: "test cleanup" })))],
      ["page context", () => context.close()],
      ["runtime errors", () => assert.deepEqual(errors, [], "no page, controller, or fixture errors")],
    ]);
  }, { timeout: 25000 });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === base.origin && !url.pathname.startsWith("/api/") && response.status() >= 400) {
      errors.push(`Asset response: ${response.status()} ${url.pathname}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  const data = { id: projectId, role: "owner", revision: 1, projectType: "latex", language: variant.language,
    activeId: fileId, openTabs: [fileId, "draft", ...extraFiles.map((file) => file.id)],
    project: { name: "Visibility test", nodes: [
      { id: fileId, type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: documentSource },
      { id: "draft", type: "file", name: "draft.txt", path: "draft.txt", kind: "tex", content: "Local draft\n" },
      ...extraFiles,
    ] }, assets: {}, fonts: [], autoSave: false, autoSaveDelay: 600, engine: "pdflatex",
    lilypondArgs: "", lilypondFormat: "pdf",
    compileProfile: { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] } };
  const fixture = { versions: [], socket: null, detail: null,
    holdDetail() {
      const gate = deferred();
      gates.add(gate);
      this.detail = gate.promise;
      return gate;
    } };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/*", async (route) => {
    try {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin) return await route.abort();
      if (!url.pathname.startsWith("/api/")) return await route.continue();
      const responses = {
        "/api/config": { auth: { ssoEnabled: false } },
        "/api/auth/session": { user: authenticated ? { id: "browser-admin", username: "browser-test", name: "Browser Admin",
          email: "browser@example.invalid", role: "admin", authSource: "local",
          canChangePassword: true, passwordChangeRequired: false } : null },
        "/api/projects": { projects },
        "/api/project-templates": { templates: { latex: [], lilypond: [] } },
        [`/api/projects/${projectId}`]: data,
        [`/api/projects/${projectId}/builds`]: { builds: [], nextOffset: null },
        [`/api/projects/${projectId}/files/${fileId}/versions`]: { versions: fixture.versions },
        [`/api/projects/${projectId}/files/${fileId}/versions/${version.id}`]: { ...version, content: source },
        "/api/admin/users": { users: [] },
        "/api/admin/templates": { templates: { latex: [template], lilypond: [] } },
      };
      if (route.request().method() === "GET" && url.pathname === "/api/admin/templates/latex/visibility") {
        const response = fixture.detail ? await bounded(() => fixture.detail, "held template response", 10000)
          : { body: { template } };
        return await json(route, response.body, response.status || 200);
      }
      if (route.request().method() !== "GET" || !Object.hasOwn(responses, url.pathname)) {
        errors.push(`Unexpected API request: ${route.request().method()} ${url.pathname}`);
        return await json(route, { errorCode: "NOT_FOUND" }, 404);
      }
      return await json(route, responses[url.pathname]);
    } catch (error) {
      if (!closing) errors.push(error.message);
      await route.abort().catch(() => {});
    }
  });
  // Only the transport is controlled; IrisCollab and the editor process real WS frames.
  await page.routeWebSocket("**/*", (socket) => {
    fixture.socket = socket;
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage((raw) => {
      try {
        const message = JSON.parse(raw);
        if (message.t === "open") socket.send(JSON.stringify({ t: "opened", fileId: message.fileId,
          role: "owner", version: 0, doc: documentSource }));
        else if (!["project", "close", "presence"].includes(message.t)) errors.push(`Unexpected WS frame: ${message.t}`);
      } catch (error) { if (!closing) errors.push(error.message); }
    });
    socket.send(JSON.stringify({ t: "ready", sessionId: "browser-session", color: "#7dcfff" }));
  });
  const response = await page.goto(base.href, { waitUntil: "networkidle", timeout: 10000 });
  assert.equal(response.status(), 200, "fixture serves the actual Iris document");
  await page.waitForFunction((authenticated) => document.documentElement.classList.contains("iris-authed") === authenticated
    && IrisMotion.activeSurface() === (authenticated ? "picker" : "login"), authenticated);
  await bounded(() => page.evaluate(async (language) => {
    await Promise.all([IrisEditor.ready, IrisI18n.ready]);
    await IrisI18n.setLanguage(language);
  }, variant.language), "application ready");
  if (openProject && authenticated) {
    await bounded(() => page.evaluate((id) => IrisProjects.openProject(id), projectId), "open project");
    await page.waitForFunction(() => IrisCollab.status() === "live" && IrisMotion.activeSurface() === "app");
    assert.equal(await page.locator(".app").evaluate((node) => node.inert), false);
  }
  return { page, fixture };
}

function send(fixture, frame) {
  assert.ok(fixture.socket, "application opened its collaboration transport");
  fixture.socket.send(JSON.stringify(frame));
}

async function selectFile(page, id) {
  await page.locator("#ftabs").getByRole("tab", { name: id === "draft" ? "draft.txt" : "main.tex", exact: true }).click();
  await page.waitForFunction((id) => IrisCollab.fileId() === (id === "draft" ? null : id)
    && IrisCollab.status() === (id === "draft" ? "off" : "live"), id);
}

async function visible(page, selector, display) {
  const actual = await page.locator(selector).evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { hidden: node.hidden, display: getComputedStyle(node).display,
      rects: node.getClientRects().length, width: box.width, height: box.height };
  });
  assert.equal(actual.hidden, false, `${selector} is restored by its controller`);
  assert.match(actual.display, display, `${selector} restores its native display mode`);
  assert.ok(actual.rects > 0 && actual.width > 0 && actual.height > 0, `${selector} has visible layout: ${JSON.stringify(actual)}`);
}

// Collect each transition before asserting so RED also exercises the visible-again
// states and reports keyboard failures instead of stopping at the first rectangle.
function hiddenChecks(t) {
  const actual = [], expected = [];
  return {
    async capture(page, selector, state) {
      const snapshot = await page.locator(selector).evaluate((node) => {
        const box = node.getBoundingClientRect();
        const focusable = 'button,input,select,textarea,a[href],[tabindex]';
        const controls = [...(node.matches(focusable) ? [node] : []), ...node.querySelectorAll(focusable)];
        const focused = [];
        for (const control of controls) {
          control.focus();
          if (document.activeElement === control) focused.push(control.id);
        }
        return { hidden: node.hidden, display: getComputedStyle(node).display,
          rects: node.getClientRects().length, width: box.width, height: box.height,
          descendantRects: [...node.querySelectorAll("*")].reduce((n, child) => n + child.getClientRects().length, 0), focused };
      });
      t.diagnostic(`${state}: ${JSON.stringify(snapshot)}`);
      actual.push({ state, ...snapshot });
      expected.push({ state, hidden: true, display: "none", rects: 0, width: 0, height: 0, descendantRects: 0, focused: [] });
    },
    async keyboard(page, from, key, target, state) {
      await page.locator(from).focus();
      await page.keyboard.press(key);
      const focus = await page.evaluate(() => ({ id: document.activeElement.id,
        hiddenAncestor: document.activeElement.closest("[hidden]")?.id || null }));
      t.diagnostic(`${state}: ${key} focused #${focus.id}; hidden ancestor: ${focus.hiddenAncestor}`);
      actual.push(target ? { state, focused: focus.id } : { state, hiddenAncestor: focus.hiddenAncestor });
      expected.push(target ? { state, focused: target } : { state, hiddenAncestor: null });
    },
    verify() { assert.deepEqual(actual, expected, "hidden elements leave layout and keyboard/programmatic focus"); },
  };
}

async function openHistory(page, variant) {
  if (variant.viewport.width < 1180 && !await page.locator(".body").evaluate((node) => node.classList.contains("drawer-open"))) {
    await page.locator("#btnSidebar").click();
  }
  const node = page.locator(`#tree .node[data-id="${fileId}"]`);
  await node.hover();
  await node.locator('[data-act="history"]').click();
  await page.locator("#versionsModal").waitFor({ state: "visible" });
  await page.waitForFunction(() => !!document.querySelector("#versionsView").textContent);
}

for (const variant of variants) {
  test(`hidden sync: ${variant.name} live, off, late maintenance reset and live again`, options, async (t) => {
    const { page, fixture } = await pageFor(t, variant);
    const checks = hiddenChecks(t);
    await visible(page, "#stSync", /^(inline-)?flex$/);
    assert.equal(await page.locator("#stSyncLabel").textContent(), variant.live);
    await selectFile(page, "draft");
    await checks.capture(page, "#stSync", "room left after live label");
    // A late role reply must not resurrect the departed file. Maintenance is
    // project-wide, so its end is a real late status reset even outside a room.
    send(fixture, { t: "role", fileId, role: "viewer" });
    send(fixture, { t: "maintenance", active: true });
    await page.waitForFunction(() => IrisCollab.paused());
    await visible(page, "#stSync", /^(inline-)?flex$/);
    assert.equal(await page.locator("#stSyncLabel").textContent(), variant.maintenance);
    send(fixture, { t: "maintenance", active: false });
    await page.waitForFunction(() => !IrisCollab.paused());
    assert.equal(await page.evaluate(() => IrisCollab.status()), "off");
    await checks.capture(page, "#stSync", "late maintenance end outside a room");
    await selectFile(page, fileId);
    await visible(page, "#stSync", /^(inline-)?flex$/);
    assert.equal(await page.locator("#stSyncLabel").textContent(), variant.live);
    checks.verify();
  });

  test(`hidden presence: ${variant.name} last peer leaves, late reset and peers return`, options, async (t) => {
    const { page, fixture } = await pageFor(t, variant);
    const checks = hiddenChecks(t);
    const showPeer = async () => {
      send(fixture, { t: "peers", fileId, peers: [peer] });
      await page.waitForFunction(() => document.querySelector("#stPeers .peer-count")?.textContent === "Ada");
      await visible(page, "#stPeers", /^(inline-)?flex$/);
      assert.equal(await page.locator("#stPeers").getAttribute("aria-label"), variant.peers);
    };
    await showPeer();
    send(fixture, { t: "peers", fileId, peers: [] });
    await page.waitForFunction(() => IrisCollab.peers().length === 0 && document.querySelector("#stPeers").hidden);
    await checks.capture(page, "#stPeers", "last peer left (no padding footprint)");
    await showPeer();
    await selectFile(page, "draft");
    send(fixture, { t: "peers", fileId, peers: [peer] });
    send(fixture, { t: "peers", fileId, peers: [] });
    // Ordered WS maintenance frame is an awaited barrier for both late frames.
    send(fixture, { t: "maintenance", active: true });
    await page.waitForFunction(() => IrisCollab.paused());
    assert.equal(await page.evaluate(() => IrisCollab.peers().length), 0);
    await checks.capture(page, "#stPeers", "late peer frames after room reset");
    send(fixture, { t: "maintenance", active: false });
    await page.waitForFunction(() => !IrisCollab.paused());
    await selectFile(page, fileId);
    await showPeer();
    checks.verify();
  });

  test(`hidden template delete: ${variant.name} new, loading, unready and ready again`, options, async (t) => {
    const { page, fixture } = await pageFor(t, variant, { openProject: false });
    const checks = hiddenChecks(t);
    await page.locator("#pkAdmin").click();
    await page.locator("#adminTabTemplates").click();
    const edit = page.locator('#adminTemplateRows [data-template-id="visibility"] .admin-row-edit');
    await edit.waitFor({ state: "visible" });
    await page.locator("#adminTemplateNew").click();
    await page.waitForFunction(() => document.activeElement.id === "adminTemplateTitle");
    assert.equal(await page.locator("#adminTemplateDelete").isDisabled(), false, "new-form focus check is not masked by disabled");
    await checks.capture(page, "#adminTemplateDelete", "new template");
    await checks.keyboard(page, "#adminTemplateCancel", "Shift+Tab", "adminTemplateContent", "new template tab order");
    await page.locator("#adminTemplateCancel").click();
    await page.locator("#adminTemplateModal").waitFor({ state: "hidden" });

    const first = fixture.holdDetail();
    await edit.click();
    await page.waitForFunction(() => document.querySelector("#adminTemplateForm").hasAttribute("aria-busy"));
    await checks.capture(page, "#adminTemplateDelete", "existing template loading");
    // Chrome can tab into the compact form's native scroll container while all
    // fields are disabled; the hidden action must be excluded in either layout.
    await checks.keyboard(page, "#adminTemplateCancel", "Shift+Tab", null, "loading template tab order");
    first.resolve({ status: 503, body: { errorCode: "NOT_FOUND" } });
    await page.waitForFunction(() => !document.querySelector("#adminTemplateForm").hasAttribute("aria-busy")
      && !document.querySelector("#adminTemplateDetailRetry").hidden);
    await checks.capture(page, "#adminTemplateDelete", "failed detail remains unready");
    const retry = fixture.holdDetail();
    await page.locator("#adminTemplateDetailRetry").click();
    await checks.capture(page, "#adminTemplateDelete", "retry loading");
    retry.resolve({ body: { template } });
    await page.waitForFunction(() => !document.querySelector("#adminTemplateDelete").hidden);
    await visible(page, "#adminTemplateDelete", /^(inline-)?flex$/);
    assert.equal(await page.locator("#adminTemplateDelete").textContent(), variant.remove);
    assert.equal(await page.locator("#adminTemplateContent").inputValue(), source);
    await page.locator("#adminTemplateContent").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "adminTemplateDelete");
    await page.keyboard.press("Enter");
    await page.locator("#adminTemplateDeleteModal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#adminTemplateForm").evaluate((node) => node.inert), true);
    await page.locator("#adminTemplateDeleteCancel").click();
    await page.locator("#adminTemplateDeleteModal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement.id), "adminTemplateDelete");
    await page.locator("#adminTemplateCancel").click();
    await page.locator("#adminTemplateModal").waitFor({ state: "hidden" });
    await page.locator("#adminTemplateNew").click();
    await page.waitForFunction(() => document.activeElement.id === "adminTemplateTitle");
    await checks.capture(page, "#adminTemplateDelete", "new template after ready edit");
    checks.verify();
  });

  test(`hidden version tabs: ${variant.name} empty, selected, empty again and restored grid`, options, async (t) => {
    const { page, fixture } = await pageFor(t, variant);
    const checks = hiddenChecks(t);
    for (const selected of [false, true, false, true]) {
      fixture.versions = selected ? [version] : [];
      await openHistory(page, variant);
      if (selected) {
        await page.waitForFunction(() => !!document.querySelector("#versionsView .ver-pre"));
        await visible(page, "#versionsViewSwitch", /^grid$/);
        assert.equal(await page.locator("#versionsDiffTab").textContent(), variant.diff);
        await page.locator("#versionsPreviewTab").focus();
        await page.keyboard.press("ArrowRight");
        assert.equal(await page.evaluate(() => document.activeElement.id), "versionsDiffTab");
        assert.equal(await page.locator("#versionsDiffTab").getAttribute("aria-selected"), "true");
      } else {
        await page.waitForFunction(() => document.querySelector("#versionsViewSwitch").hidden);
        await checks.capture(page, "#versionsViewSwitch", "history without a selected version");
        await checks.keyboard(page, "#versionsModal [data-close]", "Tab", "versionsView", "empty history tab order");
      }
      await page.locator("#versionsModal [data-close]").click();
      await page.locator("#versionsModal").waitFor({ state: "hidden" });
    }
    checks.verify();
  });
}

// Doubling DPR while halving the desktop's CSS viewport models the reflow and
// raster density of 200% browser zoom; it does not claim a physical-device test.
const layoutVariants = [
  { name: "desktop EN", viewport: { width: 1440, height: 900 }, language: "en" },
  { name: "tablet IT", viewport: { width: 1024, height: 768 }, language: "it" },
  { name: "compact EN", viewport: { width: 390, height: 844 }, language: "en" },
  { name: "compact IT", viewport: { width: 390, height: 844 }, language: "it" },
  { name: "200% equivalent IT", viewport: { width: 720, height: 450 }, scale: 2, language: "it" },
];

async function surfaceFits(page, selector) {
  const surface = page.locator(selector);
  await surface.waitFor({ state: "visible" });
  const issues = await surface.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const problems = [];
    if (box.left < -1 || box.right > innerWidth + 1) problems.push("surface leaves viewport horizontally");
    for (const control of node.querySelectorAll("button,input,select,textarea")) {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height || control.closest("[hidden]")) continue;
      if (rect.width > box.width + 1) problems.push(`${control.id || control.className}: control wider than surface`);
    }
    for (const copy of node.querySelectorAll(".login-sub,.picker-sub,.pcard-name,.pcard-meta,.desc,.hint")) {
      if (copy.clientWidth && copy.scrollWidth > copy.clientWidth + 1) problems.push(`${copy.className}: text overflows horizontally`);
    }
    return problems;
  });
  assert.deepEqual(issues, [], `${selector} keeps controls and wrapping text inside its layout`);
}

async function openSettings(page) {
  await page.locator("#btnSettings").click();
  // IrisMotion may focus the same tab synchronously before openSettings repeats
  // that focus in requestAnimationFrame. Cross the queued frame, then verify the
  // handoff, before directing keyboard input elsewhere.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  await page.waitForFunction(() => document.activeElement === document.querySelector(
    matchMedia("(max-width: 700px)").matches ? '.set-accordion-trigger[data-set="fonts"]' : "#settingsTabFonts"));
}

for (const variant of layoutVariants) {
  test(`UI scale reflow keeps login, project home, admin and settings usable: ${variant.name}`, options, async (t) => {
    const login = await pageFor(t, variant, { openProject: false, authenticated: false });
    await surfaceFits(login.page, ".login-card");
    const projects = [{ id: projectId, name: "Appunti e riferimenti per il laboratorio di composizione e ricerca",
      projectType: "latex", role: "owner", updatedAt: "2026-09-12T10:00:00.000Z" }];
    const { page } = await pageFor(t, variant, { openProject: false, projects });
    await surfaceFits(page, "#pickerScreen .picker-wrap");
    await surfaceFits(page, ".pcard");
    const homeInset = await page.locator("#pickerScreen").evaluate((node) => getComputedStyle(node).padding);
    await page.locator("#pkAdmin").click();
    await surfaceFits(page, "#adminScreen .picker-wrap");
    assert.equal(await page.locator("#adminScreen").evaluate((node) => getComputedStyle(node).padding), homeInset);
    await page.locator("#adminTabTemplates").click();
    await page.locator("#adminTemplateNew").click();
    await surfaceFits(page, ".admin-template-modal");
    await page.locator("#adminTemplateCancel").focus();
    await page.keyboard.press("Enter");
    await page.locator("#adminTemplateModal").waitFor({ state: "hidden" });
    await page.locator("#adminBack").click();
    await page.evaluate((id) => IrisProjects.openProject(id), projectId);
    await page.waitForFunction(() => IrisCollab.status() === "live");
    await surfaceFits(page, ".app");
    for (const selector of ["#btnCompile", "#btnSettings"]) {
      assert.equal(await page.locator(selector).evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
      }), true, `${selector} remains reachable in the viewport`);
    }
    await openSettings(page);
    await surfaceFits(page, ".settings-modal");
    const close = page.locator("#settingsModal .m-foot [data-close]");
    await close.focus();
    await page.keyboard.press("Enter");
    await page.locator("#settingsModal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement.id), "btnSettings");
  });
}

test("hidden invariant: ordinary inline display cannot expose an explicitly hidden app control", options, async (t) => {
  const { page } = await pageFor(t, variants[0]);
  const checks = hiddenChecks(t);
  // This isolated cascade invariant is the only direct hidden mutation in the
  // suite. The four flows above are driven exclusively by production controllers.
  for (const display of ["inline-flex", "grid"]) {
    await page.locator("#btnSettings").evaluate((node, display) => {
      node.style.display = display;
      node.hidden = true;
    }, display);
    await checks.capture(page, "#btnSettings", `hidden with normal inline ${display}`);
    await page.locator("#btnSettings").evaluate((node) => { node.hidden = false; });
    await visible(page, "#btnSettings", display === "grid" ? /^grid$/ : /^(inline-)?flex$/);
  }
  await page.locator("#btnSettings").evaluate((node) => node.style.removeProperty("display"));
  checks.verify();
});

// A local hard-coded measurement must not detach a consumer from the shared UI
// scale. Override tokens with non-default values and observe the rendered app;
// editor metrics deliberately remain independent of interface typography.
for (const variant of variants) {
  test(`shared UI scales reach dialog controls without changing editor metrics: ${variant.name}`, options, async (t) => {
    const { page } = await pageFor(t, variant);
    const editorMetrics = () => page.locator(".cm-host .cm-scroller").evaluate((node) => {
      const style = getComputedStyle(node);
      const line = getComputedStyle(document.querySelector(".cm-host .cm-line"));
      return [style.fontSize, style.lineHeight, line.paddingLeft];
    });
    const before = await editorMetrics();
    await page.evaluate(() => {
      for (const [name, value] of Object.entries({
        "--space-6": "20px", "--text-md": "15px",
        "--radius-control": "3px", "--radius-dialog": "9px",
      })) document.documentElement.style.setProperty(name, value);
      IrisMotion.openDialog("attachModal");
    });
    await page.locator("#attachModal").waitFor({ state: "visible" });
    const actual = await page.evaluate(() => {
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      return {
        inset: style("#attachModal .m-body").paddingLeft,
        fieldGap: style("#attachModal .field").marginBottom,
        controls: ["#attachModal .btn", "#attachRename", "#attachDest"].map((selector) => {
          const { fontSize, borderTopLeftRadius } = style(selector);
          return [fontSize, borderTopLeftRadius];
        }),
        dialogRadius: style("#attachModal .modal").borderTopLeftRadius,
      };
    });
    assert.deepEqual(actual, { inset: "20px", fieldGap: "20px",
      controls: [["15px", "3px"], ["15px", "3px"], ["15px", "3px"]], dialogRadius: "9px" });
    assert.deepEqual(await editorMetrics(), before);
    await page.locator("#attachModal .m-foot [data-close]").click();
  });

  test(`settings section spacing follows the shared scale through tab changes: ${variant.name}`, options, async (t) => {
    const { page } = await pageFor(t, variant);
    await openSettings(page);
    await page.locator("#settingsModal").waitFor({ state: "visible" });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--space-6", "23px");
      document.documentElement.style.setProperty("--space-7", "29px");
    });
    assert.equal(await page.locator('[data-i18n="settings.uploadedFonts"]').evaluate((node) => getComputedStyle(node).marginTop), "23px");
    const section = variant.viewport.width <= 700 ? '.set-accordion-trigger[data-set="compile"]' : "#settingsTabCompile";
    await page.locator(section).click();
    assert.equal(await page.locator("#compilePreset").evaluate((node) => getComputedStyle(node.closest(".field")).marginTop), "23px");
    assert.equal(await page.locator("#compileMainPath").evaluate((node) => getComputedStyle(node.closest(".field")).marginTop), "29px");
    const close = page.locator("#settingsModal .m-foot [data-close]");
    await close.focus();
    await page.keyboard.press("Enter");
    await page.locator("#settingsModal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement.id), "btnSettings");
  });
}

for (const language of ["en", "it"]) {
  test(`pinned toolbar controls fit at compact boundary widths: ${language}`, options, async (t) => {
    const { page } = await pageFor(t, { viewport: { width: 1440, height: 900 }, language });
    for (const width of language === "en" ? [375, 575] : [375, 590]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator(".topbar").evaluate(async (node) => {
        // Let viewport-dependent transitions finish before measuring their endpoint.
        getComputedStyle(node).width;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished));
      });
      const clipped = await page.evaluate(() => {
        const failures = [];
        for (const selector of [".topbar", ".statusbar"]) {
          const parent = document.querySelector(selector).getBoundingClientRect();
          for (const control of document.querySelectorAll(`${selector} button`)) {
            const box = control.getBoundingClientRect();
            if (!box.width || !box.height || control.closest("[hidden],.tbar-scroll,.sb-info")) continue;
            if (box.left < Math.max(0, parent.left) - .5 || box.right > Math.min(innerWidth, parent.right) + .5) {
              failures.push({ id: control.id || control.dataset.workspace, left: box.left, right: box.right });
            }
          }
        }
        return failures;
      });
      assert.deepEqual(clipped, [], `${language} at ${width}px: account, sharing and pinned actions stay inside the viewport`);
    }
  });
}

for (const format of ["png", "svg"]) {
  test(`rendered ${format} build dimensions agree with the zoom label`, options, async (t) => {
    const { page } = await pageFor(t, variants[0]);
    await page.evaluate(async (format) => {
      let base64;
      if (format === "png") {
        const canvas = document.createElement("canvas");
        canvas.width = 100; canvas.height = 200;
        canvas.getContext("2d").fillRect(0, 0, 100, 200);
        base64 = canvas.toDataURL("image/png").split(",")[1];
      } else {
        base64 = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="200"><rect width="100" height="200"/></svg>');
      }
      await IrisApp.showBuildOutput({
        build: { id: "33333333-3333-4333-8333-333333333333", status: "succeeded", format,
          mainPath: "main.ly", displayName: `score.${format}`, compiler: "lilypond", projectType: "lilypond",
          durationMs: 100, exitCode: 0, completedAt: "2026-09-13T10:00:00Z", warnings: [], errors: [] },
        artifacts: [{ name: `score.${format}`, mimeType: format === "png" ? "image/png" : "image/svg+xml", base64 }],
      });
      // Use the real zoom controls: reach the 10% floor, then advance to 100%.
      for (let i = 0; i < 30; i++) document.querySelector("#zOut").click();
      for (let i = 0; i < 9; i++) document.querySelector("#zIn").click();
    }, format);
    const size = () => page.locator(".image-preview img").evaluate((image) => {
      const box = image.getBoundingClientRect();
      return { natural: [image.naturalWidth, image.naturalHeight], rendered: [box.width, box.height],
        label: document.querySelector("#zVal").textContent };
    });
    assert.deepEqual(await size(), { natural: [100, 200], rendered: [100, 200], label: "100%" });
    await page.locator("#zIn").click();
    assert.deepEqual(await size(), { natural: [100, 200], rendered: [110, 220], label: "110%" });
  });
}

for (const variant of variants) {
  test(`form controls share a row size and text role: ${variant.name}`, options, async (t) => {
    const { page } = await pageFor(t, variant);
    await page.evaluate(() => IrisMotion.openDialog("adminProjectModal"));
    const actual = await page.evaluate(() => {
      const fields = ["adminProjectAddIdentifier", "adminProjectAddRole", "adminProjectAddBtn"].map((id) => {
        const node = document.getElementById(id), style = getComputedStyle(node);
        return { height: node.getBoundingClientRect().height, font: style.fontFamily, size: style.fontSize };
      });
      return { heights: fields.map((field) => field.height), sameFont: fields.every((field) => field.font === fields[0].font),
        sameSize: fields.every((field) => field.size === fields[0].size) };
    });
    assert.equal(new Set(actual.heights).size, 1, `fields and action align: ${JSON.stringify(actual)}`);
    assert.equal(actual.sameFont, true, "a username field and a role select use the same interface font");
    assert.equal(actual.sameSize, true);
    await page.evaluate(() => IrisMotion.closeDialog("adminProjectModal"));
    await openSettings(page);
    await page.locator(variant.viewport.width <= 700 ? '.set-accordion-trigger[data-set="editor"]' : "#settingsTabEditor").click();
    assert.equal(await page.locator("#completionTex").evaluate((node) => getComputedStyle(node).fontFamily.includes("IBM Plex Mono")), true,
      "source-code fields retain their code font");
  });

  test(`card and modal contents align with their actions: ${variant.name}`, options, async (t) => {
    const { page } = await pageFor(t, variant, { openProject: false,
      projects: [{ id: projectId, name: "Aligned project", role: "owner", projectType: "latex", updatedAt: "2026-09-13T10:00:00Z" }] });
    const card = await page.evaluate(() => [".pcard-open", ".pcard-tools"].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return [style.paddingLeft, style.paddingRight];
    }));
    assert.deepEqual(card[0], card[1], "source summary and card actions use the same horizontal inset");
    await page.evaluate((id) => IrisProjects.openProject(id), projectId);
    await openSettings(page);
    const modal = await page.evaluate(() => [".settings-modal .m-head", "#settingsPanelFonts", ".settings-modal .m-foot"].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return [style.paddingLeft, style.paddingRight];
    }));
    assert.deepEqual(modal[0], modal[1]);
    assert.deepEqual(modal[1], modal[2]);
  });

  test(`admin focus remains distinct from validation errors: ${variant.name}`, options, async (t) => {
    const { page } = await pageFor(t, variant, { openProject: false });
    await page.locator("#pkAdmin").click();
    await page.waitForFunction(() => document.activeElement.id === "adminUsersTitle");
    await page.keyboard.press("Tab");
    for (const selector of ["#adminSearch", ".admin-filters select"]) {
      const control = page.locator(selector).first();
      await control.focus();
      await control.evaluate(async (node) => {
        getComputedStyle(node).outlineWidth;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
      });
      const normal = await control.evaluate((node) => {
        const style = getComputedStyle(node);
        return { visible: node.matches(":focus-visible"), width: parseFloat(style.outlineWidth), color: style.outlineColor };
      });
      assert.equal(normal.visible, true);
      assert.ok(normal.width >= 2, `${selector} has a visible keyboard outline: ${JSON.stringify(normal)}`);
      const invalid = await control.evaluate((node) => {
        node.setAttribute("aria-invalid", "true");
        const style = getComputedStyle(node);
        return { outline: style.outlineColor, border: style.borderTopColor, width: parseFloat(style.outlineWidth) };
      });
      assert.equal(invalid.outline, normal.color);
      assert.ok(invalid.width >= 2);
      assert.notEqual(invalid.outline, invalid.border, "focus and validation remain separate indicators");
    }
  });

  test(`status and retry occupy an ordinary flow row: ${variant.name}`, options, async (t) => {
    const { page } = await pageFor(t, variant, { openProject: false });
    await page.locator("#pkAdmin").click();
    const result = await page.evaluate(() => {
      const status = document.querySelector("#adminStatusMsg"), retry = document.querySelector("#adminStatusRetry");
      status.textContent = "A long recoverable error message that needs to wrap without overlapping its retry control.";
      retry.hidden = false;
      const a = status.getBoundingClientRect(), b = retry.getBoundingClientRect();
      return { margins: [getComputedStyle(status).marginTop, getComputedStyle(retry).marginTop],
        separate: a.right <= b.left + 1 || a.bottom <= b.top + 1 };
    });
    assert.ok(result.margins.every((value) => parseFloat(value) >= 0), JSON.stringify(result));
    assert.equal(result.separate, true);
    await surfaceFits(page, "#adminScreen .picker-wrap");
  });
}

for (const language of ["en", "it"]) {
  test(`touch workspace controls have reachable 44px targets: ${language}`, options, async (t) => {
    const { page } = await pageFor(t, { viewport: { width: 375, height: 844 }, language, touch: true });
    assert.equal(await page.evaluate(() => matchMedia("(any-pointer:coarse)").matches), true);
    const failures = [];
    const measure = async (selector) => failures.push(...await page.locator(selector).evaluateAll((nodes) => nodes.flatMap((node) => {
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || node.closest("[hidden]")) return [];
      return box.width < 44 || box.height < 44 ? [{ id: node.id || node.className, width: box.width, height: box.height }] : [];
    })));
    await measure(".topbar button,.statusbar button,#ftabs [role=tab],#ftabs button");
    await page.locator("#btnCompile").scrollIntoViewIfNeeded();
    for (const selector of ["#userChip", "#btnShareProject"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 375, `${selector} stays pinned and visible`);
    }
    await page.locator("#btnSidebar").click();
    await measure(".side-tab,.side .iconbtn,#tree .node,#tree .node-act");
    await page.locator("#btnSidebar").click();
    await page.locator("#btnFind").click();
    await measure("#findBar button,#findBar input");
    await surfaceFits(page, "#findBar");
    await page.locator("#findClose").click();
    await page.locator('[data-workspace="preview"]').click();
    await measure(".pvbar button");
    assert.deepEqual(failures, [], "touch controls use at least 44px in both dimensions");
  });
}

const referenceFile = { id: "references", type: "file", name: "references.bib", path: "references.bib",
  kind: "bib", content: "@article{known, title={A known reference}}\n" };

for (const language of ["en", "it"]) {
  test(`touch close buttons remain hittable with six open files: ${language}`, options, async (t) => {
    const extraFiles = Array.from({ length: 4 }, (_, index) => ({ id: `chapter-${index}`, type: "file",
      name: `chapter-${index}.tex`, path: `chapter-${index}.tex`, kind: "tex", content: "Chapter\n" }));
    const { page } = await pageFor(t, { viewport: { width: 375, height: 844 }, language, touch: true }, { extraFiles });
    const closeButtons = page.locator("#ftabs .ftab .x");
    assert.equal(await closeButtons.count(), 6);
    const failures = [];
    for (let index = 0; index < 6; index++) {
      const button = closeButtons.nth(index);
      await button.scrollIntoViewIfNeeded();
      const result = await button.evaluate((node) => {
        const box = node.getBoundingClientRect(), parent = node.closest(".ftab").getBoundingClientRect();
        const hits = [box.left + 2, box.left + box.width / 2, box.right - 2].every((x) => {
          const target = document.elementFromPoint(x, box.top + box.height / 2);
          return target === node || node.contains(target);
        });
        return { hits, contained: box.left >= parent.left && box.right <= parent.right, width: box.width, height: box.height };
      });
      if (!result.hits || !result.contained || result.width < 44 || result.height < 44) failures.push({ index, ...result });
    }
    assert.deepEqual(failures, [], "each close target belongs to its own tab, including its edges");
  });

  test(`touch outline, notices, menus and bibliography navigation use full targets: ${language}`, options, async (t) => {
    const { page, fixture } = await pageFor(t, { viewport: { width: 375, height: 844 }, language, touch: true },
      { extraFiles: [referenceFile], documentSource: "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nText\n\\end{document}" });
    const sizes = [];
    const measure = async (selector) => sizes.push(...await page.locator(selector).evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { name: node.id || node.className || node.tagName, width: box.width, height: box.height };
    })));
    await page.locator("#btnSidebar").click();
    await page.locator("#sideTabOutline").click();
    await page.locator("#outline .ol-item").first().waitFor({ state: "visible" });
    await measure("#outline .ol-item");
    await page.locator("#btnSidebar").click();
    await page.locator('[data-workspace="preview"]').click();
    send(fixture, { t: "build", projectId, buildId: "newer-build", status: "succeeded", by: "Ada" });
    await page.locator("#pvNewer").waitFor({ state: "visible" });
    await measure("#pvNewerDismiss");
    await page.locator("#pvNewerDismiss").click();
    await page.locator("#userChip").click();
    await page.locator("#userMenu").waitFor({ state: "visible" });
    await measure("#userMenu .mi:not([hidden])");
    await page.locator("#userChip").click();
    await page.locator('[data-workspace="editor"]').click();
    await page.getByRole("tab", { name: "references.bib", exact: true }).click();
    await page.locator("#bibliographyPanel").waitFor({ state: "visible" });
    await measure("#bibliographyTabs button,#bibliographyFilters>summary");
    assert.deepEqual(sizes.filter((item) => item.width < 44 || item.height < 44), [], "navigation and disclosures are touch controls too");
  });

  test(`status action focus is inside the touch scroller: ${language}`, options, async (t) => {
    const { page } = await pageFor(t, { viewport: { width: 375, height: 844 }, language, touch: true });
    await page.keyboard.press("Tab");
    await page.locator("#btnSettings").focus();
    await page.locator("#btnSettings").scrollIntoViewIfNeeded();
    const visible = await page.locator("#btnSettings").evaluate((node) => {
      const box = node.getBoundingClientRect(), clip = node.closest(".sb-actions").getBoundingClientRect();
      const style = getComputedStyle(node), extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      return node.matches(":focus-visible") && box.top - extent >= clip.top && box.bottom + extent <= clip.bottom
        && box.left - extent >= clip.left && box.right + extent <= clip.right;
    });
    assert.equal(visible, true, "all four outline strokes remain inside the scroll clip");
  });
}

test("bibliography native-field input aligns with its action", options, async (t) => {
  const { page } = await pageFor(t, variants[0], { extraFiles: [referenceFile] });
  await page.getByRole("tab", { name: "references.bib", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#bibliographyAdd").disabled);
  await page.locator("#bibliographyAdd").click();
  await page.locator("#bibliographyFormMore>summary").click();
  const pair = await page.evaluate(() => ["bibliographyFormNativeName", "bibliographyFormAddField"].map((id) => {
    const box = document.getElementById(id).getBoundingClientRect();
    return [box.top, box.height];
  }));
  assert.deepEqual(pair[0], pair[1]);
});
