const crypto = require("node:crypto");

// Node has no UUIDv7 generator: crypto.randomUUID() always returns version 4 and
// silently ignores a { version: 7 } option, so the bytes are laid out here.
//
// RFC 9562 layout: a 48-bit big-endian Unix millisecond timestamp, then 74 random
// bits, with the 4-bit version and 2-bit variant fields overwritten in place.
// The leading timestamp makes ids sort by creation time, which keeps primary key
// inserts local in the B-tree instead of scattering them the way version 4 does.
function uuidv7() {
  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Matches any canonical lowercase UUID rather than version 7 alone: PostgreSQL
// renders the uuid type in this form, and pinning the version here would turn a
// legitimately stored value of another version into an unexplained 404.
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_PATTERN}$`);

function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

// Reads back the embedded creation time. Only meaningful for version 7.
function uuidTimestamp(value) {
  if (!isUuid(value)) return null;
  const ms = Number.parseInt(value.replace(/-/g, "").slice(0, 12), 16);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

module.exports = { uuidv7, isUuid, uuidTimestamp, UUID_PATTERN };
