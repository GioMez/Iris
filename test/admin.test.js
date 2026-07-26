const test = require("node:test");
const assert = require("node:assert/strict");

const { isSystemRole, isUserStatus, countsAsActiveAdmin, leavesNoActiveAdmin, normalizeSearch } = require("../src/admin");

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
