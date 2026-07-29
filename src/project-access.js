// Project authorization model. Pure, so the capability matrix and the last-owner
// invariant are unit-tested without a database.
//
// A project role grants a fixed set of capabilities. Roles are per project and
// distinct from the server role: a server admin gets no project access here.

const PROJECT_ROLES = new Set(["owner", "editor", "viewer"]);

const CAPABILITIES = {
  owner: new Set(["read", "write", "compile", "share", "delete", "deleteBuild"]),
  editor: new Set(["read", "write", "compile"]),
  viewer: new Set(["read"]),
};

function isProjectRole(value) {
  return PROJECT_ROLES.has(value);
}

function roleHasCapability(role, capability) {
  const set = CAPABILITIES[role];
  return set ? set.has(capability) : false;
}

// The invariant mirror of the last-admin rule: every project keeps at least one
// owner. A change is unsafe when it removes the last owner. `nextRole` is null for
// a member being removed. `otherOwners` counts owners other than the target.
function leavesNoOwner(currentRole, nextRole, otherOwners) {
  const wasOwner = currentRole === "owner";
  const willBeOwner = nextRole === "owner";
  return wasOwner && !willBeOwner && otherOwners === 0;
}

function normalizeMemberSearch(value) {
  const query = String(value || "").trim().slice(0, 100);
  return query.length >= 2 ? query : null;
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

module.exports = {
  PROJECT_ROLES,
  CAPABILITIES,
  isProjectRole,
  roleHasCapability,
  leavesNoOwner,
  normalizeMemberSearch,
  escapeLikePattern,
};
