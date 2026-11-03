const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");
const { isolatedSchema } = require("./helpers/isolated-schema.cjs");
const { initializeSchema } = require("../src/database");
const { workspace: disposableWorkspace, launch, until, freePort } = require("../scripts/lib/disposable.cjs");

const options = { skip: !connectionString, timeout: 20000 };
const nativeLua = { ...options, skip: options.skip || process.env.IRIS_TEST_LUA !== "1" };
const script = `return {apiVersion=1,pluginId='http',parameterSchema={type='object',properties={
  count={type='integer',default=2,minimum=1}}},plan=function() error('planning was not requested') end}`;

async function fixture(t, source = script, env = {}) {
  const f = await serverFixture(t, { RETENTION_ENABLED: "false", LUA_BIN_PATH: process.env.LUA_BIN_PATH || "", ...env });
  const users = {}, cookies = {};
  for (const role of ["owner", "editor", "viewer", "outsider"]) {
    const user = (await f.pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,$2,$3,$2) RETURNING *",
      [uuidv7(), role, `${role}@example.test`])).rows[0];
    users[role] = user; cookies[role] = f.cookieFor(user);
  }
  const request = (url, opts = {}, role = "owner") => f.request(url, { cookie: cookies[role], ...opts });
  const created = await request("/api/projects", { method: "POST", body: { name: "Pipeline HTTP", data: { projectType: "lilypond", project: { nodes: [
    { id: "script", type: "file", name: "iris.lua", path: "iris.lua", content: source },
    { id: "module", type: "file", name: "unused.lua", path: "unused.lua", content: "return 1\r\n" },
    { id: "main", type: "file", name: "main.ly", path: "main.ly", content: "music = { c'1 }\r\n" },
  ] } } } });
  assert.equal(created.status, 201);
  const project = await created.json(), id = project.project.id, base = `/api/projects/${id}`;
  for (const role of ["editor", "viewer"]) await f.pool.query("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)", [id, users[role].id, role]);
  const metadata = async () => {
    const response = await request(`${base}/pipeline`); assert.equal(response.status, 200, JSON.stringify(f.logs));
    return (await response.json()).pipeline;
  };
  const approve = identity => request(`${base}/pipeline/approval`, { method: "POST", body: { identity } });
  return { ...f, users, cookies, request, project, id, base, metadata, approve, dir: path.join(f.dataDir, "projects", id) };
}

test("pipeline metadata and owner approval bind all Lua files without executing source or saving", options, async t => {
  const f = await fixture(t, "error('must not execute during metadata or approval')");
  const before = (await f.pool.query("SELECT revision FROM projects WHERE id=$1", [f.id])).rows[0].revision;
  const initial = await f.metadata();
  assert.match(initial.candidate?.bundleHash || "", /^[a-f0-9]{64}$/);
  for (const [role, status] of [["viewer", 403], ["editor", 403], ["outsider", 404]]) {
    const response = await f.request(`${f.base}/pipeline/approval`, { method: "POST", body: { identity: initial.candidate } }, role);
    assert.equal(response.status, status);
  }
  const approved = await f.approve(initial.candidate); assert.equal(approved.status, 201);
  const state = await f.metadata();
  assert.equal(state.enabled, true); assert.equal(state.descriptor, null);
  assert.equal(state.approval.bundleHash, initial.candidate.bundleHash);
  assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id=$1", [f.id])).rows[0].revision, before);
  assert.equal((await f.pool.query("SELECT count(*) FROM build_outputs")).rows[0].count, "0");
  const module = f.project.data.project.nodes.find(node => node.path === "unused.lua");
  const room = f.app.collabRooms.open({ projectId: f.id, fileId: module.id, path: module.path, content: "return 2\r\n" });
  room.storageDir = f.dir;
  const changed = await f.metadata();
  assert.notEqual(changed.candidate.bundleHash, initial.candidate.bundleHash);
  assert.equal(changed.candidate.policyHash, initial.candidate.policyHash);
  const stale = await f.approve(initial.candidate);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).errorCode, "PIPELINE_BUNDLE_CHANGED");
  assert.equal((await f.pool.query("SELECT count(*) FROM pipeline_approvals")).rows[0].count, "1");
  assert.equal(await fs.readFile(path.join(f.dir, "unused.lua"), "utf8"), "return 1\r\n");
});

test("explicit Lua inspection requires current approval and caches its descriptor for readers", nativeLua, async t => {
  const f = await fixture(t);
  const inspect = role => f.request(`${f.base}/pipeline/inspect`, { method: "POST", body: {} }, role);
  assert.equal((await inspect("owner")).status, 409);
  const initial = await f.metadata(); assert.equal((await f.approve(initial.candidate)).status, 201);
  assert.equal((await inspect("viewer")).status, 403);
  assert.equal((await inspect("outsider")).status, 404);
  const inspected = await inspect("editor");
  assert.equal(inspected.status, 200, await inspected.clone().text());
  const descriptor = (await inspected.json()).descriptor;
  assert.equal(descriptor.pluginId, "http");
  assert.equal(descriptor.parameterSchema.properties.count.default, 2);
  const cached = await f.request(`${f.base}/pipeline`, {}, "viewer");
  assert.deepEqual((await cached.json()).pipeline.descriptor, descriptor);
  assert.equal((await f.pool.query("SELECT count(*) FROM build_outputs")).rows[0].count, "0");
  await fs.writeFile(path.join(f.dir, "unused.lua"), "error('unapproved')");
  const stale = await inspect("owner");
  assert.equal(stale.status, 409); assert.equal((await stale.json()).errorCode, "PIPELINE_APPROVAL_REQUIRED");
  assert.deepEqual((await f.metadata()).descriptor, descriptor);
});

test("configured missing Lua permits metadata and approval but fails explicit inspection", options, async t => {
  const f = await fixture(t, script, { LUA_BIN_PATH: "/iris-missing-interpreter" });
  const initial = await f.metadata(); assert.equal((await f.approve(initial.candidate)).status, 201);
  const inspected = await f.request(`${f.base}/pipeline/inspect`, { method: "POST", body: {} });
  assert.equal(inspected.status, 503);
  assert.equal((await inspected.json()).errorCode, "PIPELINE_RUNTIME_UNAVAILABLE");
  assert.equal((await f.metadata()).descriptor, null);
});

for (const change of ["approval", "permission", "shutdown"]) test(`${change} revocation cancels an executing descriptor inspection before its deadline`, nativeLua, async t => {
  const f = await fixture(t, "while true do end");
  const approved = await f.approve((await f.metadata()).candidate), approval = (await approved.json()).approval;
  const inspecting = f.request(`${f.base}/pipeline/inspect`, { method: "POST", body: {} }, "editor");
  const root = path.join(f.dataDir, ".pipeline-runtime"), deadline = Date.now() + 4000;
  for (;;) {
    const files = (await fs.readdir(root)).filter(file => file.endsWith(".json") && file !== "installation.json");
    const receipts = await Promise.all(files.map(file => fs.readFile(path.join(root, file), "utf8").then(JSON.parse)));
    if (receipts.some(receipt => receipt.phase === "running" && receipt.pid)) break;
    assert.ok(Date.now() < deadline, "inspection must start before revocation"); await delay(10);
  }
  if (change === "shutdown") await f.app.startGracefulShutdown("SIGTERM", f.server);
  else {
    const revoked = change === "approval"
      ? await f.request(`${f.base}/pipeline/approval/${approval.id}`, { method: "DELETE" })
      : await f.request(`${f.base}/members/${f.users.editor.id}`, { method: "DELETE" });
    assert.equal(revoked.status, 200);
  }
  const result = await inspecting;
  assert.equal(result.status, 409);
  assert.equal((await result.json()).errorCode, "PIPELINE_APPROVAL_REQUIRED");
  assert.deepEqual(await fs.readdir(root), ["installation.json"]);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".pipeline-staging")), []);
  if (change === "shutdown") assert.deepEqual(f.exits, [0]);
  else assert.equal((await f.metadata()).descriptor, null);
});

for (const location of [".pipeline-runtime", ".pipeline-staging"]) test(`inspection retains evidence and refuses a clean drain after ${location} disposal fails`, nativeLua, async t => {
  const f = await fixture(t);
  const approved = await f.approve((await f.metadata()).candidate), approval = (await approved.json()).approval;
  const remove = fs.rm, root = path.join(await fs.realpath(f.dataDir), location);
  t.mock.method(fs, "rm", async (file, ...args) => {
    if (await fs.realpath(path.dirname(file)).catch(() => "") === root) throw Object.assign(new Error("Controlled cleanup refusal"), { code: "EACCES" });
    return remove(file, ...args);
  });
  const response = await f.request(`${f.base}/pipeline/inspect`, { method: "POST", body: {} });
  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
  const staging = path.join(f.dataDir, ".pipeline-staging"), snapshots = await fs.readdir(staging);
  assert.equal(snapshots.length, 1);
  assert.equal(await fs.readFile(path.join(staging, snapshots[0], "snapshot", "iris.lua"), "utf8"), script);
  const revoked = await f.request(`${f.base}/pipeline/approval/${approval.id}`, { method: "DELETE" });
  assert.equal(revoked.status, 503);
  assert.ok(f.app.healthPayload().pendingWrites > 0, "backup must not report drained recovery state");
  await f.app.startGracefulShutdown("SIGTERM", f.server);
  assert.deepEqual(f.exits, [1]);
});

test("shutdown during inspection authorization prevents a late interpreter launch", nativeLua, async t => {
  const f = await fixture(t);
  await f.approve((await f.metadata()).candidate);
  const entered = deferred(), release = deferred();
  f.hooks.beforeQuery = async sql => {
    if (!sql.startsWith("SELECT id,path FROM project_files")) return;
    entered.resolve(); await release.promise;
  };
  const inspecting = f.request(`${f.base}/pipeline/inspect`, { method: "POST", body: {} });
  await entered.promise;
  const shutdown = f.app.startGracefulShutdown("SIGTERM", f.server);
  release.resolve();
  const response = await inspecting;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).errorCode, "PIPELINE_RUNTIME_STOPPING");
  await shutdown;
  assert.deepEqual(f.exits, [0]);
  assert.equal(await fs.stat(path.join(f.dataDir, ".pipeline-staging")).catch(() => null), null);
});

for (const change of ["approval", "replacement", "source"]) test(`queued inspection rechecks ${change} before executing approved source`, nativeLua, async t => {
  const f = await fixture(t, script, { COMPILE_CONCURRENCY: "1" });
  const initial = await f.metadata(), approval = (await (await f.approve(initial.candidate)).json()).approval;
  const release = await f.app.compileGate.acquire();
  t.after(release);
  const inspecting = f.request(`${f.base}/pipeline/inspect`, { method: "POST", body: {} });
  await until(() => f.app.compileGate.queued === 1, "queued inspection", 4000);
  if (change === "approval") {
    assert.equal((await f.request(`${f.base}/pipeline/approval/${approval.id}`, { method: "DELETE" })).status, 200);
  } else if (change === "replacement") {
    assert.equal((await f.approve(initial.candidate)).status, 201);
  } else {
    const file = f.project.data.project.nodes.find(node => node.path === "unused.lua");
    f.app.collabRooms.open({ projectId: f.id, fileId: file.id, path: file.path, content: "return 2\r\n" }).storageDir = f.dir;
  }
  release();
  const response = await inspecting;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).errorCode, "PIPELINE_APPROVAL_REQUIRED");
  assert.equal((await f.metadata()).descriptor, null);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".pipeline-runtime")), ["installation.json"]);
});

for (const phase of ["idle", "running"]) test(`startup reconciles ${phase} native receipts before serving requests with Lua absent`, options, async t => {
  const pool = await isolatedSchema(t), work = await disposableWorkspace("iris-pipeline-startup-");
  t.after(() => work.close());
  await initializeSchema(pool);
  await pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,'existing','existing@example.test','Existing')", [uuidv7()]);
  const schema = (await pool.query("SELECT current_schema() AS name")).rows[0].name;
  const database = new URL(connectionString), data = path.join(work.root, "data"), root = path.join(data, ".pipeline-runtime");
  const installationId = uuidv7(), id = uuidv7(), receipt = { version: 2, id, installationId, coordinatorId: uuidv7(),
    runId: uuidv7(), stepId: "interrupted", deadlineAt: Date.now() + 60000, phase, pid: null };
  await fs.mkdir(path.join(root, id), { recursive: true });
  await fs.writeFile(path.join(root, "installation.json"), JSON.stringify({ installationId }));
  await fs.writeFile(path.join(root, `${id}.json`), JSON.stringify(receipt));
  await fs.writeFile(path.join(root, id, "evidence"), "retain uncertain execution");
  const source = path.resolve(__dirname, ".."), port = await freePort();
  const app = launch(process.execPath, [path.join(source, "src/server.js")], { cwd: work.cwd, quiet: true, allowFailure: true, timeout: 15000,
    env: { ...work.env, DATA_DIR: data, PUBLIC_DIR: path.join(source, "public"), PORT: String(port), BIND_ADDRESS: "127.0.0.1",
      IRIS_SECRET: "pipeline-startup-test-only-secret", DB_HOST: database.hostname, DB_PORT: database.port,
      DB_USER: decodeURIComponent(database.username), DB_PASSWORD: decodeURIComponent(database.password), DB_NAME: database.pathname.slice(1),
      PGOPTIONS: `-c search_path=${schema}`, RETENTION_ENABLED: "false", LUA_BIN_PATH: path.join(work.root, "missing-lua") } });
  work.defer(() => app.stop());
  await until(() => /Iris listening|Unable to start Iris backend/.test(app.output()), "pipeline startup", 10000);
  if (phase === "idle") {
    assert.match(app.output(), /Iris listening/);
    assert.deepEqual(await fs.readdir(root), ["installation.json"]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    assert.equal((await app.stop()).code, 0);
  } else {
    assert.match(app.output(), /PIPELINE_WORKER_RECOVERY_REQUIRED/);
    assert.equal((await app.done).code, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, `${id}.json`), "utf8")), receipt);
    assert.equal(await fs.readFile(path.join(root, id, "evidence"), "utf8"), "retain uncertain execution");
  }
});
