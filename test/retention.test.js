const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RETENTION_BOUNDS,
  RETENTION_FIELDS,
  AUDIT_RETENTION_FLOOR_DAYS,
  retentionCaps,
  auditRetentionDays,
  clampRetention,
  normalizeRetentionInput,
  retentionView,
  cutoffDate,
} = require("../src/retention");

const caps = retentionCaps({});

test("an unconfigured project follows the instance default on every axis", () => {
  const resolved = clampRetention({}, caps);
  assert.deepEqual(resolved, {
    buildKeep: 20,
    buildDays: 30,
    versionKeep: 100,
    versionDays: 180,
  });
  // Null is the stored form of "no opinion", and means the same thing.
  assert.deepEqual(clampRetention({ buildKeep: null, buildDays: null, versionKeep: null, versionDays: null }, caps), resolved);
  assert.deepEqual(clampRetention(null, caps), resolved);
});

test("the operator's ceiling wins over the project's choice", () => {
  const strict = retentionCaps({ RETENTION_BUILD_KEEP_MAX: "10", RETENTION_VERSION_DAYS_MAX: "30" });
  const resolved = clampRetention({ buildKeep: 200, versionDays: 1000 }, strict);
  assert.equal(resolved.buildKeep, 10, "a project cannot keep more than the instance permits");
  assert.equal(resolved.versionDays, 30);
});

test("clamping happens on read, so lowering the ceiling takes effect immediately", () => {
  // A value stored while a generous ceiling was in force.
  const stored = { buildKeep: 150 };
  assert.equal(clampRetention(stored, caps).buildKeep, 150);
  // The operator lowers it; the same stored row now resolves to the new limit
  // without anything having to rewrite it.
  const lowered = retentionCaps({ RETENTION_BUILD_KEEP_MAX: "25" });
  assert.equal(clampRetention(stored, lowered).buildKeep, 25);
});

test("the floor stops retention from being turned into a shredder", () => {
  const resolved = clampRetention({ buildKeep: 0, versionKeep: 1, buildDays: 0, versionDays: 0 }, caps);
  assert.equal(resolved.buildKeep, RETENTION_BOUNDS.buildKeep.min);
  assert.equal(resolved.versionKeep, RETENTION_BOUNDS.versionKeep.min);
  assert.equal(resolved.buildDays, RETENTION_BOUNDS.buildDays.min);
  assert.equal(resolved.versionDays, RETENTION_BOUNDS.versionDays.min);
  for (const field of RETENTION_FIELDS) assert.ok(resolved[field] > 0);
});

test("a mistyped environment variable degrades to a working configuration", () => {
  // A ceiling below the floor would leave no satisfiable value at all.
  const broken = retentionCaps({ RETENTION_VERSION_KEEP_MAX: "1" });
  assert.equal(broken.versionKeep.max, RETENTION_BOUNDS.versionKeep.min);
  assert.ok(broken.versionKeep.fallback <= broken.versionKeep.max);
  // A default above the ceiling is pulled back under it.
  const inverted = retentionCaps({ RETENTION_BUILD_KEEP: "500", RETENTION_BUILD_KEEP_MAX: "40" });
  assert.equal(inverted.buildKeep.fallback, 40);
  // Nonsense is ignored rather than propagated.
  const garbage = retentionCaps({ RETENTION_BUILD_DAYS: "soon" });
  assert.equal(garbage.buildDays.fallback, RETENTION_BOUNDS.buildDays.fallback);
});

test("submitted settings are clamped, not rejected, and silence leaves a field alone", () => {
  const input = normalizeRetentionInput({ buildKeep: 9999, versionDays: 2 }, caps);
  assert.equal(input.buildKeep, caps.buildKeep.max);
  assert.equal(input.versionDays, caps.versionDays.min);
  // A field nobody mentioned must not be written, or a UI that sends a partial
  // form would silently reset the rest.
  assert.ok(!("buildDays" in input));
  assert.ok(!("versionKeep" in input));
  // An explicit null is a real choice: go back to following the default.
  assert.deepEqual(normalizeRetentionInput({ buildKeep: null }, caps), { buildKeep: null });
  // Anything that is not a settings object changes nothing.
  assert.deepEqual(normalizeRetentionInput(null, caps), {});
  assert.deepEqual(normalizeRetentionInput([1, 2], caps), {});
  assert.deepEqual(normalizeRetentionInput({ buildKeep: "not a number" }, caps), {});
});

test("the view carries the bounds, so the client never hard-codes a server limit", () => {
  const view = retentionView({ buildKeep: 40 }, caps);
  assert.deepEqual(view.buildKeep, {
    value: 40,
    effective: 40,
    min: caps.buildKeep.min,
    max: caps.buildKeep.max,
    default: caps.buildKeep.fallback,
  });
  // A field with no stored choice reports the default as what is in force.
  assert.equal(view.versionKeep.value, null);
  assert.equal(view.versionKeep.effective, caps.versionKeep.fallback);
  for (const field of RETENTION_FIELDS) {
    assert.ok(view[field].min <= view[field].max);
    assert.ok(view[field].effective >= view[field].min && view[field].effective <= view[field].max);
  }
});

test("audit retention belongs to the operator and has a floor no project can lower", () => {
  assert.equal(auditRetentionDays({}), 365);
  assert.equal(auditRetentionDays({ RETENTION_AUDIT_DAYS: "730" }), 730);
  // A trail short enough to have forgotten the incident is not a trail.
  assert.equal(auditRetentionDays({ RETENTION_AUDIT_DAYS: "1" }), AUDIT_RETENTION_FLOOR_DAYS);
  assert.equal(auditRetentionDays({ RETENTION_AUDIT_DAYS: "0" }), AUDIT_RETENTION_FLOOR_DAYS);
  // Audit retention is deliberately not one of the per-project fields.
  assert.ok(!RETENTION_FIELDS.includes("auditDays"));
});

test("the age cutoff is the instant the window opens", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const cutoff = cutoffDate(30, now);
  assert.equal(cutoff.getTime(), now - 30 * 24 * 60 * 60 * 1000);
  assert.ok(cutoff instanceof Date, "the value is passed straight to a timestamptz parameter");
});
