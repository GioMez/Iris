const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const argon2 = require("argon2");
const WebSocket = require("ws");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");

const options = { skip: !connectionString, timeout: 15000 };
const issuer = "https://linking-idp.example.test";
const otherIssuer = "https://other-idp.example.test";
const oauthEnv = {
  OAUTH_ISSUER_URL: issuer, OAUTH_CLIENT_ID: "linking", OAUTH_CLIENT_SECRET: "test-only",
  OAUTH_AUTHORIZATION_URL: `${issuer}/authorize`, OAUTH_TOKEN_URL: `${issuer}/token`, OAUTH_USERINFO_URL: `${issuer}/userinfo`,
  OAUTH_AUTO_REGISTER: "true", OAUTH_APPROVAL_REQUIRED: "false",
};
const profile = { email: "alice@example.test", subject: "alice-subject", name: "Alice", preferredUsername: "alice" };
const verified = { ...profile, emailVerified: true };
const inactiveErrors = {
  pending: { status: 403, errorCode: "AUTH_ACCOUNT_PENDING", authError: "account_pending" },
  disabled: { status: 403, errorCode: "AUTH_ACCOUNT_DISABLED" },
};
const settled = (promise) => promise.then((user) => ({ user }), (error) => ({ error }));
const rowFor = async (f, id) => (await f.pool.query("SELECT * FROM users WHERE id = $1", [id])).rows[0];
const actions = async (f) => (await f.pool.query("SELECT action FROM audit_events ORDER BY id")).rows.map((row) => row.action);

async function createUser(f, fields = {}) {
  const user = {
    username: "alice", email: profile.email, status: "active", auth_source: "local", system_role: "regular",
    oidc_issuer: null, oidc_subject: null, oidc_link_pending: false, ...fields,
  };
  const hash = user.auth_source === "local"
    ? await argon2.hash("local-password", { type: argon2.argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 }) : null;
  return (await f.pool.query(
    `INSERT INTO users (id, username, email, display_name, status, auth_source, system_role,
       oidc_issuer, oidc_subject, oidc_link_pending, password_hash)
     VALUES ($1, $2, $3, 'Alice', $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [uuidv7(), user.username, user.email, user.status, user.auth_source, user.system_role,
      user.oidc_issuer, user.oidc_subject, user.oidc_link_pending, hash]
  )).rows[0];
}

// Pause real database I/O, including a future transaction-backed implementation.
// Early completion and a missing hook are failures; all callers release in finally.
function pauseQuery(f, matches) {
  const reached = deferred();
  const released = deferred();
  const names = ["beforeQuery", "beforeClientQuery"];
  const remove = () => names.forEach((name) => { if (f.hooks[name] === hook) delete f.hooks[name]; });
  const hook = async (...args) => {
    if (!matches(...args)) return;
    remove();
    reached.resolve();
    await released.promise;
  };
  names.forEach((name) => { f.hooks[name] = hook; });
  return {
    async wait(pending) {
      let timer;
      try {
        await Promise.race([
          reached.promise,
          pending.then(() => { throw new Error("OAuth attempt completed before the database pause"); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Database pause not reached")), 3500); }),
        ]);
      } finally { clearTimeout(timer); }
    },
    release() { remove(); released.resolve(); },
  };
}
const linkWrite = (sql) => /^\s*UPDATE users\b/i.test(sql) && /\boidc_issuer\s*=/i.test(sql);
const registrationWrite = (sql) => /^\s*INSERT INTO users\b/i.test(sql);

async function callback(t, f, claims) {
  const fetchRequest = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, init) => {
    if (String(url) === `${issuer}/token`) return Promise.resolve(Response.json({ access_token: "linking-token", token_type: "Bearer" }));
    if (String(url) === `${issuer}/userinfo`) return Promise.resolve(Response.json(claims));
    return fetchRequest(url, init);
  });
  const start = await fetchRequest(`${f.baseUrl}/api/auth/sso/start`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  assert.equal(start.status, 303);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = start.headers.getSetCookie()[0].split(";")[0];
  return fetchRequest(`${f.baseUrl}/api/auth/sso/callback?state=${encodeURIComponent(state)}&code=linking-code`, {
    headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(10000),
  });
}
const claimsFor = (extra = {}) => ({ sub: profile.subject, email: profile.email, name: profile.name, preferred_username: profile.preferredUsername, ...extra });
const sessionCookie = (response) => response.headers.getSetCookie().find((value) => value.startsWith("iris_session="))?.split(";")[0];

async function assertCallbackRefused(f, response) {
  assert.equal(response.status, 303);
  assert.equal(sessionCookie(response), undefined, "refused callback must not issue an authenticated session cookie");
  assert.ok(new URL(response.headers.get("location"), f.baseUrl).searchParams.has("auth_error"));
  assert.deepEqual(await actions(f), ["auth.login_failed"]);
}

for (const [label, claim, allowed] of [
  ["missing", {}, false], ["false", { email_verified: false }, false],
  ["string true", { email_verified: "true" }, false], ["number one", { email_verified: 1 }, false],
  ["boolean true", { email_verified: true }, true],
]) {
  test(`email-matched callback accepts only literal verified email: ${label}`, options, async (t) => {
    const f = await serverFixture(t, oauthEnv);
    const user = await createUser(f, { oidc_link_pending: true, email: "Alice@Example.TEST" });
    const response = await callback(t, f, claimsFor({ email: "  ALICE@EXAMPLE.TEST  ", ...claim }));
    if (!allowed) {
      await assertCallbackRefused(f, response);
      assert.deepEqual(await rowFor(f, user.id), user, "unverified callback must leave the local account untouched");
      return;
    }
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    const session = await f.request("/api/auth/session", { cookie: sessionCookie(response) });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.id, user.id);
    const linked = await rowFor(f, user.id);
    assert.equal(linked.oidc_subject, profile.subject);
    assert.equal(linked.session_version, 1);
    assert.deepEqual(await actions(f), ["user.oidc_linked", "auth.login_succeeded"]);
  });
}

for (const [label, claim] of [
  ["missing", {}], ["false", { emailVerified: false }],
  ["string true", { emailVerified: "true" }], ["number one", { emailVerified: 1 }],
]) {
  test(`internal email-matched linking refuses emailVerified ${label}`, options, async (t) => {
    const f = await serverFixture(t, oauthEnv);
    const user = await createUser(f, { oidc_link_pending: true });
    await assert.rejects(f.app.userFromOAuthProfile({ ...profile, ...claim }));
    assert.deepEqual(await rowFor(f, user.id), user);
    assert.deepEqual(await actions(f), []);
  });
}

test("verified linking drops the password, consumes the window and revokes live sessions before its single audit", options, async (t) => {
  const f = await serverFixture(t, oauthEnv);
  const user = await createUser(f, { oidc_link_pending: true });
  const oldCookie = f.cookieFor(user);
  const ws = new WebSocket(`${f.baseUrl.replace("http:", "ws:")}/api/collab`, { headers: { cookie: oldCookie } });
  t.after(() => ws.terminate());
  const [raw] = await once(ws, "message", { signal: AbortSignal.timeout(5000) });
  const ready = JSON.parse(raw);
  assert.equal(ready.t, "ready");
  const live = [...f.app.collabSessions].find((entry) => entry.id === ready.sessionId);
  assert.ok(live);
  await f.pool.query("UPDATE users SET password_change_required = TRUE WHERE id = $1", [user.id]);
  const gate = pauseQuery(f, (sql, params) => sql.includes("INSERT INTO audit_events") && params.includes("user.oidc_linked"));
  const pending = settled(f.app.userFromOAuthProfile(verified));
  try {
    await gate.wait(pending);
    assert.equal(f.app.collabSessions.has(live), false);
    assert.notEqual(live.socket.readyState, WebSocket.OPEN);
    assert.equal((await f.request("/api/auth/session", { cookie: oldCookie })).status, 401);
  } finally { gate.release(); await pending; }
  assert.equal((await pending).user?.id, user.id);
  const linked = await rowFor(f, user.id);
  assert.equal(linked.auth_source, "oidc");
  assert.equal(linked.oidc_issuer, issuer);
  assert.equal(linked.oidc_subject, profile.subject);
  assert.equal(linked.password_hash, null);
  assert.equal(linked.password_change_required, false);
  assert.equal(linked.oidc_link_pending, false);
  assert.ok(linked.oidc_linked_at instanceof Date);
  assert.equal(linked.session_version, 1);
  await f.app.userFromOAuthProfile(profile);
  assert.deepEqual(await rowFor(f, user.id), linked, "returning identity must not link or bump the version again");
  assert.deepEqual(await actions(f), ["user.oidc_linked"]);
});

test("known issuer/subject signs in without verification even when its new email belongs to a local account", options, async (t) => {
  const f = await serverFixture(t, oauthEnv);
  const known = await createUser(f, { auth_source: "oidc", oidc_issuer: issuer, oidc_subject: profile.subject });
  const other = await createUser(f, { username: "other", email: "changed@example.test", oidc_link_pending: true });
  const user = await f.app.userFromOAuthProfile({ ...profile, email: other.email, name: "Updated Alice" });
  assert.equal(user.id, known.id);
  assert.equal(user.display_name, "Updated Alice");
  assert.equal(user.email, profile.email);
  assert.equal(user.session_version, 0);
  const cookie = `iris_session=${f.app.makeToken(user, "sso")}`;
  assert.equal((await f.request("/api/auth/session", { cookie })).status, 200);
  assert.deepEqual(await rowFor(f, other.id), other);
  assert.deepEqual(await actions(f), []);
  // Verification is a linking precondition, not a blanket userinfo refusal.
  const response = await callback(t, f, claimsFor({ email: other.email, name: "Updated Alice" }));
  assert.equal(response.headers.get("location"), "/");
  const session = await f.request("/api/auth/session", { cookie: sessionCookie(response) });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.id, known.id);
  assert.deepEqual(await actions(f), ["auth.login_succeeded"]);
});

test("known issuer/subject with local auth source cannot sign in or update the account profile", options, async (t) => {
  const f = await serverFixture(t, oauthEnv);
  const user = await createUser(f, { oidc_issuer: issuer, oidc_subject: profile.subject });
  const response = await callback(t, f, claimsFor({ email_verified: true, name: "Must not update" }));
  await assertCallbackRefused(f, response);
  assert.deepEqual(await rowFor(f, user.id), user);
});

for (const [label, fields, error] of [
  ["closed admin window", {}, { errorCode: "AUTH_SSO_LINK_REQUIRED" }],
  ["pending account", { oidc_link_pending: true, status: "pending" }, inactiveErrors.pending],
  ["disabled account", { oidc_link_pending: true, status: "disabled" }, inactiveErrors.disabled],
  ["previous issuer alone", { oidc_link_pending: true, oidc_issuer: otherIssuer }],
  ["previous subject alone", { oidc_link_pending: true, oidc_subject: "previous-subject" }],
  ["previous complete binding", { oidc_link_pending: true, auth_source: "oidc", oidc_issuer: otherIssuer, oidc_subject: "previous-subject" }],
]) {
  test(`verified email cannot bypass ${label}`, options, async (t) => {
    const f = await serverFixture(t, oauthEnv);
    const user = await createUser(f, fields);
    await assert.rejects(f.app.userFromOAuthProfile(verified), error);
    assert.deepEqual(await rowFor(f, user.id), user);
    assert.deepEqual(await actions(f), []);
  });
}

for (const [label, change] of [
  ["admin window closure", "oidc_link_pending = FALSE"],
  ["email change", "email = 'changed@example.test'"],
  ["disable without a version change", "status = 'disabled'"],
  ["session version change", "session_version = session_version + 1"],
  ["issuer binding", "oidc_issuer = 'https://other-idp.example.test'"],
  ["subject binding", "oidc_subject = 'other-subject'"],
  ["auth-source change", "auth_source = 'oidc'"],
]) {
  test(`link write refuses a stale lookup after ${label}`, options, async (t) => {
    const f = await serverFixture(t, oauthEnv);
    const user = await createUser(f, { oidc_link_pending: true });
    const gate = pauseQuery(f, linkWrite);
    const pending = settled(f.app.userFromOAuthProfile(verified));
    let changed;
    try {
      await gate.wait(pending);
      // Change one precondition at a time so a different CAS guard cannot mask it.
      changed = (await f.pool.query(`UPDATE users SET ${change} WHERE id = $1 RETURNING *`, [user.id])).rows[0];
    } finally { gate.release(); await pending; }
    assert.ok((await pending).error, "stale callback must be refused");
    assert.deepEqual(await rowFor(f, user.id), changed, "stale link must not overwrite the concurrent change");
    assert.deepEqual(await actions(f), []);
  });
}

test("a password reset through the admin handler survives an already-looked-up SSO callback", options, async (t) => {
  const f = await serverFixture(t, oauthEnv);
  const admin = await createUser(f, { username: "admin", email: "admin@example.test", system_role: "admin" });
  const user = await createUser(f, { oidc_link_pending: true });
  const gate = pauseQuery(f, linkWrite);
  const pending = settled(callback(t, f, claimsFor({ email_verified: true })));
  let resetRow;
  let temporaryPassword;
  try {
    await gate.wait(pending);
    const response = await f.request(`/api/admin/users/${user.id}/reset-password`, { method: "POST", cookie: f.cookieFor(admin) });
    assert.equal(response.status, 200);
    temporaryPassword = (await response.json()).temporaryPassword;
    resetRow = await rowFor(f, user.id);
  } finally { gate.release(); await pending; }
  const response = (await pending).user;
  assert.equal(sessionCookie(response), undefined, "reset must prevent the stale callback issuing a session");
  assert.deepEqual(await rowFor(f, user.id), resetRow);
  assert.equal(await argon2.verify(resetRow.password_hash, temporaryPassword), true);
  assert.deepEqual(await actions(f), ["user.password_reset", "auth.login_failed"]);
});

for (const [label, subject, status, email] of [
  ["same identity", profile.subject, "active", profile.email],
  ["different identity", "winner-subject", "active", profile.email],
  ["same identity with changed email", profile.subject, "active", "changed@example.test"],
  ["same identity now pending", profile.subject, "pending", profile.email],
  ["same identity now disabled", profile.subject, "disabled", profile.email],
]) {
  test(`parallel linking preserves the ${label} winner without a second mutation or audit`, options, async (t) => {
    const f = await serverFixture(t, oauthEnv);
    const user = await createUser(f, { oidc_link_pending: true });
    const gate = pauseQuery(f, linkWrite);
    const pending = settled(f.app.userFromOAuthProfile(verified));
    let winner;
    try {
      await gate.wait(pending);
      assert.equal((await f.app.userFromOAuthProfile({ ...verified, subject })).id, user.id);
      await f.pool.query("UPDATE users SET status = $2, email = $3 WHERE id = $1", [user.id, status, email]);
      winner = await rowFor(f, user.id);
    } finally { gate.release(); await pending; }
    const result = await pending;
    if (status !== "active") {
      assert.ok(result.error, "inactive winner must not authenticate");
    } else if (subject !== profile.subject) {
      assert.ok(result.error, "losing subject must not adopt the winner's account");
    } else if (!result.error) {
      // A stale link may fail closed. If it recovers a same-identity winner,
      // it must return that identity's current row without another mutation.
      assert.equal(result.user?.id, user.id, result.error?.message);
      assert.equal(result.user.email, email, "recovery must read the durable identity's current row");
      assert.equal(result.user.session_version, 1);
    }
    assert.deepEqual(await rowFor(f, user.id), winner);
    assert.equal(winner.session_version, 1);
    assert.deepEqual(await actions(f), ["user.oidc_linked"]);
  });
}

for (const [label, fields] of [
  ["local email", {}],
  ["different subject", { auth_source: "oidc", oidc_issuer: issuer, oidc_subject: "other-subject" }],
  ["different issuer", { auth_source: "oidc", oidc_issuer: otherIssuer, oidc_subject: profile.subject }],
  ["same identity with local auth source", { oidc_issuer: issuer, oidc_subject: profile.subject }],
  ["username only", { username: profile.preferredUsername, email: "other@example.test" }],
]) {
  test(`registration unique conflict with ${label} cannot authenticate the concurrent account`, options, async (t) => {
    const f = await serverFixture(t, oauthEnv);
    const gate = pauseQuery(f, registrationWrite);
    const pending = settled(callback(t, f, claimsFor({ email_verified: true })));
    let winner;
    try {
      await gate.wait(pending);
      winner = await createUser(f, { username: "winner", ...fields });
    } finally { gate.release(); await pending; }
    assert.equal((await pending).error, undefined);
    await assertCallbackRefused(f, (await pending).user);
    assert.deepEqual(await rowFor(f, winner.id), winner);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n, 1);
  });
}

for (const status of ["active", "pending", "disabled"]) {
  for (const email of [profile.email, "changed@example.test"]) {
    test(`parallel provisioning recovers only the ${status} durable identity with ${email === profile.email ? "same" : "changed"} email`, options, async (t) => {
      const f = await serverFixture(t, { ...oauthEnv, OAUTH_APPROVAL_REQUIRED: String(status === "pending") });
      const gate = pauseQuery(f, registrationWrite);
      const pending = settled(f.app.userFromOAuthProfile(profile));
      let winner;
      try {
        await gate.wait(pending);
        // Distinct usernames isolate email/issuer-subject conflicts from the
        // username-only collision covered above.
        const provisioned = settled(f.app.userFromOAuthProfile({ ...profile, email, preferredUsername: "winner" }));
        if (status === "pending") assert.equal((await provisioned).error?.errorCode, "AUTH_ACCOUNT_PENDING");
        else assert.ok((await provisioned).user);
        winner = (await f.pool.query("SELECT * FROM users")).rows[0];
        if (status === "disabled") {
          await f.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [winner.id]);
          winner = await rowFor(f, winner.id);
        }
      } finally { gate.release(); await pending; }
      const result = await pending;
      if (status === "active") {
        assert.equal(result.user?.id, winner.id, result.error?.message);
        assert.equal(result.user.auth_source, "oidc");
        assert.equal(result.user.email, email);
      } else {
        assert.ok(result.error);
        for (const [key, value] of Object.entries(inactiveErrors[status])) assert.equal(result.error[key], value);
      }
      assert.deepEqual((await f.pool.query("SELECT * FROM users")).rows, [winner]);
      assert.equal(winner.oidc_issuer, issuer);
      assert.equal(winner.oidc_subject, profile.subject);
      assert.equal(winner.session_version, 0);
      assert.deepEqual(await actions(f), ["user.created"]);
    });
  }
}
