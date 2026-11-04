const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture } = require("./helpers/server-fixture.cjs");

const {
  RETENTION_BOUNDS,
  RETENTION_FIELDS,
  AUDIT_RETENTION_FLOOR_DAYS,
  retentionCaps,
  auditRetentionDays,
  clampRetention,
  normalizeRetentionInput,
  retentionView,
  cutoffDate,
} = require("../src/retention");

const caps = retentionCaps({});

async function storedBuilds(t) {
  const f = await serverFixture(t), projectId = uuidv7(), fileId = uuidv7();
  const storageDir = path.join(f.dataDir, "projects", projectId), hash = "a".repeat(64);
  await fs.mkdir(storageDir, { recursive: true });
  await f.pool.query("INSERT INTO projects (id,name,storage_path) VALUES ($1,'Retention',$2)", [projectId, `projects/${projectId}`]);
  await f.pool.query("INSERT INTO project_files (id,project_id,path) VALUES ($1,$2,'main.tex')", [fileId, projectId]);
  async function add(status, ageMs) {
    const id = uuidv7(), createdAt = new Date(Date.now() - ageMs), succeeded = status === "succeeded";
    await f.pool.query(`INSERT INTO build_outputs (id,project_id,source_file_id,source_content_hash,created_by_label,created_at,
      status,completed_at,project_type,compiler,format,main_path,display_name,storage_path,size,content_hash,artifact_count)
      VALUES ($1,$2,$3,$4,'Owner',$5,$6,$7,'latex','pdflatex','pdf','main.tex','main.pdf',$8,$9,$10,$11)`,
    [id, projectId, fileId, hash, createdAt, status, status === "running" ? null : createdAt,
      succeeded ? `output/${id}` : null, succeeded ? 3 : 0, succeeded ? hash : null, succeeded ? 1 : 0]);
    if (succeeded) {
      await fs.mkdir(path.join(storageDir, "output", id), { recursive: true });
      await fs.writeFile(path.join(storageDir, "output", id, "main.pdf"), "pdf");
      await f.pool.query(`INSERT INTO build_artifacts (id,build_id,name,storage_path,mime_type,size,content_hash)
        VALUES ($1,$2,'main.pdf',$3,'application/pdf',3,$4)`, [uuidv7(), id, `output/${id}/main.pdf`, hash]);
    }
    return id;
  }
  return { ...f, projectId, fileId, storageDir, hash, add };
}

test("retention preserves recent history, the last compiler success and active compiler rows", { skip: !connectionString }, async t => {
  const f = await storedBuilds(t), day = 86400000;
  const oldSuccess = await f.add("succeeded", 92 * day), latestSuccess = await f.add("succeeded", 91 * day);
  await f.add("failed", 90 * day);
  const running = await f.add("running", 90 * day), recent = await f.add("failed", 1000);
  const versions = [];
  for (let i = 0; i < 12; i++) {
    const id = uuidv7(); versions.push(id);
    await f.pool.query(`INSERT INTO document_versions (id,file_id,author_label,reason,content_hash,content,size,created_at)
      VALUES ($1,$2,'Owner','manual',$3,$4,1,$5)`, [id, f.fileId, f.hash, String(i), new Date(Date.now() - (100 - i) * day)]);
  }
  assert.equal(await f.app.pruneProjectVersions(f.projectId, { versionKeep: 10, versionDays: 7 }, Date.now()), 2);
  assert.deepEqual((await f.pool.query("SELECT id FROM document_versions ORDER BY created_at")).rows.map(row => row.id), versions.slice(2));
  assert.equal(await f.app.pruneProjectBuilds(f.projectId, f.storageDir, { buildKeep: 0, buildDays: 1 }, Date.now()), 2);
  assert.deepEqual(new Set((await f.pool.query("SELECT id FROM build_outputs")).rows.map(row => row.id)), new Set([latestSuccess, running, recent]));
  await assert.rejects(fs.stat(path.join(f.storageDir, "output", oldSuccess)), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.storageDir, "output", latestSuccess, "main.pdf"), "utf8"), "pdf");
});

test("compiler reconciliation closes only running builds beyond its grace period", { skip: !connectionString }, async t => {
  const f = await storedBuilds(t);
  const old = await f.add("running", 86400000), recent = await f.add("running", 1000), succeeded = await f.add("succeeded", 86400000);
  assert.equal(await f.app.reconcileStalledBuilds(), 1);
  const rows = new Map((await f.pool.query("SELECT id,status,completed_at,errors FROM build_outputs")).rows.map(row => [row.id, row]));
  assert.equal(rows.get(old).status, "failed");
  assert.ok(rows.get(old).completed_at instanceof Date);
  assert.equal(rows.get(old).errors[0].severity, "error");
  assert.equal(rows.get(recent).status, "running");
  assert.equal(rows.get(recent).completed_at, null);
  assert.equal(rows.get(succeeded).status, "succeeded");
});

test("an unconfigured project follows the instance default on every axis", () => {
  const resolved = clampRetention({}, caps);
  assert.deepEqual(resolved, {
    buildKeep: 20,
    buildDays: 30,
    versionKeep: 100,
    versionDays: 180,
  });
  // Null is the stored form of "no opinion", and means the same thing.
  assert.deepEqual(clampRetention({ buildKeep: null, buildDays: null, versionKeep: null, versionDays: null }, caps), resolved);
  assert.deepEqual(clampRetention(null, caps), resolved);
});

test("the operator's ceiling wins over the project's choice", () => {
  const strict = retentionCaps({ RETENTION_BUILD_KEEP_MAX: "10", RETENTION_VERSION_DAYS_MAX: "30" });
  const resolved = clampRetention({ buildKeep: 200, versionDays: 1000 }, strict);
  assert.equal(resolved.buildKeep, 10, "a project cannot keep more than the instance permits");
  assert.equal(resolved.versionDays, 30);
});

test("clamping happens on read, so lowering the ceiling takes effect immediately", () => {
  // A value stored while a generous ceiling was in force.
  const stored = { buildKeep: 150 };
  assert.equal(clampRetention(stored, caps).buildKeep, 150);
  // The operator lowers it; the same stored row now resolves to the new limit
  // without anything having to rewrite it.
  const lowered = retentionCaps({ RETENTION_BUILD_KEEP_MAX: "25" });
  assert.equal(clampRetention(stored, lowered).buildKeep, 25);
});

test("the floor stops retention from being turned into a shredder", () => {
  const resolved = clampRetention({ buildKeep: 0, versionKeep: 1, buildDays: 0, versionDays: 0 }, caps);
  assert.equal(resolved.buildKeep, RETENTION_BOUNDS.buildKeep.min);
  assert.equal(resolved.versionKeep, RETENTION_BOUNDS.versionKeep.min);
  assert.equal(resolved.buildDays, RETENTION_BOUNDS.buildDays.min);
  assert.equal(resolved.versionDays, RETENTION_BOUNDS.versionDays.min);
  for (const field of RETENTION_FIELDS) assert.ok(resolved[field] > 0);
});

test("a mistyped environment variable degrades to a working configuration", () => {
  // A ceiling below the floor would leave no satisfiable value at all.
  const broken = retentionCaps({ RETENTION_VERSION_KEEP_MAX: "1" });
  assert.equal(broken.versionKeep.max, RETENTION_BOUNDS.versionKeep.min);
  assert.ok(broken.versionKeep.fallback <= broken.versionKeep.max);
  // A default above the ceiling is pulled back under it.
  const inverted = retentionCaps({ RETENTION_BUILD_KEEP: "500", RETENTION_BUILD_KEEP_MAX: "40" });
  assert.equal(inverted.buildKeep.fallback, 40);
  // Nonsense is ignored rather than propagated.
  const garbage = retentionCaps({ RETENTION_BUILD_DAYS: "soon" });
  assert.equal(garbage.buildDays.fallback, RETENTION_BOUNDS.buildDays.fallback);
});

test("submitted settings are clamped, not rejected, and silence leaves a field alone", () => {
  const input = normalizeRetentionInput({ buildKeep: 9999, versionDays: 2 }, caps);
  assert.equal(input.buildKeep, caps.buildKeep.max);
  assert.equal(input.versionDays, caps.versionDays.min);
  // A field nobody mentioned must not be written, or a UI that sends a partial
  // form would silently reset the rest.
  assert.ok(!("buildDays" in input));
  assert.ok(!("versionKeep" in input));
  // An explicit null is a real choice: go back to following the default.
  assert.deepEqual(normalizeRetentionInput({ buildKeep: null }, caps), { buildKeep: null });
  // Anything that is not a settings object changes nothing.
  assert.deepEqual(normalizeRetentionInput(null, caps), {});
  assert.deepEqual(normalizeRetentionInput([1, 2], caps), {});
  assert.deepEqual(normalizeRetentionInput({ buildKeep: "not a number" }, caps), {});
});

test("the view carries the bounds, so the client never hard-codes a server limit", () => {
  const view = retentionView({ buildKeep: 40 }, caps);
  assert.deepEqual(view.buildKeep, {
    value: 40,
    effective: 40,
    min: caps.buildKeep.min,
    max: caps.buildKeep.max,
    default: caps.buildKeep.fallback,
  });
  // A field with no stored choice reports the default as what is in force.
  assert.equal(view.versionKeep.value, null);
  assert.equal(view.versionKeep.effective, caps.versionKeep.fallback);
  for (const field of RETENTION_FIELDS) {
    assert.ok(view[field].min <= view[field].max);
    assert.ok(view[field].effective >= view[field].min && view[field].effective <= view[field].max);
  }
});

test("audit retention belongs to the operator and has a floor no project can lower", () => {
  assert.equal(auditRetentionDays({}), 365);
  assert.equal(auditRetentionDays({ RETENTION_AUDIT_DAYS: "730" }), 730);
  // A trail short enough to have forgotten the incident is not a trail.
  assert.equal(auditRetentionDays({ RETENTION_AUDIT_DAYS: "1" }), AUDIT_RETENTION_FLOOR_DAYS);
  assert.equal(auditRetentionDays({ RETENTION_AUDIT_DAYS: "0" }), AUDIT_RETENTION_FLOOR_DAYS);
  // Audit retention is deliberately not one of the per-project fields.
  assert.ok(!RETENTION_FIELDS.includes("auditDays"));
});

test("the age cutoff is the instant the window opens", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const cutoff = cutoffDate(30, now);
  assert.equal(cutoff.getTime(), now - 30 * 24 * 60 * 60 * 1000);
  assert.ok(cutoff instanceof Date, "the value is passed straight to a timestamptz parameter");
});
