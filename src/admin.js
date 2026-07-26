const SYSTEM_ROLES = new Set(["admin", "regular"]);
const USER_STATUSES = new Set(["active", "disabled"]);

function isSystemRole(value) {
  return SYSTEM_ROLES.has(value);
}

function isUserStatus(value) {
  return USER_STATUSES.has(value);
}

function countsAsActiveAdmin(user) {
  return user.system_role === "admin" && user.status === "active";
}

// The core invariant: at least one active admin must always remain. Given the
// target's current and intended state and how many OTHER active admins exist, a
// change is unsafe when it removes the last active admin. Pure, so the rule is
// tested without a database.
function leavesNoActiveAdmin(current, next, otherActiveAdmins) {
  const wasActiveAdmin = countsAsActiveAdmin(current);
  const willBeActiveAdmin = countsAsActiveAdmin({
    system_role: next.system_role ?? current.system_role,
    status: next.status ?? current.status,
  });
  return wasActiveAdmin && !willBeActiveAdmin && otherActiveAdmins === 0;
}

// Normalizes a free-text search into a bounded lowercase term, or null when the
// caller passed nothing usable.
function normalizeSearch(value) {
  const term = String(value || "").trim().toLowerCase().slice(0, 190);
  return term || null;
}

module.exports = {
  SYSTEM_ROLES,
  USER_STATUSES,
  isSystemRole,
  isUserStatus,
  countsAsActiveAdmin,
  leavesNoActiveAdmin,
  normalizeSearch,
};
