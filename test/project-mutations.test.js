const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { ChangeSet } = require("@codemirror/state");
const { uuidv7 } = require("../src/ids");
const { createZip } = require("../src/zip");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");
const options = { skip: !connectionString, timeout: 20000 };

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Mutation barrier timed out")), 4000);
    })]);
  } finally { clearTimeout(timer); }
}

async function setup(t, env = {}) {
  const f = await serverFixture(t, env);
  const user = (await f.pool.query("INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, 'writer', 'writer@example.org', 'Writer', 'hash') RETURNING *", [uuidv7()])).rows[0];
  const cookie = f.cookieFor(user);
  const request = (url, opts = {}) => f.request(url, { cookie, ...opts });
  const create = async (name = "Original") => {
    const res = await request("/api/projects", { method: "POST", body: { name, data: { revision: 999, role: "viewer", project: { nodes: [
      { id: "a", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: "original\r\n" },
      { id: "b", type: "file", name: "bytes.bin", path: "bytes.bin", binary: true, data: "data:application/octet-stream;base64,AAEC/w==" },
    ] } } } });
    assert.equal(res.status, 201);
    return res.json();
  };
  const out = await create();
  const id = out.project.id;
  return { ...f, user, request, create, out, id, url: `/api/projects/${id}`, dir: path.join(f.dataDir, "projects", id) };
}

async function reader(f, member = true) {
  const user = (await f.pool.query("INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, 'reader', 'reader@example.org', 'Reader', 'hash') RETURNING *", [uuidv7()])).rows[0];
  if (member) await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')", [f.id, user.id]);
  return { user, cookie: f.cookieFor(user) };
}

async function treeBytes(dir, base = "") {
  const result = {};
  for (const entry of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { result[`${rel}/`] = null; Object.assign(result, await treeBytes(dir, rel)); }
    else result[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
  }
  return result;
}

function renamed(data, name = "renamed.tex") {
  const next = structuredClone(data);
  next.project.nodes[0].name = name;
  next.project.nodes[0].path = name;
  delete next.project.nodes[0].content;
  delete next.project.nodes[1].data;
  next.assets = {};
  return next;
}

test("a paused viewer download has a hard deadline that releases project writes", options, async (t) => {
  const f = await setup(t, { PROJECT_DOWNLOAD_TIMEOUT_MS: "250" });
  const viewer = await reader(f);
  await fs.writeFile(path.join(f.dir, "large.bin"), Buffer.alloc(12 * 1024 * 1024, 1));
  const closed = deferred();
  f.server.on("request", (req, res) => { if (req.url.includes("/files/download")) res.once("close", closed.resolve); });
  let response, save;
  const download = http.get(f.baseUrl + f.url + "/files/download?path=large.bin", { headers: { cookie: viewer.cookie }, agent: false });
  download.on("error", () => {});
  try {
    await within(new Promise((resolve) => download.once("response", (res) => { response = res; res.on("error", () => {}); res.pause(); resolve(); })));
    assert.equal(response.statusCode, 200);
    save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Not blocked forever", data: f.out.data } });
    assert.equal((await within(save)).status, 200);
    await within(closed.promise);
    assert.equal(f.streams.size, 0);
    assert.equal(response.complete, false, "the paused transfer was terminated, not fully delivered");
  } finally {
    response?.destroy(); download.destroy();
    f.streams.forEach((stream) => stream.destroy());
    if (save) await save;
  }
});

test("a disconnected queued download cannot retain the project gate", options, async (t) => {
  const f = await setup(t, { PROJECT_DOWNLOAD_TIMEOUT_MS: "10000" });
  const viewer = await reader(f);
  await fs.writeFile(path.join(f.dir, "large.bin"), Buffer.alloc(12 * 1024 * 1024, 1));
  f.out.data.project.nodes.push({ id: "large", type: "file", name: "large.bin", path: "large.bin", binary: true });
  const reached = deferred(), release = deferred(), authenticated = deferred(), disconnected = deferred();
  f.hooks.afterRename = async (src) => { if (src === path.join(f.dir, "main.tex")) { reached.resolve(); await release.promise; } };
  f.hooks.afterQuery = async (sql, params) => {
    if (sql.includes("FROM users WHERE id = $1") && params[0] === viewer.user.id) setImmediate(authenticated.resolve);
  };
  f.server.on("request", (req, res) => { if (req.url.includes("/files/download")) res.once("close", disconnected.resolve); });
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data) } });
  let download, next;
  try {
    await within(reached.promise);
    download = http.get(f.baseUrl + f.url + "/files/download?path=large.bin", { headers: { cookie: viewer.cookie }, agent: false });
    download.on("error", () => {});
    await within(authenticated.promise);
    download.destroy();
    await within(disconnected.promise);
    release.resolve();
    assert.equal((await save).status, 200);
    next = f.request(f.url, { method: "PUT", body: { baseRevision: 1, name: "Queue drained" } });
    assert.equal((await within(next)).status, 200);
    assert.equal(f.streams.size, 0);
  } finally {
    release.resolve(); download?.destroy();
    f.streams.forEach((stream) => stream.destroy());
    await save;
    if (next) await next;
  }
});

test("download read errors terminate the response safely and release the project gate", options, async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.dir, "large.bin"), Buffer.alloc(12 * 1024 * 1024, 1));
  const closed = deferred();
  f.server.on("request", (req, res) => { if (req.url.includes("/files/download")) res.once("close", closed.resolve); });
  let response;
  const download = http.get(f.baseUrl + f.url + "/files/download?path=large.bin", { headers: { cookie: f.cookieFor(f.user) }, agent: false });
  download.on("error", () => {});
  try {
    await within(new Promise((resolve) => download.once("response", (res) => { response = res; res.on("error", () => {}); res.pause(); resolve(); })));
    assert.equal(response.statusCode, 200);
    assert.equal(f.streams.size, 1);
    f.streams.values().next().value.destroy(new Error("injected read failure after headers"));
    await within(closed.promise);
    assert.equal((await within(f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: f.out.data } }))).status, 200);
    const normal = await within(f.request(f.url + "/files/download?path=main.tex"));
    assert.equal(normal.status, 200);
    assert.equal(await within(normal.text()), "original\r\n");
    assert.equal((await within(f.request(f.url))).status, 200);
    assert.equal(f.streams.size, 0);
  } finally { response?.destroy(); download.destroy(); f.streams.forEach((stream) => stream.destroy()); }
});

test("private recovery state stays hidden from nonmembers on project routes", options, async (t) => {
  const f = await setup(t);
  const outsider = await reader(f, false);
  const request = (suffix = "", opts = {}) => f.request(f.url + suffix, { cookie: outsider.cookie, ...opts });
  assert.equal((await request()).status, 404);
  f.hooks.afterClientQuery = async (sql) => { if (sql === "COMMIT") throw new Error("lost COMMIT acknowledgement"); };
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Committed" } })).status, 503);
  for (const [suffix, method] of [["", "GET"], ["", "PUT"], ["", "DELETE"], ["/compile", "POST"], ["/checkpoint", "POST"], ["/archive", "GET"], ["/files/download?path=main.tex", "GET"], [`/files/${f.out.data.project.nodes[0].id}/versions/${uuidv7()}/restore`, "POST"]]) {
    const body = method === "PUT" || method === "POST" ? { baseRevision: 1, data: f.out.data } : undefined;
    const denied = await request(suffix, { method, body });
    assert.equal(denied.status, 404, `${method} ${suffix}`);
    assert.equal((await denied.json()).errorCode, "PROJECT_NOT_FOUND");
    assert.equal((await f.request(f.url + suffix, { method, body })).status, 503);
  }
});

test("membership removed while queued is rechecked before revealing recovery state", options, async (t) => {
  const f = await setup(t);
  const viewer = await reader(f);
  const reached = deferred(), release = deferred(), authenticated = deferred();
  f.hooks.afterClientQuery = async (sql) => { if (sql === "COMMIT") { reached.resolve(); await release.promise; throw new Error("lost COMMIT acknowledgement"); } };
  f.hooks.afterQuery = async (sql, params) => {
    if (sql.includes("FROM users WHERE id = $1") && params[0] === viewer.user.id) setImmediate(authenticated.resolve);
  };
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Committed" } });
  let queued;
  try {
    await within(reached.promise);
    queued = f.request(f.url, { cookie: viewer.cookie });
    await within(authenticated.promise);
    await f.pool.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [f.id, viewer.user.id]);
    release.resolve();
    assert.equal((await save).status, 503);
    assert.equal((await within(queued)).status, 404);
    assert.equal((await f.request(f.url)).status, 503);
  } finally { release.resolve(); await save; if (queued) await queued; }
});

test("revision is server-owned and PUT/compile/checkpoint reject missing, malformed and stale bases", options, async (t) => {
  const f = await setup(t);
  assert.equal(f.out.project.revision, 0);
  assert.equal(f.out.data.revision, 0);
  assert.equal((await (await f.request(f.url)).json()).role, "owner");
  for (const [suffix, method] of [["", "PUT"], ["/compile", "POST"], ["/checkpoint", "POST"]]) {
    for (const baseRevision of [undefined, null, "0", -1, 0.5]) {
      const res = await f.request(f.url + suffix, { method, body: { data: f.out.data, baseRevision } });
      assert.equal(res.status, 428, `${suffix}: ${baseRevision}`);
      assert.equal((await res.json()).errorCode, "PROJECT_REVISION_REQUIRED");
    }
  }
  const saved = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data) } });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).data.revision, 1);
  for (const [suffix, method] of [["", "PUT"], ["/compile", "POST"], ["/checkpoint", "POST"]]) {
    const res = await f.request(f.url + suffix, { method, body: { data: f.out.data, baseRevision: 0 } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).params.currentRevision, 1);
  }
  assert.equal((await f.request(f.url, { method: "PUT", body: { name: "Name only" } })).status, 428);
  const nameOnly = await f.request(f.url, { method: "PUT", body: { name: "Name only", baseRevision: 1 } });
  assert.equal(nameOnly.status, 200);
  const current = await (await f.request(f.url)).json();
  assert.equal(current.revision, 2);
  assert.equal(current.project.nodes[0].path, "renamed.tex");
  assert.equal(current.project.nodes[0].content, "original\r\n");
  assert.equal((await (await f.request("/api/projects")).json()).projects[0].revision, 2);
  const checkpoint = await (await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).json();
  assert.equal(checkpoint.revision, undefined);
  assert.equal((await (await f.request(f.url)).json()).revision, 2);
  const cp = await f.request(f.url + "/checkpoint", { method: "POST", body: { baseRevision: 2, data: current } });
  assert.equal(cp.status, 200);
  const cpOut = await cp.json();
  assert.equal(cpOut.revision, 3);
  assert.equal(cpOut.data.revision, 3);
});

test("same-base rename has one winner, GET pairs revision/tree, and another project progresses", options, async (t) => {
  const f = await setup(t);
  const other = await f.create("Other");
  const reached = deferred(), release = deferred();
  let held = false;
  f.hooks.afterRename = async (src, dest) => {
    if (!held && src === path.join(f.dir, "main.tex")) { held = true; reached.resolve(); await release.promise; }
  };
  const first = f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data) } });
  try {
    await within(reached.promise);
    const second = f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data, "loser.tex") } });
    const get = f.request(f.url);
    const otherSave = await f.request(`/api/projects/${other.project.id}`, { method: "PUT", body: { baseRevision: 0, name: "Other changed" } });
    assert.equal(otherSave.status, 200);
    release.resolve();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 409);
    const current = await (await get).json();
    assert.equal(current.revision, 1);
    assert.equal(current.project.nodes[0].path, "renamed.tex");
    assert.equal(await fs.readFile(path.join(f.dir, "renamed.tex"), "utf8"), "original\r\n");
  } finally { release.resolve(); await first; }
});

for (const failure of ["rename", "write", "prune", "manifest", "sql"]) {
  test(`a precommit ${failure} failure restores exact bytes, namespace, manifest and ledger`, options, async (t) => {
    const f = await setup(t);
    await fs.mkdir(path.join(f.dir, "empty"));
    await fs.mkdir(path.join(f.dir, "output"));
    await fs.writeFile(path.join(f.dir, "output", "keep.pdf"), "output");
    await fs.writeFile(path.join(f.dir, ".iris", "cache"), "cache");
    const before = await treeBytes(f.dir);
    const ledger = (await f.pool.query("SELECT * FROM project_files WHERE project_id = $1 ORDER BY id", [f.id])).rows;
    let injected = false;
    const fail = () => { injected = true; throw Object.assign(new Error("injected I/O failure"), { code: "EIO" }); };
    f.hooks.beforeRename = async (src, dest) => {
      if (!injected && ((failure === "rename" && src === path.join(f.dir, "main.tex")) || (failure === "manifest" && dest === path.join(f.dir, ".iris", "project.json")))) fail();
    };
    f.hooks.beforeUnlink = async (file) => { if (!injected && failure === "prune" && file === path.join(f.dir, "bytes.bin")) fail(); };
    f.hooks.afterWriteFile = async (file) => { if (!injected && failure === "write" && file === path.join(f.dir, "renamed.tex")) fail(); };
    f.hooks.beforeClientQuery = async (sql) => { if (!injected && failure === "sql" && /^UPDATE projects SET/.test(sql)) fail(); };
    const data = renamed(f.out.data);
    if (failure === "write") data.project.nodes[0].content = "partially saved new bytes";
    data.project.nodes.pop();
    const res = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } });
    assert.equal(res.status, 500);
    assert.equal(injected, true);
    assert.deepEqual(await treeBytes(f.dir), before);
    assert.deepEqual((await f.pool.query("SELECT * FROM project_files WHERE project_id = $1 ORDER BY id", [f.id])).rows, ledger);
    assert.equal((await (await f.request(f.url)).json()).revision, 0);
  });
}

test("occupied rename destination is rejected before changing source bytes", options, async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.dir, "occupied.tex"), "do not overwrite");
  const before = await treeBytes(f.dir);
  f.hooks.beforeRm = async (file) => { if (file.startsWith(f.dir + path.sep)) assert.fail("invalid rename must not rewrite live state"); };
  const res = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data, "occupied.tex") } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errorCode, "PROJECT_PATH_INVALID");
  assert.deepEqual(await treeBytes(f.dir), before);
});

test("swaps, chains and ambiguous paths fail preflight without any live I/O", options, async (t) => {
  const f = await setup(t);
  const before = await treeBytes(f.dir);
  for (const kind of ["swap", "chain", "duplicate", "parent", "new parent"]) {
    const data = structuredClone(f.out.data);
    const [a, b] = data.project.nodes;
    a.name = a.path = kind === "duplicate" ? "other.tex" : "bytes.bin";
    b.name = b.path = kind === "swap" ? "main.tex" : kind === "parent" ? "bytes.bin/child.tex" : "other.tex";
    if (kind === "new parent") { a.name = a.path = "new"; b.name = b.path = "new/child.tex"; }
    const res = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } });
    assert.equal(res.status, 400, kind);
    assert.equal((await res.json()).errorCode, "PROJECT_PATH_INVALID");
    assert.deepEqual(await treeBytes(f.dir), before);
  }
});

for (const failure of ["rollback", "commit"]) {
  test(`${failure} uncertainty retains the backup and fails closed`, options, async (t) => {
    const f = await setup(t);
    const before = await treeBytes(f.dir);
    f.hooks.beforeClientQuery = async (sql) => {
      if (failure === "rollback" && /^UPDATE projects SET/.test(sql)) throw new Error("precommit failure");
    };
    f.hooks.beforeCp = async (from) => {
      if (failure === "rollback" && from.includes(".project-backups")) throw new Error("compensation unavailable");
    };
    f.hooks.afterClientQuery = async (sql) => { if (failure === "commit" && sql === "COMMIT") throw new Error("lost COMMIT acknowledgement"); };
    const res = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data) } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).errorCode, "PROJECT_RECOVERY_REQUIRED");
    const backup = path.join(f.dataDir, ".project-backups", f.id);
    assert.deepEqual(await treeBytes(backup), before);
    assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, failure === "commit" ? 1 : 0);
    for (const [method, body] of [["GET", undefined], ["PUT", { baseRevision: 0, data: f.out.data }], ["DELETE", undefined]]) {
      assert.equal((await f.request(f.url, { method, body })).status, 503);
    }
    assert.equal((await f.request(f.url + "/archive")).status, 503);
    assert.equal((await f.request(f.url + "/files/download?path=renamed.tex")).status, 503);
    assert.deepEqual(await treeBytes(backup), before);
  });
}

test("a checked-out PostgreSQL row lock blocks only that project's mutation", options, async (t) => {
  const f = await setup(t);
  const other = await f.create("Other");
  const lock = await f.pool.connect();
  const reached = deferred();
  let pending;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [f.id]);
    f.hooks.beforeClientQuery = async (sql, params) => { if (/SELECT id FROM projects.*FOR UPDATE/.test(sql) && params[0] === f.id) reached.resolve(); };
    pending = f.request(f.url, { method: "PUT", body: { baseRevision: 0, name: "Locked" } });
    await within(reached.promise);
    assert.equal((await f.request(`/api/projects/${other.project.id}`, { method: "PUT", body: { baseRevision: 0, name: "Unlocked" } })).status, 200);
    assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, 0);
  } finally { await lock.query("ROLLBACK"); lock.release(); }
  assert.equal((await pending).status, 200);
});

test("live flush waits for compensation, follows committed renames, and never recreates a deleted file", options, async (t) => {
  const f = await setup(t);
  const fileId = f.out.data.project.nodes[0].id;
  const room = f.app.collabRooms.open({ fileId, projectId: f.id, path: "main.tex", content: "original\r\n" });
  room.storageDir = f.dir;
  const edit = (text) => room.receive(room.version, [{ clientID: "test", changes: ChangeSet.of({ from: 0, to: room.text().length, insert: text }, room.text().length).toJSON() }]);
  const reached = deferred(), release = deferred();
  let fail = true;
  f.hooks.beforeClientQuery = async (sql) => { if (fail && /^UPDATE projects SET/.test(sql)) { fail = false; throw new Error("save failure"); } };
  f.hooks.beforeCp = async (from) => { if (from.includes(".project-backups") && from.endsWith("main.tex")) { reached.resolve(); await release.promise; } };
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data) } });
  let flush;
  try {
    await within(reached.promise);
    edit("live during rollback");
    flush = f.app.collabPersistNow(room, false);
    release.resolve();
    assert.equal((await save).status, 500);
    await flush;
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "live during rollback");
  } finally { release.resolve(); await save; if (flush) await flush; }
  f.hooks.beforeCp = null;
  const next = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data) } });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).data.project.nodes[0].content, "live during rollback");
  edit("live after rename");
  await f.app.collabPersistNow(room, false);
  assert.equal(await fs.readFile(path.join(f.dir, "renamed.tex"), "utf8"), "live after rename");
  await assert.rejects(fs.stat(path.join(f.dir, "main.tex")), { code: "ENOENT" });
  const data = { project: { nodes: [] } };
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 1, data } })).status, 200);
  edit("must not recreate");
  await f.app.collabPersistNow(room, false);
  await assert.rejects(fs.stat(path.join(f.dir, "renamed.tex")), { code: "ENOENT" });
  assert.equal((await (await f.request(f.url)).json()).revision, 2);
});

test("collabJoin seeds from the committed namespace after a rename", options, async (t) => {
  const f = await setup(t);
  const reached = deferred(), release = deferred();
  f.hooks.afterRename = async (src) => { if (src === path.join(f.dir, "main.tex")) { reached.resolve(); await release.promise; } };
  const save = f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: renamed(f.out.data) } });
  const session = { user: { sub: f.user.id, exp: Math.floor(Date.now() / 1000) + 60 }, rooms: new Map(), socket: { OPEN: 1, readyState: 1 } };
  let join;
  try {
    await within(reached.promise);
    join = f.app.collabJoin(session, f.out.data.project.nodes[0].id);
    release.resolve();
    assert.equal((await save).status, 200);
    const entry = await join;
    assert.equal(entry.room.path, "renamed.tex");
    assert.equal(entry.room.text(), "original\r\n");
  } finally { release.resolve(); await save; if (join) await join; }
});

test("compiler failure still returns the committed revision and snapshot; no-data compile reads current tree", options, async (t) => {
  const f = await setup(t);
  for (const withData of [true, false]) {
    const res = await f.request(f.url + "/compile", { method: "POST", body: { texPath: path.join(f.dataDir, "missing-tool"), ...(withData ? { baseRevision: 0, data: f.out.data } : {}) } });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.success, false);
    assert.equal(out.revision, withData ? 1 : 2);
    assert.equal(out.data.revision, out.revision);
    assert.equal(out.data.project.nodes[0].content, "original\r\n");
  }
});

test("PUT, checkpoint and compile all save live-room authority rather than stale payloads", options, async (t) => {
  const f = await setup(t);
  const room = f.app.collabRooms.open({ fileId: f.out.data.project.nodes[0].id, projectId: f.id, path: "main.tex", content: "live authority" });
  room.storageDir = f.dir;
  let baseRevision = 0;
  for (const [suffix, method] of [["", "PUT"], ["/checkpoint", "POST"], ["/compile", "POST"]]) {
    const res = await f.request(f.url + suffix, { method, body: { baseRevision, data: f.out.data, texPath: path.join(f.dataDir, "missing-tool") } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.project.nodes[0].content, "live authority");
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "live authority");
    baseRevision++;
  }
});

test("binary renames preserve omitted bytes, and a missing required source fails without fabricating content", options, async (t) => {
  const f = await setup(t);
  const data = renamed(f.out.data);
  data.project.nodes[1].name = data.project.nodes[1].path = "moved.bin";
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } })).status, 200);
  assert.deepEqual(await fs.readFile(path.join(f.dir, "moved.bin")), Buffer.from([0, 1, 2, 255]));
  await fs.unlink(path.join(f.dir, "renamed.tex"));
  data.project.nodes[0].name = data.project.nodes[0].path = "missing.tex";
  const before = await treeBytes(f.dir);
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 1, data } })).status, 500);
  assert.deepEqual(await treeBytes(f.dir), before);
  assert.equal((await (await f.request(f.url)).json()).revision, 1);
});

test("restore compensates failed writes and leaves the browser revision unchanged", options, async (t) => {
  const f = await setup(t);
  const fileId = f.out.data.project.nodes[0].id;
  assert.equal((await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).status, 200);
  const versionId = (await f.pool.query("SELECT id FROM document_versions WHERE file_id = $1", [fileId])).rows[0].id;
  const data = structuredClone(f.out.data);
  data.project.nodes[0].content = "newer bytes";
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } })).status, 200);
  const before = await treeBytes(f.dir);
  f.hooks.beforeClientQuery = async (sql) => { if (/^UPDATE projects SET/.test(sql)) throw new Error("restore failure"); };
  const url = `${f.url}/files/${fileId}/versions/${versionId}/restore`;
  assert.equal((await f.request(url, { method: "POST", body: {} })).status, 500);
  assert.deepEqual(await treeBytes(f.dir), before);
  assert.equal((await f.pool.query("SELECT id FROM document_versions WHERE file_id = $1", [fileId])).rows.length, 1);
  f.hooks.beforeClientQuery = null;
  const room = f.app.collabRooms.open({ fileId, projectId: f.id, path: "main.tex", content: "newer bytes" });
  room.storageDir = f.dir;
  assert.equal((await f.request(url, { method: "POST", body: {} })).status, 200);
  assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "original\r\n");
  assert.equal(room.text(), "original\r\n");
  assert.equal((await (await f.request(f.url)).json()).revision, 1);
});

test("deleting a project after compile setup cannot recreate its live storage", options, async (t) => {
  const f = await setup(t);
  const reached = deferred(), release = deferred();
  f.hooks.beforeMkdir = async (dir) => { if (dir.endsWith("texmf-var")) { reached.resolve(); await release.promise; } };
  const compile = f.request(f.url + "/compile", { method: "POST", body: { baseRevision: 0, data: f.out.data, texPath: path.join(f.dataDir, "missing-tool") } });
  try {
    await within(reached.promise);
    assert.equal((await f.request(f.url, { method: "DELETE" })).status, 200);
    release.resolve();
    const res = await compile;
    assert.equal(res.status, 404);
    assert.equal((await res.json()).params.savedRevision, 1);
    await assert.rejects(fs.stat(f.dir), { code: "ENOENT" });
    assert.equal((await f.pool.query("SELECT id FROM build_outputs WHERE project_id = $1", [f.id])).rows.length, 0);
  } finally { release.resolve(); await compile; }
});

for (const admin of [false, true]) {
  test(`${admin ? "admin" : "owner"} deletion rolls back namespace and SQL on precommit failure`, options, async (t) => {
    const f = await setup(t);
    await f.pool.query("UPDATE users SET system_role = 'admin' WHERE id = $1", [f.user.id]);
    await fs.mkdir(path.join(f.dir, "output"));
    await fs.writeFile(path.join(f.dir, "output", "build.pdf"), "keep output on rollback");
    const before = await treeBytes(f.dir);
    let fail = true;
    f.hooks.afterQuery = f.hooks.afterClientQuery = async (sql) => { if (fail && /^DELETE FROM projects/.test(sql)) { fail = false; throw new Error("delete failed"); } };
    const res = await f.request(admin ? `/api/admin/projects/${f.id}` : f.url, { method: "DELETE" });
    assert.equal(res.status, 500);
    assert.equal((await f.pool.query("SELECT id FROM projects WHERE id = $1", [f.id])).rows.length, 1);
    assert.deepEqual(await treeBytes(f.dir), before);
  });
}

test("compile setup failure acknowledges the already committed save", options, async (t) => {
  const f = await setup(t);
  f.hooks.beforeMkdir = async (dir) => { if (dir.includes(".build-staging")) throw new Error("staging unavailable"); };
  const res = await f.request(f.url + "/compile", { method: "POST", body: { baseRevision: 0, data: f.out.data } });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).params.savedRevision, 1);
  assert.equal((await (await f.request(f.url)).json()).revision, 1);
});

for (const imported of [false, true]) {
  test(`${imported ? "import" : "create"} is invisible until its manifest and ledger are ready`, options, async (t) => {
    const f = await setup(t);
    const reached = deferred(), release = deferred();
    let held = false;
    f.hooks.afterClientQuery = f.hooks.afterQuery = async (sql) => {
      if (!held && /INSERT INTO project_members/.test(sql)) { held = true; reached.resolve(); await release.promise; }
    };
    let pending;
    if (imported) {
      const archive = createZip([{ name: ".iris/project.json", data: Buffer.from(JSON.stringify({ revision: 42, irisArchive: { format: "iris-project", version: 1 }, project: { name: "Imported", nodes: [] } })) }]);
      const cookie = f.cookieFor((await f.pool.query("SELECT * FROM users")).rows[0]);
      pending = fetch(f.baseUrl + "/api/projects/import", { method: "POST", headers: { cookie, "content-type": "application/zip" }, body: archive, signal: AbortSignal.timeout(15000) });
    } else pending = f.request("/api/projects", { method: "POST", body: { name: "New" } });
    try {
      await within(reached.promise);
      assert.equal((await f.pool.query("SELECT id FROM projects")).rows.length, 1);
      assert.equal((await (await f.request("/api/projects")).json()).projects.length, 1);
      release.resolve();
      const response = await pending;
      assert.equal(response.status, 201);
      const out = await response.json();
      assert.equal(out.project.revision, 0);
      assert.equal(out.data.revision, 0);
    } finally { release.resolve(); await pending; }
  });
}
