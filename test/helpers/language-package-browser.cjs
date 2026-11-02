// Executed in a child of the fresh-install test. Windows must unload argon2's
// native library before npm ci replaces node_modules or the archive is removed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
test("extracted production browser runtime", { timeout: 30000 }, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, "requires the disposable session database");
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const root = path.resolve(__dirname, "../.."), baseUrl = `http://127.0.0.1:${port}`;
  // Real require.main startup using only extracted production dependencies.
  // Ignore bootstrap stdout: it contains disposable initial-admin credentials.
  const app = spawn(process.execPath, [path.join(root, "src/server.js")], { cwd: root, windowsHide: true, stdio: "ignore",
    env: { ...process.env, BIND_ADDRESS: "127.0.0.1", PORT: String(port), PUBLIC_DIR: path.join(root, "public"), DATA_DIR: path.join(root, "owned-app-data") } });
  let launchError;
  app.once("error", e => { launchError = e; });
  const closed = new Promise(resolve => app.once("close", resolve));
  t.after(async () => {
    if (app.exitCode === null) app.kill("SIGTERM");
    let timer;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { app.kill("SIGKILL"); reject(new Error("extracted server stop deadline")); }, 5000); })]); }
    finally { clearTimeout(timer); }
  });
  const deadline = Date.now() + 15000;
  while (true) {
    if (launchError) throw launchError;
    assert.equal(app.exitCode, null, "extracted server must remain running");
    const response = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "extracted server must start with production dependencies");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  // Playwright is test apparatus, explicitly supplied by the parent. All Iris
  // application dependencies resolve from the extracted production install.
  const { chromium } = require(process.env.IRIS_HP_PLAYWRIGHT);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.IRIS_BROWSER_EXECUTABLE, timeout: 10000 });
  t.after(() => browser.close());
  const page = await browser.newPage(), failed = [], external = [], assets = [];
  const verifyFonts = require("./font-browser.cjs").observeFonts(page);
  page.on("pageerror", e => failed.push(e.message));
  page.on("response", r => {
    if (!new URL(r.url()).pathname.startsWith("/api/")) { assets.push({ url: r.url(), status: r.status() }); if (r.status() >= 400) failed.push(r.url()); }
  });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl) { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const fonts = await verifyFonts(baseUrl);
  const outlines = await page.evaluate(async () => {
    await IrisEditor.ready;
    const { analyze } = await import("/iris-language-service.mjs");
    // Large inputs require the actually shipped Worker in this production-only
    // installation. No import map/dev dependency/network fallback is available.
    return Promise.all([analyze("tex", "\\section{Package}\n" + "text ".repeat(10000)),
      analyze("ly", "\\score { c4 }\n" + "% comment\n".repeat(5000))].map(async p => {
      const result = await p;
      if (result.status !== "ready") throw new Error("Packaged Worker unavailable");
      return result.data.outline.map(s => s.title);
    }));
  });
  assert.deepEqual(outlines, [["Package"], ["Score 1"]]); assert.deepEqual(failed, []);
  console.log("HP08_PACKAGE " + JSON.stringify({ startup: "node src/server.js (require.main)", browser: browser.version(), outlines, external, assets, fonts }));
  await browser.close();
});
