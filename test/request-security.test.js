const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const argon2 = require("argon2");
const { uuidv7 } = require("../src/ids");
const { createZip } = require("../src/zip");
const { requestOrigin, isRequestOriginAllowed } = require("../src/request-security");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");

const options = { skip: !connectionString, timeout: 20000 };
const forbidden = { status: 403, code: "REQUEST_ORIGIN_FORBIDDEN" };
const unsupported = { status: 415, code: "REQUEST_CONTENT_TYPE_UNSUPPORTED" };
const ok = { status: 200, code: null };
const oauthEnv = {
  OAUTH_CLIENT_ID: "request-security", OAUTH_CLIENT_SECRET: "synthetic-client-secret",
  OAUTH_ISSUER_URL: "https://idp.example.test",
  OAUTH_AUTHORIZATION_URL: "https://idp.example.test/authorize",
  OAUTH_TOKEN_URL: "https://idp.example.test/token",
  OAUTH_USERINFO_URL: "https://idp.example.test/userinfo",
  OAUTH_AUTO_REGISTER: "true", OAUTH_APPROVAL_REQUIRED: "false",
};

// A flat header array goes over real HTTP unchanged, including empty fields and
// duplicate singletons which Node otherwise coalesces in IncomingMessage.headers.
function request(f, { pathname = "/api/auth/logout", method = "POST", headers = [],
  body, upgrade = false, omitHost = false, agent = false } = {}) {
  const fields = [...headers];
  const has = (name) => fields.some((value, i) => i % 2 === 0 && value.toLowerCase() === name);
  if (!omitHost && !has("host")) fields.unshift("Host", new URL(f.baseUrl).host);
  if (body !== undefined && !has("content-length") && !has("transfer-encoding")) {
    fields.push("Content-Length", String(Buffer.byteLength(body)));
  }
  if (!upgrade && !has("connection")) fields.push("Connection", agent ? "keep-alive" : "close");
  if (upgrade) fields.push("Connection", "Upgrade", "Upgrade", "websocket",
    "Sec-WebSocket-Version", "13", "Sec-WebSocket-Key", Buffer.from("0123456789abcdef").toString("base64"));
  return new Promise((resolve, reject) => {
    // Node adds Transfer-Encoding:chunked to empty POSTs with flat raw header
    // arrays unless defaults are disabled. Let each test choose its wire framing.
    const req = http.request(f.baseUrl, { path: pathname, method: upgrade ? "GET" : method,
      headers: fields, setHost: false, setDefaultHeaders: false, agent });
    const timer = setTimeout(() => req.destroy(new Error(`HTTP response deadline: ${method} ${pathname}`)), 4000);
    const finish = (result) => { clearTimeout(timer); resolve(result); };
    req.on("error", (error) => { clearTimeout(timer); reject(error); });
    req.on("upgrade", (res, socket) => {
      const sessions = f.app.collabSessions.size;
      socket.destroy();
      finish({ status: res.statusCode, code: null, upgraded: true, sessions, headers: res.headers });
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", (error) => { clearTimeout(timer); req.destroy(); reject(error); });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch {}
        finish({ status: res.statusCode, code: json?.errorCode || null, json, text,
          headers: res.headers, upgraded: false, sessions: f.app.collabSessions.size, socket: req.socket });
      });
    });
    req.end(body);
  });
}

const outcome = ({ status, code }) => ({ status, code });
async function matrix(t, f, cases) {
  const actual = [], expected = [];
  for (const [name, input, want] of cases) {
    const response = await request(f, input);
    const refusal = want === forbidden || want === unsupported;
    actual.push({ name, ...outcome(response), ...(refusal ? { cookies: response.headers["set-cookie"]?.length || 0 } : {}) });
    expected.push({ name, ...want, ...(refusal ? { cookies: 0 } : {}) });
  }
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, expected);
}
async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Did not settle: ${label}`);
    await delay(10);
  }
}
const health = async (f) => (await request(f, { pathname: "/api/health", method: "GET" })).json;
async function user(f, username = "owner", role = "admin", passwordHash = null) {
  return (await f.pool.query(`INSERT INTO users (id, username, email, display_name, system_role, password_hash)
    VALUES ($1, $2, $3, $2, $4, $5) RETURNING *`,
  [uuidv7(), username, `${username}@example.test`, role, passwordHash])).rows[0];
}
async function project(f, cookie) {
  const response = await request(f, { pathname: "/api/projects", headers: ["Cookie", cookie,
    "Content-Type", "application/json"], body: JSON.stringify({ name: "Security fixture", data: {
    project: { nodes: [{ id: uuidv7(), type: "file", name: "main.tex", content: "\\documentclass{article}\n" }] },
  } }) });
  assert.equal(response.status, 201, response.text);
  return response.json.project.id;
}
function observe(f) {
  const effects = { queries: 0, transactions: 0, verifies: 0, filesystem: 0, children: 0 };
  f.hooks.beforeQuery = () => { effects.queries++; };
  f.hooks.beforeClientQuery = () => { effects.transactions++; };
  f.hooks.afterVerify = () => { effects.verifies++; };
  for (const name of ["beforeWriteFile", "beforeMkdir", "beforeRename", "beforeRm", "beforeUnlink"]) {
    f.hooks[name] = () => { effects.filesystem++; };
  }
  // Keep the actual child-process boundary, replacing only the external compiler.
  f.hooks.spawn = () => { effects.children++; return { command: process.execPath, args: ["-e", "process.exit(0)"] }; };
  return effects;
}
const noEffects = { queries: 0, transactions: 0, verifies: 0, filesystem: 0, children: 0 };

test("direct TLS origin derivation uses socket encryption, including a proxy's missing-proto fallback", () => {
  const req = { socket: { encrypted: true }, rawHeaders: ["Host", "iris.example:443", "Origin", "https://iris.example"] };
  assert.equal(requestOrigin(req), "https://iris.example");
  assert.equal(isRequestOriginAllowed(req), true);
  req.socket.encrypted = false;
  assert.equal(requestOrigin(req), "http://iris.example:443");
  assert.equal(isRequestOriginAllowed(req), false);
  req.socket.encrypted = true;
  req.rawHeaders.push("X-Forwarded-Host", "public.test:443");
  assert.equal(requestOrigin(req, { trustProxy: true }), "https://public.test");
  assert.equal(requestOrigin(req, { trustProxy: false }), "https://iris.example");
});

test("Origin accepts native clients and equivalent HTTP(S)/IPv6 origins", options, async (t) => {
  const f = await serverFixture(t);
  await matrix(t, f, [
    ["metadata-free native", {}, ok],
    ["actual loopback origin", { headers: ["Origin", f.baseUrl] }, ok],
    ["host case and default port", { headers: ["Host", "IRIS.EXAMPLE:80", "Origin", "http://iris.example"] }, ok],
    ["Origin scheme/host case", { headers: ["Host", "iris.example", "Origin", "HTTP://IRIS.EXAMPLE:80"] }, ok],
    ["bracketed IPv6", { headers: ["Host", "[::1]:80", "Origin", "http://[::1]"] }, ok],
    ["Origin takes precedence over foreign fallbacks", { headers: ["Origin", f.baseUrl,
      "Referer", "https://foreign.test/page", "Sec-Fetch-Site", "cross-site"] }, ok],
  ]);
});

test("terminal-dot IPv4 authorities are invalid while DNS trailing dots remain valid and distinct", options, async (t) => {
  const f = await serverFixture(t, { TRUST_PROXY: "true" });
  await matrix(t, f, [
    ["canonical IPv4", { headers: ["Host", "127.0.0.1", "Origin", "http://127.0.0.1"] }, ok],
    ["IPv4 Origin terminal dot", { headers: ["Host", "127.0.0.1", "Origin", "http://127.0.0.1."] }, forbidden],
    ["IPv4 Host terminal dot (reversed fields)", { headers: ["Host", "127.0.0.1.", "Origin", "http://127.0.0.1"] }, { status: 400, code: null }],
    ["matching IPv4 Referer terminal dot", { headers: ["Host", "127.0.0.1", "Referer", "http://127.0.0.1./page?q=1"] }, forbidden],
    ["trusted IPv4 forwarded host terminal dot with port", { headers: ["X-Forwarded-Host", "127.0.0.1.:80", "Origin", "http://127.0.0.1"] }, forbidden],
    ["short IPv4 spelling with terminal dot", { headers: ["Host", "127.0.0.1", "Origin", "http://127.1."] }, forbidden],
    ["matching DNS trailing dots", { headers: ["Host", "iris.example.:80", "Origin", "http://IRIS.EXAMPLE."] }, ok],
    ["DNS dotted Origin differs", { headers: ["Host", "iris.example", "Origin", "http://iris.example."] }, forbidden],
    ["DNS dotted Host differs", { headers: ["Host", "iris.example.", "Origin", "http://iris.example"] }, forbidden],
  ]);
});

test("Origin refuses foreign, opaque, repaired and ambiguous values before logout cookie changes", options, async (t) => {
  const f = await serverFixture(t);
  const origins = [
    ["sibling host", "http://sibling.iris.example"], ["wrong scheme", "https://iris.example"],
    ["wrong port", "http://iris.example:81"], ["trailing dot", "http://iris.example."],
    ["empty", ""], ["opaque null", "null"], ["credentials", "http://user@iris.example"],
    ["trailing slash", "http://iris.example/"], ["path", "http://iris.example/path"],
    ["query", "http://iris.example?x=1"], ["fragment", "http://iris.example#x"],
    ["backslash repair", "http://iris.example\\path"], ["escaped host", "http://%69ris.example"],
    ["internal whitespace", "http://iris. example"], ["list", "http://iris.example, http://foreign.test"],
    ["internal tab repair", "http://iris.exa\tmple"],
    ["websocket scheme", "ws://iris.example"], ["empty port", "http://iris.example:"],
    ["unbracketed IPv6", "http://::1"],
  ];
  const cases = origins.map(([name, origin]) => [name, { headers: ["Host", "iris.example", "Origin", origin,
    "Referer", "http://iris.example/safe", "Sec-Fetch-Site", "same-origin"] }, forbidden]);
  cases.push(["identical raw Origin fields", { headers: ["Origin", f.baseUrl, "oRiGiN", f.baseUrl] }, forbidden]);
  await matrix(t, f, cases);
});

test("absent Origin accepts only affirmative browser fallbacks or metadata-free native requests", options, async (t) => {
  const f = await serverFixture(t);
  await matrix(t, f, [
    ["Fetch same-origin alone", { headers: ["Sec-Fetch-Site", "same-origin"] }, ok],
    ["Referer with path query and legitimate comma", { headers: ["Referer", `${f.baseUrl}/a,b?q=c,d`] }, ok],
    ["Referer plus none", { headers: ["Referer", `${f.baseUrl}/page`, "Sec-Fetch-Site", "none"] }, ok],
    ["Referer plus same-origin", { headers: ["Referer", `${f.baseUrl}/page`, "Sec-Fetch-Site", "same-origin"] }, ok],
  ]);
});

test("absent Origin refuses misleading Fetch Metadata and foreign or malformed Referer", options, async (t) => {
  const f = await serverFixture(t);
  await matrix(t, f, [
    ...["same-site", "cross-site", "none", "", "same-origin, same-origin", "garbage"].map((value) =>
      [`Fetch ${JSON.stringify(value)} alone`, { headers: ["Sec-Fetch-Site", value] }, forbidden]),
    ["same-site cannot be rescued by Referer", { headers: ["Referer", `${f.baseUrl}/page`, "Sec-Fetch-Site", "same-site"] }, forbidden],
    ["cross-site cannot be rescued by Referer", { headers: ["Referer", `${f.baseUrl}/page`, "Sec-Fetch-Site", "cross-site"] }, forbidden],
    ["foreign Referer cannot be rescued by Fetch", { headers: ["Referer", "http://foreign.test/page", "Sec-Fetch-Site", "same-origin"] }, forbidden],
    ...["", "/relative", `${f.baseUrl.replace("://", "://user@")}/page`, `${f.baseUrl}\\page`,
      `${f.baseUrl.replace("127", "%31%32%37")}/page`].map((value) => [
      `malformed Referer ${JSON.stringify(value)}`, { headers: ["Referer", value, "Sec-Fetch-Site", "same-origin"] }, forbidden]),
    ["duplicate raw Referer", { headers: ["Referer", `${f.baseUrl}/page`, "Referer", `${f.baseUrl}/page`] }, forbidden],
    ["duplicate raw Fetch Metadata", { headers: ["Sec-Fetch-Site", "same-origin", "Sec-Fetch-Site", "same-origin"] }, forbidden],
  ]);
});

test("strict Host admission rejects URL repairs and duplicate or missing authority with 400", options, async (t) => {
  const f = await serverFixture(t);
  const hosts = ["", "http://iris.example", "user@iris.example", "iris.example/path", "iris.example?x=1",
    "iris.example#x", "iris.example\\path", "%69ris.example", "iris.example:", "iris.example:65536",
    "iris.example,evil.test", "iris.exa\tmple", "::1", "["];
  const bad = { status: 400, code: null };
  await matrix(t, f, [
    ...hosts.map((host) => [JSON.stringify(host), { pathname: "/api/health", method: "GET", headers: ["Host", host] }, bad]),
    ["missing Host", { pathname: "/api/health", method: "GET", omitHost: true }, bad],
    ["duplicate raw Host", { headers: ["Host", "iris.example", "Host", "iris.example"] }, bad],
    ["duplicate Host on WS", { pathname: "/api/collab", upgrade: true, headers: ["Host", "iris.example", "Host", "iris.example"] }, bad],
  ]);
});

test("automatic origin uses actual Host/socket, ignoring COOKIE_SECURE and absolute request-target authority", options, async (t) => {
  const f = await serverFixture(t, { COOKIE_SECURE: "true" });
  await matrix(t, f, [
    ["secure cookie does not imply HTTPS", { headers: ["Origin", f.baseUrl] }, ok],
    ["HTTPS Origin on HTTP socket", { headers: ["Origin", f.baseUrl.replace("http:", "https:")] }, forbidden],
    ["absolute target does not replace Host", { pathname: "https://foreign.test/api/auth/logout", headers: ["Origin", f.baseUrl] }, ok],
    ["absolute target cannot authorize its own origin", { pathname: "https://foreign.test/api/auth/logout", headers: ["Origin", "https://foreign.test"] }, forbidden],
  ]);
});

test("APP_BASE_URL pins origin independently of Host and forwarding while preserving the callback base path", options, async (t) => {
  const f = await serverFixture(t, { ...oauthEnv, APP_BASE_URL: "https://Iris.Example:443/base/", TRUST_PROXY: "true" });
  const spoof = ["Host", "internal.test:3000", "X-Forwarded-Host", "foreign.test", "X-Forwarded-Proto", "http"];
  const start = await request(f, { pathname: "/api/auth/sso/start", method: "GET", headers: spoof });
  assert.equal(start.status, 303);
  const redirect = new URL(start.headers.location).searchParams.get("redirect_uri");
  assert.equal(new URL(redirect).origin, "https://iris.example");
  assert.equal(new URL(redirect).pathname, "/base/api/auth/sso/callback");
  await matrix(t, f, [
    ["public pin", { headers: [...spoof, "Origin", "https://iris.example"] }, ok],
    ["internal Host is not the pin", { headers: [...spoof, "Origin", "http://internal.test:3000"] }, forbidden],
    ["forwarding is not the pin", { headers: [...spoof, "Origin", "http://foreign.test"] }, forbidden],
    ["pin wins over ambiguous forwarding", { headers: ["Origin", "https://iris.example", "X-Forwarded-Host", "a.test,b.test"] }, ok],
    ["WS uses pin then reaches auth", { pathname: "/api/collab", upgrade: true, headers: [...spoof, "Origin", "https://iris.example"] }, { status: 401, code: null }],
    ["WS cannot substitute internal Host for pin", { pathname: "/api/collab", upgrade: true, headers: [...spoof, "Origin", "http://internal.test:3000"] }, { status: 403, code: null }],
  ]);
});

test("untrusted forwarding cannot influence either request admission or OAuth callback URLs", options, async (t) => {
  const f = await serverFixture(t, { ...oauthEnv, TRUST_PROXY: "false" });
  const spoof = ["X-Forwarded-Host", "foreign.test", "X-Forwarded-Proto", "https"];
  const start = await request(f, { pathname: "/api/auth/sso/start", method: "GET", headers: spoof });
  assert.equal(start.status, 303);
  const redirect = new URL(start.headers.location).searchParams.get("redirect_uri");
  const results = [];
  for (const origin of [f.baseUrl, "https://foreign.test"]) results.push(outcome(await request(f, { headers: [...spoof, "Origin", origin] })));
  t.diagnostic(JSON.stringify({ redirect, results }));
  assert.deepEqual({ redirect, results }, { redirect: `${f.baseUrl}/api/auth/sso/callback`, results: [ok, forbidden] });
});

test("trusted proxy supports singular proto-only, host-only and both components with actual fallbacks", options, async (t) => {
  const f = await serverFixture(t, { ...oauthEnv, TRUST_PROXY: "true" });
  const cases = [
    ["proto only", ["X-Forwarded-Proto", "https"], f.baseUrl.replace("http:", "https:")],
    ["host only", ["X-Forwarded-Host", "public.test:8080"], "http://public.test:8080"],
    ["both", ["X-Forwarded-Host", "PUBLIC.TEST:443", "X-Forwarded-Proto", "https"], "https://public.test"],
  ];
  const actual = [], expected = [];
  for (const [name, headers, origin] of cases) {
    const start = await request(f, { pathname: "/api/auth/sso/start", method: "GET", headers });
    assert.equal(start.status, 303);
    actual.push({ name, redirectOrigin: new URL(new URL(start.headers.location).searchParams.get("redirect_uri")).origin,
      accepted: outcome(await request(f, { headers: [...headers, "Origin", origin] })),
      wrong: outcome(await request(f, { headers: [...headers, "Origin", f.baseUrl] })) });
    expected.push({ name, redirectOrigin: origin, accepted: ok, wrong: forbidden });
  }
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, expected);
});

test("trusted forwarding rejects empty, repeated, list and repaired components", options, async (t) => {
  const f = await serverFixture(t, { TRUST_PROXY: "true" });
  const bad = [
    ["empty host", ["X-Forwarded-Host", ""], f.baseUrl], ["empty proto", ["X-Forwarded-Proto", ""], f.baseUrl],
    ["host chain", ["X-Forwarded-Host", "public.test, public.test"], "http://public.test"],
    ["proto chain", ["X-Forwarded-Proto", "https, https"], f.baseUrl.replace("http:", "https:")],
    ["repeated host", ["X-Forwarded-Host", "public.test", "X-Forwarded-Host", "public.test"], "http://public.test"],
    ["repeated proto", ["X-Forwarded-Proto", "https", "X-Forwarded-Proto", "https"], f.baseUrl.replace("http:", "https:")],
    ["non-HTTP proto with native metadata", ["X-Forwarded-Proto", "ftp"], null],
    ["authority path", ["X-Forwarded-Host", "public.test/path"], "http://public.test"],
    ["authority userinfo", ["X-Forwarded-Host", "user@public.test"], "http://public.test"],
    ["escaped authority", ["X-Forwarded-Host", "%70ublic.test"], "http://public.test"],
    ["empty authority port", ["X-Forwarded-Host", "public.test:"], "http://public.test"],
  ];
  // Match the value a permissive URL parser/first-list-element implementation
  // would accept, so an unrelated origin mismatch cannot hide missing validation.
  await matrix(t, f, bad.map(([name, headers, origin]) => [name, {
    headers: [...headers, ...(origin ? ["Origin", origin] : [])],
  }, forbidden]));
});

test("nonempty invalid APP_BASE_URL fails configuration loading rather than falling back or failing a DB connection", options, async (t) => {
  const actual = [];
  const values = ["relative/path", "ftp://iris.example", "https://user:pass@iris.example", "https://iris.example?x=1",
    "https://iris.example#fragment", "https://iris.example\\base", "https://%69ris.example", "https://iris.example:",
    "https://127.0.0.1.:443/base"];
  for (const value of values) {
    let f;
    try { f = await serverFixture(t, { APP_BASE_URL: value }); }
    catch (error) {
      assert.match(error.message, /APP_BASE_URL/, "only a named configuration error counts as refusal");
      actual.push("configuration refused");
      continue;
    }
    assert.equal((await health(f)).status, "ok", "baseline acceptance must be a working handler, not a connection error");
    actual.push("accepted healthy server");
  }
  t.diagnostic(JSON.stringify(values.map((value, i) => ({ value, result: actual[i] }))));
  assert.deepEqual(actual, values.map(() => "configuration refused"));
});

test("OAUTH_REDIRECT_URI override and empty automatic APP_BASE_URL retain callback compatibility", options, async (t) => {
  const f = await serverFixture(t, { ...oauthEnv, APP_BASE_URL: "", OAUTH_REDIRECT_URI: "https://callback.test/custom" });
  const start = await request(f, { pathname: "/api/auth/sso/start", method: "GET" });
  assert.equal(start.status, 303);
  assert.equal(new URL(start.headers.location).searchParams.get("redirect_uri"), "https://callback.test/custom");
  assert.deepEqual(outcome(await request(f, { headers: ["Origin", f.baseUrl] })), ok);
});

test("JSON media accepts exact type, optional UTF-8 and provably empty native commands", options, async (t) => {
  const f = await serverFixture(t);
  const untypedFraming = [];
  f.server.on("request", (req) => {
    if (req.method === "POST" && req.headers["content-type"] === undefined) {
      untypedFraming.push([req.headers["transfer-encoding"] ?? null, req.headers["content-length"] ?? null]);
    }
  });
  await matrix(t, f, [
    ...["application/json", "Application/JSON", "application/json; charset=utf-8", 'application/json ; CHARSET = "UTF-8"'].map((type) =>
      [type, { headers: ["Content-Type", type], body: "{}" }, ok]),
    ["no type or framing", {}, ok],
    ["missing type length zero", { headers: ["Content-Length", "0"] }, ok],
    ["typed empty chunked", { headers: ["Transfer-Encoding", "chunked", "Content-Type", "application/json"] }, ok],
  ]);
  assert.deepEqual(untypedFraming, [[null, null], [null, "0"]], "the native compatibility cases must send the intended headers");
});

test("JSON media refuses unsupported syntax, raw duplicates and untyped framed bodies even on logout", options, async (t) => {
  const f = await serverFixture(t);
  await matrix(t, f, [
    ...["", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/zip",
      "application/problem+json", "application/jsonp", "application/json; charset=latin1", "application/json; foo=bar",
      "application/json; charset=utf-8; charset=utf-8", "application/json;", 'application/json; charset="utf-8',
      "application/json, application/json"].map((type) => [type || "empty type", { headers: ["Content-Type", type], body: "{}" }, unsupported]),
    ["wrong type with zero length", { headers: ["Content-Type", "text/plain", "Content-Length", "0"] }, unsupported],
    ["wrong type without body framing", { headers: ["Content-Type", "text/plain"] }, unsupported],
    ["raw duplicate Content-Type", { headers: ["Content-Type", "application/json", "content-type", "application/json"], body: "{}" }, unsupported],
    ["missing type positive length", { body: "{}" }, unsupported],
    ["missing type chunked payload", { headers: ["Transfer-Encoding", "chunked"], body: "{}" }, unsupported],
    ["missing type empty chunked", { headers: ["Transfer-Encoding", "chunked"] }, unsupported],
  ]);
});

test("central admission covers POST PUT PATCH DELETE before authentication and orders Origin before media", options, async (t) => {
  const f = await serverFixture(t);
  await matrix(t, f, [
    ...["POST", "PUT", "PATCH", "DELETE"].map((method) => [method, {
      pathname: `/api/projects/${uuidv7()}`, method, headers: ["Content-Type", "text/plain"],
    }, unsupported]),
    ["Origin before unsupported media", { headers: ["Origin", "http://foreign.test", "Content-Type", "text/plain"] }, forbidden],
    ["supported media still requires authentication", { pathname: "/api/projects", headers: ["Content-Type", "application/json"], body: "{}" },
      { status: 401, code: "NOT_AUTHENTICATED" }],
  ]);
});

test("cross-origin project creation is refused before authentication queries, transaction, storage and audit", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  const effects = observe(f);
  const response = await request(f, { pathname: "/api/projects", headers: ["Cookie", cookie,
    "Origin", "http://foreign.test", "Content-Type", "application/json"], body: '{"name":"Cross-origin write"}' });
  const projects = (await f.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n;
  const audit = (await f.pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n;
  const actual = { ...outcome(response), effects: { ...effects }, projects, audit,
    cookies: response.headers["set-cookie"] || [], pendingWrites: (await health(f)).pendingWrites };
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, { ...forbidden, effects: noEffects, projects: 0, audit: 0, cookies: [], pendingWrites: 0 });
});

test("wrong-media reset and delete cannot mutate durable state despite bypassing readBody", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  const target = await user(f, "target", "regular");
  const id = await project(f, cookie);
  const beforeAudit = (await f.pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n;
  const effects = observe(f);
  const reset = await request(f, { pathname: `/api/admin/users/${target.id}/reset-password`, headers: ["Cookie", cookie, "Content-Type", "text/plain"] });
  const remove = await request(f, { pathname: `/api/projects/${id}`, method: "DELETE", headers: ["Cookie", cookie, "Content-Type", "text/plain"] });
  const row = (await f.pool.query("SELECT * FROM users WHERE id = $1", [target.id])).rows[0];
  const actual = { reset: outcome(reset), remove: outcome(remove), effects: { ...effects },
    passwordUnchanged: row.password_hash === target.password_hash, version: row.session_version,
    projects: (await f.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n,
    auditsAdded: (await f.pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n - beforeAudit };
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, { reset: unsupported, remove: unsupported, effects: noEffects,
    passwordUnchanged: true, version: 0, projects: 1, auditsAdded: 0 });
});

test("metadata-free no-body reset and delete remain usable through the real handlers", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  const target = await user(f, "target", "regular");
  const id = await project(f, cookie);
  const reset = await request(f, { pathname: `/api/admin/users/${target.id}/reset-password`, headers: ["Cookie", cookie] });
  assert.equal(reset.status, 200, reset.text);
  const hash = (await f.pool.query("SELECT password_hash FROM users WHERE id = $1", [target.id])).rows[0].password_hash;
  assert.equal(await argon2.verify(hash, reset.json.temporaryPassword), true);
  assert.equal((await request(f, { pathname: `/api/projects/${id}`, method: "DELETE", headers: ["Cookie", cookie] })).status, 200);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n, 0);
});

for (const gate of ["origin", "media"]) {
  test(`${gate} refusal precedes login limiter, Argon2, audit and session cookie issuance`, options, async (t) => {
    const f = await serverFixture(t, { AUTH_RATE_LIMIT: "2", AUTH_ACCOUNT_RATE_LIMIT: "2", AUTH_FAILURE_PENALTY: "1" });
    const hash = await argon2.hash("correct-password", { memoryCost: 1024, timeCost: 1, parallelism: 1 });
    await user(f, "login", "regular", hash);
    const effects = observe(f);
    const headers = gate === "origin" ? ["Origin", "http://foreign.test", "Content-Type", "application/json"] : ["Content-Type", "text/plain"];
    const refused = [];
    for (let i = 0; i < 3; i++) refused.push(outcome(await request(f, { pathname: "/api/auth/login", headers,
      body: '{"username":"login","password":"wrong-password"}' })));
    const beforeGood = { ...effects };
    const good = await request(f, { pathname: "/api/auth/login", headers: ["Content-Type", "application/json"],
      body: '{"username":"login","password":"correct-password"}' });
    const audits = (await f.pool.query("SELECT action FROM audit_events ORDER BY id")).rows.map((row) => row.action);
    const actual = { refused, beforeGood, good: outcome(good), audits };
    t.diagnostic(JSON.stringify(actual));
    assert.deepEqual(actual, { refused: Array(3).fill(gate === "origin" ? forbidden : unsupported),
      beforeGood: noEffects, good: ok, audits: ["auth.login_succeeded"] });
    assert.ok(good.headers["set-cookie"].some((value) => value.startsWith("iris_session=")));
  });
}

test("cross-origin compile is refused before compiler processes and build/storage work", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  const id = await project(f, cookie);
  const effects = observe(f);
  const response = await request(f, { pathname: `/api/projects/${id}/compile`, headers: ["Cookie", cookie,
    "Origin", "http://foreign.test", "Content-Type", "application/json"], body: "{}" });
  await until(() => f.app.runtimeSettled(), "compile work");
  const actual = { ...outcome(response), effects: { ...effects }, pendingWrites: (await health(f)).pendingWrites };
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, { ...forbidden, effects: noEffects, pendingWrites: 0 });
});

test("forbidden login and logout cannot issue or clear session cookies even with correct credentials", options, async (t) => {
  const f = await serverFixture(t);
  const hash = await argon2.hash("correct-password", { memoryCost: 1024, timeCost: 1, parallelism: 1 });
  const account = await user(f, "login", "regular", hash);
  const actual = [], expected = [];
  for (const [headers, want] of [
    [["Origin", "http://foreign.test", "Content-Type", "application/json"], forbidden],
    [["Content-Type", "text/plain"], unsupported],
  ]) {
    for (const pathname of ["/api/auth/login", "/api/auth/logout"]) {
      const response = await request(f, { pathname, headers,
        ...(pathname.endsWith("login") ? { body: '{"username":"login","password":"correct-password"}' } : {}) });
      actual.push({ ...outcome(response), cookies: response.headers["set-cookie"]?.length || 0 });
      expected.push({ ...want, cookies: 0 });
    }
  }
  const row = (await f.pool.query("SELECT last_login_at FROM users WHERE id = $1", [account.id])).rows[0];
  t.diagnostic(JSON.stringify({ actual, loginRecorded: row.last_login_at !== null }));
  assert.deepEqual(actual, expected);
  assert.equal(row.last_login_at, null);
});

const archive = () => createZip([{ name: ".iris/project.json", data: Buffer.from(JSON.stringify({
  irisArchive: { format: "iris-project", version: 1 }, project: { name: "Imported security fixture", nodes: [] },
})) }]);

test("exact parsed POST import route retains type-agnostic native ZIP acceptance and archive validation", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  for (const type of ["application/zip", "application/octet-stream", null]) {
    const response = await request(f, { pathname: "/api/projects/./import?filename=fixture.zip", headers: ["Cookie", cookie,
      ...(type ? ["Content-Type", type] : [])], body: archive() });
    assert.equal(response.status, 201, response.text);
    const row = (await f.pool.query("SELECT name FROM projects WHERE id = $1", [response.json.project.id])).rows[0];
    assert.equal(row.name, "Imported security fixture");
  }
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n, 3);
  const invalid = await request(f, { pathname: "/api/projects/import", headers: ["Cookie", cookie, "Content-Type", "text/plain"], body: "not a ZIP" });
  assert.deepEqual(outcome(invalid), { status: 400, code: "PROJECT_ARCHIVE_INVALID" });
});

test("ZIP media exception never bypasses Origin and lookalike routes/methods still need JSON", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  const effects = observe(f);
  const valid = await request(f, { pathname: "/api/projects/import", headers: ["Cookie", cookie,
    "Origin", "http://foreign.test", "Content-Type", "application/zip"], body: archive() });
  const invalid = await request(f, { pathname: "/api/projects/import", headers: ["Cookie", cookie,
    "Origin", "http://foreign.test"], body: "not a ZIP" });
  const probes = [
    ["PUT", "/api/projects/import"], ["POST", "/api/projects/import/"], ["POST", "/api/projects/import-lookalike"],
    ["POST", "/api/projects/%69mport"],
  ];
  const lookalikes = [];
  for (const [method, pathname] of probes) lookalikes.push(outcome(await request(f, { method, pathname,
    headers: ["Content-Type", "application/zip"], body: archive() })));
  const actual = { valid: outcome(valid), invalid: outcome(invalid), effects: { ...effects }, lookalikes,
    projects: (await f.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n };
  t.diagnostic(JSON.stringify(actual));
  assert.deepEqual(actual, { valid: forbidden, invalid: forbidden, effects: noEffects,
    lookalikes: probes.map(() => unsupported), projects: 0 });
});

test("supported JSON preserves INVALID_JSON and bounded 413 responses downstream", options, async (t) => {
  const f = await serverFixture(t, { MAX_BODY_MB: "0.001" });
  const cookie = f.cookieFor(await user(f));
  await matrix(t, f, [
    ["invalid JSON", { pathname: "/api/auth/login", headers: ["Content-Type", "application/json"], body: "{" }, { status: 400, code: "INVALID_JSON" }],
    ["oversize JSON", { pathname: "/api/auth/login", headers: ["Content-Type", "application/json"], body: JSON.stringify({ x: "x".repeat(2048) }) }, { status: 413, code: "REQUEST_TOO_LARGE" }],
    ["raw import retains the byte limit before ZIP parsing", { pathname: "/api/projects/import", headers: ["Cookie", cookie], body: Buffer.alloc(2048) }, { status: 413, code: "REQUEST_TOO_LARGE" }],
  ]);
});

// Send only a prefix of the declared body. The observation deadline is intentional:
// a missing final response is captured as data, then asserted, never a hook timeout.
async function incomplete(f, headers) {
  const socket = net.connect(new URL(f.baseUrl).port, "127.0.0.1");
  let wire = "", closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { wire += chunk; });
  socket.on("close", () => { closed = true; });
  socket.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.setTimeout(3000, () => socket.destroy(new Error("Raw client connection timeout")));
    });
    socket.write(`POST /api/auth/login HTTP/1.1\r\nHost: ${new URL(f.baseUrl).host}\r\nConnection: keep-alive\r\nContent-Length: 100000\r\n${headers.join("\r\n")}\r\n\r\n{`);
    const deadline = Date.now() + 900;
    while (!closed && Date.now() < deadline) await delay(10);
    const final = [...wire.matchAll(/HTTP\/1\.1 (\d{3})[^\r]*\r\n/g)].map((m) => Number(m[1])).filter((status) => status >= 200);
    const pendingWrites = (await health(f)).pendingWrites;
    return { status: final.at(-1) || null, closed, pendingWrites, interim100: wire.includes("100 Continue"),
      code: wire.match(/"errorCode":"([^"]+)"/)?.[1] || null };
  } finally {
    socket.destroy();
    await until(() => f.app.runtimeSettled(), "aborted incomplete body");
  }
}

for (const gate of ["origin", "media"]) {
  test(`${gate} header refusal answers incomplete Expect-continue bodies promptly, closes connection and never counts a write`, options, async (t) => {
    const f = await serverFixture(t);
    const effects = observe(f);
    const headers = gate === "origin" ? ["Origin: http://foreign.test", "Content-Type: application/json"] : ["Content-Type: text/plain"];
    const actual = await incomplete(f, [...headers, "Expect: 100-continue"]);
    t.diagnostic(JSON.stringify({ ...actual, effects }));
    const { interim100, ...admission } = actual;
    assert.deepEqual(admission, { ...(gate === "origin" ? forbidden : unsupported), closed: true, pendingWrites: 0 });
    assert.deepEqual(effects, noEffects);
  });
}

test("accepted no-body commands retain normal HTTP keep-alive", options, async (t) => {
  const f = await serverFixture(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await request(f, { agent, headers: ["Connection", "keep-alive", "Origin", f.baseUrl] });
    const second = await request(f, { agent, headers: ["Connection", "keep-alive", "Origin", f.baseUrl] });
    assert.deepEqual([outcome(first), outcome(second)], [ok, ok]);
    assert.equal(first.socket, second.socket);
    assert.equal(first.headers.connection, "keep-alive");
  } finally { agent.destroy(); }
});

test("valid-cookie WS accepts same-origin and native handshakes without a Content-Type gate", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  for (const headers of [["Cookie", cookie, "Origin", f.baseUrl], ["Cookie", cookie, "Content-Type", "text/plain"],
    ["Cookie", cookie, "Referer", `${f.baseUrl}/page`, "Sec-Fetch-Site", "none"]]) {
    const result = await request(f, { pathname: "/api/collab", upgrade: true, headers });
    assert.equal(result.status, 101);
    assert.equal(result.sessions, 1, "a real collaboration session was created");
    await until(() => f.app.collabSessions.size === 0, "closed WS session");
  }
  assert.equal((await request(f, { pathname: "/api/collab", upgrade: true })).status, 401, "native compatibility still needs authentication");
});

test("WS refuses bad origins and fallback metadata before auth queries or session/room creation", options, async (t) => {
  const f = await serverFixture(t);
  const cookie = f.cookieFor(await user(f));
  const effects = observe(f);
  const actual = [];
  for (const [name, headers] of [
    ["foreign with cookie", ["Cookie", cookie, "Origin", "http://foreign.test"]],
    ["foreign without cookie", ["Origin", "http://foreign.test"]],
    ["null with cookie", ["Cookie", cookie, "Origin", "null"]],
    ["duplicate with cookie", ["Cookie", cookie, "Origin", f.baseUrl, "Origin", f.baseUrl]],
    ["foreign Referer", ["Cookie", cookie, "Referer", "http://foreign.test/path", "Sec-Fetch-Site", "same-origin"]],
    ["same-site alone", ["Cookie", cookie, "Sec-Fetch-Site", "same-site"]],
  ]) {
    const response = await request(f, { pathname: "/api/collab", upgrade: true, headers });
    actual.push({ name, status: response.status, upgraded: response.upgraded, sessions: response.sessions });
    await until(() => f.app.collabSessions.size === 0, "refused/closed WS session");
  }
  t.diagnostic(JSON.stringify({ actual, effects, rooms: f.app.collabRooms.all().length }));
  assert.deepEqual(actual, actual.map(({ name }) => ({ name, status: 403, upgraded: false, sessions: 0 })));
  assert.deepEqual(effects, noEffects);
  assert.equal(f.app.collabRooms.all().length, 0);
});

test("health/read handling and lifecycle 503 precede security admission with clean pendingWrites", options, async (t) => {
  const f = await serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public") });
  const badHeaders = ["Origin", "http://foreign.test", "Content-Type", "text/plain", "Sec-Fetch-Site", "cross-site"];
  const effects = observe(f);
  await fs.writeFile(path.join(f.dataDir, ".maintenance"), "");
  await matrix(t, f, [
    ["HTTP maintenance", { headers: badHeaders }, { status: 503, code: "MAINTENANCE_MODE" }],
    ["WS maintenance", { pathname: "/api/collab", upgrade: true, headers: badHeaders }, { status: 503, code: null }],
    ["callback still lifecycle-counted", { pathname: "/api/auth/sso/callback", method: "GET", headers: badHeaders }, { status: 503, code: "MAINTENANCE_MODE" }],
    ["health", { pathname: "/api/health", method: "GET", headers: badHeaders }, ok],
    ["safe API read", { pathname: "/api/config", method: "GET", headers: badHeaders }, ok],
    ["static HEAD", { pathname: "/iris-net.js", method: "HEAD", headers: badHeaders }, ok],
  ]);
  assert.deepEqual(effects, noEffects);
  assert.equal((await health(f)).pendingWrites, 0);
});

test("cross-site OIDC callback keeps signed state equality/expiry checks and skips exchange for invalid state", options, async (t) => {
  const f = await serverFixture(t, oauthEnv);
  const nativeFetch = globalThis.fetch;
  const exchanges = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url) === oauthEnv.OAUTH_TOKEN_URL) {
      exchanges.push("token");
      return Response.json({ access_token: "synthetic-access", token_type: "Bearer" });
    }
    if (String(url) === oauthEnv.OAUTH_USERINFO_URL) {
      exchanges.push("userinfo");
      return Response.json({ sub: "security-subject", email: "sso@example.test", email_verified: true, preferred_username: "sso" });
    }
    return nativeFetch(url, init);
  });
  const start = await request(f, { pathname: "/api/auth/sso/start", method: "GET" });
  assert.equal(start.status, 303);
  const state = new URL(start.headers.location).searchParams.get("state");
  const expiredBody = Buffer.from(JSON.stringify({ state: "expired", exp: 1 })).toString("base64url");
  const expired = `${expiredBody}.${crypto.createHmac("sha256", "session-tests-only-secret-with-sufficient-entropy").update(expiredBody).digest("base64url")}`;
  const foreign = ["Origin", "https://idp.example.test", "Referer", "https://idp.example.test/authorize", "Sec-Fetch-Site", "cross-site"];
  for (const [queryState, cookieState] of [[state, "mismatch"], ["forged.signature", "forged.signature"], [expired, expired]]) {
    const response = await request(f, { pathname: `/api/auth/sso/callback?code=synthetic&state=${encodeURIComponent(queryState)}`,
      method: "GET", headers: [...foreign, "Cookie", `iris_oauth_state=${cookieState}`] });
    assert.equal(response.status, 303);
    assert.match(response.headers.location, /auth_error=/);
    assert.equal(response.headers["set-cookie"].some((value) => value.startsWith("iris_session=")), false);
  }
  assert.deepEqual(exchanges, []);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 0);
  // Observe lifecycle accounting at a real audit I/O boundary, releasing in finally.
  const entered = deferred(), release = deferred();
  f.hooks.beforeQuery = async (sql) => {
    if (!sql.includes("INSERT INTO audit_events")) return;
    delete f.hooks.beforeQuery;
    entered.resolve();
    await release.promise;
  };
  const pending = request(f, { pathname: `/api/auth/sso/callback?code=synthetic&state=${encodeURIComponent(state)}`,
    method: "GET", headers: [...foreign, "Cookie", `iris_oauth_state=${state}`] });
  let response;
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail("callback completed before its audit"))]);
    assert.equal((await health(f)).pendingWrites, 1);
  } finally { release.resolve(); response = await pending; }
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, "/");
  assert.deepEqual(exchanges, ["token", "userinfo"]);
  const cookie = response.headers["set-cookie"].find((value) => value.startsWith("iris_session=")).split(";")[0];
  assert.equal((await request(f, { pathname: "/api/auth/session", method: "GET", headers: ["Cookie", cookie] })).status, 200);
  assert.equal((await health(f)).pendingWrites, 0);
});
