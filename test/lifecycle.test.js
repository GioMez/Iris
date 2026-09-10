const test = require("node:test");
const assert = require("node:assert/strict");

const { isMutatingMethod, isWriteRequest, lifecycleGate, healthStatus, HEALTH_PATH } = require("../src/lifecycle");

const RUNNING = { shuttingDown: false, maintenance: false };
const MAINTENANCE = { shuttingDown: false, maintenance: true };
const SHUTTING_DOWN = { shuttingDown: true, maintenance: false };

test("mutating methods are recognised case-insensitively", () => {
  for (const method of ["POST", "put", "Delete", "PATCH"]) assert.equal(isMutatingMethod(method), true);
  for (const method of ["GET", "HEAD", "OPTIONS", "", null]) assert.equal(isMutatingMethod(method), false);
});

test("a running server gates nothing", () => {
  assert.equal(lifecycleGate({ method: "POST", pathname: "/api/projects", ...RUNNING }), null);
  assert.equal(lifecycleGate({ method: "GET", pathname: "/api/projects", ...RUNNING }), null);
});

test("maintenance refuses writes but keeps reads and health", () => {
  assert.deepEqual(
    lifecycleGate({ method: "POST", pathname: "/api/projects", ...MAINTENANCE }),
    { status: 503, code: "MAINTENANCE_MODE" }
  );
  assert.deepEqual(
    lifecycleGate({ method: "DELETE", pathname: "/api/projects/abc", ...MAINTENANCE }),
    { status: 503, code: "MAINTENANCE_MODE" }
  );
  // Reads keep working so a user can still view during a backup window.
  assert.equal(lifecycleGate({ method: "GET", pathname: "/api/projects", ...MAINTENANCE }), null);
  // Health is answered in every state.
  assert.equal(lifecycleGate({ method: "GET", pathname: HEALTH_PATH, ...MAINTENANCE }), null);
});

test("maintenance does not gate non-api mutations", () => {
  // Static assets are GET-only; a stray POST elsewhere is left to normal handling.
  assert.equal(lifecycleGate({ method: "POST", pathname: "/upload", ...MAINTENANCE }), null);
});

test("SSO callbacks are writes even when a failed GET only records an audit event", () => {
  assert.deepEqual(lifecycleGate({ method: "GET", pathname: "/api/auth/sso/callback", ...MAINTENANCE }),
    { status: 503, code: "MAINTENANCE_MODE" });
  for (const [method, pathname, expected] of [
    ["GET", "/api/auth/sso/callback", true],
    ["post", "/api/unknown", true],
    ["GET", "/api/auth/sso/start", false],
    ["GET", "/api/project-templates", false],
    ["GET", "/api/projects", false],
    ["POST", "/upload", false],
  ]) assert.equal(isWriteRequest(method, pathname), expected, `${method} ${pathname}`);
});

test("shutting down refuses everything except health", () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    assert.deepEqual(
      lifecycleGate({ method, pathname: "/api/projects", ...SHUTTING_DOWN }),
      { status: 503, code: "SERVER_SHUTTING_DOWN" }
    );
  }
  assert.deepEqual(
    lifecycleGate({ method: "GET", pathname: "/index.html", ...SHUTTING_DOWN }),
    { status: 503, code: "SERVER_SHUTTING_DOWN" }
  );
  assert.equal(lifecycleGate({ method: "GET", pathname: HEALTH_PATH, ...SHUTTING_DOWN }), null);
});

test("shutdown takes precedence over maintenance", () => {
  assert.deepEqual(
    lifecycleGate({ method: "GET", pathname: "/api/projects", shuttingDown: true, maintenance: true }),
    { status: 503, code: "SERVER_SHUTTING_DOWN" }
  );
});

test("health status names the current state", () => {
  assert.equal(healthStatus(RUNNING), "ok");
  assert.equal(healthStatus(MAINTENANCE), "maintenance");
  assert.equal(healthStatus(SHUTTING_DOWN), "shutting_down");
  // Shutdown wins if both are set.
  assert.equal(healthStatus({ shuttingDown: true, maintenance: true }), "shutting_down");
});
