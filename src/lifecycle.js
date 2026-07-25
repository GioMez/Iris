// Request-lifecycle gate, kept pure so its decision table is unit-tested without
// a live server. It expresses the two operational states the process can be in:
//
// - maintenance: a reversible window the operator opens for a consistent backup
//   or restore. Reads keep working; anything that would write is refused so the
//   database and the filesystem can be copied at a mutually consistent point.
// - shutting down: a SIGTERM arrived and no new work must start while in-flight
//   requests drain.
//
// The health endpoint is always answered so an operator script or load balancer
// can observe both states even while everything else is refused.

const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
const HEALTH_PATH = "/api/health";

function isMutatingMethod(method) {
  return MUTATING_METHODS.has(String(method || "").toUpperCase());
}

function lifecycleGate({ method, pathname, shuttingDown, maintenance }) {
  if (pathname === HEALTH_PATH) return null;
  if (shuttingDown) return { status: 503, code: "SERVER_SHUTTING_DOWN" };
  if (maintenance && isMutatingMethod(method) && String(pathname).startsWith("/api/")) {
    return { status: 503, code: "MAINTENANCE_MODE" };
  }
  return null;
}

function healthStatus({ shuttingDown, maintenance }) {
  if (shuttingDown) return "shutting_down";
  if (maintenance) return "maintenance";
  return "ok";
}

module.exports = { isMutatingMethod, lifecycleGate, healthStatus, HEALTH_PATH };
