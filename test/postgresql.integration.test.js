const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { runMigrations } = require("../src/database");

const connectionString = process.env.TEST_DATABASE_URL;

test("PostgreSQL migrations enforce Iris data invariants", { skip: !connectionString }, async (t) => {
  const schema = `iris_test_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString, max: 2, options: `-c search_path=${schema}` });

  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  await runMigrations(pool);
  await runMigrations(pool);

  const migrations = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(migrations.rows.map((row) => row.version), ["001_initial.sql"]);

  const user = await pool.query(
    "INSERT INTO users (username, email, display_name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    ["Mario", "Mario@example.org", "Mario", "admin", "hash"]
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO users (username, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
      ["mario", "other@example.org", "Other Mario", "hash"]
    ),
    (error) => error.code === "23505"
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO users (username, email, display_name, password_hash) VALUES ($1, $2, $3, $4)",
      ["other", "mario@EXAMPLE.ORG", "Other", "hash"]
    ),
    (error) => error.code === "23505"
  );

  await pool.query(
    "INSERT INTO projects (id, user_id, name, storage_path) VALUES ($1, $2, $3, $4)",
    ["0123456789abcdef0123456789abcdef", user.rows[0].id, "Score", "/tmp/score"]
  );
  await pool.query("DELETE FROM users WHERE id = $1", [user.rows[0].id]);
  const projects = await pool.query("SELECT COUNT(*) AS n FROM projects");
  assert.equal(Number(projects.rows[0].n), 0);
});
