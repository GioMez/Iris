const path = require("node:path");
const { isUuid } = require("./ids");

// POSIX keys keep database dumps portable across DATA_DIR locations and hosts.
function projectStorageKey(id) {
  if (!isUuid(id)) throw new Error(`Invalid project id: ${id}`);
  return `projects/${id}`;
}

function resolveProjectStorageDir(dataDir, storageKey) {
  if (typeof storageKey !== "string" || !storageKey.startsWith("projects/") || !isUuid(storageKey.slice(9))) {
    throw new Error(`Invalid project storage key: ${storageKey}`);
  }
  // The validated key has exactly two safe components, including at a root base.
  return path.resolve(dataDir, storageKey);
}

module.exports = { projectStorageKey, resolveProjectStorageDir };
