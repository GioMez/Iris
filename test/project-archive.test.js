const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.IRIS_SECRET = "test-only-secret-with-sufficient-entropy";

const { buildProjectArchive, parseProjectArchive } = require("../src/server");
const { createZip, extractZip, safeZipPath } = require("../src/zip");

test("ZIP codec preserves files, binary contents, and empty directories", () => {
  const binary = Buffer.from([0, 1, 2, 255]);
  const archive = createZip([
    { name: "sources", directory: true },
    { name: "sources/main.ly", data: Buffer.from("{ c1 }", "utf8") },
    { name: "empty", directory: true },
    { name: "image.bin", data: binary },
  ]);
  const unpacked = extractZip(archive);
  assert.deepEqual([...unpacked.directories], ["sources/", "empty/"]);
  assert.equal(unpacked.files.get("sources/main.ly").toString("utf8"), "{ c1 }");
  assert.deepEqual(unpacked.files.get("image.bin"), binary);
});

test("ZIP codec rejects unsafe paths and corrupted contents", () => {
  for (const name of ["../escape", "/absolute", "C:/absolute", "C:relative", "folder/../../escape"]) {
    assert.throws(() => safeZipPath(name), (error) => error.code === "ZIP_PATH_INVALID");
  }
  assert.throws(
    () => createZip([{ name: "../escape", data: "bad" }]),
    (error) => error.code === "ZIP_PATH_INVALID"
  );

  const archive = createZip([{ name: "main.tex", data: "hello" }]);
  const contentOffset = archive.indexOf(Buffer.from("hello"));
  archive[contentOffset] ^= 0xff;
  assert.throws(() => extractZip(archive), (error) => error.code === "ZIP_INVALID");
});

test("project import accepts only versioned Iris archives", () => {
  const manifest = (version = 1) => Buffer.from(JSON.stringify({
    irisArchive: { format: "iris-project", version },
    project: { name: "Imported", nodes: [] },
  }));
  const valid = parseProjectArchive(createZip([{ name: ".iris/project.json", data: manifest() }]));
  assert.equal(valid.data.project.name, "Imported");

  assert.throws(
    () => parseProjectArchive(createZip([{ name: "main.tex", data: "source" }])),
    (error) => error.errorCode === "PROJECT_ARCHIVE_INVALID" && error.status === 400
  );
  assert.throws(
    () => parseProjectArchive(createZip([{ name: ".iris/project.json", data: manifest(2) }])),
    (error) => error.errorCode === "PROJECT_ARCHIVE_VERSION_UNSUPPORTED" && error.status === 400
  );
  assert.throws(
    () => parseProjectArchive(createZip([
      { name: ".iris/project.json", data: manifest() },
      { name: ".iris/private-cache", data: "reserved" },
    ])),
    (error) => error.errorCode === "PROJECT_ARCHIVE_INVALID"
  );
});

test("project export includes the filesystem and a portable Iris manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-project-archive-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".iris", "texmf-var"), { recursive: true });
  await fs.mkdir(path.join(root, "fonts"));
  await fs.mkdir(path.join(root, "output"));
  await fs.mkdir(path.join(root, "empty"));
  await fs.writeFile(path.join(root, "main.ly"), "\\score { { c1 } }", "utf8");
  await fs.writeFile(path.join(root, "fonts", "Custom.otf"), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(root, "payload.bin"), Buffer.from([7, 8, 9]));
  await fs.writeFile(path.join(root, "output", "main.png"), Buffer.from([4, 5, 6]));
  await fs.writeFile(path.join(root, ".iris", "texmf-var", "cache"), "private cache");
  await fs.writeFile(path.join(root, ".iris", "project.json"), JSON.stringify({
    project: {
      name: "Old name",
      nodes: [
        { type: "file", id: "main", name: "main.ly", path: "main.ly", kind: "ly", content: "duplicated" },
        { type: "file", id: "payload", name: "payload.bin", path: "payload.bin", kind: "file", data: "duplicated" },
      ],
    },
    projectType: "lilypond",
    engine: "lilypond",
    compileProfile: { mode: "quick" },
    lilypondArgs: "-dno-point-and-click",
    lilypondFormat: "png",
    fonts: [{ name: "Custom.otf", path: "fonts/Custom.otf", data: "duplicated" }],
    assets: { "fonts/Custom.otf": "duplicated" },
  }), "utf8");

  const unpacked = extractZip(await buildProjectArchive(root, "Portable score"));
  assert.equal(unpacked.files.get("main.ly").toString("utf8"), "\\score { { c1 } }");
  assert.deepEqual(unpacked.files.get("fonts/Custom.otf"), Buffer.from([1, 2, 3]));
  assert.deepEqual(unpacked.files.get("payload.bin"), Buffer.from([7, 8, 9]));
  assert.deepEqual(unpacked.files.get("output/main.png"), Buffer.from([4, 5, 6]));
  assert.ok(unpacked.directories.has("empty/"));
  assert.equal(unpacked.files.has(".iris/texmf-var/cache"), false);

  const manifest = JSON.parse(unpacked.files.get(".iris/project.json").toString("utf8"));
  assert.deepEqual(manifest.irisArchive.format, "iris-project");
  assert.equal(manifest.irisArchive.version, 1);
  assert.equal(manifest.project.name, "Portable score");
  assert.equal(manifest.project.nodes[0].content, undefined);
  assert.equal(manifest.project.nodes[0].encoding, "utf8");
  assert.equal(manifest.project.nodes[1].data, undefined);
  assert.equal(manifest.project.nodes[1].encoding, "base64");
  assert.equal(manifest.fonts[0].data, undefined);
  assert.deepEqual(manifest.assets, {});
  assert.equal(manifest.lilypondFormat, "png");
  assert.equal(manifest.lilypondArgs, "-dno-point-and-click");
});
