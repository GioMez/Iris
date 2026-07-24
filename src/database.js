const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../db/migrations");
const MIGRATION_FILE = /^\d+_[a-z0-9_-]+\.sql$/;

async function readMigrations(migrationsDir) {
  const names = (await fs.readdir(migrationsDir))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) throw new Error(`No database migrations found in ${migrationsDir}`);

  return Promise.all(names.map(async (version) => {
    const sql = await fs.readFile(path.join(migrationsDir, version), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    return { version, checksum, sql };
  }));
}

async function runMigrations(pool, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const migrations = await readMigrations(migrationsDir);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(49524953)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const appliedResult = await client.query("SELECT version, checksum FROM schema_migrations");
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.checksum]));
    for (const migration of migrations) {
      const priorChecksum = applied.get(migration.version);
      if (priorChecksum && priorChecksum !== migration.checksum) {
        throw new Error(`Database migration ${migration.version} has changed since it was applied`);
      }
      if (priorChecksum) continue;
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum]
      );
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
    await pool.query("SELECT 1");
    await runMigrations(pool, options.migrationsDir || DEFAULT_MIGRATIONS_DIR);
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

module.exports = {
  createDatabase,
  readMigrations,
  runMigrations,
};
