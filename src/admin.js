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

// Physical user deletion is a distinct, protected operation, separate from the
// reversible disable. It is refused when it would be a mistake or strand data,
// and the reasons are ordered by severity so the first blocker is reported.
// Pure so the guard is tested without a database; the sole-owner project count is
// computed by the endpoint. Deleting only a disabled account also means the
// last-active-admin rule is already satisfied (disabling it was blocked earlier).
function userDeletionBlock({ isSelf, status, soleOwnerProjectCount }) {
  if (isSelf) return "self";
  if (status !== "disabled") return "not_disabled";
  if (Number(soleOwnerProjectCount) > 0) return "sole_owner";
  return null;
}

module.exports = {
  SYSTEM_ROLES,
  USER_STATUSES,
  isSystemRole,
  isUserStatus,
  countsAsActiveAdmin,
  leavesNoActiveAdmin,
  normalizeSearch,
  userDeletionBlock,
};
