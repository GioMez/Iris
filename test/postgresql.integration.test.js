const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Pool } = require("pg");
const { runMigrations } = require("../src/database");
const { uuidv7, isUuid, uuidTimestamp } = require("../src/ids");
const { projectStorageKey, relocateProjectStorage } = require("../src/project-storage");

const connectionString = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");
const ALL_MIGRATIONS = [
  "001_initial.sql",
  "002_project_storage_relative.sql",
  "003_audit_events.sql",
  "004_uuidv7_identifiers.sql",
  "005_consolidation_invariants.sql",
];
const silentLogger = { log() {}, warn() {}, error() {} };

// Each test owns an isolated schema so a failure never leaves state behind.
async function isolatedSchema(t) {
  const schema = `iris_test_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString, max: 2, options: `-c search_path=${schema}` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  return pool;
}

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function insertUser(pool, username, email) {
  const { rows } = await pool.query(
    "INSERT INTO users (id, username, email, display_name, role, password_hash) VALUES ($1, $2, $3, $2, 'admin', 'hash') RETURNING id",
    [uuidv7(), username, email]
  );
  return rows[0].id;
}

test("PostgreSQL migrations enforce Iris data invariants", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);
  await runMigrations(pool);

  const migrations = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(migrations.rows.map((row) => row.version), ALL_MIGRATIONS);

  const userId = await insertUser(pool, "Mario", "Mario@example.org");
  assert.ok(isUuid(userId), `expected a uuid, got ${userId}`);
  await assert.rejects(
    pool.query(
      "INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, $2, $3, $2, 'hash')",
      [uuidv7(), "mario", "other@example.org"]
    ),
    (error) => error.code === "23505"
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, $2, $3, $2, 'hash')",
      [uuidv7(), "other", "mario@EXAMPLE.ORG"]
    ),
    (error) => error.code === "23505"
  );

  const projectId = uuidv7();
  await pool.query(
    "INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, $3, $4)",
    [projectId, userId, "Score", projectStorageKey(projectId)]
  );
  // Storage locations must stay relative to DATA_DIR and inside it.
  for (const invalid of ["/srv/iris/data/projects/x", "", "projects/../escape", "C:\\iris\\projects"]) {
    await assert.rejects(
      pool.query(
        "INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, $3, $4)",
        [uuidv7(), userId, "Bad", invalid]
      ),
      (error) => error.code === "23514"
    );
  }
  await assert.rejects(
    pool.query(
      "INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, $3, $4)",
      [uuidv7(), userId, "Mismatched", projectStorageKey(projectId)]
    ),
    (error) => error.code === "23514"
  );
  // The uuid type rejects malformed identifiers without a CHECK constraint.
  await assert.rejects(
    pool.query(
      "INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, $3, $4)",
      ["not-a-uuid", userId, "Bad", "projects/x"]
    ),
    (error) => error.code === "22P02"
  );

  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  const projects = await pool.query("SELECT COUNT(*) AS n FROM projects");
  assert.equal(Number(projects.rows[0].n), 0);
});

test("the audit trail outlives the accounts it describes", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);
  const userId = await insertUser(pool, "lucia", "lucia@example.org");
  const projectId = uuidv7();

  await pool.query(
    `INSERT INTO audit_events (action, actor_id, actor_label, target_type, target_id, ip, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    ["project.deleted", userId, "lucia", "project", projectId, "203.0.113.7", '{"name":"Score"}']
  );
  await pool.query(
    "INSERT INTO audit_events (action, outcome, actor_label, target_type) VALUES ($1, $2, $3, $4)",
    ["auth.login_failed", "failure", "unknown", "user"]
  );

  const validRow = { action: "user.created", outcome: "success", actor_label: "lucia", target_type: "user" };
  for (const [column, value] of [["outcome", "maybe"], ["target_type", "invoice"], ["action", ""], ["actor_label", ""]]) {
    const columns = Object.keys(validRow);
    const values = columns.map((name) => (name === column ? value : validRow[name]));
    await assert.rejects(
      pool.query(
        `INSERT INTO audit_events (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        values
      ),
      (error) => error.code === "23514"
    );
  }
  await assert.rejects(
    pool.query(
      "INSERT INTO audit_events (action, actor_label, target_type, metadata) VALUES ('user.created', 'lucia', 'user', $1::jsonb)",
      ['"a string"']
    ),
    (error) => error.code === "23514"
  );
  for (const metadata of [{ nested: { value: 1 } }, { list: [1, 2] }, { empty: null }]) {
    await assert.rejects(
      pool.query(
        "INSERT INTO audit_events (action, actor_label, target_type, metadata) VALUES ('user.created', 'lucia', 'user', $1::jsonb)",
        [JSON.stringify(metadata)]
      ),
      (error) => error.code === "23514"
    );
  }
  await assert.rejects(
    pool.query(
      "INSERT INTO audit_events (action, actor_label, target_type, metadata) VALUES ('user.created', 'lucia', 'user', $1::jsonb)",
      [JSON.stringify({ value: "x".repeat(9000) })]
    ),
    (error) => error.code === "23514"
  );

  // Removing the account clears the reference but keeps the trail and its label.
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  const events = await pool.query("SELECT action, actor_id, actor_label, metadata FROM audit_events ORDER BY id");
  assert.equal(events.rows.length, 2);
  assert.deepEqual(events.rows[0], {
    action: "project.deleted",
    actor_id: null,
    actor_label: "lucia",
    metadata: { name: "Score" },
  });
  assert.equal(events.rows[1].actor_label, "unknown");
});

test("upgrading a pre-002 database relocates project data", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  const staged = await tempDir(t, "iris-migrations-");
  const dataDir = await tempDir(t, "iris-data-");
  const legacyId = "0123456789abcdef0123456789abcdef";

  // Start from the schema as it shipped, with an absolute storage path.
  await fs.copyFile(path.join(MIGRATIONS_DIR, ALL_MIGRATIONS[0]), path.join(staged, ALL_MIGRATIONS[0]));
  await runMigrations(pool, staged);
  const { rows } = await pool.query(
    "INSERT INTO users (username, email, display_name, role, password_hash) VALUES ('gio', 'gio@example.org', 'gio', 'admin', 'hash') RETURNING id"
  );
  const legacyDir = path.join(dataDir, String(rows[0].id), `${legacyId}-score`);
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, "main.tex"), "\\documentclass{article}");
  await pool.query(
    "INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, $3, $4)",
    [legacyId, rows[0].id, "Score", legacyDir]
  );

  await runMigrations(pool, MIGRATIONS_DIR);

  // 002 made the path relative, 004 renamed it after the new uuid: both moves are
  // pending on disk and both are carried by legacy_storage_path.
  const migrated = await pool.query("SELECT id, storage_path, legacy_storage_path FROM projects");
  assert.ok(isUuid(migrated.rows[0].id));
  assert.equal(migrated.rows[0].storage_path, projectStorageKey(migrated.rows[0].id));
  assert.equal(migrated.rows[0].legacy_storage_path, legacyDir);

  const summary = await relocateProjectStorage({ db: pool, dataDir, logger: silentLogger });
  assert.equal(summary.moved, 1);
  const settled = await pool.query("SELECT legacy_storage_path FROM projects");
  assert.equal(settled.rows[0].legacy_storage_path, null);
  assert.equal(
    await fs.readFile(path.join(dataDir, "projects", migrated.rows[0].id, "main.tex"), "utf8"),
    "\\documentclass{article}"
  );
});

test("migration 004 rewrites every identifier and its references", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  const staged = await tempDir(t, "iris-migrations-");
  const dataDir = await tempDir(t, "iris-data-");
  const legacyId = "fedcba9876543210fedcba9876543210";

  // Reach the state right before 004: integer users, CHAR(32) projects.
  for (const name of ALL_MIGRATIONS.slice(0, 3)) {
    await fs.copyFile(path.join(MIGRATIONS_DIR, name), path.join(staged, name));
  }
  await runMigrations(pool, staged);

  const createdAt = "2024-03-01 09:15:00+01";
  const { rows: userRows } = await pool.query(
    `INSERT INTO users (username, email, display_name, role, password_hash, created_at)
     VALUES ('gio', 'gio@example.org', 'gio', 'admin', 'hash', $1) RETURNING id`,
    [createdAt]
  );
  const oldUserId = userRows[0].id;
  await pool.query(
    "INSERT INTO projects (id, user_id, name, storage_path, created_at) VALUES ($1, $2, 'Score', $3, $4)",
    [legacyId, oldUserId, `projects/${legacyId}`, createdAt]
  );
  await fs.mkdir(path.join(dataDir, "projects", legacyId), { recursive: true });
  await fs.writeFile(path.join(dataDir, "projects", legacyId, "main.ly"), "{ c1 }");

  // Audit rows reference both entities: by foreign key and as text in target_id.
  await pool.query(
    `INSERT INTO audit_events (action, actor_id, actor_label, target_type, target_id) VALUES
       ('project.created', $1, 'gio', 'project', $2),
       ('user.created', $1, 'gio', 'user', $3),
       ('auth.login_failed', NULL, 'ghost', 'user', '999')`,
    [oldUserId, legacyId, String(oldUserId)]
  );

  await runMigrations(pool, MIGRATIONS_DIR);

  const user = (await pool.query("SELECT id, created_at FROM users")).rows[0];
  const project = (await pool.query("SELECT id, user_id, storage_path, legacy_storage_path FROM projects")).rows[0];

  assert.ok(isUuid(user.id) && isUuid(project.id), "identifiers became uuids");
  assert.equal(user.id[14], "7", "user id is version 7");
  assert.equal(project.id[14], "7", "project id is version 7");
  // The backfilled id embeds the row's own creation time, so ids stay time-ordered.
  assert.equal(uuidTimestamp(user.id).getTime(), new Date(user.created_at).getTime());

  assert.equal(project.user_id, user.id, "the foreign key follows the rewrite");
  assert.equal(project.storage_path, projectStorageKey(project.id));
  assert.equal(project.legacy_storage_path, `projects/${legacyId}`);

  const events = await pool.query("SELECT action, actor_id, target_type, target_id FROM audit_events ORDER BY id");
  assert.deepEqual(events.rows, [
    { action: "project.created", actor_id: user.id, target_type: "project", target_id: project.id },
    { action: "user.created", actor_id: user.id, target_type: "user", target_id: user.id },
    // Nothing to translate: the referenced account never existed.
    { action: "auth.login_failed", actor_id: null, target_type: "user", target_id: "999" },
  ]);

  // The indexes that depended on the rewritten columns must be back.
  const indexes = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname"
  );
  const names = indexes.rows.map((row) => row.indexname);
  for (const expected of ["idx_projects_user_updated", "idx_audit_events_actor", "uq_users_username_ci"]) {
    assert.ok(names.includes(expected), `missing index ${expected}: ${names.join(", ")}`);
  }

  // Constraints survive the column swap.
  await assert.rejects(
    pool.query("INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, 'x', '/absolute')", [uuidv7(), user.id]),
    (error) => error.code === "23514"
  );
  const orphanProjectId = uuidv7();
  await assert.rejects(
    pool.query(
      "INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, 'x', $3)",
      [orphanProjectId, uuidv7(), projectStorageKey(orphanProjectId)]
    ),
    (error) => error.code === "23503"
  );

  // And the pending directory rename completes.
  const summary = await relocateProjectStorage({ db: pool, dataDir, logger: silentLogger });
  assert.equal(summary.moved, 1);
  assert.equal(await fs.readFile(path.join(dataDir, "projects", project.id, "main.ly"), "utf8"), "{ c1 }");
});
