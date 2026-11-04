const test = require("node:test");
const assert = require("node:assert/strict");

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { assertSupportedPostgresVersion, createDatabase, initializeSchema } = require("../src/database");
const { connectionString, isolatedSchema } = require("./helpers/isolated-schema.cjs");
const { uuidv7 } = require("../src/ids");

test("PostgreSQL 18 is the supported baseline and newer majors are allowed", () => {
  assert.equal(assertSupportedPostgresVersion("180004"), 18);
  // A newer major must not block startup: a routine upgrade stays non-breaking.
  assert.equal(assertSupportedPostgresVersion("190001"), 19);
  assert.equal(assertSupportedPostgresVersion("210000"), 21);
  // Older majors and unparseable values are refused.
  for (const unsupported of ["170006", "150010", "", null, "not-a-version", "-1"]) {
    assert.throws(
      () => assertSupportedPostgresVersion(unsupported),
      /PostgreSQL 18 or later is required/
    );
  }
});

test("createDatabase bootstraps with a restricted owner, reopens and refuses an incompatible version", { skip: !connectionString, timeout: 15000 }, async (t) => {
  const database = `iris_bootstrap_${crypto.randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const url = new URL(connectionString);
  const password = crypto.randomBytes(24).toString("hex");
  const options = { host: url.hostname, port: Number(url.port), user: database, password, database, connectTimeout: 3000 };
  let pool;
  t.after(async () => {
    try {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${database}`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE ROLE ${database} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${database}`);
  pool = await createDatabase(options);
  assert.deepEqual((await pool.query("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user")).rows, [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }]);
  assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version: 5 }]);
  await pool.query("INSERT INTO audit_events (action, actor_label, target_type) VALUES ('startup.test', 'operator', 'system')");
  await pool.end();
  pool = null;
  pool = await createDatabase(options);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_events")).rows[0].n, 1);
  await pool.query("UPDATE iris_schema SET version = 1");
  await pool.end();
  pool = null;
  await assert.rejects(createDatabase(options), { code: "IRIS_SCHEMA_INCOMPATIBLE" });
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [database])).rows[0].n, 0, "failed startup closes its pool");
});

const dbOptions = { skip: !connectionString, timeout: 20000 };
test("schema-4 upgrade preserves projects without inventing Lua edit times or owner preferences", dbOptions, async t => {
  const { pool, before, project } = await legacyFixture(t);
  for (const name of ["003-pipelines.sql", "004-primary-preview.sql"]) await pool.query(await fs.readFile(path.join(__dirname, "../db/migrations", name), "utf8"));
  await pool.query("UPDATE iris_schema SET version=4");
  await Promise.all([initializeSchema(pool), initializeSchema(pool)]);
  assert.equal((await pool.query("SELECT version FROM iris_schema")).rows[0].version, 5);
  await assertHistoricalRows(pool, before);
  assert.deepEqual((await pool.query("SELECT lua_sources_changed_at,lua_sources_hash,lua_sources_pending,lua_sources_author_id,lua_sources_approval_session FROM projects WHERE id=$1", [project])).rows[0], {
    lua_sources_changed_at: null, lua_sources_hash: null, lua_sources_pending: false, lua_sources_author_id: null, lua_sources_approval_session: null,
  });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pipeline_auto_approvals")).rows[0].n, 0);
});
const historicalTables = ["users", "projects", "project_members", "project_files", "document_versions", "build_outputs", "build_artifacts", "audit_events", "project_deletions"];
async function legacyFixture(t) {
  const pool = await isolatedSchema(t);
  await pool.query(await fs.readFile(path.join(__dirname, "fixtures/database/schema-2.sql"), "utf8"));
  const [user, project, file, revision, build, artifact] = Array.from({ length: 6 }, uuidv7);
  const hash = crypto.createHash("sha256").update("original\r\nscore").digest("hex");
  await pool.query("INSERT INTO users (id, username, email, display_name) VALUES ($1,'owner','owner@test.invalid','Owner')", [user]);
  await pool.query("INSERT INTO projects (id,created_by,name,storage_path,revision) VALUES ($1,$2,'Score',$3,9)", [project, user, `projects/${project}`]);
  await pool.query("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'owner')", [project, user]);
  await pool.query("INSERT INTO project_files (id,project_id,path) VALUES ($1,$2,'main.ly')", [file, project]);
  await pool.query("INSERT INTO document_versions (id,file_id,author_id,author_label,reason,content_hash,content,size) VALUES ($1,$2,$3,'Owner','compile',$4,$5,15)", [revision, file, user, hash, "original\r\nscore"]);
  await pool.query(`INSERT INTO build_outputs (id,project_id,source_file_id,source_revision_id,source_content_hash,created_by,created_by_label,
    project_type,compiler,format,main_path,display_name,status,completed_at,storage_path,size,content_hash,artifact_count)
    VALUES ($1,$2,$3,$4,$5,$6,'Owner','lilypond','lilypond','pdf','main.ly','score.pdf','succeeded',CURRENT_TIMESTAMP,$7,7,$5,1)`,
  [build, project, file, revision, hash, user, `output/${build}`]);
  await pool.query("INSERT INTO build_artifacts (id,build_id,name,storage_path,mime_type,size,content_hash) VALUES ($1,$2,'score.pdf',$3,'application/pdf',7,$4)", [artifact, build, `output/${build}/score.pdf`, hash]);
  await pool.query(`INSERT INTO build_outputs (id,project_id,source_file_id,source_content_hash,created_by_label,
    project_type,compiler,format,main_path,display_name,created_at)
    VALUES ($1,$2,$3,$4,'Owner','lilypond','lilypond','pdf','main.ly','older.pdf',CURRENT_TIMESTAMP - INTERVAL '1 day')`, [uuidv7(), project, file, hash]);
  await pool.query("INSERT INTO audit_events (action,actor_id,actor_label,target_type,target_id) VALUES ('build.complete',$1,'Owner','build',$2)", [user, build]);
  await pool.query("INSERT INTO project_deletions (project_id,owner_ids,state) VALUES ($1,$2,'cleanup_ready')", [uuidv7(), [user]]);
  const before = {};
  for (const table of historicalTables) before[table] = (await pool.query(`SELECT * FROM ${table}`)).rows;
  return { pool, before, build, project, user };
}
async function assertHistoricalRows(pool, before) {
  for (const table of historicalTables) {
    const columns = Object.keys(before[table][0]);
    const rows = (await pool.query(`SELECT ${columns.join(",")} FROM ${table}`)).rows;
    const ordered = values => values.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(ordered(rows), ordered(before[table]), table);
  }
}

test("schema-3 preview upgrade preserves history and enforces checked preview references", dbOptions, async t => {
  const { pool, before, build } = await legacyFixture(t);
  await pool.query(await fs.readFile(path.join(__dirname, "../db/migrations/003-pipelines.sql"), "utf8"));
  await pool.query("UPDATE iris_schema SET version=3");
  const oldShape = await schemaShape(pool);
  await Promise.all([initializeSchema(pool), initializeSchema(pool)]);
  assert.equal((await pool.query("SELECT version FROM iris_schema")).rows[0].version, 5);
  await assertHistoricalRows(pool, before);
  assert.equal((await pool.query("SELECT primary_preview FROM build_outputs WHERE id=$1", [build])).rows[0].primary_preview, null);
  await assert.rejects(pool.query("UPDATE build_outputs SET primary_preview=$2::jsonb WHERE id=$1", [build, JSON.stringify({ step: "validate", port: "report" })]), { code: "23514" });
  assert.ok((await schemaShape(pool)).columns.length > oldShape.columns.length);
  await initializeSchema(pool);
  await assertHistoricalRows(pool, before);
});

test("failed schema-3 preview migration rolls back without changing retained build records", dbOptions, async t => {
  const { pool, before } = await legacyFixture(t);
  await pool.query(await fs.readFile(path.join(__dirname, "../db/migrations/003-pipelines.sql"), "utf8"));
  await pool.query("UPDATE iris_schema SET version=3");
  const shape = await schemaShape(pool);
  const failing = { async connect() {
    const client = await pool.connect();
    return { async query(sql, params) {
      const result = await client.query(sql, params);
      if (/^UPDATE .*iris_schema/.test(sql.trim())) await client.query("SELECT 1 / 0");
      return result;
    }, release: () => client.release() };
  } };
  await assert.rejects(initializeSchema(failing), { code: "22012" });
  assert.equal((await pool.query("SELECT version FROM iris_schema")).rows[0].version, 3);
  assert.deepEqual(await schemaShape(pool), shape);
  await assertHistoricalRows(pool, before);
  await initializeSchema(pool);
  await assertHistoricalRows(pool, before);
});

test("schema-2 upgrade preserves original rows and stored paths and never imports plugin authority", dbOptions, async (t) => {
  const { pool, before, build } = await legacyFixture(t);
  await initializeSchema(pool);
  assert.equal((await pool.query("SELECT version FROM iris_schema")).rows[0].version, 5);
  await assertHistoricalRows(pool, before);
  assert.deepEqual((await pool.query("SELECT kind,target,request_order FROM build_outputs WHERE id=$1", [build])).rows[0], { kind: "compiler", target: "default", request_order: "2" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pipeline_approvals")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM project_pipelines")).rows[0].n, 0);
  await initializeSchema(pool);
  await assertHistoricalRows(pool, before);
});

test("a migration failure rolls back DDL and the version marker without losing historical data", dbOptions, async (t) => {
  const { pool, before } = await legacyFixture(t);
  let injected = false;
  const failing = { async connect() {
    const client = await pool.connect();
    return { async query(sql, params) {
      const result = await client.query(sql, params);
      if (!injected && /^UPDATE .*iris_schema/.test(sql.trim())) {
        injected = true;
        await client.query("SELECT 1 / 0");
      }
      return result;
    }, release() { client.release(); } };
  } };
  await assert.rejects(initializeSchema(failing), { code: "22012" });
  assert.equal(injected, true);
  assert.equal((await pool.query("SELECT version FROM iris_schema")).rows[0].version, 2);
  assert.equal((await pool.query("SELECT to_regclass('pipeline_approvals') AS approvals")).rows[0].approvals, null);
  await assertHistoricalRows(pool, before);
  await initializeSchema(pool);
  assert.equal((await pool.query("SELECT version FROM iris_schema")).rows[0].version, 5);
});

async function schemaShape(pool) {
  const columns = (await pool.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,
    character_maximum_length,is_identity,identity_generation FROM information_schema.columns
    WHERE table_schema=current_schema() ORDER BY table_name,column_name`)).rows;
  const constraints = (await pool.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid WHERE c.relnamespace=current_schema()::regnamespace
    ORDER BY c.relname,k.conname`)).rows;
  const indexes = (await pool.query(`SELECT t.relname AS table_name,i.relname AS index_name,pg_get_indexdef(i.oid,0,true) AS definition
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    WHERE t.relnamespace=current_schema()::regnamespace ORDER BY t.relname,i.relname`)).rows
    .map(row => ({ ...row, definition: row.definition.replace(/ ON [^. ]+\./, " ON ") }));
  return { columns, constraints, indexes };
}
test("fresh and upgraded schemas enforce identical column and relational contracts", dbOptions, async (t) => {
  const legacy = await legacyFixture(t), fresh = await isolatedSchema(t);
  await initializeSchema(fresh);
  await initializeSchema(legacy.pool);
  assert.equal((await fresh.query("SELECT version FROM iris_schema")).rows[0].version, 5);
  assert.deepEqual(await schemaShape(legacy.pool), await schemaShape(fresh));
});

test("concurrent schema-2 initializers upgrade once and retain the historical request order", dbOptions, async (t) => {
  const { pool, before } = await legacyFixture(t);
  await Promise.all([initializeSchema(pool), initializeSchema(pool)]);
  assert.equal((await pool.query("SELECT version FROM iris_schema")).rows[0].version, 5);
  await assertHistoricalRows(pool, before);
  const columns = (await pool.query("SELECT identity_generation FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='build_outputs' AND column_name='request_order'")).rows;
  assert.deepEqual(columns, [{ identity_generation: "ALWAYS" }]);
  const inserted = await pool.query(`INSERT INTO build_outputs (id,project_id,source_file_id,source_content_hash,created_by_label,project_type,compiler,format,main_path,display_name)
    SELECT $1,project_id,source_file_id,source_content_hash,created_by_label,project_type,compiler,format,main_path,'new.pdf'
    FROM build_outputs ORDER BY created_at DESC LIMIT 1 RETURNING request_order`, [uuidv7()]);
  assert.equal(inserted.rows[0].request_order, "3");
});

test("pipeline relational checks reject unknown/null lifecycle evidence and permit validation-only success", dbOptions, async (t) => {
  const { pool, project, user } = await legacyFixture(t);
  await initializeSchema(pool);
  const approval = uuidv7(), run = uuidv7(), hash = "a".repeat(64);
  await pool.query(`INSERT INTO pipeline_approvals (id,project_id,bundle_hash,policy_hash,registry_hash,approved_by,approved_by_label)
    VALUES ($1,$2,$3,$3,$3,$4,'Owner')`, [approval, project, hash, user]);
  await pool.query(`INSERT INTO build_outputs (id,project_id,created_by,created_by_label,display_name,kind,target,status,
    snapshot_hash,bundle_hash,policy_hash,registry_hash,approval_id,save_revision,coordinator_id,deadline_at)
    VALUES ($1,$2,$3,'Owner','Validation','pipeline','check','queued',$4,$4,$4,$4,$5,9,$6,CURRENT_TIMESTAMP + INTERVAL '30 minutes')`, [run, project, user, hash, approval, uuidv7()]);
  for (const assignment of [
    "approval_id=NULL", "snapshot_hash=NULL", "coordinator_id=NULL", "save_revision=NULL",
    "status='failed',completed_at=CURRENT_TIMESTAMP", "publication_state='prepared'",
    "status='succeeded',completed_at=CURRENT_TIMESTAMP",
    `status='succeeded',completed_at=CURRENT_TIMESTAMP,artifact_count=1,content_hash='${hash}',plan_hash='${hash}',publication_state='committed',publication_hash='${hash}'`,
  ]) await assert.rejects(pool.query(`UPDATE build_outputs SET ${assignment} WHERE id=$1`, [run]), { code: "23514" });
  await pool.query(`UPDATE build_outputs SET status='succeeded',completed_at=CURRENT_TIMESTAMP,plan_hash=$2,
    publication_state='committed',publication_hash=$2 WHERE id=$1`, [run, hash]);
  assert.deepEqual((await pool.query("SELECT status,storage_path,artifact_count FROM build_outputs WHERE id=$1", [run])).rows[0], { status: "succeeded", storage_path: null, artifact_count: 0 });
  for (const value of [{}, { step: "compile" }, { step: "../compile", port: "output" }, { step: 1, port: "output" },
    { step: "compile", port: "output", path: "guess.pdf" }, ["compile", "output"], null]) {
    await assert.rejects(pool.query("UPDATE build_outputs SET primary_preview=$2::jsonb WHERE id=$1", [run, JSON.stringify(value)]), { code: "23514" });
  }
  const otherProject = uuidv7();
  await pool.query("INSERT INTO projects (id,name,storage_path) VALUES ($1,'Other',$2)", [otherProject, `projects/${otherProject}`]);
  await assert.rejects(pool.query("INSERT INTO project_pipelines (project_id,enabled,approval_id) VALUES ($1,true,$2)", [otherProject, approval]), { code: "23503" });
});
