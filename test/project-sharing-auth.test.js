const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const WebSocket = require("ws");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");

const options = { skip: !connectionString, timeout: 20000 };
const projectLock = "SELECT pg_advisory_xact_lock(4952, hashtext($1))";

async function within(promise, label, ms = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Sharing barrier timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Hooks only pause real, existing I/O boundaries; they never replace SQL results.
function pauseAt(f, names, matches) {
  const reached = deferred(), release = deferred();
  const clear = () => names.forEach((name) => { if (f.hooks[name] === hook) delete f.hooks[name]; });
  const hook = async (...args) => {
    if (!matches(...args)) return;
    clear();
    reached.resolve();
    await release.promise;
  };
  names.forEach((name) => { f.hooks[name] = hook; });
  return {
    wait: (pending) => within(Promise.race([reached.promise, pending.then((res) => {
      throw new Error(`Request completed before existing I/O pause: HTTP ${res.status}`);
    })]), "existing I/O pause"),
    release: () => { clear(); release.resolve(); },
  };
}

function preflight(f, route, actor = f.actor, id = f.id) {
  return pauseAt(f, ["afterQuery"], (sql, params) => params?.[0] === id && (route === "owner"
    ? sql.includes("JOIN project_members m") && params[1] === actor.id
    : sql.startsWith("SELECT id, name, storage_path FROM projects")));
}

async function transaction(f) {
  const client = await f.pool.connect();
  try { await client.query("BEGIN"); }
  catch (err) { client.release(true); throw err; }
  let closed = false;
  return {
    client, pid: client.processID,
    async finish(commit = false) {
      if (closed) return;
      closed = true;
      try { await within(client.query(commit ? "COMMIT" : "ROLLBACK"), "external transaction release"); }
      catch (err) { client.release(true); throw err; }
      client.release();
    },
  };
}

// An early HTTP response is evidence too: baseline POST has no project lock,
// and baseline PATCH/DELETE have no requester lock. Never wait for future SQL.
async function waitOrResponse(observer, pending, blocker, exclude = []) {
  let settled, failure;
  pending.then((response) => { settled = response; }, (err) => { failure = err; });
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    if (failure) throw failure;
    if (settled) return { kind: "response", status: settled.status };
    // The observer may itself hold an open transaction. Refresh its activity
    // snapshot so newly connected backends and their current queries are visible.
    await observer.query("SELECT pg_stat_clear_snapshot()");
    const { rows } = await observer.query(
      `SELECT pid, query, wait_event FROM pg_stat_activity
       WHERE $1::int = ANY(pg_blocking_pids(pid)) AND NOT (pid = ANY($2::int[]))`,
      [blocker, exclude]
    );
    if (rows.length) return { kind: "blocked", ...rows[0] };
    await delay(5);
  }
  throw new Error("Neither a PostgreSQL lock wait nor an HTTP response was observed");
}

async function user(f, username, role = "regular") {
  return (await f.pool.query(
    `INSERT INTO users (id, username, email, display_name, system_role, password_hash)
     VALUES ($1, $2, $3, $2, $4, 'unused-test-hash') RETURNING *`,
    [uuidv7(), username, `${username}@example.test`, role]
  )).rows[0];
}

async function project(f) {
  const id = uuidv7();
  await f.pool.query("INSERT INTO projects (id, name, storage_path) VALUES ($1, 'Sharing', $2)", [id, `projects/${id}`]);
  return id;
}

async function member(f, who, role, id = f.id) {
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)", [id, who.id, role]);
}

async function setup(t, { route = "owner", method = "PATCH", actorMember = true } = {}) {
  const f = await serverFixture(t, { COLLAB_HEARTBEAT_MS: "60000" });
  f.actor = await user(f, "actor", route === "admin" ? "admin" : "regular");
  f.other = await user(f, "other", "admin");
  f.target = await user(f, "target");
  f.id = await project(f);
  if (actorMember) await member(f, f.actor, "owner");
  await member(f, f.other, "owner");
  if (method !== "POST") await member(f, f.target, "editor");
  return f;
}

function mutate(f, route, method, { actor = f.actor, target = f.target, id = f.id, role = "viewer", cookie } = {}) {
  return f.request(`/api/${route === "admin" ? "admin/" : ""}projects/${id}/members${method === "POST" ? "" : `/${target.id}`}`, {
    method, cookie: cookie || f.cookieFor(actor),
    ...(method === "DELETE" ? {} : { body: method === "POST"
      ? { userId: target.id, identifier: target.username, role } : { role } }),
  });
}

async function membership(f, who = f.target, id = f.id) {
  return (await f.pool.query("SELECT role, invited_by FROM project_members WHERE project_id = $1 AND user_id = $2", [id, who.id])).rows[0] || null;
}

async function successAudits(f, actor = f.actor, id = f.id) {
  return (await f.pool.query(
    "SELECT action FROM audit_events WHERE target_id = $1 AND actor_id = $2 AND target_type = 'membership' ORDER BY action",
    [id, actor.id]
  )).rows.map((row) => row.action);
}

async function denied(f, response, status, errorCode, before, who = f.target, extra = {}) {
  const body = await response.json();
  assert.deepEqual({
    status: response.status, errorCode: body.errorCode,
    membership: await membership(f, who), successAudits: await successAudits(f), ...extra.actual,
  }, { status, errorCode, membership: before, successAudits: [], ...extra.expected });
}

// Catches trusting the owner's preflight permission after a competing member
// mutation wins the real project-lock queue. POST must join that queue too.
for (const method of ["POST", "PATCH", "DELETE"]) {
  for (const change of ["removed", "demoted"]) {
    test(`owner ${method}: ${change} requester loses to the first queued owner/admin mutation`, options, async (t) => {
      const f = await setup(t, { method });
      const before = await membership(f);
      const gate = preflight(f, "owner");
      const hold = await transaction(f);
      let winner, waiting;
      const pending = mutate(f, "owner", method);
      try {
        await gate.wait(pending);
        await hold.client.query(projectLock, [f.id]);
        winner = mutate(f, change === "removed" ? "owner" : "admin", change === "removed" ? "DELETE" : "PATCH", {
          actor: f.other, target: f.actor, role: "editor",
        });
        const first = await waitOrResponse(hold.client, winner, hold.pid);
        assert.equal(first.kind, "blocked", "the winning mutation must really wait on the held project");
        gate.release();
        waiting = await waitOrResponse(hold.client, pending, hold.pid, [first.pid]);
        await hold.finish(true);
        assert.equal((await within(winner, "winning mutation")).status, 200);
      } finally {
        gate.release();
        await hold.finish();
        await within(Promise.all([pending, winner]), "owner requests settle");
      }
      t.diagnostic(`requester behind winner: ${JSON.stringify(waiting)}`);
      await denied(f, await pending, change === "removed" ? 404 : 403,
        change === "removed" ? "PROJECT_NOT_FOUND" : "PROJECT_FORBIDDEN", before);
    });
  }
}

// Catches trusting the initial server role, including when project ownership
// remains valid. A writer that acquired users first must be read after commit.
for (const method of ["POST", "PATCH", "DELETE"]) {
  test(`admin ${method}: user-row-first demotion denies even a project owner`, options, async (t) => {
    const f = await setup(t, { route: "admin", method });
    const before = await membership(f);
    const hold = await transaction(f);
    let pending, observed;
    try {
      await hold.client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [f.actor.id]);
      await hold.client.query("UPDATE users SET system_role = 'regular' WHERE id = $1", [f.actor.id]);
      pending = mutate(f, "admin", method);
      observed = await waitOrResponse(hold.client, pending, hold.pid);
      await hold.finish(true);
    } finally {
      await hold.finish();
      if (pending) await within(pending, "admin request settles");
    }
    t.diagnostic(`demotion writer first: ${JSON.stringify(observed)}`);
    await denied(f, await pending, 403, "ADMIN_REQUIRED", before);
  });
}

const sessionChanges = [
  { name: "disable", route: "owner", method: "POST", status: 401, code: "NOT_AUTHENTICATED" },
  { name: "password reset", route: "admin", method: "PATCH", status: 401, code: "NOT_AUTHENTICATED" },
  { name: "version revocation", route: "owner", method: "DELETE", status: 401, code: "NOT_AUTHENTICATED" },
  { name: "requester deletion", route: "admin", method: "DELETE", status: 401, code: "NOT_AUTHENTICATED" },
  { name: "forced password change", route: "owner", method: "PATCH", status: 403, code: "PASSWORD_CHANGE_REQUIRED" },
];
for (const row of sessionChanges) {
  test(`${row.route} ${row.method}: ${row.name} after preflight invalidates the original session`, options, async (t) => {
    const f = await setup(t, row);
    const before = await membership(f);
    const gate = preflight(f, row.route);
    const pending = mutate(f, row.route, row.method);
    try {
      await gate.wait(pending);
      if (row.name === "disable" || row.name === "password reset") {
        const reset = row.name === "password reset";
        const changed = await f.request(`/api/admin/users/${f.actor.id}${reset ? "/reset-password" : ""}`, {
          method: reset ? "POST" : "PATCH", cookie: f.cookieFor(f.other),
          ...(reset ? {} : { body: { status: "disabled" } }),
        });
        assert.equal(changed.status, 200);
      } else {
        const sql = row.name === "version revocation" ? "UPDATE users SET session_version = session_version + 1 WHERE id = $1"
          : row.name === "requester deletion" ? "DELETE FROM users WHERE id = $1"
            : "UPDATE users SET password_change_required = TRUE WHERE id = $1";
        await f.pool.query(sql, [f.actor.id]);
      }
    } finally {
      gate.release();
      await within(pending, "revoked request settles");
    }
    await denied(f, await pending, row.status, row.code, before);
  });
}

test("session-version writer first is reread after an actual requester-row wait", options, async (t) => {
  const f = await setup(t, { method: "POST" });
  const hold = await transaction(f);
  let pending;
  try {
    await hold.client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [f.actor.id]);
    await hold.client.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [f.actor.id]);
    pending = mutate(f, "owner", "POST");
    assert.equal((await waitOrResponse(hold.client, pending, hold.pid)).kind, "blocked");
    await hold.finish(true);
  } finally {
    await hold.finish();
    if (pending) await within(pending, "writer-first session request settles");
  }
  await denied(f, await pending, 401, "NOT_AUTHENTICATED", null);
});

for (const route of ["owner", "admin"]) {
  test(`${route} POST: target-row wait preserves the route's current active-account policy`, options, async (t) => {
    const f = await setup(t, { route, method: "POST", actorMember: route !== "admin" });
    const hold = await transaction(f);
    let pending;
    try {
      await hold.client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [f.target.id]);
      await hold.client.query("UPDATE users SET status = 'disabled' WHERE id = $1", [f.target.id]);
      pending = mutate(f, route, "POST");
      assert.equal((await waitOrResponse(hold.client, pending, hold.pid)).kind, "blocked");
      await hold.finish(true);
    } finally {
      await hold.finish();
      if (pending) await within(pending, "target account wait settles");
    }
    if (route === "owner") await denied(f, await pending, 404, "MEMBER_USER_NOT_FOUND", null);
    else {
      assert.equal((await pending).status, 201);
      assert.deepEqual(await membership(f), { role: "viewer", invited_by: f.actor.id });
      assert.deepEqual(await successAudits(f), ["project.shared"]);
    }
  });
}

for (const change of ["removed", "editor", "viewer"]) {
  test(`self-leave: requester ${change} during preflight is checked with read capability`, options, async (t) => {
    const f = await setup(t);
    const gate = preflight(f, "owner");
    const pending = mutate(f, "owner", "DELETE", { target: f.actor });
    try {
      await gate.wait(pending);
      assert.equal((await mutate(f, "owner", change === "removed" ? "DELETE" : "PATCH", {
        actor: f.other, target: f.actor, role: change,
      })).status, 200);
    } finally {
      gate.release();
      await within(pending, "self-leave settles");
    }
    if (change === "removed") await denied(f, await pending, 404, "PROJECT_NOT_FOUND", null, f.actor);
    else {
      assert.equal((await pending).status, 200);
      assert.equal(await membership(f, f.actor), null);
      assert.deepEqual(await successAudits(f), ["project.left"]);
    }
  });
}

// Real waits, deterministic clock: advancing only Date.now preserves monotonic
// polling/cleanup deadlines and avoids slow or timing-sensitive expiry sleeps.
for (const wait of ["requester row", "project advisory", "target membership", "INSERT project FK"]) {
  test(`expiry during ${wait} wait rejects and rolls back sharing`, options, async (t) => {
    const method = wait === "requester row" || wait === "INSERT project FK" ? "POST" : "PATCH";
    const f = await setup(t, { method });
    const before = await membership(f);
    let now = Math.floor(Date.now() / 1000);
    const exp = now + 60;
    t.mock.method(Date, "now", () => now * 1000);
    const hold = await transaction(f);
    let pending, observed;
    try {
      if (wait === "requester row") await hold.client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [f.actor.id]);
      if (wait === "project advisory") await hold.client.query(projectLock, [f.id]);
      if (wait === "target membership") await hold.client.query("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE", [f.id, f.target.id]);
      if (wait === "INSERT project FK") await hold.client.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [f.id]);
      pending = mutate(f, "owner", method, { cookie: f.cookieFor(f.actor, { exp }) });
      observed = await waitOrResponse(hold.client, pending, hold.pid);
      assert.equal(observed.kind, "blocked", "expiry must cross a real PostgreSQL lock wait");
      if (wait === "INSERT project FK") assert.match(observed.query, /^INSERT INTO project_members/, "the later wait must occur in DML");
      now = exp;
      await hold.finish(true);
    } finally {
      await hold.finish();
      if (pending) await within(pending, "expired request settles");
    }
    t.diagnostic(`expiry wait: ${JSON.stringify(observed)}`);
    await denied(f, await pending, 401, "NOT_AUTHENTICATED", before);
  });
}

test("expiry during an INSERT duplicate-key wait takes precedence over the target conflict", options, async (t) => {
  const f = await setup(t, { method: "POST" });
  let now = Math.floor(Date.now() / 1000);
  const exp = now + 60;
  t.mock.method(Date, "now", () => now * 1000);
  const hold = await transaction(f);
  let pending;
  try {
    await hold.client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [f.id, f.target.id]);
    pending = mutate(f, "owner", "POST", { cookie: f.cookieFor(f.actor, { exp }) });
    const observed = await waitOrResponse(hold.client, pending, hold.pid);
    assert.equal(observed.kind, "blocked");
    assert.match(observed.query, /^INSERT INTO project_members/);
    now = exp;
    await hold.finish(true);
  } finally {
    await hold.finish();
    if (pending) await within(pending, "expired duplicate request settles");
  }
  await denied(f, await pending, 401, "NOT_AUTHENTICATED", { role: "editor", invited_by: null });
});

// Catches a final check placed before the current-member wait. Requester
// membership is deliberately changed while the handler is blocked on its target.
test("requester permission is reread after the target-membership lock wait", options, async (t) => {
  const f = await setup(t);
  const before = await membership(f);
  const hold = await transaction(f);
  let pending;
  try {
    await hold.client.query("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE", [f.id, f.target.id]);
    pending = mutate(f, "owner", "PATCH");
    assert.equal((await waitOrResponse(hold.client, pending, hold.pid)).kind, "blocked");
    await hold.client.query("UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2", [f.id, f.actor.id]);
    await hold.finish(true);
  } finally {
    await hold.finish();
    if (pending) await within(pending, "target wait request settles");
  }
  await denied(f, await pending, 403, "PROJECT_FORBIDDEN", before);
});

for (const row of [
  { route: "owner", method: "PATCH", targetError: "missing", status: 403, code: "PROJECT_FORBIDDEN" },
  { route: "admin", method: "DELETE", targetError: "missing", status: 403, code: "ADMIN_REQUIRED" },
  { route: "owner", method: "POST", targetError: "missing user", status: 403, code: "PROJECT_FORBIDDEN" },
  { route: "owner", method: "POST", targetError: "external owner", status: 403, code: "PROJECT_FORBIDDEN" },
  { route: "admin", method: "POST", targetError: "duplicate", status: 403, code: "ADMIN_REQUIRED" },
]) {
  test(`${row.route} ${row.method}: ${row.targetError} target cannot bypass the final requester gate`, options, async (t) => {
    const f = await setup(t, row);
    if (row.targetError === "missing") await f.pool.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [f.id, f.target.id]);
    if (row.targetError === "missing user") await f.pool.query("DELETE FROM users WHERE id = $1", [f.target.id]);
    if (row.targetError === "duplicate") await member(f, f.target, "editor");
    if (row.targetError === "external owner") await f.pool.query("UPDATE users SET system_role = 'external' WHERE id = $1", [f.target.id]);
    const before = await membership(f);
    const gate = preflight(f, row.route);
    const pending = mutate(f, row.route, row.method, { role: row.targetError === "external owner" ? "owner" : "viewer" });
    try {
      await gate.wait(pending);
      await f.pool.query(row.route === "admin" ? "UPDATE users SET system_role = 'regular' WHERE id = $1"
        : "UPDATE project_members SET role = 'viewer' WHERE user_id = $1", [f.actor.id]);
    } finally {
      gate.release();
      await within(pending, "target error request settles");
    }
    await denied(f, await pending, row.status, row.code, before);
  });
}

for (const route of ["owner", "admin"]) {
  test(`${route} PATCH: a project deleted after preflight is PROJECT_NOT_FOUND`, options, async (t) => {
    const f = await setup(t, { route });
    const gate = preflight(f, route);
    const pending = mutate(f, route, "PATCH");
    try {
      await gate.wait(pending);
      await f.pool.query("DELETE FROM projects WHERE id = $1", [f.id]);
    } finally {
      gate.release();
      await within(pending, "deleted project request settles");
    }
    await denied(f, await pending, 404, "PROJECT_NOT_FOUND", null);
  });
}

test("requester SHARE-first makes a later session-version writer wait until sharing commits", options, async (t) => {
  const f = await setup(t);
  const hold = await transaction(f);
  let pending, writer, observed;
  try {
    await hold.client.query(projectLock, [f.id]);
    pending = mutate(f, "owner", "PATCH");
    const sharing = await waitOrResponse(hold.client, pending, hold.pid);
    assert.equal(sharing.kind, "blocked");
    writer = f.pool.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [f.actor.id]);
    observed = await waitOrResponse(hold.client, writer, sharing.pid);
    await hold.finish(true);
  } finally {
    await hold.finish();
    await within(Promise.all([pending, writer]), "SHARE-first operations settle");
  }
  assert.equal((await pending).status, 200);
  assert.equal((await membership(f)).role, "viewer");
  assert.equal((await f.request("/api/auth/session", { cookie: f.cookieFor(f.actor) })).status, 401);
  assert.equal(observed.kind, "blocked", "a version writer must not overtake sharing after its requester lock");
});

test("admin self-add protects the shared requester/target ID against a non-key account writer", options, async (t) => {
  const f = await setup(t, { route: "admin", method: "POST", actorMember: false });
  const hold = await transaction(f);
  let pending, writer, sharing, account;
  try {
    await hold.client.query(projectLock, [f.id]);
    pending = mutate(f, "admin", "POST", { target: f.actor });
    sharing = await waitOrResponse(hold.client, pending, hold.pid);
    // KEY SHARE alone permits this non-key UPDATE. When both references are the
    // same user, the requester protection must still hold it off until commit.
    writer = f.pool.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [f.actor.id]);
    account = await waitOrResponse(hold.client, writer, sharing.pid || hold.pid);
    await hold.finish(true);
  } finally {
    await hold.finish();
    await within(Promise.all([pending, writer]), "same-ID sharing and account writer settle");
  }
  assert.deepEqual({ status: (await pending).status, projectWait: sharing.kind, accountWait: account.kind,
    membership: await membership(f, f.actor) }, {
    status: 201, projectWait: "blocked", accountWait: "blocked",
    membership: { role: "viewer", invited_by: f.actor.id },
  });
  assert.equal((await f.request("/api/auth/session", { cookie: f.cookieFor(f.actor) })).status, 401);
});

test("the same requester can commit on an independent project while its first project is locked", options, async (t) => {
  const f = await setup(t);
  const second = await project(f);
  await member(f, f.actor, "owner", second);
  await member(f, f.target, "editor", second);
  const hold = await transaction(f);
  let pending, independent;
  try {
    await hold.client.query(projectLock, [f.id]);
    pending = mutate(f, "owner", "PATCH");
    assert.equal((await waitOrResponse(hold.client, pending, hold.pid)).kind, "blocked");
    independent = mutate(f, "owner", "PATCH", { id: second });
    assert.equal((await within(independent, "independent project progress", 2000)).status, 200);
    assert.equal((await membership(f, f.target, second)).role, "viewer");
    assert.equal((await membership(f)).role, "editor");
  } finally {
    await hold.finish();
    await within(Promise.all([pending, independent]), "independent requests settle");
  }
  assert.equal((await pending).status, 200);
});

for (const reference of ["invited_by", "target"]) {
  for (const first of ["conversion", "add"]) {
    test(`external conversion versus add: ${reference} reference, ${first} acquires first`, options, async (t) => {
      const f = await setup(t, { method: "POST" });
      const converted = reference === "invited_by" ? f.actor : f.target;
      const convert = () => f.request(`/api/admin/users/${converted.id}`, {
        method: "PATCH", cookie: f.cookieFor(f.other), body: { role: "external" },
      });
      let gate, conversion, adding, observed;
      try {
        if (first === "conversion") {
          if (reference === "target") await member(f, f.target, "owner");
          gate = pauseAt(f, ["afterClientQuery"], (sql, params) => sql.startsWith("SELECT project_id FROM project_members") && params[0] === converted.id);
          conversion = convert();
          await gate.wait(conversion); // conversion owns users(FOR UPDATE), and has recorded this project
          if (reference === "target") {
            // Make INSERT feasible while conversion still intends to lock this
            // project: a target already present would only exercise duplicate409.
            assert.equal((await mutate(f, "owner", "DELETE", { actor: f.other })).status, 200);
          }
          const locking = await f.pool.query(
            `SELECT pid FROM pg_stat_activity WHERE state = 'idle in transaction'
             AND query LIKE 'SELECT project_id FROM project_members%'
             AND pid IN (SELECT pid FROM pg_locks WHERE relation = 'users'::regclass)`
          );
          assert.equal(locking.rows.length, 1);
          adding = mutate(f, "owner", "POST", { role: reference === "target" ? "owner" : "viewer" });
          observed = await waitOrResponse(f.pool, adding, locking.rows[0].pid);
          assert.equal(observed.kind, "blocked", "add must actually encounter the conversion's user lock");
        } else {
          // This INSERT boundary exists on RED too. GREEN must already protect
          // both user references and the project when arriving here.
          gate = pauseAt(f, ["beforeQuery", "beforeClientQuery"], (sql) => sql.startsWith("INSERT INTO project_members"));
          adding = mutate(f, "owner", "POST");
          await gate.wait(adding);
          conversion = convert();
          // No future-lock hook: detect conversion's actual lock wait, or its
          // incorrect successful response while add is paused before INSERT.
          let done = false;
          conversion.then(() => { done = true; }, () => { done = true; });
          const deadline = performance.now() + 2000;
          do {
            const { rows } = await f.pool.query(
              `SELECT pid, query, wait_event FROM pg_stat_activity
               WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE '%FROM users%FOR UPDATE%'
               AND pid IN (SELECT pid FROM pg_locks WHERE relation = 'users'::regclass)`
            );
            if (rows.length) { observed = { kind: "blocked", ...rows[0] }; break; }
            if (done) { observed = { kind: "response", status: (await conversion).status }; break; }
            await delay(5);
          } while (performance.now() < deadline);
          assert.ok(observed, "conversion must either wait on users or complete");
        }
      } finally {
        gate?.release();
        await within(Promise.all([conversion, adding]), "conversion/add settle without deadlock");
      }
      t.diagnostic(`conversion/add schedule: ${JSON.stringify(observed)}`);
      assert.equal((await conversion).status, 200, "conversion must not fail with a deadlock or lock timeout");
      if (first === "conversion") {
        await denied(f, await adding, reference === "target" ? 409 : 403,
          reference === "target" ? "MEMBER_EXTERNAL_NOT_OWNER" : "PROJECT_FORBIDDEN", null);
      } else {
        assert.equal((await adding).status, 201);
        assert.equal((await membership(f)).role, "viewer");
        assert.equal(observed.kind, "blocked", `${reference} must be protected before add takes the project lock`);
      }
    });
  }
}

// Passing characterization: admin authority does not require membership or grant
// content access. Errors must release clients/locks for the next valid mutation.
for (const route of ["owner", "admin"]) {
  test(`${route} sharing preserves success bodies, audit, duplicate/external and last-owner rules`, options, async (t) => {
    const f = await setup(t, { route, method: "POST", actorMember: route !== "admin" });
    if (route === "admin") assert.equal((await f.request(`/api/projects/${f.id}`, { cookie: f.cookieFor(f.actor) })).status, 404);
    else await f.pool.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [f.id, f.other.id]);
    const soleOwner = route === "admin" ? f.other : f.actor;
    for (const method of ["PATCH", "DELETE"]) {
      const res = await mutate(f, route, method, { target: soleOwner });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).errorCode, "PROJECT_LAST_OWNER");
    }
    await f.pool.query("UPDATE users SET system_role = 'external' WHERE id = $1", [f.target.id]);
    const external = await mutate(f, route, "POST", { role: "owner" });
    assert.equal(external.status, 409);
    assert.equal((await external.json()).errorCode, "MEMBER_EXTERNAL_NOT_OWNER");
    const added = await mutate(f, route, "POST", { role: "editor" });
    assert.equal(added.status, 201);
    const view = (await added.json()).member;
    assert.deepEqual({ userId: view.userId, role: view.role, external: view.external, invitedBy: view.invitedBy },
      { userId: f.target.id, role: "editor", external: true, invitedBy: f.actor.id });
    assert.equal(typeof view.createdAt, "number");
    const duplicate = await mutate(f, route, "POST");
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).errorCode, "MEMBER_ALREADY");
    const promotion = await mutate(f, route, "PATCH", { role: "owner" });
    assert.equal(promotion.status, 409);
    assert.equal((await promotion.json()).errorCode, "MEMBER_EXTERNAL_NOT_OWNER");
    for (const method of ["PATCH", "DELETE"]) {
      const res = await mutate(f, route, method);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    }
    assert.equal(await membership(f), null);
    assert.deepEqual(await successAudits(f), ["project.member_role_changed", "project.shared", "project.unshared"]);
    assert.equal((await membership(f, soleOwner)).role, "owner");
  });
}

async function liveTarget(f) {
  const created = await f.request("/api/projects", { method: "POST", cookie: f.cookieFor(f.actor), body: {
    name: "Live sharing", data: { project: { nodes: [{ id: "main", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: "base" }] } },
  } });
  assert.equal(created.status, 201);
  const out = await created.json();
  f.id = out.project.id;
  await member(f, f.other, "owner");
  await member(f, f.target, "editor");
  const fileId = out.data.project.nodes[0].id;
  const ws = new WebSocket(f.baseUrl.replace("http:", "ws:") + "/api/collab", { headers: { cookie: f.cookieFor(f.target) } });
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw)));
  ws.on("error", () => {});
  const next = async (type) => {
    const deadline = performance.now() + 3000;
    while (!messages.some((m) => m.t === type)) {
      assert.ok(performance.now() < deadline, `WebSocket ${type} not received`);
      await delay(5);
    }
    return messages.splice(messages.findIndex((m) => m.t === type), 1)[0];
  };
  try {
    await next("ready");
    ws.send(JSON.stringify({ t: "project", projectId: f.id }));
    ws.send(JSON.stringify({ t: "open", fileId }));
    await next("opened");
    messages.length = 0;
    return { ws, messages, next, fileId };
  } catch (err) { ws.terminate(); throw err; }
}

for (const authorized of [true, false]) {
  test(`live sharing ${authorized ? "notifies and audits only after COMMIT" : "denial emits no role/revocation success notification"}`, options, async (t) => {
    const f = await setup(t);
    const live = await liveTarget(f);
    const before = await membership(f);
    const gate = authorized ? pauseAt(f, ["beforeClientQuery"], (sql) => sql === "COMMIT") : preflight(f, "owner");
    const pending = mutate(f, "owner", "PATCH");
    try {
      await gate.wait(pending);
      if (!authorized) await f.pool.query("UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2", [f.id, f.actor.id]);
      assert.deepEqual(await membership(f), before, "uncommitted sharing is not visible");
      assert.deepEqual(await successAudits(f), [], "no precommit success audit");
      assert.deepEqual(live.messages.filter((m) => ["role", "revoked"].includes(m.t)), []);
      gate.release();
      const response = await within(pending, "live sharing response");
      if (authorized) {
        assert.equal(response.status, 200);
        assert.deepEqual(await live.next("role"), { t: "role", fileId: live.fileId, role: "viewer" });
        assert.deepEqual(await successAudits(f), ["project.member_role_changed"]);
        assert.equal((await membership(f)).role, "viewer");
      } else {
        // A pong fences already queued server frames without a negative sleep.
        const pong = new Promise((resolve) => live.ws.once("pong", resolve));
        live.ws.ping();
        await within(pong, "WebSocket fence");
        await denied(f, response, 403, "PROJECT_FORBIDDEN", before, f.target, {
          actual: { notifications: live.messages.filter((m) => ["role", "revoked"].includes(m.t)) },
          expected: { notifications: [] },
        });
      }
    } finally {
      gate.release();
      live.ws.terminate();
      await within(pending, "live sharing settles");
    }
  });
}
