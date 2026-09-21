const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { serverFixture } = require("./server-fixture.cjs");

// Real shipped HTML, modules, app and EditorView. Only HTTP/WS data is controlled.
async function languageBrowser(t, { beforeNavigate } = {}) {
  assert.ok(process.env.TEST_DATABASE_URL, "requires the disposable database driver");
  const { baseUrl } = await serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../../public") });
  const browser = await chromium.launch({ headless: true, timeout: 10000,
    ...(process.env.IRIS_BROWSER_EXECUTABLE ? { executablePath: process.env.IRIS_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
  t.after(() => browser.close());
  t.diagnostic(`Browser ${browser.version()}`);
  return async function pageFor(t, files, activeId = files[0].id) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(5000);
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource:")) errors.push(m.text()); });
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url());
      const responses = {
        "/api/config": { auth: { ssoEnabled: false } },
        "/api/auth/session": { user: { id: "language-user", username: "tester", name: "Tester", role: "admin", authSource: "local" } },
        "/api/projects": { projects: [] },
        "/api/project-templates": { templates: { latex: [], lilypond: [] } },
      };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(responses[url.pathname] || {}) });
    });
    await page.routeWebSocket("**/*", socket => {
      socket.onMessage(raw => {
        const m = JSON.parse(raw);
        if (m.t === "open") socket.send(JSON.stringify({ t: "unavailable", fileId: m.fileId }));
      });
      socket.send(JSON.stringify({ t: "ready", sessionId: "language-test" }));
    });
    if (beforeNavigate) await beforeNavigate(page);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(async ({ files, activeId }) => {
      await Promise.all([IrisEditor.ready, IrisI18n.ready]);
      await IrisI18n.setLanguage("en");
      await IrisApp.load({ id: "language-project", language: "en", role: "owner", revision: 1, projectType: "latex",
        activeId, openTabs: files.map(f => f.id), project: { name: "Languages", nodes: files },
        assets: {}, fonts: [], autoSave: false, autoSaveDelay: 600, engine: "pdflatex" });
      await IrisMotion.openProject();
      IrisMotion.setActiveSurface("app");
    }, { files, activeId });
    return page;
  };
}

async function readySyntax(page) {
  assert.equal(await page.evaluate(() => typeof IrisEditor.syntaxSnapshot), "function", "the mounted editor exposes its syntax owner");
  await page.waitForFunction(() => IrisEditor.syntaxSnapshot?.()?.status === "ready"
    && IrisEditor.syntaxSnapshot().revision === IrisEditor.snapshot().revision);
  return page.evaluate(() => IrisEditor.syntaxSnapshot());
}

module.exports = { languageBrowser, readySyntax };
