const path = require("node:path");
const { uuidv7, isUuid } = require("./ids");

// Normalizes a tree path the same way the disk writer does, so a ledger path is
// byte-identical to the file's location on disk. Returns null for a path that
// would escape the project, which the disk writer rejects as well.
function normalizeProjectPath(relPath) {
  const raw = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

// The set of files the ledger tracks: every non-generated source file in the
// tree. Generated output and read-only nodes are excluded, matching exactly the
// files the disk writer persists. Each entry keeps a reference to its node so the
// caller can stamp the resolved id back onto the manifest.
function collectProjectFiles(nodes) {
  const entries = [];
  const walk = (list, parentPath) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || node.generated || node.readOnly) continue;
      if (node.type === "folder") {
        const folderPath = normalizeProjectPath(joinPosix(parentPath, node.name));
        walk(node.children, folderPath === null ? parentPath : folderPath);
        continue;
      }
      const filePath = normalizeProjectPath(node.path || joinPosix(parentPath, node.name));
      if (filePath === null) continue;
      entries.push({ node, nodeId: node.id == null ? null : String(node.id), path: filePath, kind: node.kind || null });
    }
  };
  walk(nodes, "");
  return entries;
}

function joinPosix(parent, name) {
  const clean = String(name || "");
  return parent ? path.posix.join(parent, clean) : clean;
}

// Diffs the incoming files against the live ledger rows and produces the plan to
// reconcile them. Pure: the id generator is injected so tests are deterministic.
//
// An incoming file keeps its identity when it matches a live row either by its
// canonical id (the normal case after the browser has adopted the UUIDv7) or by
// client_ref (the same editing session before that adoption). A path change on a
// matched file is a rename or move and updates the row in place. A live row that
// no incoming file matches is soft-deleted. Anything unmatched is a new file,
// adopting a client-supplied UUIDv7 when present and minting one otherwise.
function reconcileProjectFiles(liveRows, incoming, { generateId = uuidv7 } = {}) {
  const byId = new Map();
  const byClientRef = new Map();
  for (const row of liveRows) {
    byId.set(row.id, row);
    if (row.client_ref != null && !byClientRef.has(row.client_ref)) byClientRef.set(row.client_ref, row);
  }

  const claimed = new Set();
  const usedIds = new Set(liveRows.map((row) => row.id));
  const resolved = [];
  const inserts = [];
  const updates = [];

  for (const file of incoming) {
    const ref = file.nodeId;
    let row = null;
    if (ref != null && byId.has(ref) && !claimed.has(byId.get(ref).id)) row = byId.get(ref);
    else if (ref != null && byClientRef.has(ref) && !claimed.has(byClientRef.get(ref).id)) row = byClientRef.get(ref);

    if (row) {
      claimed.add(row.id);
      if (row.path !== file.path || (row.kind || null) !== (file.kind || null)) {
        // fromPath lets the disk layer move the bytes on a rename instead of
        // deleting and recreating them; it equals path when only the kind changed.
        updates.push({ id: row.id, fromPath: row.path, path: file.path, kind: file.kind });
      }
      resolved.push({ canonicalId: row.id });
      continue;
    }

    let id = ref != null && isUuid(ref) && !usedIds.has(ref) ? ref : generateId();
    while (usedIds.has(id)) id = generateId();
    usedIds.add(id);
    claimed.add(id);
    inserts.push({ id, client_ref: ref, path: file.path, kind: file.kind });
    resolved.push({ canonicalId: id });
  }

  const softDeletes = liveRows.filter((row) => !claimed.has(row.id)).map((row) => row.id);
  return { resolved, inserts, updates, softDeletes };
}

module.exports = { normalizeProjectPath, collectProjectFiles, reconcileProjectFiles };
