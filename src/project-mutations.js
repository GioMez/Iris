const path = require("node:path");

// In-process serialization includes compensation, not just the successful write.
// Retained backups are a fail-closed operator boundary, not a crash recovery log.
function createProjectMutations({ fs, getDb, backupRoot, requestError }) {
  const pending = new Map();
  const blocked = new Set();
  const recovery = () => requestError("PROJECT_RECOVERY_REQUIRED", 503);
  const exists = async (file) => fs.lstat(file).then(() => true, (err) => {
    if (err.code === "ENOENT") return false;
    throw err;
  });
  async function check(id) {
    if (blocked.has(id) || await exists(path.join(backupRoot, id))) throw recovery();
  }
  async function serialize(id, action) {
    const previous = pending.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    pending.set(id, current);
    try { return await current; }
    finally { if (pending.get(id) === current) pending.delete(id); }
  }
  function gate(id, action, authorize = null) {
    return serialize(id, async () => {
      // Check current access after queueing, before revealing recovery state.
      const context = authorize ? await authorize() : undefined;
      await check(id);
      return action(context);
    });
  }
  const sourceEntries = async (dir) => (await fs.readdir(dir)).filter((name) => ![".iris", "output"].includes(name.toLowerCase()));
  async function copySources(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const name of await sourceEntries(from)) {
      await fs.cp(path.join(from, name), path.join(to, name), { recursive: true, verbatimSymlinks: true });
    }
    const manifest = path.join(from, ".iris", "project.json");
    if (await exists(manifest)) {
      await fs.mkdir(path.join(to, ".iris"), { recursive: true });
      await fs.cp(manifest, path.join(to, ".iris", "project.json"));
    }
  }

  // Caller holds the project queue throughout. The row lock also serializes CAS
  // writers using separate connections; it stays held until compensation ends.
  async function transaction({ id, storageDir, create = false, deleting = false, beforeLock = null, authorize = null }, action) {
    const client = await getDb().connect();
    const backup = path.join(backupRoot, id);
    let prepared = false;
    let committing = false;
    let committed = false;
    let broken = false;
    let ownsBackup = false;
    const protect = async () => {
      if (prepared) return;
      // check(id) established this project's backup namespace was absent. Own
      // preparation before mkdir too, so a partially successful mkdir is cleaned.
      ownsBackup = true;
      await fs.mkdir(backup, { recursive: true });
      if (!create && !deleting) await copySources(storageDir, backup);
      prepared = true;
      if (deleting) {
        try { await fs.rename(storageDir, path.join(backup, "deleted")); }
        catch (err) {
          // rename's ENOENT can name either parent. Only an absent source is
          // an already-absent deletion payload; ENOTDIR/permissions still fail.
          if (err.code !== "ENOENT" || await exists(storageDir)) throw err;
        }
      }
    };
    try {
      await client.query("BEGIN");
      // Deletion shares BE10's user -> owner-advisory -> project row order.
      if (beforeLock) await beforeLock(client);
      await client.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [id]);
      if (authorize) await authorize(client);
      await check(id);
      const result = await action(client, protect);
      committing = true;
      await client.query("COMMIT");
      committed = true;
      // Deletion's durable receipt must become ready before any recursive rm.
      if (deleting) return result;
      // A leftover backup deliberately blocks subsequent access even if only its
      // cleanup failed. Do not turn a confirmed save into an ambiguous response.
      await fs.rm(backup, { recursive: true, force: true }).catch((err) => {
        blocked.add(id);
        console.error(`Project backup cleanup required: ${backup}`, err);
      });
      return result;
    } catch (err) {
      let compensationFailed = committing;
      if (prepared && !committing) {
        try {
          if (create) await fs.rm(storageDir, { recursive: true, force: true });
          else if (deleting) {
            if (await exists(path.join(backup, "deleted"))) await fs.rename(path.join(backup, "deleted"), storageDir);
          } else {
            for (const name of await sourceEntries(storageDir)) await fs.rm(path.join(storageDir, name), { recursive: true, force: true });
            await fs.rm(path.join(storageDir, ".iris", "project.json"), { force: true });
            await copySources(backup, storageDir);
          }
        } catch (restoreError) {
          compensationFailed = true;
          console.error(`Project compensation required: ${backup}`, restoreError);
        }
      }
      try { await client.query("ROLLBACK"); }
      catch { compensationFailed = true; broken = true; }
      if (!compensationFailed && ownsBackup) {
        try { await fs.rm(backup, { recursive: true, force: true }); }
        catch { compensationFailed = true; }
      }
      if (compensationFailed) { blocked.add(id); throw recovery(); }
      throw err;
    } finally {
      client.release(broken || (committing && !committed));
    }
  }
  // Queue-only access and clearing are reserved for receipt-checked deletion
  // cleanup. Ordinary readers/writers must continue to use gate.
  return { gate, serialize, transaction, clearBlock: (id) => blocked.delete(id) };
}

module.exports = { createProjectMutations };
