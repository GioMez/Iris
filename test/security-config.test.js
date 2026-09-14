const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const server = path.join(root, "src/server.js");

// A configuration failure happens while the module is still loading, so a run
// that is expected to survive it only has to live long enough to prove it did:
// it is cut short rather than waited out on the database connection.
function runWithEnvironment(overrides, unset = [], timeout = 5000) {
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
    timeout,
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

test("SSO auto-provisioning cannot be pointed at an unbounded role", () => {
  // A typo here would grant more access than the operator asked for, and naming
  // the admin role would let the identity provider mint administrators, so both
  // stop the server instead of falling back to a default.
  for (const role of ["admin", "regualr"]) {
    const rejected = runWithEnvironment({ OAUTH_DEFAULT_ROLE: role });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /OAUTH_DEFAULT_ROLE must be either "regular" or "external"/);
  }
  // The new value is accepted and configuration proceeds past it.
  const accepted = runWithEnvironment({ OAUTH_DEFAULT_ROLE: "external" }, [], 1500);
  assert.doesNotMatch(accepted.stderr, /OAUTH_DEFAULT_ROLE/);
});

// Compose secret refusal, restricted-role provisioning, persistent volumes and
// runtime/schema contents are exercised on the actual engines by scripts/smoke.cjs.
