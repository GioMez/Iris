const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { ChangeSet } = require("@codemirror/state");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");
const options = { skip: !connectionString, timeout: 20000 };
const mainText = "\\documentclass{article}\r\n\\begin{document}Snapshot\\end{document}\r\n";
const partText = "First line\r\nSecond line\r\n";
const binary = Buffer.from([0, 255, 13, 10, 128, 1]);
const font = Buffer.from([0, 1, 0, 0, 255, 13, 10]);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Compile snapshot barrier timed out")), 4000);
    })]);
  } finally { clearTimeout(timer); }
}

function files(data) {
  return data.project.nodes.flatMap(function walk(node) {
    return node.type === "folder" ? node.children.flatMap(walk) : [node];
  });
}

function sparse(data) {
  const copy = structuredClone(data);
  for (const node of files(copy)) { delete node.content; delete node.data; }
  for (const font of copy.fonts || []) delete font.data;
  copy.assets = {};
  return copy;
}

async function setup(t, data) {
  const f = await serverFixture(t, {
    COLLAB_FLUSH_MS: "60000", COLLAB_FLUSH_MAX_MS: "60000", COLLAB_REVISION_IDLE_MS: "60000",
  });
  const user = (await f.pool.query("INSERT INTO users (id, username, email, display_name) VALUES ($1, 'writer', 'writer@example.test', 'Writer') RETURNING *", [uuidv7()])).rows[0];
  const request = (url, opts = {}) => f.request(url, { cookie: f.cookieFor(user), ...opts });
  const create = async (data) => {
    const res = await request("/api/projects", { method: "POST", body: { name: "Snapshot", data } });
    assert.equal(res.status, 201);
    return res.json();
  };
  const out = await create(data || { project: { nodes: [
    { id: "main", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: mainText },
    { type: "folder", name: "parts", children: [
      { id: "part", type: "file", name: "one.tex", path: "parts/one.tex", kind: "tex", content: partText },
      { id: "notes", type: "file", name: "notes.txt", path: "parts/notes.txt", content: "clear me" },
      { type: "folder", name: "empty", children: [] },
    ] },
    { id: "image", type: "file", name: "image.bin", path: "image.bin", binary: true, data: `data:application/octet-stream;base64,${binary.toString("base64")}` },
    { type: "folder", name: "fonts", children: [
      { id: "font", type: "file", name: "example.ttf", path: "fonts/example.ttf", kind: "font", binary: true, data: `data:font/ttf;base64,${font.toString("base64")}` },
    ] },
  ] } });
  const id = out.project.id;
  const url = `/api/projects/${id}`;
  const compile = (body = {}) => request(url + "/compile", { method: "POST", body: {
    texPath: path.join(f.dataDir, "missing-compiler"), lilypondPath: path.join(f.dataDir, "missing-compiler"), ...body,
  } });
  return { ...f, user, request, create, compile, out, id, url, dir: path.join(f.dataDir, "projects", id) };
}

async function tree(dir, base = "") {
  const result = {};
  for (const entry of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { result[rel + "/"] = null; Object.assign(result, await tree(dir, rel)); }
    else result[rel] = await fs.readFile(path.join(dir, rel));
  }
  return result;
}

async function assertClean(f) {
  const builds = path.join(f.dataDir, ".build-staging", f.id);
  const deadline = Date.now() + 4000;
  while ((await fs.readdir(builds).catch((err) => { if (err.code !== "ENOENT") throw err; return []; })).length) {
    assert.ok(Date.now() < deadline, "staging cleanup timed out");
    await delay(5);
  }
}

test("sparse compile snapshots exact saved text, explicit empty, binary, fonts and declared empty folders only", options, async (t) => {
  const f = await setup(t);
  await fs.mkdir(path.join(f.dir, "output"));
  await fs.writeFile(path.join(f.dir, "output", "old.pdf"), "old output");
  await fs.writeFile(path.join(f.dir, ".iris", "cache"), "private cache");
  const data = sparse(f.out.data);
  files(data).find((node) => node.name === "notes.txt").content = "";
  const large = Buffer.alloc(16 * 1024 * 1024 + 1, 97);
  await fs.writeFile(path.join(f.dir, "large.txt"), large);
  data.project.nodes.push({ id: "large", type: "file", name: "large.txt", path: "large.txt" });
  let snapshot;
  f.hooks.beforeMkdir = async (dir) => {
    if (dir.endsWith("texmf-var")) snapshot = await tree(path.dirname(path.dirname(dir)));
  };
  const res = await f.compile({ baseRevision: 0, data });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.success, false);
  assert.equal(out.revision, 1);
  for (const [rel, bytes] of Object.entries({ "main.tex": Buffer.from(mainText), "parts/one.tex": Buffer.from(partText), "parts/notes.txt": Buffer.alloc(0), "image.bin": binary, "fonts/example.ttf": font, "large.txt": large })) {
    assert.deepEqual(snapshot[rel], bytes, rel);
    assert.deepEqual(await fs.readFile(path.join(f.dir, rel)), bytes, `live ${rel}`);
  }
  assert.equal(snapshot["parts/empty/"], null);
  assert.equal(snapshot["output/old.pdf"], undefined);
  assert.equal(snapshot[".iris/cache"], undefined);
  assert.equal(files(out.data).find((node) => node.name === "image.bin").data, undefined);
  assert.equal(out.data.fonts[0].data, undefined);
  assert.equal(files(out.data).find((node) => node.name === "one.tex").content, undefined);
  assert.equal(out.sourceContentHash, hash(Buffer.from(mainText)));
  const versions = (await f.pool.query("SELECT f.path, v.content FROM document_versions v JOIN project_files f ON f.id = v.file_id WHERE f.project_id = $1 ORDER BY f.path", [f.id])).rows;
  assert.deepEqual(versions, [{ path: "main.tex", content: mainText }, { path: "parts/notes.txt", content: "" }, { path: "parts/one.tex", content: partText }]);
  await assertClean(f);
});

test("omitted renamed text, assets and fonts copy from normalized committed paths with canonical identities", options, async (t) => {
  const f = await setup(t);
  const data = sparse(f.out.data);
  const [main, part, notes, image, fontNode] = files(data);
  main.name = "renamed.tex";
  main.path = "parts\\.\\renamed.tex";
  part.name = "moved.tex";
  delete part.path;
  image.name = image.path = "moved.bin";
  fontNode.name = "moved.ttf";
  delete fontNode.path;
  let snapshot;
  f.hooks.beforeMkdir = async (dir) => { if (dir.endsWith("texmf-var")) snapshot = await tree(path.dirname(path.dirname(dir))); };
  const res = await f.compile({ baseRevision: 0, data, mainPath: "parts/renamed.tex" });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.mainPath, "parts/renamed.tex");
  assert.equal(out.sourceFileId, main.id);
  for (const [rel, bytes] of Object.entries({ "parts/renamed.tex": Buffer.from(mainText), "parts/moved.tex": Buffer.from(partText), "moved.bin": binary, "fonts/moved.ttf": font })) assert.deepEqual(snapshot[rel], bytes, rel);
  for (const rel of ["main.tex", "parts/one.tex", "image.bin", "fonts/example.ttf"]) {
    assert.equal(snapshot[rel], undefined);
    await assert.rejects(fs.stat(path.join(f.dir, rel)), { code: "ENOENT" });
  }
  const ledger = (await f.pool.query("SELECT id, path FROM project_files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path", [f.id])).rows;
  assert.deepEqual(ledger, [
    { id: fontNode.id, path: "fonts/moved.ttf" }, { id: image.id, path: "moved.bin" },
    { id: part.id, path: "parts/moved.tex" }, { id: notes.id, path: "parts/notes.txt" }, { id: main.id, path: "parts/renamed.tex" },
  ]);
});

for (const [projectType, ext, marker] of [["latex", "tex", "\\documentclass{article}"], ["lilypond", "ly", "\\score { c' }"]]) {
  test(`${projectType} auto-main uses effective disk or room text in candidate DFS order, not sparse or stale payloads`, options, async (t) => {
    const f = await setup(t, { projectType, project: { nodes: [
      { id: "include", type: "file", name: `include.${ext}`, path: `include.${ext}`, content: "fragment" },
      { type: "folder", name: "nested", children: [
        { id: "main", type: "file", name: `main.${ext}`, content: marker },
      ] },
      { id: "later", type: "file", name: `later.${ext}`, path: `later.${ext}`, content: marker },
    ] } });
    const data = sparse(f.out.data);
    const first = await f.compile({ baseRevision: 0, data });
    assert.equal(first.status, 200);
    const out = await first.json();
    assert.equal(out.mainPath, `nested/main.${ext}`);
    const nodes = files(out.data);
    const room = f.app.collabRooms.open({ fileId: nodes[1].id, projectId: f.id, path: `nested/main.${ext}`, content: "now only a fragment" });
    room.storageDir = f.dir;
    const live = f.app.collabRooms.open({ fileId: nodes[2].id, projectId: f.id, path: `later.${ext}`, content: marker + " live" });
    live.storageDir = f.dir;
    nodes[1].content = marker;
    nodes[2].content = "stale fragment";
    const second = await f.compile({ baseRevision: 1, data: out.data });
    assert.equal(second.status, 200);
    const current = await second.json();
    assert.equal(current.mainPath, `later.${ext}`);
    assert.equal(current.sourceFileId, nodes[2].id);
    assert.equal(current.sourceContentHash, hash(marker + " live"));
    const requested = await f.compile({ baseRevision: 2, data: sparse(current.data), mainPath: `include.${ext}` });
    assert.equal(requested.status, 200);
    assert.equal((await requested.json()).mainPath, `include.${ext}`);
  });
}

test("blocked snapshot copy queues same-project save and push but not another project; later room text cannot change staging versions", options, async (t) => {
  const f = await setup(t);
  const other = await f.create();
  const mainId = files(f.out.data)[0].id;
  const partId = files(f.out.data)[1].id;
  const messages = [];
  const session = { user: { sub: f.user.id, exp: Math.floor(Date.now() / 1000) + 60 }, request: { headers: { cookie: f.cookieFor(f.user) } }, rooms: new Map(), socket: { OPEN: 1, readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) } };
  const entry = await f.app.collabJoin(session, partId);
  session.rooms.set(partId, entry);
  const entered = deferred(), release = deferred(), pushQueued = deferred(), authenticated = deferred();
  let stagingDir, saved = false, pushed = false, authCount = 0;
  f.hooks.beforeWriteFile = async (file) => {
    if (file.includes(".build-staging") && file.endsWith("one.tex")) {
      stagingDir = path.dirname(path.dirname(file));
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.compile({ baseRevision: 0, data: sparse(f.out.data) });
  let save, push;
  try {
    await within(entered.promise);
    f.hooks.afterQuery = async (sql) => {
      if (sql.includes("FROM users WHERE id = $1")) setImmediate(++authCount === 1 ? pushQueued.resolve : authenticated.resolve);
    };
    push = f.app.collabHandleMessage(session, JSON.stringify({ t: "push", fileId: partId, version: entry.room.version, updates: [
      { clientID: "snapshot", changes: ChangeSet.of({ from: 0, to: entry.room.text().length, insert: "new room text after copy" }, entry.room.text().length).toJSON() },
    ] })).then(() => { pushed = true; });
    await within(pushQueued.promise);
    const newer = sparse(f.out.data);
    files(newer)[0].content = "new main after copy";
    save = f.request(f.url, { method: "PUT", body: { baseRevision: 1, data: newer } }).then((res) => { saved = true; return res; });
    await within(authenticated.promise);
    assert.equal((await f.request(`/api/projects/${other.project.id}`, { method: "PUT", body: { baseRevision: 0, name: "Other progresses" } })).status, 200);
    assert.equal(saved, false);
    assert.equal(pushed, false);
    assert.equal(entry.room.text(), partText);
    assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, 1);
    release.resolve();
    assert.equal((await within(save)).status, 200);
    await within(push);
    assert.ok(messages.some((m) => m.t === "pushed" && m.accepted));
    const res = await pending;
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.revision, 1);
    assert.equal(out.sourceFileId, mainId);
    assert.equal(out.sourceContentHash, hash(mainText));
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "new main after copy");
    assert.equal(await fs.readFile(path.join(f.dir, "parts/one.tex"), "utf8"), "new room text after copy");
    const versions = (await f.pool.query("SELECT file_id, content, content_hash FROM document_versions WHERE file_id = ANY($1::uuid[]) ORDER BY file_id", [[mainId, partId]])).rows;
    assert.deepEqual(versions, [
      { file_id: mainId, content: mainText, content_hash: hash(mainText) },
      { file_id: partId, content: partText, content_hash: hash(partText) },
    ].sort((a, b) => a.file_id.localeCompare(b.file_id)));
    const build = (await f.pool.query("SELECT source_content_hash, source_revision_id FROM build_outputs WHERE id = $1", [out.buildId])).rows[0];
    assert.equal(build.source_content_hash, hash(mainText));
    assert.equal(build.source_revision_id, out.sourceRevisionId);
    await assertClean(f);
    await assert.rejects(fs.stat(stagingDir), { code: "ENOENT" });
    assert.equal((await f.request(`${f.url}/builds/${out.buildId}`, { method: "DELETE" })).status, 200);
  } finally { release.resolve(); await pending; if (save) await save; if (push) await push; }
});

test("no-data compile propagates expected and discovered hydration/scan read errors without rewriting live bytes; GET stays tolerant", options, async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.dir, "parts", "discovered.txt"), "discovered bytes");
  const before = await tree(f.dir);
  for (const [rel, code, occurrence] of [["main.tex", "EIO", 1], ["image.bin", "EACCES", 1], ["fonts/example.ttf", "EIO", 1], ["parts/discovered.txt", "EIO", 1], ["parts/one.tex", "EACCES", 2]]) {
    let reads = 0;
    f.hooks.beforeReadFile = async (file) => {
      if (file === path.join(f.dir, rel) && ++reads === occurrence) throw Object.assign(new Error("compile input unreadable"), { code });
    };
    const res = await f.compile();
    assert.equal(res.status, 500, `${rel} read ${occurrence}`);
    assert.equal((await res.json()).params?.savedRevision, undefined);
    assert.deepEqual(await tree(f.dir), before);
    assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, 0);
    await assertClean(f);
  }
  f.hooks.beforeReadFile = async (file) => { if (file === path.join(f.dir, "main.tex")) throw Object.assign(new Error("GET still tolerant"), { code: "EIO" }); };
  const get = await f.request(f.url);
  assert.equal(get.status, 200);
  assert.equal(files(await get.json())[0].content, "");
  assert.deepEqual(await tree(f.dir), before);
});

test("postcommit copy, staging checkpoint and setup failures acknowledge only the saved revision and clean partial builds", options, async (t) => {
  const f = await setup(t);
  let revision = 0;
  for (const [phase, code] of [["copy-read", "ENOENT"], ["copy-read", "EIO"], ["copy-write", "EACCES"], ["checkpoint", "EIO"], ["checkpoint", "ENOENT"], ["setup", "EIO"]]) {
    let confirmed = false, injected = false;
    f.hooks.afterClientQuery = async (sql) => { if (sql === "COMMIT") confirmed = true; };
    const fail = () => { injected = true; throw Object.assign(new Error("strict staging failure"), { code }); };
    f.hooks.beforeReadFile = async (file) => {
      if (confirmed && phase === "copy-read" && file === path.join(f.dir, "parts/notes.txt")) fail();
      if (phase === "checkpoint" && file.includes(".build-staging") && file.endsWith("notes.txt")) fail();
    };
    f.hooks.beforeWriteFile = async (file) => { if (phase === "copy-write" && file.includes(".build-staging") && file.endsWith("image.bin")) fail(); };
    f.hooks.beforeMkdir = async (dir) => { if (phase === "setup" && dir.endsWith("texmf-var")) fail(); };
    const res = await f.compile({ baseRevision: revision, data: sparse(f.out.data) });
    assert.equal(res.status, 500, `${phase} ${code}`);
    assert.equal(injected, true);
    assert.equal((await res.json()).params.savedRevision, ++revision);
    assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, revision);
    assert.equal(await fs.readFile(path.join(f.dir, "parts/notes.txt"), "utf8"), "clear me");
    await assertClean(f);
    const builds = (await f.pool.query("SELECT id, status FROM build_outputs WHERE project_id = $1", [f.id])).rows;
    assert.equal(builds.length, phase === "setup" ? 1 : 0);
    if (phase === "setup") {
      assert.equal(builds[0].status, "failed");
      assert.equal((await f.request(`${f.url}/builds/${builds[0].id}`, { method: "DELETE" })).status, 200);
    } else assert.equal((await f.pool.query("SELECT id FROM document_versions")).rows.length, 0);
  }
});

test("precommit main/read/argument/CAS failures restore the save, and uncertain COMMIT never acknowledges an advanced data revision", options, async (t) => {
  const f = await setup(t);
  const before = await tree(f.dir);
  const noMain = sparse(f.out.data);
  noMain.project.nodes = [files(noMain).find((node) => node.name === "image.bin")];
  const invalidMain = sparse(f.out.data);
  files(invalidMain)[0].name = files(invalidMain)[0].path = "bad^^name.tex";
  for (const [body, status] of [
    [{ baseRevision: 0, data: noMain }, 400],
    [{ baseRevision: 0, data: invalidMain }, 400],
    [{ baseRevision: 0, data: sparse(f.out.data), compileProfile: { mode: "custom", steps: [{ tool: "[engine]", args: ["-shell-escape", "[main]"] }] } }, 400],
    [{ baseRevision: 9, data: sparse(f.out.data) }, 409],
  ]) {
    const res = await f.compile(body);
    assert.equal(res.status, status);
    assert.equal((await res.json()).params?.savedRevision, undefined);
    assert.deepEqual(await tree(f.dir), before);
  }
  f.hooks.beforeReadFile = async (file) => { if (file === path.join(f.dir, "main.tex")) throw Object.assign(new Error("effective main unreadable"), { code: "EACCES" }); };
  const unreadable = await f.compile({ baseRevision: 0, data: sparse(f.out.data) });
  assert.equal(unreadable.status, 500);
  assert.equal((await unreadable.json()).params?.savedRevision, undefined);
  assert.deepEqual(await tree(f.dir), before);
  assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, 0);
  f.hooks.beforeReadFile = null;
  f.hooks.afterClientQuery = async (sql) => { if (sql === "COMMIT") throw new Error("lost COMMIT acknowledgement"); };
  const uncertain = await f.compile({ baseRevision: 0, data: sparse(f.out.data) });
  assert.equal(uncertain.status, 503);
  const out = await uncertain.json();
  assert.equal(out.errorCode, "PROJECT_RECOVERY_REQUIRED");
  assert.equal(out.params?.savedRevision, undefined);
  assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, 1);
  assert.equal((await f.request(f.url)).status, 503);
  await assertClean(f);
});

test("no-data compile still reconciles genuinely absent stale manifest entries without recreating them", options, async (t) => {
  const f = await setup(t);
  const nodes = files(f.out.data);
  await fs.unlink(path.join(f.dir, "parts/one.tex"));
  await fs.unlink(path.join(f.dir, "image.bin"));
  await fs.unlink(path.join(f.dir, "fonts/example.ttf"));
  const res = await f.compile();
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.revision, 1);
  assert.equal(out.sourceContentHash, hash(mainText));
  assert.deepEqual(files(out.data).map((node) => node.name), ["main.tex", "notes.txt"]);
  const deleted = (await f.pool.query("SELECT id FROM project_files WHERE project_id = $1 AND deleted_at IS NOT NULL ORDER BY id", [f.id])).rows.map((row) => row.id);
  assert.deepEqual(deleted, [nodes[1].id, nodes[3].id, nodes[4].id].sort());
  for (const rel of ["parts/one.tex", "image.bin", "fonts/example.ttf"]) await assert.rejects(fs.stat(path.join(f.dir, rel)), { code: "ENOENT" });
  await assertClean(f);
});

test("review regression: requested main aliases normalize without changing unmatched fallback", options, async (t) => {
  for (const [requested, expected] of [
    ["parts\\.\\wanted.tex", "parts/wanted.tex"],
    ["parts/./wanted.tex", "parts/wanted.tex"],
    ["parts/wanted.tex", "parts/wanted.tex"],
    ["parts/missing.tex", "first.tex"],
    ["../outside.tex", "first.tex"],
    ["", "first.tex"],
    [null, "first.tex"],
  ]) await t.test(JSON.stringify(requested), async (t) => {
    const f = await setup(t, { project: { nodes: [
      { id: "first", type: "file", name: "first.tex", path: "first.tex", content: mainText },
      { type: "folder", name: "parts", children: [
        { id: "wanted", type: "file", name: "wanted.tex", path: "parts\\.\\wanted.tex", content: "wanted\r\n" },
      ] },
    ] } });
    let snapshot;
    f.hooks.beforeMkdir = async (dir) => { if (dir.endsWith("texmf-var")) snapshot = await tree(path.dirname(path.dirname(dir))); };
    const res = await f.compile({ baseRevision: 0, data: sparse(f.out.data), mainPath: requested });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.mainPath, expected);
    assert.equal(out.sourceFileId, files(f.out.data)[expected === "first.tex" ? 0 : 1].id);
    assert.deepEqual(snapshot["first.tex"], Buffer.from(mainText));
    assert.deepEqual(snapshot["parts/wanted.tex"], Buffer.from("wanted\r\n"));
    const version = (await f.pool.query("SELECT content_hash FROM document_versions WHERE id = $1", [out.sourceRevisionId])).rows[0];
    assert.equal(out.sourceContentHash, hash(expected === "first.tex" ? mainText : "wanted\r\n"));
    assert.equal(version.content_hash, out.sourceContentHash);
    await assertClean(f);
  });
});

test("review regression: mixed source types cannot displace the effective project's main", options, async (t) => {
  for (const [projectType, ext, marker, otherExt, otherMarker] of [
    ["latex", "tex", "\\documentclass{article}", "ly", "\\score { c' }"],
    ["lilypond", "ly", "\\score { c' }", "tex", "\\documentclass{article}"],
  ]) await t.test(projectType, async (t) => {
    const f = await setup(t, { projectType, project: { nodes: [
      { id: "other", type: "file", name: `other.${otherExt}`, path: `other.${otherExt}`, content: otherMarker },
      { id: "fragment", type: "file", name: `fragment.${ext}`, path: `fragment.${ext}`, content: "fragment" },
      { type: "folder", name: "parts", children: [
        { id: "main", type: "file", name: `main.${ext}`, path: `parts/main.${ext}`, content: marker + "\r\n" },
      ] },
      { id: "later", type: "file", name: `later.${ext}`, path: `later.${ext}`, content: marker },
    ] } });
    let snapshot;
    f.hooks.beforeMkdir = async (dir) => { if (dir.endsWith("texmf-var")) snapshot = await tree(path.dirname(path.dirname(dir))); };
    const res = await f.compile({ baseRevision: 0, data: sparse(f.out.data) });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.mainPath, `parts/main.${ext}`);
    assert.equal(out.sourceFileId, files(f.out.data)[2].id);
    for (const node of files(f.out.data)) assert.deepEqual(snapshot[node.path], Buffer.from(node.content), node.path);
    const version = (await f.pool.query("SELECT content_hash FROM document_versions WHERE id = $1", [out.sourceRevisionId])).rows[0];
    assert.equal(out.sourceContentHash, hash(marker + "\r\n"));
    assert.equal(version.content_hash, out.sourceContentHash);
    await assertClean(f);
  });
});

test("review regression: strict compile versions require lossless UTF-8 while preserving raw bytes and general history", options, async (t) => {
  for (const [label, suffix, versionable] of [
    ["Latin-1", [0xe9], false],
    ["truncated UTF-8", [0xe2, 0x82], false],
    ["valid UTF-8", [0xc3, 0xa9], true],
    ["valid replacement character", [0xef, 0xbf, 0xbd], true],
  ]) await t.test(label, async (t) => {
    const f = await setup(t);
    const raw = Buffer.concat([Buffer.from(mainText + "% "), Buffer.from(suffix), Buffer.from("\r\n")]);
    const sourceIds = [files(f.out.data)[0].id, files(f.out.data)[2].id];
    for (const rel of ["main.tex", "parts/notes.txt"]) await fs.writeFile(path.join(f.dir, rel), raw);
    // Ordinary history keeps its existing text policy; strict compile must not
    // link a previously recorded lossy version to a byte-exact build snapshot.
    assert.equal((await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).status, 200);
    const previous = (await f.pool.query("SELECT id, file_id, content, content_hash FROM document_versions WHERE file_id = ANY($1::uuid[]) ORDER BY file_id", [sourceIds])).rows;
    assert.equal(previous.length, 2);
    for (const version of previous) assert.equal(version.content, raw.toString("utf8"));
    let snapshot;
    f.hooks.beforeMkdir = async (dir) => { if (dir.endsWith("texmf-var")) snapshot = await tree(path.dirname(path.dirname(dir))); };
    const res = await f.compile({ baseRevision: 0, data: sparse(f.out.data) });
    assert.equal(res.status, 200);
    const out = await res.json();
    for (const rel of ["main.tex", "parts/notes.txt"]) {
      assert.deepEqual(snapshot[rel], raw, `staging ${rel}`);
      assert.deepEqual(await fs.readFile(path.join(f.dir, rel)), raw, `live ${rel}`);
    }
    assert.equal(out.sourceContentHash, hash(raw));
    assert.equal(out.sourceRevisionId, versionable ? previous.find((version) => version.file_id === sourceIds[0]).id : null);
    const build = (await f.pool.query("SELECT b.source_content_hash, b.source_revision_id, v.content_hash AS version_hash FROM build_outputs b LEFT JOIN document_versions v ON v.id = b.source_revision_id WHERE b.id = $1", [out.buildId])).rows[0];
    assert.equal(build.source_content_hash, hash(raw));
    assert.equal(build.source_revision_id, out.sourceRevisionId);
    assert.equal(build.version_hash, versionable ? hash(raw) : null);
    assert.deepEqual((await f.pool.query("SELECT id, file_id, content, content_hash FROM document_versions WHERE file_id = ANY($1::uuid[]) ORDER BY file_id", [sourceIds])).rows, previous);
    await assertClean(f);
  });
});
