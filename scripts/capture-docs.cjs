#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomBytes, createHash } = require("node:crypto");
const { parseArgs } = require("node:util");
const { workspace, postgres, run, launch, freePort, until, operationSignal } = require("./lib/disposable.cjs");
const { withBrowser } = require("./lib/browser.cjs");
const projects = require("./fixtures/docs-demo.cjs");
const root = path.resolve(__dirname, "..");
const help = `Usage: node scripts/capture-docs.cjs --output DIR [--pg-bin DIR] [--browser-executable PATH]

Capture the shipped UI with original synthetic projects, real PostgreSQL and
native PDF builds. Requires npm ci, an unprivileged POSIX user, PostgreSQL 18+
tools, pdflatex (geometry/booktabs), LilyPond 2.26.0 and installed Chrome.
--output DIR              Existing image directory; replaces only the four named
                          demo PNGs and capture.json. No application data retained.
--pg-bin DIR              PostgreSQL tools (default: pg_config --bindir).
--browser-executable PATH Chromium executable (default: installed Chrome channel).
--help                    Show help without starting services.

Creates a disposable cluster, credentials, storage and browser context. Ignores
ambient application configuration and .env. No engine, VM or external database.
Fixture: scripts/fixtures/docs-demo.cjs. Capture viewport: 1600x1000, DPR 1.
Fonts load through the shipped page's external font stylesheets; fallback is
reported. Output includes compiler/browser versions and PNG hashes. Reproduction
preserves the journey, not byte-identical timestamps, fonts or PDF rendering.
`;
async function main() {
  const { values } = parseArgs({ options: { help: { type: "boolean" }, ...Object.fromEntries(["output", "pg-bin", "browser-executable"].map((key) => [key, { type: "string" }])) } });
  if (values.help) return console.log(help);
  if (!values.output) throw new Error("--output is required; see --help");
  const output = await fs.realpath(values.output);
  assert.ok((await fs.stat(output)).isDirectory());
  const work = await workspace("iris-docs-");
  try {
    const pg = await postgres(work, values["pg-bin"]), port = await freePort();
    const versions = { node: process.version };
    for (const [key, command] of [["postgres", pg.tool("psql")], ["pdflatex", "pdflatex"], ["lilypond", "lilypond"]]) {
      versions[key] = (await run(command, ["--version"], { env: work.env, quiet: true })).stdout.toString().split(/\r?\n/)[0];
    }
    const data = path.join(work.root, "data"), password = randomBytes(24).toString("hex");
    await run(pg.tool("psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-c", `CREATE ROLE iris LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`], { env: pg.env, quiet: true });
    await run(pg.tool("psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE iris OWNER iris"], { env: pg.env, quiet: true });
    const app = launch(process.execPath, [path.join(root, "src/server.js")], { cwd: work.cwd, quiet: true, timeout: 180000, env: {
      ...work.env, DB_HOST: "127.0.0.1", DB_PORT: String(pg.port), DB_NAME: "iris", DB_USER: "iris", DB_PASSWORD: password,
      IRIS_SECRET: randomBytes(32).toString("hex"), PORT: String(port), BIND_ADDRESS: "127.0.0.1", DATA_DIR: data,
      PUBLIC_DIR: path.join(root, "public"), TEMPLATE_DIR: path.join(data, "templates"), TEX_PATH_LOCKED: "true", LILYPOND_PATH_LOCKED: "true",
    } });
    work.cleanups.push(() => app.stop());
    const base = `http://127.0.0.1:${port}`;
    await until(async () => { try { return (await fetch(`${base}/api/health`, { signal: operationSignal(1000) })).ok; } catch { return false; } }, "demo readiness");
    let cookie = "";
    const request = async (route, body, method = "POST", status = 200) => {
      const response = await fetch(base + route, { method, signal: operationSignal(60000), headers: { origin: base, cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      return result;
    };
    const initial = app.output().match(/Password: ([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(initial);
    const account = (await request("/api/auth/login", { username: "admin", password: initial })).user;
    await request("/api/auth/password", { currentPassword: initial, newPassword: randomBytes(24).toString("hex") });
    await request(`/api/admin/users/${account.id || account.sub}`, { name: "Demo administrator", email: "admin@example.test" }, "PATCH");
    for (const [username, name, role] of [["alex", "Alex North", "regular"], ["sam", "Sam River", "external"]]) {
      await request("/api/admin/users", { username, name, email: `${username}@example.test`, role }, "POST", 201);
    }
    const records = [];
    for (const fixture of projects) {
      const made = await request("/api/projects", { name: fixture.name, data: { projectType: fixture.type, language: "en", sourceMapping: true, project: { nodes: fixture.nodes } } }, "POST", 201);
      records.push({ ...fixture, id: made.project.id });
    }
    await withBrowser(work, values["browser-executable"] ? { executablePath: values["browser-executable"] } : { channel: "chrome" }, async (browser) => {
      versions.chromium = browser.version();
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, reducedMotion: "reduce", locale: "en-GB", timezoneId: "UTC", colorScheme: "dark" });
      await context.addCookies([{ name: "iris_session", value: cookie.slice("iris_session=".length), url: base }]);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const errors = [], externalFailures = [], captures = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (req) => { if (!req.url().startsWith(base)) externalFailures.push({ url: req.url(), error: req.failure()?.errorText }); });
      await page.goto(base, { waitUntil: "networkidle" });
      const capture = async (name) => {
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(1595, 995);
        await page.screenshot({ path: path.join(output, name), animations: "disabled" });
        const bytes = await fs.readFile(path.join(output, name));
        captures.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        console.log(`Captured ${name}: ${bytes.length} bytes`);
      };
      for (const record of records) {
        await page.evaluate(async ({ id, type }) => { IrisTheme.setPreference(type === "latex" ? "light" : "dark"); await IrisEditor.ready; await IrisProjects.openProject(id); }, record);
        await page.waitForFunction(() => IrisCollab.status() === "live");
        const compiled = page.waitForResponse((response) => response.url() === `${base}/api/projects/${record.id}/compile` && response.request().method() === "POST");
        await page.locator("#btnCompile").click();
        const build = await (await compiled).json(); assert.equal(build.success, true, build.log);
        await page.waitForFunction((id) => IrisApp.currentBuildId() === id && document.querySelector(".pdf-page canvas")?.width > 0, build.buildId);
        await page.waitForFunction(() => !document.querySelector("#btnCompile").disabled);
        await capture(`${record.type}-workspace.png`);
      }
      await page.locator("#tree .node .nm").filter({ hasText: "references.bib" }).click();
      await page.locator("#btnPreview").click();
      await page.locator("#bibliographyTable").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelectorAll("#bibliographyRows tr").length === 3);
      await capture("bibliography.png");
      await page.evaluate(() => IrisAdmin.open());
      await page.locator("#adminUsersPanel").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelectorAll("#adminRows tr").length === 3);
      await capture("administration.png");
      const fonts = await page.evaluate(() => ({ plexSans: document.fonts.check('14px "IBM Plex Sans"'), plexMono: document.fonts.check('14px "IBM Plex Mono"') }));
      await page.evaluate(() => IrisCollab.disconnect());
      assert.deepEqual(errors, [], "shipped UI runtime errors");
      const evidence = { version: require("../package.json").version, schema: 2, viewport: { width: 1600, height: 1000, dpr: 1 }, fixture: "scripts/fixtures/docs-demo.cjs", versions, fonts, externalFailures, captures };
      await fs.writeFile(path.join(output, "capture.json"), JSON.stringify(evidence, null, 2) + "\n");
      console.log(JSON.stringify(evidence, null, 2));
    });
  } finally { await work.close(); }
}
main().catch((error) => { console.error(error.stack); process.exitCode ||= 1; });
