const crypto = require("node:crypto");
const fsSync = require("node:fs");
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
  try {
    return await fs.stat(target);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function hashFile(target) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function directoryManifest(root) {
  const records = [];
  const walk = async (directory, relative = "") => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const childRelative = relative ? path.posix.join(relative, child.name) : child.name;
      const absolute = path.join(directory, child.name);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) {
        records.push({ path: childRelative, type: "directory" });
        await walk(absolute, childRelative);
      } else if (stat.isFile()) {
        records.push({
          path: childRelative,
          type: "file",
          size: stat.size,
          sha256: await hashFile(absolute),
        });
      } else if (stat.isSymbolicLink()) {
        records.push({ path: childRelative, type: "symlink", target: await fs.readlink(absolute) });
      } else {
        throw new Error(`Unsupported filesystem entry during project relocation: ${absolute}`);
      }
    }
  };
  await walk(root);
  return records;
}

async function verifyDirectoryCopy(source, target) {
  const [sourceManifest, targetManifest] = await Promise.all([
    directoryManifest(source),
    directoryManifest(target),
  ]);
  if (JSON.stringify(sourceManifest) !== JSON.stringify(targetManifest)) {
    throw new Error(`Cross-device project copy verification failed: ${source} -> ${target}`);
  }
}

async function moveDirectory(source, target) {
  try {
    await fs.rename(source, target);
    return;
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
  }
  // The previous DATA_DIR may live on another device, where rename cannot work.
  await fs.cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  });
  // fs.cp resolving means the traversal completed, but an explicit manifest
  // comparison also catches missing, truncated or altered data before the only
  // remaining source copy is removed.
  await verifyDirectoryCopy(source, target);
  await fs.rm(source, { recursive: true, force: true });
}

// Relocates directories that still carry a legacy source path. Safe to run
// repeatedly for completed and missing moves: each row is cleared only once its
// data sits at the canonical location. A partial cross-device copy is surfaced
// as a conflict for manual comparison rather than guessed automatically.
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
      // A temporarily unavailable mount must not turn a recoverable relocation
      // into a permanently lost source reference. Leave the row pending so a
      // later startup or maintenance run can try again.
      logger.warn(`Project ${row.id} has no storage directory at ${source}; relocation remains pending.`);
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
  verifyDirectoryCopy,
};
