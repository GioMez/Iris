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
const generatingScript = `local schema={type='object',properties={count={type='integer',default=2,minimum=1},loop={type='boolean',default=false}}}
return {apiVersion=1,pluginId='http-generator',parameterSchema=schema,
plan=function(ctx) return {apiVersion=1,pluginId='http-generator',parameterSchema=schema,steps={
  {id='generate',adapter={id='iris.lua',version='1.0.0'},options={script='iris.lua',entrypoint='generate'},
    inputs={source={snapshot=true}},outputs={text={kind='file',mediaType='text/plain',path='generated/result.txt'}}}},
  targets={main={steps={'generate'},publish={{step='generate',port='text'}}}}} end,
generate=function(ctx)
  ctx.log('info','generation started')
  if ctx.options.parameters.loop then while true do end end
  ctx.diagnostic({severity='warning',message='input note',input='source',file='main.ly',line=1})
  ctx.write('text','generated/result.txt',string.rep(ctx.read('source','main.ly'),ctx.options.parameters.count)..string.char(0,255))
end}`;

async function inspect(f) {
  assert.equal((await f.approve((await f.metadata()).candidate)).status, 201);
  const response = await f.request(`${f.base}/pipeline/inspect`, { method: "POST", body: {} });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).descriptor;
}

async function terminalRun(f, id) {
  let run;
  await until(async () => {
    const response = await f.request(`${f.base}/runs/${id}`);
    assert.equal(response.status, 200); run = (await response.json()).run;
    return !["queued", "planning", "running"].includes(run.state);
  }, "pipeline completion", 10000);
  return run;
}

async function runningTransform(f, id) {
  let run;
  try {
    await until(async () => {
      const response = await f.request(`${f.base}/runs/${id}`);
      assert.equal(response.status, 200);
      run = (await response.json()).run;
      assert.ok(["queued", "planning", "running"].includes(run.state), JSON.stringify(run));
      return run.log.includes("generation started");
    }, "running transform", 4000);
  } catch (error) {
    error.message += `; last run: ${JSON.stringify(run)}`;
    throw error;
  }
}

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

test("asynchronous Lua runs persist progress and publish byte-exact generated downloads", nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } }, "editor");
  assert.equal(response.status, 202, await response.clone().text());
  const accepted = (await response.json()).run;
  assert.equal(accepted.state, "queued");
  assert.deepEqual(accepted.parameters, { count: 2, loop: false });
  const run = await terminalRun(f, accepted.id);
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.ok(run.sequence > accepted.sequence);
  assert.match(run.log, /generation started/);
  assert.equal(run.steps[0].state, "succeeded");
  assert.equal(run.steps[0].diagnostics[0].message, "input note");
  const sourceId = f.project.data.project.nodes.find(file => file.path === "main.ly").id;
  assert.equal(run.steps[0].diagnostics[0].sourceFileId, sourceId);
  assert.match(run.steps[0].diagnostics[0].sourceRevisionId, /^[a-f0-9-]{36}$/);
  const buildResponse = await f.request(`${f.base}/builds/${run.id}`, {}, "viewer");
  assert.equal(buildResponse.status, 200);
  const build = await buildResponse.json();
  assert.equal(build.build.kind, "pipeline"); assert.equal(build.build.target, "main");
  assert.equal(build.build.requestOrder, run.requestOrder);
  assert.equal(build.build.primaryPreview, null); assert.equal(build.primaryPreviewArtifactId, null);
  assert.equal(build.artifacts.length, 1);
  assert.equal(build.files.length, 1, "private publication receipts must not enter downloads");
  const artifact = build.artifacts[0], download = await f.request(artifact.url, {}, "viewer");
  assert.equal(artifact.producerStep, "generate"); assert.equal(artifact.outputPort, "text");
  assert.equal(artifact.logicalPath, "generated/result.txt");
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.concat([Buffer.from("music = { c'1 }\r\n".repeat(2)), Buffer.from([0, 255])]));
  assert.equal(await fs.readFile(path.join(f.dir, "main.ly"), "utf8"), "music = { c'1 }\r\n");
  assert.equal((await f.request(artifact.url, {}, "outsider")).status, 404);
  await until(() => f.app.healthPayload().pendingWrites === 0, "run cleanup", 4000);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".pipeline-staging")), []);
});

test("run admission rejects invalid parameters and stale descriptors before saving or planning", nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const revision = (await f.pool.query("SELECT revision FROM projects WHERE id=$1", [f.id])).rows[0].revision;
  for (const [parameters, descriptorHash, status] of [[{ count: 0 }, descriptor.descriptorHash, 400], [null, descriptor.descriptorHash, 400], [{}, "0".repeat(64), 409]]) {
    const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters, descriptorHash } });
    assert.equal(response.status, status, await response.clone().text());
  }
  assert.equal((await f.pool.query("SELECT count(*) FROM build_outputs")).rows[0].count, "0");
  assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id=$1", [f.id])).rows[0].revision, revision);
});

for (const mimeType of ["text/html", "image/svg+xml"]) test(`generated ${mimeType} downloads cannot execute in the application origin`, nativeLua, async t => {
  const source = generatingScript.replace("mediaType='text/plain'", `mediaType='${mimeType}'`);
  const f = await fixture(t, source), descriptor = await inspect(f);
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202);
  const run = await terminalRun(f, (await response.json()).run.id);
  assert.equal(run.state, "succeeded");
  const build = await (await f.request(`${f.base}/builds/${run.id}`)).json();
  const download = await f.request(build.artifacts[0].url, {}, "viewer");
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), mimeType);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-security-policy"), /(?:^|;)\s*sandbox(?:;|$)/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.concat([Buffer.from("music = { c'1 }\r\n".repeat(2)), Buffer.from([0, 255])]));
});

test("run admission retains snapshots when rejection cleanup fails", nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const root = path.join(await fs.realpath(f.dataDir), ".pipeline-staging"), remove = fs.rm;
  t.mock.method(fs, "rm", async (file, ...args) => {
    if (path.dirname(file) === root) throw Object.assign(new Error("Controlled admission cleanup failure"), { code: "EACCES" });
    return remove(file, ...args);
  });
  f.hooks.beforeClientQuery = sql => {
    if (sql.startsWith("INSERT INTO build_outputs")) throw new Error("Controlled admission failure");
  };
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
  assert.ok(f.app.healthPayload().pendingWrites > 0);
  assert.equal((await fs.readdir(root)).length, 1);
  assert.equal((await f.pool.query("SELECT count(*) FROM build_outputs")).rows[0].count, "0");
});

for (const operation of ["inspection", "run"]) test(`${operation} snapshot setup retains partial sources when copy and cleanup both fail`, nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const root = path.join(await fs.realpath(f.dataDir), ".pipeline-staging"), open = fs.open, remove = fs.rm;
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file.startsWith(root + path.sep) && file.endsWith("/snapshot/unused.lua")) {
      throw Object.assign(new Error("Controlled snapshot copy failure"), { code: "ENOSPC" });
    }
    return open(file, ...args);
  });
  t.mock.method(fs, "rm", async (file, ...args) => {
    if (path.dirname(file) === root) throw Object.assign(new Error("Controlled partial snapshot cleanup failure"), { code: "EACCES" });
    return remove(file, ...args);
  });
  const endpoint = operation === "inspection" ? `${f.base}/pipeline/inspect` : `${f.base}/runs`;
  const body = operation === "inspection" ? {} : { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash };
  const response = await f.request(endpoint, { method: "POST", body });
  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
  assert.ok(f.app.healthPayload().pendingWrites > 0);
  const retained = await fs.readdir(root);
  assert.equal(retained.length, 1);
  assert.equal(await fs.readFile(path.join(root, retained[0], "snapshot/iris.lua"), "utf8"), generatingScript);
  assert.equal((await f.pool.query("SELECT count(*) FROM build_outputs")).rows[0].count, "0");
  assert.equal((await f.request(endpoint, { method: "POST", body })).status, 503);
  await f.app.startGracefulShutdown("SIGTERM", f.server);
  assert.deepEqual(f.exits, [1]);
});

test("accepted Lua runs use authoritative live source even after later edits", nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const file = f.project.data.project.nodes.find(file => file.path === "main.ly");
  const room = f.app.collabRooms.open({ projectId: f.id, fileId: file.id, path: file.path, content: "live source\r\n" });
  room.storageDir = f.dir;
  const entered = deferred(), release = deferred();
  f.hooks.beforeClientQuery = async (sql, values) => {
    if (sql.startsWith("UPDATE build_outputs SET status=$2") && values[1] === "planning") {
      entered.resolve(); await release.promise;
    }
  };
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202);
  const { run } = await response.json();
  await entered.promise;
  await fs.writeFile(path.join(f.dir, "main.ly"), "later source\n");
  release.resolve();
  assert.equal((await terminalRun(f, run.id)).state, "succeeded");
  const build = await (await f.request(`${f.base}/builds/${run.id}`)).json();
  const bytes = await (await f.request(build.artifacts[0].url)).arrayBuffer();
  assert.deepEqual(Buffer.from(bytes), Buffer.concat([Buffer.from("live source\r\n".repeat(2)), Buffer.from([0, 255])]));
});

test("a validation-only target succeeds without a publication directory or artifacts", nativeLua, async t => {
  const source = `return {apiVersion=1,pluginId='validate',plan=function() return {apiVersion=1,pluginId='validate',steps={
    {id='check',adapter={id='iris.lua',version='1.0.0'},options={script='iris.lua',entrypoint='check'}}},
    targets={main={steps={'check'},publish=iris.array{}}}} end,check=function(ctx) ctx.log('info','checked') end}`;
  const f = await fixture(t, source), descriptor = await inspect(f);
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202);
  const run = await terminalRun(f, (await response.json()).run.id);
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.equal(run.artifactCount, 0); assert.equal(run.storagePath, null);
  const build = await (await f.request(`${f.base}/builds/${run.id}`)).json();
  assert.deepEqual(build.artifacts, []); assert.equal(build.archiveUrl, null);
});

test("cancelling an asynchronous Lua run drains its process and publishes no partial output", nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: { loop: true }, descriptorHash: descriptor.descriptorHash } }, "editor");
  assert.equal(response.status, 202);
  const { run } = await response.json();
  await runningTransform(f, run.id);
  assert.equal((await f.request(`${f.base}/runs/${run.id}/cancel`, { method: "POST" }, "viewer")).status, 403);
  assert.equal((await f.request(`${f.base}/runs/${run.id}/cancel`, { method: "POST" }, "editor")).status, 200);
  assert.equal((await terminalRun(f, run.id)).state, "cancelled");
  assert.equal((await f.pool.query("SELECT count(*) FROM build_artifacts WHERE build_id=$1", [run.id])).rows[0].count, "0");
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".pipeline-runtime")), ["installation.json"]);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".pipeline-staging")), []);
});

for (const change of ["approval", "permission", "shutdown", "deletion"]) test(`${change} loss drains an accepted asynchronous run`, nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: { loop: true }, descriptorHash: descriptor.descriptorHash } }, "editor");
  assert.equal(response.status, 202);
  const { run } = await response.json();
  await runningTransform(f, run.id);
  if (change === "shutdown") {
    await f.app.startGracefulShutdown("SIGTERM", f.server);
    assert.deepEqual(f.exits, [0]);
  } else {
    const revoked = change === "approval"
      ? await f.request(`${f.base}/pipeline/approval/${run.approvalId}`, { method: "DELETE" })
      : change === "deletion" ? await f.request(f.base, { method: "DELETE" })
        : await f.request(`${f.base}/members/${f.users.editor.id}`, { method: "DELETE" });
    assert.equal(revoked.status, 200);
    if (change === "deletion") assert.equal((await f.request(`${f.base}/runs/${run.id}`)).status, 404);
    else assert.equal((await terminalRun(f, run.id)).state, "cancelled");
  }
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".pipeline-runtime")), ["installation.json"]);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, ".pipeline-staging")), []);
});

test("failed asynchronous run cleanup retains source evidence and blocks a successful drain", nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const root = path.join(await fs.realpath(f.dataDir), ".pipeline-staging"), remove = fs.rm;
  t.mock.method(fs, "rm", async (file, ...args) => {
    if (path.dirname(file) === root) throw Object.assign(new Error("Controlled cleanup refusal"), { code: "EACCES" });
    return remove(file, ...args);
  });
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202);
  const { run } = await response.json();
  assert.equal((await terminalRun(f, run.id)).state, "succeeded");
  await until(() => f.app.runtimeSettled(), "failed cleanup completion", 4000);
  assert.ok(f.app.healthPayload().pendingWrites > 0);
  await f.app.startGracefulShutdown("SIGTERM", f.server);
  assert.deepEqual(f.exits, [1]);
  assert.equal((await fs.readdir(root)).length, 1);
});

test("transform worker cleanup failure preserves the whole run for recovery", nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  const root = path.join(await fs.realpath(f.dataDir), ".pipeline-runtime"), remove = fs.rm;
  t.mock.method(fs, "rm", async (file, ...args) => {
    if (path.dirname(file) === root) {
      const receipt = JSON.parse(await fs.readFile(`${file}.json`, "utf8"));
      if (receipt.stepId === "generate") throw Object.assign(new Error("Controlled worker cleanup failure"), { code: "EACCES" });
    }
    return remove(file, ...args);
  });
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202);
  const { run } = await response.json();
  await until(() => f.app.runtimeSettled(), "worker cleanup failure", 4000);
  assert.equal((await (await f.request(`${f.base}/runs/${run.id}`)).json()).run.state, "running");
  assert.ok(f.app.healthPayload().pendingWrites > 0);
  assert.equal((await fs.readdir(path.join(f.dataDir, ".pipeline-staging"))).length, 1);
  assert.equal((await f.pool.query("SELECT count(*) FROM build_artifacts WHERE build_id=$1", [run.id])).rows[0].count, "0");
});

for (const damage of ["none", "artifact", "receipt", "restart"]) test(`publication database failure checks retained ${damage === "none" ? "matching bytes" : damage === "restart" ? "bytes after a real server restart" : `changed ${damage}`} during reconciliation`, nativeLua, async t => {
  const f = await fixture(t, generatingScript), descriptor = await inspect(f);
  f.hooks.beforeClientQuery = sql => {
    if (sql.startsWith("UPDATE build_outputs SET status='succeeded'")) throw new Error("Controlled finalization failure");
  };
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202);
  const { run } = await response.json();
  await until(() => f.app.runtimeSettled(), "publication failure", 4000);
  const retained = (await f.pool.query("SELECT status,publication_state,publication_path FROM build_outputs WHERE id=$1", [run.id])).rows[0];
  assert.equal(retained.status, "running");
  assert.equal(retained.publication_state, "prepared");
  const generated = path.join(f.dir, retained.publication_path, "generate/text/generated/result.txt");
  const before = await fs.readFile(generated);
  assert.ok(f.app.healthPayload().pendingWrites > 0);
  if (damage === "artifact") {
    await fs.chmod(generated, 0o600);
    const changed = Buffer.from(before); changed[0] ^= 1;
    await fs.writeFile(generated, changed);
  } else if (damage === "receipt") {
    const receipt = path.join(f.dir, retained.publication_path, ".iris-pipeline-publication.jsonl");
    const contents = await fs.readFile(receipt, "utf8");
    await fs.chmod(receipt, 0o600);
    await fs.writeFile(receipt, contents.replace(run.id, uuidv7()));
  }
  delete f.hooks.beforeClientQuery;
  if (damage === "restart") {
    await f.app.startGracefulShutdown("SIGTERM", f.server);
    assert.deepEqual(f.exits, [1]);
    const work = await disposableWorkspace("iris-publication-restart-");
    try {
      const schema = (await f.pool.query("SELECT current_schema() AS name")).rows[0].name;
      const database = new URL(connectionString), source = path.resolve(__dirname, ".."), port = await freePort();
      const app = launch(process.execPath, [path.join(source, "src/server.js")], { cwd: work.cwd, quiet: true, allowFailure: true, timeout: 15000,
        env: { ...work.env, DATA_DIR: f.dataDir, PUBLIC_DIR: path.join(source, "public"), PORT: String(port), BIND_ADDRESS: "127.0.0.1",
          IRIS_SECRET: "pipeline-restart-test-only-secret", DB_HOST: database.hostname, DB_PORT: database.port,
          DB_USER: decodeURIComponent(database.username), DB_PASSWORD: decodeURIComponent(database.password), DB_NAME: database.pathname.slice(1),
          PGOPTIONS: `-c search_path=${schema}`, RETENTION_ENABLED: "false", LUA_BIN_PATH: path.join(work.root, "missing-lua") } });
      work.defer(() => app.stop());
      await until(() => /Iris listening|Unable to start Iris backend/.test(app.output()), "restarted server", 10000);
      assert.match(app.output(), /Iris listening/);
      await until(async () => (await f.pool.query("SELECT status FROM build_outputs WHERE id=$1", [run.id])).rows[0].status === "interrupted", "restart reconciliation", 4000);
      await until(async () => (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).pendingWrites === 0, "restarted server drain", 4000);
      assert.equal((await app.stop()).code, 0);
    } finally { await work.close(); }
  } else {
    await f.pool.query("UPDATE build_outputs SET coordinator_id=$2 WHERE id=$1", [run.id, uuidv7()]);
    f.app.startRetentionSweep();
    await until(() => f.app.runtimeSettled(), "publication reconciliation", 4000);
    assert.equal((await (await f.request(`${f.base}/runs/${run.id}`)).json()).run.state, damage === "none" ? "interrupted" : "running");
  }
  if (damage !== "artifact") assert.deepEqual(await fs.readFile(generated), before);
  else assert.equal((await fs.stat(generated)).size, before.length);
});

for (const family of ["latex", "lilypond"]) for (const mode of ["single-pass", "two-pass", "broken-include"]) test(`HTTP ${family} ${mode} layout decorator ${mode === "broken-include" ? "retains generated-source diagnostics" : "publishes interactive layers with native navigation"}`, {
  ...nativeLua, timeout: 60000, skip: nativeLua.skip || process.env.IRIS_TEST_COMPILERS !== "1",
}, async t => {
  const { PDFDocument, PDFName, PDFString, rgb } = require("pdf-lib");
  const twoPass = mode !== "single-pass";
  const source = await fs.readFile(path.join(__dirname, `fixtures/pipelines/${twoPass ? "adjust-layout" : "decorate"}.lua`), "utf8");
  const f = await fixture(t, source), data = f.project.data, main = family === "latex" ? "main.tex" : "main.ly";
  const layer = await PDFDocument.create(), page = layer.addPage([10, 10]);
  page.drawRectangle({ x: 0, y: 0, width: 10, height: 10, color: rgb(1, 0, 0) });
  page.node.addAnnot(layer.context.register(layer.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], Border: [0, 0, 0],
    A: { S: "URI", URI: PDFString.of("https://example.test/decorator") } })));
  const bytes = Buffer.from(await layer.save());
  data.project.nodes = data.project.nodes.filter(node => node.path !== main);
  data.project.nodes.push({ id: "native-main", type: "file", name: main, path: main, content: family === "latex"
    ? "\\documentclass{article}\n\\begin{document}\n\\ifdefined\\irisAdjustment\\irisAdjustment\\fi Decorated source.\n\\newpage\nExcluded source.\n\\end{document}\n"
    : '\\version "2.26.0"\n\\paper { page-count = 2 }\n\\score { \\new Staff { \\override NoteHead.extra-offset = #(cons (if (defined? \'iris-layout-offset) iris-layout-offset 0) 0)\nc\'1 d\'1 \\pageBreak e\'1 f\'1\n} }\n' });
  if (twoPass) {
    data.project.nodes.push({ id: "module-decorator", type: "file", name: "decorate.lua", path: "decorate.lua",
      content: await fs.readFile(path.join(__dirname, "fixtures/pipelines/decorate.lua"), "utf8") });
    const final = family === "latex" ? "final.tex" : "final.ly";
    data.project.nodes.push({ id: "final-main", type: "file", name: final, path: final, content: family === "latex"
      ? "\\input{generated/adjust.tex}\n\\input{main.tex}\n" : '\\include "generated/adjust.ily"\n\\include "main.ly"\n' });
  }
  data.project.nodes.push({ id: "layer", type: "file", name: "layer.pdf", path: "layer.pdf", binary: true, data: `data:application/pdf;base64,${bytes.toString("base64")}` });
  data.projectType = family; data.sourceMapping = true;
  assert.equal((await f.request(f.base, { method: "PUT", body: { baseRevision: data.revision, data } })).status, 200);
  const descriptor = await inspect(f), parameters = { family, clearance: 4, offsetX: 3, offsetY: 2, excludedPages: [2] };
  if (twoPass) parameters.broken = mode === "broken-include";
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202, await response.clone().text());
  const run = await terminalRun(f, (await response.json()).run.id);
  if (mode === "broken-include") {
    assert.equal(run.state, "failed", JSON.stringify(run));
    const diagnostic = run.steps.find(step => step.id === "compile").diagnostics.find(item => item.generatedSource?.producerStep === "adjust");
    assert.ok(diagnostic, JSON.stringify(run.steps));
    assert.equal(diagnostic.sourceFileId, undefined); assert.equal(diagnostic.line, 1);
    assert.equal(run.artifactCount, 0);
    return;
  }
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  assert.deepEqual(new Set(run.steps.filter(step => step.adapter.id === `iris.${family}`).map(step => step.id)), new Set(twoPass ? ["measure", "compile"] : ["compile"]));
  assert.equal(run.steps.length, twoPass ? 6 : 4);
  if (twoPass) {
    const step = id => run.steps.find(item => item.id === id);
    for (const [before, after] of [["measure", "adjust"], ["adjust", "compile"], ["compile", "decorate"], ["decorate", "compose"]]) {
      assert.ok(Date.parse(step(before).completedAt) <= Date.parse(step(after).startedAt));
    }
  }
  const build = await (await f.request(`${f.base}/builds/${run.id}`)).json();
  const artifact = step => build.artifacts.find(item => item.producerStep === step);
  const composed = artifact("compose"), base = build.artifacts.find(item => item.producerStep === "compile" && item.outputPort === "output");
  assert.deepEqual(run.primaryPreview, { step: "compose", port: "output" });
  assert.deepEqual(build.build.primaryPreview, run.primaryPreview);
  assert.equal(build.primaryPreviewArtifactId, composed.id);
  const download = await f.request(composed.url), pdfBytes = Buffer.from(await download.arrayBuffer());
  assert.match(download.headers.get("content-disposition"), /^inline;/);
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  const output = await PDFDocument.load(pdfBytes), annotations = output.getPage(0).node.Annots();
  const baseBytes = Buffer.from(await (await f.request(base.url)).arrayBuffer()), original = await PDFDocument.load(baseBytes);
  assert.equal(output.getPageCount(), 2); assert.equal(annotations.size(), (original.getPage(0).node.Annots()?.size() || 0) + 1);
  assert.equal(annotations.lookup(annotations.size() - 1).lookup(PDFName.of("A")).lookup(PDFName.of("URI")).decodeText(), "https://example.test/decorator");
  const placementResponse = await f.request(artifact("decorate").url), placements = await placementResponse.json();
  assert.match(placementResponse.headers.get("content-disposition"), /^attachment;/);
  const layout = await (await f.request(build.artifacts.find(item => item.name === "layout.json").url)).json();
  if (twoPass) {
    const initial = await (await f.request(build.artifacts.find(item => item.name === "initial-layout.json").url)).json();
    assert.notEqual(initial.artifact.id, layout.artifact.id); assert.notEqual(initial.artifact.contentHash, layout.artifact.contentHash);
    assert.notDeepEqual(initial.pages[0].occupied, layout.pages[0].occupied, "the second pass must change measured ink");
    const b = initial.pages[0].occupied[0].bounds, offset = Math.min(12, Math.max(1, Math.ceil((b[2] - b[0]) / 10)));
    const generated = await (await f.request(artifact("adjust").url)).text();
    assert.equal(generated, family === "latex" ? `\\def\\irisAdjustment{\\hspace*{${offset}bp}}\n` : `#(define iris-layout-offset ${offset})\n`);
  }
  assert.equal(placements.base.id, base.id); assert.equal(placements.base.contentHash, base.contentHash);
  assert.equal(layout.artifact.id, base.id); assert.equal(placements.layers.length, 1);
  const placed = placements.layers[0]; assert.equal(placed.page, 1);
  const occupied = layout.pages[0].occupied;
  assert.ok(occupied.some(({ bounds: b }) => Math.abs(placed.x - (b[2] + 7)) < 1e-7 && Math.abs(placed.y - (b[1] + 2)) < 1e-7), "author offsets follow an actual ink boundary");
  for (const { bounds: b } of occupied) assert.ok(placed.x >= b[2] + 4 || placed.x + 10 <= b[0] - 4 || placed.y >= b[3] + 4 || placed.y + 10 <= b[1] - 4);
  const rasterRoot = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "iris-decorated-http-"));
  t.after(() => fs.rm(rasterRoot, { recursive: true, force: true }));
  const { redPixels } = require("./helpers/pdf-raster.cjs");
  const raster = async (label, bytes) => {
    const file = path.join(rasterRoot, `${label}.pdf`); await fs.writeFile(file, bytes);
    return redPixels(file, rasterRoot, label, "rgb");
  };
  const [before, after] = await Promise.all([raster("base", baseBytes), raster("decorated", pdfBytes)]);
  const index = 3 * (Math.floor(placed.y + 5) * after[0].width + Math.floor(placed.x + 5));
  assert.deepEqual([...after[0].pixels.subarray(index, index + 3)], [255, 0, 0]);
  assert.ok(after[1].pixels.equals(before[1].pixels), "excluded page keeps its rendered content");
  const sourceId = (await f.pool.query("SELECT id FROM project_files WHERE project_id=$1 AND path=$2 AND deleted_at IS NULL", [f.id, main])).rows[0].id;
  const navigation = await f.request(`${f.base}/builds/${run.id}/navigation`, { method: "POST", body: { direction: "forward", sourceFileId: sourceId, line: family === "latex" ? 3 : 4, column: 0 } });
  const forward = await navigation.json(); assert.equal(forward.status, "ready", JSON.stringify(forward));
  assert.deepEqual(new Set(forward.matches.map(item => item.artifactId)), new Set([base.id, composed.id]));
  const selected = forward.matches.find(item => item.artifactId === composed.id);
  const inverse = await (await f.request(`${f.base}/builds/${run.id}/navigation`, { method: "POST", body: { direction: "inverse", artifactId: composed.id,
    page: selected.page, x: selected.x, y: selected.y } })).json();
  assert.equal(inverse.status, "ready", JSON.stringify(inverse));
  assert.ok(inverse.matches.some(item => item.sourceFileId === sourceId));
  assert.ok(build.artifacts.every(item => !/relation|source-map|synctex/.test(item.name)));
});

for (const [family, cleanupFailure] of [["latex", false], ["lilypond", false], ["latex", "compiler"], ["lilypond", "compiler"], ["latex", "navigation"]]) test(`HTTP ${family} pipeline ${cleanupFailure ? `retains ${cleanupFailure} cleanup evidence` : "compiles generated source and retains artifact-bound navigation"}`, {
  ...nativeLua, timeout: 45000, skip: nativeLua.skip || process.env.IRIS_TEST_COMPILERS !== "1",
}, async t => {
  const source = (await fs.readFile(path.join(__dirname, "fixtures/pipelines/generate.lua"), "utf8")).replace("sourceMapping=false", "sourceMapping=true");
  const f = await fixture(t, source), data = f.project.data;
  const main = family === "latex" ? "main.tex" : "main.ly";
  data.project.nodes = data.project.nodes.filter(node => node.path !== main);
  data.project.nodes.push({ id: "native-main", type: "file", name: main, path: main,
    content: family === "latex" ? "\\documentclass{article}\n\\begin{document}\n\\input{generated/include.tex}\\newpage\nOriginal source.\n\\end{document}\n"
      : '\\version "2.26.0"\n\\include "generated/include.ily"\n\\score {\n  \\new Staff { \\generatedMusic c\'1 }\n}\n' });
  data.projectType = family; data.sourceMapping = true;
  const saved = await f.request(f.base, { method: "PUT", body: { baseRevision: data.revision, data } });
  assert.equal(saved.status, 200, await saved.clone().text());
  const descriptor = await inspect(f);
  if (cleanupFailure) {
    const root = path.join(await fs.realpath(f.dataDir), ".pipeline-runtime"), remove = fs.rm;
    t.mock.method(fs, "rm", async (file, ...args) => {
      if (path.dirname(file) === root && JSON.parse(await fs.readFile(`${file}.json`, "utf8")).stepId === (cleanupFailure === "compiler" ? "compile" : "navigation")) {
        throw Object.assign(new Error("Controlled native cleanup failure"), { code: "EACCES" });
      }
      return remove(file, ...args);
    });
  }
  const response = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: { family }, descriptorHash: descriptor.descriptorHash } });
  assert.equal(response.status, 202);
  const accepted = (await response.json()).run;
  if (cleanupFailure === "compiler") {
    await until(() => f.app.runtimeSettled(), "compiler cleanup failure", 10000);
    assert.equal((await (await f.request(`${f.base}/runs/${accepted.id}`)).json()).run.state, "running");
    assert.ok(f.app.healthPayload().pendingWrites > 0);
    assert.equal((await fs.readdir(path.join(f.dataDir, ".pipeline-staging"))).length, 1);
    return;
  }
  const run = await terminalRun(f, accepted.id);
  assert.equal(run.state, "succeeded", JSON.stringify(run));
  const build = await (await f.request(`${f.base}/builds/${run.id}`)).json();
  const pdf = build.artifacts.find(artifact => artifact.mimeType === "application/pdf");
  assert.ok(pdf);
  const download = await f.request(pdf.url);
  assert.match(download.headers.get("content-disposition"), /^inline;/);
  assert.match(Buffer.from(await download.arrayBuffer()).subarray(0, 8).toString(), /^%PDF-/);
  const sourceId = (await f.pool.query("SELECT id FROM project_files WHERE project_id=$1 AND path=$2 AND deleted_at IS NULL", [f.id, main])).rows[0].id;
  const navigation = await f.request(`${f.base}/builds/${run.id}/navigation`, { method: "POST", body: { direction: "forward", sourceFileId: sourceId, line: 4, column: 2 } });
  if (cleanupFailure === "navigation") {
    assert.equal(navigation.status, 503, await navigation.clone().text());
    assert.equal((await navigation.json()).errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
    assert.ok(f.app.healthPayload().pendingWrites > 0);
    const retry = await f.request(`${f.base}/runs`, { method: "POST", body: { target: "main", parameters: { family }, descriptorHash: descriptor.descriptorHash } });
    assert.equal(retry.status, 503);
    assert.equal((await retry.json()).errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
    await f.app.startGracefulShutdown("SIGTERM", f.server);
    assert.deepEqual(f.exits, [1]);
    return;
  }
  assert.equal(navigation.status, 200);
  const result = await navigation.json();
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.ok(result.matches.some(match => match.artifactId === pdf.id && match.sourceFileId === sourceId));
  const match = result.matches.find(match => match.artifactId === pdf.id && match.sourceFileId === sourceId);
  const inverse = await f.request(`${f.base}/builds/${run.id}/navigation`, { method: "POST", body: { direction: "inverse", artifactId: pdf.id,
    page: match.page, x: match.x + match.width / 2, y: match.y + match.height / 2 } });
  const back = await inverse.json();
  assert.equal(back.status, "ready", JSON.stringify(back));
  assert.ok(back.matches.some(item => item.artifactId === pdf.id && item.sourceFileId === sourceId));
});
