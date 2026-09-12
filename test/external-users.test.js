const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const server = read("src/server.js");
const migration = read("db/migrations/014_external_users.sql");
const html = read("public/Iris.html");
const css = read("public/iris.css");
const projects = read("public/iris-projects.js");
const admin = read("public/iris-admin.js");
const adminProjects = read("public/iris-admin-projects.js");

test("the schema admits the external role and the pending status", () => {
  assert.match(migration, /system_role IN \('admin', 'regular', 'external'\)/);
  assert.match(migration, /status IN \('active', 'disabled', 'pending'\)/);
});

test("both ways a project comes into existence are closed to an external account", () => {
  // Import counts because downloading an archive is a read capability: without the
  // gate an external member could package a project and import it back as its own.
  const create = server.slice(server.indexOf("async function createProject("), server.indexOf("async function renameProject"));
  assert.match(create, /requireProjectCreation\(user\)/);
  const importer = server.slice(server.indexOf("async function importProjectArchive("));
  assert.match(importer.slice(0, 400), /requireProjectCreation\(user\)/);
  assert.match(server, /function requireProjectCreation\(user\) \{\s*\n\s*if \(!canCreateProjects\(user\.role\)\) throw requestError\("PROJECT_CREATE_FORBIDDEN", 403\)/);
});

test("no path grants ownership to an external account, the admin console included", () => {
  assert.match(server, /function requireGrantableRole\(systemRole, projectRole\) \{[\s\S]*?requestError\("MEMBER_EXTERNAL_NOT_OWNER", 409\)/);
  // project-sharing-auth.test.js exercises owner/admin grants and target-role
  // rechecks through HTTP/PostgreSQL. Updates also read the member's server role
  // in the same locked query that reads their current project role.
  assert.equal((server.match(/requireGrantableRole\(current\.rows\[0\]\.system_role, nextRole\)/g) || []).length, 2);
  assert.equal((server.match(/FOR UPDATE OF m/g) || []).length, 2);
  assert.match(server, /SELECT id, username, email, display_name, system_role FROM users WHERE/);
});

test("turning an account external strips ownership and refuses to strand a project", () => {
  const guard = server.slice(server.indexOf("if (wantsRole && nextRole === \"external\""), server.indexOf("const sets = [\"updated_at = CURRENT_TIMESTAMP\"]"));
  // Locks first, in a fixed order, then counts, then demotes: a concurrent
  // membership change cannot slip between the count and the update.
  assert.match(guard, /role = 'owner' ORDER BY project_id/);
  assert.match(guard, /pg_advisory_xact_lock\(\$1, hashtext\(\$2\)\)/);
  assert.match(guard, /soleOwnerProjects\(targetId, client\)/);
  assert.match(guard, /ADMIN_EXTERNAL_SOLE_OWNER", 409/);
  assert.match(guard, /UPDATE project_members SET role = 'editor'[\s\S]*?RETURNING project_id/);
  // The stripped ownership is audited per project and pushed to open sessions.
  assert.match(server, /for \(const projectId of demotedProjects\) \{[\s\S]*?from: "owner", to: "editor", reason: "external"[\s\S]*?collabRecheckProject\(projectId\)/);
  assert.match(server, /async function soleOwnerProjects\(userId, client = null\)/);
});

test("an unknown SSO identity is provisioned with a bounded role and no access", () => {
  // The provider must never be able to mint an administrator, and a typo must not
  // quietly grant more than the operator asked for.
  assert.match(server, /function autoRegisteredRole\(name, value\) \{[\s\S]*?role !== "regular" && role !== "external"[\s\S]*?throw new Error/);
  assert.match(server, /const OAUTH_DEFAULT_ROLE = autoRegisteredRole\("OAUTH_DEFAULT_ROLE", process\.env\.OAUTH_DEFAULT_ROLE\)/);
  assert.match(server, /const OAUTH_APPROVAL_REQUIRED = String\(process\.env\.OAUTH_APPROVAL_REQUIRED \|\| "true"\) === "true"/);
  // The row is created so an administrator can decide on it; the sign-in that
  // created it is refused.
  assert.match(server, /const status = OAUTH_APPROVAL_REQUIRED \? "pending" : "active"/);
  assert.match(server, /if \(status !== "active"\) throw pendingAccountError\(\)/);
});

test("waiting for approval and having been disabled are told apart", () => {
  assert.match(server, /errorCode = "AUTH_ACCOUNT_PENDING"/);
  assert.match(server, /authError = "account_pending"/);
  assert.match(server, /function inactiveAccountError\(status\) \{\s*\n\s*return status === "pending" \? pendingAccountError\(\) : disabledAccountError\(\)/);
  // oauth-linking.test.js exercises pending/disabled identity and email matches,
  // including real PostgreSQL provisioning conflicts, through the handlers.
  assert.match(server, /pending \? "AUTH_ACCOUNT_PENDING" : "AUTH_ACCOUNT_DISABLED"/);
  // Access checks are an allow-list on 'active', so the new state is refused
  // everywhere without a new check: requireUser is the one that matters most.
  const authentication = server.slice(server.indexOf("async function requireUser("), server.indexOf("function requireAdmin("));
  assert.match(authentication, /if \(!row \|\| row\.status !== "active"(?:\s*\|\|[^;]+)?\) throw requestError\("NOT_AUTHENTICATED", 401\)/);
});

test("the console can filter by pending but cannot assign it", () => {
  assert.match(server, /const statusFilter = url\.searchParams\.get\("status"\);\s*\n\s*if \(isAccountStatus\(statusFilter\)\)/);
  assert.match(server, /if \(wantsStatus && !isUserStatus\(nextStatus\)\) throw requestError\("ADMIN_STATUS_INVALID", 400\)/);
  assert.match(admin, /nextStatus === "pending" \? undefined : nextStatus/);
  assert.match(html, /id="adminEditStatusPending"[^>]*disabled[^>]*hidden/);
  // Approving is its own event: an active/disabled pair should not have to be
  // read backwards to work out what happened.
  assert.match(server, /approved \? "user\.approved" : "user\.status_changed"/);
});

test("the project chooser offers no way in for an account that cannot create one", () => {
  assert.match(html, /id="pkNew"/);
  assert.match(html, /class="btn cta internal-only" id="pkNew"/);
  assert.match(html, /class="btn internal-only" id="pkImport"/);
  assert.match(html, /class="btn cta internal-only" id="pkNewEmpty"/);
  assert.match(html, /class="pe-sub external-only" data-i18n="projects.emptyExternal"/);
  assert.match(css, /html\[data-role="external"\] \.internal-only\{display:none\}/);
  // The server is the authority either way; these only stop the dead ends.
  assert.match(projects, /function askNew\(\) \{\s*\n\s*if \(isExternalUser\(\)\) return;/);
  assert.match(projects, /if \(isExternalUser\(\)\) return;\s*\n\s*void handleProjectImport\(file\)/);
});

test("owner is absent from every role menu offered for an external member", () => {
  assert.match(server, /external: row\.system_role === "external"/);
  assert.match(projects, /rolesForMember = \(external\) => \(external \? PROJECT_ROLES\.filter\(\(role\) => role !== "owner"\) : PROJECT_ROLES\)/);
  assert.match(projects, /const options = rolesForMember\(member\.external\)/);
  assert.match(projects, /function syncShareRoleOptions\(\)[\s\S]*?if \(external && select\.value === "owner"\) select\.value = "editor"/);
  assert.match(adminProjects, /rolesFor = \(member\) => \(member\.external \? ROLES\.filter\(\(role\) => role !== "owner"\) : ROLES\)/);
  assert.match(adminProjects, /const options = rolesFor\(m\)/);
});
