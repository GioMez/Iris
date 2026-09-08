const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const { createRequire } = require("node:module");
const { compileFunction } = require("node:vm");
const { Pool } = require("pg");
const argon2 = require("argon2");
const { runMigrations } = require("../../src/database");

const connectionString = process.env.TEST_DATABASE_URL;
const serverPath = path.resolve(__dirname, "../../src/server.js");
const requireServer = createRequire(serverPath);
const source = fsSync.readFileSync(serverPath, "utf8");
const secret = "session-tests-only-secret-with-sufficient-entropy";

// Execute the real handlers with an isolated database and controllable I/O waits.
// No production injection API or workspace .env is needed for these tests.
async function serverFixture(t, env = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-session-test-"));
  const schema = `iris_sessions_${crypto.randomBytes(8).toString("hex")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
  const hooks = {};
  let app;
  let server;
  const sockets = new Set();
  t.after(async () => {
    if (app) await app.collabShutdown();
    sockets.forEach((socket) => socket.destroy());
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await runMigrations(pool);
  const injectedDb = {
    async query(sql, params) {
      if (hooks.beforeQuery) await hooks.beforeQuery(sql, params);
      const result = await pool.query(sql, params);
      if (hooks.afterQuery) await hooks.afterQuery(sql, params, result);
      return result;
    },
    connect: () => pool.connect(),
  };
  const localRequire = (name) => {
    if (name === "./env") return { loadDotEnv() {} };
    if (name === "node:fs/promises") return {
      ...fs,
      async readFile(...args) {
        if (hooks.beforeReadFile) await hooks.beforeReadFile(...args);
        return fs.readFile(...args);
      },
    };
    if (name === "argon2") return {
      ...argon2,
      async verify(...args) {
        const result = await argon2.verify(...args);
        if (hooks.afterVerify) await hooks.afterVerify(...args);
        return result;
      },
    };
    return requireServer(name);
  };
  localRequire.resolve = requireServer.resolve;
  app = compileFunction(`${source}\ndb = injectedDb;\nreturn {
    ...module.exports, makeToken, verifyToken, requireUser, userFromOAuthProfile,
    collabSessions, collabHandleMessage, collabJoin, collabRecheckProject, collabShutdown
  };`, ["require", "module", "__filename", "__dirname", "process", "injectedDb"], { filename: serverPath })(
    localRequire, { exports: {} }, serverPath, path.dirname(serverPath),
    { pid: process.pid, env: {
      IRIS_SECRET: secret, DB_PASSWORD: "session-tests-only-password", DATA_DIR: dataDir,
      ARGON2_MEMORY_COST: "1024", ARGON2_TIME_COST: "1", ARGON2_PARALLELISM: "1", ...env,
    } }, injectedDb
  );
  server = http.createServer(app.handle);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  app.collabAttach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookieFor = (user, overrides = {}) => {
    const payload = JSON.parse(Buffer.from(app.makeToken(user).split(".")[0], "base64url"));
    const body = Buffer.from(JSON.stringify({ ...payload, ...overrides })).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    return `iris_session=${body}.${sig}`;
  };
  const request = (pathname, { cookie, method = "GET", body } = {}) => fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { app, pool, hooks, dataDir, baseUrl, cookieFor, request };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

module.exports = { connectionString, serverFixture, deferred };
