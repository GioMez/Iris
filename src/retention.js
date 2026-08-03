// Retention policy: how long a project keeps its compilation outputs and its
// file history. Pure, so the whole decision table is unit-tested without a
// database, and so the one place that decides an effective threshold is the one
// place the server calls.
//
// Two axes, and both must be crossed before anything is deleted:
//
//   * `keep` — how many of the newest entries are retained unconditionally;
//   * `days` — how old an entry must be before it is even a candidate.
//
// A row is pruned only when it is *outside the newest `keep`* AND *older than
// `days`*. Either alone would be a foot-gun: a count alone deletes this
// morning's work on a busy afternoon, and an age alone empties the history of a
// project nobody has touched in a year. Requiring both means the recent past is
// always intact and the distant past is only trimmed once it is genuinely
// redundant.
//
// Authority is split. The owner tunes the numbers for their project; the
// operator sets the ceiling the owner cannot exceed, because the disk belongs to
// the instance and not to any one project. Every value the server acts on has
// therefore passed through `clampRetention`, which is what makes "configurable,
// but not unboundedly long" true rather than merely intended.

// Floors exist for the same reason ceilings do, pointing the other way: an owner
// lowering `keep` to zero would turn retention into a history shredder, and the
// promise the editor makes about recoverable work would stop holding. The floor
// is the smallest setting under which that promise still means something.
const RETENTION_BOUNDS = {
  buildKeep: { min: 3, max: 200, fallback: 20 },
  buildDays: { min: 1, max: 365, fallback: 30 },
  versionKeep: { min: 10, max: 1000, fallback: 100 },
  versionDays: { min: 7, max: 1095, fallback: 180 },
};

const RETENTION_FIELDS = Object.keys(RETENTION_BOUNDS);

// Audit retention is deliberately not a project setting. The trail records who
// did what to whom across the instance, so a project owner is exactly the wrong
// authority over how long it survives; and its floor is high because a trail
// that has already forgotten the incident is not a trail.
const AUDIT_RETENTION_FLOOR_DAYS = 90;
const AUDIT_RETENTION_DEFAULT_DAYS = 365;

function toInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : null;
}

function bound(value, min, max, fallback) {
  const numeric = toInteger(value);
  if (numeric === null) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

// The operator's ceiling and default for every field, read once at startup.
// A ceiling below the floor would make the field unsatisfiable, so the ceiling
// is raised to the floor rather than left to produce an empty range; and a
// default outside the resulting range is pulled back into it, so a mistyped
// environment variable degrades to a working configuration instead of a broken
// one.
function retentionCaps(env = {}) {
  const caps = {};
  for (const field of RETENTION_FIELDS) {
    const { min, max, fallback } = RETENTION_BOUNDS[field];
    const screaming = field.replace(/([A-Z])/g, "_$1").toUpperCase();
    const ceiling = Math.max(min, bound(env[`RETENTION_${screaming}_MAX`], min, max, max));
    const fallbackValue = Math.min(ceiling, Math.max(min, bound(env[`RETENTION_${screaming}`], min, ceiling, fallback)));
    caps[field] = { min, max: ceiling, fallback: fallbackValue };
  }
  return caps;
}

function auditRetentionDays(env = {}) {
  return Math.max(
    AUDIT_RETENTION_FLOOR_DAYS,
    bound(env.RETENTION_AUDIT_DAYS, AUDIT_RETENTION_FLOOR_DAYS, 36500, AUDIT_RETENTION_DEFAULT_DAYS)
  );
}

// Resolves what the server will actually enforce for one project. A null column
// means "follow the instance default" and keeps following it as the operator
// changes it, which is why the default is applied here at read time rather than
// copied into the row when the project is created.
function clampRetention(settings, caps) {
  const resolved = {};
  for (const field of RETENTION_FIELDS) {
    const cap = caps[field];
    const stored = settings ? toInteger(settings[field]) : null;
    resolved[field] = stored === null ? cap.fallback : Math.min(cap.max, Math.max(cap.min, stored));
  }
  return resolved;
}

// Normalizes what an owner submitted into what may be stored. Null survives as
// null — the explicit "use the instance default" — while any number is clamped
// into the permitted range instead of being rejected, so a UI that offers a
// slider cannot produce a value the API refuses. A field that was not mentioned
// at all is absent from the result and leaves the stored value untouched.
function normalizeRetentionInput(input, caps) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const field of RETENTION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const raw = input[field];
    if (raw === null || raw === "" || raw === "default") {
      out[field] = null;
      continue;
    }
    const numeric = toInteger(raw);
    if (numeric === null) continue;
    const cap = caps[field];
    out[field] = Math.min(cap.max, Math.max(cap.min, numeric));
  }
  return out;
}

// What the settings UI needs to render itself: the stored choice, the value in
// force, and the range the owner may move within. Sending the bounds with the
// values keeps the client from hard-coding limits that only the server knows.
function retentionView(settings, caps) {
  const effective = clampRetention(settings, caps);
  const view = {};
  for (const field of RETENTION_FIELDS) {
    view[field] = {
      value: settings ? toInteger(settings[field]) : null,
      effective: effective[field],
      min: caps[field].min,
      max: caps[field].max,
      default: caps[field].fallback,
    };
  }
  return view;
}

// The cutoff instant for the age half of the rule.
function cutoffDate(days, now = Date.now()) {
  return new Date(now - days * 24 * 60 * 60 * 1000);
}

module.exports = {
  RETENTION_BOUNDS,
  RETENTION_FIELDS,
  AUDIT_RETENTION_FLOOR_DAYS,
  AUDIT_RETENTION_DEFAULT_DAYS,
  retentionCaps,
  auditRetentionDays,
  clampRetention,
  normalizeRetentionInput,
  retentionView,
  cutoffDate,
};
