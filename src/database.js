const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

const SCHEMA_FILE = path.resolve(__dirname, "../db/schema.sql");
// Bump for incompatible current-schema changes; SQL comments are not versions.
const CURRENT_SCHEMA_VERSION = 1;
const MINIMUM_POSTGRES_MAJOR = 18;

// A minimum, not an exact match: a newer major is allowed until one is proven
// incompatible, so a routine database upgrade never blocks the application from
// starting. The floor stays at 18 because that is the baseline the schema and
// its tests are exercised against.
function assertSupportedPostgresVersion(versionNumber) {
  const numeric = Number(versionNumber);
  const major = Number.isInteger(numeric) && numeric > 0 ? Math.floor(numeric / 10000) : null;
  if (major === null || major < MINIMUM_POSTGRES_MAJOR) {
    throw new Error(
      `PostgreSQL ${MINIMUM_POSTGRES_MAJOR} or later is required; server reported version number ${versionNumber}`
    );
  }
  return major;
}

function incompatibleSchema(reason) {
  const error = new Error(`Incompatible beta schema: ${reason}. Use a fresh empty database or explicitly reset the beta installation after backup/export; Iris will not reset or convert it automatically.`);
  error.code = "IRIS_SCHEMA_INCOMPATIBLE";
  return error;
}

async function initializeSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT pg_advisory_xact_lock(49524953)");
    const catalog = await client.query(`
      SELECT current_schema() AS schema,
        (SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = 'iris_schema') AS marker,
        EXISTS (SELECT FROM pg_class WHERE relnamespace = current_schema()::regnamespace)
        OR EXISTS (SELECT FROM pg_proc WHERE pronamespace = current_schema()::regnamespace)
        OR EXISTS (SELECT FROM pg_type WHERE typnamespace = current_schema()::regnamespace) AS nonempty
    `);
    const { schema, marker, nonempty } = catalog.rows[0];
    if (!schema) throw new Error("No accessible PostgreSQL application schema in search_path");
    const qualifiedMarker = `"${schema.replace(/"/g, '""')}".iris_schema`;
    if (marker) {
      // Inspect column types before reading: malformed DDL is incompatibility,
      // while connection and permission failures retain PostgreSQL's diagnosis.
      const columns = await client.query(`
        SELECT a.attname, a.atttypid::regtype::text AS type, a.attnotnull
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.oid = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attname
      `, [marker]);
      if (columns.rows.length !== 2 || columns.rows[0].attname !== "singleton" || columns.rows[0].type !== "boolean" || !columns.rows[0].attnotnull ||
          columns.rows[1].attname !== "version" || columns.rows[1].type !== "integer" || !columns.rows[1].attnotnull) {
        throw incompatibleSchema("invalid iris_schema marker definition");
      }
      // Do not filter or LIMIT: extra rows must never be hidden by validation.
      const { rows } = await client.query(`SELECT singleton, version FROM ${qualifiedMarker}`);
      if (rows.length !== 1 || rows[0].singleton !== true) throw incompatibleSchema("expected one iris_schema marker row");
      if (rows[0].version !== CURRENT_SCHEMA_VERSION) throw incompatibleSchema(`expected schema version ${CURRENT_SCHEMA_VERSION}, found ${rows[0].version}`);
      const constraints = await client.query(`
        SELECT
          EXISTS (SELECT FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'singleton'
            WHERE c.conrelid = $1 AND c.contype = 'p' AND c.conkey = ARRAY[a.attnum] AND c.convalidated) AS primary_key,
          EXISTS (SELECT FROM pg_constraint c WHERE c.conrelid = $1 AND c.contype = 'c' AND c.convalidated
            AND pg_get_expr(c.conbin, c.conrelid) = 'singleton') AS singleton_check
      `, [marker]);
      if (!constraints.rows[0].primary_key || !constraints.rows[0].singleton_check) {
        throw incompatibleSchema("invalid iris_schema singleton constraints");
      }
    } else {
      if (nonempty) throw incompatibleSchema("nonempty application schema has no iris_schema marker");
      await client.query(await fs.readFile(SCHEMA_FILE, "utf8"));
      await client.query(`CREATE TABLE ${qualifiedMarker} (
        singleton BOOLEAN PRIMARY KEY CHECK (singleton),
        version INTEGER NOT NULL
      )`);
      await client.query(`INSERT INTO ${qualifiedMarker} (singleton, version) VALUES (TRUE, $1)`, [CURRENT_SCHEMA_VERSION]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createDatabase(options) {
  const pool = new Pool({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    max: options.maxConnections || 8,
    connectionTimeoutMillis: options.connectTimeout,
    idleTimeoutMillis: 30000,
    application_name: "iris",
  });
  pool.on("error", (err) => console.error("Unexpected PostgreSQL pool error", err));

  try {
    const version = await pool.query("SHOW server_version_num");
    assertSupportedPostgresVersion(version.rows[0] && version.rows[0].server_version_num);
    await initializeSchema(pool);
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

module.exports = {
  assertSupportedPostgresVersion,
  createDatabase,
  initializeSchema,
};
