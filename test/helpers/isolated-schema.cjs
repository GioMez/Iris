const crypto = require("node:crypto");
const { Pool } = require("pg");

const connectionString = process.env.TEST_DATABASE_URL;

// Only synthetic TEST_DATABASE_URL credentials; every caller owns a fresh schema.
async function isolatedSchema(t) {
  const schema = `iris_schema_${crypto.randomBytes(8).toString("hex")}`;
  const timeouts = { connectionTimeoutMillis: 3000, query_timeout: 7000, statement_timeout: 5000, lock_timeout: 3000, idle_in_transaction_session_timeout: 10000 };
  const admin = new Pool({ connectionString, max: 1, ...timeouts });
  const pool = new Pool({ connectionString, max: 4, ...timeouts, options: `-c search_path=${schema}` });
  t.after(async () => {
    try {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  return pool;
}

module.exports = { connectionString, isolatedSchema };
