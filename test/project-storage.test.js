const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  projectStorageKey,
  resolveProjectStorageDir,
  relocateProjectStorage,
  verifyDirectoryCopy,
} = require("../src/project-storage");

const ID_A = "019f99b9-61cf-7fee-963f-8f7dee086983";
const ID_B = "019f99bb-6923-7322-a37d-c8f46b5e5cc9";

function fakeDb(rows) {
  const cleared = [];
  return {
    cleared,
    async query(sql, params) {
      if (sql.startsWith("SELECT")) return { rows: rows.filter((row) => row.legacy_storage_path !== null) };
      cleared.push(params[0]);
      const row = rows.find((entry) => entry.id === params[0]);
      if (row) row.legacy_storage_path = null;
      return { rows: [] };
    },
  };
}

const silentLogger = { log() {}, warn() {}, error() {} };

async function tempDataDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-storage-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("storage keys are derived from the project id alone", () => {
  assert.equal(projectStorageKey(ID_A), `projects/${ID_A}`);
  for (const invalid of [
    "",
    null,
    "../escape",
    "0123456789abcdef0123456789abcdef",
    ID_A.toUpperCase(),
    `${ID_A}x`,
  ]) {
    assert.throws(() => projectStorageKey(invalid), /Invalid project id/);
  }
});

test("stored paths resolve under the data directory and reject traversal", () => {
  const dataDir = path.resolve("/srv/iris/data");
  assert.equal(resolveProjectStorageDir(dataDir, `projects/${ID_A}`), path.join(dataDir, "projects", ID_A));
  // Rows written before migration 002 keep working until they are relocated.
  assert.equal(resolveProjectStorageDir(dataDir, "/mnt/old/7/abc-score"), path.resolve("/mnt/old/7/abc-score"));
  for (const invalid of ["", null, "../outside", `projects/../../${ID_A}`]) {
    assert.throws(() => resolveProjectStorageDir(dataDir, invalid));
  }
});

test("a copied directory is verified byte-for-byte before its source can be removed", async (t) => {
  const dataDir = await tempDataDir(t);
  const source = path.join(dataDir, "copy-source");
  const target = path.join(dataDir, "copy-target");
  await fs.mkdir(path.join(source, "nested", "empty"), { recursive: true });
  await fs.writeFile(path.join(source, "main.tex"), "original");
  await fs.writeFile(path.join(source, "nested", "asset.bin"), Buffer.from([0, 1, 2, 3]));
  await fs.cp(source, target, { recursive: true });

  await assert.doesNotReject(verifyDirectoryCopy(source, target));

  // Same length, different content: checking only names and sizes is not enough.
  await fs.writeFile(path.join(target, "main.tex"), "modified");
  await assert.rejects(
    verifyDirectoryCopy(source, target),
    /copy verification failed/
  );
  assert.equal(await fs.readFile(path.join(source, "main.tex"), "utf8"), "original");
});

test("relocation moves legacy directories and is safe to repeat", async (t) => {
  const dataDir = await tempDataDir(t);
  const legacy = path.join(dataDir, "7", `${ID_A}-score`);
  await fs.mkdir(path.join(legacy, ".iris"), { recursive: true });
  await fs.writeFile(path.join(legacy, ".iris", "project.json"), '{"project":{"nodes":[]}}');
  await fs.writeFile(path.join(legacy, "main.ly"), "{ c1 }");

  const rows = [{ id: ID_A, storage_path: projectStorageKey(ID_A), legacy_storage_path: legacy }];
  const db = fakeDb(rows);
  const summary = await relocateProjectStorage({ db, dataDir, logger: silentLogger });

  assert.deepEqual({ moved: summary.moved, conflicts: summary.conflicts }, { moved: 1, conflicts: [] });
  const target = path.join(dataDir, "projects", ID_A);
  assert.equal(await fs.readFile(path.join(target, "main.ly"), "utf8"), "{ c1 }");
  assert.equal(await fs.stat(legacy).catch(() => null), null);
  // The emptied per-user parent directory is not left behind.
  assert.equal(await fs.stat(path.join(dataDir, "7")).catch(() => null), null);
  assert.deepEqual(db.cleared, [ID_A]);

  const second = await relocateProjectStorage({ db, dataDir, logger: silentLogger });
  assert.equal(second.moved, 0);
});

test("relocation follows a DATA_DIR-relative legacy path", async (t) => {
  // Migration 004 records the previous location relative to DATA_DIR, unlike 002
  // which recorded an absolute path.
  const dataDir = await tempDataDir(t);
  const legacyKey = `projects/${ID_B}`;
  await fs.mkdir(path.join(dataDir, legacyKey), { recursive: true });
  await fs.writeFile(path.join(dataDir, legacyKey, "main.tex"), "old id");

  const rows = [{ id: ID_A, storage_path: projectStorageKey(ID_A), legacy_storage_path: legacyKey }];
  const db = fakeDb(rows);
  const summary = await relocateProjectStorage({ db, dataDir, logger: silentLogger });

  assert.equal(summary.moved, 1);
  assert.equal(await fs.readFile(path.join(dataDir, "projects", ID_A, "main.tex"), "utf8"), "old id");
  assert.equal(await fs.stat(path.join(dataDir, legacyKey)).catch(() => null), null);
});

test("relocation resumes after an interrupted move and keeps missing sources pending", async (t) => {
  const dataDir = await tempDataDir(t);
  // Data already sits at the canonical location but the row was never cleared.
  await fs.mkdir(path.join(dataDir, "projects", ID_A), { recursive: true });
  const rows = [
    { id: ID_A, storage_path: projectStorageKey(ID_A), legacy_storage_path: path.join(dataDir, "7", `${ID_A}-score`) },
    { id: ID_B, storage_path: projectStorageKey(ID_B), legacy_storage_path: path.join(dataDir, "9", `${ID_B}-gone`) },
  ];
  const db = fakeDb(rows);

  const summary = await relocateProjectStorage({ db, dataDir, logger: silentLogger });
  assert.equal(summary.alreadyRelocated, 1);
  assert.equal(summary.missing, 1);
  assert.deepEqual(db.cleared, [ID_A]);
  assert.notEqual(rows[1].legacy_storage_path, null);

  // Once the external storage becomes available, the same pending row is
  // picked up and completed without repairing the database by hand.
  await fs.mkdir(rows[1].legacy_storage_path, { recursive: true });
  await fs.writeFile(path.join(rows[1].legacy_storage_path, "main.tex"), "restored mount");
  const retry = await relocateProjectStorage({ db, dataDir, logger: silentLogger });
  assert.equal(retry.moved, 1);
  assert.equal(rows[1].legacy_storage_path, null);
  assert.equal(
    await fs.readFile(path.join(dataDir, projectStorageKey(ID_B), "main.tex"), "utf8"),
    "restored mount"
  );
});

test("relocation propagates filesystem errors without clearing the pending source", async (t) => {
  const dataDir = await tempDataDir(t);
  const notDirectory = path.join(dataDir, "not-a-directory");
  await fs.writeFile(notDirectory, "blocked");
  const rows = [{
    id: ID_A,
    storage_path: projectStorageKey(ID_A),
    legacy_storage_path: path.join(notDirectory, "project"),
  }];
  const db = fakeDb(rows);

  await assert.rejects(
    relocateProjectStorage({ db, dataDir, logger: silentLogger }),
    (error) => error.code === "ENOTDIR"
  );
  assert.deepEqual(db.cleared, []);
  assert.notEqual(rows[0].legacy_storage_path, null);
});

test("relocation refuses to guess when both locations hold data", async (t) => {
  const dataDir = await tempDataDir(t);
  const legacy = path.join(dataDir, "7", `${ID_A}-score`);
  await fs.mkdir(legacy, { recursive: true });
  await fs.mkdir(path.join(dataDir, "projects", ID_A), { recursive: true });
  const rows = [{ id: ID_A, storage_path: projectStorageKey(ID_A), legacy_storage_path: legacy }];
  const db = fakeDb(rows);

  await assert.rejects(
    relocateProjectStorage({ db, dataDir, logger: silentLogger }),
    /ambiguous/
  );
  // Nothing was moved and the row keeps its legacy path for a manual decision.
  assert.deepEqual(db.cleared, []);
  assert.ok(await fs.stat(legacy));
});
