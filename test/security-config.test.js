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
  assert.match(compose, /IRIS_SECRET: "\$\{IRIS_SECRET:\?/);
  assert.match(compose, /DB_PASSWORD: "\$\{DB_PASSWORD:\?/);
  assert.match(compose, /MARIADB_ROOT_PASSWORD: "\$\{MARIADB_ROOT_PASSWORD:\?/);
  assert.match(compose, /MARIADB_PASSWORD: "\$\{DB_PASSWORD:\?/);
  assert.match(compose, /healthcheck\.sh.*--connect.*--innodb_initialized/);
  assert.doesNotMatch(compose, /iris-root|-piris/);
});
