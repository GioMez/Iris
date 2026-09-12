const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { initializeSchema } = require("../src/database");
const { uuidv7, isUuid } = require("../src/ids");
const { projectStorageKey } = require("../src/project-storage");
const { connectionString, isolatedSchema } = require("./helpers/isolated-schema.cjs");

async function insertUser(pool, username, email) {
  const { rows } = await pool.query(
    "INSERT INTO users (id, username, email, display_name, system_role, password_hash) VALUES ($1, $2, $3, $2, 'admin', 'hash') RETURNING id",
    [uuidv7(), username, email]
  );
  return rows[0].id;
}

test("the current PostgreSQL schema enforces Iris data invariants", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);

  // Keep the current lookup/index guarantees independently of bootstrap history.
  const indexes = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()");
  const names = indexes.rows.map((row) => row.indexname);
  for (const expected of ["idx_projects_created_by", "idx_audit_events_actor", "uq_users_username_ci"]) {
    assert.ok(names.includes(expected), `missing index ${expected}: ${names.join(", ")}`);
  }

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
  const orphanId = uuidv7();
  await assert.rejects(
    pool.query("INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'Orphan', $3)", [orphanId, uuidv7(), projectStorageKey(orphanId)]),
    { code: "23503" }
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
  await initializeSchema(pool);
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
  await initializeSchema(pool);
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
  await initializeSchema(pool);
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
  await initializeSchema(pool);

  // Only current server roles are admitted.
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

  // An external account waiting for approval is storable.
  await pool.query(
    "INSERT INTO users (id, username, email, display_name, system_role, status, auth_source, oidc_issuer, oidc_subject) VALUES ($1, 'ext', 'ext@e.org', 'ext', 'external', 'pending', 'oidc', 'https://idp', 'sub-ext')",
    [uuidv7()]
  );
  const provisioned = await pool.query("SELECT system_role, status, disabled_at FROM users WHERE username = 'ext'");
  assert.deepEqual(
    { role: provisioned.rows[0].system_role, status: provisioned.rows[0].status },
    { role: "external", status: "pending" }
  );
  // A pending account was never disabled, so the date that describes it is
  // created_at and disabled_at stays null.
  assert.equal(provisioned.rows[0].disabled_at, null);

  // Defaults: a plain insert is an active, regular, local account.
  const id = uuidv7();
  await pool.query("INSERT INTO users (id, username, email, display_name, password_hash) VALUES ($1, 'gio', 'gio@e.org', 'gio', 'h')", [id]);
  const row = await pool.query("SELECT system_role, status, auth_source, session_version FROM users WHERE id = $1", [id]);
  assert.deepEqual(
    { role: row.rows[0].system_role, status: row.rows[0].status, source: row.rows[0].auth_source },
    { role: "regular", status: "active", source: "local" }
  );
  assert.equal(row.rows[0].session_version, 0);

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

test("session versions default to zero and enforce nonnegative integers", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
  const fresh = await insertUser(pool, "fresh", "fresh@example.org");
  const { rows } = await pool.query("SELECT session_version FROM users");
  assert.deepEqual(rows, [{ session_version: 0 }]);
  const column = await pool.query(
    "SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'session_version'"
  );
  assert.equal(column.rows[0].data_type, "integer");
  for (const [value, code] of [[null, "23502"], [-1, "23514"], ["1.5", "22P02"]]) {
    await assert.rejects(pool.query("UPDATE users SET session_version = $1 WHERE id = $2", [value, fresh]), (error) => error.code === code);
  }
  await pool.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [fresh]);
  assert.equal((await pool.query("SELECT session_version FROM users WHERE id = $1", [fresh])).rows[0].session_version, 1);
});

test("project revisions default to zero and enforce nonnegative integers", { skip: !connectionString, timeout: 20000 }, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
  const user = await insertUser(pool, "writer", "writer@example.org");
  const id = uuidv7();
  await pool.query("INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, 'Fresh', $3)", [id, user, projectStorageKey(id)]);
  assert.equal((await pool.query("SELECT revision FROM projects WHERE id = $1", [id])).rows[0].revision, 0);
  for (const [value, code] of [[null, "23502"], [-1, "23514"], ["1.5", "22P02"]]) {
    await assert.rejects(pool.query("UPDATE projects SET revision = $1 WHERE id = $2", [value, id]), (error) => error.code === code);
  }
});

test("document versions form an append-only history keyed to a stable file id", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
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

  // Realtime editing records consolidated checkpoints in the same history.
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
  await initializeSchema(pool);
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
  await initializeSchema(pool);
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

// The retention SQL is the implementation of the K+D rule, so it is verified
// against a real planner rather than against a reimplementation of itself. Every
// case below is one the rule has to get right, and each is a way a naive
// version — count only, or age only — would delete something it must not.
test("retention prunes only what is both surplus and old", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
  const userId = await insertUser(pool, "gio", "gio@example.org");
  const projectId = uuidv7();
  await pool.query(
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
    [projectId, userId, "Thesis", projectStorageKey(projectId)]
  );
  const fileId = uuidv7();
  await pool.query(
    "INSERT INTO project_files (id, project_id, client_ref, path, kind) VALUES ($1, $2, $3, 'main.tex', 'tex')",
    [fileId, projectId, fileId]
  );

  // Ten revisions, one per day going back: index 0 is today, index 9 is nine
  // days old. Age is set explicitly so the test does not depend on wall time.
  const versions = [];
  for (let age = 0; age < 10; age++) {
    const id = uuidv7();
    await pool.query(
      `INSERT INTO document_versions (id, file_id, author_id, author_label, reason, content_hash, content, size, created_at)
       VALUES ($1, $2, $3, 'gio', 'realtime', $4, $5, 4, CURRENT_TIMESTAMP - ($6 || ' days')::interval)`,
      [id, fileId, userId, crypto.createHash("sha256").update(`v${age}`).digest("hex"), `v${age}`, String(age)]
    );
    versions.push({ id, age });
  }

  const pruneVersions = (keep, days) => pool.query(
    `WITH ranked AS (
       SELECT dv.id, dv.created_at,
              ROW_NUMBER() OVER (PARTITION BY dv.file_id ORDER BY dv.created_at DESC, dv.id DESC) AS position
       FROM document_versions dv
       JOIN project_files pf ON pf.id = dv.file_id
       WHERE pf.project_id = $1
     )
     DELETE FROM document_versions dv
     USING ranked
     WHERE dv.id = ranked.id AND ranked.position > $2 AND ranked.created_at < $3`,
    [projectId, keep, new Date(Date.now() - days * 24 * 60 * 60 * 1000)]
  );

  // Old but not surplus: a generous count protects every one of them.
  const untouched = await pruneVersions(50, 1);
  assert.equal(untouched.rowCount, 0, "the count alone must be able to save an old revision");

  // Surplus but not old: a short count does not on its own delete this week's work.
  const stillUntouched = await pruneVersions(3, 365);
  assert.equal(stillUntouched.rowCount, 0, "the age alone must be able to save a surplus revision");

  // Both: keep the newest 4, and of the rest delete only those older than 6 days.
  // That is indexes 6, 7, 8 and 9 — surplus by count and past the age cutoff.
  const pruned = await pruneVersions(4, 6);
  assert.equal(pruned.rowCount, 4);
  const remaining = await pool.query("SELECT id FROM document_versions WHERE file_id = $1", [fileId]);
  const survivors = new Set(remaining.rows.map((row) => row.id));
  assert.equal(survivors.size, 6);
  for (const version of versions.filter((v) => v.age <= 5)) {
    assert.ok(survivors.has(version.id), `revision aged ${version.age} days must survive`);
  }
  // The current content of the file is the one thing that can never go.
  assert.ok(survivors.has(versions[0].id), "the newest revision is never prunable");

  /* ---- builds ---- */
  const sourceHash = crypto.createHash("sha256").update("source").digest("hex");
  const insertBuild = async (age, status) => {
    const id = uuidv7();
    const succeeded = status === "succeeded";
    // The lifecycle CHECK ties status to the shape of the rest of the row, so a
    // succeeded build has to carry its storage path, hash and artifact count
    // while the other two must carry none of them.
    await pool.query(
      `INSERT INTO build_outputs (
         id, project_id, source_file_id, source_content_hash, created_by, created_by_label,
         completed_at, status, project_type, compiler, format, main_path, display_name,
         storage_path, size, content_hash, artifact_count, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'gio', $6, $7,
         'latex', 'pdflatex', 'pdf', 'main.tex', 'main.pdf',
         $8, $9, $10, $11, CURRENT_TIMESTAMP - ($12 || ' days')::interval)`,
      [
        id, projectId, fileId, sourceHash, userId,
        status === "running" ? null : new Date(),
        status,
        succeeded ? `output/${id}` : null,
        succeeded ? 3 : 0,
        succeeded ? sourceHash : null,
        succeeded ? 1 : 0,
        String(age),
      ]
    );
    return id;
  };

  // Six failures spread over a year, and one success older than all of them.
  const oldSuccess = await insertBuild(400, "succeeded");
  const failures = [];
  for (const age of [1, 40, 90, 200, 300, 500]) failures.push({ id: await insertBuild(age, "failed"), age });
  const running = await insertBuild(700, "running");

  const pruneBuilds = (keep, days) => pool.query(
    `WITH ranked AS (
       SELECT id, created_at,
              ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS position
       FROM build_outputs
       WHERE project_id = $1 AND status <> 'running'
     ),
     protected_build AS (
       SELECT id FROM build_outputs
       WHERE project_id = $1 AND status = 'succeeded'
       ORDER BY created_at DESC, id DESC LIMIT 1
     )
     DELETE FROM build_outputs b
     USING ranked
     WHERE b.id = ranked.id
       AND ranked.position > $2
       AND ranked.created_at < $3
       AND b.id NOT IN (SELECT id FROM protected_build)
     RETURNING b.id`,
    [projectId, keep, new Date(Date.now() - days * 24 * 60 * 60 * 1000)]
  );

  // Keep 3, delete the rest once past 30 days. By age the order is 1, 40, 90,
  // 200, 300, 400 (the success), 500 — so positions 4 upward are 200, 300, 400
  // and 500 days old. All are past the cutoff, but the success at 400 days is
  // the project's last good output and survives regardless.
  const removed = await pruneBuilds(3, 30);
  const removedIds = new Set(removed.rows.map((row) => row.id));
  assert.equal(removed.rowCount, 3);
  assert.ok(!removedIds.has(oldSuccess), "the last successful build survives any age");
  assert.ok(!removedIds.has(running), "a build still running owns its directory");
  for (const age of [200, 300, 500]) {
    const failure = failures.find((f) => f.age === age);
    assert.ok(removedIds.has(failure.id), `the failure aged ${age} days should have been pruned`);
  }
  const left = await pool.query("SELECT id, status FROM build_outputs WHERE project_id = $1", [projectId]);
  assert.equal(left.rowCount, 5);
  assert.ok(left.rows.some((row) => row.status === "running"), "the running build is untouched");

  // A revision a build points at can be pruned without taking the build with
  // it: the reference is nulled and the content hash still records the source.
  const buildWithRevision = uuidv7();
  const keptVersion = versions[0].id;
  await pool.query(
    `INSERT INTO build_outputs (
       id, project_id, source_file_id, source_revision_id, source_content_hash, created_by_label,
       completed_at, status, project_type, compiler, format, main_path, display_name
     ) VALUES ($1, $2, $3, $4, $5, 'gio', CURRENT_TIMESTAMP, 'failed', 'latex', 'pdflatex', 'pdf', 'main.tex', 'main.pdf')`,
    [buildWithRevision, projectId, fileId, keptVersion, sourceHash]
  );
  await pool.query("DELETE FROM document_versions WHERE id = $1", [keptVersion]);
  const orphaned = await pool.query(
    "SELECT source_revision_id, source_content_hash FROM build_outputs WHERE id = $1",
    [buildWithRevision]
  );
  assert.equal(orphaned.rows[0].source_revision_id, null);
  assert.equal(orphaned.rows[0].source_content_hash, sourceHash, "provenance survives the pruned revision");
});

// The schema's own floors, which hold even for a value written outside the
// application. The operator's narrower ceiling lives above this layer so it can
// change without a schema change.
test("retention columns admit null and refuse a history-shredding value", { skip: !connectionString }, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
  const userId = await insertUser(pool, "gio", "gio@example.org");
  const projectId = uuidv7();
  // Null on every axis: the project follows the instance default.
  await pool.query(
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
    [projectId, userId, "Defaults", projectStorageKey(projectId)]
  );
  const defaults = await pool.query(
    "SELECT build_keep, build_days, version_keep, version_days FROM projects WHERE id = $1",
    [projectId]
  );
  assert.deepEqual(defaults.rows[0], { build_keep: null, build_days: null, version_keep: null, version_days: null });

  for (const [column, value] of [["build_keep", 0], ["version_keep", 1], ["build_days", 0], ["version_days", 0]]) {
    await assert.rejects(
      pool.query(`UPDATE projects SET ${column} = $1 WHERE id = $2`, [value, projectId]),
      (error) => error.code === "23514",
      `${column} must refuse ${value}`
    );
  }
  for (const [column, value] of [["build_keep", 1000], ["version_keep", 5000], ["build_days", 4000], ["version_days", 4000]]) {
    await assert.rejects(
      pool.query(`UPDATE projects SET ${column} = $1 WHERE id = $2`, [value, projectId]),
      (error) => error.code === "23514",
      `${column} must refuse ${value}`
    );
  }
  await pool.query("UPDATE projects SET build_keep = 50, version_days = 400 WHERE id = $1", [projectId]);
  const stored = await pool.query("SELECT build_keep, version_days FROM projects WHERE id = $1", [projectId]);
  assert.deepEqual(stored.rows[0], { build_keep: 50, version_days: 400 });
});
