const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isProjectRole,
  roleHasCapability,
  canCreateProjects,
  canHoldProjectRole,
  leavesNoOwner,
  normalizeMemberSearch,
  escapeLikePattern,
} = require("../src/project-access");

test("the role vocabulary matches the schema", () => {
  assert.ok(isProjectRole("owner") && isProjectRole("editor") && isProjectRole("viewer"));
  assert.ok(!isProjectRole("admin") && !isProjectRole("regular") && !isProjectRole(""));
});

test("the capability matrix matches the roadmap", () => {
  // Owner: everything.
  for (const cap of ["read", "write", "compile", "share", "delete"]) {
    assert.equal(roleHasCapability("owner", cap), true, `owner should have ${cap}`);
  }
  assert.equal(roleHasCapability("owner", "deleteBuild"), true);
  assert.equal(roleHasCapability("editor", "deleteBuild"), false);
  // Editor: read, write, compile — but not share or delete.
  assert.deepEqual(
    ["read", "write", "compile", "share", "delete"].map((c) => roleHasCapability("editor", c)),
    [true, true, true, false, false]
  );
  // Viewer: read only.
  assert.deepEqual(
    ["read", "write", "compile", "share", "delete"].map((c) => roleHasCapability("viewer", c)),
    [true, false, false, false, false]
  );
});

test("an unknown role or capability grants nothing", () => {
  assert.equal(roleHasCapability("intruder", "read"), false);
  assert.equal(roleHasCapability("owner", "teleport"), false);
});

test("the last owner cannot be demoted or removed", () => {
  // No other owner: demotion or removal strands the project.
  assert.equal(leavesNoOwner("owner", "editor", 0), true);
  assert.equal(leavesNoOwner("owner", null, 0), true);
  // With another owner present, both are allowed.
  assert.equal(leavesNoOwner("owner", "editor", 1), false);
  assert.equal(leavesNoOwner("owner", null, 2), false);
});

test("acting on a non-owner never triggers the invariant", () => {
  assert.equal(leavesNoOwner("editor", null, 0), false);
  assert.equal(leavesNoOwner("viewer", "editor", 0), false);
  // Promoting someone to owner is always safe.
  assert.equal(leavesNoOwner("editor", "owner", 0), false);
});

test("only an external account is barred from starting a project", () => {
  assert.equal(canCreateProjects("regular"), true);
  assert.equal(canCreateProjects("admin"), true);
  assert.equal(canCreateProjects("external"), false);
});

test("an external account may hold any project role except owner", () => {
  assert.equal(canHoldProjectRole("external", "editor"), true);
  assert.equal(canHoldProjectRole("external", "viewer"), true);
  assert.equal(canHoldProjectRole("external", "owner"), false);
  // Everyone else is unconstrained by the server role.
  for (const role of ["owner", "editor", "viewer"]) {
    assert.equal(canHoldProjectRole("regular", role), true);
    assert.equal(canHoldProjectRole("admin", role), true);
  }
  // A role outside the vocabulary is never grantable, whoever asks.
  assert.equal(canHoldProjectRole("regular", "intruder"), false);
  assert.equal(canHoldProjectRole("external", ""), false);
});

test("the last-owner invariant still holds because every owner is internal", () => {
  // Nothing can make an external an owner, so leavesNoOwner never has to ask
  // which kind of owner it is counting.
  assert.equal(canHoldProjectRole("external", "owner"), false);
  assert.equal(leavesNoOwner("owner", "editor", 0), true);
});

test("member search requires two characters and has a bounded query", () => {
  assert.equal(normalizeMemberSearch(" a "), null);
  assert.equal(normalizeMemberSearch("  Alice@example.org  "), "Alice@example.org");
  assert.equal(normalizeMemberSearch("x".repeat(120)).length, 100);
});

test("member search treats SQL LIKE metacharacters literally", () => {
  assert.equal(escapeLikePattern("a%b_c\\d"), "a\\%b\\_c\\\\d");
});
