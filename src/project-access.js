// Project authorization model. Pure, so the capability matrix and the last-owner
// invariant are unit-tested without a database.
//
// A project role grants a fixed set of capabilities. Roles are per project and
// distinct from the server role: a server admin gets no project access here.
//
// The server role does constrain project authority in one direction, though: an
// external account is a guest of the organisation, so it neither originates a
// project nor holds the role that answers for one. The two rules below are that
// constraint, and together they keep every owner internal — which is why
// leavesNoOwner below still means what it says.

const PROJECT_ROLES = new Set(["owner", "editor", "viewer"]);

const EXTERNAL_SYSTEM_ROLE = "external";

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

// A project has to start somewhere, and an external account is never that place:
// both the blank-project and the archive-import paths are closed to it, because
// importing an archive it is entitled to download would otherwise recreate the
// project under its own ownership.
function canCreateProjects(systemRole) {
  return systemRole !== EXTERNAL_SYSTEM_ROLE;
}

// Which project roles a given server role may be granted. Owner carries the
// authority to manage membership and to destroy the project, and it is the anchor
// of the at-least-one-owner invariant; an external account holds none of that, so
// it is capped at editor. Everyone else may hold any project role.
function canHoldProjectRole(systemRole, projectRole) {
  if (!isProjectRole(projectRole)) return false;
  if (systemRole !== EXTERNAL_SYSTEM_ROLE) return true;
  return projectRole !== "owner";
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
  EXTERNAL_SYSTEM_ROLE,
  isProjectRole,
  roleHasCapability,
  canCreateProjects,
  canHoldProjectRole,
  leavesNoOwner,
  normalizeMemberSearch,
  escapeLikePattern,
};
