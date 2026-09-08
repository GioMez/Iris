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
  "006_project_files.sql",
  "007_document_versions.sql",
  "008_server_administration.sql",
  "009_project_members.sql",
  "010_account_hardening.sql",
  "011_oidc_linked_at.sql",
  "012_versioned_build_outputs.sql",
  "013_realtime_revisions.sql",
  "014_account_session_version.sql",
  "015_project_revision.sql",
];
const silentLogger = { log() {}, warn() {}, error() {} };

// Each test owns an isolated schema so a failure never leaves state behind.
async function isolatedSchema(t) {
  const schema = `iris_test_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  const timeouts = { connectionTimeoutMillis: 3000, query_timeout: 7000, statement_timeout: 5000, lock_timeout: 3000, idle_in_transaction_session_timeout: 10000 };
  const admin = new Pool({ connectionString, max: 1, ...timeouts });
  const pool = new Pool({ connectionString, max: 2, ...timeouts, options: `-c search_path=${schema}` });
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
    "INSERT INTO users (id, username, email, display_name, system_role, password_hash) VALUES ($1, $2, $3, $2, 'admin', 'hash') RETURNING id",
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
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
    [projectId, userId, "Score", projectStorageKey(projectId)]
  );
  // Storage locations must stay relative to DATA_DIR and inside it.
  for (const invalid of ["/srv/iris/data/projects/x", "", "projects/../escape", "C:\\iris\\projects"]) {
    await assert.rejects(
      pool.query(
        "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
        [uuidv7(), userId, "Bad", invalid]
      ),
      (error) => error.code === "23514"
    );
  }
  await assert.rejects(
    pool.query(
      "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
      [uuidv7(), userId, "Mismatched", projectStorageKey(projectId)]
    ),
    (error) => error.code === "23514"
  );
  // The uuid type rejects malformed identifiers without a CHECK constraint.
  await assert.rejects(
    pool.query(
      "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
      ["not-a-uuid", userId, "Bad", "projects/x"]
    ),
    (error) => error.code === "22P02"
  );

  // Deleting the creator no longer removes the project: created_by is a historical
  // pointer set to NULL, and the project lives on through its memberships.
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  const projects = await pool.query("SELECT id, created_by FROM projects");
  assert.equal(projects.rows.length, 1);
  assert.equal(projects.rows[0].created_by, null);
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

test("the file-identity ledger enforces its invariants", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);
  const userId = await insertUser(pool, "gio", "gio@example.org");
  const projectId = uuidv7();
  await pool.query(
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
    [projectId, userId, "Score", projectStorageKey(projectId)]
  );

  const insertFile = (id, path, kind = "tex") => pool.query(
    "INSERT INTO project_files (id, project_id, client_ref, path, kind) VALUES ($1, $2, $3, $4, $5)",
    [id, projectId, id, path, kind]
  );

  const fileA = uuidv7();
  await insertFile(fileA, "main.tex");
  // A second live file cannot claim the same path.
  await assert.rejects(insertFile(uuidv7(), "main.tex"), (error) => error.code === "23505");

  // A rename is an update on the same identity, and it frees the old path.
  await pool.query("UPDATE project_files SET path = 'renamed.tex' WHERE id = $1", [fileA]);
  const reused = uuidv7();
  await insertFile(reused, "main.tex");
  const live = await pool.query(
    "SELECT id, path FROM project_files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path",
    [projectId]
  );
  assert.deepEqual(live.rows, [{ id: reused, path: "main.tex" }, { id: fileA, path: "renamed.tex" }]);

  // Soft-deleting frees the path for a genuinely new file without erasing history.
  await pool.query("UPDATE project_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [fileA]);
  const successor = uuidv7();
  await insertFile(successor, "renamed.tex");
  const total = await pool.query("SELECT COUNT(*) AS n FROM project_files WHERE project_id = $1", [projectId]);
  assert.equal(Number(total.rows[0].n), 3);

  // Malformed and unsafe paths are refused.
  for (const badPath of ["", "/abs.tex", "a/../b.tex"]) {
    await assert.rejects(insertFile(uuidv7(), badPath), (error) => error.code === "23514");
  }
  // A malformed id is refused by the uuid type.
  await assert.rejects(
    pool.query("INSERT INTO project_files (id, project_id, path) VALUES ($1, $2, $3)", ["not-a-uuid", projectId, "x.tex"]),
    (error) => error.code === "22P02"
  );

  // Deleting the project removes its files.
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  const orphans = await pool.query("SELECT COUNT(*) AS n FROM project_files");
  assert.equal(Number(orphans.rows[0].n), 0);
});

test("project membership is the authority for ownership and cascades correctly", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);
  const owner = await insertUser(pool, "owner", "owner@example.org");
  const editor = await insertUser(pool, "editor", "editor@example.org");
  const projectId = uuidv7();
  await pool.query(
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'Score', $3)",
    [projectId, owner, projectStorageKey(projectId)]
  );
  await pool.query("INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)", [projectId, owner]);
  await pool.query("INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, 'editor', $3)", [projectId, editor, owner]);

  // A user has at most one role per project, and roles are constrained.
  await assert.rejects(
    pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')", [projectId, editor]),
    (error) => error.code === "23505"
  );
  await assert.rejects(
    pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'admin')", [projectId, uuidv7()]),
    (error) => error.code === "23514"
  );

  // Removing a member (the editor) does not touch the project or the owner.
  await pool.query("DELETE FROM users WHERE id = $1", [editor]);
  const afterEditor = await pool.query("SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1", [projectId]);
  assert.equal(Number(afterEditor.rows[0].n), 1);
  const projectStillThere = await pool.query("SELECT created_by FROM projects WHERE id = $1", [projectId]);
  assert.equal(projectStillThere.rows[0].created_by, owner);

  // Deleting the creator keeps the project (created_by → NULL) but removes their
  // membership; ownership would need transfer first, which the app enforces.
  await pool.query("DELETE FROM users WHERE id = $1", [owner]);
  const afterOwner = await pool.query("SELECT created_by FROM projects WHERE id = $1", [projectId]);
  assert.equal(afterOwner.rows.length, 1);
  assert.equal(afterOwner.rows[0].created_by, null);
  const members = await pool.query("SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1", [projectId]);
  assert.equal(Number(members.rows[0].n), 0);

  // Deleting the project cascades whatever memberships remain.
  const p2 = uuidv7();
  const u2 = await insertUser(pool, "solo", "solo@example.org");
  await pool.query("INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'P2', $3)", [p2, u2, projectStorageKey(p2)]);
  await pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [p2, u2]);
  await pool.query("DELETE FROM projects WHERE id = $1", [p2]);
  const orphanMembers = await pool.query("SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1", [p2]);
  assert.equal(Number(orphanMembers.rows[0].n), 0);
});

test("server administration schema enforces roles, status and OIDC identity", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);

  // The role column was renamed and its vocabulary changed.
  await assert.rejects(
    pool.query("INSERT INTO users (id, username, email, display_name, system_role, password_hash) VALUES ($1, 'x', 'x@e.org', 'x', 'user', 'h')", [uuidv7()]),
    (error) => error.code === "23514"
  );
  for (const [column, value] of [["status", "deleted"], ["auth_source", "ldap"]]) {
    await assert.rejects(
      pool.query(
        `INSERT INTO users (id, username, email, display_name, password_hash, ${column}) VALUES ($1, 'y', 'y@e.org', 'y', 'h', $2)`,
        [uuidv7(), value]
      ),
      (error) => error.code === "23514"
    );
  }

  // Defaults: a plain insert is an active, regular, local account.
  const id = uuidv7();
  await pool.query("INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, 'gio', 'gio@e.org', 'gio', 'h')", [id]);
  const row = await pool.query("SELECT system_role, status, auth_source, session_epoch FROM users WHERE id = $1", [id]);
  assert.deepEqual(
    { role: row.rows[0].system_role, status: row.rows[0].status, source: row.rows[0].auth_source },
    { role: "regular", status: "active", source: "local" }
  );
  assert.ok(row.rows[0].session_epoch, "session_epoch defaults to now");

  // The issuer + subject identity is unique when both are present.
  await pool.query(
    "INSERT INTO users (id, username, email, display_name, auth_source, oidc_issuer, oidc_subject) VALUES ($1, 'a', 'a@e.org', 'a', 'oidc', 'https://idp', 'sub-1')",
    [uuidv7()]
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO users (id, username, email, display_name, auth_source, oidc_issuer, oidc_subject) VALUES ($1, 'b', 'b@e.org', 'b', 'oidc', 'https://idp', 'sub-1')",
      [uuidv7()]
    ),
    (error) => error.code === "23505"
  );
  // A different subject at the same issuer is fine, and two local accounts with
  // NULL issuer/subject do not collide.
  await pool.query(
    "INSERT INTO users (id, username, email, display_name, auth_source, oidc_issuer, oidc_subject) VALUES ($1, 'c', 'c@e.org', 'c', 'oidc', 'https://idp', 'sub-2')",
    [uuidv7()]
  );
  await pool.query("INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, 'd', 'd@e.org', 'd', 'h')", [uuidv7()]);
  await pool.query("INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, 'e', 'e@e.org', 'e', 'h')", [uuidv7()]);
});

test("session versions backfill existing accounts and enforce nonnegative integers", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  const staged = await tempDir(t, "iris-migrations-");
  for (const name of ALL_MIGRATIONS.slice(0, 13)) {
    await fs.copyFile(path.join(MIGRATIONS_DIR, name), path.join(staged, name));
  }
  await runMigrations(pool, staged);
  const existing = await insertUser(pool, "existing", "existing@example.org");
  await runMigrations(pool);
  const fresh = await insertUser(pool, "fresh", "fresh@example.org");
  const { rows } = await pool.query("SELECT session_version, session_epoch FROM users ORDER BY username");
  assert.deepEqual(rows.map((row) => row.session_version), [0, 0]);
  assert.ok(rows.every((row) => row.session_epoch), "retain the epoch column for existing data");
  const column = await pool.query(
    "SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'session_version'"
  );
  assert.equal(column.rows[0].data_type, "integer");
  for (const [value, code] of [[null, "23502"], [-1, "23514"], ["1.5", "22P02"]]) {
    await assert.rejects(pool.query("UPDATE users SET session_version = $1 WHERE id = $2", [value, existing]), (error) => error.code === code);
  }
  await pool.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [fresh]);
  assert.equal((await pool.query("SELECT session_version FROM users WHERE id = $1", [fresh])).rows[0].session_version, 1);
});

test("project revisions backfill and enforce nonnegative integers", { skip: !connectionString, timeout: 20000 }, async (t) => {
  const pool = await isolatedSchema(t);
  const staged = await tempDir(t, "iris-migrations-");
  for (const name of ALL_MIGRATIONS.slice(0, 14)) await fs.copyFile(path.join(MIGRATIONS_DIR, name), path.join(staged, name));
  await runMigrations(pool, staged);
  const user = await insertUser(pool, "writer", "writer@example.org");
  const id = uuidv7();
  await pool.query("INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'Existing', $3)", [id, user, projectStorageKey(id)]);
  await runMigrations(pool);
  assert.equal((await pool.query("SELECT revision FROM projects WHERE id = $1", [id])).rows[0].revision, 0);
  for (const [value, code] of [[null, "23502"], [-1, "23514"], ["1.5", "22P02"]]) {
    await assert.rejects(pool.query("UPDATE projects SET revision = $1 WHERE id = $2", [value, id]), (error) => error.code === code);
  }
});

test("document versions form an append-only history keyed to a stable file id", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);
  const userId = await insertUser(pool, "gio", "gio@example.org");
  const projectId = uuidv7();
  await pool.query(
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
    [projectId, userId, "Score", projectStorageKey(projectId)]
  );
  const fileId = uuidv7();
  await pool.query(
    "INSERT INTO project_files (id, project_id, client_ref, path, kind) VALUES ($1, $2, $3, $4, $5)",
    [fileId, projectId, fileId, "main.tex", "tex"]
  );

  // A separate author who does not own the project, so deleting the author does
  // not cascade the project away and the SET NULL behaviour can be observed.
  const authorId = await insertUser(pool, "author", "author@example.org");
  const addVersion = async (parent, reason, content) => {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO document_versions (id, file_id, parent_version_id, author_id, author_label, reason, content_hash, content, size)
       VALUES ($1, $2, $3, $4, 'author', $5, $6, $7, $8)`,
      [id, fileId, parent, authorId, reason, crypto.createHash("sha256").update(content).digest("hex"), content, Buffer.byteLength(content)]
    );
    return id;
  };

  const v1 = await addVersion(null, "compile", "one");
  const v2 = await addVersion(v1, "compile", "two");
  // A rollback appends a revision with older content; it never deletes v2.
  const v3 = await addVersion(v2, "rollback", "one");
  const chain = await pool.query(
    "SELECT id, parent_version_id, reason, content FROM document_versions WHERE file_id = $1 ORDER BY created_at, id",
    [fileId]
  );
  assert.equal(chain.rows.length, 3);
  assert.equal(chain.rows[2].parent_version_id, v2, "rollback parents the latest, not the source");
  assert.equal(chain.rows[2].content, "one");

  // Migration 013 admits the consolidated checkpoints realtime editing records.
  const v4 = await addVersion(v3, "realtime", "one live");
  assert.ok(isUuid(v4));

  // The reason vocabulary and non-empty author label are enforced.
  await assert.rejects(addVersion(null, "whatever", "x"), (error) => error.code === "23514");
  await assert.rejects(
    pool.query(
      "INSERT INTO document_versions (id, file_id, author_label, reason, content_hash, content, size) VALUES ($1, $2, '', 'manual', 'h', 'c', 1)",
      [uuidv7(), fileId]
    ),
    (error) => error.code === "23514"
  );

  // Attribution outlives the author: deleting the (non-owner) author keeps the
  // history and its readable label.
  await pool.query("DELETE FROM users WHERE id = $1", [authorId]);
  const afterUser = await pool.query("SELECT author_id, author_label FROM document_versions WHERE id = $1", [v1]);
  assert.deepEqual(afterUser.rows[0], { author_id: null, author_label: "author" });

  // Soft-deleting the file keeps its history; deleting the project cascades it away.
  await pool.query("UPDATE project_files SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1", [fileId]);
  const afterSoftDelete = await pool.query("SELECT COUNT(*) AS n FROM document_versions WHERE file_id = $1", [fileId]);
  assert.equal(Number(afterSoftDelete.rows[0].n), 4);
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  const afterProject = await pool.query("SELECT COUNT(*) AS n FROM document_versions");
  assert.equal(Number(afterProject.rows[0].n), 0);
});

test("versioned build outputs retain provenance and cascade with their project", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);
  const userId = await insertUser(pool, "builder", "builder@example.org");
  const projectId = uuidv7();
  await pool.query(
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'Builds', $3)",
    [projectId, userId, projectStorageKey(projectId)]
  );
  const fileId = uuidv7();
  await pool.query(
    "INSERT INTO project_files (id, project_id, client_ref, path, kind) VALUES ($1, $2, $3, 'main.tex', 'tex')",
    [fileId, projectId, fileId]
  );
  const versionId = uuidv7();
  const sourceHash = crypto.createHash("sha256").update("source").digest("hex");
  await pool.query(
    `INSERT INTO document_versions (id, file_id, author_id, author_label, reason, content_hash, content, size)
     VALUES ($1, $2, $3, 'builder', 'compile', $4, 'source', 6)`,
    [versionId, fileId, userId, sourceHash]
  );
  const buildId = uuidv7();
  const artifactId = uuidv7();
  const artifactHash = crypto.createHash("sha256").update("pdf").digest("hex");
  const storagePath = `output/${buildId}`;
  await pool.query(
    `INSERT INTO build_outputs (
       id, project_id, source_file_id, source_revision_id, source_content_hash, created_by, created_by_label,
       completed_at, status, project_type, compiler, format, main_path, display_name,
       storage_path, size, content_hash, artifact_count, duration_ms, exit_code
     ) VALUES ($1, $2, $3, $4, $5, $6, 'builder', CURRENT_TIMESTAMP, 'succeeded',
       'latex', 'pdflatex', 'pdf', 'main.tex', 'main.pdf', $7, 3, $8, 1, 25, 0)`,
    [buildId, projectId, fileId, versionId, sourceHash, userId, storagePath, artifactHash]
  );
  await pool.query(
    `INSERT INTO build_artifacts (id, build_id, name, storage_path, mime_type, size, content_hash)
     VALUES ($1, $2, 'main.pdf', $3, 'application/pdf', 3, $4)`,
    [artifactId, buildId, `${storagePath}/main.pdf`, artifactHash]
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO build_outputs (
         id, project_id, source_file_id, source_content_hash, created_by_label, completed_at, status,
         project_type, compiler, format, main_path, display_name, storage_path, size,
         content_hash, artifact_count
       ) VALUES ($1, $2, $3, $4, 'builder', CURRENT_TIMESTAMP, 'succeeded', 'latex',
         'pdflatex', 'pdf', 'main.tex', 'bad.pdf', 'output/not-the-id', 1, $4, 1)`,
      [uuidv7(), projectId, fileId, artifactHash]
    ),
    (error) => error.code === "23514"
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO build_artifacts (id, build_id, name, storage_path, mime_type, size, content_hash)
       VALUES ($1, $2, '../escape.pdf', 'output/escape.pdf', 'application/pdf', 1, $3)`,
      [uuidv7(), buildId, artifactHash]
    ),
    (error) => error.code === "23514"
  );

  // User deletion preserves readable attribution and the build itself.
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  const retained = await pool.query("SELECT created_by, created_by_label, source_revision_id FROM build_outputs WHERE id = $1", [buildId]);
  assert.deepEqual(retained.rows[0], {
    created_by: null,
    created_by_label: "builder",
    source_revision_id: versionId,
  });

  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM build_outputs")).rows[0].n), 0);
  assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM build_artifacts")).rows[0].n), 0);
});

test("admin user deletion: sole-owner detection and membership cascade", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await runMigrations(pool);
  const alice = await insertUser(pool, "alice", "alice@example.org");
  const bob = await insertUser(pool, "bob", "bob@example.org");
  const mkProject = async (name) => {
    const id = uuidv7();
    await pool.query(
      "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
      [id, alice, name, projectStorageKey(id)]
    );
    return id;
  };
  const addMember = (projectId, userId, role) =>
    pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)", [projectId, userId, role]);

  const solo = await mkProject("Solo");       // alice: only owner
  await addMember(solo, alice, "owner");
  const shared = await mkProject("Shared");   // alice + bob: both owners
  await addMember(shared, alice, "owner");
  await addMember(shared, bob, "owner");
  const guest = await mkProject("Guest");     // bob owner, alice editor
  await addMember(guest, bob, "owner");
  await addMember(guest, alice, "editor");

  // The endpoint's sole-owner detection: alice is the *only* owner of Solo alone.
  const soleOwner = await pool.query(
    `SELECT p.id FROM projects p
     JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 AND m.role = 'owner'
     WHERE NOT EXISTS (SELECT 1 FROM project_members o WHERE o.project_id = p.id AND o.role = 'owner' AND o.user_id <> $1)`,
    [alice]
  );
  assert.deepEqual(soleOwner.rows.map((r) => r.id), [solo], "only the solely-owned project is flagged");

  // Deleting alice cascades her memberships: the co-owned project keeps its other
  // owner, her editor membership vanishes, and the solely-owned project is left
  // ownerless — which is exactly why the endpoint blocks until it is resolved.
  await pool.query("DELETE FROM users WHERE id = $1", [alice]);
  const ownerCount = async (id) =>
    Number((await pool.query("SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner'", [id])).rows[0].n);
  assert.equal(await ownerCount(shared), 1, "co-owned project keeps its other owner");
  assert.equal(await ownerCount(solo), 0, "solely-owned project is orphaned by the cascade");
  const guestMembership = await pool.query(
    "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND user_id = $2", [guest, alice]
  );
  assert.equal(Number(guestMembership.rows[0].n), 0, "her editor membership cascades away");
  const surviving = await pool.query("SELECT COUNT(*) AS n FROM projects");
  assert.equal(Number(surviving.rows[0].n), 3, "the projects themselves survive (created_by is nulled)");
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
  const project = (await pool.query("SELECT id, created_by, storage_path, legacy_storage_path FROM projects")).rows[0];

  assert.ok(isUuid(user.id) && isUuid(project.id), "identifiers became uuids");
  assert.equal(user.id[14], "7", "user id is version 7");
  assert.equal(project.id[14], "7", "project id is version 7");
  // The backfilled id embeds the row's own creation time, so ids stay time-ordered.
  assert.equal(uuidTimestamp(user.id).getTime(), new Date(user.created_at).getTime());

  assert.equal(project.created_by, user.id, "the foreign key follows the rewrite");
  assert.equal(project.storage_path, projectStorageKey(project.id));
  // Migration 009 seeded ownership from the migrated single-owner column.
  const owner = await pool.query("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2", [project.id, user.id]);
  assert.equal(owner.rows[0].role, "owner");
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
  for (const expected of ["idx_projects_created_by", "idx_audit_events_actor", "uq_users_username_ci"]) {
    assert.ok(names.includes(expected), `missing index ${expected}: ${names.join(", ")}`);
  }

  // Constraints survive the column swap.
  await assert.rejects(
    pool.query("INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'x', '/absolute')", [uuidv7(), user.id]),
    (error) => error.code === "23514"
  );
  const orphanProjectId = uuidv7();
  await assert.rejects(
    pool.query(
      "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'x', $3)",
      [orphanProjectId, uuidv7(), projectStorageKey(orphanProjectId)]
    ),
    (error) => error.code === "23503"
  );

  // And the pending directory rename completes.
  const summary = await relocateProjectStorage({ db: pool, dataDir, logger: silentLogger });
  assert.equal(summary.moved, 1);
  assert.equal(await fs.readFile(path.join(dataDir, "projects", project.id, "main.ly"), "utf8"), "{ c1 }");
});
