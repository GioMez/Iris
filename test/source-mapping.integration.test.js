const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");
const options = { skip: !connectionString, timeout: 20000 };

async function setup(t, sourceMapping, env = {}) {
  const f = await serverFixture(t, { PATH: process.env.PATH, ...env });
  const users = {};
  for (const name of ["owner", "viewer", "editor", "outsider"]) users[name] = (await f.pool.query("INSERT INTO users (id, username, email, display_name) VALUES ($1,$2,$3,$2) RETURNING *", [uuidv7(), name, `${name}@example.test`])).rows[0];
  const request = (url, opts = {}) => f.request(url, { cookie: f.cookieFor(users.owner), ...opts });
  const create = await request("/api/projects", { method: "POST", body: { name: "Navigation", data: { ...(sourceMapping === undefined ? {} : { sourceMapping }), project: { nodes: [
    { type: "file", id: "main", name: "main.ly", path: "main.ly", content: "\\include \"part.ly\"\n\\score { \\theme }", kind: "ly" },
    { type: "file", id: "part", name: "part.ly", path: "part.ly", content: "theme = { c'4 d'4 }\n", kind: "ly" },
  ] } } } });
  assert.equal(create.status, 201);
  const out = await create.json(), id = out.project.id, url = `/api/projects/${id}`;
  for (const role of ["viewer", "editor"]) await f.pool.query("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)", [id, users[role].id, role]);
  const bin = path.join(f.dataDir, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "lilypond"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync('output/main.pdf','%PDF-fixture');
fs.writeFileSync('output/args.json',JSON.stringify(args));
if(args.some(a=>a.startsWith('-dinclude-settings='))) fs.writeFileSync('output/main.iris-map.tsv','IRIS-LILYPOND\\t1\\nP\\t1\\t595.276\\t841.89\\nG\\t1\\tpart.ly\\t1\\t10\\t10\\t100\\t200\\t10\\t8\\n');
`, { mode: 0o755 });
  const compile = async (body = {}) => {
    const res = await request(url + "/compile", { method: "POST", body: { lilypondPath: bin, ...body } });
    assert.equal(res.status, 200);
    const build = await res.json();
    assert.equal(build.success, true, JSON.stringify(build));
    return build;
  };
  return { ...f, users, request, out, id, url, bin, compile, dir: path.join(f.dataDir, "projects", id) };
}

test("sourceMapping defaults true and persists false across open, sparse save and compile", options, async (t) => {
  const f = await setup(t);
  assert.equal(f.out.data.sourceMapping, true);
  const save = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, sourceMapping: false } });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).data.sourceMapping, false);
  assert.equal((await (await f.request(f.url)).json()).sourceMapping, false);
  const sparse = structuredClone(f.out.data); delete sparse.sourceMapping;
  sparse.project.nodes.forEach((n) => delete n.content);
  const build = await f.compile({ baseRevision: 1, data: sparse });
  assert.equal(build.data.sourceMapping, false);
  const args = JSON.parse(await fs.readFile(path.join(f.dir, build.outputDir, "args.json"), "utf8"));
  assert.equal(args.some((a) => a.startsWith("-dinclude-settings=")), false);
  const response = await f.request(`${f.url}/builds/${build.buildId}/navigation`, { method: "POST", body: { direction: "forward", sourceFileId: f.out.data.project.nodes[1].id, line: 1, column: 0 } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "disabled", matches: [] });
  for (const value of [null, "false", 0]) {
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 2, sourceMapping: value } })).status, 400);
    assert.equal((await f.request(f.url + "/compile", { method: "POST", body: { sourceMapping: value } })).status, 400);
  }
});

test("sourceMapping imports false, defaults legacy manifests, and validates all creation/save forms", options, async (t) => {
  const f = await setup(t, false);
  const { createZip } = require("../src/zip");
  for (const value of [false, undefined, null, "true"]) {
    const data = { ...f.out.data, irisArchive: { format: "iris-project", version: 1 } };
    if (value === undefined) delete data.sourceMapping; else data.sourceMapping = value;
    const zip = createZip([{ name: ".iris/project.json", data: JSON.stringify(data) }, ...data.project.nodes.map((n) => ({ name: n.path, data: n.content }))]);
    const res = await fetch(f.baseUrl + "/api/projects/import", { method: "POST", headers: { cookie: f.cookieFor(f.users.owner), "content-type": "application/zip" }, body: zip });
    assert.equal(res.status, value === null || value === "true" ? 400 : 201);
    if (res.status === 201) assert.equal((await res.json()).data.sourceMapping, value !== false);
  }
  const meta = path.join(f.dir, ".iris", "project.json");
  const legacy = JSON.parse(await fs.readFile(meta, "utf8")); delete legacy.sourceMapping;
  await fs.writeFile(meta, JSON.stringify(legacy));
  assert.equal((await (await f.request(f.url)).json()).sourceMapping, true);
  for (const value of [null, "true", 1]) {
    assert.equal((await f.request("/api/projects", { method: "POST", body: { name: "Invalid", data: { sourceMapping: value } } })).status, 400);
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: { ...f.out.data, sourceMapping: value } } })).status, 400);
  }
  assert.equal((await f.request(f.url, { method: "PUT", cookie: f.cookieFor(f.users.viewer), body: { baseRevision: 0, sourceMapping: false } })).status, 403);
  assert.equal((await f.request(f.url, { method: "PUT", cookie: f.cookieFor(f.users.editor), body: { baseRevision: 0, sourceMapping: false } })).status, 200);
});

test("renames retain source identity/hash; deleted files/builds and cross-project IDs cannot navigate", options, async (t) => {
  const f = await setup(t);
  const build = await f.compile();
  const route = `${f.url}/builds/${build.buildId}/navigation`;
  const partId = build.data.project.nodes[1].id;
  const query = { direction: "forward", sourceFileId: partId, line: 1, column: 10 };
  const navigate = async () => (await f.request(route, { method: "POST", body: query })).json();
  const before = await navigate();
  const data = structuredClone(build.data);
  data.project.nodes[1].name = data.project.nodes[1].path = "renamed.ly";
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 1, data } })).status, 200);
  assert.deepEqual(await navigate(), before);
  data.project.nodes[1].content = "changed text";
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 2, data } })).status, 200);
  assert.equal((await navigate()).matches[0].sourceHash, before.matches[0].sourceHash);
  const other = await f.request("/api/projects", { method: "POST", body: { name: "Other", data: { project: { nodes: [{ type: "file", name: "other.ly", content: "{ c' }" }] } } } });
  const otherData = await other.json();
  assert.equal((await f.request(`/api/projects/${otherData.project.id}/builds/${build.buildId}/navigation`, { method: "POST", body: query })).status, 404);
  assert.equal((await f.request(route, { method: "POST", body: { ...query, sourceFileId: otherData.data.project.nodes[0].id } })).status, 404);
  data.project.nodes.pop();
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 3, data } })).status, 200);
  assert.equal((await navigate()).status, "missing");
  const inverse = await f.request(route, { method: "POST", body: { direction: "inverse", artifactId: build.artifacts[0].id, page: 1, x: 105, y: 204 } });
  assert.equal((await inverse.json()).status, "missing");
  assert.equal((await f.request(`${f.url}/builds/${build.buildId}`, { method: "DELETE" })).status, 200);
  assert.equal((await f.request(route, { method: "POST", body: query })).status, 404);
  await assert.rejects(fs.stat(path.join(f.dir, build.outputDir)), { code: "ENOENT" });
});

test("mapping is published with its compile-time setting while a concurrent save controls current navigation", options, async (t) => {
  const f = await setup(t);
  const entered = deferred(), release = deferred();
  f.hooks.beforeMkdir = async (dir) => { if (dir.endsWith("texmf-var")) { entered.resolve(); await release.promise; } };
  const pending = f.compile();
  try {
    await entered.promise;
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 1, sourceMapping: false } })).status, 200);
    release.resolve();
    const build = await pending;
    assert.equal(build.data.sourceMapping, true);
    const file = path.join(f.dir, build.outputDir, ".iris-navigation.json");
    const original = await fs.readFile(file);
    assert.equal(JSON.parse(original).status, "ready");
    const query = { direction: "forward", sourceFileId: build.data.project.nodes[1].id, line: 1, column: 0 };
    const route = `${f.url}/builds/${build.buildId}/navigation`;
    assert.equal((await (await f.request(route, { method: "POST", body: query })).json()).status, "disabled");
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 2, sourceMapping: true } })).status, 200);
    assert.equal((await (await f.request(route, { method: "POST", body: query })).json()).status, "ready");
    assert.deepEqual(await fs.readFile(file), original);
    const staging = path.join(f.dataDir, ".build-staging", f.id, build.buildId);
    for (let i = 0; i < 100 && await fs.stat(staging).catch(() => null); i++) await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(fs.stat(staging), { code: "ENOENT" });
  } finally { release.resolve(); await pending; }
});

test("accessory map corruption and absent support preserve successful PDFs; current off skips malformed sidecars", options, async (t) => {
  const f = await setup(t);
  const build = await f.compile();
  const file = path.join(f.dir, build.outputDir, ".iris-navigation.json");
  const manifest = await fs.readFile(file);
  const query = { direction: "forward", sourceFileId: build.data.project.nodes[1].id, line: 1, column: 0 };
  const route = `${f.url}/builds/${build.buildId}/navigation`;
  const navigate = async () => (await (await f.request(route, { method: "POST", body: query })).json());
  for (const content of ["{", JSON.stringify({ ...JSON.parse(manifest), buildId: uuidv7() }), JSON.stringify({ ...JSON.parse(manifest), entries: [{ ...JSON.parse(manifest).entries[0], sourceFileId: uuidv7() }] })]) {
    await fs.writeFile(file, content);
    assert.equal((await navigate()).status, "unavailable");
    assert.equal((await f.request(`${f.url}/builds/${build.buildId}/artifacts/${build.artifacts[0].id}`)).status, 200);
  }
  await fs.unlink(file);
  assert.equal((await navigate()).status, "missing");
  await fs.symlink(path.join(f.dataDir, "not-readable"), file);
  assert.equal((await navigate()).status, "missing");
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 1, sourceMapping: false } })).status, 200);
  assert.equal((await navigate()).status, "disabled");
  await fs.unlink(file);
  await fs.writeFile(file, manifest);
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 2, sourceMapping: true } })).status, 200);
  await fs.writeFile(path.join(f.dir, build.outputDir, "main.pdf"), "%PDF-tampered");
  assert.equal((await navigate()).reason, "stale-artifact");
  const rows = (await f.pool.query("SELECT status FROM build_outputs WHERE id = $1", [build.buildId])).rows;
  assert.equal(rows[0].status, "succeeded");
});

test("collector parse failure does not fail publication and missing native support stays unsupported", options, async (t) => {
  const f = await setup(t);
  for (const raw of ["bad map", null]) {
    await fs.writeFile(path.join(f.bin, "lilypond"), `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync('output/main.pdf','%PDF-good'); ${raw === null ? "" : `fs.writeFileSync('output/main.iris-map.tsv',${JSON.stringify(raw)});`}`, { mode: 0o755 });
    const build = await f.compile();
    const res = await f.request(`${f.url}/builds/${build.buildId}/navigation`, { method: "POST", body: { direction: "forward", sourceFileId: build.data.project.nodes[1].id, line: 1, column: 0 } });
    assert.equal((await res.json()).status, raw === null ? "unsupported" : "unavailable");
    assert.equal((await f.request(`${f.url}/builds/${build.buildId}/artifacts/${build.artifacts[0].id}`)).status, 200);
  }
});

test("authenticated navigation connects compiled included-file/revision/artifact UUIDs for viewers and editors", options, async (t) => {
  const f = await setup(t);
  const build = await f.compile();
  const partId = f.out.data.project.nodes[1].id;
  const route = `${f.url}/builds/${build.buildId}/navigation`;
  const body = { direction: "forward", sourceFileId: partId, line: 1, column: 0 };
  for (const role of ["owner", "viewer", "editor"]) {
    const response = await f.request(route, { method: "POST", body, cookie: f.cookieFor(f.users[role]) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, "ready");
    assert.equal(result.matches[0].sourceFileId, partId);
    assert.equal(result.matches[0].artifactId, build.artifacts[0].id);
    const row = (await f.pool.query("SELECT file_id FROM document_versions WHERE id = $1", [result.matches[0].sourceRevisionId])).rows[0];
    assert.equal(row.file_id, partId);
    assert.equal(JSON.stringify(result).includes(f.dataDir), false);
  }
  assert.equal((await f.request(route, { method: "POST", body, cookie: f.cookieFor(f.users.outsider) })).status, 404);
  assert.equal((await f.request(route, { method: "POST", body, cookie: "" })).status, 401);
  assert.equal((await f.request(route, { method: "POST", body: { ...body, sourceFileId: "../../file" } })).status, 400);
  assert.equal((await f.request(route, { method: "POST", body: { ...body, artifactId: uuidv7() } })).status, 404);
  const wrong = await f.request(`/api/projects/${uuidv7()}/builds/${build.buildId}/navigation`, { method: "POST", body });
  assert.equal(wrong.status, 404);
});

async function texFixture(t) {
  const f = await setup(t);
  const data = structuredClone(f.out.data);
  data.projectType = "latex";
  data.project.nodes.forEach((n, i) => { n.kind = "tex"; n.name = n.path = i ? "part.tex" : "main.tex"; n.content = i ? "Retained part.\n" : "\\documentclass{article}\n\\begin{document}\\input{part}\\end{document}"; });
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } })).status, 200);
  await fs.writeFile(path.join(f.bin, "pdflatex"), `#!${process.execPath}
const fs=require('node:fs'); fs.writeFileSync('output/main.pdf','%PDF-good');
fs.writeFileSync('output/main.synctex','SyncTeX Version:1\\nInput:1:./main.tex\\nInput:2:./part.tex\\nContent:\\n');
`, { mode: 0o755 });
  const res = await f.request(f.url + "/compile", { method: "POST", body: { texPath: f.bin } });
  assert.equal(res.status, 200);
  const build = await res.json(); assert.equal(build.success, true);
  const query = { direction: "forward", sourceFileId: build.data.project.nodes[1].id, line: 1, column: 0 };
  const route = `${f.url}/builds/${build.buildId}/navigation`;
  return { ...f, build, query, route };
}

for (const mutation of ["revoke", "logout", "delete-build", "delete-file", "disable"]) test(`navigation rechecks ${mutation} after an awaited native query`, options, async (t) => {
  const f = await texFixture(t);
  const started = deferred(), release = path.join(f.dataDir, "release-query");
  f.hooks.spawn = (command) => {
    if (path.basename(command) !== "synctex") return;
    return { command: process.execPath, args: ["-e", `const fs=require('node:fs'); console.log('started'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('SyncTeX result begin\\nOutput:main.pdf\\nPage:1\\nh:10\\nv:24\\nW:3\\nH:4\\nSyncTeX result end');}},5);`] };
  };
  f.hooks.afterSpawn = (child, command) => { if (path.basename(command) === "synctex") child.stdout.once("data", () => started.resolve()); };
  const pending = f.request(f.route, { method: "POST", body: f.query });
  try {
    await started.promise;
    if (mutation === "revoke") await f.pool.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [f.id, f.users.owner.id]);
    if (mutation === "logout") await f.pool.query("UPDATE users SET session_version=session_version+1 WHERE id=$1", [f.users.owner.id]);
    if (mutation === "delete-build") assert.equal((await f.request(`${f.url}/builds/${f.build.buildId}`, { method: "DELETE" })).status, 200);
    if (mutation === "delete-file") {
      const data = structuredClone(f.build.data); data.project.nodes.pop();
      assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 2, data } })).status, 200);
    }
    if (mutation === "disable") assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 2, sourceMapping: false } })).status, 200);
    await fs.writeFile(release, "go");
    const res = await pending;
    assert.equal(res.status, mutation === "logout" ? 401 : ["revoke", "delete-build"].includes(mutation) ? 404 : 200);
    if (res.status === 200) assert.equal((await res.json()).status, mutation === "disable" ? "disabled" : "missing");
  } finally { await fs.writeFile(release, "go"); await pending; }
});

test("HTTP navigation reports missing native executable, output-limit, timeout and rejects excess queries without queueing", options, async (t) => {
  const f = await texFixture(t);
  const navigate = async () => (await (await f.request(f.route, { method: "POST", body: f.query })).json());
  f.hooks.spawn = (command) => path.basename(command) === "synctex" ? { command: path.join(f.dataDir, "absent-synctex"), args: [] } : undefined;
  assert.equal((await navigate()).reason, "engine-missing");
  f.hooks.spawn = (command) => path.basename(command) === "synctex" ? { command: process.execPath, args: ["-e", "process.stderr.write('x'.repeat(1048577))"] } : undefined;
  assert.equal((await navigate()).reason, "output-limit");
  const started = deferred(); let count = 0;
  f.hooks.spawn = (command) => path.basename(command) === "synctex" ? { command: process.execPath, args: ["-e", "console.log('started');setInterval(()=>{},1000)"] } : undefined;
  f.hooks.afterSpawn = (child, command) => { if (path.basename(command) === "synctex") child.stdout.once("data", () => { if (++count === 2) started.resolve(); }); };
  const first = navigate(), second = navigate();
  await started.promise;
  assert.equal((await navigate()).reason, "busy");
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.reason), ["timeout", "timeout"]);
  assert.equal(f.children.size, 0);
});

test("retention removes map sidecars with the build and preserves the retained build manifest", options, async (t) => {
  const f = await setup(t);
  const builds = [];
  for (let i = 0; i < 2; i++) builds.push(await f.compile());
  await f.pool.query("UPDATE build_outputs SET created_at=CURRENT_TIMESTAMP-INTERVAL '90 days' WHERE id=$1", [builds[0].buildId]);
  const retainedPath = path.join(f.dir, builds[1].outputDir, ".iris-navigation.json");
  const retained = await fs.readFile(retainedPath);
  const count = await f.app.pruneProjectBuilds(f.id, f.dir, { buildKeep: 1, buildDays: 30 }, new Date());
  assert.equal(count, 1);
  await assert.rejects(fs.stat(path.join(f.dir, builds[0].outputDir)), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(retainedPath), retained);
  assert.equal((await f.request(`${f.url}/builds/${builds[0].buildId}/navigation`, { method: "POST", body: { direction: "forward", sourceFileId: f.out.data.project.nodes[1].id, line: 1, column: 0 } })).status, 404);
});

test("non-PDF compilation retains sourceMapping and avoids loading the collector", options, async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.bin, "lilypond"), `#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv.some(a=>a.startsWith('-dinclude-settings='))) process.exit(3); fs.writeFileSync('output/main.svg','<svg/>');`, { mode: 0o755 });
  const build = await f.compile({ lilypondFormat: "svg" });
  assert.equal(build.data.sourceMapping, true);
  await assert.rejects(fs.stat(path.join(f.dir, build.outputDir, ".iris-navigation.json")), { code: "ENOENT" });
  const res = await f.request(`${f.url}/builds/${build.buildId}/navigation`, { method: "POST", body: { direction: "forward", sourceFileId: build.data.project.nodes[1].id, line: 1, column: 0 } });
  assert.deepEqual(await res.json(), { status: "unsupported", matches: [] });
});

test("private navigation manifests and native sidecars stay out of public file/archive APIs", options, async (t) => {
  const f = await texFixture(t);
  const details = await (await f.request(`${f.url}/builds/${f.build.buildId}`)).json();
  assert.equal(details.files.some((file) => file.name === ".iris-navigation.json" || file.name.includes(".synctex")), false);
  for (const name of [".iris-navigation.json", "main.synctex"]) {
    const res = await f.request(`${f.url}/builds/${f.build.buildId}/files/download?path=${encodeURIComponent(name)}`);
    assert.equal(res.status, 404);
  }
  const archive = await f.request(`${f.url}/builds/${f.build.buildId}/archive`);
  const { extractZip } = require("../src/zip");
  const names = [...extractZip(Buffer.from(await archive.arrayBuffer())).files.keys()];
  assert.equal(names.includes(".iris-navigation.json"), false);
  assert.equal(names.includes("main.synctex"), false);
  assert.equal(names.includes("main.pdf"), true);
});

test("binary payloads with UTF-8-compatible bytes are excluded and every Lily book output receives its own artifact", options, async (t) => {
  const f = await setup(t);
  const data = structuredClone(f.out.data);
  data.project.nodes.push({ type: "file", name: "bytes.bin", path: "bytes.bin", binary: true, data: "data:application/octet-stream;base64,Ynl0ZXM=" });
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } })).status, 200);
  await fs.writeFile(path.join(f.bin, "lilypond"), `#!${process.execPath}
const fs=require('node:fs');
for(const stem of ['main-one','separate-book']) {
  fs.writeFileSync('output/'+stem+'.pdf','%PDF-'+stem);
  fs.writeFileSync('output/'+stem+'.iris-map.tsv','IRIS-LILYPOND\\t1\\nP\\t1\\t595\\t842\\nG\\t1\\tpart.ly\\t1\\t10\\t10\\t100\\t200\\t10\\t8\\n');
}`, { mode: 0o755 });
  const build = await f.compile();
  assert.deepEqual(build.artifacts.map((a) => a.fileName), ["main-one.pdf", "separate-book.pdf"]);
  const manifest = JSON.parse(await fs.readFile(path.join(f.dir, build.outputDir, ".iris-navigation.json")));
  assert.deepEqual(manifest.sources.map((s) => s.path), ["main.ly", "part.ly"]);
  const result = await (await f.request(`${f.url}/builds/${build.buildId}/navigation`, { method: "POST", body: { direction: "forward", sourceFileId: build.data.project.nodes[1].id, line: 1, column: 10 } })).json();
  assert.deepEqual(result.matches.map((m) => m.artifactId), build.artifacts.map((a) => a.id));
});

test("navigation resolves synctex beside the compiler selected for the retained build", options, async (t) => {
  const f = await texFixture(t);
  await fs.writeFile(path.join(f.bin, "synctex"), `#!${process.execPath}\nconsole.log('SyncTeX result begin\\nOutput:main.pdf\\nPage:1\\nh:10\\nv:24\\nW:3\\nH:4\\nSyncTeX result end');`, { mode: 0o755 });
  const result = await (await f.request(f.route, { method: "POST", body: f.query })).json();
  assert.equal(result.status, "ready");
  assert.equal(result.matches[0].sourceFileId, f.query.sourceFileId);
});

test("disconnecting an HTTP navigation request kills and drains its native child", options, async (t) => {
  const f = await texFixture(t);
  const started = deferred(), exited = deferred();
  f.hooks.spawn = (command) => path.basename(command) === "synctex" ? { command: process.execPath, args: ["-e", "console.log('started');setInterval(()=>{},1000)"] } : undefined;
  f.hooks.afterSpawn = (child, command) => {
    if (path.basename(command) !== "synctex") return;
    child.stdout.once("data", () => started.resolve());
    child.once("close", () => exited.resolve());
  };
  const controller = new AbortController();
  const pending = fetch(f.baseUrl + f.route, { method: "POST", headers: { cookie: f.cookieFor(f.users.owner), "content-type": "application/json" }, body: JSON.stringify(f.query), signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await exited.promise;
  assert.equal(f.children.size, 0);
});

async function within(promise, label, ms = 1500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
  })]); } finally { clearTimeout(timer); }
}

function observeNavigation(t, f) {
  const mapping = require("../src/source-mapping");
  const navigate = mapping.navigateBuild;
  const gate = f.app.projectMutations.gate;
  const observation = { maps: 0, natives: 0, gates: 0, enrolled: deferred() };
  mapping.navigateBuild = (...args) => { observation.maps++; return navigate(...args); };
  f.app.projectMutations.gate = (...args) => {
    observation.gates++; observation.enrolled.resolve();
    return gate(...args);
  };
  f.hooks.spawn = (command) => path.basename(command) === "synctex" ? { command: process.execPath,
    args: ["-e", "console.log('SyncTeX result begin\\nOutput:main.pdf\\nPage:1\\nh:10\\nv:24\\nW:3\\nH:4\\nSyncTeX result end');"] } : undefined;
  f.hooks.afterSpawn = (_child, command) => { if (path.basename(command) === "synctex") observation.natives++; };
  t.after(() => { mapping.navigateBuild = navigate; f.app.projectMutations.gate = gate; });
  return { observation, gate };
}

for (const phase of ["initial gate", "native work", "final gate"]) test(`review I1: navigation rejects excess admission before a held project gate (${phase})`, options, async (t) => {
  const f = await texFixture(t);
  const { observation, gate } = observeNavigation(t, f);
  const entered = deferred(), release = deferred(), started = deferred();
  const nativeRelease = path.join(f.dataDir, "release-admission-native");
  if (phase !== "initial gate") {
    f.hooks.spawn = (command) => path.basename(command) === "synctex" ? { command: process.execPath,
      args: ["-e", `const fs=require('node:fs'); console.log('started'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(nativeRelease)})){clearInterval(timer);console.log('SyncTeX result begin\\nOutput:main.pdf\\nPage:1\\nh:10\\nv:24\\nW:3\\nH:4\\nSyncTeX result end');}},5);`] } : undefined;
    let count = 0;
    f.hooks.afterSpawn = (child, command) => { if (path.basename(command) === "synctex") {
      observation.natives++;
      child.stdout.once("data", () => { if (++count === 2) started.resolve(); });
    } };
  }
  const pending = [];
  const navigate = (role = "owner") => {
    const promise = f.request(f.route, { method: "POST", body: f.query, cookie: f.cookieFor(f.users[role]) }).then((r) => r.json());
    pending.push(promise); return promise;
  };
  let held;
  try {
    if (phase === "initial gate") {
      held = gate(f.id, async () => { entered.resolve(); await release.promise; });
      await entered.promise;
    }
    const first = navigate(), second = navigate("viewer");
    if (phase === "initial gate") {
      await within((async () => { while (observation.gates < 2) await new Promise((r) => setTimeout(r, 5)); })(), "initial enrollment");
    } else {
      await within(started.promise, "two native starts");
      held = gate(f.id, async () => { entered.resolve(); await release.promise; });
      await entered.promise;
      if (phase === "final gate") {
        await fs.writeFile(nativeRelease, "go");
        await within((async () => { while (observation.gates < 4) await new Promise((r) => setTimeout(r, 5)); })(), "final enrollment");
      }
    }
    const enrolled = observation.gates;
    const excess = await within(Promise.all(Array.from({ length: 4 }, () => navigate("editor"))), "prompt busy responses while gate remains held");
    assert.deepEqual(excess, Array(4).fill({ status: "unavailable", matches: [], reason: "busy" }));
    assert.equal(observation.gates, enrolled, "excess requests must not join the gate chain");
    release.resolve();
    await fs.writeFile(nativeRelease, "go");
    assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), ["ready", "ready"]);
    assert.equal(observation.natives, 2);
    assert.equal((await navigate()).status, "ready", "reservations release after final validation");
  } finally { release.resolve(); await fs.writeFile(nativeRelease, "go"); await held; await Promise.allSettled(pending); }
});

for (const phase of ["initial gate", "inspection", "authentication"]) test(`review I2: a disconnect during ${phase} causes zero map/native work`, options, async (t) => {
  const f = await texFixture(t);
  const { observation, gate } = observeNavigation(t, f);
  const entered = deferred(), release = deferred(), closed = deferred();
  let held;
  if (phase === "initial gate") {
    held = gate(f.id, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
  } else {
    f.hooks.afterQuery = async (sql) => {
      if (phase === "inspection" ? sql.includes("FROM build_outputs WHERE id = $1") : sql.includes("FROM users WHERE id = $1")) {
        entered.resolve(); await release.promise;
      }
    };
  }
  f.server.prependOnceListener("request", (_req, res) => res.once("close", () => closed.resolve()));
  const controller = new AbortController();
  const pending = fetch(f.baseUrl + f.route, { method: "POST", headers: { cookie: f.cookieFor(f.users.owner), "content-type": "application/json" }, body: JSON.stringify(f.query), signal: controller.signal });
  try {
    await within(phase === "initial gate" ? observation.enrolled.promise : entered.promise, "blocked request");
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    await within(closed.promise, "server response close");
    assert.equal(observation.natives, 0);
    release.resolve(); await held;
    await within((async () => { while (!f.app.runtimeSettled()) await new Promise((r) => setTimeout(r, 5)); })(), "cancelled handler drain");
    assert.equal(observation.maps, 0, "closed requests must not invoke the mapping adapter");
    assert.equal(observation.natives, 0);
    assert.equal(observation.gates, phase === "authentication" ? 0 : 1, "no final response gate after cancellation");
    f.hooks.afterQuery = null;
    const resumed = await f.request(f.route, { method: "POST", body: f.query });
    assert.equal((await resumed.json()).status, "ready", "cancelled reservation released after draining its wait");
  } finally { controller.abort(); release.resolve(); await held; await pending.catch(() => {}); }
});

test("review I1/I2: early errors and disabled responses release navigation admission", options, async (t) => {
  const f = await texFixture(t);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.request(f.route, { method: "POST", body: { ...f.query, line: 0 } })).status, 400);
    assert.equal((await f.request(f.route, { method: "POST", body: f.query, cookie: f.cookieFor(f.users.outsider) })).status, 404);
  }
  assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 2, sourceMapping: false } })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await (await f.request(f.route, { method: "POST", body: f.query })).json()).status, "disabled");
});

test("review I1/I2: cancelled gate waiters retain bounded reservations until their callbacks drain", options, async (t) => {
  const f = await texFixture(t);
  const { observation, gate } = observeNavigation(t, f);
  const entered = deferred(), release = deferred(), closed = deferred();
  const held = gate(f.id, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let closes = 0;
  const observeClose = (_req, res) => res.once("close", () => { if (++closes === 2) closed.resolve(); });
  f.server.prependListener("request", observeClose);
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) => fetch(f.baseUrl + f.route, { method: "POST", headers: { cookie: f.cookieFor(f.users.owner), "content-type": "application/json" }, body: JSON.stringify(f.query), signal: controller.signal }));
  try {
    await within((async () => { while (observation.gates < 2) await new Promise((r) => setTimeout(r, 5)); })(), "two gate waiters");
    const aborted = pending.map((p) => assert.rejects(p, { name: "AbortError" }));
    controllers.forEach((c) => c.abort());
    await Promise.all(aborted); await within(closed.promise, "both server closes");
    f.server.removeListener("request", observeClose);
    for (let i = 0; i < 3; i++) {
      const res = await within(f.request(f.route, { method: "POST", body: f.query }), "busy after cancellations");
      assert.deepEqual(await res.json(), { status: "unavailable", matches: [], reason: "busy" });
    }
    assert.equal(observation.gates, 2);
    release.resolve(); await held;
    await within((async () => { while (!f.app.runtimeSettled()) await new Promise((r) => setTimeout(r, 5)); })(), "cancelled waiters drain");
    assert.equal(observation.maps, 0);
    assert.equal(observation.natives, 0);
    const resumed = await Promise.all([f.request(f.route, { method: "POST", body: f.query }), f.request(f.route, { method: "POST", body: f.query })]);
    assert.deepEqual(await Promise.all(resumed.map(async (r) => (await r.json()).status)), ["ready", "ready"]);
  } finally { controllers.forEach((c) => c.abort()); release.resolve(); await held; await Promise.allSettled(pending); f.server.removeListener("request", observeClose); }
});

test("review I2: disconnect during an incomplete JSON body releases admission without joining a project gate", options, async (t) => {
  const f = await texFixture(t);
  const { observation } = observeNavigation(t, f);
  const http = require("node:http");
  for (let i = 0; i < 3; i++) {
    const receiving = deferred(), closed = deferred();
    f.server.prependOnceListener("request", (req, res) => {
      const iterate = req[Symbol.asyncIterator];
      req[Symbol.asyncIterator] = function (...args) { receiving.resolve(); return iterate.apply(this, args); };
      res.once("close", () => closed.resolve());
    });
    const request = http.request(f.baseUrl + f.route, { method: "POST", headers: { cookie: f.cookieFor(f.users.owner), "content-type": "application/json" } });
    request.on("error", () => {});
    request.write('{"direction":');
    try { await within(receiving.promise, "body consumption"); }
    finally { request.destroy(); }
    await within(closed.promise, "body disconnect close");
    await within((async () => { while (!f.app.runtimeSettled()) await new Promise((r) => setTimeout(r, 5)); })(), "body cancellation drain");
  }
  assert.deepEqual({ maps: observation.maps, natives: observation.natives, gates: observation.gates }, { maps: 0, natives: 0, gates: 0 });
  assert.equal((await (await f.request(f.route, { method: "POST", body: f.query })).json()).status, "ready");
});
