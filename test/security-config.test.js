const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const server = path.join(root, "src/server.js");

function runWithEnvironment(overrides, unset = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "iris-config-test-"));
  const env = {
    ...process.env,
    IRIS_SECRET: "test-only-secret-with-sufficient-entropy",
    DB_PASSWORD: "test-only-database-password",
    ...overrides,
  };
  for (const name of unset) delete env[name];
  const result = spawnSync(process.execPath, [server], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  fs.rmSync(cwd, { recursive: true, force: true });
  return result;
}

test("server requires non-default session and database secrets", () => {
  const missingPassword = runWithEnvironment({}, ["DB_PASSWORD"]);
  assert.notEqual(missingPassword.status, 0);
  assert.match(missingPassword.stderr, /DB_PASSWORD must be set to a secure, non-default value/);

  const defaultPassword = runWithEnvironment({ DB_PASSWORD: "iris" });
  assert.notEqual(defaultPassword.status, 0);
  assert.match(defaultPassword.stderr, /DB_PASSWORD must be set to a secure, non-default value/);

  const missingSessionSecret = runWithEnvironment({}, ["IRIS_SECRET"]);
  assert.notEqual(missingSessionSecret.status, 0);
  assert.match(missingSessionSecret.stderr, /IRIS_SECRET must be set to a secure, non-default value/);
});

test("Compose requires secrets and does not expose default credentials", () => {
  const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const postgresInit = fs.readFileSync(path.join(root, "db/init/01-create-iris-user.sh"), "utf8");
  assert.match(compose, /IRIS_SECRET: "\$\{IRIS_SECRET:\?/);
  assert.match(compose, /DB_PASSWORD: "\$\{DB_PASSWORD:\?/);
  assert.match(compose, /POSTGRES_PASSWORD: "\$\{POSTGRES_ADMIN_PASSWORD:\?/);
  assert.match(compose, /pg_isready.*-U.*postgres.*-d.*postgres/);
  assert.match(compose, /image:\s*postgres:18\s*$/m);
  assert.match(compose, /postgres-data:\/var\/lib\/postgresql\s*$/m);
  assert.doesNotMatch(compose, /postgres-data:\/var\/lib\/postgresql\/data\s*$/m);
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*(iris|postgres)\s*$/m);
  assert.match(postgresInit, /CREATE ROLE iris WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(postgresInit, /CREATE DATABASE iris OWNER iris/);
  assert.doesNotMatch(compose, /iris-root|-piris/);
});

test("the PostgreSQL runtime image includes versioned migrations", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.ok(packageJson.dependencies.pg);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /COPY db\/migrations \.\/db\/migrations/);
});
