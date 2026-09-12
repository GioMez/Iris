const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { uuidv7, isUuid } = require("../src/ids");
const { createZip, extractZip } = require("../src/zip");
const { connectionString, serverFixture } = require("./helpers/server-fixture.cjs");
const options = { skip: !connectionString, timeout: 20000 };
const rootBytes = Buffer.from('\uFEFF{"project":{"name":"Ordinary source","nodes":[]},"revision":99}\r\n');
const binaryBytes = Buffer.from([0, 255, 128, 13, 10]);
const fontBytes = Buffer.from([0, 1, 0, 0, 255]);

function files(data) {
  const walk = (nodes) => nodes.flatMap((node) => node.generated || node.readOnly ? [] : node.type === "folder" ? walk(node.children) : [node]);
  return walk(data.project.nodes);
}

function idsByPath(data) {
  return Object.fromEntries(files(data).map((node) => [node.path, node.id]));
}

function sparse(data) {
  const copy = structuredClone(data);
  for (const node of files(copy)) { delete node.content; delete node.data; }
  for (const font of copy.fonts || []) delete font.data;
  copy.assets = {};
  return copy;
}

async function setup(t) {
  const f = await serverFixture(t);
  const user = (await f.pool.query(
    "INSERT INTO users (id, username, email, display_name) VALUES ($1, 'importer', 'importer@example.test', 'Importer') RETURNING *", [uuidv7()]
  )).rows[0];
  const cookie = f.cookieFor(user);
  const request = (url, opts = {}) => f.request(url, { cookie, ...opts });
  const importArchive = (bytes) => fetch(f.baseUrl + "/api/projects/import?filename=identity.zip", {
    method: "POST", headers: { cookie, "content-type": "application/zip" }, body: bytes, signal: AbortSignal.timeout(15000),
  });
  const dir = (id) => path.join(f.dataDir, "projects", id);
  return { ...f, user, request, importArchive, dir };
}

async function jsonResponse(response, status) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

async function treeBytes(dir, base = "") {
  const entries = {};
  for (const entry of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { entries[rel + "/"] = null; Object.assign(entries, await treeBytes(dir, rel)); }
    else entries[rel] = (await fs.readFile(path.join(dir, rel))).toString("base64");
  }
  return entries;
}

async function databaseState(f, id) {
  return {
    projects: (await f.pool.query("SELECT * FROM projects WHERE id = $1", [id])).rows,
    members: (await f.pool.query("SELECT * FROM project_members WHERE project_id = $1 ORDER BY user_id", [id])).rows,
    files: (await f.pool.query("SELECT * FROM project_files WHERE project_id = $1 ORDER BY id", [id])).rows,
    versions: (await f.pool.query("SELECT v.* FROM document_versions v JOIN project_files f ON f.id = v.file_id WHERE f.project_id = $1 ORDER BY v.id", [id])).rows,
    builds: (await f.pool.query("SELECT * FROM build_outputs WHERE project_id = $1 ORDER BY id", [id])).rows,
  };
}

async function assertViews(f, out, expectedIds, activeId, openTabs) {
  const id = out.project.id;
  assert.equal(out.data.id, id);
  const manifest = JSON.parse(await fs.readFile(path.join(f.dir(id), ".iris/project.json"), "utf8"));
  const loaded = await jsonResponse(await f.request(`/api/projects/${id}`), 200);
  assert.equal(loaded.id, id);
  assert.ok(manifest.id === undefined || manifest.id === id);
  for (const data of [out.data, manifest, loaded]) {
    assert.deepEqual(idsByPath(data), expectedIds);
    assert.equal(data.activeId, activeId);
    assert.deepEqual(data.openTabs, openTabs);
    assert.equal(data.revision, 0);
  }
  const rows = (await f.pool.query("SELECT id, path, client_ref, deleted_at FROM project_files WHERE project_id = $1", [id])).rows;
  assert.equal(rows.length, Object.keys(expectedIds).length);
  for (const row of rows) {
    assert.equal(row.id, expectedIds[row.path]);
    assert.equal(row.client_ref, row.id, "the ledger must adopt the once-remapped ID");
    assert.equal(row.deleted_at, null);
    assert.ok(isUuid(row.id));
    assert.equal(row.id[14], "7");
  }
  return loaded;
}

test("unchanged current export imports repeatedly and concurrently beside its live original with separate stable identities and history", options, async (t) => {
  const f = await setup(t);
  const mainId = uuidv7(), nestedId = uuidv7(), binaryId = uuidv7(), fontId = uuidv7(), rootId = uuidv7();
  const data = {
    projectType: "latex", engine: "xelatex", mainPath: "chapters/intro.tex",
    compileProfile: { mode: "custom", steps: [{ tool: "[engine]", args: ["[main]"] }] },
    customCommands: { tex: ["\\myMacro"], ly: ["\\my-music"] }, settings: { tabSize: 4, spellcheck: false },
    fonts: [{ path: "fonts/Custom.otf", family: "ChosenFamily", enabled: false }],
    activeId: nestedId, openTabs: [nestedId, binaryId, mainId, nestedId, "stale"],
    project: { nodes: [
      { type: "file", id: mainId, name: "main.tex", path: "main.tex", content: "\\documentclass{article}\r\n" },
      { type: "folder", id: "chapter-folder", name: "chapters", open: true, children: [
        { type: "file", id: nestedId, name: "intro.tex", path: "chapters/intro.tex", content: "Nested source\r\n" },
        { type: "file", id: binaryId, name: "bytes.bin", path: "chapters/bytes.bin", binary: true, data: `data:application/octet-stream;base64,${binaryBytes.toString("base64")}` },
      ] },
      { type: "folder", name: "fonts", children: [
        { type: "file", id: fontId, name: "Custom.otf", path: "fonts/Custom.otf", binary: true, data: `data:font/otf;base64,${fontBytes.toString("base64")}` },
      ] },
      { type: "file", id: rootId, name: "project.json", path: "project.json", content: rootBytes.toString("utf8") },
    ] },
  };
  const original = await jsonResponse(await f.request("/api/projects", { method: "POST", body: { name: "Identity original", data } }), 201);
  const originalId = original.project.id;
  const originalUrl = `/api/projects/${originalId}`;
  // A normal save persists the GET/response project identity in the exported manifest.
  await jsonResponse(await f.request(originalUrl, { method: "PUT", body: { baseRevision: 0, data: original.data } }), 200);
  await jsonResponse(await f.request(originalUrl + "/checkpoint", { method: "POST", body: {} }), 200);
  const version = (await f.pool.query("SELECT id, content_hash FROM document_versions WHERE file_id = $1", [nestedId])).rows[0];
  await f.pool.query(
    `INSERT INTO build_outputs (id, project_id, source_file_id, source_revision_id, source_content_hash, created_by, created_by_label,
       status, completed_at, project_type, compiler, format, main_path, display_name)
     VALUES ($1, $2, $3, $4, $5, $6, 'Importer', 'failed', CURRENT_TIMESTAMP, 'latex', 'xelatex', 'pdf', 'chapters/intro.tex', 'intro.pdf')`,
    [uuidv7(), originalId, nestedId, version.id, version.content_hash, f.user.id]
  );
  const beforeDb = await databaseState(f, originalId);
  const beforeFiles = await treeBytes(f.dir(originalId));
  assert.ok(beforeDb.versions.length > 0);
  assert.equal(beforeDb.builds.length, 1);
  const exported = await f.request(originalUrl + "/archive");
  assert.equal(exported.status, 200);
  const archiveBytes = Buffer.from(await exported.arrayBuffer());
  const archive = extractZip(archiveBytes);
  const archived = JSON.parse(archive.files.get(".iris/project.json"));
  assert.equal(archived.id, originalId);
  assert.equal(archived.revision, 1);
  assert.deepEqual(idsByPath(archived), idsByPath(original.data));
  assert.deepEqual(archive.files.get("project.json"), rootBytes);

  const first = await jsonResponse(await f.importArchive(archiveBytes), 201);
  const concurrent = await Promise.all([f.importArchive(archiveBytes), f.importArchive(archiveBytes)]);
  const copies = [first, ...await Promise.all(concurrent.map((response) => jsonResponse(response, 201)))];
  const used = new Set([originalId, mainId, nestedId, binaryId, fontId, rootId]);
  for (const out of copies) {
    const copyId = out.project.id;
    assert.ok(!used.has(copyId)); used.add(copyId);
    const ids = idsByPath(out.data);
    assert.deepEqual(Object.keys(ids).sort(), Object.keys(idsByPath(original.data)).sort());
    for (const id of Object.values(ids)) { assert.ok(!used.has(id), "copies must have disjoint file identities"); used.add(id); }
    const tabs = [ids["chapters/intro.tex"], ids["chapters/bytes.bin"], ids["main.tex"]];
    const loaded = await assertViews(f, out, ids, ids["chapters/intro.tex"], tabs);
    assert.equal(out.data.createdAt, out.project.createdAt);
    assert.equal(out.data.updatedAt, out.project.updatedAt);
    assert.ok(out.data.createdAt >= archived.createdAt);
    for (const key of ["engine", "mainPath", "compileProfile", "customCommands", "settings"]) assert.deepEqual(loaded[key], data[key]);
    assert.equal(loaded.project.nodes[1].id, "chapter-folder");
    assert.equal(loaded.project.nodes[1].open, true);
    assert.equal(loaded.fonts[0].path, "fonts/Custom.otf");
    assert.equal(loaded.fonts[0].family, "ChosenFamily");
    assert.equal(loaded.fonts[0].enabled, false);
    assert.equal(loaded.fonts[0].data, `data:font/otf;base64,${fontBytes.toString("base64")}`);
    assert.equal(loaded.assets["chapters/bytes.bin"], `data:application/octet-stream;base64,${binaryBytes.toString("base64")}`);
    for (const [name, bytes] of archive.files) {
      if (name !== ".iris/project.json") assert.deepEqual(await fs.readFile(path.join(f.dir(copyId), name)), bytes);
    }
    const state = await databaseState(f, copyId);
    assert.deepEqual(state.versions, []);
    assert.deepEqual(state.builds, []);
    assert.equal(state.members.length, 1);
    assert.equal(state.members[0].role, "owner");
    const url = `/api/projects/${copyId}`;
    const foreign = await f.request(`${url}/files/${nestedId}/versions`);
    await jsonResponse(foreign, 404);
    const versionUrl = `${url}/files/${ids["chapters/intro.tex"]}/versions`;
    assert.deepEqual((await jsonResponse(await f.request(versionUrl), 200)).versions, []);
    const next = sparse(loaded);
    files(next).find((node) => node.path === "chapters/intro.tex").content = `Copy ${copyId}\r\n`;
    const saved = await jsonResponse(await f.request(url, { method: "PUT", body: { baseRevision: 0, data: next } }), 200);
    assert.deepEqual(idsByPath(saved.data), ids);
    const reloaded = await jsonResponse(await f.request(url), 200);
    assert.deepEqual(idsByPath(reloaded), ids);
    assert.equal(reloaded.activeId, ids["chapters/intro.tex"]);
    assert.deepEqual(reloaded.openTabs, tabs);
    assert.equal(reloaded.revision, 1);
    for (const [name, bytes] of archive.files) {
      if (![".iris/project.json", "chapters/intro.tex"].includes(name)) assert.deepEqual(await fs.readFile(path.join(f.dir(copyId), name)), bytes);
    }
    const afterSave = await databaseState(f, copyId);
    assert.deepEqual(afterSave.files, state.files, "sparse save must not churn ledger identities or timestamps");
    await jsonResponse(await f.request(url + "/checkpoint", { method: "POST", body: {} }), 200);
    const history = (await jsonResponse(await f.request(versionUrl), 200)).versions;
    assert.equal(history.length, 1);
    assert.equal(history[0].parentId, null);
    assert.notEqual(history[0].id, version.id);
    const ownVersion = await jsonResponse(await f.request(versionUrl + "/" + history[0].id), 200);
    assert.equal(ownVersion.content, `Copy ${copyId}\r\n`);
    await jsonResponse(await f.request(versionUrl + "/" + version.id), 404);
  }
  assert.deepEqual(await databaseState(f, originalId), beforeDb);
  assert.deepEqual(await treeBytes(f.dir(originalId)), beforeFiles);
});

test("import failure after its first file INSERT rolls back SQL and storage without changing the live original", options, async (t) => {
  const f = await setup(t);
  const original = await jsonResponse(await f.request("/api/projects", { method: "POST", body: {
    name: "Rollback original", data: { project: { nodes: [
      { type: "file", id: "main", name: "main.tex", path: "main.tex", content: "Original source\r\n" },
      { type: "file", id: "root", name: "project.json", path: "project.json", content: rootBytes.toString("utf8") },
      { type: "file", id: "bytes", name: "bytes.bin", path: "bytes.bin", binary: true, data: `data:application/octet-stream;base64,${binaryBytes.toString("base64")}` },
    ] } },
  } }), 201);
  const originalId = original.project.id;
  const originalUrl = `/api/projects/${originalId}`;
  await jsonResponse(await f.request(originalUrl + "/checkpoint", { method: "POST", body: {} }), 200);
  const beforeDb = await databaseState(f, originalId);
  const beforeFiles = await treeBytes(f.dir(originalId));
  assert.equal(beforeDb.files.length, 3);
  assert.ok(beforeDb.versions.length > 0, "the original must have history to protect");
  const exported = await f.request(originalUrl + "/archive");
  assert.equal(exported.status, 200);
  const archiveBytes = Buffer.from(await exported.arrayBuffer());
  const archive = extractZip(archiveBytes);
  assert.deepEqual(idsByPath(JSON.parse(archive.files.get(".iris/project.json"))), idsByPath(original.data));

  const inserted = [];
  let partial;
  f.hooks.afterClientQuery = async (sql, params, result) => {
    if (/^INSERT INTO projects /.test(sql)) inserted.push({ table: "projects", projectId: params[0], rows: result.rowCount });
    if (/^INSERT INTO project_members /.test(sql)) inserted.push({ table: "project_members", projectId: params[0], rows: result.rowCount });
    if (!/^INSERT INTO project_files /.test(sql)) return;
    const importedId = params[1];
    inserted.push({ table: "project_files", projectId: importedId, rows: result.rowCount });
    partial = {
      id: importedId, fileId: params[0], files: await treeBytes(f.dir(importedId)),
      backupExists: (await fs.stat(path.join(f.dataDir, ".project-backups", importedId))).isDirectory(),
    };
    throw new Error("injected import failure after first file INSERT");
  };
  let failed;
  try { failed = await jsonResponse(await f.importArchive(archiveBytes), 500); }
  finally { delete f.hooks.afterClientQuery; }
  assert.equal(failed.errorCode, "SERVER_ERROR");
  assert.ok(partial, "the import must reach a successful file INSERT before the injected failure");
  assert.ok(isUuid(partial.id));
  assert.notEqual(partial.id, originalId);
  assert.ok(!beforeDb.files.some((file) => file.id === partial.fileId));
  assert.deepEqual(inserted, ["projects", "project_members", "project_files"].map((table) => ({ table, projectId: partial.id, rows: 1 })));
  assert.equal(partial.backupExists, true);
  assert.ok(partial.files[".iris/project.json"]);
  for (const [name, bytes] of archive.files) {
    if (name !== ".iris/project.json") assert.equal(partial.files[name], bytes.toString("base64"));
  }

  assert.deepEqual(await databaseState(f, partial.id), { projects: [], members: [], files: [], versions: [], builds: [] });
  assert.deepEqual((await f.pool.query("SELECT id FROM project_files WHERE id = $1", [partial.fileId])).rows, []);
  await assert.rejects(fs.stat(f.dir(partial.id)), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.dataDir, ".project-backups", partial.id)), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "projects")), [originalId]);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".project-backups")), []);
  assert.deepEqual(await databaseState(f, originalId), beforeDb);
  assert.deepEqual(await treeBytes(f.dir(originalId)), beforeFiles);
});

function currentArchive(data, entries) {
  return createZip([
    { name: ".iris/project.json", data: JSON.stringify({ ...data, irisArchive: { format: "iris-project", version: 1 } }) },
    ...entries.map(([name, bytes]) => ({ name, data: bytes })),
  ]);
}

test("import remaps temporary, missing and discovered text/binary/font IDs after filesystem discovery", options, async (t) => {
  const f = await setup(t);
  const staleId = uuidv7();
  const data = {
    id: uuidv7(), revision: 97, createdAt: 1, updatedAt: 2,
    activeId: "file_current", openTabs: ["file_current", staleId, "file_current", "absent"],
    mainPath: "nested/main.tex", customCommands: { tex: ["\\current"], ly: [] }, settings: { tabSize: 2 },
    fonts: [{ path: "fonts/Discovered.otf", family: "DiscoveredFamily", enabled: false }],
    project: { name: "Discovery", nodes: [
      { type: "folder", name: "nested", children: [
        { type: "file", id: "file_current", name: "main.tex", path: "nested/main.tex" },
        { type: "file", name: "missing-id.txt", path: "nested/missing-id.txt" },
        { type: "file", id: null, name: "null-id.txt", path: "nested/null-id.txt" },
        { type: "file", id: staleId, name: "gone.tex", path: "nested/gone.tex" },
      ] },
    ] },
  };
  const entries = [
    ["nested/main.tex", "current\r\n"], ["nested/missing-id.txt", "missing ID"], ["nested/null-id.txt", "null ID"],
    ["nested/discovered.txt", "discovered\r\n"], ["nested/discovered.bin", binaryBytes],
    ["fonts/Discovered.otf", fontBytes], ["project.json", rootBytes], ["output/preview.pdf", binaryBytes],
  ];
  const out = await jsonResponse(await f.importArchive(currentArchive(data, entries)), 201);
  assert.notEqual(out.project.id, data.id);
  const ids = idsByPath(out.data);
  assert.deepEqual(Object.keys(ids).sort(), entries.map(([name]) => name).filter((name) => !name.startsWith("output/")).sort());
  assert.equal(new Set(Object.values(ids)).size, 7);
  assert.ok(!Object.values(ids).includes(staleId));
  const loaded = await assertViews(f, out, ids, ids["nested/main.tex"], [ids["nested/main.tex"]]);
  assert.ok(out.data.createdAt > 2);
  assert.equal(out.data.updatedAt, out.data.createdAt);
  assert.equal(loaded.mainPath, "nested/main.tex");
  assert.deepEqual(loaded.customCommands, data.customCommands);
  assert.deepEqual(loaded.settings, data.settings);
  assert.equal(loaded.fonts[0].family, "DiscoveredFamily");
  assert.equal(loaded.fonts[0].enabled, false);
  assert.equal(files(loaded).find((node) => node.path === "nested/discovered.txt").content, "discovered\r\n");
  assert.equal(files(loaded).find((node) => node.path === "nested/discovered.bin").data, `data:application/octet-stream;base64,${binaryBytes.toString("base64")}`);
  for (const [name, bytes] of entries) assert.deepEqual(await fs.readFile(path.join(f.dir(out.project.id), name)), Buffer.from(bytes));
});

for (const duplicate of ["019f99bb-6923-7322-a37d-c8f46b5e5cc9", "file_current"]) {
  test(`HTTP import allocates per-node IDs and drops ambiguous navigation for ${duplicate}`, options, async (t) => {
    const f = await setup(t);
    const data = { activeId: duplicate, openTabs: [duplicate, "unique", "unique", "dangling"], project: { nodes: [
      { type: "file", id: duplicate, name: "one.tex", path: "one.tex" },
      { type: "folder", name: "nested", children: [
        { type: "file", id: duplicate, name: "two.tex", path: "nested/two.tex" },
        { type: "file", id: "unique", name: "three.tex", path: "nested/three.tex" },
      ] },
    ] } };
    const out = await jsonResponse(await f.importArchive(currentArchive(data, [["one.tex", "one"], ["nested/two.tex", "two"], ["nested/three.tex", "three"]])), 201);
    const ids = idsByPath(out.data);
    assert.equal(new Set(Object.values(ids)).size, 3);
    assert.ok(!Object.values(ids).includes(duplicate));
    await assertViews(f, out, ids, null, [ids["nested/three.tex"]]);
  });
}

for (const invalid of [0, 42, true, {}, []]) {
  test(`HTTP import rejects nonstring file ID ${JSON.stringify(invalid)} and rolls back storage and SQL`, options, async (t) => {
    const f = await setup(t);
    const data = { activeId: String(invalid), openTabs: [String(invalid)], project: { nodes: [
      { type: "file", id: invalid, name: "main.tex", path: "main.tex" },
    ] } };
    const out = await jsonResponse(await f.importArchive(currentArchive(data, [["main.tex", "invalid identity"]])), 400);
    assert.equal(out.errorCode, "PROJECT_ARCHIVE_INVALID");
    assert.deepEqual((await f.pool.query("SELECT id FROM projects")).rows, []);
    assert.deepEqual((await f.pool.query("SELECT id FROM project_files")).rows, []);
    assert.deepEqual((await f.pool.query("SELECT project_id FROM project_members")).rows, []);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, "projects")).catch((err) => { if (err.code === "ENOENT") return []; throw err; }), []);
  });
}
