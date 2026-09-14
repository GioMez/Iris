const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
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

async function pageFor(t, variant, { openProject = true, authenticated = true, projects = [], extraFiles = [], documentSource = source, sourceMapping = true } = {}) {
  const context = await browser.newContext({ viewport: variant.viewport, deviceScaleFactor: variant.scale || 1,
    hasTouch: !!variant.touch, reducedMotion: variant.motion || "reduce", colorScheme: variant.theme || "dark" });
  if (variant.layout) await context.addInitScript((layout) => localStorage.setItem("iris_layout", JSON.stringify(layout)), variant.layout);
  if (variant.storedTheme !== undefined) await context.addInitScript((value) => localStorage.setItem("iris_theme", value), variant.storedTheme);
  if (variant.blockedStorage) await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Fixture storage blocked", "SecurityError"); } });
  });
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
    lilypondArgs: "", lilypondFormat: "pdf", sourceMapping,
    compileProfile: { mode: "quick", steps: [{ tool: "[engine]", args: ["[main]"] }] } };
  const fixture = { versions: [], socket: null, detail: null, compile: null, compileRequests: [], responses: {},
    holdCompile() {
      const gate = deferred();
      gates.add(gate);
      this.compile = gate.promise;
      return gate;
    },
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
      if (url.pathname === "/iris-theme.js") {
        const response = await route.fetch();
        return await route.fulfill({ response, body: `${await response.text()}\nwindow.themeAtHead = { body: !!document.body, app: typeof window.IrisApp, theme: document.documentElement.dataset.theme, scheme: document.documentElement.style.colorScheme };` });
      }
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
      if (route.request().method() === "POST" && url.pathname === `/api/projects/${projectId}/compile` && fixture.compile) {
        const request = JSON.parse(route.request().postData());
        fixture.compileRequests.push(request);
        const response = await bounded(() => fixture.compile, "held compilation", 10000);
        return await json(route, { revision: request.baseRevision + 1, data: request.data, ...response.body }, response.status || 200);
      }
      const responseKey = `${route.request().method()} ${url.pathname}`;
      if (Object.hasOwn(fixture.responses, responseKey)) {
        const response = fixture.responses[responseKey];
        return await json(route, response.body, response.status || 200);
      }
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

test("color roles propagate to switches, actions, scrollbars and collaboration fallbacks", options, async (t) => {
  const { page, fixture } = await pageFor(t, variants[0]);
  await page.evaluate(() => document.documentElement.style.setProperty("--switch-track", "rgb(11, 22, 33)"));
  assert.equal(await page.locator(".switch-wrap:not(.on) .sw").first().evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(11, 22, 33)");
  await page.evaluate(() => {
    for (const name of ["switch-thumb", "on-accent", "scrollbar-thumb", "peer-fallback", "region-fallback"]) {
      document.documentElement.style.setProperty(`--${name}`, "rgb(11, 22, 33)");
    }
  });
  assert.equal(await page.locator(".switch-wrap:not(.on) .sw").first().evaluate((node) => getComputedStyle(node, "::after").backgroundColor), "rgb(11, 22, 33)");
  assert.equal(await page.locator("#btnCompile").evaluate((node) => getComputedStyle(node).color), "rgb(11, 22, 33)");
  assert.equal(await page.locator(".cm-scroller").evaluate((node) => getComputedStyle(node, "::-webkit-scrollbar-thumb").backgroundColor), "rgb(11, 22, 33)");
  send(fixture, { t: "peers", fileId, peers: [{ ...peer, color: null }] });
  await page.locator('.cm-iris-peer-mark[title="Ada"]').waitFor({ state: "attached" });
  assert.equal(await page.locator('.cm-iris-peer-mark[title="Ada"]').evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(11, 22, 33)");
  assert.equal(await page.locator("#stPeers .peer-dot").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(11, 22, 33)");
  await page.evaluate(() => IrisEditor.setSharedRegion({ from: 0, to: 10 }));
  assert.match(await page.locator(".cm-iris-peer-region").first().evaluate((node) => getComputedStyle(node).boxShadow), /rgb\(11, 22, 33\)/);
  send(fixture, { t: "peers", fileId, peers: [peer] });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.cm-iris-peer-mark[title="Ada"]')).backgroundColor === "rgb(158, 206, 106)");
});

for (const theme of ["dark", "light"]) {
test(`computed ${theme} contrast covers syntax selections, filled actions, focus and switch indicators`, options, async (t) => {
  const { page, fixture } = await pageFor(t, { ...variants[0], theme }, { documentSource: "% A comment\n" + source });
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.waitForFunction(() => !!document.querySelector(".cm-selectionBackground"));
  async function measure(selected) {
    return page.evaluate((selected) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const paint = (layers) => {
        ctx.clearRect(0, 0, 1, 1);
        for (const color of layers) { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); }
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      const luminance = (rgb) => rgb.map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
        .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      const samples = [];
      const check = (name, foreground, backgrounds, minimum) => {
        const fg = paint([...backgrounds, foreground]), bg = paint(backgrounds), a = luminance(fg), b = luminance(bg);
        samples.push({ name, foreground: fg, background: bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), minimum });
      };
      const style = (selector, pseudo) => getComputedStyle(document.querySelector(selector), pseudo);
      const editor = style(".cm-host").backgroundColor;
      const selection = style(".cm-selectionBackground").backgroundColor;
      for (const selector of [".t-comment", ".t-brace", ".t-cmd", ".t-env", ".cm-content"]) {
        check(`${selector} ${selected}`, style(selector).color, [editor, selection], 4.5);
      }
      for (const selector of [".cm-iris-peer-selection", ".cm-iris-match-active"]) {
        if (!document.querySelector(selector)) continue;
        check(`${selector} muted syntax`, style(".t-comment").color,
          [editor, style(".cm-iris-peer-line").backgroundColor, style(selector).backgroundColor], 4.5);
      }
      for (const selector of ["#btnCompile", "#adminTemplateDelete"]) {
        const current = style(selector); check(selector, current.color, [current.backgroundColor], 4.5);
      }
      check("keyboard focus", style("#btnSettings").outlineColor, [style(".statusbar").backgroundColor], 3);
      const track = style(".switch-wrap:not(.on) .sw");
      check("switch thumb", style(".switch-wrap:not(.on) .sw", "::after").backgroundColor, [track.backgroundColor], 3);
      return samples;
    }, selected);
  }
  await page.locator("#btnSettings").focus();
  await page.waitForFunction(() => !document.querySelector(".cm-editor").classList.contains("cm-focused"));
  const idle = await measure("idle");
  await page.locator(".cm-content").focus();
  await page.waitForFunction(() => document.querySelector(".cm-editor").classList.contains("cm-focused"));
  const active = await measure("active");
  // A bright incoming peer is data, not a theme primitive. Its selection must
  // remain readable even when its line band lies underneath a search match.
  send(fixture, { t: "peers", fileId, peers: [{ ...peer, color: "#ffffff", anchor: 0, head: 10 }] });
  await page.locator(".cm-iris-peer-selection").waitFor({ state: "attached" });
  await page.evaluate(() => IrisEditor.highlightMatches([{ from: 0, to: 10 }], 0));
  await page.locator(".cm-iris-match-active").waitFor({ state: "attached" });
  const overlays = await measure("overlays");
  const samples = [...idle, ...active, ...overlays];
  t.diagnostic(`Computed contrast: ${JSON.stringify(samples)}`);
  assert.deepEqual(samples.filter((sample) => sample.ratio < sample.minimum), []);
  assert.equal(await page.locator(".cm-editor").evaluate((node) => node.getRootNode() === document), true,
    "the mounted CodeMirror editor inherits document tokens rather than an unstyled shadow root");
});

}

async function selectFile(page, id) {
  await page.locator("#ftabs").getByRole("tab", { name: id === "draft" ? "draft.txt" : "main.tex", exact: true }).click();
  await page.waitForFunction((id) => IrisCollab.fileId() === (id === "draft" ? null : id)
    && IrisCollab.status() === (id === "draft" ? "off" : "live"), id);
}

for (const theme of ["dark", "light"]) {
  test(`final review: selected history, build and sharing metadata contrast / ${theme}`, options, async (t) => {
    const { page, fixture } = await pageFor(t, { ...variants[0], theme });
    const samples = [];
    async function measure(state, selectors) {
      for (const selector of selectors) {
        await page.locator(selector).first().waitFor({ state: "visible" });
        samples.push({ state, selector, text: await page.locator(selector).first().textContent(),
          ...await renderedContrast(page, selector) });
      }
    }
    // Real history controller rows: all reason badges and the author/date leaves.
    fixture.versions = ["initial", "manual", "compile", "rollback"].map((reason, i) => ({
      ...version, id: `22222222-2222-4222-8222-22222222222${i}`, reason,
    }));
    for (const item of fixture.versions) fixture.responses[`GET /api/projects/${projectId}/files/${fileId}/versions/${item.id}`] = {
      body: { ...item, content: source },
    };
    await openHistory(page, variants[0]);
    for (const reason of ["initial", "manual", "compile", "rollback"]) {
      await page.locator(`.ver-item:has(.reason-${reason})`).click();
      await page.locator(`.ver-item.on .reason-${reason}`).waitFor({ state: "visible" });
      await page.mouse.move(0, 0);
      await measure(`history selected ${reason}`, [".ver-item.on .ver-who", ".ver-item.on .ver-when", ".ver-item.on .ver-reason"]);
    }
    assert.match(await page.locator(".ver-item.on .ver-who").textContent(), /Browser fixture/);
    await page.locator("#versionsModal [data-close]").click();

    const builds = ["failed", "succeeded"].map((status, i) => ({ id: `22222222-2222-4222-8222-22222222223${i}`,
      status, format: "pdf", compiler: "pdflatex", projectType: "latex", author: "Metadata Author",
      createdAt: version.createdAt, completedAt: version.createdAt, mainPath: "main.tex", warnings: [], errors: [] }));
    fixture.responses[`GET /api/projects/${projectId}/builds`] = { body: { builds, nextOffset: null } };
    for (const build of builds) fixture.responses[`GET /api/projects/${projectId}/builds/${build.id}`] = { body: { build, files: [] } };
    await page.locator("#btnBuilds").click();
    await page.locator(".build-item.on").waitFor({ state: "visible" });
    assert.equal(await page.locator(".build-item.on .build-who").textContent(), "Metadata Author · pdflatex · PDF");
    await page.mouse.move(0, 0);
    await measure("build selected", [".build-item.on .build-who", ".build-item.on .build-when"]);
    await page.locator(".build-item:not(.on) .build-select").check();
    await page.mouse.move(0, 0);
    await measure("build checked", [".build-item.checked:not(.on) .build-who", ".build-item.checked:not(.on) .build-when"]);
    await page.locator(".build-item.checked:not(.on)").hover();
    await measure("build checked hover", [".build-item.checked:not(.on) .build-who"]);
    await page.locator("#buildsModal [data-close]").first().click();

    fixture.responses[`GET /api/projects/${projectId}/members`] = { body: { members: [] } };
    fixture.responses[`GET /api/projects/${projectId}/members/search`] = { body: { users: [
      { userId: "candidate", name: "Candidate User", username: "candidate", email: "candidate@example.invalid", external: true },
    ] } };
    await page.locator("#btnShareProject").click();
    await page.locator("#projectShareSearch").fill("candidate");
    await page.locator(".project-share-result").waitFor({ state: "visible" });
    await page.mouse.move(0, 0);
    await measure("sharing ordinary", [".project-share-result > b", ".project-share-result > span", ".project-share-result .project-share-external"]);
    await page.locator(".project-share-result").hover();
    await measure("sharing hover", [".project-share-result > span", ".project-share-result .project-share-external"]);
    await page.locator(".project-share-result").click();
    await page.mouse.move(0, 0);
    assert.equal(await page.locator(".project-share-result.selected").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".project-share-result.selected > span").textContent(), "@candidate · candidate@example.invalid");
    await measure("sharing selected", [".project-share-result.selected > b", ".project-share-result.selected > span", ".project-share-result.selected .project-share-external"]);
    const directory = await fs.mkdtemp(path.join(process.env.TMPDIR, `iris-final-metadata-${theme}-`));
    await fs.writeFile(path.join(directory, "contrast.json"), JSON.stringify(samples, null, 2));
    t.diagnostic(`Selected metadata ${theme}: ${JSON.stringify(samples.map(({ state, selector, ratio }) => ({ state, selector, ratio })))}`);
    t.diagnostic(`Selected metadata evidence: ${directory}`);
    assert.deepEqual(samples.filter(sample => sample.ratio < sample.minimum), []);
  });
}

// Read the mounted consumer and composite its actual ancestor backgrounds in
// paint order. In particular, a match's background can sit on a peer line.
async function renderedContrast(page, selector, { pseudo = null, shadow = false, minimum = 4.5, surrounding = false, paintProperty = "color" } = {}) {
  return page.locator(selector).first().evaluate((node, { pseudo, shadow, minimum, surrounding, paintProperty }) => {
    // CodeMirror can wrap a syntax span in a decoration span. Measure the
    // actual text leaf rather than its outer wrapper's inherited text color.
    if (!pseudo && !shadow) {
      const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
      if (text) node = text.parentElement;
    }
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const paint = (layers) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const color of layers) { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); }
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const ancestors = [];
    for (let current = node; current; current = current.parentElement) ancestors.unshift(getComputedStyle(current).backgroundColor);
    if (surrounding) ancestors.pop();
    const style = getComputedStyle(node, pseudo);
    if (pseudo === "::selection") ancestors.push(style.backgroundColor);
    const pigment = shadow ? style.boxShadow.match(/(?:rgba?|color)\([^)]*\)/)?.[0] : style[paintProperty];
    const bg = paint(ancestors), fg = paint([...ancestors, pigment]);
    const luminance = (rgb) => rgb.map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    const a = luminance(fg), b = luminance(bg);
    return { foreground: fg, background: bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), minimum,
      pigment, content: style.content, shadow: style.boxShadow, focusVisible: node.matches(":focus-visible") || !!node.querySelector(":focus-visible") };
  }, { pseudo, shadow, minimum, surrounding, paintProperty });
}

test("R10 light peer initials and marker boundaries remain readable for fallback and bright identities", options, async (t) => {
  const { page, fixture } = await pageFor(t, { ...variants[0], theme: "light" });
  const samples = [];
  for (const color of [null, "#ffffff", "#9ece6a", "#7aa2f7", "#f7768e", "#e0af68", "#bb9af7", "#2ac3de", "#ff9e64", "#b4f9f8"]) {
    const name = `Ada ${color || 'fallback'}`;
    send(fixture, { t: "peers", fileId, peers: [{ ...peer, id: name, name, color }] });
    await page.waitForFunction((name) => document.querySelector('#stPeers .peer-count')?.textContent === name, name);
    await page.locator("#stPeers .peer-dot").waitFor({ state: "visible" });
    samples.push({ color, name: "initials", ...await renderedContrast(page, "#stPeers .peer-dot") });
    samples.push({ color, name: "marker boundary", ...await renderedContrast(page, ".cm-iris-peer-mark", { shadow: true, surrounding: true, minimum: 3 }) });
    samples.push({ color, name: "badge boundary", ...await renderedContrast(page, "#stPeers .peer-dot", { shadow: true, surrounding: true, minimum: 3 }) });
  }
  t.diagnostic(`Peer indicator audit: ${JSON.stringify(samples)}`);
  assert.deepEqual(samples.filter(s => s.ratio < s.minimum), []);
});

for (const theme of ["dark", "light"]) {
test(`${theme}: editor focus paints a visible ring with at least 3:1 contrast`, options, async (t) => {
  const { page } = await pageFor(t, { ...variants[0], theme });
  await page.keyboard.press("Tab");
  await page.locator(".cm-content").focus();
  await page.waitForFunction(() => document.querySelector(".cm-content").matches(":focus-visible"));
  const measured = await renderedContrast(page, ".cm-host", { pseudo: "::after", shadow: true, minimum: 3 });
  t.diagnostic(`Editor focus: ${JSON.stringify(measured)}`);
  assert.equal(measured.focusVisible, true);
  assert.equal(measured.content, '\"\"');
  assert.notEqual(measured.shadow, "none");
  assert.ok(measured.ratio >= measured.minimum, `actual editor focus ring: ${measured.ratio}:1`);
  await page.locator("#btnSettings").focus();
  assert.equal(await page.locator(".cm-host").evaluate((node) => getComputedStyle(node, "::after").content), "none");
});

test(`${theme}: selected autocomplete source details remain readable`, options, async (t) => {
  const text = "\\label{review-label}\n\\ref{";
  const { page } = await pageFor(t, { ...variants[0], theme }, { documentSource: text });
  await page.evaluate((end) => { IrisEditor.select(end); IrisEditor.focus(); }, text.length);
  await page.keyboard.press("Control+Space");
  const selector = '.cm-tooltip-autocomplete li[aria-selected="true"] .cm-completionDetail';
  await page.locator(selector).waitFor({ state: "visible" });
  assert.equal(await page.locator(selector).textContent(), "main.tex");
  const measured = await renderedContrast(page, selector);
  t.diagnostic(`Selected completion detail: ${JSON.stringify(measured)}`);
  assert.ok(measured.ratio >= measured.minimum, `selected source path: ${measured.ratio}:1`);
});

test(`${theme}: enabled editor decorations keep text readable over a peer caret line`, options, async (t) => {
  const text = "% needle comment\n{pair}\n}\n\u00a0\nneedle\n";
  const { page, fixture } = await pageFor(t, { ...variants[0], theme }, { documentSource: text });
  const samples = [];
  async function caret(position) {
    send(fixture, { t: "peers", fileId, peers: [{ ...peer, color: "#ffffff", anchor: position, head: position }] });
    await page.waitForFunction((line) => document.querySelectorAll(".cm-content .cm-line")[line]?.classList.contains("cm-iris-peer-line"),
      text.slice(0, position).split("\n").length - 1);
    await page.evaluate((position) => { IrisEditor.select(position); IrisEditor.focus(); }, position);
  }
  await caret(0);
  await page.evaluate((last) => IrisEditor.highlightMatches([{ from: 2, to: 8 }, { from: last, to: last + 6 }], 1), text.lastIndexOf("needle"));
  await page.locator(".cm-iris-match:not(.cm-iris-match-active)").waitFor({ state: "attached" });
  samples.push({ name: "inactive match on peer line", ...await renderedContrast(page, ".cm-iris-match:not(.cm-iris-match-active)") });
  await page.evaluate(() => IrisEditor.highlightMatches([], -1));
  await caret(text.indexOf("{pair}"));
  await page.locator(".cm-matchingBracket").first().waitFor({ state: "attached" });
  samples.push({ name: "matching bracket on peer line", ...await renderedContrast(page, ".cm-matchingBracket") });
  await caret(text.indexOf("\n}\n") + 1);
  await page.locator(".cm-nonmatchingBracket").waitFor({ state: "attached" });
  samples.push({ name: "nonmatching bracket on peer line", ...await renderedContrast(page, ".cm-nonmatchingBracket") });
  await caret(text.indexOf("\u00a0"));
  samples.push({ name: "special character on peer line", ...await renderedContrast(page, ".cm-specialChar") });
  t.diagnostic(`Decoration audit: ${JSON.stringify(samples)}`);
  assert.deepEqual(samples.filter((sample) => sample.ratio < sample.minimum), []);
});

test(`${theme}: music categorization is isolated from permissions and compilation history`, options, async (t) => {
  const { page, fixture } = await pageFor(t, { ...variants[0], theme }, { openProject: false,
    projects: [{ id: projectId, name: "Role isolation", projectType: "lilypond", role: "editor", updatedAt: "2026-09-13T10:00:00Z" }],
    extraFiles: [{ id: "score", type: "file", name: "score.ly", path: "score.ly", kind: "ly", content: "{ c4 }" }] });
  await page.locator(".pcard-role.role-editor").waitFor({ state: "visible" });
  await page.evaluate((id) => IrisProjects.openProject(id), projectId);
  fixture.versions = [{ ...version, reason: "compile" }];
  await openHistory(page, variants[0]);
  await page.locator(".ver-reason.reason-compile").first().waitFor({ state: "visible" });
  await page.locator("#versionsModal [data-close]").click();
  const build = { id: version.id, status: "failed", format: "pdf", compiler: "pdflatex", projectType: "latex",
    author: "Fixture", createdAt: version.createdAt, completedAt: version.createdAt, mainPath: "main.tex", warnings: [], errors: [] };
  fixture.responses[`GET /api/projects/${projectId}/builds`] = { body: { builds: [build], nextOffset: null } };
  fixture.responses[`GET /api/projects/${projectId}/builds/${build.id}`] = { body: { build, files: [] } };
  await page.locator("#btnBuilds").click();
  await page.locator(".build-item.on").waitFor({ state: "visible" });
  const selectors = [".pcard-role.role-editor", ".ver-reason.reason-compile", ".workflow-builds", ".build-head-icon", ".build-item.on", ".build-select"];
  const read = () => page.evaluate((selectors) => selectors.map((selector) => {
    const style = getComputedStyle(document.querySelector(selector));
    return { selector, color: style.color, background: style.backgroundColor, border: style.borderTopColor, accent: style.accentColor };
  }), selectors);
  const before = await read();
  await page.evaluate(() => document.documentElement.style.setProperty("--category-music", "rgb(11, 22, 33)"));
  assert.equal(await page.locator(".fi.ly").first().evaluate((node) => getComputedStyle(node).color), "rgb(11, 22, 33)");
  const after = await read();
  t.diagnostic(`Music isolation: ${JSON.stringify({ before, after })}`);
  assert.deepEqual(after, before, "changing music category must not recolor permissions or compilation UI");
  for (const [role, selector] of [["permission-editor", ".pcard-role.role-editor"], ["history-compile", ".ver-reason.reason-compile"], ["build-accent", ".build-head-icon"]]) {
    await page.evaluate((role) => document.documentElement.style.setProperty(`--${role}`, "rgb(44, 55, 66)"), role);
    assert.equal(await page.locator(selector).first().evaluate((node) => getComputedStyle(node).color), "rgb(44, 55, 66)");
  }
});

}

for (const variant of variants) for (const theme of ["dark", "light"]) {
  test(`R10 preference, selector and retained editor: ${variant.name} / ${theme}`, options, async (t) => {
    const { page } = await pageFor(t, { ...variant, theme });
    assert.equal(await page.evaluate(() => typeof window.IrisTheme), "object", "theme API loaded");
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    await showTallOutput(page, "pdf");
    if (variant.viewport.width < 820) await page.locator('[data-workspace="editor"]').click();
    await page.evaluate(async () => {
      IrisEditor.select(2, 12); IrisEditor.focus();
      window.themeView = (await import('@codemirror/view')).EditorView.findFromDOM(document.querySelector('.cm-editor'));
      document.querySelector("#pvStage").scrollTop = 300;
      window.themeRetained = { view: window.themeView, state: window.themeView.state,
        focus: document.activeElement, project: JSON.stringify(IrisApp.serialize()),
        page: document.querySelector(".pdf-page"), scroll: document.querySelector("#pvStage").scrollTop };
    });
    await page.evaluate(() => IrisTheme.setPreference(IrisTheme.resolved() === "dark" ? "light" : "dark"));
    assert.equal(await page.evaluate(() => {
      const before = window.themeRetained;
      return before.view.dom === document.querySelector('.cm-editor') && before.state === window.themeView.state
        && before.focus === document.activeElement && before.project === JSON.stringify(IrisApp.serialize())
        && before.page === document.querySelector(".pdf-page") && before.scroll === document.querySelector("#pvStage").scrollTop;
    }), true, "theme switching retains state, focus, document and reading position");
    await openSettings(page);
    await page.locator(variant.viewport.width <= 700 ? '.set-accordion-trigger[data-set="editor"]' : '#settingsTabEditor').click();
    const select = page.getByLabel(variant.language === "it" ? "Tema" : "Theme", { exact: true });
    assert.equal(await select.getAttribute("id"), "settingsTheme");
    // Native select type-ahead works in headless macOS Chrome; Home/arrow keys
    // are handled by its OS popup and do not commit a DOM value in this harness.
    await select.focus(); await page.keyboard.press("s");
    await page.keyboard.press(variant.language === "it" ? "i" : "y");
    await page.keyboard.press("Tab");
    assert.equal(await select.inputValue(), "system");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await select.selectOption("dark");
    await page.emulateMedia({ colorScheme: "dark" }); await page.emulateMedia({ colorScheme: "light" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.evaluate(async () => { await IrisI18n.setLanguage("it"); });
    assert.equal(await page.getByLabel("Tema", { exact: true }).inputValue(), "dark");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await page.evaluate(() => IrisTheme.preference()), "dark");
  });
}

for (const initial of [
  { theme: "light", want: "light" }, { theme: "dark", want: "dark" },
  { theme: "light", storedTheme: "dark", want: "dark" }, { theme: "dark", storedTheme: "light", want: "light" },
  { theme: "light", storedTheme: "invalid", want: "light" }, { theme: "light", blockedStorage: true, want: "light" },
]) test(`R10 head initialization: ${JSON.stringify(initial)}`, options, async (t) => {
  const { page } = await pageFor(t, { ...variants[0], ...initial }, { authenticated: false, openProject: false });
  assert.deepEqual(await page.evaluate(() => window.themeAtHead), { body: false, app: "undefined", theme: initial.want, scheme: initial.want });
  await page.evaluate(() => IrisTheme.setPreference("dark"));
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.evaluate(() => IrisTheme.setPreference("system"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
});

for (const variant of variants) for (const theme of ["dark", "light"]) {
  test(`R10 rendered surfaces and branding: ${variant.name} / ${theme}`, options, async (t) => {
    const directory = await fs.mkdtemp(path.join(process.env.TMPDIR, "iris-r10-theme-"));
    t.diagnostic(`Theme screenshots and contrast: ${directory}`);
    const samples = [];
    async function capture(page, name, selectors) {
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); });
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      for (const selector of selectors) {
        const measured = await renderedContrast(page, selector);
        samples.push({ name, selector, ...measured });
      }
      await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled" });
      await fs.writeFile(path.join(directory, "contrast.json"), JSON.stringify(samples, null, 2));
    }
    const login = await pageFor(t, { ...variant, theme }, { authenticated: false, openProject: false });
    await capture(login.page, "login", [".login-sub", "#loginUser", "#loginBtn"]);
    await login.page.locator('#loginUser').fill('Selected username');
    await login.page.locator('#loginUser').evaluate(node => node.select());
    samples.push({ name: 'native selection', ...await renderedContrast(login.page, '#loginUser', { pseudo: '::selection' }) });
    samples.push({ name: 'wordmark', ...await renderedContrast(login.page, '#loginCard .brand-wordmark', { surrounding: true, paintProperty: 'backgroundColor' }) });
    assert.match(await login.page.locator('#loginCard .brand-wordmark').evaluate(n => getComputedStyle(n).maskImage), /iris_text_logo_w\.svg/);
    login.fixture.responses['POST /api/auth/login'] = { status: 401, body: { errorCode: 'NOT_AUTHENTICATED' } };
    await login.page.locator('#loginPass').fill('fixture-password');
    await login.page.locator('#loginCard').evaluate(n => n.requestSubmit());
    await login.page.locator('#loginError').waitFor({ state: 'visible' });
    await capture(login.page, 'login-error', ['#loginError']);
    const score = { id: 'score', type: 'file', name: 'score.ly', path: 'score.ly', kind: 'ly', content: '% Music comment\n\\relative c\' { c4 d e f }\n' };
    const { page, fixture } = await pageFor(t, { ...variant, theme }, { openProject: false, extraFiles: [referenceFile, score], documentSource: source + '% New line\n' });
    await capture(page, "home", ["#pickerScreen .picker-sub"]);
    await page.locator("#pkAdmin").click();
    await capture(page, "admin", ["#adminSearch", "#adminEmpty"]);
    await page.locator("#adminTabTemplates").click(); await page.locator("#adminTemplateNew").click();
    await capture(page, "admin-dialog", ["#adminTemplateTitle", "#adminTemplateContent"]);
    await page.locator("#adminTemplateCancel").click(); await page.locator("#adminBack").click();
    await page.evaluate((id) => IrisProjects.openProject(id), projectId);
    await page.waitForFunction(() => IrisCollab.status() === "live");
    await capture(page, "editor", [".cm-content", ".t-cmd", ".t-env", ".t-brace", "#btnCompile"]);
    await page.evaluate(() => IrisEditor.setDiagnostics([{ line: 1, severity: 'error', message: 'Fixture error' }, { line: 2, severity: 'warning', message: 'Fixture warning' }]));
    await capture(page, 'diagnostics', ['.cm-iris-diagnostic-mark.error', '.cm-iris-diagnostic-mark.warning']);
    await showTallOutput(page, "pdf");
    await capture(page, "preview", [".pvbar .mini"]);
    assert.equal(await page.locator(".pdf-page").first().evaluate(n => getComputedStyle(n).backgroundColor), "rgb(255, 255, 255)");
    if (variant.viewport.width < 820) await page.locator('[data-workspace="editor"]').click();
    fixture.versions = [version]; await openHistory(page, variant);
    await page.locator("#versionsDiffTab").click();
    await capture(page, "diff", ["#versionsView", '.diff-add .diff-text', '.diff-add .diff-sign']);
    await page.locator("#versionsModal [data-close]").click();
    if (variant.viewport.width < 1180 && await page.locator(".body").evaluate(n => n.classList.contains("drawer-open"))) await page.locator("#btnSidebar").click();
    await page.getByRole('tab', { name: 'score.ly', exact: true }).click();
    await capture(page, 'lilypond', ['.t-comment', '.t-cmd', '.t-brace', '.cm-content']);
    await page.getByRole("tab", { name: "references.bib", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("#bibliographyAdd").disabled);
    await capture(page, "bibliography", ["#bibliographyPanel"]);
    await openSettings(page);
    await page.locator(variant.viewport.width <= 700 ? '.set-accordion-trigger[data-set="editor"]' : '#settingsTabEditor').click();
    await capture(page, "settings", ["#settingsTheme", "#settingsPanelEditor .desc", "#settingsPanelEditor .set-row-sub"]);
    await surfaceFits(page, ".settings-modal");
    assert.deepEqual(samples.filter(sample => sample.ratio < sample.minimum), []);
  });
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
].flatMap(variant => ['dark', 'light'].map(theme => ({ ...variant, theme, name: `${variant.name} / ${theme}` })));

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
    assert.ok(await page.locator(".pcard-tools").evaluate((node) => Number(getComputedStyle(node).opacity)) >= .5,
      "card actions remain visible before hover");
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

for (const language of ["en", "it"]) {
  test(`footer preview toggle follows both panel controls and compact navigation without source mapping / ${language}`, options, async (t) => {
    const { page } = await pageFor(t, { viewport: { width: 1440, height: 900 }, language }, { sourceMapping: false });
    const footer = page.locator("#btnPreview"), toolbar = page.locator("#btnPreviewPane"), pane = page.locator("#previewPane");
    const open = language === "it" ? "Apri anteprima" : "Open preview";
    const close = language === "it" ? "Chiudi anteprima" : "Close preview";
    let queries = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname.endsWith("/navigation")) queries++; });
    const before = await page.evaluate(() => ({ text: IrisEditor.getValue(), selection: IrisEditor.selection(), activeId: IrisApp.serialize().activeId }));
    assert.equal(await pane.isVisible(), true);
    await footer.click();
    assert.equal(await pane.isVisible(), false, "footer must close the panel even without a PDF or map");
    assert.equal(await footer.getAttribute("aria-label"), open);
    assert.equal(await footer.getAttribute("aria-expanded"), "false");
    assert.equal(await toolbar.getAttribute("aria-label"), open);
    await footer.focus(); await page.keyboard.press("Enter");
    assert.equal(await pane.isVisible(), true);
    assert.equal(await footer.getAttribute("aria-label"), close);
    assert.equal(await footer.getAttribute("aria-expanded"), "true");
    await toolbar.click();
    assert.equal(await pane.isVisible(), false);
    assert.equal(await footer.getAttribute("aria-label"), open, "toolbar action updates footer state");
    await toolbar.click();
    assert.equal(await footer.getAttribute("aria-label"), close);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-workspace="editor"]').click();
    assert.equal(await footer.getAttribute("aria-label"), open);
    await footer.focus(); await page.keyboard.press("Enter");
    assert.equal(await pane.isVisible(), true, "compact toggle opens the preview workspace");
    assert.equal(await footer.getAttribute("aria-label"), close);
    await footer.click();
    assert.equal(await pane.isVisible(), false, "compact close returns to the editor");
    assert.equal(await page.locator(".cm-content").isVisible(), true);
    await page.locator('[data-workspace="preview"]').click();
    assert.equal(await footer.getAttribute("aria-label"), close, "workspace tabs update footer state");
    await page.locator('[data-workspace="editor"]').click();
    assert.equal(await footer.getAttribute("aria-label"), open);
    assert.deepEqual(await page.evaluate(() => ({ text: IrisEditor.getValue(), selection: IrisEditor.selection(), activeId: IrisApp.serialize().activeId })), before);
    assert.equal(queries, 0, "panel visibility does not issue source-map queries");
  });
}

const referenceFile = { id: "references", type: "file", name: "references.bib", path: "references.bib",
  kind: "bib", content: "@article{known, title={A known reference}}\n" };

for (const theme of ["dark", "light"]) {
  test(`crowded tabs scroll their strip without clipping the editor / ${theme}`, options, async (t) => {
    const extraFiles = Array.from({ length: 8 }, (_, index) => ({ id: `chapter-${index}`, type: "file",
      name: `chapter-${index}.tex`, path: `chapter-${index}.tex`, kind: "tex", content: "Chapter\n" }));
    const { page } = await pageFor(t, { ...variants[0], viewport: { width: 1467, height: 900 }, theme }, { extraFiles });
    const geometry = () => page.evaluate(() => {
      const pane = document.querySelector(".pane.edpane"), host = document.querySelector(".cm-host");
      const gutter = document.querySelector(".cm-gutters"), strip = document.querySelector("#ftabs");
      return { outerScroll: pane.scrollLeft, paneX: pane.getBoundingClientRect().x,
        hostX: host.getBoundingClientRect().x, gutterX: gutter.getBoundingClientRect().x,
        editorScroll: document.querySelector(".cm-scroller").scrollLeft, stripScroll: strip.scrollLeft,
        stripWidth: strip.clientWidth, stripContent: strip.scrollWidth };
    });
    const initial = await geometry();
    await page.locator('#ftabs [role="tab"]').nth(3).click();
    const selected = await geometry();
    t.diagnostic(`Fourth tab geometry: ${JSON.stringify({ initial, selected })}`);
    assert.equal(selected.outerScroll, initial.outerScroll, "tab focus must not scroll the outer editor pane");
    assert.equal(selected.hostX, initial.hostX, "source host stays aligned");
    assert.equal(selected.gutterX, initial.gutterX, "line-number gutter stays aligned");
    assert.equal(selected.editorScroll, 0);
    assert.ok(selected.stripScroll > initial.stripScroll, "only the crowded strip scrolls to reveal the selected tab");
    const check = async (label) => {
      const actual = await geometry();
      assert.equal(actual.outerScroll, 0, `${label}: outer pane never scrolls`);
      assert.equal(actual.hostX, actual.paneX, `${label}: host stays aligned with its pane`);
      assert.equal(actual.gutterX, actual.paneX, `${label}: gutter is not clipped`);
    };
    const visibleTab = async (index) => {
      assert.equal(await page.locator('#ftabs [role="tab"]').nth(index).evaluate((node) => {
        const tab = node.getBoundingClientRect(), strip = node.parentElement.getBoundingClientRect();
        return tab.left >= strip.left - 1 && tab.right <= strip.right + 1;
      }), true, "the focused or selected tab is inside the strip");
    };
    await page.evaluate(() => { IrisEditor.select(2, 8); IrisEditor.focus(); });
    const caret = await page.evaluate(() => IrisEditor.selection());
    // Native sequential focus reveals an offscreen tab without activating it.
    await page.locator('#ftabs [role="tab"]').nth(8).focus();
    await page.keyboard.press("Tab"); // its close button
    await page.keyboard.press("Tab"); // the final tab
    assert.equal(await page.locator('#ftabs [role="tab"]').last().evaluate(node => node === document.activeElement), true);
    await visibleTab(9);
    await check("keyboard focus");
    assert.deepEqual(await page.evaluate(() => IrisEditor.selection()), caret, "tab focus retains the source selection");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator('#ftabs [role="tab"]').last().getAttribute("aria-selected"), "true");
    assert.equal(await page.locator(".cm-content").evaluate(node => node === document.activeElement), true);
    await visibleTab(9);
    await check("keyboard selection");
    await page.evaluate(() => { IrisEditor.select(1, 5); IrisEditor.focus(); });
    const retained = await page.evaluate(() => IrisEditor.selection());
    for (const width of [1300, 1467]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("#btnSidebar").click();
      await page.locator('#ftabs [role="tab"]').last().focus();
      await check(`resize/sidebar ${width}`);
      await visibleTab(9);
      assert.deepEqual(await page.evaluate(() => IrisEditor.selection()), retained);
    }
    // A newly reopened file must be reachable without shifting the source pane.
    await page.locator('#ftabs [role="tab"]').last().locator(".x").click();
    await page.locator('#tree .node[data-id="chapter-7"] .nm').click();
    assert.equal(await page.locator('#ftabs [role="tab"]').last().getAttribute("aria-selected"), "true");
    await visibleTab(9);
    await check("reopened file");
    // Source scrolling remains owned by CodeMirror, independently of the strip.
    await page.evaluate(() => {
      IrisEditor.load("x".repeat(400) + "\n" + "line\n".repeat(100), "tex");
      IrisEditor.select(350); IrisEditor.focus();
    });
    await page.waitForFunction(() => document.querySelector(".cm-scroller").scrollLeft > 0);
    assert.equal(await page.locator(".pane.edpane").evaluate(node => node.scrollLeft), 0);
    const end = await page.evaluate(() => IrisEditor.getValue().length);
    await page.evaluate(end => { IrisEditor.select(end); IrisEditor.focus(); }, end);
    await page.waitForFunction(() => document.querySelector(".cm-scroller").scrollTop > 0);
    assert.equal(await page.locator(".pane.edpane").evaluate(node => node.scrollTop), 0);
  });
}

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

for (const variant of [variants[0], { ...variants[1], name: "tablet / IT", viewport: { width: 1024, height: 768 } },
  { ...variants[0], name: "desktop / normal motion", motion: "no-preference" }]) {
  test(`preview pane toggles without losing width, output or editor state: ${variant.name}`, options, async (t) => {
    const { page, fixture } = await pageFor(t, variant);
    const toggle = page.locator("#btnPreviewPane");
    assert.equal(await toggle.count(), 1, "the preview control is in the persistent toolbar");
    await page.locator(".app").evaluate((node) => Promise.allSettled(node.getAnimations().map((animation) => animation.finished)));
    const text = await page.locator(".cm-content").textContent();
    const resizer = await page.locator("#rz2").boundingBox();
    await page.mouse.move(resizer.x + resizer.width / 2, resizer.y + 100);
    await page.mouse.down();
    await page.mouse.move(resizer.x + 60, resizer.y + 100);
    await page.mouse.up();
    await page.evaluate(async () => {
      await IrisApp.showBuildOutput({ build: { id: "retained-output", status: "succeeded", format: "svg", mainPath: "main.ly",
        completedAt: "2026-09-13T10:00:00Z", warnings: [], errors: [] },
      artifacts: [{ name: "score.svg", mimeType: "image/svg+xml",
        base64: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="800"><rect width="100" height="800"/></svg>') }] });
      window.retainedPreviewImage = document.querySelector(".image-preview img");
      document.querySelector("#pvStage").scrollTop = 240;
    });
    await page.waitForFunction(() => document.querySelector("#pvStage").scrollTop === 240);
    const width = (await page.locator("#previewPane").boundingBox()).width;
    const savedWidth = await page.locator(".body").evaluate((node) => node.style.getPropertyValue("--pv-w"));
    const editorWidth = (await page.locator(".edpane").boundingBox()).width;
    await toggle.click();
    await page.locator("#previewPane").waitFor({ state: "hidden" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await toggle.getAttribute("aria-label"), variant.language === "it" ? "Apri anteprima" : "Open preview");
    await page.waitForFunction((width) => document.querySelector(".edpane").getBoundingClientRect().width > width + 200, editorWidth);
    assert.equal(await page.locator("#rz2").isVisible(), false);
    send(fixture, { t: "build", projectId, buildId: "remote-while-hidden", status: "succeeded", by: "Ada" });
    await page.waitForFunction(() => !document.querySelector("#pvNewer").hidden);
    assert.equal(await page.locator("#previewPane").isVisible(), false, "a remote notification does not interrupt source editing");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await page.locator("#previewPane").waitFor({ state: "visible" });
    await page.waitForFunction((width) => document.querySelector("#previewPane").getBoundingClientRect().width === width, width);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal((await page.locator("#previewPane").boundingBox()).width, width);
    assert.equal(await page.locator(".body").evaluate((node) => node.style.getPropertyValue("--pv-w")), savedWidth);
    assert.equal(await page.locator(".cm-content").textContent(), text);
    assert.equal(await page.evaluate(() => document.querySelector(".image-preview img") === window.retainedPreviewImage), true);
    assert.ok(Math.abs(await page.locator("#pvStage").evaluate((node) => node.scrollTop) - 240) <= 1, "reading position survives hide/show");
    await toggle.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-workspace="preview"]').click();
    await page.locator("#previewPane").waitFor({ state: "visible" });
    await page.setViewportSize(variant.viewport);
    await page.locator("#previewPane").waitFor({ state: "visible" });
  });

  test(`starting compilation reopens the collapsed preview before the response: ${variant.name}`, options, async (t) => {
    const { page, fixture } = await pageFor(t, variant);
    assert.equal(await page.locator("#btnPreviewPane").count(), 1);
    await page.locator("#btnPreviewPane").click();
    const gate = fixture.holdCompile();
    await page.locator("#btnCompile").click();
    await page.waitForFunction(() => document.querySelector("#btnCompile").disabled);
    await page.locator("#previewPane").waitFor({ state: "visible" });
    assert.equal(await page.locator("#btnPreviewPane").getAttribute("aria-expanded"), "true");
    gate.resolve({ body: { success: false, log: "Controlled compiler failure", errors: ["Controlled compiler failure"], warnings: [], durationMs: 1 } });
    await page.waitForFunction(() => !document.querySelector("#btnCompile").disabled);
    assert.equal(fixture.compileRequests.length, 1);
    assert.equal(await page.locator("#previewPane").isVisible(), true, "failure diagnostics stay available after compilation");
  });
}

test("error visibility is independent of the component's display layout", options, async (t) => {
  const { page, fixture } = await pageFor(t, variants[0], { openProject: false, authenticated: false });
  await page.addStyleTag({ content: ".login-error{display:flex}" });
  assert.equal(await page.locator("#loginError").isVisible(), false, "layout rules cannot expose an inactive error");
  fixture.responses["POST /api/auth/login"] = { status: 401, body: { errorCode: "NOT_AUTHENTICATED" } };
  await page.locator("#loginUser").fill("fixture-user");
  await page.locator("#loginPass").fill("fixture-wrong-password");
  await page.locator("#loginCard").evaluate((node) => node.requestSubmit());
  await page.locator("#loginError").waitFor({ state: "visible" });
  await page.locator("#loginUser").fill("another-fixture-user");
  await page.locator("#loginError").waitFor({ state: "hidden" });
});

test("dialog closure follows the rendered animation rather than a fixed timer", options, async (t) => {
  const { page } = await pageFor(t, { ...variants[0], motion: "no-preference" });
  const completed = await page.evaluate(async () => {
    const dialog = document.querySelector("#attachModal");
    dialog.style.animationDuration = "400ms";
    IrisMotion.openDialog(dialog);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const closing = IrisMotion.closeDialog(dialog);
    const animation = dialog.getAnimations()[0];
    if (!animation) throw new Error("the fixture must exercise an actual closing animation");
    let finished = false;
    animation.finished.then(() => { finished = true; }, () => {});
    await closing;
    return finished;
  });
  assert.equal(completed, true, "the dialog remains mounted until its actual exit animation completes");
  await page.locator("#attachModal").waitFor({ state: "hidden" });
});

test("reduced motion suppresses the active compilation spinner", options, async (t) => {
  const { page, fixture } = await pageFor(t, variants[0]);
  await page.evaluate(() => IrisMotion.openProject());
  assert.equal(await page.locator(".app").evaluate((node) => node.getAnimations().length), 0);
  const gate = fixture.holdCompile();
  await page.locator("#btnCompile").click();
  await page.locator("#compiling").waitFor({ state: "visible" });
  const animations = await page.locator("#compiling .spinner").evaluate((node) => node.getAnimations().length);
  gate.resolve({ body: { success: false, log: "Controlled completion", errors: [], warnings: [], durationMs: 1 } });
  await page.waitForFunction(() => !document.querySelector("#btnCompile").disabled);
  assert.equal(animations, 0, "a visible progress indication does not require animation when motion is reduced");
});

test("a refused compile request leaves a visible unlocated error diagnostic", options, async (t) => {
  const { page, fixture } = await pageFor(t, variants[0]);
  const gate = fixture.holdCompile();
  await page.locator("#btnCompile").click();
  gate.resolve({ status: 503, body: { errorCode: "COMPILE_SERVER_BUSY" } });
  const diagnostic = page.locator("#diagnosticsList .diagnostic-item.error");
  await diagnostic.waitFor({ state: "visible" });
  assert.equal(await diagnostic.locator(".diagnostic-message").textContent(), "The server is running as many compilations as it can. Try again shortly.");
  assert.equal(await diagnostic.isDisabled(), true, "an unlocated failure must not fabricate a source jump");
  assert.equal(await page.locator(".cm-iris-diagnostic-mark").count(), 0);
});

test("failed admin loading and a successful empty retry have distinct visible states", options, async (t) => {
  const { page, fixture } = await pageFor(t, variants[0], { openProject: false });
  fixture.responses["GET /api/admin/users"] = { status: 503, body: { errorCode: "NOT_FOUND" } };
  await page.locator("#pkAdmin").click();
  await page.locator("#adminStatusRetry").waitFor({ state: "visible" });
  assert.equal(await page.locator("#adminEmpty").isVisible(), false);
  assert.equal(await page.locator("#adminStatusMsg").getAttribute("role"), "alert");
  fixture.responses["GET /api/admin/users"] = { body: { users: [] } };
  await page.locator("#adminStatusRetry").click();
  await page.locator("#adminEmpty").waitFor({ state: "visible" });
  assert.equal(await page.locator("#adminStatusRetry").isVisible(), false);
  assert.equal(await page.locator("#adminStatusMsg").getAttribute("role"), "status");
});

test("new-project fields return after the rename dialog hides them", options, async (t) => {
  const { page } = await pageFor(t, variants[0], { openProject: false,
    projects: [{ id: projectId, name: "Fixture project", role: "owner", projectType: "latex", updatedAt: "2026-09-13T10:00:00Z" }] });
  await page.locator("#pkNew").click();
  await page.locator("#projTemplateField").waitFor({ state: "visible" });
  await page.evaluate(() => IrisMotion.closeDialog("projModal"));
  await page.locator('.pcard [data-act="rename"]').click();
  await page.locator("#projModal").waitFor({ state: "visible" });
  assert.equal(await page.locator("#projTemplateField").isVisible(), false);
  assert.equal(await page.locator("#projTypeField").isVisible(), false);
  await page.evaluate(() => IrisMotion.closeDialog("projModal"));
  await page.locator("#pkNew").click();
  await page.locator("#projTemplateField").waitFor({ state: "visible" });
  assert.equal(await page.locator("#projTypeField").isVisible(), true);
});

for (const savedSidebar of [false, true]) {
  test(`both collapsed panels retain a usable editor across tablet widths (saved sidebar: ${savedSidebar})`, options, async (t) => {
    const { page } = await pageFor(t, { ...variants[0], ...(savedSidebar ? { layout: { sideCollapsed: true } } : {}) });
    if (!savedSidebar) await page.locator("#btnSidebar").click();
    await page.locator("#btnPreviewPane").click();
    const widths = [];
    for (const width of [1181, 1180, 1024, 821]) {
      await page.setViewportSize({ width, height: 900 });
      widths.push({ viewport: width, editor: (await page.locator(".edpane").boundingBox()).width });
    }
    assert.ok(widths.every((item) => item.editor > 300), JSON.stringify(widths));
  });
}

test("pane disclosures announce their actual initial state after project entry", options, async (t) => {
  const { page } = await pageFor(t, variants[0]);
  assert.equal(await page.locator("#previewPane").isVisible(), true);
  assert.equal(await page.locator("#btnPreviewPane").getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#btnSidebar").getAttribute("aria-expanded"), "true");
});

test("preview toggle hands focus to compact navigation when it disappears", options, async (t) => {
  const { page } = await pageFor(t, { ...variants[0], viewport: { width: 821, height: 900 } });
  await page.locator("#btnPreviewPane").focus();
  await page.setViewportSize({ width: 820, height: 900 });
  await page.locator("#btnPreviewPane").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#workspaceSwitch [aria-selected="true"]')), true);
});

async function showTallOutput(page, format) {
  await page.evaluate(async (format) => {
    let bytes;
    if (format === "pdf") {
      const stream = "0 0 100 100 re 0.5 g f\n";
      const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
        ...Array(3).fill("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 1800] /Resources << >> /Contents 6 0 R >>"),
        `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
      const xref = pdf.length;
      pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
      bytes = `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    } else bytes = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1800"><rect width="600" height="1800"/></svg>';
    await IrisApp.showBuildOutput({ build: { id: "tall-output", status: "succeeded", format, mainPath: "main.tex", warnings: [], errors: [] },
      artifacts: [{ name: `tall.${format}`, mimeType: format === "pdf" ? "application/pdf" : "image/svg+xml", base64: btoa(bytes) }] });
  }, format);
}

for (const format of ["svg", "pdf"]) {
  test(`normal-motion ${format} reopening after a hidden resize preserves the reading anchor`, options, async (t) => {
    const { page } = await pageFor(t, { ...variants[0], motion: "no-preference" });
    await page.locator(".app").evaluate((node) => Promise.allSettled(node.getAnimations().map((animation) => animation.finished)));
    await showTallOutput(page, format);
    await page.locator("#pvStage").evaluate((node) => { node.scrollTop = 500; });
    const anchor = () => page.evaluate(() => {
      const stage = document.querySelector("#pvStage"), first = document.querySelector("#pvPages>div");
      return (stage.scrollTop + parseFloat(getComputedStyle(stage).paddingTop) - first.offsetTop) / first.offsetHeight;
    });
    const before = await anchor();
    await page.locator("#btnPreviewPane").click();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.locator("#btnPreviewPane").click();
    await page.locator(".body").evaluate((node) => Promise.allSettled(node.getAnimations().map((animation) => animation.finished)));
    assert.ok(Math.abs(await anchor() - before) < .005, "refitting must not adopt an intermediate clamped scroll position");
  });
}

test("same-width PDF reveal retains its pages and canvases", options, async (t) => {
  const { page } = await pageFor(t, variants[0]);
  await showTallOutput(page, "pdf");
  await page.evaluate(() => { window.savedPdfPage = document.querySelector(".pdf-page"); window.savedPdfCanvas = window.savedPdfPage.querySelector("canvas"); });
  await page.locator("#btnPreviewPane").click();
  await page.locator("#btnPreviewPane").click();
  await page.locator("#previewPane").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => document.querySelector(".pdf-page") === window.savedPdfPage
    && document.querySelector(".pdf-page canvas") === window.savedPdfCanvas), true);
});
