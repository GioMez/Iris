const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { uuidv7 } = require("../src/ids");
const { serverFixture } = require("./helpers/server-fixture.cjs");

const enabled = process.env.IRIS_TEST_BROWSER === "1";
const options = { skip: !enabled, timeout: 20000 };
let browser;

async function bounded(work, label, ms = 5000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Browser deadline: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test.before(async (t) => {
  if (!enabled) return;
  assert.ok(process.env.TEST_DATABASE_URL, "requires isolated PostgreSQL");
  browser = await chromium.launch({ headless: true, channel: "chrome", timeout: 10000 });
  t.after(() => bounded(() => browser.close(), "browser close", 10000));
  t.diagnostic(`Real browser: ${browser.version()}`);
});

async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => bounded(() => context.close(), "context close"));
  const f = await serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public") });
  const user = (await f.pool.query(`INSERT INTO users (id, username, email, display_name, system_role)
    VALUES ($1, 'browser', 'browser@example.test', 'Security Browser', 'regular') RETURNING *`, [uuidv7()])).rows[0];
  const token = f.cookieFor(user).slice("iris_session=".length);
  await context.addCookies([{ name: "iris_session", value: token, url: f.baseUrl, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  return { ...f, context, page };
}

async function foreignPage(t, f) {
  const sockets = new Set();
  const server = http.createServer((_req, res) => res.writeHead(200, { "Content-Type": "text/html" })
    .end("<!doctype html><title>Same-site foreign origin security probe</title>"));
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  t.after(() => bounded(() => {
    sockets.forEach((socket) => socket.destroy());
    return new Promise((resolve) => server.close(resolve));
  }, "foreign server close"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(origin, f.baseUrl);
  assert.equal((await f.page.goto(origin)).status(), 200);
  return origin;
}

test("real same-origin IrisNet JSON and no-body commands work with browser-generated metadata", options, async (t) => {
  const f = await fixture(t);
  const seen = [];
  f.server.on("request", (req, res) => {
    if (req.method !== "POST") return;
    res.once("finish", () => seen.push({ path: req.url, origin: req.headers.origin,
      site: req.headers["sec-fetch-site"], type: req.headers["content-type"], status: res.statusCode }));
  });
  assert.equal((await f.page.goto(f.baseUrl)).status(), 200, "actual Iris document and assets");
  await f.page.waitForFunction(() => typeof window.IrisNet?.request === "function");
  const created = await bounded(() => f.page.evaluate(() => IrisNet.request("/api/projects", {
    method: "POST", body: JSON.stringify({ name: "Browser legitimate project" }),
  })), "IrisNet create");
  assert.equal((await f.pool.query("SELECT name FROM projects WHERE id = $1", [created.project.id])).rows[0].name,
    "Browser legitimate project");
  assert.deepEqual(await bounded(() => f.page.evaluate(() => IrisNet.request("/api/auth/logout", { method: "POST" })), "IrisNet logout"), { ok: true });
  assert.deepEqual(seen, [
    { path: "/api/projects", origin: f.baseUrl, site: "same-origin", type: "application/json", status: 201 },
    { path: "/api/auth/logout", origin: f.baseUrl, site: "same-origin", type: "application/json", status: 200 },
  ]);
  t.diagnostic(JSON.stringify(seen));
});

test("real same-site foreign-port no-cors write carries a valid cookie but is refused before PostgreSQL mutation", options, async (t) => {
  const f = await fixture(t);
  const foreign = await foreignPage(t, f);
  let observed;
  const response = new Promise((resolve) => f.server.on("request", (req, res) => {
    if (req.url !== "/api/projects" || req.method !== "POST") return;
    observed = { origin: req.headers.origin, referer: req.headers.referer,
      site: req.headers["sec-fetch-site"], cookie: !!req.headers.cookie, type: req.headers["content-type"] };
    res.once("finish", () => resolve(res.statusCode));
  }));
  const opaque = await bounded(() => f.page.evaluate(async (base) => {
    const res = await fetch(`${base}/api/projects`, { method: "POST", mode: "no-cors", credentials: "include",
      headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ name: "Browser cross-origin project" }) });
    return res.type;
  }, f.baseUrl), "cross-origin fetch");
  assert.equal(opaque, "opaque", "browser SOP hides the response but must not be confused with server refusal");
  assert.deepEqual(observed, { origin: foreign, referer: `${foreign}/`, site: "same-site", cookie: true, type: "text/plain" });
  const actual = { status: await bounded(() => response, "server response"),
    projects: (await f.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n,
    audits: (await f.pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n };
  t.diagnostic(JSON.stringify({ observed, actual }));
  assert.deepEqual(actual, { status: 403, projects: 0, audits: 0 });
});

test("real same-site foreign-port WebSocket cannot turn its browser cookie into a collaboration session", options, async (t) => {
  const f = await fixture(t);
  const foreign = await foreignPage(t, f);
  let observed;
  f.server.on("upgrade", (req) => {
    observed = { origin: req.headers.origin, cookie: !!req.headers.cookie };
  });
  // The browser's open event is the observable admission result. The protocol
  // companion asserts exact HTTP 403 and zero DB queries on refused handshakes.
  const result = await bounded(() => f.page.evaluate((base) => new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http:", "ws:")}/api/collab`);
    const timer = setTimeout(() => { ws.close(); resolve("deadline"); }, 3000);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve("opened"); };
    ws.onerror = () => { clearTimeout(timer); ws.close(); resolve("refused"); };
  }), f.baseUrl), "browser WS");
  const sessionsAtObservation = f.app.collabSessions.size;
  assert.deepEqual(observed, { origin: foreign, cookie: true });
  t.diagnostic(JSON.stringify({ observed, result, sessionsAtObservation }));
  assert.equal(result, "refused");
});
