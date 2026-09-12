const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const argon2 = require("argon2");
const WebSocket = require("ws");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");

const options = { skip: !connectionString, timeout: 15000 };
const password = "original-password";
const newPassword = "replacement-password";
const issuer = "https://idp.example.org";
const hashOptions = { type: argon2.argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 };

async function createUser(f, username = "alice", role = "regular", timeCost = 1) {
  return (await f.pool.query(
    `INSERT INTO users (id, username, email, display_name, system_role, password_hash)
     VALUES ($1, $2, $3, $2, $4, $5) RETURNING *`,
    [uuidv7(), username, `${username}@example.org`, role, await argon2.hash(password, { ...hashOptions, timeCost })]
  )).rows[0];
}

const responseCookie = (response) => response.headers.get("set-cookie")?.split(";")[0];
const session = (f, cookie) => f.request("/api/auth/session", { cookie });
const login = (f, user, secret = password) => f.request("/api/auth/login", {
  method: "POST", body: { username: user.username, password: secret },
});
const reset = (f, admin, user) => f.request(`/api/admin/users/${user.id}/reset-password`, {
  method: "POST", cookie: f.cookieFor(admin),
});

// Pause an actual I/O operation once; an early response fails instead of hanging.
function pauseAt(hooks, name, matches) {
  const reached = deferred();
  const release = deferred();
  hooks[name] = async (...args) => {
    if (!matches(...args)) return;
    delete hooks[name];
    reached.resolve();
    await release.promise;
  };
  return {
    wait: (pending) => Promise.race([reached.promise, pending.then(() => { throw new Error("request completed before pause"); })]),
    release: () => { delete hooks[name]; release.resolve(); },
  };
}

async function openSession(t, f, user) {
  const ws = new WebSocket(`${f.baseUrl.replace("http:", "ws:")}/api/collab`, { headers: { cookie: f.cookieFor(user) } });
  t.after(() => ws.terminate());
  const [raw] = await once(ws, "message");
  const ready = JSON.parse(raw);
  assert.equal(ready.t, "ready");
  const live = [...f.app.collabSessions].find((entry) => entry.id === ready.sessionId);
  assert.ok(live);
  return live;
}

test("cookies require a numeric version and finite numeric expiry, including the exact boundary", options, async (t) => {
  const f = await serverFixture(t);
  const user = await createUser(f);
  const now = Math.floor(Date.now() / 1000);
  t.mock.method(Date, "now", () => now * 1000);
  for (const claims of [
    { sessionVersion: undefined }, { sessionVersion: "0" }, { sessionVersion: null },
    { sessionVersion: -1 }, { sessionVersion: 0.5 }, { sessionVersion: 1 },
    { exp: undefined }, { exp: null }, { exp: "9999999999" }, { exp: "Infinity" },
    { exp: now }, { exp: now - 1 },
  ]) {
    assert.equal((await session(f, f.cookieFor(user, claims))).status, 401, JSON.stringify(claims));
  }
  assert.equal((await session(f, f.cookieFor(user))).status, 200);
  const withoutVersion = { ...user };
  delete withoutVersion.session_version;
  assert.throws(() => f.app.makeToken(withoutVersion), /session.version/i);
});

test("requireUser returns the authenticated version and expiry and rechecks expiry after SQL", options, async (t) => {
  const f = await serverFixture(t);
  const user = await createUser(f);
  let now = Math.floor(Date.now() / 1000);
  t.mock.method(Date, "now", () => now * 1000);
  const exp = now + 10;
  const cookie = f.cookieFor(user, { exp });
  const authenticated = await f.app.requireUser({ headers: { cookie } });
  assert.equal(authenticated.sessionVersion, 0);
  assert.equal(authenticated.exp, exp);
  const gate = pauseAt(f.hooks, "afterQuery", (sql) => sql.startsWith("SELECT") && sql.includes("FROM users WHERE id"));
  const pending = session(f, cookie);
  try {
    await gate.wait(pending);
    now = exp;
  } finally {
    gate.release();
    await pending;
  }
  assert.equal((await pending).status, 401);
});

test("disable-enable revokes same-second cookies but role and profile changes keep sessions fresh", options, async (t) => {
  const f = await serverFixture(t);
  const admin = await createUser(f, "admin", "admin");
  const user = await createUser(f);
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, "now", () => now);
  const cookie = f.cookieFor(user);
  const patch = (body) => f.request(`/api/admin/users/${user.id}`, { method: "PATCH", cookie: f.cookieFor(admin), body });
  assert.equal((await patch({ role: "admin", name: "Updated" })).status, 200);
  const fresh = await (await session(f, cookie)).json();
  assert.equal(fresh.user.role, "admin");
  assert.equal(fresh.user.name, "Updated");
  const live = await openSession(t, f, user);
  const gate = pauseAt(f.hooks, "beforeQuery", (sql) => sql.includes("INSERT INTO audit_events"));
  const pending = patch({ status: "disabled" });
  try {
    await gate.wait(pending);
    assert.equal(f.app.collabSessions.has(live), false, "revoke before waiting for audit");
  } finally {
    gate.release();
    await pending;
  }
  assert.equal((await patch({ status: "active" })).status, 200);
  const row = (await f.pool.query("SELECT * FROM users WHERE id = $1", [user.id])).rows[0];
  assert.equal(row.session_version, 1);
  assert.equal(Date.now(), now, "issuance and revocation occur in the same frozen second");
  assert.equal((await session(f, cookie)).status, 401);
  const current = await login(f, user);
  assert.equal((await session(f, responseCookie(current))).status, 200);
});

test("self password change revokes old sessions and issues a usable replacement", options, async (t) => {
  const f = await serverFixture(t);
  const user = await createUser(f);
  const cookie = f.cookieFor(user);
  // Open before forcing the change, since realtime may enforce the same gate.
  const live = await openSession(t, f, user);
  await f.pool.query("UPDATE users SET password_change_required = TRUE WHERE id = $1", [user.id]);
  const gate = pauseAt(f.hooks, "beforeQuery", (sql) => sql.includes("INSERT INTO audit_events"));
  const pending = f.request("/api/auth/password", { method: "POST", cookie, body: { currentPassword: password, newPassword } });
  try {
    await gate.wait(pending);
    assert.equal(f.app.collabSessions.has(live), false);
  } finally {
    gate.release();
    await pending;
  }
  const response = await pending;
  assert.equal(response.status, 200);
  const current = await session(f, responseCookie(response));
  assert.equal(current.status, 200);
  assert.equal((await current.json()).user.passwordChangeRequired, false);
  assert.equal((await session(f, cookie)).status, 401);
  assert.equal((await login(f, user)).status, 401);
  assert.equal((await login(f, user, newPassword)).status, 200);
});

for (const action of ["reset-password", "unlink-sso", "delete"]) {
  test(`${action} revokes live sessions before audit and invalidates old cookies`, options, async (t) => {
    const f = await serverFixture(t);
    const admin = await createUser(f, "admin", "admin");
    const user = await createUser(f);
    if (action === "unlink-sso") {
      Object.assign(user, (await f.pool.query(
        "UPDATE users SET auth_source = 'oidc', password_hash = NULL, oidc_issuer = $2, oidc_subject = 'alice' WHERE id = $1 RETURNING *",
        [user.id, issuer]
      )).rows[0]);
    }
    const oldCookie = f.cookieFor(user);
    const live = await openSession(t, f, user);
    if (action === "delete") await f.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [user.id]);
    const gate = pauseAt(f.hooks, "beforeQuery", (sql) => sql.includes("INSERT INTO audit_events"));
    const pending = f.request(`/api/admin/users/${user.id}${action === "delete" ? "" : `/${action}`}`, {
      method: action === "delete" ? "DELETE" : "POST", cookie: f.cookieFor(admin), body: { confirmation: user.username },
    });
    try {
      await gate.wait(pending);
      assert.equal(f.app.collabSessions.has(live), false);
      assert.notEqual(live.socket.readyState, WebSocket.OPEN);
      assert.equal((await session(f, oldCookie)).status, 401);
    } finally {
      gate.release();
      await pending;
    }
    const response = await pending;
    assert.equal(response.status, 200);
    const row = (await f.pool.query("SELECT * FROM users WHERE id = $1", [user.id])).rows[0];
    if (action === "delete") return assert.equal(row, undefined);
    assert.equal(row.session_version, 1);
    const result = await login(f, user, (await response.json()).temporaryPassword);
    assert.equal(result.status, 200);
    assert.equal((await session(f, responseCookie(result))).status, 200);
    assert.equal((await result.json()).user.passwordChangeRequired, true);
  });
}

test("local-to-SSO conversion revokes local sessions and clears forced change; SSO inserts use the DB default version", options, async (t) => {
  const f = await serverFixture(t, { OAUTH_ISSUER_URL: issuer, OAUTH_AUTO_REGISTER: "true", OAUTH_APPROVAL_REQUIRED: "false" });
  const user = await createUser(f);
  const live = await openSession(t, f, user);
  await f.pool.query("UPDATE users SET oidc_link_pending = TRUE, password_change_required = TRUE WHERE id = $1", [user.id]);
  const profile = { email: user.email, subject: "alice", name: "Alice", preferredUsername: "alice", emailVerified: true };
  const gate = pauseAt(f.hooks, "beforeQuery", (sql) => sql.includes("INSERT INTO audit_events"));
  const pending = f.app.userFromOAuthProfile(profile);
  try {
    await gate.wait(pending);
    assert.equal(f.app.collabSessions.has(live), false);
  } finally {
    gate.release();
    await pending;
  }
  const converted = await pending;
  assert.equal(converted.session_version, 1);
  assert.equal(converted.password_change_required, false);
  assert.equal((await session(f, f.cookieFor(user))).status, 401);
  const ssoCookie = `iris_session=${f.app.makeToken(converted, "sso")}`;
  assert.equal((await f.request("/api/projects", { cookie: ssoCookie })).status, 200);
  const returning = await f.app.userFromOAuthProfile({ ...profile, name: "Updated Alice" });
  assert.equal((await session(f, `iris_session=${f.app.makeToken(returning, "sso")}`)).status, 200);
  const registered = await f.app.userFromOAuthProfile({ email: "bob@example.org", subject: "bob", name: "Bob", preferredUsername: "bob" });
  assert.equal(registered.session_version, 0);
  assert.equal((await session(f, `iris_session=${f.app.makeToken(registered, "sso")}`)).status, 200);
});

test("SSO registration defaults to pending approval and admits the configured role only after approval", options, async (t) => {
  const f = await serverFixture(t, { OAUTH_ISSUER_URL: issuer, OAUTH_AUTO_REGISTER: "true", OAUTH_DEFAULT_ROLE: "external" });
  const admin = await createUser(f, "admin", "admin");
  const profile = { email: "guest@example.org", subject: "guest", name: "Guest", preferredUsername: "guest" };
  const pendingError = { status: 403, errorCode: "AUTH_ACCOUNT_PENDING", authError: "account_pending" };
  await assert.rejects(f.app.userFromOAuthProfile(profile), pendingError);
  const pending = (await f.pool.query("SELECT * FROM users WHERE email = $1", [profile.email])).rows[0];
  assert.equal(pending.status, "pending");
  assert.equal(pending.system_role, "external");
  assert.equal(pending.auth_source, "oidc");
  assert.equal(pending.session_version, 0);
  // Even a correctly signed cookie cannot make an unapproved account active.
  const pendingCookie = `iris_session=${f.app.makeToken(pending, "sso")}`;
  assert.equal((await session(f, pendingCookie)).status, 401);
  assert.equal((await f.request("/api/projects", { cookie: pendingCookie })).status, 401);
  await assert.rejects(f.app.userFromOAuthProfile(profile), pendingError);
  assert.equal((await f.pool.query("SELECT id FROM users WHERE email = $1", [profile.email])).rows.length, 1);

  const approved = await f.request(`/api/admin/users/${pending.id}`, {
    method: "PATCH", cookie: f.cookieFor(admin), body: { status: "active" },
  });
  assert.equal(approved.status, 200);
  const registered = await f.app.userFromOAuthProfile(profile);
  assert.equal(registered.id, pending.id);
  assert.equal(registered.system_role, "external");
  assert.equal(registered.session_version, 0);
  const cookie = `iris_session=${f.app.makeToken(registered, "sso")}`;
  const authenticated = await session(f, cookie);
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).user.role, "external");
  const create = await f.request("/api/projects", { method: "POST", cookie, body: { name: "Not permitted" } });
  assert.equal(create.status, 403);
  assert.equal((await create.json()).errorCode, "PROJECT_CREATE_FORBIDDEN");
  assert.equal((await f.pool.query("SELECT action FROM audit_events WHERE target_id = $1 AND action = 'user.approved'", [pending.id])).rows.length, 1);
});

for (const rehash of [false, true]) {
  test(`login overlapping reset cannot mint a current session${rehash ? " or overwrite the reset during rehash" : ""}`, options, async (t) => {
    const f = await serverFixture(t);
    const admin = await createUser(f, "admin", "admin");
    const user = await createUser(f, "alice", "regular", rehash ? 2 : 1);
    const gate = pauseAt(f.hooks, "afterVerify", () => true);
    const pending = login(f, user);
    let temporaryPassword;
    try {
      await gate.wait(pending);
      const response = await reset(f, admin, user);
      assert.equal(response.status, 200);
      temporaryPassword = (await response.json()).temporaryPassword;
    } finally {
      gate.release();
      await pending;
    }
    const response = await pending;
    assert.equal((await session(f, responseCookie(response))).status, 401);
    const row = (await f.pool.query("SELECT * FROM users WHERE id = $1", [user.id])).rows[0];
    assert.equal(await argon2.verify(row.password_hash, temporaryPassword), true);
    assert.equal((await login(f, user)).status, 401);
    assert.equal((await login(f, user, temporaryPassword)).status, 200);
  });
}

test("self password change cannot overwrite a reset after password verification", options, async (t) => {
  const f = await serverFixture(t);
  const admin = await createUser(f, "admin", "admin");
  const user = await createUser(f);
  const gate = pauseAt(f.hooks, "afterVerify", () => true);
  const pending = f.request("/api/auth/password", {
    method: "POST", cookie: f.cookieFor(user), body: { currentPassword: password, newPassword },
  });
  let temporaryPassword;
  try {
    await gate.wait(pending);
    const response = await reset(f, admin, user);
    assert.equal(response.status, 200);
    temporaryPassword = (await response.json()).temporaryPassword;
  } finally {
    gate.release();
    await pending;
  }
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(responseCookie(response), undefined);
  assert.equal((await login(f, user, temporaryPassword)).status, 200);
  assert.equal((await login(f, user, newPassword)).status, 401);
});

test("username renewal uses the original authenticated version, not a newer row read after reset", options, async (t) => {
  const f = await serverFixture(t);
  const user = await createUser(f);
  const gate = pauseAt(f.hooks, "afterQuery", (sql, params) => sql.startsWith("SELECT") && sql.includes("password_change_required") && params[0] === user.id);
  const pending = f.request("/api/account/username", {
    method: "POST", cookie: f.cookieFor(user), body: { username: "renamed", currentPassword: password },
  });
  try {
    await gate.wait(pending);
    // Keep the same secret to isolate the version guard from password step-up.
    await f.pool.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [user.id]);
  } finally {
    gate.release();
    await pending;
  }
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(responseCookie(response), undefined);
  assert.equal((await f.pool.query("SELECT username FROM users WHERE id = $1", [user.id])).rows[0].username, "alice");
  const freshUser = (await f.pool.query("SELECT * FROM users WHERE id = $1", [user.id])).rows[0];
  const success = await f.request("/api/account/username", {
    method: "POST", cookie: f.cookieFor(freshUser), body: { username: "renamed", currentPassword: password },
  });
  assert.equal(success.status, 200);
  assert.equal((await session(f, responseCookie(success))).status, 200);
});

for (const action of ["reset-password", "unlink-sso"]) {
  test(`${action} refuses a stale precondition after an auth-source transition`, options, async (t) => {
    const f = await serverFixture(t, { OAUTH_ISSUER_URL: issuer });
    const admin = await createUser(f, "admin", "admin");
    const user = await createUser(f);
    if (action === "unlink-sso") {
      await f.pool.query("UPDATE users SET auth_source = 'oidc', password_hash = NULL, oidc_issuer = $2, oidc_subject = 'old' WHERE id = $1", [user.id, issuer]);
    }
    const gate = pauseAt(f.hooks, "afterQuery", (sql, params) => sql.startsWith("SELECT id, username,") && !sql.includes("email") && params[0] === user.id);
    const pending = f.request(`/api/admin/users/${user.id}/${action}`, { method: "POST", cookie: f.cookieFor(admin) });
    let transitioned;
    try {
      await gate.wait(pending);
      if (action === "unlink-sso") assert.equal((await f.request(`/api/admin/users/${user.id}/unlink-sso`, { method: "POST", cookie: f.cookieFor(admin) })).status, 200);
      await f.pool.query("UPDATE users SET oidc_link_pending = TRUE WHERE id = $1", [user.id]);
      transitioned = await f.app.userFromOAuthProfile({ email: user.email, subject: "new", name: "Alice", emailVerified: true });
    } finally {
      gate.release();
      await pending;
    }
    const response = await pending;
    assert.equal(response.status, 400);
    const row = (await f.pool.query("SELECT * FROM users WHERE id = $1", [user.id])).rows[0];
    assert.equal(row.auth_source, "oidc");
    assert.equal(row.oidc_subject, "new");
    assert.equal(row.password_hash, null);
    assert.equal(row.session_version, transitioned.session_version);
    assert.equal(row.password_change_required, false);
  });
}
