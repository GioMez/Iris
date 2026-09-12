const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const WebSocket = require("ws");
const { ChangeSet } = require("@codemirror/state");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");

const options = { skip: !connectionString, timeout: 15000 };
async function until(predicate, label) {
  const deadline = Date.now() + 3500;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(10);
  }
}
function pause(t, f, hook, matches = () => true) {
  const entered = deferred();
  const release = deferred();
  f.hooks[hook] = async (...args) => {
    if (!matches(...args)) return;
    delete f.hooks[hook];
    entered.resolve();
    await release.promise;
  };
  t.after(() => release.resolve());
  return { entered: entered.promise, release: () => release.resolve() };
}
async function seed(t, env = {}, extraFiles = []) {
  const f = await serverFixture(t, {
    COLLAB_FLUSH_MS: "60000", COLLAB_FLUSH_MAX_MS: "60000",
    COLLAB_REVISION_IDLE_MS: "60000", COLLAB_TOUCH_MS: "60000", ...env,
  });
  const user = (await f.pool.query(`INSERT INTO users (id, username, email, display_name, system_role)
    VALUES ($1, 'owner', 'owner@example.test', 'Owner', 'admin') RETURNING *`, [uuidv7()])).rows[0];
  const cookie = f.cookieFor(user);
  const response = await f.request("/api/projects", { cookie, method: "POST", body: {
    name: "Lifecycle", data: { project: { nodes: [
      { id: uuidv7(), type: "file", name: "main.tex", content: "base" },
    ].concat(extraFiles) } },
  } });
  assert.equal(response.status, 201);
  const projectId = (await response.json()).project.id;
  const fileId = (await f.pool.query("SELECT id FROM project_files WHERE project_id = $1 AND path = 'main.tex'", [projectId])).rows[0].id;
  return { ...f, user, cookie, projectId, fileId };
}
const marker = (f, active) => active
  ? fs.writeFile(path.join(f.dataDir, ".maintenance"), "")
  : fs.unlink(path.join(f.dataDir, ".maintenance"));
const health = async (f) => (await f.request("/api/health")).json();
async function frozen(f) {
  await until(async () => (await health(f)).pendingWrites === 0, "durable drain");
}
function connect(t, f) {
  const ws = new WebSocket(`${f.baseUrl.replace("http:", "ws:")}/api/collab`, { headers: { cookie: f.cookie } });
  const messages = [];
  const handshake = new Promise((resolve) => {
    ws.once("open", () => resolve(101));
    ws.once("unexpected-response", (_req, res) => { res.resume(); resolve(res.statusCode); ws.terminate(); });
  });
  ws.on("error", () => {});
  ws.on("message", (raw) => messages.push(JSON.parse(raw)));
  t.after(() => ws.terminate());
  return { ws, messages, handshake, send: (message) => ws.send(JSON.stringify(message)),
    async next(type, predicate = () => true) {
      const matches = (message) => message.t === type && predicate(message);
      await until(() => messages.some(matches), type);
      return messages.splice(messages.findIndex(matches), 1)[0];
    } };
}
async function opened(t, f) {
  const client = connect(t, f);
  assert.equal(await client.handshake, 101);
  await client.next("ready");
  client.send({ t: "open", fileId: f.fileId });
  await client.next("opened");
  client.messages.splice(0); // Discard initial presence and retained-pause reset.
  return client;
}
function push(client, f, version = 0, text = "base", insert = " accepted") {
  client.send({ t: "push", fileId: f.fileId, version, updates: [{ clientID: "writer",
    changes: ChangeSet.of({ from: text.length, insert }, text.length).toJSON() }] });
}

for (const stalled of [false, true]) {
  test(`fixture disposal closes resources and reports a ${stalled ? "stalled" : "rejected"} drain`, options, async (t) => {
    let dispose;
    let disposed = false;
    const f = await serverFixture({ after: (fn) => { dispose = fn; }, diagnostic: (message) => t.diagnostic(message) });
    t.after(async () => { if (!disposed) await dispose(); });
    assert.equal((await f.request("/api/health")).status, 200);
    const child = f.app.runCompileStep({ step: { tool: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, cwd: f.dataDir });
    const drain = f.app.collabShutdown;
    const failure = Object.assign(new Error("unexpected fixture drain failure"), { errorCode: "PROJECT_RECOVERY_REQUIRED" });
    f.exits.push(1); // An exit code alone must not suppress an unrelated teardown failure.
    f.app.collabShutdown = async () => {
      await drain();
      if (stalled) await new Promise(() => {});
      throw failure;
    };
    disposed = true;
    await assert.rejects(dispose(), (err) => err instanceof AggregateError && err.errors.some((cause) =>
      stalled ? cause.message === "Fixture cleanup timed out: realtime drain" : cause === failure));
    await child;
    assert.equal(f.children.size, 0);
    assert.equal(f.server.listening, false);
    assert.equal(f.pool.ended, true);
    assert.equal(f.pool.totalCount, 0);
    await assert.rejects(fs.stat(f.dataDir), { code: "ENOENT" });
  });
}

test("fixture disposes known recovery-blocked dirty authority without bypassing the production gate", options, async (t) => {
  let dispose;
  let disposed = false;
  const diagnostics = [];
  const f = await serverFixture({ after: (fn) => { dispose = fn; }, diagnostic: (message) => diagnostics.push(message) });
  t.after(async () => { if (!disposed) await dispose(); });
  const projectId = uuidv7();
  const room = f.app.collabRooms.open({ fileId: uuidv7(), projectId, path: "main.tex", content: "base" });
  room.storageDir = path.join(f.dataDir, "projects", projectId);
  room.receive(0, [{ clientID: "writer", changes: ChangeSet.of({ from: 4, insert: " accepted" }, 4).toJSON() }]);
  await fs.mkdir(path.join(f.dataDir, ".project-backups", projectId), { recursive: true });
  await assert.rejects(f.app.collabShutdown(), { errorCode: "PROJECT_RECOVERY_REQUIRED" });
  assert.equal(room.needsPersist(), true);
  disposed = true;
  await dispose();
  assert.deepEqual(diagnostics, ["Fixture disposing known failed drain: PROJECT_RECOVERY_REQUIRED"]);
  assert.equal(f.server.listening, false);
  assert.equal(f.pool.ended, true);
  await assert.rejects(fs.stat(f.dataDir), { code: "ENOENT" });
});

test("disconnected HTTP mutation stays counted through its audit and handles the closed response", options, async (t) => {
  const f = await seed(t);
  const wait = pause(t, f, "beforeQuery", (sql) => sql.includes("INSERT INTO audit_events"));
  const req = http.request(`${f.baseUrl}/api/projects`, { method: "POST", headers: { cookie: f.cookie, "content-type": "application/json" } });
  req.on("error", () => {});
  req.end(JSON.stringify({ name: "Disconnected" }));
  try {
    await wait.entered;
    req.destroy();
    await marker(f, true);
    await delay(30);
    assert.equal((await health(f)).pendingWrites, 1);
  } finally { wait.release(); req.destroy(); }
  await frozen(f);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM projects")).rows[0].n, 2);
});

test("a completed compile response remains counted while its staging cleanup is blocked", options, async (t) => {
  const f = await seed(t);
  const wait = pause(t, f, "beforeRm", (target) => String(target).includes(".build-staging"));
  const response = f.request(`/api/projects/${f.projectId}/compile`, { cookie: f.cookie, method: "POST", body: { texPath: path.join(f.dataDir, "missing-compiler") } });
  try {
    await wait.entered;
    assert.equal((await response).status, 200);
    await marker(f, true);
    assert.equal((await health(f)).pendingWrites, 1);
  } finally { wait.release(); await response; }
  await frozen(f);
});

test("failed SSO GET audit is counted; maintenance refusal never reaches callback auditing", options, async (t) => {
  const f = await serverFixture(t);
  const wait = pause(t, f, "beforeQuery", (sql) => sql.includes("INSERT INTO audit_events"));
  const pending = fetch(`${f.baseUrl}/api/auth/sso/callback`, { redirect: "manual" });
  try {
    await wait.entered;
    assert.equal((await health(f)).pendingWrites, 1);
    await marker(f, true);
    assert.equal((await f.request("/api/auth/sso/callback")).status, 503);
  } finally { wait.release(); await pending; }
  await frozen(f);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM audit_events")).rows[0].n, 1);
});

test("successful SSO GET linking stays counted through user changes and the final login audit", options, async (t) => {
  const issuer = "https://lifecycle-idp.example.test";
  const f = await serverFixture(t, {
    OAUTH_ISSUER_URL: issuer, OAUTH_CLIENT_ID: "lifecycle", OAUTH_CLIENT_SECRET: "test-only",
    OAUTH_AUTHORIZATION_URL: `${issuer}/authorize`, OAUTH_TOKEN_URL: `${issuer}/token`, OAUTH_USERINFO_URL: `${issuer}/userinfo`,
  });
  const user = (await f.pool.query(`INSERT INTO users (id, username, email, display_name, oidc_link_pending)
    VALUES ($1, 'linking', 'linking@example.test', 'Linking', true) RETURNING *`, [uuidv7()])).rows[0];
  const fetchRequest = globalThis.fetch;
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (String(url) === `${issuer}/token`) {
      exchanges++;
      return Promise.resolve(Response.json({ access_token: "lifecycle-token" }));
    }
    if (String(url) === `${issuer}/userinfo`) return Promise.resolve(Response.json({
      sub: "durable-subject", email: user.email, name: user.display_name, email_verified: true,
    }));
    return fetchRequest(url, init);
  });
  const start = await fetchRequest(`${f.baseUrl}/api/auth/sso/start`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  assert.equal(start.status, 303);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = start.headers.getSetCookie()[0].split(";")[0];
  const url = `${f.baseUrl}/api/auth/sso/callback?state=${encodeURIComponent(state)}&code=lifecycle-code`;
  const linked = pause(t, f, "beforeQuery", (sql) => sql.includes("UPDATE users SET oidc_issuer"));
  const pending = fetchRequest(url, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(10000) });
  let auditWait;
  let response;
  try {
    await linked.entered;
    assert.equal((await health(f)).pendingWrites, 1);
    await marker(f, true);
    assert.equal((await fetchRequest(url, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(5000) })).status, 503);
    assert.equal(exchanges, 1, "refusal must happen before the token exchange");
    auditWait = pause(t, f, "beforeQuery", (sql, params) => sql.includes("INSERT INTO audit_events") && params.includes("auth.login_succeeded"));
    linked.release();
    await auditWait.entered;
    assert.equal((await health(f)).pendingWrites, 1);
    const row = (await f.pool.query("SELECT auth_source, oidc_subject, oidc_link_pending, session_version FROM users WHERE id = $1", [user.id])).rows[0];
    assert.deepEqual(row, { auth_source: "oidc", oidc_subject: "durable-subject", oidc_link_pending: false, session_version: 1 });
  } finally { linked.release(); auditWait?.release(); response = await pending; }
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.ok(response.headers.getSetCookie().some((value) => value.startsWith("iris_session=")));
  await frozen(f);
  assert.deepEqual((await f.pool.query("SELECT action, outcome FROM audit_events ORDER BY id")).rows, [
    { action: "user.oidc_linked", outcome: "success" }, { action: "auth.login_succeeded", outcome: "success" },
  ]);
});

test("maintenance drains accepted edits, grouped revision and final touch; reads freeze and sockets resume", options, async (t) => {
  const f = await seed(t);
  const client = await opened(t, f);
  push(client, f);
  assert.equal((await client.next("pushed")).accepted, true);
  const wait = pause(t, f, "beforeQuery", (sql) => sql.startsWith("UPDATE projects SET updated_at"));
  try {
    await marker(f, true);
    assert.ok((await health(f)).pendingWrites > 0);
    await client.next("maintenance", (m) => m.active);
    await wait.entered;
    assert.ok((await health(f)).pendingWrites > 0, "final touch still owns durable work");
  } finally { wait.release(); }
  await frozen(f);
  const room = f.app.collabRooms.get(f.fileId);
  assert.equal(await fs.readFile(path.join(room.storageDir, room.path), "utf8"), "base accepted");
  assert.equal(room.needsRevision(), false);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM document_versions WHERE reason = 'realtime'")).rows[0].n, 1);
  const writes = [];
  f.hooks.beforeQuery = (sql) => { if (/^\s*(UPDATE|INSERT|DELETE|BEGIN)/i.test(sql)) writes.push(sql); };
  f.hooks.beforeClientQuery = f.hooks.beforeQuery;
  f.hooks.beforeWriteFile = (target) => writes.push(target);
  for (const route of ["/api/config", "/api/projects", `/api/projects/${f.projectId}`, "/api/project-templates"]) {
    assert.equal((await f.request(route, { cookie: f.cookie })).status, 200, route);
  }
  client.send({ t: "pull", fileId: f.fileId, version: 1 });
  assert.equal((await client.next("updates", (m) => m.updates.length === 0)).version, 1);
  push(client, f, 1, "base accepted", " refused");
  assert.deepEqual(await client.next("error"), { t: "error", code: "MAINTENANCE_MODE", request: "push", fileId: f.fileId });
  assert.equal(await connect(t, f).handshake, 503);
  await delay(1100);
  assert.deepEqual(writes, []);
  delete f.hooks.beforeQuery; delete f.hooks.beforeClientQuery; delete f.hooks.beforeWriteFile;
  await marker(f, false);
  await client.next("maintenance", (m) => !m.active);
  push(client, f, 1, "base accepted", " resumed");
  assert.equal((await client.next("pushed")).accepted, true);
  assert.equal(room.text(), "base accepted resumed");
});

for (const stage of ["started work", "final touch"]) {
  test(`maintenance exit during ${stage} leaves resumed edits on the ordinary revision debounce`, options, async (t) => {
    const revisionMs = 61007;
    const f = await seed(t, { COLLAB_REVISION_IDLE_MS: String(revisionMs) });
    const client = await opened(t, f);
    push(client, f); await client.next("pushed");
    const room = f.app.collabRooms.get(f.fileId);
    if (stage === "started work") await f.app.collabPersist(room, { revision: true });
    const touch = pause(t, f, "beforeQuery", (sql) => sql.startsWith("UPDATE projects SET updated_at"));
    let touching;
    let revisionTick;
    try {
      if (stage === "started work") {
        touching = f.app.collabTouchProject(f.projectId);
        await touch.entered;
      }
      await marker(f, true);
      await health(f);
      await touch.entered;
      assert.equal(await fs.readFile(path.join(room.storageDir, room.path), "utf8"), "base accepted");
      assert.deepEqual((await f.pool.query("SELECT content FROM document_versions WHERE reason = 'realtime'")).rows,
        [{ content: "base accepted" }]);
      await marker(f, false);
      await health(f);
      await client.next("maintenance", (message) => !message.active);
      const schedule = globalThis.setTimeout;
      const cancel = globalThis.clearTimeout;
      t.mock.method(globalThis, "clearTimeout", (timer) => {
        if (revisionTick && timer === revisionTick.timer) revisionTick.cancelled = true;
        return cancel(timer);
      });
      t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
        const timer = schedule(callback, ms, ...args);
        if (ms === revisionMs) revisionTick = { callback, timer, cancelled: false };
        return timer;
      });
      push(client, f, 1, "base accepted", " resumed");
      await client.next("pushed");
    } finally { touch.release(); if (touching) await touching; }
    await until(() => f.app.runtimeSettled(), "old maintenance drain settled");
    assert.deepEqual((await f.pool.query("SELECT content FROM document_versions WHERE reason = 'realtime'")).rows,
      [{ content: "base accepted" }], "resuming must not trigger an eager checkpoint");
    assert.equal(await fs.readFile(path.join(room.storageDir, room.path), "utf8"), "base accepted");
    assert.equal(room.text(), "base accepted resumed");
    assert.equal(room.needsRevision(), true);
    assert.ok(revisionTick, "resumed editing schedules the ordinary debounce");
    assert.equal(revisionTick.cancelled, false, "the old drain must not cancel the resumed debounce");
    // Fire the real scheduled callback without waiting a minute of wall time.
    clearTimeout(revisionTick.timer);
    revisionTick.callback();
    await until(() => !room.needsRevision(), "ordinary revision debounce persisted resumed edits");
    assert.equal(await fs.readFile(path.join(room.storageDir, room.path), "utf8"), "base accepted resumed");
    assert.deepEqual((await f.pool.query("SELECT content FROM document_versions WHERE reason = 'realtime' ORDER BY created_at, id")).rows,
      [{ content: "base accepted" }, { content: "base accepted resumed" }]);
  });
}

test("explicit collab shutdown joins a resumed maintenance drain and still flushes its final obligations", options, async (t) => {
  const f = await seed(t);
  const client = await opened(t, f);
  push(client, f); await client.next("pushed");
  const room = f.app.collabRooms.get(f.fileId);
  await f.app.collabPersist(room, { revision: true });
  const touch = pause(t, f, "beforeQuery", (sql) => sql.startsWith("UPDATE projects SET updated_at"));
  const touching = f.app.collabTouchProject(f.projectId);
  let touches = 0;
  f.hooks.afterQuery = (sql) => { if (sql.startsWith("UPDATE projects SET updated_at")) touches++; };
  let shutdown;
  try {
    await touch.entered;
    await marker(f, true); await health(f);
    await marker(f, false); await health(f);
    push(client, f, 1, "base accepted", " resumed");
    await client.next("pushed");
    // Unlike startGracefulShutdown, this explicit drain does not set the global
    // shuttingDown flag. Joining the shared maintenance promise must be enough.
    shutdown = f.app.collabShutdown();
    await until(() => !room.needsRevision(), "last leave persisted resumed edits");
  } finally { touch.release(); await touching; if (shutdown) await shutdown; }
  assert.equal(touches, 2, "the new flush's touch must follow the previously started touch");
  assert.equal(f.app.healthPayload().pendingWrites, 0);
  assert.equal(await fs.readFile(path.join(room.storageDir, room.path), "utf8"), "base accepted resumed");
});

test("a push queued on the project gate is refused when the marker arrives before receive", options, async (t) => {
  const f = await seed(t);
  const client = await opened(t, f);
  const entered = deferred(); const release = deferred();
  const held = f.app.projectMutations.gate(f.projectId, async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    push(client, f);
    await delay(30);
    await marker(f, true);
    assert.equal((await health(f)).pendingWrites, 0);
  } finally { release.resolve(); await held; }
  assert.deepEqual(await client.next("error"), { t: "error", code: "MAINTENANCE_MODE", request: "push", fileId: f.fileId });
  assert.equal(f.app.collabRooms.get(f.fileId).text(), "base");
});

test("an upgrade waiting for authentication rechecks maintenance before acceptance", options, async (t) => {
  const f = await seed(t);
  const wait = pause(t, f, "afterQuery", (sql) => sql.includes("FROM users WHERE id = $1"));
  const client = connect(t, f);
  try { await wait.entered; await marker(f, true); }
  finally { wait.release(); }
  assert.equal(await client.handshake, 503);
  assert.equal(f.app.collabSessions.size, 0);
});

test("shutdown refuses a queued push at the final project gate and drains only accepted edits before db.end", options, async (t) => {
  const f = await seed(t);
  const client = await opened(t, f);
  push(client, f);
  await client.next("pushed");
  const room = f.app.collabRooms.get(f.fileId);
  const session = Array.from(f.app.collabSessions)[0];
  const entered = deferred(); const release = deferred();
  const held = f.app.projectMutations.gate(f.projectId, async () => { entered.resolve(); await release.promise; });
  let snapshot;
  f.hooks.beforeEnd = async () => {
    snapshot = {
      text: await fs.readFile(path.join(f.dataDir, "projects", f.projectId, "main.tex"), "utf8"),
      versions: (await f.pool.query("SELECT content FROM document_versions WHERE reason = 'realtime'")).rows,
    };
  };
  let shutdown;
  try {
    await entered.promise;
    const previous = session.messages;
    push(client, f, 1, "base accepted", " refused");
    await until(() => session.messages !== previous, "push received while the project gate is held");
    shutdown = f.app.startGracefulShutdown("test", f.server);
    assert.deepEqual(f.exits, []);
  } finally { release.resolve(); await held; }
  await shutdown;
  await session.messages;
  assert.equal(room.text(), "base accepted");
  assert.deepEqual(snapshot, { text: "base accepted", versions: [{ content: "base accepted" }] });
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.app.healthPayload().pendingWrites, 0);
});

test("failed project touches remain pending and retry after the last room leaves", options, async (t) => {
  const f = await seed(t);
  const client = await opened(t, f);
  push(client, f); await client.next("pushed");
  f.hooks.beforeQuery = (sql) => { if (sql.startsWith("UPDATE projects SET updated_at")) throw new Error("touch unavailable"); };
  await marker(f, true);
  await health(f);
  client.send({ t: "close", fileId: f.fileId });
  await delay(150);
  assert.ok((await health(f)).pendingWrites > 0);
  delete f.hooks.beforeQuery;
  await frozen(f);
  assert.equal([...f.app.collabProjects.values()].some((state) => state.touchPending), false);
});

test("startup reconciliation and retention roots are counted and skip new work in maintenance", options, async (t) => {
  const f = await serverFixture(t);
  const wait = pause(t, f, "beforeQuery", (sql) => sql.includes("UPDATE build_outputs"));
  f.app.startRetentionSweep();
  try {
    await wait.entered;
    await marker(f, true);
    assert.ok((await health(f)).pendingWrites > 0);
    assert.equal(await f.app.runRetentionSweep(), null);
    assert.equal(await f.app.reconcileStalledBuilds(), null);
  } finally { wait.release(); }
  await frozen(f);
  await marker(f, false);
  const audit = pause(t, f, "beforeQuery", (sql) => sql.includes("DELETE FROM audit_events"));
  const sweep = f.app.runRetentionSweep();
  try { await audit.entered; await marker(f, true); assert.ok((await health(f)).pendingWrites > 0); }
  finally { audit.release(); await sweep; }
  await frozen(f);
});

test("shutdown waits for disconnected HTTP, background tail and final collab touch before db.end; calls reuse one promise", options, async (t) => {
  const f = await seed(t);
  const client = await opened(t, f);
  push(client, f); await client.next("pushed");
  const bg = pause(t, f, "beforeQuery", (sql) => sql.includes("DELETE FROM audit_events"));
  const sweep = f.app.runRetentionSweep();
  await bg.entered;
  const httpWait = pause(t, f, "beforeRm", (target) => String(target).includes(".build-staging"));
  const response = f.request(`/api/projects/${f.projectId}/compile`, { cookie: f.cookie, method: "POST", body: { texPath: path.join(f.dataDir, "missing") } });
  await httpWait.entered;
  await response;
  const touch = pause(t, f, "beforeQuery", (sql) => sql.startsWith("UPDATE projects SET updated_at"));
  let ended = false; f.hooks.beforeEnd = () => { ended = true; };
  const shutdown = f.app.startGracefulShutdown("test", f.server);
  try {
    assert.ok(shutdown instanceof Promise);
    assert.equal(f.app.startGracefulShutdown("again", f.server), shutdown);
    await delay(50);
    assert.equal(ended, false);
    httpWait.release(); bg.release(); await sweep;
    await touch.entered;
    assert.equal(ended, false);
  } finally { httpWait.release(); bg.release(); touch.release(); await sweep; }
  await shutdown;
  assert.equal(ended, true);
  assert.deepEqual(f.exits, [0]);
});

test("shutdown rejects both existing queue waiters with merged busy responses", options, async (t) => {
  const f = await seed(t, { COMPILE_CONCURRENCY: "1", PASSWORD_HASH_CONCURRENCY: "1" });
  const releaseCompile = await f.app.compileGate.acquire();
  const releasePassword = await f.app.passwordHashGate.acquire();
  const compile = f.request(`/api/projects/${f.projectId}/compile`, { cookie: f.cookie, method: "POST", body: {} });
  const password = f.request(`/api/admin/users/${f.user.id}/reset-password`, { cookie: f.cookie, method: "POST" });
  try {
    await until(() => f.app.compileGate.queued === 1 && f.app.passwordHashGate.queued === 1, "both queue waiters");
    const shutdown = f.app.startGracefulShutdown("test", f.server);
    assert.equal((await compile).status, 503);
    assert.equal((await (await compile).json()).errorCode, "COMPILE_SERVER_BUSY");
    assert.equal((await password).status, 503);
    assert.equal((await (await password).json()).errorCode, "AUTH_BUSY");
    await shutdown;
    assert.deepEqual(f.exits, [0]);
  } finally { releaseCompile(); releasePassword(); }
});

test("shutdown deadline includes db.end and never reports a clean exit on timeout", options, async (t) => {
  const f = await serverFixture(t, { SHUTDOWN_TIMEOUT_MS: "100" });
  const wait = pause(t, f, "beforeEnd");
  const shutdown = f.app.startGracefulShutdown("test", f.server);
  try {
    await wait.entered;
    await until(() => f.exits.length > 0, "shutdown deadline");
    assert.deepEqual(f.exits, [1]);
  } finally { wait.release(); await shutdown; }
  await delay(30);
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.logs.some((entry) => entry.args[0] === "Shutdown complete"), false);
});

test("db.end rejection is a shutdown failure even when all writes drained", options, async (t) => {
  const f = await serverFixture(t);
  f.hooks.beforeEnd = () => { throw new Error("database close failed"); };
  await f.app.startGracefulShutdown("test", f.server);
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.logs.some((entry) => entry.args[0] === "Shutdown complete"), false);
});

test("shutdown deadline also covers an active direct child without an HTTP owner", options, async (t) => {
  const f = await serverFixture(t, { SHUTDOWN_TIMEOUT_MS: "100" });
  const child = f.app.runCompileStep({ step: { tool: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, cwd: f.dataDir });
  let ended = false;
  f.hooks.beforeEnd = () => { ended = true; };
  try {
    await f.app.startGracefulShutdown("test", f.server);
    assert.deepEqual(f.exits, [1]);
    assert.equal(ended, false);
    await until(() => f.children.size === 0, "unowned direct child stopped");
  } finally {
    f.children.forEach((process) => process.kill("SIGKILL"));
    await child;
  }
});

test("revision persistence failure keeps its obligation and makes shutdown nonzero", options, async (t) => {
  const f = await seed(t, { SHUTDOWN_TIMEOUT_MS: "500" });
  const client = await opened(t, f);
  push(client, f); await client.next("pushed");
  const room = f.app.collabRooms.get(f.fileId);
  f.hooks.beforeClientQuery = (sql) => { if (sql.includes("INSERT INTO document_versions")) throw new Error("checkpoint unavailable"); };
  try {
    await f.app.startGracefulShutdown("test", f.server);
    assert.deepEqual(f.exits, [1]);
    assert.equal(room.needsRevision(), true);
    assert.ok(f.app.healthPayload().pendingWrites > 0);
    assert.equal(f.logs.some((entry) => entry.args[0] === "Shutdown complete"), false);
  } finally { delete f.hooks.beforeClientQuery; }
});

test("a handler error after a partial HTTP body terminates the client stream without sending second headers", options, async (t) => {
  const f = await serverFixture(t);
  const received = deferred();
  const failed = deferred();
  let serverResponse;
  let clientResponse;
  let bytes = 0;
  let writeHeads = 0;
  let closed = false;
  let aborted = false;
  f.server.prependListener("request", (_req, res) => {
    serverResponse = res;
    const original = res.writeHead;
    res.writeHead = function (...args) { writeHeads++; return original.apply(this, args); };
  });
  f.hooks.beforeReadFile = async () => {
    delete f.hooks.beforeReadFile;
    serverResponse.write(Buffer.alloc(4096, "x"));
    await received.promise;
    failed.resolve();
    throw new Error("read failed after a partial body");
  };
  const request = http.get(`${f.baseUrl}/vendor/codemirror/state.js`, { agent: false }, (res) => {
    clientResponse = res;
    res.on("data", (chunk) => { bytes += chunk.length; if (bytes >= 4096) received.resolve(); });
    res.on("aborted", () => { aborted = true; });
    res.on("close", () => { closed = true; });
    res.on("error", () => {});
  });
  request.on("error", () => {});
  try {
    await until(() => bytes === 4096, "partial response received by client");
    await failed.promise;
    await until(() => closed, "failed HTTP body terminated by the server");
    assert.equal(aborted, true);
    assert.equal(clientResponse.complete, false);
    assert.equal(serverResponse.destroyed, true);
    assert.equal(writeHeads, 1);
    assert.equal(f.app.runtimeSettled(), true);
  } finally { received.resolve(); clientResponse?.destroy(); request.destroy(); }
});

test("handled errors after headers or disconnect never attempt a second HTTP response", options, async (t) => {
  const f = await serverFixture(t);
  let response;
  f.server.prependListener("request", (_req, res) => { response = res; });
  for (const disconnected of [false, true]) {
    let writeHeads = 0;
    const failed = deferred();
    f.hooks.beforeReadFile = () => {
      delete f.hooks.beforeReadFile;
      const original = response.writeHead;
      response.writeHead = function (...args) { writeHeads++; return original.apply(this, args); };
      if (disconnected) response.destroy();
      else response.end("partial response");
      failed.resolve();
      throw new Error("read failed after response closed");
    };
    const request = f.request("/vendor/codemirror/state.js").catch(() => null);
    await failed.promise;
    await request;
    await delay(30);
    assert.equal(writeHeads, disconnected ? 0 : 1);
    assert.equal((await health(f)).pendingWrites, 0);
  }
});

test("reopening maintenance reschedules failed revisions and preserves grouped per-file authorship", options, async (t) => {
  const f = await seed(t, { COLLAB_FLUSH_MS: "50", COLLAB_REVISION_IDLE_MS: "50" },
    [{ id: uuidv7(), type: "file", name: "second.tex", content: "base" }]);
  const other = (await f.pool.query(`INSERT INTO users (id, username, email, display_name)
    VALUES ($1, 'other', 'other@example.test', 'Other') RETURNING *`, [uuidv7()])).rows[0];
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [f.projectId, other.id]);
  const otherFileId = (await f.pool.query("SELECT id FROM project_files WHERE project_id = $1 AND path = 'second.tex'", [f.projectId])).rows[0].id;
  const otherFixture = { ...f, cookie: f.cookieFor(other), fileId: otherFileId };
  const first = await opened(t, f);
  const second = await opened(t, otherFixture);
  let failures = 0;
  f.hooks.beforeClientQuery = (sql) => {
    if (sql.includes("INSERT INTO document_versions")) { failures++; throw new Error("revision storage unavailable"); }
  };
  push(first, f); push(second, otherFixture);
  await first.next("pushed"); await second.next("pushed");
  await marker(f, true);
  await health(f);
  await first.next("maintenance", (m) => m.active);
  await until(() => failures > 0, "failed checkpoint");
  assert.ok((await health(f)).pendingWrites > 0);
  delete f.hooks.beforeClientQuery;
  let checkpoints = 0;
  f.hooks.beforeClientQuery = (sql) => { if (sql.includes("pg_advisory_xact_lock")) checkpoints++; };
  await marker(f, false);
  await first.next("maintenance", (m) => !m.active);
  await until(() => f.app.collabRooms.all().every((room) => !room.needsRevision()), "rescheduled revisions");
  assert.equal(checkpoints, 1, "both rooms use the same project checkpoint");
  const versions = (await f.pool.query("SELECT file_id, author_id, content FROM document_versions WHERE reason = 'realtime' ORDER BY file_id")).rows;
  assert.equal(versions.length, 2);
  assert.equal(versions.find((version) => version.file_id === f.fileId).author_id, f.user.id);
  assert.equal(versions.find((version) => version.file_id === otherFileId).author_id, other.id);
  assert.ok(versions.every((version) => version.content === "base accepted"));
});

test("forced shutdown stops active direct compiler and font-cache children without claiming a drained database", options, async (t) => {
  const f = await seed(t, { SHUTDOWN_TIMEOUT_MS: "150" });
  const wait = pause(t, f, "beforeQuery", (sql) => sql.includes("INSERT INTO audit_events"));
  const request = f.request("/api/projects", { cookie: f.cookie, method: "POST", body: { name: "Blocked" } }).catch(() => null);
  await wait.entered;
  const args = ["-e", "setInterval(() => {}, 1000)"];
  // fc-cache is an optional system tool. Substitute its executable only, using
  // real child processes and the production font-cache lifecycle.
  f.hooks.spawn = (command) => command === "fc-cache" ? { command: process.execPath, args } : null;
  const compiler = f.app.runCompileStep({ step: { tool: process.execPath, args }, cwd: f.dataDir });
  const fonts = f.app.refreshFontCache(f.dataDir);
  let ended = false; f.hooks.beforeEnd = () => { ended = true; };
  try {
    assert.equal(f.children.size, 2);
    const shutdown = f.app.startGracefulShutdown("test", f.server);
    await until(() => f.exits.length > 0, "forced exit");
    assert.deepEqual(f.exits, [1]);
    assert.equal(ended, false);
    await until(() => f.children.size === 0, "direct children stopped");
    await shutdown;
  } finally {
    f.children.forEach((child) => child.kill("SIGKILL"));
    wait.release();
    await Promise.all([compiler, fonts, request]);
  }
});
