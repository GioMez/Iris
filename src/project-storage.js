const fs = require("node:fs/promises");
const path = require("node:path");
const { isUuid } = require("./ids");

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/;

// Stored in the database with POSIX separators so a dump stays portable across
// hosts; path.join accepts them on every platform when resolving.
function projectStorageKey(id) {
  if (!isUuid(id)) throw new Error(`Invalid project id: ${id}`);
  return `projects/${id}`;
}

function resolveProjectStorageDir(dataDir, storageKey) {
  const key = String(storageKey || "");
  if (!key) throw new Error("Project storage path is empty");
  // Rows written before migration 002 still hold an absolute path until their
  // directory has been relocated.
  if (ABSOLUTE_PATH.test(key)) return path.resolve(key);
  const base = path.resolve(dataDir);
  const resolved = path.resolve(base, key);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Project storage path escapes the data directory: ${key}`);
  }
  return resolved;
}

async function statOrNull(target) {
  return fs.stat(target).catch(() => null);
}

async function moveDirectory(source, target) {
  try {
    await fs.rename(source, target);
    return;
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
  }
  // The previous DATA_DIR may live on another device, where rename cannot work.
  await fs.cp(source, target, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true });
  await fs.rm(source, { recursive: true, force: true });
}

// Relocates the directories of projects that still carry a pre-002 absolute
// path. Safe to run repeatedly: each row is cleared only once its data sits at
// the canonical location, so an interrupted run resumes where it stopped.
async function relocateProjectStorage({ db, dataDir, logger = console }) {
  const { rows } = await db.query(
    "SELECT id, storage_path, legacy_storage_path FROM projects WHERE legacy_storage_path IS NOT NULL ORDER BY id"
  );
  const summary = { moved: 0, alreadyRelocated: 0, missing: 0, conflicts: [] };

  for (const row of rows) {
    const target = resolveProjectStorageDir(dataDir, row.storage_path);
    // Migration 002 recorded an absolute path here, 004 a DATA_DIR-relative one;
    // the same resolver handles both.
    const source = resolveProjectStorageDir(dataDir, row.legacy_storage_path);
    if (source === target) {
      await clearLegacyPath(db, row.id);
      summary.alreadyRelocated += 1;
      continue;
    }

    const [sourceStat, targetStat] = await Promise.all([statOrNull(source), statOrNull(target)]);
    if (sourceStat && targetStat) {
      summary.conflicts.push(row.id);
      logger.error(`Project ${row.id} exists at both ${source} and ${target}; resolve this by hand.`);
      continue;
    }
    if (targetStat) {
      await clearLegacyPath(db, row.id);
      summary.alreadyRelocated += 1;
      continue;
    }
    if (!sourceStat) {
      logger.warn(`Project ${row.id} has no storage directory at ${source}; nothing to relocate.`);
      await clearLegacyPath(db, row.id);
      summary.missing += 1;
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await moveDirectory(source, target);
    await clearLegacyPath(db, row.id);
    // The per-user parent directory is obsolete once emptied.
    await fs.rmdir(path.dirname(source)).catch(() => {});
    summary.moved += 1;
    logger.log(`Relocated project ${row.id} to ${target}`);
  }

  if (summary.conflicts.length) {
    throw new Error(`Project storage relocation is ambiguous for: ${summary.conflicts.join(", ")}`);
  }
  return summary;
}

async function clearLegacyPath(db, id) {
  await db.query("UPDATE projects SET legacy_storage_path = NULL WHERE id = $1", [id]);
}

module.exports = {
  projectStorageKey,
  resolveProjectStorageDir,
  relocateProjectStorage,
};
