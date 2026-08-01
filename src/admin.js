const SYSTEM_ROLES = new Set(["admin", "regular", "external"]);
// Two vocabularies, deliberately different. ACCOUNT_STATUSES is what the schema
// stores and what the console may filter by; USER_STATUSES is what an
// administrator may *set*. 'pending' is missing from the second one because it is
// a state an account is provisioned into and only ever leaves: approving it makes
// it active, refusing it makes it disabled, and nothing puts an account back.
const ACCOUNT_STATUSES = new Set(["active", "disabled", "pending"]);
const USER_STATUSES = new Set(["active", "disabled"]);

function isSystemRole(value) {
  return SYSTEM_ROLES.has(value);
}

function isUserStatus(value) {
  return USER_STATUSES.has(value);
}

function isAccountStatus(value) {
  return ACCOUNT_STATUSES.has(value);
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
// computed by the endpoint. Only a non-active account can be deleted, which also
// means the last-active-admin rule is already satisfied (disabling it was blocked
// earlier). A pending account qualifies without first being disabled: turning
// away a stranger the IdP provisioned should not require pretending they once had
// access. Note that deleting one is not a durable refusal — the same SSO identity
// signing in again is provisioned afresh — so refusing for good means leaving the
// account pending or disabling it, where the identity match finds it and stops.
function userDeletionBlock({ isSelf, status, soleOwnerProjectCount }) {
  if (isSelf) return "self";
  if (status !== "disabled" && status !== "pending") return "not_disabled";
  if (Number(soleOwnerProjectCount) > 0) return "sole_owner";
  return null;
}

module.exports = {
  SYSTEM_ROLES,
  ACCOUNT_STATUSES,
  USER_STATUSES,
  isSystemRole,
  isUserStatus,
  isAccountStatus,
  countsAsActiveAdmin,
  leavesNoActiveAdmin,
  normalizeSearch,
  userDeletionBlock,
};
