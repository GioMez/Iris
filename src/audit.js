const { isUuid } = require("./ids");

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const OUTCOMES = new Set(["success", "failure"]);
const TARGET_TYPES = new Set(["system", "user", "session", "project", "membership", "revision", "build"]);

const LIMITS = {
  action: 64,
  actorLabel: 190,
  targetId: 64,
  ip: 45,
};

function clamp(value, max) {
  return String(value).slice(0, max);
}

// Metadata is operational context, never a second copy of the columns above and
// never a place for credentials. Only JSON scalars survive, so a stray object
// cannot smuggle unbounded content into the trail.
function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") out[key] = clamp(value, 500);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function normalizeAuditEvent(event) {
  const action = clamp(String((event && event.action) || "").trim(), LIMITS.action);
  if (!ACTION.test(action)) throw new Error(`Invalid audit action: ${action}`);

  const targetType = String((event && event.targetType) || "").trim();
  if (!TARGET_TYPES.has(targetType)) throw new Error(`Invalid audit target type: ${targetType}`);

  const outcome = String((event && event.outcome) || "success").trim();
  if (!OUTCOMES.has(outcome)) throw new Error(`Invalid audit outcome: ${outcome}`);

  // actor_id is a foreign key to users.id: anything that is not a well formed
  // identifier is dropped rather than sent to PostgreSQL, so an unattributable
  // event is still recorded through actor_label alone.
  const rawActorId = event && event.actorId != null ? String(event.actorId) : "";
  const actorLabel = clamp(String((event && event.actorLabel) || "").trim() || "unknown", LIMITS.actorLabel);
  const targetId = event && event.targetId != null ? clamp(String(event.targetId), LIMITS.targetId) : null;
  const ip = event && event.ip ? clamp(String(event.ip), LIMITS.ip) : null;

  return {
    action,
    outcome,
    actorId: isUuid(rawActorId) ? rawActorId : null,
    actorLabel,
    targetType,
    targetId,
    ip,
    metadata: normalizeMetadata(event && event.metadata),
  };
}

async function recordAuditEvent(db, event) {
  const entry = normalizeAuditEvent(event);
  await db.query(
    `INSERT INTO audit_events (action, outcome, actor_id, actor_label, target_type, target_id, ip, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      entry.action,
      entry.outcome,
      entry.actorId,
      entry.actorLabel,
      entry.targetType,
      entry.targetId,
      entry.ip,
      JSON.stringify(entry.metadata),
    ]
  );
  return entry;
}

module.exports = {
  normalizeAuditEvent,
  recordAuditEvent,
  TARGET_TYPES,
};
