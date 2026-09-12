const test = require("node:test");
const assert = require("node:assert/strict");
const { initializeSchema } = require("../src/database");
const { connectionString, isolatedSchema } = require("./helpers/isolated-schema.cjs");

const options = { skip: !connectionString, timeout: 15000 };
const incompatible = (error) => error.code === "IRIS_SCHEMA_INCOMPATIBLE" && /incompatible beta schema/i.test(error.message) && /fresh|reset/i.test(error.message);
const objects = async (pool) => (await pool.query(
  "SELECT oid, relname, relkind FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY relname"
)).rows;

test("fresh initialization creates current tables and a constrained singleton version marker", options, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
  assert.deepEqual((await objects(pool)).filter((row) => row.relkind === "r").map((row) => row.relname), [
    "audit_events", "build_artifacts", "build_outputs", "document_versions", "iris_schema",
    "project_deletions", "project_files", "project_members", "projects", "users",
  ]);
  assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version: 1 }]);
  await assert.rejects(pool.query("INSERT INTO iris_schema VALUES (TRUE, 1)"), { code: "23505" });
  await assert.rejects(pool.query("INSERT INTO iris_schema VALUES (FALSE, 1)"), { code: "23514" });
  await assert.rejects(pool.query("UPDATE iris_schema SET version = NULL"), { code: "23502" });
  const columns = (await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name IN ('legacy_storage_path', 'session_epoch')")).rows;
  assert.deepEqual(columns, []);
});

test("repeat initialization preserves rows, identities and the explicit version", options, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
  await pool.query("INSERT INTO audit_events (action, actor_label, target_type, metadata) VALUES ('startup.test', 'operator', 'system', '{\"bytes\":\"original\\r\\ntext\"}')");
  const before = (await pool.query("SELECT * FROM audit_events")).rows;
  const catalog = await objects(pool);
  await initializeSchema(pool);
  assert.deepEqual((await pool.query("SELECT * FROM audit_events")).rows, before);
  assert.deepEqual(await objects(pool), catalog);
  assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version: 1 }]);
});

for (const isolation of ["read committed", "repeatable read"]) {
  test(`concurrent fresh initializers publish one schema with ${isolation} session defaults`, options, async (t) => {
    const pool = await isolatedSchema(t);
    const barrier = await pool.connect();
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    const pids = await Promise.all(clients.map(async (client) => (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
    const pending = [];
    try {
      for (const client of clients) {
        await client.query("SELECT set_config('default_transaction_isolation', $1, false)", [isolation]);
      }
      await barrier.query("BEGIN");
      await barrier.query("SELECT pg_advisory_xact_lock(49524953)");
      for (const client of clients) pending.push(initializeSchema({ connect: async () => ({ query: client.query.bind(client), release() {} }) }));
      // PostgreSQL itself confirms both waiters reached the lock, rather than a sleep.
      const deadline = Date.now() + 2500;
      while (true) {
        const waiting = await barrier.query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE pid = ANY($1::int[]) AND locktype = 'advisory' AND NOT granted", [pids]);
        if (waiting.rows[0].n === 2) break;
        assert.ok(Date.now() < deadline, "both initializers must wait on the initialization lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(await objects(barrier), [], "no DDL is visible before admission");
      await barrier.query("COMMIT");
      await Promise.all(pending);
      assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version: 1 }]);
      for (const client of clients) {
        assert.equal((await client.query("SHOW default_transaction_isolation")).rows[0].default_transaction_isolation, isolation);
      }
    } finally {
      await barrier.query("ROLLBACK");
      await Promise.allSettled(pending);
      clients.forEach((client) => client.release());
      barrier.release();
    }
  });
}

test("an unmarked nonempty schema is refused with its original rows and bytes untouched", options, async (t) => {
  const pool = await isolatedSchema(t);
  await pool.query("CREATE TABLE beta_payload (id INTEGER PRIMARY KEY, payload BYTEA NOT NULL)");
  const bytes = Buffer.from([0, 255, 13, 10, 128, 1]);
  await pool.query("INSERT INTO beta_payload VALUES (7, $1)", [bytes]);
  const before = await objects(pool);
  await assert.rejects(initializeSchema(pool), incompatible);
  assert.deepEqual(await objects(pool), before);
  assert.deepEqual((await pool.query("SELECT * FROM beta_payload")).rows, [{ id: 7, payload: bytes }]);
});

test("an old unmarked application table is refused without altering its definition or data", options, async (t) => {
  const pool = await isolatedSchema(t);
  await pool.query("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (42, 'original')");
  const before = await objects(pool);
  await assert.rejects(initializeSchema(pool), incompatible);
  assert.deepEqual(await objects(pool), before);
  assert.deepEqual((await pool.query("SELECT * FROM users")).rows, [{ id: 42, username: "original" }]);
});

for (const ddl of ["CREATE SEQUENCE reserved_ids", "CREATE VIEW reserved_view AS SELECT 1 AS id", "CREATE TYPE reserved_kind AS ENUM ('original')", "CREATE FUNCTION reserved_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'"]) {
  test(`non-table schema objects prevent fresh initialization: ${ddl.split(" ").slice(0, 3).join(" ")}`, options, async (t) => {
    const pool = await isolatedSchema(t);
    await pool.query(ddl);
    const before = await objects(pool);
    await assert.rejects(initializeSchema(pool), incompatible);
    assert.deepEqual(await objects(pool), before);
  });
}

for (const version of [0, 2]) {
  test(`schema version ${version} is refused without rewriting the marker or current rows`, options, async (t) => {
    const pool = await isolatedSchema(t);
    await initializeSchema(pool);
    await pool.query("INSERT INTO audit_events (action, actor_label, target_type) VALUES ('startup.test', 'operator', 'system')");
    const rows = (await pool.query("SELECT * FROM audit_events")).rows;
    await pool.query("UPDATE iris_schema SET version = $1", [version]);
    const before = await objects(pool);
    await assert.rejects(initializeSchema(pool), incompatible);
    assert.deepEqual(await objects(pool), before);
    assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version }]);
    assert.deepEqual((await pool.query("SELECT * FROM audit_events")).rows, rows);
  });
}

for (const [name, ddl] of [
  ["missing row", "CREATE TABLE iris_schema (singleton BOOLEAN PRIMARY KEY CHECK (singleton), version INTEGER NOT NULL)"],
  ["extra row", "CREATE TABLE iris_schema (singleton BOOLEAN NOT NULL, version INTEGER NOT NULL); INSERT INTO iris_schema VALUES (TRUE, 1), (FALSE, 1)"],
  ["duplicate row", "CREATE TABLE iris_schema (singleton BOOLEAN NOT NULL, version INTEGER NOT NULL); INSERT INTO iris_schema VALUES (TRUE, 1), (TRUE, 1)"],
  ["false singleton", "CREATE TABLE iris_schema (singleton BOOLEAN PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO iris_schema VALUES (FALSE, 1)"],
  ["null version", "CREATE TABLE iris_schema (singleton BOOLEAN PRIMARY KEY, version INTEGER); INSERT INTO iris_schema VALUES (TRUE, NULL)"],
  ["wrong columns", "CREATE TABLE iris_schema (old_version TEXT); INSERT INTO iris_schema VALUES ('1')"],
  ["text version", "CREATE TABLE iris_schema (singleton BOOLEAN PRIMARY KEY, version TEXT NOT NULL); INSERT INTO iris_schema VALUES (TRUE, '1')"],
  ["view", "CREATE VIEW iris_schema AS SELECT TRUE AS singleton, 1 AS version"],
  ["unconstrained singleton", "CREATE TABLE iris_schema (singleton BOOLEAN NOT NULL, version INTEGER NOT NULL); INSERT INTO iris_schema VALUES (TRUE, 1)"],
  ["missing singleton check", "CREATE TABLE iris_schema (singleton BOOLEAN PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO iris_schema VALUES (TRUE, 1)"],
  ["unvalidated singleton check", "CREATE TABLE iris_schema (singleton BOOLEAN PRIMARY KEY, version INTEGER NOT NULL); ALTER TABLE iris_schema ADD CHECK (singleton) NOT VALID; INSERT INTO iris_schema VALUES (TRUE, 1)"],
]) {
  test(`malformed marker (${name}) is refused without repair`, options, async (t) => {
    const pool = await isolatedSchema(t);
    await pool.query(ddl);
    const before = await objects(pool);
    const rows = (await pool.query("SELECT * FROM iris_schema")).rows;
    await assert.rejects(initializeSchema(pool), incompatible);
    assert.deepEqual(await objects(pool), before);
    assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, rows);
  });
}

test("DDL failure rolls back every object and permits a clean retry", options, async (t) => {
  const pool = await isolatedSchema(t);
  let injected = false;
  const failing = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          const result = await client.query(sql, params);
          const current = await client.query("SELECT to_regclass('users') AS users");
          if (!injected && current.rows[0].users) {
            injected = true;
            // A real PostgreSQL DDL error after the baseline has created objects.
            await client.query("CREATE TABLE users (duplicate INTEGER)");
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  await assert.rejects(initializeSchema(failing), { code: "42P07" });
  assert.equal(injected, true);
  assert.deepEqual(await objects(pool), []);
  await initializeSchema(pool);
  assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version: 1 }]);
});

test("initialization identifies only the first application schema in the search path", options, async (t) => {
  const other = await isolatedSchema(t);
  const pool = await isolatedSchema(t);
  await initializeSchema(other);
  const otherSchema = (await other.query("SELECT current_schema() AS name")).rows[0].name;
  const schema = (await pool.query("SELECT current_schema() AS name")).rows[0].name;
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schema}, ${otherSchema}`);
    await initializeSchema({ connect: async () => ({ query: client.query.bind(client), release() {} }) });
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r'")).rows[0].n, 10);
    assert.deepEqual((await client.query(`SELECT * FROM ${schema}.iris_schema`)).rows, [{ singleton: true, version: 1 }]);
  } finally { client.release(); }
});

test("connection errors retain their cause instead of requesting a schema reset", async () => {
  const failure = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  await assert.rejects(initializeSchema({ connect: async () => { throw failure; } }), (error) => error === failure);
});

test("permission errors retain PostgreSQL's diagnosis instead of requesting a schema reset", options, async (t) => {
  const pool = await isolatedSchema(t);
  await initializeSchema(pool);
  const schema = (await pool.query("SELECT current_schema() AS name")).rows[0].name;
  const role = `${schema}_reader`;
  await pool.query(`CREATE ROLE ${role}; GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  const restricted = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          if (/^BEGIN\b/.test(sql)) {
            await client.query(sql, params);
            return client.query(`SET LOCAL ROLE ${role}`);
          }
          return client.query(sql, params);
        },
        release: () => client.release(),
      };
    },
  };
  try {
    await assert.rejects(initializeSchema(restricted), { code: "42501", message: "permission denied for table iris_schema" });
    assert.deepEqual((await pool.query("SELECT * FROM iris_schema")).rows, [{ singleton: true, version: 1 }]);
  } finally {
    await pool.query(`REVOKE USAGE ON SCHEMA ${schema} FROM ${role}; DROP ROLE ${role}`);
  }
});
