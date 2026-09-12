const test = require("node:test");
const assert = require("node:assert/strict");

const crypto = require("node:crypto");
const { Pool } = require("pg");
const { assertSupportedPostgresVersion, createDatabase } = require("../src/database");
const { connectionString } = require("./helpers/isolated-schema.cjs");

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
  assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version: 1 }]);
  await pool.query("INSERT INTO audit_events (action, actor_label, target_type) VALUES ('startup.test', 'operator', 'system')");
  await pool.end();
  pool = null;
  pool = await createDatabase(options);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM audit_events")).rows[0].n, 1);
  await pool.query("UPDATE iris_schema SET version = 2");
  await pool.end();
  pool = null;
  await assert.rejects(createDatabase(options), { code: "IRIS_SCHEMA_INCOMPATIBLE" });
  assert.equal((await admin.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [database])).rows[0].n, 0, "failed startup closes its pool");
});
