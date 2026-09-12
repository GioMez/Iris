const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { projectStorageKey, resolveProjectStorageDir } = require("../src/project-storage");

const ID = "019f99b9-61cf-7fee-963f-8f7dee086983";

test("storage keys are derived from the project id alone", () => {
  assert.equal(projectStorageKey(ID), `projects/${ID}`);
  for (const invalid of ["", null, "../escape", "0123456789abcdef0123456789abcdef", ID.toUpperCase(), `${ID}x`,
    ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map((ending) => ID + ending)]) {
    assert.throws(() => projectStorageKey(invalid), /Invalid project id/);
  }
});

test("canonical keys resolve under absolute and relative data directories", () => {
  for (const dataDir of ["/srv/iris/data", "relative-data"]) {
    assert.equal(resolveProjectStorageDir(dataDir, `projects/${ID}`), path.resolve(dataDir, "projects", ID));
  }
});

test("an absolute filesystem root is a valid data directory", () => {
  const root = path.parse(process.cwd()).root;
  assert.equal(resolveProjectStorageDir(root, `projects/${ID}`), path.join(root, "projects", ID));
});

test("storage addressing refuses absolute, traversal and noncanonical keys", () => {
  for (const invalid of [
    "", null, 12, {}, `/projects/${ID}`, "/mnt/old/7/abc-score", `C:\\iris\\projects\\${ID}`,
    `\\\\server\\projects\\${ID}`, "../outside", `projects/../../${ID}`, `projects/../projects/${ID}`,
    `./projects/${ID}`, `projects//${ID}`, `projects\\${ID}`, `projects/${ID}/`,
    `projects/${ID.toUpperCase()}`, `projects/${ID}/child`, `other/${ID}`, "projects/0123456789abcdef0123456789abcdef",
    ...["\n", "\r", "\r\n", "\u2028", "\u2029"].map((ending) => `projects/${ID}${ending}`),
  ]) {
    assert.throws(() => resolveProjectStorageDir("/srv/iris/data", invalid), undefined, String(invalid));
  }
});
