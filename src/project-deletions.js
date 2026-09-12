const path = require("node:path");

// Current deletion receipts live outside the recursively removed quarantine.
// prepared is deliberately not recoverable by observing project-row absence.
function createProjectDeletions({ fs, getDb, mutations, backupRoot, requestError, log = console }) {
  const recovery = () => requestError("PROJECT_RECOVERY_REQUIRED", 503);
  const notFound = () => requestError("PROJECT_NOT_FOUND", 404);
  const receipt = async (id) => (await getDb().query(
    "SELECT * FROM project_deletions WHERE project_id = $1", [id]
  )).rows[0];
  const live = async (id) => (await getDb().query("SELECT id FROM projects WHERE id = $1", [id])).rows.length > 0;

  // Caller owns the shared project queue. Even a ready receipt is not permission
  // to remove bytes if a live project exists. No paths come from the receipt.
  async function cleanup(id, row) {
    if (await live(id)) throw recovery();
    if (row.state === "complete") return { ok: true, cleanupPending: false };
    if (row.state !== "cleanup_ready") throw recovery();
    try {
      await fs.rm(path.join(backupRoot, id), { recursive: true, force: true });
    } catch (err) {
      log.error(`Project deletion cleanup pending: ${id}`, err);
      return { ok: true, cleanupPending: true };
    }
    try {
      const result = await getDb().query(
        "UPDATE project_deletions SET state = 'complete', completed_at = CURRENT_TIMESTAMP WHERE project_id = $1 AND state = 'cleanup_ready'",
        [id]
      );
      if (result.rowCount !== 1) throw recovery();
    } catch (err) {
      log.error(`Project deletion completion required: ${id}`, err);
      throw recovery();
    }
    mutations.clearBlock(id);
    return { ok: true, cleanupPending: false };
  }

  function remove({ id, admin = false, authenticate, authorizeLive, lockAuthority, onCommitted }) {
    return mutations.serialize(id, async () => {
      const user = await authenticate();
      if (!await live(id)) {
        const row = await receipt(id);
        if (!row || (!admin && !row.owner_ids.includes(user.sub))) throw notFound();
        return cleanup(id, row);
      }
      // Authorization precedes every recovery disclosure, including live rows.
      const project = await authorizeLive();
      if (await receipt(id)) throw recovery();
      await mutations.transaction({
        id, storageDir: project.storageDir, deleting: true,
        beforeLock: (client) => lockAuthority(client, user),
        authorize: authorizeLive,
      }, async (client, protect) => {
        const owners = await client.query(
          "SELECT user_id FROM project_members WHERE project_id = $1 AND role = 'owner' ORDER BY user_id FOR UPDATE", [id]
        );
        await authorizeLive(client);
        await client.query(
          "INSERT INTO project_deletions (project_id, owner_ids, state) VALUES ($1, $2, 'prepared')",
          [id, owners.rows.map((row) => row.user_id)]
        );
        await protect();
        await client.query("DELETE FROM projects WHERE id = $1", [id]);
        // Account authority is locked, but wall-clock expiry can pass during I/O.
        await authenticate(client);
      });
      // Only an acknowledged COMMIT reaches these effects. Retries never do.
      await onCommitted(project, user);
      try {
        const result = await getDb().query(
          "UPDATE project_deletions SET state = 'cleanup_ready' WHERE project_id = $1 AND state = 'prepared'", [id]
        );
        if (result.rowCount !== 1) throw recovery();
      } catch (err) {
        log.error(`Project deletion readiness required: ${id}`, err);
        throw recovery();
      }
      return cleanup(id, { state: "cleanup_ready" });
    });
  }

  async function sweep({ shouldRun = () => true } = {}) {
    if (!shouldRun()) return;
    const { rows } = await getDb().query("SELECT project_id FROM project_deletions WHERE state = 'cleanup_ready'");
    for (const { project_id: id } of rows) {
      if (!shouldRun()) return;
      try {
        await mutations.serialize(id, async () => {
          if (!shouldRun()) return;
          const row = await receipt(id);
          if (row?.state === "cleanup_ready") await cleanup(id, row);
        });
      } catch (err) { log.error(`Project deletion sweep failed: ${id}`, err); }
    }
    if (shouldRun()) await getDb().query(
      "DELETE FROM project_deletions WHERE state = 'complete' AND completed_at < CURRENT_TIMESTAMP - INTERVAL '7 days'"
    );
  }

  return { remove, sweep };
}

module.exports = { createProjectDeletions };
