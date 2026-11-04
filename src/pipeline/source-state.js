const { createHash } = require("node:crypto");
const { openCheckedFile } = require("./workspaces");

const isLua = name => /\.lua$/i.test(name);
async function state(queryable, id) {
  const { rows } = await queryable.query("SELECT lua_sources_changed_at,lua_sources_hash,lua_sources_pending,lua_sources_author_id,lua_sources_approval_session FROM projects WHERE id=$1", [id]);
  return rows[0];
}

// Fingerprints describe registered disk sources, independently of live rooms.
// Keep reads bounded and reject a file that changes while being hashed.
async function capture(queryable, id, root, incomingPaths = []) {
  const current = await state(queryable, id);
  const { rows } = await queryable.query("SELECT id,path FROM project_files WHERE project_id=$1 AND deleted_at IS NULL AND path ~* '\\.lua$' ORDER BY path", [id]);
  const registered = new Set(rows.map(file => file.path));
  for (const name of new Set(incomingPaths.filter(isLua))) {
    if (!registered.has(name)) rows.push({ id: null, path: name });
  }
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const files = [];
  for (const file of rows) {
    let opened;
    try { opened = await openCheckedFile(root, file.path); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (file.id) files.push({ ...file, missing: true });
      continue;
    }
    const { input, before } = opened;
    try {
      const hash = createHash("sha256"); let size = 0;
      for await (const bytes of input.createReadStream({ autoClose: false })) { hash.update(bytes); size += bytes.length; }
      const after = await input.stat();
      if (size !== before.size || size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw Object.assign(new Error("Lua source changed during fingerprint capture"), { code: "PIPELINE_BUNDLE_CHANGED" });
      }
      files.push({ ...file, size, hash: hash.digest("hex") });
    } finally { await input.close(); }
  }
  return { state: current, files, hash: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

function pending(current, changes = []) {
  let changedAt = current.lua_sources_changed_at?.getTime() || null;
  let dirty = current.lua_sources_pending, authorId = current.lua_sources_author_id;
  for (const change of changes) {
    if (change.unknownTime) changedAt = null;
    else if (change.at) changedAt = Math.max(changedAt || 0, change.at);
    authorId = !dirty || authorId === change.authorId ? change.authorId : null;
    dirty = true;
  }
  return { changedAt, dirty, authorId };
}

function external(captured, sessionId = null) {
  return captured.files.some(file => !file.id || file.missing) || (captured.state.lua_sources_hash && captured.state.lua_sources_hash !== captured.hash)
    || (captured.state.lua_sources_approval_session && captured.state.lua_sources_approval_session !== sessionId)
    ? [{ at: null, authorId: null, unknownTime: true }] : [];
}

// Caller owns the project gate and, for filesystem transactions, their client.
async function persist(queryable, id, root, before, { authorId = null, edits = [], approvedFiles = new Set(), changes: mutations = [], sessionId = null, settlesApproval = false } = {}) {
  const after = await capture(queryable, id, root), changes = [...edits, ...external(before, sessionId), ...mutations];
  const previous = new Map(before.files.map(file => [file.path, file]));
  const next = new Map(after.files.map(file => [file.path, file]));
  for (const name of new Set([...previous.keys(), ...next.keys()])) {
    const a = previous.get(name), b = next.get(name);
    if ((a?.missing && !b) || (a && b && a.hash === b.hash)) continue;
    if (a && b && a.id === b.id && (approvedFiles.has(b.id) || edits.some(edit => edit.fileId === b.id))) continue;
    changes.push({ at: Date.now(), authorId });
  }
  if (!changes.length && before.hash === after.hash && (before.state.lua_sources_hash || !after.files.length)
    && !(before.state.lua_sources_approval_session && settlesApproval)) return;
  const merged = pending(after.state, changes);
  await queryable.query(`UPDATE projects SET lua_sources_hash=$2,lua_sources_changed_at=$3,
    lua_sources_pending=$4,lua_sources_author_id=$5,
    lua_sources_approval_session=CASE WHEN $6 THEN NULL ELSE lua_sources_approval_session END WHERE id=$1`,
  [id, after.hash, merged.changedAt === null ? null : new Date(merged.changedAt), merged.dirty, merged.authorId, settlesApproval]);
}

function live(rooms) {
  return rooms.filter(room => isLua(room.path) && room.luaChange).map(room => ({ ...room.luaChange, fileId: room.fileId }));
}
function approvedFiles(rooms) {
  return new Set(rooms.filter(room => !room.luaChange && room.luaApprovalVersion === room.version).map(room => room.fileId));
}
// Clear the crash marker only after every approved live room reaches disk.
function approvalSettled(rooms, writingFileId) {
  return rooms.every(room => !isLua(room.path) || room.fileId === writingFileId || room.luaApprovalVersion == null || room.persistedVersion >= room.luaApprovalVersion);
}
module.exports = { isLua, capture, persist, pending, external, live, approvedFiles, approvalSettled };
