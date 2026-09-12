const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const WebSocket = require("ws");
const { ChangeSet } = require("@codemirror/state");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");
const options = { skip: !connectionString, timeout: 20000 };

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Room lifecycle barrier timed out")), 4000);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Room lifecycle condition timed out");
    await delay(5);
  }
}

async function setup(t, env = {}) {
  const f = await serverFixture(t, {
    COLLAB_FLUSH_MS: "60000", COLLAB_FLUSH_MAX_MS: "60000",
    COLLAB_REVISION_IDLE_MS: "60000", COLLAB_HEARTBEAT_MS: "60000",
    ...env,
  });
  const user = (await f.pool.query("INSERT INTO users (id, username, email, display_name, system_role) VALUES ($1, 'writer', 'writer@example.test', 'Writer', 'admin') RETURNING *", [uuidv7()])).rows[0];
  const cookie = f.cookieFor(user);
  const request = (url, opts = {}) => f.request(url, { cookie, ...opts });
  const res = await request("/api/projects", { method: "POST", body: { name: "Lifecycle", data: { project: { nodes: [
    { id: "main", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: "base" },
    { id: "other", type: "file", name: "other.tex", path: "other.tex", kind: "tex", content: "other" },
  ] } } } });
  assert.equal(res.status, 201);
  const out = await res.json();
  const id = out.project.id;
  const [fileId, otherId] = out.data.project.nodes.map((node) => node.id);
  return { ...f, user, cookie, request, out, id, fileId, otherId, url: `/api/projects/${id}`, dir: path.join(f.dataDir, "projects", id) };
}

async function connect(t, f) {
  const ws = new WebSocket(f.baseUrl.replace("http:", "ws:") + "/api/collab", { headers: { cookie: f.cookie } });
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on("error", () => {});
  t.after(() => ws.terminate());
  const client = {
    ws, messages,
    send: (message) => ws.send(JSON.stringify(message)),
    async next(type) {
      await until(() => messages.some((message) => message.t === type));
      return messages.splice(messages.findIndex((message) => message.t === type), 1)[0];
    },
    async open(fileId) {
      client.send({ t: "open", fileId });
      return client.next("opened");
    },
  };
  const ready = await client.next("ready");
  client.session = Array.from(f.app.collabSessions).find((session) => session.id === ready.sessionId);
  client.send({ t: "project", projectId: f.id });
  await client.open(f.fileId);
  return client;
}

function push(client, fileId, version, text, insert) {
  client.send({ t: "push", fileId, version, updates: [{
    clientID: "lifecycle", changes: ChangeSet.of({ from: text.length, insert }, text.length).toJSON(),
  }] });
}

async function accepted(client, fileId, version, text, insert) {
  push(client, fileId, version, text, insert);
  assert.equal((await client.next("updates")).version, version + 1);
  assert.equal((await client.next("pushed")).accepted, true);
}

async function history(f) {
  return (await f.pool.query("SELECT id, parent_version_id, content, reason FROM document_versions WHERE file_id = $1 ORDER BY created_at, id", [f.fileId])).rows;
}

async function targetVersion(f) {
  assert.equal((await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).status, 200);
  return (await history(f))[0].id;
}

for (const [writer, suffix, method] of [["PUT", "", "PUT"], ["checkpoint", "/checkpoint", "POST"], ["compile-save", "/compile", "POST"]]) {
  test(`${writer} reconciles canonical rename and kind before follow-up I/O without resetting OT`, options, async (t) => {
    const f = await setup(t);
    const client = await connect(t, f);
    await accepted(client, f.fileId, 0, "base", " live");
    const room = f.app.collabRooms.get(f.fileId);
    const data = structuredClone(f.out.data);
    data.project.nodes[0].name = data.project.nodes[0].path = "renamed.sty";
    data.project.nodes[0].kind = "sty";
    const entered = deferred(), release = deferred();
    if (writer === "checkpoint") f.hooks.beforeQuery = async (sql) => {
      if (sql.includes("INSERT INTO audit_events")) { entered.resolve(); await release.promise; }
    };
    if (writer === "compile-save") f.hooks.beforeMkdir = async (dir) => {
      if (dir.includes(".build-staging")) { entered.resolve(); await release.promise; }
    };
    const save = f.request(f.url + suffix, { method, body: { baseRevision: 0, data, texPath: path.join(f.dataDir, "missing-tool"), mainPath: "other.tex" } });
    try {
      if (writer === "PUT") assert.equal((await save).status, 200);
      else await within(entered.promise);
      assert.equal(room.path, "renamed.sty");
      assert.equal(room.kind, "sty");
      assert.equal(f.app.collabRooms.get(f.fileId), room);
      assert.equal(room.text(), "base live");
      assert.equal(room.version, 1);
      assert.equal(room.since(0).length, 1);
      assert.equal(client.messages.some((m) => ["resync", "file-closed", "revoked"].includes(m.t)), false);
    } finally { release.resolve(); assert.equal((await save).status, 200); }
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 1, name: "Name only" } })).status, 200);
    assert.equal(room.kind, "sty", "name-only saves must not reconcile filesystem-derived kinds");
    await accepted(client, f.fileId, 1, "base live", " next");
    await f.app.collabPersistNow(room, false);
    assert.equal(await fs.readFile(path.join(f.dir, "renamed.sty"), "utf8"), "base live next");
    await assert.rejects(fs.stat(path.join(f.dir, "main.tex")), { code: "ENOENT" });
  });
}

test("file deletion snapshots unflushed authority, rejects queued pushes and flushes, and keeps other files watched", options, async (t) => {
  const f = await setup(t, { COLLAB_REVISION_IDLE_MS: "100" });
  const client = await connect(t, f);
  const peer = await connect(t, f);
  await client.open(f.otherId);
  await accepted(client, f.fileId, 0, "base", " accepted");
  const room = f.app.collabRooms.get(f.fileId);
  const entered = deferred(), release = deferred(), authenticated = deferred();
  f.hooks.beforeUnlink = async (file) => {
    if (file === path.join(f.dir, "main.tex")) { entered.resolve(); await release.promise; }
  };
  const data = structuredClone(f.out.data);
  data.project.nodes.shift();
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } });
  let flush;
  try {
    await within(entered.promise);
    f.hooks.afterQuery = async (sql) => { if (sql.includes("FROM users WHERE id = $1")) setImmediate(authenticated.resolve); };
    push(client, f.fileId, 1, "base accepted", " forbidden");
    await within(authenticated.promise);
    flush = f.app.collabPersistNow(room, true);
    assert.equal(room.text(), "base accepted", "push must wait for the destructive transaction");
    release.resolve();
    assert.equal((await save).status, 200);
    await within(flush);
    assert.deepEqual(await client.next("file-closed"), { t: "file-closed", fileId: f.fileId });
    assert.deepEqual(await peer.next("file-closed"), { t: "file-closed", fileId: f.fileId });
    assert.equal((await client.next("error")).code, "COLLAB_NOT_JOINED");
    assert.equal(f.app.collabRooms.get(f.fileId), null);
    assert.equal(room.clients.size, 0);
    assert.equal(room.flushTimer._destroyed, true);
    assert.equal(client.session.rooms.has(f.fileId), false);
    assert.equal(peer.session.rooms.has(f.fileId), false);
    assert.equal(client.session.projectId, f.id);
    assert.equal(peer.session.projectId, f.id);
    assert.deepEqual((await history(f)).map((v) => v.content), ["base accepted"]);
    client.send({ t: "pull", fileId: f.fileId, version: 1 });
    assert.equal((await client.next("error")).code, "COLLAB_NOT_JOINED");
    await accepted(client, f.otherId, 0, "other", " usable");
    // The shared project timer must still checkpoint surviving rooms without
    // revisiting the removed file or recreating its bytes.
    const surviving = f.app.collabRooms.get(f.otherId);
    await until(() => !surviving.needsRevision());
    assert.equal(await fs.readFile(path.join(f.dir, "other.tex"), "utf8"), "other usable");
    const revisions = await f.pool.query("SELECT content, reason FROM document_versions WHERE file_id = $1 ORDER BY created_at, id", [f.otherId]);
    assert.deepEqual(revisions.rows, [{ content: "other usable", reason: "realtime" }]);
    assert.deepEqual((await history(f)).map((v) => v.content), ["base accepted"]);
    assert.equal(client.messages.some((m) => m.t === "revoked"), false);
    assert.equal(peer.messages.some((m) => m.t === "revoked"), false);
    await f.app.collabPersistNow(room, true);
    await assert.rejects(fs.stat(path.join(f.dir, "main.tex")), { code: "ENOENT" });
  } finally { release.resolve(); await save; if (flush) await within(flush); }
});

test("restore snapshots unflushed authority and orders reset, queued flush and old-version rejection before new typing", options, async (t) => {
  const f = await setup(t);
  const target = await targetVersion(f);
  const client = await connect(t, f);
  await accepted(client, f.fileId, 0, "base", " accepted");
  const room = f.app.collabRooms.get(f.fileId);
  const entered = deferred(), release = deferred(), authenticated = deferred(), audit = deferred(), releaseAudit = deferred();
  f.hooks.beforeWriteFile = async (file) => { if (file === path.join(f.dir, "main.tex")) { entered.resolve(); await release.promise; } };
  f.hooks.beforeQuery = async (sql) => { if (sql.includes("INSERT INTO audit_events")) { audit.resolve(); await releaseAudit.promise; } };
  const restore = f.request(`${f.url}/files/${f.fileId}/versions/${target}/restore`, { method: "POST", body: {} });
  let flush;
  try {
    await within(entered.promise);
    f.hooks.afterQuery = async (sql) => { if (sql.includes("FROM users WHERE id = $1")) setImmediate(authenticated.resolve); };
    push(client, f.fileId, 1, "base accepted", " stale");
    await within(authenticated.promise);
    flush = f.app.collabPersistNow(room, true);
    assert.equal(room.text(), "base accepted");
    release.resolve();
    await within(audit.promise);
    assert.equal(room.text(), "base");
    assert.equal(room.version, 2);
    const versions = await history(f);
    assert.deepEqual(versions.map((v) => [v.content, v.reason]), [["base", "manual"], ["base accepted", "manual"], ["base", "rollback"]]);
    assert.equal(versions[1].parent_version_id, target);
    assert.equal(versions[2].parent_version_id, versions[1].id);
    releaseAudit.resolve();
    assert.equal((await restore).status, 200);
    await within(flush);
    assert.equal((await client.next("resync")).doc, "base");
    assert.deepEqual(await client.next("pushed"), { t: "pushed", fileId: f.fileId, accepted: false, version: 2 });
    f.hooks.beforeWriteFile = null;
    await accepted(client, f.fileId, 2, "base", " new");
    await f.app.collabPersistNow(room, true);
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base new");
    assert.equal((await history(f)).at(-1).content, "base new");
  } finally { release.resolve(); releaseAudit.resolve(); await restore; if (flush) await within(flush); }
});

test("failed rename, delete and restore roll history back without resetting or detaching accepted text", options, async (t) => {
  const f = await setup(t);
  const target = await targetVersion(f);
  const client = await connect(t, f);
  await accepted(client, f.fileId, 0, "base", " accepted");
  const room = f.app.collabRooms.get(f.fileId);
  const before = await history(f);
  const renamed = structuredClone(f.out.data);
  renamed.project.nodes[0].name = renamed.project.nodes[0].path = "failed.sty";
  renamed.project.nodes[0].kind = "sty";
  f.hooks.beforeClientQuery = async (sql) => { if (/^UPDATE projects SET/.test(sql)) throw new Error("injected precommit failure"); };
  for (const mutation of ["rename", "delete", "restore"]) {
    const res = mutation === "restore"
      ? await f.request(`${f.url}/files/${f.fileId}/versions/${target}/restore`, { method: "POST", body: {} })
      : await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: mutation === "rename" ? renamed : { project: { nodes: [f.out.data.project.nodes[1]] } } } });
    assert.equal(res.status, 500);
    assert.deepEqual(await history(f), before);
    assert.equal(f.app.collabRooms.get(f.fileId), room);
    assert.equal(client.session.rooms.get(f.fileId).room, room);
    assert.equal(room.path, "main.tex");
    assert.equal(room.kind, "tex");
    assert.equal(room.text(), "base accepted");
    assert.equal(room.version, 1);
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base");
  }
  assert.equal(client.messages.some((m) => ["resync", "file-closed", "revoked"].includes(m.t)), false);
  f.hooks.beforeClientQuery = null;
  await f.app.collabPersistNow(room, true);
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base accepted");
  assert.equal((await history(f)).at(-1).content, "base accepted");
});

test("destructive snapshot read errors abort delete and restore rather than discarding history", options, async (t) => {
  const f = await setup(t);
  const target = await targetVersion(f);
  await fs.writeFile(path.join(f.dir, "main.tex"), "unversioned disk");
  for (const [mutation, code] of [["delete", "EIO"], ["restore", "EIO"], ["delete", "EACCES"], ["restore", "EACCES"]]) {
    f.hooks.beforeReadFile = async (file) => {
      if (file === path.join(f.dir, "main.tex")) throw Object.assign(new Error("snapshot unreadable"), { code });
    };
    const res = mutation === "delete"
      ? await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: { project: { nodes: [f.out.data.project.nodes[1]] } } } })
      : await f.request(`${f.url}/files/${f.fileId}/versions/${target}/restore`, { method: "POST", body: {} });
    assert.equal(res.status, 500, mutation);
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "unversioned disk");
    assert.equal((await history(f)).length, 1);
    assert.equal((await f.pool.query("SELECT deleted_at FROM project_files WHERE id = $1", [f.fileId])).rows[0].deleted_at, null);
  }
  f.hooks.beforeReadFile = null;
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: { project: { nodes: [f.out.data.project.nodes[1]] } } } })).status, 200);
  const versions = await history(f);
  assert.equal(versions.at(-1).content, "unversioned disk");
  assert.equal(versions.at(-1).parent_version_id, target);
});

test("old-room queued persistence and last-leave completion cannot write or close a replacement", options, async (t) => {
  const f = await setup(t);
  const client = await connect(t, f);
  await accepted(client, f.fileId, 0, "base", " old");
  const old = f.app.collabRooms.get(f.fileId);
  const entered = deferred(), release = deferred();
  f.hooks.beforeClientQuery = async (sql) => { if (/^UPDATE projects SET/.test(sql)) { entered.resolve(); await release.promise; } };
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Name only" } });
  let leaving;
  try {
    await within(entered.promise);
    client.send({ t: "close", fileId: f.fileId });
    await until(() => !client.session.rooms.has(f.fileId));
    leaving = old.persisting;
    f.app.collabRooms.close(f.fileId);
    const fresh = f.app.collabRooms.open({ fileId: f.fileId, projectId: f.id, path: "main.tex", content: "base" });
    fresh.storageDir = f.dir;
    release.resolve();
    assert.equal((await save).status, 200);
    await within(leaving);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base");
    assert.equal(f.app.collabRooms.get(f.fileId), fresh);
    assert.equal((await history(f)).length, 0);
    await client.open(f.fileId);
    await accepted(client, f.fileId, 0, "base", " fresh");
    await f.app.collabPersistNow(fresh, false);
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base fresh");
  } finally { release.resolve(); await save; if (leaving) await within(leaving); }
});

test("same-room rejoin, edit and last leave preserve edits queued ahead of an older retirement", options, async (t) => {
  const f = await setup(t, { COLLAB_FLUSH_MS: "30" });
  const writer = await connect(t, f);
  const peer = await connect(t, f);
  peer.send({ t: "close", fileId: f.fileId });
  await until(() => !peer.session.rooms.has(f.fileId));
  const room = f.app.collabRooms.get(f.fileId);
  const membership = deferred(), releaseMembership = deferred(), joinQueued = deferred();
  const flushing = deferred(), releaseFlush = deferred();
  const revision = deferred(), releaseRevision = deferred();
  const saving = deferred(), releaseSave = deferred();
  let membershipReads = 0, authenticated = 0;
  f.hooks.afterQuery = async (sql) => {
    if (sql.includes("FROM users WHERE id = $1")) setImmediate(() => authenticated++);
    if (sql.includes("FROM projects p JOIN project_members") && ++membershipReads === 2) {
      membership.resolve();
      await releaseMembership.promise;
      setImmediate(joinQueued.resolve);
    }
  };
  f.hooks.beforeWriteFile = async (file) => {
    if (file === path.join(f.dir, "main.tex")) { flushing.resolve(); await releaseFlush.promise; }
  };
  f.hooks.afterClientQuery = async (sql) => {
    if (sql === "COMMIT") { revision.resolve(); await releaseRevision.promise; }
  };
  f.hooks.beforeClientQuery = async (sql) => {
    if (/^UPDATE projects SET/.test(sql)) { saving.resolve(); await releaseSave.promise; }
  };
  const rejoin = peer.open(f.fileId);
  let save, leaving;
  try {
    await within(membership.promise);
    await accepted(writer, f.fileId, 0, "base", " old");
    await within(flushing.promise);
    // Last leave chains behind the debounce flush. The peer's final join is
    // already queued when that flush releases the project gate.
    writer.send({ t: "close", fileId: f.fileId });
    await until(() => !writer.session.rooms.has(f.fileId));
    releaseMembership.resolve();
    await within(joinQueued.promise);
    releaseFlush.resolve();
    assert.equal((await within(rejoin)).doc, "base old");
    await within(revision.promise);
    assert.ok(peer.session.rooms.get(f.fileId).room === room);
    authenticated = 0;
    push(peer, f.fileId, 1, "base old", " NEW");
    await until(() => authenticated === 1);
    save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Name only" } });
    await until(() => authenticated === 2);
    // The first last-leave completion now queues retirement behind the push
    // and PUT; the peer leaves again while the name-only PUT still holds it.
    releaseRevision.resolve();
    await within(saving.promise);
    assert.equal((await peer.next("pushed")).accepted, true);
    assert.equal(room.text(), "base old NEW");
    peer.send({ t: "close", fileId: f.fileId });
    await until(() => !peer.session.rooms.has(f.fileId));
    leaving = room.persisting;
    assert.equal(room.needsPersist(), true);
    assert.equal(room.needsRevision(), true);
    releaseSave.resolve();
    assert.equal((await save).status, 200);
    await within(leaving);
    await until(() => f.app.collabRooms.get(f.fileId) === null);
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base old NEW");
    assert.deepEqual((await history(f)).map((v) => v.content), ["base old", "base old NEW"]);
  } finally {
    releaseMembership.resolve(); releaseFlush.resolve(); releaseRevision.resolve(); releaseSave.resolve();
    await within(rejoin);
    if (save) await save;
    if (leaving) await within(leaving);
  }
});

for (const [writer, suffix, method, withData] of [
  ["PUT", "", "PUT", true],
  ["checkpoint", "/checkpoint", "POST", true],
  ["no-data compile", "/compile", "POST", false],
]) {
  test(`${writer} reconciles an externally missing file without inventing a current snapshot`, options, async (t) => {
    const f = await setup(t);
    const target = await targetVersion(f);
    await fs.unlink(path.join(f.dir, "main.tex"));
    const current = await (await f.request(f.url)).json();
    assert.deepEqual(current.project.nodes.map((file) => file.id), [f.otherId]);
    const res = await f.request(f.url + suffix, { method, body: {
      ...(withData ? { baseRevision: current.revision, data: current } : {}),
      texPath: path.join(f.dataDir, "missing-tool"),
    } });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.data.revision, 1);
    assert.ok((await f.pool.query("SELECT deleted_at FROM project_files WHERE id = $1", [f.fileId])).rows[0].deleted_at);
    assert.deepEqual((await history(f)).map((v) => [v.id, v.content]), [[target, "base"]]);
    await assert.rejects(fs.stat(path.join(f.dir, "main.tex")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(f.dir, "other.tex"), "utf8"), "other");
  });
}

test("restore recreates an externally missing indexed file from history", options, async (t) => {
  const f = await setup(t);
  const target = await targetVersion(f);
  await fs.unlink(path.join(f.dir, "main.tex"));
  const res = await f.request(`${f.url}/files/${f.fileId}/versions/${target}/restore`, { method: "POST", body: {} });
  assert.equal(res.status, 200);
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base");
  const versions = await history(f);
  assert.deepEqual(versions.map((v) => [v.content, v.reason]), [["base", "manual"], ["base", "rollback"]]);
  assert.equal(versions[1].parent_version_id, target);
  const client = await connect(t, f);
  await accepted(client, f.fileId, 0, "base", " new");
});

test("queued push rechecks current role and socket activity after the project gate", options, async (t) => {
  const f = await setup(t);
  const demoted = await connect(t, f);
  const expired = await connect(t, f);
  const entered = deferred(), release = deferred();
  let authenticated = 0;
  f.hooks.beforeClientQuery = async (sql) => { if (/^UPDATE projects SET/.test(sql)) { entered.resolve(); await release.promise; } };
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Gate" } });
  try {
    await within(entered.promise);
    f.hooks.afterQuery = async (sql) => { if (sql.includes("FROM users WHERE id = $1")) setImmediate(() => authenticated++); };
    push(demoted, f.fileId, 0, "base", " denied");
    push(expired, f.fileId, 0, "base", " expired");
    await until(() => authenticated >= 2);
    await f.pool.query("UPDATE project_members SET role = 'viewer' WHERE project_id = $1", [f.id]);
    await f.app.collabRecheckProject(f.id);
    expired.session.user.exp = 0;
    release.resolve();
    assert.equal((await save).status, 200);
    await within(demoted.session.messages);
    await within(expired.session.messages);
    assert.equal(f.app.collabRooms.get(f.fileId).text(), "base");
    assert.equal((await demoted.next("error")).code, "COLLAB_READ_ONLY");
    assert.equal(expired.session.closed, true);
    assert.equal(demoted.messages.some((m) => m.t === "pushed" && m.accepted), false);
    assert.equal(expired.messages.some((m) => m.t === "pushed" && m.accepted), false);
  } finally { release.resolve(); await save; }
});

for (const admin of [false, true]) {
  test(`${admin ? "admin" : "owner"} project deletion invalidates rooms and watchers before audit with revoked semantics`, options, async (t) => {
    const f = await setup(t);
    const client = await connect(t, f);
    await accepted(client, f.fileId, 0, "base", " accepted");
    const room = f.app.collabRooms.get(f.fileId);
    const entered = deferred(), release = deferred();
    f.hooks.beforeQuery = async (sql) => { if (sql.includes("INSERT INTO audit_events")) { entered.resolve(); await release.promise; } };
    const deletion = f.request(admin ? `/api/admin/projects/${f.id}` : f.url, { method: "DELETE" });
    try {
      await within(entered.promise);
      assert.ok(f.app.collabRooms.get(f.fileId) === null, "committed-away room must be removed before audit");
      assert.equal(client.session.rooms.size, 0);
      assert.equal(client.session.projectId, null);
      assert.equal((await client.next("revoked")).fileId, f.fileId);
      assert.equal(client.messages.some((m) => m.t === "file-closed"), false);
      await within(f.app.collabPersistNow(room, true));
      await assert.rejects(fs.stat(f.dir), { code: "ENOENT" });
    } finally { release.resolve(); assert.equal((await deletion).status, 200); }
  });
}

test("uncertain COMMIT leaves rooms unannounced and blocks queued pushes and persistence fail-closed", options, async (t) => {
  const f = await setup(t);
  const client = await connect(t, f);
  await accepted(client, f.fileId, 0, "base", " accepted");
  const room = f.app.collabRooms.get(f.fileId);
  const entered = deferred(), release = deferred(), authenticated = deferred();
  f.hooks.afterClientQuery = async (sql) => { if (sql === "COMMIT") { entered.resolve(); await release.promise; throw new Error("lost COMMIT acknowledgement"); } };
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: { project: { nodes: [f.out.data.project.nodes[1]] } } } });
  try {
    await within(entered.promise);
    f.hooks.afterQuery = async (sql) => { if (sql.includes("FROM users WHERE id = $1")) setImmediate(authenticated.resolve); };
    push(client, f.fileId, 1, "base accepted", " forbidden");
    await within(authenticated.promise);
    release.resolve();
    assert.equal((await save).status, 503);
    assert.equal((await client.next("error")).code, "COLLAB_ERROR");
    assert.equal(room.text(), "base accepted");
    assert.equal(f.app.collabRooms.get(f.fileId), room);
    assert.equal(client.messages.some((m) => ["file-closed", "resync", "revoked", "pushed"].includes(m.t)), false);
    await assert.rejects(f.app.collabPersistNow(room, false), { errorCode: "PROJECT_RECOVERY_REQUIRED" });
    assert.equal((await f.request(f.url)).status, 503);
  } finally { release.resolve(); await save; }
});

test("retention and source saves commit atomically at the checked revision and remain owner-only", options, async (t) => {
  const f = await setup(t);
  const policy = { buildKeep: 5, versionDays: 30 };
  const missing = await f.request(f.url, { method: "PUT", body: { retention: policy } });
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).errorCode, "PROJECT_REVISION_REQUIRED");

  const data = structuredClone(f.out.data);
  data.project.nodes[0].content = "committed text";
  const save = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data, retention: policy } });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.retention.buildKeep.value, 5);
  assert.equal(saved.retention.versionDays.value, 30);
  const projectRow = async () => (await f.pool.query(
    "SELECT name, revision, updated_at, build_keep, version_days FROM projects WHERE id = $1", [f.id]
  )).rows[0];
  const before = await projectRow();
  assert.equal(before.revision, 1);
  assert.equal(before.build_keep, 5);
  assert.equal(before.version_days, 30);
  const manifestPath = path.join(f.dir, ".iris", "project.json");
  const manifest = await fs.readFile(manifestPath);
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "committed text");

  const changed = structuredClone(saved.data);
  changed.project.nodes[0].content = "must roll back";
  let retentionWritten = false;
  f.hooks.afterClientQuery = async (sql) => {
    if (!/^UPDATE projects SET .*build_keep/.test(sql)) return;
    retentionWritten = true;
    throw new Error("injected failure after retention update");
  };
  try {
    const failed = await f.request(f.url, {
      method: "PUT", body: { baseRevision: 1, name: "Must roll back", data: changed, retention: { buildKeep: 9 } },
    });
    assert.equal(failed.status, 500);
    assert.equal(retentionWritten, true, "fail after both the sources and retention have been written");
  } finally { delete f.hooks.afterClientQuery; }
  assert.deepEqual(await projectRow(), before);
  assert.deepEqual(await fs.readFile(manifestPath), manifest);
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "committed text");

  const stale = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: changed, retention: { buildKeep: 9 } } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).errorCode, "PROJECT_REVISION_CONFLICT");
  assert.deepEqual(await projectRow(), before);
  assert.deepEqual(await fs.readFile(manifestPath), manifest);

  const editor = (await f.pool.query(
    "INSERT INTO users (id, username, email, display_name) VALUES ($1, 'editor', 'editor@example.test', 'Editor') RETURNING *", [uuidv7()]
  )).rows[0];
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [f.id, editor.id]);
  const edited = await f.request(f.url, {
    method: "PUT", cookie: f.cookieFor(editor), body: { baseRevision: 1, name: "Editor save", retention: { buildKeep: 9 } },
  });
  assert.equal(edited.status, 200);
  const out = await edited.json();
  assert.equal(out.data.revision, 2);
  assert.equal(out.retention.buildKeep.value, 5);
  assert.equal((await projectRow()).build_keep, 5);
  assert.equal((await f.pool.query(
    "SELECT action FROM audit_events WHERE target_id = $1 AND action = 'project.retention_changed'", [f.id]
  )).rows.length, 1, "only the committed owner policy change is audited");
});

test("the project revision timer groups dirty rooms into one transaction with each file's author", options, async (t) => {
  const idleMs = 61001;
  const f = await setup(t, { COLLAB_REVISION_IDLE_MS: String(idleMs) });
  const otherUser = (await f.pool.query(
    "INSERT INTO users (id, username, email, display_name) VALUES ($1, 'peer', 'peer@example.test', 'Peer') RETURNING *", [uuidv7()]
  )).rows[0];
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [f.id, otherUser.id]);
  const writer = await connect(t, f);
  const peer = await connect(t, { ...f, cookie: f.cookieFor(otherUser) });
  await peer.open(f.otherId);
  const scheduled = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    const timer = schedule(callback, ms, ...args);
    if (ms === idleMs) scheduled.push({ callback, timer });
    return timer;
  });
  let checkpointLocks = 0;
  f.hooks.beforeClientQuery = async (sql) => {
    if (sql.includes("pg_advisory_xact_lock(4953,")) checkpointLocks++;
  };
  await accepted(peer, f.otherId, 0, "other", " peer edit");
  await accepted(writer, f.fileId, 0, "base", " writer edit");
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[0].timer._destroyed, true, "activity in another room replaces the project's timer");
  assert.equal(scheduled[1].timer._destroyed, false);
  assert.equal(checkpointLocks, 0);
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base");
  assert.equal(await fs.readFile(path.join(f.dir, "other.tex"), "utf8"), "other");
  // Fire the actual scheduled callback without depending on wall-clock timing.
  clearTimeout(scheduled[1].timer);
  scheduled[1].callback();
  await until(() => f.app.collabRooms.forProject(f.id).every((room) => !room.needsRevision()));
  assert.equal(checkpointLocks, 1);
  const { rows } = await f.pool.query(
    `SELECT v.file_id, v.author_id, v.content, v.reason, v.xmin::text AS transaction_id
     FROM document_versions v JOIN project_files f ON f.id = v.file_id
     WHERE f.project_id = $1 ORDER BY f.path`, [f.id]
  );
  assert.deepEqual(rows.map((row) => [row.file_id, row.author_id, row.content, row.reason]), [
    [f.fileId, f.user.id, "base writer edit", "realtime"],
    [f.otherId, otherUser.id, "other peer edit", "realtime"],
  ]);
  assert.equal(new Set(rows.map((row) => row.transaction_id)).size, 1);
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "base writer edit");
  assert.equal(await fs.readFile(path.join(f.dir, "other.tex"), "utf8"), "other peer edit");
});
