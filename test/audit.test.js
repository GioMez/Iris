const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeAuditEvent, recordAuditEvent } = require("../src/audit");

const ACTOR = "019f99b9-61cf-7fee-963f-8f7dee086983";
const TARGET = "019f99bb-6923-7322-a37d-c8f46b5e5cc9";
const baseEvent = { action: "project.deleted", actorId: ACTOR, actorLabel: "mario", targetType: "project" };

test("audit events keep a readable actor and a constrained taxonomy", () => {
  const entry = normalizeAuditEvent({ ...baseEvent, targetId: TARGET, ip: "203.0.113.7" });
  assert.deepEqual(entry, {
    action: "project.deleted",
    outcome: "success",
    actorId: ACTOR,
    actorLabel: "mario",
    targetType: "project",
    targetId: TARGET,
    ip: "203.0.113.7",
    metadata: {},
  });

  for (const invalid of ["", "deleted", "Project.Deleted", "project..deleted", "project.deleted."]) {
    assert.throws(() => normalizeAuditEvent({ ...baseEvent, action: invalid }), /Invalid audit action/);
  }
  assert.throws(() => normalizeAuditEvent({ ...baseEvent, targetType: "invoice" }), /Invalid audit target type/);
  assert.throws(() => normalizeAuditEvent({ ...baseEvent, outcome: "maybe" }), /Invalid audit outcome/);
});

test("unattributable events stay recordable without inventing an actor", () => {
  // A malformed actor id must be dropped: it is a foreign key to users.id.
  const entry = normalizeAuditEvent({
    action: "auth.login_failed",
    outcome: "failure",
    actorId: "7",
    actorLabel: "",
    targetType: "user",
  });
  assert.equal(entry.actorId, null);
  assert.equal(entry.actorLabel, "unknown");
  assert.equal(entry.targetId, null);
  assert.equal(entry.ip, null);
});

test("metadata carries only bounded JSON scalars", () => {
  const entry = normalizeAuditEvent({
    ...baseEvent,
    metadata: {
      reason: "x".repeat(900),
      count: 3,
      enabled: false,
      skippedNull: null,
      skippedNested: { a: 1 },
      skippedList: [1, 2],
      skippedFn: () => {},
      skippedNaN: Number.NaN,
    },
  });
  assert.deepEqual(Object.keys(entry.metadata).sort(), ["count", "enabled", "reason"]);
  assert.equal(entry.metadata.reason.length, 500);

  for (const invalid of [null, "text", ["a"], 5]) {
    assert.deepEqual(normalizeAuditEvent({ ...baseEvent, metadata: invalid }).metadata, {});
  }
});

test("oversized identities are truncated to the stored column widths", () => {
  const entry = normalizeAuditEvent({
    ...baseEvent,
    actorLabel: "a".repeat(400),
    targetId: "b".repeat(200),
    ip: "c".repeat(80),
  });
  assert.equal(entry.actorLabel.length, 190);
  assert.equal(entry.targetId.length, 64);
  assert.equal(entry.ip.length, 45);
});

test("recording sends normalized values and serialized metadata to PostgreSQL", async () => {
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; } };
  await recordAuditEvent(db, { ...baseEvent, targetId: TARGET, metadata: { name: "Score" } });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO audit_events/);
  assert.deepEqual(calls[0].params, [
    "project.deleted", "success", ACTOR, "mario", "project", TARGET, null, '{"name":"Score"}',
  ]);
});

test("an invalid event is rejected before it reaches the database", async () => {
  const db = { async query() { throw new Error("must not be called"); } };
  await assert.rejects(recordAuditEvent(db, { action: "nope", targetType: "user" }), /Invalid audit action/);
});
