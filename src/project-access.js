// Shared project authorization. The capability matrix and last-owner invariant
// are pure; authorizeProjectRecord applies them to current membership records.
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
// Shared by membership/owner changes and pipeline acceptance/publication.
const PROJECT_OWNER_LOCK = 4952;

const EXTERNAL_SYSTEM_ROLE = "external";

const CAPABILITIES = {
  owner: new Set(["read", "write", "compile", "share", "delete", "deleteBuild", "approvePipeline"]),
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

async function authorizeProjectRecord(queryable, id, user, capability, requestError) {
  const { rows } = await queryable.query(
    `SELECT p.id, p.name, p.storage_path, p.created_at, p.updated_at, p.revision,
            p.build_keep, p.build_days, p.version_keep, p.version_days, m.role
     FROM projects p JOIN project_members m ON m.project_id = p.id
     JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE p.id = $1 AND m.user_id = $2`,
    [id, user.sub]
  );
  if (!rows.length) throw requestError("PROJECT_NOT_FOUND", 404);
  if (!roleHasCapability(rows[0].role, capability)) throw requestError("PROJECT_FORBIDDEN", 403);
  return rows[0];
}

function canCancelRun(role, actorId, submitterId) {
  return role === "owner" || (role === "editor" && actorId === submitterId);
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
  PROJECT_OWNER_LOCK,
  PROJECT_ROLES,
  CAPABILITIES,
  EXTERNAL_SYSTEM_ROLE,
  isProjectRole,
  roleHasCapability,
  authorizeProjectRecord,
  canCancelRun,
  canCreateProjects,
  canHoldProjectRole,
  leavesNoOwner,
  normalizeMemberSearch,
  escapeLikePattern,
};
