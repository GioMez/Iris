const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");
const options = { skip: !connectionString, timeout: 20000 };

async function within(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Deletion barrier timed out")), 4000);
  })]); } finally { clearTimeout(timer); }
}
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, "Deletion condition timed out"); await delay(5); }
}
async function tree(dir, base = "") {
  const out = {};
  for (const entry of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) { out[rel + "/"] = null; Object.assign(out, await tree(dir, rel)); }
    else out[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
  }
  return out;
}
const absent = (file) => assert.rejects(fs.lstat(file), { code: "ENOENT" });
const ioError = (code = "EIO") => Object.assign(new Error("injected deletion fault"), { code });
async function setup(t, env = {}) {
  const f = await serverFixture(t, { COLLAB_HEARTBEAT_MS: "60000", ...env });
  const addUser = async (name, role = "regular") => (await f.pool.query(
    "INSERT INTO users (id, username, email, display_name, system_role) VALUES ($1, $2, $3, $2, $4) RETURNING *",
    [uuidv7(), name, `${name}@example.test`, role]
  )).rows[0];
  const owner = await addUser("owner", "admin");
  const request = (url, opts = {}) => f.request(url, { cookie: f.cookieFor(owner), ...opts });
  const create = async () => {
    const res = await request("/api/projects", { method: "POST", body: { name: "Deletion", data: { project: { nodes: [
      { id: "main", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: "original\r\n" },
      { id: "asset", type: "file", name: "asset.bin", path: "asset.bin", binary: true, data: "data:application/octet-stream;base64,AAEC/w==" },
    ] } } } });
    assert.equal(res.status, 201);
    return res.json();
  };
  const out = await create(), id = out.project.id;
  const dir = path.join(f.dataDir, "projects", id), backup = path.join(f.dataDir, ".project-backups", id);
  await fs.mkdir(path.join(dir, "output"));
  await fs.writeFile(path.join(dir, "output", "build.pdf"), "original output");
  await fs.mkdir(path.join(dir, "empty"));
  const url = `/api/projects/${id}`, adminUrl = `/api/admin/projects/${id}`;
  const receipt = async () => (await f.pool.query("SELECT * FROM project_deletions WHERE project_id = $1", [id])).rows[0];
  const audits = async () => (await f.pool.query("SELECT * FROM audit_events WHERE target_id = $1 AND action = 'project.deleted'", [id])).rows;
  return { ...f, request, addUser, create, owner, out, id, dir, backup, url, adminUrl, receipt, audits,
    remove: (opts = {}) => request(url, { method: "DELETE", ...opts }) };
}

for (const admin of [false, true]) {
  test(`${admin ? "admin" : "owner"} deletion completes once, snapshots all owners and repeats without filesystem writes`, options, async (t) => {
    const f = await setup(t);
    const coowner = await f.addUser("coowner");
    await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [f.id, coowner.id]);
    const url = admin ? f.adminUrl : f.url;
    const res = await f.request(url, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cleanupPending: false });
    await absent(f.dir); await absent(f.backup);
    const row = await f.receipt();
    assert.equal(row.state, "complete");
    assert.deepEqual(row.owner_ids.sort(), [f.owner.id, coowner.id].sort());
    assert.ok(row.completed_at >= row.created_at);
    assert.equal((await f.pool.query("SELECT * FROM project_members WHERE project_id = $1", [f.id])).rowCount, 0);
    f.hooks.beforeRm = () => { assert.fail("complete retry must not touch filesystem"); };
    for (const cookie of [f.cookieFor(f.owner), f.cookieFor(coowner)]) {
      const repeated = await f.remove({ cookie });
      assert.equal(repeated.status, 200);
      assert.deepEqual(await repeated.json(), { ok: true, cleanupPending: false });
    }
    assert.equal((await f.audits()).length, 1);
  });
  test(`${admin ? "admin" : "owner"} deletion accepts genuinely missing source storage`, options, async (t) => {
    const f = await setup(t);
    await fs.rm(f.dir, { recursive: true });
    const res = await f.request(admin ? f.adminUrl : f.url, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cleanupPending: false });
    assert.equal((await f.receipt()).state, "complete");
    await absent(f.backup);
  });
}

for (const fault of ["rename", "destination-ENOENT", "permission", "ENOTDIR", "sql", "receipt-insert", "mkdir-ack"]) {
  test(`precommit ${fault} failure preserves exact original tree and rolls back metadata/receipt`, options, async (t) => {
    const f = await setup(t), before = await tree(f.dir);
    f.hooks.beforeRename = async (src) => {
      if (src === f.dir && ["rename", "destination-ENOENT", "permission", "ENOTDIR"].includes(fault)) {
        throw ioError({ "destination-ENOENT": "ENOENT", permission: "EACCES", ENOTDIR: "ENOTDIR" }[fault]);
      }
    };
    f.hooks.afterClientQuery = async (sql) => {
      if (fault === "sql" && /^DELETE FROM projects/.test(sql)) throw ioError();
      if (fault === "receipt-insert" && /INSERT INTO project_deletions/.test(sql)) throw ioError();
    };
    f.hooks.afterMkdir = async (dir) => { if (fault === "mkdir-ack" && dir === f.backup) throw ioError(); };
    assert.equal((await f.remove()).status, 500);
    assert.deepEqual(await tree(f.dir), before);
    assert.equal(await f.receipt(), undefined);
    await absent(f.backup);
    assert.equal((await f.request(f.url)).status, 200);
    assert.equal((await f.audits()).length, 0);
  });
}

test("a new deletion manager resumes ready proof after all payload bytes disappeared", options, async (t) => {
  const f = await setup(t);
  f.hooks.beforeRm = async (file) => { if (file === f.backup) throw ioError(); };
  assert.equal((await f.remove()).status, 200);
  await fs.rm(f.backup, { recursive: true });
  const { createProjectMutations } = require("../src/project-mutations");
  const { createProjectDeletions } = require("../src/project-deletions");
  const requestError = (errorCode, status) => Object.assign(new Error(errorCode), { errorCode, status });
  const settings = { fs, getDb: () => f.pool, backupRoot: path.join(f.dataDir, ".project-backups"), requestError };
  const mutations = createProjectMutations(settings);
  const restarted = createProjectDeletions({ ...settings, mutations });
  await restarted.sweep();
  assert.equal((await f.receipt()).state, "complete");
  assert.equal((await f.remove()).status, 200);
  assert.equal((await f.audits()).length, 1);
});

for (const boundary of ["readiness-ack", "completion"]) {
  test(`${boundary} DB failure retains durable retry evidence without repeating commit effects`, options, async (t) => {
    const f = await setup(t), before = await tree(f.dir);
    const failure = async (sql) => {
      if (boundary === "readiness-ack" && /UPDATE project_deletions.*cleanup_ready.*WHERE/s.test(sql)) throw ioError();
      if (boundary === "completion" && /UPDATE project_deletions.*state = 'complete'/s.test(sql)) throw ioError();
    };
    if (boundary === "readiness-ack") f.hooks.afterQuery = failure;
    else f.hooks.beforeQuery = failure;
    assert.equal((await f.remove()).status, 503);
    assert.equal((await f.receipt()).state, "cleanup_ready");
    if (boundary === "readiness-ack") assert.deepEqual(await tree(path.join(f.backup, "deleted")), before);
    else await absent(f.backup);
    f.hooks.beforeQuery = f.hooks.afterQuery = null;
    assert.equal((await f.remove()).status, 200);
    assert.equal((await f.receipt()).state, "complete");
    assert.equal((await f.audits()).length, 1);
  });
}

test("owner changes ahead of deletion's advisory wait determine authorization and retry snapshot", options, async (t) => {
  const f = await setup(t), coowner = await f.addUser("coowner");
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [f.id, coowner.id]);
  const lock = await f.pool.connect(), entered = deferred();
  let deletion;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [4952, f.id]);
    f.hooks.beforeClientQuery = async (sql) => { if (sql.includes("pg_advisory_xact_lock")) entered.resolve(); };
    deletion = f.remove();
    await within(entered.promise);
    await lock.query("UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2", [f.id, f.owner.id]);
    await lock.query("COMMIT");
    assert.equal((await within(deletion)).status, 403);
    assert.equal(await f.receipt(), undefined);
    assert.equal((await f.remove({ cookie: f.cookieFor(coowner) })).status, 200);
    assert.deepEqual((await f.receipt()).owner_ids, [coowner.id]);
    assert.equal((await f.remove()).status, 404);
  } finally { await lock.query("ROLLBACK"); lock.release(); if (deletion) await deletion; }
});

test("sharing INSERT holding the owner lock can finish while deletion queues without a project-row inversion", options, async (t) => {
  const f = await setup(t), coowner = await f.addUser("coowner");
  const entered = deferred(), release = deferred(), deletionWaiting = deferred();
  f.hooks.beforeClientQuery = async (sql, params) => {
    if (sql.includes("INSERT INTO project_members") && params[1] === coowner.id) { entered.resolve(); await release.promise; }
  };
  const sharing = f.request(f.url + "/members", { method: "POST", body: { userId: coowner.id, role: "owner" } });
  let deletion;
  try {
    await within(entered.promise);
    f.hooks.beforeClientQuery = async (sql) => { if (sql.includes("pg_advisory_xact_lock")) deletionWaiting.resolve(); };
    deletion = f.remove();
    // The hook marks attempts; the PostgreSQL locks, INSERT FK and resulting
    // receipt establish that sharing committed before the deleting transaction.
    await within(deletionWaiting.promise);
    release.resolve();
    assert.equal((await within(sharing)).status, 201);
    assert.equal((await within(deletion)).status, 200);
    assert.deepEqual((await f.receipt()).owner_ids.sort(), [f.owner.id, coowner.id].sort());
  } finally { release.resolve(); await sharing; if (deletion) await deletion; }
});

test("a session revoked during the requester row lock wait takes precedence over private backup recovery", options, async (t) => {
  const f = await setup(t);
  await fs.mkdir(f.backup); await fs.writeFile(path.join(f.backup, "keep"), "unknown backup");
  const lock = await f.pool.connect(), entered = deferred();
  let deletion;
  try {
    await lock.query("BEGIN");
    await lock.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [f.owner.id]);
    f.hooks.beforeClientQuery = async (sql) => { if (sql.includes("FROM users") && sql.includes("FOR SHARE")) entered.resolve(); };
    deletion = f.remove();
    await within(entered.promise);
    await lock.query("COMMIT");
    assert.equal((await within(deletion)).status, 401);
    assert.equal(await fs.readFile(path.join(f.backup, "keep"), "utf8"), "unknown backup");
    assert.equal(await f.receipt(), undefined);
  } finally { await lock.query("ROLLBACK"); lock.release(); if (deletion) await deletion; }
});

test("current receipt constraints preserve retry snapshots after owner account deletion", options, async (t) => {
  const f = await setup(t);
  assert.equal((await f.remove()).status, 200);
  for (const [state, completed] of [["prepared", new Date()], ["cleanup_ready", new Date()], ["complete", null], ["unknown", null]]) {
    await assert.rejects(f.pool.query("INSERT INTO project_deletions (project_id, owner_ids, state, completed_at) VALUES ($1, $2, $3, $4)", [uuidv7(), [f.owner.id], state, completed]), { code: "23514" });
  }
  await assert.rejects(f.pool.query("UPDATE project_deletions SET completed_at = created_at - INTERVAL '1 second' WHERE project_id = $1", [f.id]), { code: "23514" });
  await f.pool.query("DELETE FROM users WHERE id = $1", [f.owner.id]);
  assert.deepEqual((await f.receipt()).owner_ids, [f.owner.id]);
  assert.equal((await f.remove()).status, 401);
  const replacement = await f.addUser("owner");
  assert.equal((await f.remove({ cookie: f.cookieFor(replacement) })).status, 404);
});

test("expiry after quarantine rolls back original bytes before COMMIT", options, async (t) => {
  const f = await setup(t), before = await tree(f.dir);
  const expires = Math.floor(Date.now() / 1000) + 2;
  f.hooks.afterRename = async (src) => { if (src === f.dir) await until(() => Math.floor(Date.now() / 1000) >= expires); };
  assert.equal((await f.remove({ cookie: f.cookieFor(f.owner, { exp: expires }) })).status, 401);
  assert.deepEqual(await tree(f.dir), before);
  assert.equal(await f.receipt(), undefined);
  await absent(f.backup);
  assert.equal((await f.audits()).length, 0);
});

test("startup cleanup remains lifecycle-counted through filesystem and completion writes", options, async (t) => {
  const f = await setup(t, { RETENTION_ENABLED: "false" });
  f.hooks.beforeRm = async (file) => { if (file === f.backup) throw ioError(); };
  assert.equal((await f.remove()).status, 200);
  const entered = deferred(), release = deferred();
  f.hooks.beforeRm = async (file) => { if (file === f.backup) { entered.resolve(); await release.promise; } };
  let shutdown;
  try {
    f.app.startRetentionSweep();
    await within(entered.promise);
    assert.equal(f.app.runtimeSettled(), false);
    assert.ok(f.app.healthPayload().pendingWrites > 0);
    shutdown = f.app.startGracefulShutdown("test", f.server);
    await delay(25);
    assert.deepEqual(f.exits, []);
    release.resolve();
    await within(shutdown);
    assert.deepEqual(f.exits, [0]);
    await absent(f.backup);
  } finally { release.resolve(); if (shutdown) await shutdown; }
});

test("maintenance activated during a queued cleanup prevents filesystem writes when the queue opens", options, async (t) => {
  const f = await setup(t, { RETENTION_ENABLED: "false" });
  f.hooks.beforeRm = async (file) => { if (file === f.backup) throw ioError(); };
  assert.equal((await f.remove()).status, 200);
  const entered = deferred(), release = deferred(), scanned = deferred();
  f.hooks.beforeRm = async (file) => { if (file === f.backup) { entered.resolve(); await release.promise; throw ioError(); } };
  const holding = f.remove();
  try {
    await within(entered.promise);
    f.hooks.afterQuery = async (sql) => { if (sql.includes("SELECT project_id FROM project_deletions")) setImmediate(scanned.resolve); };
    f.app.startRetentionSweep();
    await within(scanned.promise);
    await fs.writeFile(path.join(f.dataDir, ".maintenance"), "test");
    release.resolve(); await holding;
    await until(() => f.app.runtimeSettled());
    assert.equal((await f.receipt()).state, "cleanup_ready");
    assert.equal(await fs.readFile(path.join(f.backup, "deleted", "main.tex"), "utf8"), "original\r\n");
  } finally { release.resolve(); await holding; }
});

test("failed deletion restoration keeps original quarantine bytes and blocks subsequent mutations", options, async (t) => {
  const f = await setup(t), before = await tree(f.dir);
  f.hooks.afterClientQuery = async (sql) => { if (/^DELETE FROM projects/.test(sql)) throw ioError(); };
  f.hooks.beforeRename = async (src) => { if (src === path.join(f.backup, "deleted")) throw ioError(); };
  assert.equal((await f.remove()).status, 503);
  assert.deepEqual(await tree(path.join(f.backup, "deleted")), before);
  assert.equal((await f.pool.query("SELECT id FROM projects WHERE id = $1", [f.id])).rowCount, 1);
  assert.equal(await f.receipt(), undefined);
  assert.equal((await f.remove()).status, 503);
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Blocked" } })).status, 503);
  assert.equal((await f.audits()).length, 0);
});

for (const partial of [false, true]) {
  test(`${partial ? "partial" : "failed"} recursive cleanup retains ready proof and authorized concurrent retries finish once`, options, async (t) => {
    const f = await setup(t), before = await tree(f.dir);
    f.hooks.beforeRm = async (file) => {
      if (file !== f.backup) return;
      if (partial) await fs.rm(path.join(f.backup, "deleted", "output"), { recursive: true });
      throw ioError();
    };
    const res = await f.remove();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cleanupPending: true });
    assert.equal((await f.receipt()).state, "cleanup_ready");
    assert.equal((await f.receipt()).completed_at, null);
    if (partial) {
      await absent(path.join(f.backup, "deleted", "output"));
      assert.equal(await fs.readFile(path.join(f.backup, "deleted", "main.tex"), "utf8"), "original\r\n");
    } else assert.deepEqual(await tree(path.join(f.backup, "deleted")), before);
    const entered = deferred(), release = deferred();
    f.hooks.beforeRm = async (file) => { if (file === f.backup) { entered.resolve(); await release.promise; } };
    const first = f.remove();
    let second;
    try {
      await within(entered.promise);
      second = f.request(f.adminUrl, { method: "DELETE" });
      const other = await f.create();
      assert.equal((await f.request(`/api/projects/${other.project.id}`, { method: "PUT", body: { baseRevision: 0, name: "Other progresses" } })).status, 200);
      release.resolve();
      for (const response of await Promise.all([first, second])) {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, cleanupPending: false });
      }
    } finally { release.resolve(); await first; if (second) await second; }
    assert.equal((await f.receipt()).state, "complete");
    await absent(f.backup);
    assert.equal((await f.audits()).length, 1);
    assert.equal(await f.app.projectMutations.gate(f.id, () => "unblocked"), "unblocked");
  });
}

for (const fault of ["lost-commit-ack", "readiness"]) {
  test(`${fault} preserves quarantine and the acknowledged-versus-uncertain room/audit boundary`, options, async (t) => {
    const f = await setup(t), before = await tree(f.dir);
    const fileId = f.out.data.project.nodes[0].id;
    const room = f.app.collabRooms.open({ fileId, projectId: f.id, path: "main.tex", content: "original\r\n" });
    room.storageDir = f.dir;
    f.hooks.afterClientQuery = async (sql) => { if (fault === "lost-commit-ack" && sql === "COMMIT") throw ioError(); };
    f.hooks.beforeQuery = async (sql) => { if (fault === "readiness" && /UPDATE project_deletions.*cleanup_ready/s.test(sql)) throw ioError(); };
    f.hooks.beforeRm = async (file) => { if (file === f.backup) assert.fail("unready deletion must retain bytes"); };
    assert.equal((await f.remove()).status, 503);
    assert.equal((await f.receipt()).state, "prepared");
    assert.deepEqual(await tree(path.join(f.backup, "deleted")), before);
    assert.equal((await f.pool.query("SELECT id FROM projects WHERE id = $1", [f.id])).rowCount, 0);
    assert.equal(f.app.collabRooms.get(fileId), fault === "lost-commit-ack" ? room : null);
    assert.equal((await f.audits()).length, fault === "lost-commit-ack" ? 0 : 1);
    assert.equal((await f.remove()).status, 503);
    await f.app.runRetentionSweep();
    assert.deepEqual(await tree(path.join(f.backup, "deleted")), before);
  });
}

test("deleted receipts and unknown backups are private to authenticated historical owners or current admins", options, async (t) => {
  const f = await setup(t);
  const viewer = await f.addUser("viewer"), outsider = await f.addUser("outsider"), admin = await f.addUser("admin", "admin");
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')", [f.id, viewer.id]);
  assert.equal((await f.remove({ cookie: f.cookieFor(viewer) })).status, 403);
  assert.equal((await f.remove({ cookie: f.cookieFor(outsider) })).status, 404);
  f.hooks.beforeRm = async (file) => { if (file === f.backup) throw ioError(); };
  assert.equal((await f.remove()).status, 200);
  for (const user of [viewer, outsider, admin]) {
    const denied = await f.remove({ cookie: f.cookieFor(user) });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).errorCode, "PROJECT_NOT_FOUND");
  }
  assert.equal((await f.remove({ cookie: "" })).status, 401);
  assert.equal((await f.remove({ cookie: f.cookieFor(f.owner, { exp: 1 }) })).status, 401);
  f.hooks.beforeRm = null;
  assert.equal((await f.request(f.adminUrl, { method: "DELETE", cookie: f.cookieFor(admin) })).status, 200);
  const unknown = uuidv7(), backup = path.join(f.dataDir, ".project-backups", unknown);
  await fs.mkdir(backup); await fs.writeFile(path.join(backup, "proofless"), "keep");
  for (const prefix of ["/api/projects/", "/api/admin/projects/"]) assert.equal((await f.request(prefix + unknown, { method: "DELETE" })).status, 404);
  await f.app.runRetentionSweep();
  assert.equal(await fs.readFile(path.join(backup, "proofless"), "utf8"), "keep");
});

for (const retry of [false, true]) for (const change of ["revoke", "expire", "demote-admin", "password-required"]) {
  test(`${retry ? "retry" : "live deletion"} reauthenticates after queue: ${change}`, options, async (t) => {
    const f = await setup(t);
    if (retry) {
      f.hooks.beforeRm = async (file) => { if (file === f.backup) throw ioError(); };
      assert.equal((await f.remove()).status, 200);
      f.hooks.beforeRm = null;
    }
    const entered = deferred(), release = deferred(), authenticated = deferred();
    // A ready deletion still has an ordinary recovery gate, so hold its queue via
    // a cleanup retry; live deletion can hold the normal gate directly.
    let holding;
    if (retry) {
      f.hooks.beforeRm = async (file) => { if (file === f.backup) { entered.resolve(); await release.promise; throw ioError(); } };
      holding = f.remove();
    } else holding = f.app.projectMutations.gate(f.id, async () => { entered.resolve(); await release.promise; });
    let queued;
    try {
      await within(entered.promise);
      const expires = Math.floor(Date.now() / 1000) + 2;
      f.hooks.afterQuery = async (sql) => { if (sql.includes("FROM users WHERE id = $1")) setImmediate(authenticated.resolve); };
      queued = f.request(change === "demote-admin" ? f.adminUrl : f.url, { method: "DELETE", cookie: f.cookieFor(f.owner, change === "expire" ? { exp: expires } : {}) });
      await within(authenticated.promise);
      if (change === "expire") await until(() => Math.floor(Date.now() / 1000) >= expires);
      else await f.pool.query(`UPDATE users SET ${change === "revoke" ? "session_version = session_version + 1" : change === "demote-admin" ? "system_role = 'regular'" : "password_change_required = true"} WHERE id = $1`, [f.owner.id]);
      release.resolve(); await holding;
      assert.equal((await within(queued)).status, ["demote-admin", "password-required"].includes(change) ? 403 : 401);
      if (retry) assert.equal((await f.receipt()).state, "cleanup_ready");
      else { assert.equal(await f.receipt(), undefined); assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "original\r\n"); }
    } finally { release.resolve(); await holding; if (queued) await queued; }
  });
}

test("orphan admin deletion records an empty owner snapshot", options, async (t) => {
  const f = await setup(t);
  await f.pool.query("DELETE FROM project_members WHERE project_id = $1", [f.id]);
  assert.equal((await f.request(f.adminUrl, { method: "DELETE" })).status, 200);
  assert.deepEqual((await f.receipt()).owner_ids, []);
  assert.equal((await f.remove()).status, 404);
  assert.equal((await f.request(f.adminUrl, { method: "DELETE" })).status, 200);
});

test("startup resumes partial ready cleanup with retention disabled and prunes only seven-day complete receipts", options, async (t) => {
  const f = await setup(t, { RETENTION_ENABLED: "false" });
  f.hooks.beforeRm = async (file) => {
    if (file !== f.backup) return;
    await fs.rm(path.join(f.backup, "deleted", "asset.bin")); throw ioError();
  };
  assert.equal((await f.remove()).status, 200);
  assert.equal((await f.receipt()).state, "cleanup_ready");
  f.hooks.beforeRm = null;
  const oldComplete = uuidv7(), recentComplete = uuidv7(), prepared = uuidv7();
  await f.pool.query(`INSERT INTO project_deletions (project_id, owner_ids, state, created_at, completed_at) VALUES
    ($1, $4, 'complete', CURRENT_TIMESTAMP - INTERVAL '9 days', CURRENT_TIMESTAMP - INTERVAL '8 days'),
    ($2, $4, 'complete', CURRENT_TIMESTAMP - INTERVAL '9 days', CURRENT_TIMESTAMP - INTERVAL '6 days'),
    ($3, $4, 'prepared', CURRENT_TIMESTAMP - INTERVAL '30 days', NULL)`, [oldComplete, recentComplete, prepared, [f.owner.id]]);
  const preparedDir = path.join(f.dataDir, ".project-backups", prepared);
  await fs.mkdir(preparedDir); await fs.writeFile(path.join(preparedDir, "keep"), "prepared");
  f.app.startRetentionSweep();
  await until(() => f.app.runtimeSettled());
  assert.equal((await f.receipt()).state, "complete");
  await absent(f.backup);
  assert.equal((await f.request(`/api/projects/${oldComplete}`, { method: "DELETE" })).status, 404);
  assert.equal((await f.request(`/api/projects/${recentComplete}`, { method: "DELETE" })).status, 200);
  assert.equal((await f.request(`/api/projects/${prepared}`, { method: "DELETE" })).status, 503);
  assert.equal(await fs.readFile(path.join(preparedDir, "keep"), "utf8"), "prepared");
});

test("ready receipt with a live project never deletes quarantine and does not stop other ready cleanup", options, async (t) => {
  const f = await setup(t), other = await f.create();
  await f.pool.query("INSERT INTO project_deletions (project_id, owner_ids, state) VALUES ($1, $2, 'cleanup_ready')", [f.id, [f.owner.id]]);
  await fs.mkdir(f.backup); await fs.writeFile(path.join(f.backup, "keep"), "inconsistent");
  const otherBackup = path.join(f.dataDir, ".project-backups", other.project.id);
  f.hooks.beforeRm = async (file) => { if (file === otherBackup) throw ioError(); };
  assert.equal((await f.request(`/api/projects/${other.project.id}`, { method: "DELETE" })).status, 200);
  f.hooks.beforeRm = null;
  await f.app.runRetentionSweep();
  assert.equal(await fs.readFile(path.join(f.backup, "keep"), "utf8"), "inconsistent");
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "original\r\n");
  assert.equal((await f.receipt()).state, "cleanup_ready");
  await absent(otherBackup);
  assert.equal((await f.remove()).status, 503);
});

for (const flag of ["maintenance", "shutdown"]) {
  test(`${flag} prevents startup deletion cleanup`, options, async (t) => {
    const f = await setup(t, { RETENTION_ENABLED: "false" });
    f.hooks.beforeRm = async (file) => { if (file === f.backup) throw ioError(); };
    assert.equal((await f.remove()).status, 200);
    f.hooks.beforeRm = null;
    if (flag === "maintenance") await fs.writeFile(path.join(f.dataDir, ".maintenance"), "test");
    else f.app.stopRuntimeTimers();
    f.app.startRetentionSweep();
    await until(() => f.app.runtimeSettled());
    assert.equal((await f.receipt()).state, "cleanup_ready");
    assert.equal(await fs.readFile(path.join(f.backup, "deleted", "main.tex"), "utf8"), "original\r\n");
  });
}
