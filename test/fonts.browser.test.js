const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { observeFonts } = require("./helpers/font-browser.cjs");

test("all declared interface faces load from actual local HTTP with zero external requests", { skip: process.env.IRIS_TEST_BROWSER !== "1", timeout: 60000 }, async t => {
  assert.ok(process.env.TEST_DATABASE_URL, "requires disposable database");
  const { baseUrl } = await require("./helpers/server-fixture.cjs").serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public") });
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ headless: true, timeout: 10000,
    ...(process.env.IRIS_BROWSER_EXECUTABLE ? { executablePath: process.env.IRIS_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
  t.after(() => browser.close());
  const page = await browser.newPage(), external = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== baseUrl) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const verifyFonts = observeFonts(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert.deepEqual(external, [], "no external stylesheet or font request, including blocked requests");
  const evidence = await verifyFonts(baseUrl);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  t.diagnostic(`Chrome ${browser.version()}: ${evidence.faces.length} loaded FontFaces, ${evidence.http.length} local font responses, 11 selected family/style/weight combinations`);
});
