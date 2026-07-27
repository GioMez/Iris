const crypto = require("node:crypto");

const REASONS = new Set(["manual", "compile", "rollback", "initial"]);
// A source file larger than this is not versioned inline: history is meant for
// editable text, and a runaway file should not bloat the database. 16 MB is
// generous for even a very long source: PostgreSQL stores the content out-of-line
// and compresses it (TOAST), so the on-disk cost is far below the raw size. It
// also stays well under the 25 MB request-body cap (MAX_BODY), so any file this
// size can actually be saved in the first place.
const MAX_VERSION_BYTES = 16 * 1024 * 1024;

function hashContent(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Decides whether a buffer read from disk is a text source file worth versioning.
// A NUL byte is the cheap, reliable signal of binary content; `img` and other
// binary kinds are excluded outright.
function isVersionableText(buffer, kind) {
  if (kind === "img" || kind === "font") return false;
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.length > MAX_VERSION_BYTES) return false;
  return !buffer.includes(0);
}

// A new revision is only worth recording when the content actually changed since
// the file's latest revision. The first revision of a file always records.
function contentChanged(latestHash, nextHash) {
  return latestHash == null || latestHash !== nextHash;
}

module.exports = { REASONS, MAX_VERSION_BYTES, hashContent, isVersionableText, contentChanged };
