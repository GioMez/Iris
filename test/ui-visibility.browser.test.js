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

async function pageFor(t, variant, { openProject = true } = {}) {
  const context = await browser.newContext({ viewport: variant.viewport, reducedMotion: "reduce" });
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
    activeId: fileId, openTabs: [fileId, "draft"],
    project: { name: "Visibility test", nodes: [
      { id: fileId, type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: source },
      { id: "draft", type: "file", name: "draft.txt", path: "draft.txt", kind: "tex", content: "Local draft\n" },
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
        "/api/auth/session": { user: { id: "browser-admin", username: "browser-test", name: "Browser Admin",
          email: "browser@example.invalid", role: "admin", authSource: "local",
          canChangePassword: true, passwordChangeRequired: false } },
        "/api/projects": { projects: [] },
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
          role: "owner", version: 0, doc: source }));
        else if (!["project", "close", "presence"].includes(message.t)) errors.push(`Unexpected WS frame: ${message.t}`);
      } catch (error) { if (!closing) errors.push(error.message); }
    });
    socket.send(JSON.stringify({ t: "ready", sessionId: "browser-session", color: "#7dcfff" }));
  });
  const response = await page.goto(base.href, { waitUntil: "networkidle", timeout: 10000 });
  assert.equal(response.status(), 200, "fixture serves the actual Iris document");
  await page.waitForFunction(() => document.documentElement.classList.contains("iris-authed"));
  await bounded(() => page.evaluate(async (language) => {
    await Promise.all([IrisEditor.ready, IrisI18n.ready]);
    await IrisI18n.setLanguage(language);
  }, variant.language), "application ready");
  if (openProject) {
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
