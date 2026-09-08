// Operational Transformation with central server authority, built on the
// primitives of @codemirror/collab. This module owns the algorithm and the
// bookkeeping; the transport (WebSocket) and the storage live in server.js, so
// convergence can be tested without a socket or a database.
//
// The model is the one @codemirror/collab is designed for:
//
//   * the server holds the authoritative document and a version number equal to
//     the count of updates it has accepted;
//   * a client may only push updates based on the authoritative version. A push
//     from behind is rejected, the client pulls, rebases its pending changes
//     locally (that is where the transformation happens) and pushes again;
//   * accepted updates are appended to a log every client replays in the same
//     order, so all replicas converge on the same text.
//
// Because the order is decided in one place, permissions, revocation, revisions
// and persistence stay under server control — the reason OT was chosen over a
// CRDT (see .drafts/NEXT_STEPS.md).
const { ChangeSet, Text } = require("@codemirror/state");

// How many accepted updates a room keeps so a reconnecting client can catch up
// by replaying them. A client that asks for anything older is told to resync
// from the authoritative document instead: correctness never depends on the log
// being complete, only the cheap path does.
const DEFAULT_HISTORY_LIMIT = 1000;
// A single change set from one keystroke is tiny; this bounds a malicious or
// broken client, and is far above any legitimate paste-sized edit.
const MAX_UPDATES_PER_PUSH = 200;

class CollabError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// One collaborative document: a room. `version` counts accepted updates, never
// resets, and is what clients synchronise against.
class CollabDocument {
  constructor({ fileId, projectId, path: filePath, content = "", historyLimit = DEFAULT_HISTORY_LIMIT }) {
    this.fileId = fileId;
    this.projectId = projectId;
    this.path = filePath;
    this.doc = Text.of(String(content).split("\n"));
    this.version = 0;
    this.historyLimit = historyLimit;
    // Accepted updates, oldest first. `logStart` is the version the first entry
    // takes the document from, so entry i applies to version logStart + i.
    this.log = [];
    this.logStart = 0;
    // Persistence bookkeeping, read by the owner of the room in server.js.
    this.persistedVersion = 0;
    this.revisionVersion = 0;
  }

  text() {
    return this.doc.toString();
  }

  // Updates a client needs to reach the authoritative version, or null when the
  // requested version has fallen out of the log and a full resync is required.
  since(version) {
    if (!Number.isInteger(version) || version < 0 || version > this.version) {
      throw new CollabError("COLLAB_BAD_VERSION");
    }
    if (version < this.logStart) return null;
    return this.log.slice(version - this.logStart).map(serializeUpdate);
  }

  // Applies a client's updates. Accepted only when the client is exactly at the
  // authoritative version: anything else means it has not seen updates that are
  // already ordered before its own, so it must rebase and retry.
  receive(version, updates, meta = {}) {
    if (!Number.isInteger(version) || version < 0) throw new CollabError("COLLAB_BAD_VERSION");
    if (!Array.isArray(updates) || !updates.length) throw new CollabError("COLLAB_EMPTY_PUSH");
    if (updates.length > MAX_UPDATES_PER_PUSH) throw new CollabError("COLLAB_PUSH_TOO_LARGE");
    if (version !== this.version) return { accepted: false, version: this.version };

    // Parse and apply against a scratch document first: a malformed or
    // non-applicable change set must leave the room untouched.
    const parsed = [];
    let doc = this.doc;
    for (const update of updates) {
      let changes;
      try {
        changes = ChangeSet.fromJSON(update && update.changes);
      } catch {
        throw new CollabError("COLLAB_BAD_CHANGES");
      }
      if (changes.length !== doc.length) throw new CollabError("COLLAB_BAD_CHANGES");
      doc = changes.apply(doc);
      parsed.push({ changes, clientID: String(update.clientID || ""), userId: meta.userId || null });
    }

    this.doc = doc;
    this.version += parsed.length;
    this.log.push(...parsed);
    this.trim();
    return { accepted: true, version: this.version, updates: parsed.map(serializeUpdate) };
  }

  trim() {
    const excess = this.log.length - this.historyLimit;
    if (excess <= 0) return;
    this.log.splice(0, excess);
    this.logStart += excess;
  }

  // Replaces the document outside the update stream (a rollback, or a refresh
  // from disk). Clients cannot rebase across this, so the version is bumped past
  // anything they hold and they are expected to resync.
  reset(content) {
    this.doc = Text.of(String(content).split("\n"));
    this.version += 1;
    this.log = [];
    this.logStart = this.version;
    this.persistedVersion = 0;
    this.revisionVersion = 0;
    return this.version;
  }

  // True when the text differs from what was last written to disk.
  needsPersist() {
    return this.version !== this.persistedVersion;
  }

  markPersisted(version = this.version) {
    this.persistedVersion = version;
  }

  needsRevision() {
    return this.version !== this.revisionVersion;
  }

  markRevisioned(version = this.version) {
    this.revisionVersion = version;
  }
}

function serializeUpdate(update) {
  return { changes: update.changes.toJSON(), clientID: update.clientID };
}

// The set of live rooms, keyed by the file's canonical id. Rooms are created on
// first join and disposed once empty; while a room is live it is the authority
// for that file's content, which is what keeps a stale whole-project save from
// overwriting edits made in realtime (see collabContentFor in server.js).
class CollabRooms {
  constructor({ historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
    this.rooms = new Map();
    this.historyLimit = historyLimit;
    this.generation = 0;
  }

  get(fileId) {
    return this.rooms.get(fileId) || null;
  }

  // Creates the room seeded with `content` when absent; the seed is ignored for
  // a room that already exists, whose in-memory text is newer than any disk read.
  open({ fileId, projectId, path: filePath, content }) {
    const existing = this.rooms.get(fileId);
    if (existing) return existing;
    const room = new CollabDocument({ fileId, projectId, path: filePath, content, historyLimit: this.historyLimit });
    room.clients = new Set();
    this.rooms.set(fileId, room);
    this.generation++;
    return room;
  }

  close(fileId) {
    if (this.rooms.delete(fileId)) this.generation++;
  }

  forProject(projectId) {
    return Array.from(this.rooms.values()).filter((room) => room.projectId === projectId);
  }

  all() {
    return Array.from(this.rooms.values());
  }
}

// Identity colours for presence. Chosen from the editor's own syntax palette so
// they read on the dark editor background, and far enough apart in hue to stay
// distinguishable as small markers. Assignment is deterministic on the user id,
// so the same person is the same colour for everyone and across reconnections.
const PEER_COLORS = [
  "#7aa2f7", // blue
  "#9ece6a", // green
  "#bb9af7", // purple
  "#e0af68", // amber
  "#f7768e", // rose
  "#2ac3de", // teal
  "#ff9e64", // orange
  "#b4f9f8", // ice
];

function peerColor(userId) {
  const key = String(userId || "");
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return PEER_COLORS[hash % PEER_COLORS.length];
}

// Normalizes a presence report from a client. Positions are ephemeral hints, so
// anything malformed is dropped rather than treated as an error.
function normalizePresence(message, docLength) {
  if (!message || typeof message !== "object") return null;
  const toOffset = (value) => {
    const offset = Number(value);
    if (!Number.isFinite(offset)) return null;
    return Math.max(0, Math.min(docLength, Math.floor(offset)));
  };
  const anchor = toOffset(message.anchor);
  const head = toOffset(message.head);
  if (anchor === null || head === null) return null;
  const version = Number(message.version);
  return { anchor, head, version: Number.isInteger(version) && version >= 0 ? version : 0 };
}

module.exports = {
  CollabDocument,
  CollabRooms,
  CollabError,
  DEFAULT_HISTORY_LIMIT,
  MAX_UPDATES_PER_PUSH,
  PEER_COLORS,
  peerColor,
  normalizePresence,
};
