const test = require("node:test");
const assert = require("node:assert/strict");

const { isSystemRole, isUserStatus, countsAsActiveAdmin, leavesNoActiveAdmin, normalizeSearch, userDeletionBlock } = require("../src/admin");

test("role and status vocabularies match the schema", () => {
  assert.ok(isSystemRole("admin") && isSystemRole("regular"));
  assert.ok(!isSystemRole("user") && !isSystemRole("owner") && !isSystemRole(""));
  assert.ok(isUserStatus("active") && isUserStatus("disabled"));
  assert.ok(!isUserStatus("deleted") && !isUserStatus(""));
});

test("only an active admin counts toward the invariant", () => {
  assert.equal(countsAsActiveAdmin({ system_role: "admin", status: "active" }), true);
  assert.equal(countsAsActiveAdmin({ system_role: "admin", status: "disabled" }), false);
  assert.equal(countsAsActiveAdmin({ system_role: "regular", status: "active" }), false);
});

test("the last active admin cannot be demoted, disabled, or both", () => {
  const admin = { system_role: "admin", status: "active" };
  // No other active admin: demoting or disabling would leave none.
  assert.equal(leavesNoActiveAdmin(admin, { system_role: "regular" }, 0), true);
  assert.equal(leavesNoActiveAdmin(admin, { status: "disabled" }, 0), true);
  assert.equal(leavesNoActiveAdmin(admin, { system_role: "regular", status: "disabled" }, 0), true);
  // With another active admin present, the same changes are allowed.
  assert.equal(leavesNoActiveAdmin(admin, { system_role: "regular" }, 1), false);
  assert.equal(leavesNoActiveAdmin(admin, { status: "disabled" }, 2), false);
});

test("changes that keep the target an active admin are always safe", () => {
  const admin = { system_role: "admin", status: "active" };
  // A no-op or a profile-only change keeps admin-ness.
  assert.equal(leavesNoActiveAdmin(admin, {}, 0), false);
  assert.equal(leavesNoActiveAdmin(admin, { system_role: "admin", status: "active" }, 0), false);
});

test("acting on a non-admin never triggers the invariant", () => {
  const regular = { system_role: "regular", status: "active" };
  assert.equal(leavesNoActiveAdmin(regular, { status: "disabled" }, 0), false);
  const disabledAdmin = { system_role: "admin", status: "disabled" };
  // Already not counted; demoting it removes nobody from the active set.
  assert.equal(leavesNoActiveAdmin(disabledAdmin, { system_role: "regular" }, 0), false);
});

test("search terms are trimmed, lowercased, bounded, or nulled", () => {
  assert.equal(normalizeSearch("  Mario  "), "mario");
  assert.equal(normalizeSearch(""), null);
  assert.equal(normalizeSearch(null), null);
  assert.equal(normalizeSearch("x".repeat(300)).length, 190);
});

test("user deletion is blocked in order: self, then not-disabled, then sole owner", () => {
  // Deleting yourself is refused regardless of anything else.
  assert.equal(userDeletionBlock({ isSelf: true, status: "disabled", soleOwnerProjectCount: 0 }), "self");
  assert.equal(userDeletionBlock({ isSelf: true, status: "active", soleOwnerProjectCount: 5 }), "self");
  // Physical deletion is only allowed on an already-disabled account.
  assert.equal(userDeletionBlock({ isSelf: false, status: "active", soleOwnerProjectCount: 0 }), "not_disabled");
  // A disabled account that is the sole owner of a project must be resolved first.
  assert.equal(userDeletionBlock({ isSelf: false, status: "disabled", soleOwnerProjectCount: 2 }), "sole_owner");
  // Disabled, not self, owns no orphan-making project: deletion may proceed.
  assert.equal(userDeletionBlock({ isSelf: false, status: "disabled", soleOwnerProjectCount: 0 }), null);
});
