const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildStoragePath,
  publishCompileOutput,
  versionCompileArtifacts,
  hashBuildArtifacts,
  resolveBuildDirectory,
  resolveBuildArtifact,
  normalizeBuildRelativePath,
  listBuildFiles,
  collectBuildArchiveEntries,
  resolveBuildFile,
} = require("../src/builds");
const { createZip, extractZip } = require("../src/zip");

const BUILD_ID = "019c01f0-3aa0-7000-8000-000000000001";

async function tempDir(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("publication refuses an output directory that escapes through a symlink", async (t) => {
  const root = await tempDir(t, "iris-build-symlink-");
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  const staged = path.join(root, "staged-output");
  await fs.mkdir(project);
  await fs.mkdir(outside);
  await fs.mkdir(staged);
  await fs.writeFile(path.join(staged, "main.pdf"), "pdf");
  await fs.symlink(outside, path.join(project, "output"));

  await assert.rejects(
    publishCompileOutput(staged, project, BUILD_ID),
    /Invalid project output directory/
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("a completed build is atomically published under its immutable id", async (t) => {
  const root = await tempDir(t, "iris-build-publish-");
  const project = path.join(root, "project");
  const staged = path.join(root, "staged-output");
  await fs.mkdir(project);
  await fs.mkdir(staged, { recursive: true });
  await fs.writeFile(path.join(staged, "main.pdf"), "pdf");

  const storagePath = await publishCompileOutput(staged, project, BUILD_ID);
  assert.equal(storagePath, buildStoragePath(BUILD_ID));
  assert.equal(await fs.readFile(path.join(project, "output", BUILD_ID, "main.pdf"), "utf8"), "pdf");
  await assert.rejects(fs.stat(staged), (error) => error.code === "ENOENT");
  assert.equal(
    await resolveBuildDirectory(project, BUILD_ID, storagePath),
    await fs.realpath(path.join(project, "output", BUILD_ID))
  );
  await assert.rejects(
    resolveBuildDirectory(project, BUILD_ID, "output/another-build"),
    /Invalid storage path/
  );
});

test("versioned artifacts have stable per-file and aggregate hashes", () => {
  let sequence = 0;
  const artifacts = versionCompileArtifacts([
    { name: "output/main-2.png", base64: Buffer.from("second").toString("base64"), size: 0, mimeType: "image/png" },
    { name: "output/main.png", base64: Buffer.from("first").toString("base64"), size: 0, mimeType: "image/png" },
  ], BUILD_ID, () => `artifact-${++sequence}`);

  assert.deepEqual(artifacts.map((artifact) => artifact.name), [
    `output/${BUILD_ID}/main-2.png`,
    `output/${BUILD_ID}/main.png`,
  ]);
  assert.deepEqual(artifacts.map((artifact) => artifact.size), [6, 5]);
  assert.match(artifacts[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(hashBuildArtifacts(artifacts), hashBuildArtifacts([...artifacts].reverse()));
  assert.notEqual(
    hashBuildArtifacts(artifacts),
    hashBuildArtifacts([{ ...artifacts[0], fileName: "renamed.png" }, artifacts[1]])
  );
});

test("artifact resolution stays inside the published build", async (t) => {
  const project = await tempDir(t, "iris-build-resolve-");
  const buildPath = buildStoragePath(BUILD_ID);
  const directory = path.join(project, "output", BUILD_ID);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "main.pdf"), "pdf");

  const file = await resolveBuildArtifact(project, BUILD_ID, buildPath, `${buildPath}/main.pdf`);
  assert.equal(file.size, 3);
  assert.equal(file.path, await fs.realpath(path.join(directory, "main.pdf")));
  await file.handle.close();
  assert.equal(await resolveBuildArtifact(project, BUILD_ID, buildPath, `${buildPath}/missing.pdf`), null);
  await assert.rejects(
    resolveBuildArtifact(project, BUILD_ID, buildPath, `${buildPath}/../outside.pdf`),
    /Invalid artifact path/
  );
});

test("every regular file in a build is listed and securely downloadable", async (t) => {
  const project = await tempDir(t, "iris-build-files-");
  const buildPath = buildStoragePath(BUILD_ID);
  const directory = path.join(project, "output", BUILD_ID);
  const outside = path.join(project, "outside.txt");
  await fs.mkdir(path.join(directory, "bibliography"), { recursive: true });
  await fs.writeFile(path.join(directory, "main.pdf"), "pdf");
  await fs.writeFile(path.join(directory, "main.midi"), "midi");
  await fs.writeFile(path.join(directory, "bibliography", "main.bbl"), "bbl");
  await fs.writeFile(outside, "outside");
  await fs.symlink(outside, path.join(directory, "linked.txt"));

  await assert.rejects(
    listBuildFiles(project, BUILD_ID, buildPath, { maxEntries: 2, errorCode: "BUILD_FILE_LIST_TOO_LARGE" }),
    (error) => error.code === "BUILD_FILE_LIST_TOO_LARGE"
  );
  const files = await listBuildFiles(project, BUILD_ID, buildPath);
  assert.deepEqual(files.map((file) => file.path), [
    "bibliography/main.bbl",
    "main.midi",
    "main.pdf",
  ]);
  assert.equal(files.find((file) => file.path === "main.midi").size, 4);

  const nested = await resolveBuildFile(project, BUILD_ID, buildPath, "bibliography/main.bbl");
  assert.equal((await nested.handle.readFile()).toString("utf8"), "bbl");
  await nested.handle.close();
  assert.equal(await resolveBuildFile(project, BUILD_ID, buildPath, "linked.txt"), null);
  assert.throws(() => normalizeBuildRelativePath("../outside.txt"), /Invalid build file path/);
  await assert.rejects(
    resolveBuildFile(project, BUILD_ID, buildPath, "bibliography/../main.pdf"),
    /Invalid build file path/
  );
  const stable = await resolveBuildFile(project, BUILD_ID, buildPath, "main.pdf");
  await fs.rm(directory, { recursive: true, force: true });
  assert.equal((await stable.handle.readFile()).toString("utf8"), "pdf");
  await stable.handle.close();
});

test("a build archive preserves all files and empty directories", async (t) => {
  const project = await tempDir(t, "iris-build-archive-");
  const buildPath = buildStoragePath(BUILD_ID);
  const directory = path.join(project, "output", BUILD_ID);
  await fs.mkdir(path.join(directory, "empty"), { recursive: true });
  await fs.mkdir(path.join(directory, "nested"), { recursive: true });
  await fs.writeFile(path.join(directory, "main.pdf"), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(directory, "main.midi"), Buffer.from([4, 5, 6]));
  await fs.writeFile(path.join(directory, "nested", "main.bbl"), "bibliography");

  await assert.rejects(
    collectBuildArchiveEntries(project, BUILD_ID, buildPath, { maxBytes: 8, maxEntries: 100 }),
    (error) => error.code === "BUILD_ARCHIVE_TOO_LARGE"
  );

  const entries = await collectBuildArchiveEntries(project, BUILD_ID, buildPath);
  const archive = extractZip(createZip(entries));
  assert.deepEqual(archive.files.get("main.pdf"), Buffer.from([1, 2, 3]));
  assert.deepEqual(archive.files.get("main.midi"), Buffer.from([4, 5, 6]));
  assert.equal(archive.files.get("nested/main.bbl").toString("utf8"), "bibliography");
  assert.ok(archive.directories.has("empty/"));
});
