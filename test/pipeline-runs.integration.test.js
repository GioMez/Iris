const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const WebSocket = require("ws");
const { initializeSchema } = require("../src/database");
const { uuidv7 } = require("../src/ids");
const { createProjectMutations } = require("../src/project-mutations");
const { publishCompileOutput } = require("../src/builds");
const { validatePlan } = require("../src/pipeline/contracts");
const { createRegistry } = require("../src/pipeline/registry");
const { connectionString, isolatedSchema } = require("./helpers/isolated-schema.cjs");
const { deferred, serverFixture } = require("./helpers/server-fixture.cjs");
const runs = require("../src/pipeline/runs");

const options = { skip: !connectionString, timeout: 15000 };
const hash = "a".repeat(64), otherHash = "b".repeat(64);
const requestError = (errorCode, statusCode) => Object.assign(new Error(errorCode), { errorCode, statusCode });

async function fixture(t, server = false) {
  const http = server ? await serverFixture(t, { RETENTION_ENABLED: "false" }) : null;
  const pool = http?.pool || await isolatedSchema(t);
  if (!http) await initializeSchema(pool);
  const root = http?.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), "iris-run-test-"));
  if (!http) t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectId = uuidv7(), coordinatorId = uuidv7();
  const principals = {}, cookies = {};
  for (const role of ["owner", "editor", "viewer", "outsider"]) {
    const id = uuidv7(); principals[role] = { sub: id };
    const inserted = await pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,$2,$3,$2) RETURNING *", [id, role, `${role}@example.invalid`]);
    if (http) cookies[role] = http.cookieFor(inserted.rows[0]);
  }
  await pool.query("INSERT INTO projects (id,name,storage_path,revision) VALUES ($1,'Pipeline',$2,7)", [projectId, `projects/${projectId}`]);
  for (const role of ["owner", "editor", "viewer"]) {
    await pool.query("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)", [projectId, principals[role].sub, role]);
  }
  const events = [], stopped = [];
  const store = {
    pool, requestError, policyHash: hash, registryHash: hash,
    mutations: http?.app.projectMutations || createProjectMutations({ fs, getDb: () => pool, backupRoot: path.join(root, "backups"), requestError }),
    emit: async event => { events.push(event); },
    stop: async id => { stopped.push(id); },
  };
  const identity = { bundleHash: hash, policyHash: hash, registryHash: hash };
  const approve = () => runs.approveBundle(store, projectId, principals.owner, identity);
  const accept = (approval, extra = {}) => runs.createRun(store, {
    id: uuidv7(), projectId, principal: principals.editor, approvalId: approval.id,
    ...identity, snapshotHash: hash, saveRevision: 7, target: "check", parameters: {},
    coordinatorId, deadlineAt: new Date(Date.now() + 60000), ...extra,
  });
  return { ...http, pool, root, store, events, stopped, projectId, coordinatorId, principals, cookies, identity, approve, accept };
}
function validationPlan(withOutput = false) {
  const kind = withOutput === "collection" ? "collection" : "file";
  const registry = createRegistry([{ id: "check", version: "1.0.0", implementationHash: hash,
    inputs: {}, outputs: withOutput ? { report: { kinds: [kind], mediaTypes: ["text/plain"], required: true } } : {},
    optionsSchema: { type: "object" }, execute: async () => {}, capabilities: [] }]);
  return validatePlan({ apiVersion: 1, pluginId: "fixture", steps: [{ id: "validate", adapter: { id: "check", version: "1.0.0" },
    outputs: withOutput ? { report: { kind, mediaType: "text/plain", path: "report.txt" } } : {} }],
    targets: { check: { steps: ["validate"], publish: withOutput ? [{ step: "validate", port: "report" }] : [] } } }, { registry });
}
async function ready(f, run, plan = validationPlan()) {
  await runs.transitionRun(f.store, run.id, "queued", "planning");
  await runs.transitionRun(f.store, run.id, "planning", "running", { plan });
  await runs.transitionStep(f.store, run.id, "validate", "pending", "running");
  await runs.transitionStep(f.store, run.id, "validate", "running", "succeeded");
}

test("only owners approve exact bundles; rejected identity or authority leaves no durable run", options, async t => {
  const f = await fixture(t);
  for (const role of ["editor", "viewer", "outsider"]) {
    await assert.rejects(runs.approveBundle(f.store, f.projectId, f.principals[role], f.identity), { statusCode: role === "outsider" ? 404 : 403 });
  }
  const approval = await f.approve();
  for (const field of ["bundleHash", "policyHash", "registryHash"]) {
    await assert.rejects(f.accept(approval, { [field]: otherHash }), { errorCode: "PIPELINE_APPROVAL_REQUIRED" });
  }
  for (const role of ["viewer", "outsider"]) await assert.rejects(f.accept(approval, { principal: f.principals[role] }), { statusCode: role === "viewer" ? 403 : 404 });
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM build_outputs")).rows[0].n, 0);
  assert.equal(f.events.length, 0);
});

test("accepted run identities and parameters remain detached and server request order survives completion order", options, async t => {
  const f = await fixture(t), approval = await f.approve();
  const parameters = { clearance: 4 };
  const first = await f.accept(approval, { parameters }), second = await f.accept(approval, { target: "export" });
  parameters.clearance = 90;
  assert.equal(first.state, "queued");
  assert.ok(BigInt(second.requestOrder) > BigInt(first.requestOrder));
  assert.deepEqual((await runs.getRun(f.store, first.id, f.principals.viewer)).parameters, { clearance: 4 });
  assert.equal(first.saveRevision, 7);
  assert.equal(first.snapshotHash, hash);
  await runs.cancelRun(f.store, second.id, f.principals.owner);
  assert.equal((await runs.getRun(f.store, first.id, f.principals.viewer)).state, "queued");
  assert.deepEqual(f.events.filter(e => e.runId === second.id).map(e => e.sequence), ["1", "2"]);
  assert.equal(JSON.stringify(f.events).includes("clearance"), false, "notifications carry identity/status, not parameter contents");
});

test("validation-only success persists step outcomes and requires a completed plan", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  await assert.rejects(runs.transitionRun(f.store, run.id, "queued", "succeeded"), { errorCode: "PIPELINE_TRANSITION_INVALID" });
  await runs.transitionRun(f.store, run.id, "queued", "planning");
  await assert.rejects(runs.transitionRun(f.store, run.id, "planning", "running"), { errorCode: "PIPELINE_PLAN_INVALID" });
  await runs.transitionRun(f.store, run.id, "planning", "running", { plan: validationPlan() });
  await assert.rejects(runs.publishRun(f.store, run.id, []), { errorCode: "PIPELINE_STEPS_INCOMPLETE" });
  await runs.transitionStep(f.store, run.id, "validate", "pending", "running");
  await runs.transitionStep(f.store, run.id, "validate", "running", "succeeded");
  const result = await runs.publishRun(f.store, run.id, []);
  assert.equal(result.state, "succeeded");
  assert.equal(result.artifactCount, 0);
  assert.equal(result.storagePath, null);
  assert.deepEqual(result.steps.map(s => [s.id, s.state]), [["validate", "succeeded"]]);
  assert.equal(result.planHash, validationPlan().planHash);
  assert.equal((await f.pool.query("SELECT publication_state FROM build_outputs WHERE id=$1", [run.id])).rows[0].publication_state, "committed");
});

test("editors cancel only their own runs; owners cancel any; terminal cancellation is idempotent", options, async t => {
  const f = await fixture(t), approval = await f.approve();
  const own = await f.accept(approval), owners = await f.accept(approval, { principal: f.principals.owner });
  for (const role of ["viewer", "outsider"]) await assert.rejects(runs.cancelRun(f.store, own.id, f.principals[role]), { statusCode: role === "viewer" ? 403 : 404 });
  await assert.rejects(runs.cancelRun(f.store, owners.id, f.principals.editor), { statusCode: 403 });
  const first = await runs.cancelRun(f.store, own.id, f.principals.editor);
  const repeated = await runs.cancelRun(f.store, own.id, f.principals.editor);
  assert.equal(first.state, "cancelled");
  assert.equal(repeated.sequence, first.sequence);
  await runs.cancelRun(f.store, owners.id, f.principals.owner);
  assert.deepEqual(new Set(f.stopped), new Set([own.id, owners.id]));
  await assert.rejects(runs.getRun(f.store, own.id, f.principals.outsider), { statusCode: 404 });
  await assert.rejects(runs.getRun(f.store, own.id, f.principals.owner, uuidv7()), { statusCode: 404 });
});

test("publication and cancellation have one terminal winner and never reopen a finished run", options, async t => {
  const f = await fixture(t), approval = await f.approve();
  for (const cancelFirst of [true, false]) {
    const run = await f.accept(approval); await ready(f, run);
    const actions = [() => runs.cancelRun(f.store, run.id, f.principals.owner), () => runs.publishRun(f.store, run.id, [])];
    if (!cancelFirst) actions.reverse();
    const results = await Promise.all(actions.map(fn => fn()));
    const final = await runs.getRun(f.store, run.id, f.principals.viewer);
    assert.ok(["succeeded", "cancelled"].includes(final.state));
    assert.equal(results.at(-1).state, final.state);
    const terminalEvents = f.events.filter(e => e.runId === run.id && ["succeeded", "cancelled"].includes(e.state));
    assert.equal(terminalEvents.length, 1);
    assert.equal((await runs.transitionRun(f.store, run.id, "running", "failed", { reason: "late-failure" })).state, final.state);
  }
});

test("revoked approval, lost compile authority and operator policy changes prevent publication", options, async t => {
  for (const change of ["approval", "membership", "account", "policy", "registry"]) {
    const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
    await ready(f, run);
    if (change === "approval") await runs.revokeApproval(f.store, f.projectId, approval.id, f.principals.owner);
    if (change === "membership") await f.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [f.projectId, f.principals.editor.sub]);
    if (change === "account") await f.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [f.principals.editor.sub]);
    if (change === "policy") f.store.policyHash = otherHash;
    if (change === "registry") f.store.registryHash = otherHash;
    const result = await runs.publishRun(f.store, run.id, []);
    assert.equal(result.state, "cancelled", change);
    assert.ok(result.reason);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM build_artifacts")).rows[0].n, 0);
    assert.ok(f.stopped.includes(run.id));
  }
});

test("reapproval of changed source preserves an already accepted immutable approved run", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  await ready(f, run);
  await runs.approveBundle(f.store, f.projectId, f.principals.owner, { ...f.identity, bundleHash: otherHash });
  assert.equal((await runs.publishRun(f.store, run.id, [])).state, "succeeded");
  await assert.rejects(f.accept(approval), { errorCode: "PIPELINE_APPROVAL_REQUIRED" });
});

test("restart reconciliation interrupts abandoned owners but preserves live and uncertain publication work", options, async t => {
  const f = await fixture(t), approval = await f.approve();
  const abandoned = await f.accept(approval), liveOwner = uuidv7(), live = await f.accept(approval, { coordinatorId: liveOwner });
  const uncertain = await f.accept(approval);
  await ready(f, uncertain);
  await f.pool.query("UPDATE build_outputs SET publication_state='prepared',publication_hash=$2,publication_path='output/'||id::text WHERE id=$1", [uncertain.id, hash]);
  f.store.inspectPublication = async () => ({ state: "unavailable" });
  const result = await runs.reconcileRuns(f.store, new Set([liveOwner]));
  assert.ok(result.interrupted.includes(abandoned.id));
  assert.ok(result.unresolved.includes(uncertain.id));
  assert.equal((await runs.getRun(f.store, abandoned.id, f.principals.owner)).state, "interrupted");
  assert.equal((await runs.getRun(f.store, live.id, f.principals.owner)).state, "queued");
  assert.equal((await runs.getRun(f.store, uncertain.id, f.principals.owner)).state, "running");
  f.store.inspectPublication = async () => ({ state: "matching" });
  await runs.reconcileRuns(f.store, new Set([liveOwner]));
  assert.equal((await runs.getRun(f.store, uncertain.id, f.principals.owner)).state, "interrupted", "directory existence cannot establish a successful commit");
  assert.equal((await f.pool.query("SELECT publication_state FROM build_outputs WHERE id=$1", [uncertain.id])).rows[0].publication_state, "prepared", "retain recovery intent");
});

test("HTTP resync records reflect mutations that finished while the reader waited at the project gate", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  const entered = deferred(), release = deferred(), queued = deferred();
  t.after(() => release.resolve());
  const gate = f.store.mutations.gate;
  const writing = gate(f.projectId, async () => {
    entered.resolve(); await release.promise;
    await f.pool.query("UPDATE build_outputs SET status='failed',terminal_reason='fixture-failure',completed_at=CURRENT_TIMESTAMP,event_sequence=event_sequence+1 WHERE id=$1", [run.id]);
  });
  await entered.promise;
  f.store.mutations.gate = (...args) => { queued.resolve(); return gate(...args); };
  const reading = runs.getRun(f.store, run.id, f.principals.viewer);
  await queued.promise;
  release.resolve(); await writing;
  const result = await reading;
  assert.equal(result.state, "failed");
  assert.equal(result.sequence, "2");
});

async function output(f, run, text) {
  const staging = path.join(f.root, "staging", run.id);
  const project = path.join(f.root, "project");
  await fs.mkdir(staging, { recursive: true }); await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(staging, "report.txt"), text);
  f.store.publish = async row => publishCompileOutput(path.join(f.root, "staging", row.id), project, row.id);
  return [{ id: uuidv7(), name: "report.txt", storagePath: `output/${run.id}/report.txt`, logicalPath: "report.txt",
    producerStep: "validate", outputPort: "report", mimeType: "text/plain", size: Buffer.byteLength(text),
    contentHash: createHash("sha256").update(text).digest("hex") }];
}

test("a database failure after rename retains publication intent and the previous successful output", options, async t => {
  const f = await fixture(t), approval = await f.approve();
  const previous = await f.accept(approval); await ready(f, previous, validationPlan(true));
  await runs.publishRun(f.store, previous.id, await output(f, previous, "previous"));
  const run = await f.accept(approval); await ready(f, run, validationPlan(true));
  const artifacts = await output(f, run, "new output");
  const failing = { async connect() {
    const client = await f.pool.connect();
    return { async query(sql, args) {
      if (sql.startsWith("INSERT INTO build_artifacts")) await client.query("SELECT 1/0");
      return client.query(sql, args);
    }, release: error => client.release(error) };
  } };
  f.store.mutations = createProjectMutations({ fs, getDb: () => failing, backupRoot: path.join(f.root, "backups"), requestError });
  await assert.rejects(runs.publishRun(f.store, run.id, artifacts), { code: "22012" });
  assert.equal(await fs.readFile(path.join(f.root, "project", previous.storagePath || `output/${previous.id}`, "report.txt"), "utf8"), "previous");
  assert.equal(await fs.readFile(path.join(f.root, "project", `output/${run.id}`, "report.txt"), "utf8"), "new output");
  assert.deepEqual((await f.pool.query("SELECT status,publication_state,publication_path FROM build_outputs WHERE id=$1", [run.id])).rows[0],
    { status: "running", publication_state: "prepared", publication_path: `output/${run.id}` });
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM build_artifacts WHERE build_id=$1", [run.id])).rows[0].n, 0);
});

test("uncertain publication commit preserves the committed artifact and blocks mutation until reconciliation", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  await ready(f, run, validationPlan(true));
  const artifacts = await output(f, run, "committed output");
  const uncertain = { async connect() {
    const client = await f.pool.connect(); let publishing = false;
    return { async query(sql, args) {
      if (sql.startsWith("UPDATE build_outputs SET status='succeeded'")) publishing = true;
      const result = await client.query(sql, args);
      if (publishing && sql === "COMMIT") throw Object.assign(new Error("synthetic commit acknowledgement loss"), { code: "ECONNRESET" });
      return result;
    }, release: error => client.release(error) };
  } };
  f.store.mutations = createProjectMutations({ fs, getDb: () => uncertain, backupRoot: path.join(f.root, "backups"), requestError });
  await assert.rejects(runs.publishRun(f.store, run.id, artifacts), { errorCode: "PROJECT_RECOVERY_REQUIRED" });
  assert.equal((await f.pool.query("SELECT status FROM build_outputs WHERE id=$1", [run.id])).rows[0].status, "succeeded");
  assert.equal(await fs.readFile(path.join(f.root, "project", `output/${run.id}`, "report.txt"), "utf8"), "committed output");
  await assert.rejects(runs.cancelRun(f.store, run.id, f.principals.owner), { errorCode: "PROJECT_RECOVERY_REQUIRED" });
  assert.equal(f.events.some(e => e.runId === run.id && e.state === "succeeded"), false, "no success notification before confirmed commit");
});

test("run HTTP inspection and cancellation recheck project authority and route identity", options, async t => {
  const f = await fixture(t, true), approval = await f.approve(), run = await f.accept(approval);
  const route = `/api/projects/${f.projectId}/runs/${run.id}`;
  for (const role of ["owner", "editor", "viewer"]) {
    const response = await f.request(route, { cookie: f.cookies[role] });
    assert.equal(response.status, 200, role);
    assert.equal((await response.json()).run.state, "queued");
  }
  assert.equal((await f.request(route, { cookie: f.cookies.outsider })).status, 404);
  assert.equal((await f.request(`/api/projects/${uuidv7()}/runs/${run.id}`, { cookie: f.cookies.owner })).status, 404);
  assert.equal((await f.request(`${route}/cancel`, { cookie: f.cookies.viewer, method: "POST" })).status, 403);
  assert.equal((await f.request(`${route}/cancel`, { cookie: f.cookies.editor, method: "POST" })).status, 200);
  assert.equal((await (await f.request(route, { cookie: f.cookies.viewer })).json()).run.state, "cancelled");
  const other = await f.accept(approval);
  await f.pool.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [f.projectId, f.principals.editor.sub]);
  assert.equal((await f.request(`/api/projects/${f.projectId}/runs/${other.id}/cancel`, { cookie: f.cookies.editor, method: "POST" })).status, 404);
});

test("cached pipeline metadata needs only read access; revocation is owner-only and cancels accepted work", options, async t => {
  const f = await fixture(t, true), approval = await f.approve(), run = await f.accept(approval);
  await f.pool.query("UPDATE pipeline_approvals SET descriptor=$2::jsonb WHERE id=$1", [approval.id, JSON.stringify({ apiVersion: 1, pluginId: "fixture" })]);
  const route = `/api/projects/${f.projectId}/pipeline`;
  const response = await f.request(route, { cookie: f.cookies.viewer });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).pipeline.descriptor, { apiVersion: 1, pluginId: "fixture" });
  assert.equal((await f.request(`${route}/approval/${approval.id}`, { cookie: f.cookies.editor, method: "DELETE" })).status, 403);
  assert.equal((await f.request(`${route}/approval/${approval.id}`, { cookie: f.cookies.owner, method: "DELETE" })).status, 200);
  assert.equal((await runs.getRun(f.store, run.id, f.principals.owner)).state, "cancelled");
});

test("startup reconciliation runs with retention disabled and the compiler grace sweep cannot finish pipeline work", options, async t => {
  const f = await fixture(t, true), approval = await f.approve(), run = await f.accept(approval);
  await ready(f, run);
  await f.pool.query("UPDATE build_outputs SET created_at=CURRENT_TIMESTAMP-INTERVAL '1 day' WHERE id=$1", [run.id]);
  await f.app.reconcileStalledBuilds();
  assert.equal((await runs.getRun(f.store, run.id, f.principals.owner)).state, "running");
  f.app.startRetentionSweep();
  const deadline = Date.now() + 3000;
  while ((await runs.getRun(f.store, run.id, f.principals.owner)).state === "running") {
    assert.ok(Date.now() < deadline, "startup must reconcile even with retention disabled");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await runs.getRun(f.store, run.id, f.principals.owner)).state, "interrupted");
});

test("retention protects each target's newest accepted success, active states and prepared recovery evidence", options, async t => {
  const f = await fixture(t, true), approval = await f.approve();
  const first = await f.accept(approval), second = await f.accept(approval), other = await f.accept(approval, { target: "export" });
  for (const run of [first, second, other]) await f.pool.query(`UPDATE build_outputs SET status='succeeded',plan_hash=$2,
    publication_state='committed',publication_hash=$2,completed_at=CURRENT_TIMESTAMP WHERE id=$1`, [run.id, hash]);
  const queued = await f.accept(approval), planning = await f.accept(approval), uncertain = await f.accept(approval);
  await runs.transitionRun(f.store, planning.id, "queued", "planning");
  await f.pool.query("UPDATE build_outputs SET status='interrupted',terminal_reason='test',completed_at=CURRENT_TIMESTAMP,publication_state='prepared',publication_hash=$2,publication_path='output/'||id::text WHERE id=$1", [uncertain.id, hash]);
  await f.pool.query("UPDATE build_outputs SET created_at=CURRENT_TIMESTAMP-INTERVAL '90 days'");
  await f.pool.query("UPDATE build_outputs SET created_at=CURRENT_TIMESTAMP-INTERVAL '80 days' WHERE id=$1", [first.id]);
  const removed = await f.app.pruneProjectBuilds(f.projectId, path.join(f.root, "projects", f.projectId), { buildKeep: 0, buildDays: 1 }, Date.now());
  assert.equal(removed, 1);
  assert.deepEqual(new Set((await f.pool.query("SELECT id FROM build_outputs")).rows.map(r => r.id)), new Set([second.id,other.id,queued.id,planning.id,uncertain.id]));
});

test("manual build deletion cannot remove queued runs or unresolved publication evidence", options, async t => {
  const f = await fixture(t, true), approval = await f.approve();
  const queued = await f.accept(approval), uncertain = await f.accept(approval);
  await f.pool.query("UPDATE build_outputs SET status='interrupted',terminal_reason='test',completed_at=CURRENT_TIMESTAMP,publication_state='prepared',publication_hash=$2 WHERE id=$1", [uncertain.id, hash]);
  for (const run of [queued, uncertain]) {
    const response = await f.request(`/api/projects/${f.projectId}/builds/${run.id}`, { cookie: f.cookies.owner, method: "DELETE" });
    assert.equal(response.status, 409);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM build_outputs WHERE id=$1", [run.id])).rows[0].n, 1);
  }
});

test("queued acceptance cannot borrow later mutations of request identities or the principal", options, async t => {
  const f = await fixture(t), approval = await f.approve();
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const holding = f.store.mutations.gate(f.projectId, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const request = { id: uuidv7(), projectId: f.projectId, principal: { ...f.principals.editor }, approvalId: approval.id,
    ...f.identity, snapshotHash: hash, saveRevision: 7, target: "check", parameters: {}, coordinatorId: f.coordinatorId,
    deadlineAt: new Date(Date.now() + 60000) };
  const accepting = runs.createRun(f.store, request);
  request.snapshotHash = otherHash; request.saveRevision = 99; request.principal.sub = f.principals.viewer.sub;
  release.resolve(); await holding;
  const accepted = await accepting;
  assert.equal(accepted.snapshotHash, hash);
  assert.equal(accepted.saveRevision, 7);
  assert.equal(accepted.createdBy, f.principals.editor.sub);
});

test("a disabled account waiting at the read gate cannot obtain a run resync", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  const entered = deferred(), release = deferred(), queued = deferred();
  t.after(() => release.resolve());
  const gate = f.store.mutations.gate;
  const holding = gate(f.projectId, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  f.store.mutations.gate = (...args) => { queued.resolve(); return gate(...args); };
  const reading = runs.getRun(f.store, run.id, f.principals.viewer);
  await queued.promise;
  await f.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [f.principals.viewer.sub]);
  release.resolve(); await holding;
  await assert.rejects(reading, { statusCode: 404 });
});

test("cancellation retries a failed process drain without changing its terminal sequence", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  let running = true;
  f.store.stop = async () => { throw new Error("synthetic process drain failure"); };
  await assert.rejects(runs.cancelRun(f.store, run.id, f.principals.owner), /synthetic process drain failure/);
  const terminal = await runs.getRun(f.store, run.id, f.principals.owner);
  f.store.stop = async () => { running = false; };
  const retried = await runs.cancelRun(f.store, run.id, f.principals.owner);
  assert.equal(running, false);
  assert.equal(retried.sequence, terminal.sequence);
});

test("startup continues past recovery-blocked projects and reports their unresolved runs", options, async t => {
  const f = await fixture(t), approval = await f.approve(), blocked = await f.accept(approval);
  const otherProject = uuidv7();
  await f.pool.query("INSERT INTO projects (id,name,storage_path,revision) VALUES ($1,'Other',$2,7)", [otherProject, `projects/${otherProject}`]);
  for (const role of ["owner", "editor"]) await f.pool.query("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)", [otherProject, f.principals[role].sub, role]);
  const otherApproval = await runs.approveBundle(f.store, otherProject, f.principals.owner, f.identity);
  const other = await f.accept(otherApproval, { projectId: otherProject });
  await fs.mkdir(path.join(f.root, "backups", f.projectId), { recursive: true });
  const result = await runs.reconcileRuns(f.store, new Set());
  assert.deepEqual(result.unresolved, [blocked.id]);
  assert.deepEqual(result.interrupted, [other.id]);
  assert.equal((await runs.getRun(f.store, other.id, f.principals.owner)).state, "interrupted");
});

async function watch(t, f, role) {
  const ws = new WebSocket(`${f.baseUrl.replace("http:", "ws:")}/api/collab`, { headers: { cookie: f.cookies[role] } });
  const messages = [], waiters = new Map();
  ws.on("message", raw => {
    const message = JSON.parse(raw); messages.push(message);
    waiters.get(message.t)?.(message); waiters.delete(message.t);
  });
  const next = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${type} notification`)), 3000);
    waiters.set(type, message => { clearTimeout(timer); resolve(message); });
  });
  t.after(() => ws.terminate());
  await next("ready");
  const subscribed = next("filepeers");
  ws.send(JSON.stringify({ t: "project", projectId: f.projectId }));
  await subscribed;
  return { ws, messages, next };
}

test("run notices carry committed sequence identities and stop at revoked project membership", options, async t => {
  const f = await fixture(t, true), approval = await f.approve(), run = await f.accept(approval);
  const viewer = await watch(t, f, "viewer"), owner = await watch(t, f, "owner");
  const notice = viewer.next("run"), ownerNotice = owner.next("run");
  const response = await f.request(`/api/projects/${f.projectId}/runs/${run.id}/cancel`, { cookie: f.cookies.editor, method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await notice, { t: "run", projectId: f.projectId, runId: run.id, target: "check", requestOrder: run.requestOrder, sequence: "2", state: "cancelled" });
  await ownerNotice;
  const resync = await (await f.request(`/api/projects/${f.projectId}/runs/${run.id}`, { cookie: f.cookies.viewer })).json();
  assert.equal(resync.run.sequence, "2");
  const other = await f.accept(approval);
  await f.pool.query("DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", [f.projectId, f.principals.viewer.sub]);
  const nextOwnerNotice = owner.next("run");
  assert.equal((await f.request(`/api/projects/${f.projectId}/runs/${other.id}/cancel`, { cookie: f.cookies.owner, method: "POST" })).status, 200);
  assert.equal((await nextOwnerNotice).runId, other.id);
  assert.equal(viewer.messages.filter(message => message.t === "run").length, 1);
  assert.equal((await f.request(`/api/projects/${f.projectId}/runs/${other.id}`, { cookie: f.cookies.viewer })).status, 404);
});

test("membership removal waits for the publication winner before committing revocation", options, async t => {
  const f = await fixture(t, true), approval = await f.approve(), run = await f.accept(approval);
  await ready(f, run, validationPlan(true));
  const artifacts = await output(f, run, "published before revocation");
  const entered = deferred(), release = deferred();
  const publish = f.store.publish;
  f.store.publish = async (...args) => { entered.resolve(); await release.promise; return publish(...args); };
  t.after(() => release.resolve());
  const publishing = runs.publishRun(f.store, run.id, artifacts);
  await entered.promise;
  const removing = f.request(`/api/projects/${f.projectId}/members/${f.principals.editor.sub}`, { cookie: f.cookies.owner, method: "DELETE" });
  try {
    const deadline = Date.now() + 1500;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      waiting = (await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'")).rowCount > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "membership revocation must serialize with publication");
  } finally {
    release.resolve();
    await publishing; await removing;
  }
  assert.equal((await publishing).state, "succeeded");
  assert.equal((await removing).status, 200);
});

test("membership demotion cancels submitted runs before the HTTP mutation completes", options, async t => {
  const f = await fixture(t, true), approval = await f.approve(), run = await f.accept(approval);
  const ownersRun = await f.accept(approval, { principal: f.principals.owner });
  const response = await f.request(`/api/projects/${f.projectId}/members/${f.principals.editor.sub}`, {
    cookie: f.cookies.owner, method: "PATCH", body: { role: "viewer" },
  });
  assert.equal(response.status, 200);
  assert.equal((await runs.getRun(f.store, run.id, f.principals.owner)).state, "cancelled");
  assert.equal((await runs.getRun(f.store, ownersRun.id, f.principals.owner)).state, "queued");
});

test("account disablement cancels submitted runs before the administrator response", options, async t => {
  const f = await fixture(t, true), approval = await f.approve(), run = await f.accept(approval);
  await f.pool.query("UPDATE users SET system_role='admin' WHERE id=$1", [f.principals.owner.sub]);
  const response = await f.request(`/api/admin/users/${f.principals.editor.sub}`, {
    cookie: f.cookies.owner, method: "PATCH", body: { status: "disabled" },
  });
  assert.equal(response.status, 200);
  assert.equal((await runs.getRun(f.store, run.id, f.principals.owner)).state, "cancelled");
});

test("step diagnostics share a whole-run budget for bounded HTTP resync", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  const registry = createRegistry([{ id: "check", version: "1.0.0", implementationHash: hash,
    inputs: {}, outputs: {}, optionsSchema: { type: "object" }, execute: async () => {}, capabilities: [] }]);
  const plan = validatePlan({ apiVersion: 1, pluginId: "fixture", steps: ["first", "second"].map(id => ({ id, adapter: { id: "check", version: "1.0.0" } })),
    targets: { check: { steps: ["first", "second"], publish: [] } } }, { registry });
  await runs.transitionRun(f.store, run.id, "queued", "planning");
  await runs.transitionRun(f.store, run.id, "planning", "running", { plan });
  const diagnostics = Array.from({ length: 10 }, () => ({ message: "x".repeat(60000) }));
  await runs.transitionStep(f.store, run.id, "first", "pending", "running");
  await runs.transitionStep(f.store, run.id, "first", "running", "succeeded", { diagnostics });
  await runs.transitionStep(f.store, run.id, "second", "pending", "running");
  await assert.rejects(runs.transitionStep(f.store, run.id, "second", "running", "succeeded", { diagnostics }), { errorCode: "PIPELINE_DIAGNOSTICS_LIMIT" });
  const result = await runs.getRun(f.store, run.id, f.principals.owner);
  assert.equal(result.steps[1].state, "running");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1048576);
});

test("publication accepts 20000 artifact identities without applying the planner JSON budget", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  await ready(f, run, validationPlan("collection"));
  const artifacts = Array.from({ length: 20000 }, (_, i) => ({ id: uuidv7(), name: `${i}.txt`, storagePath: `output/${run.id}/${i}.txt`,
    logicalPath: `${i}.txt`, producerStep: "validate", outputPort: "report", mimeType: "text/plain", size: 0, contentHash: hash }));
  // Deliberately stop at the filesystem boundary. This checks metadata capacity
  // and durable intent, not validation or publication of 20000 physical files.
  f.store.publish = async () => { throw new Error("synthetic publication boundary"); };
  await assert.rejects(runs.publishRun(f.store, run.id, artifacts), /synthetic publication boundary/);
  assert.equal((await f.pool.query("SELECT publication_state FROM build_outputs WHERE id=$1", [run.id])).rows[0].publication_state, "prepared");
  artifacts.push({ ...artifacts[0], id: uuidv7() });
  await assert.rejects(runs.publishRun(f.store, run.id, artifacts), { errorCode: "PIPELINE_REQUEST_INVALID" });
});

test("invalid publication provenance and excess output bytes fail before filesystem publication", options, async t => {
  const f = await fixture(t), approval = await f.approve(), run = await f.accept(approval);
  await ready(f, run, validationPlan(true));
  const original = (await output(f, run, "report"))[0];
  let renamed = false;
  const publish = f.store.publish;
  f.store.publish = async (...args) => { renamed = true; return publish(...args); };
  for (const extra of [
    { name: "." }, { name: "x".repeat(256) }, { logicalPath: "bad\nname.txt" },
    { producerStep: "unknown" }, { size: 134217729 },
  ]) {
    await assert.rejects(runs.publishRun(f.store, run.id, [{ ...original, ...extra }]), { errorCode: "PIPELINE_REQUEST_INVALID" });
    assert.equal(renamed, false);
  }
  const excess = Array.from({ length: 5 }, (_, i) => ({ ...original, id: uuidv7(), name: `${i}.txt`, logicalPath: `${i}.txt`,
    storagePath: `output/${run.id}/${i}.txt`, size: 134217728 }));
  await assert.rejects(runs.publishRun(f.store, run.id, excess), { errorCode: "PIPELINE_REQUEST_INVALID" });
  assert.equal(renamed, false);
  assert.equal((await f.pool.query("SELECT publication_state FROM build_outputs WHERE id=$1", [run.id])).rows[0].publication_state, "none");
});
