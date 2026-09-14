const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const release = path.resolve(__dirname, "../scripts/release.cjs");
const required = ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", ".npmrc", ".env.example",
  ".dockerignore", "Dockerfile", "docker-compose.yml", "db/schema.sql", "db/init/01-create-iris-user.sh",
  "src/server.js", "public/Iris.html", "public/templates/.metadata.json", "scripts/test.cjs", "scripts/smoke.cjs"];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-package-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), output = path.join(root, "out"), manifest = path.join(root, "manifest.json");
  const files = { ...Object.fromEntries(required.map((name) => [name, name])),
    "package.json": JSON.stringify({ name: "iris", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({ name: "iris", version: "1.0.0", packages: { "": { name: "iris", version: "1.0.0" } } }),
    "test/example.test.js": "// public test", "docs/images/demo.png": Buffer.from([0, 1, 255]) };
  for (const [name, data] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fs.writeFile(path.join(source, name), data);
  }
  await fs.writeFile(manifest, JSON.stringify(Object.keys(files)));
  const run = (...extra) => spawnSync(process.execPath, [release, "--candidate", source, "--manifest", manifest, "--output", output, ...extra], { encoding: "utf8", timeout: 15000 });
  return { root, source, output, manifest, files, run };
}

test("candidate archive is byte-reproducible, extractable, and ignores unlisted local secrets", async (t) => {
  const f = await fixture(t);
  // These must never be opened or inferred into the explicit source manifest.
  for (const name of [".env", ".env.production", "data/database.dump", ".drafts/notes.md", ".superpowers/report.md", "node_modules/private.js", "docs/superpowers/plan.md"]) {
    await fs.mkdir(path.dirname(path.join(f.source, name)), { recursive: true });
    await fs.writeFile(path.join(f.source, name), "DO NOT SHIP");
  }
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const archive = path.join(f.output, "iris-1.0.0.tar.gz");
  const first = await fs.readFile(archive);
  const sums = await fs.readFile(path.join(f.output, "SHA256SUMS"), "utf8");
  assert.equal(sums, `${createHash("sha256").update(first).digest("hex")}  iris-1.0.0.tar.gz\n`);
  await fs.utimes(path.join(f.source, "src/server.js"), new Date(), new Date());
  await fs.writeFile(f.manifest, JSON.stringify(Object.keys(f.files).reverse()));
  result = f.run("--output", path.join(f.root, "second"));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readFile(path.join(f.root, "second/iris-1.0.0.tar.gz")), first);
  const extracted = path.join(f.root, "extracted");
  await fs.mkdir(extracted);
  const tar = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const walk = async (dir, prefix = "") => (await Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(async (entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))).flat();
  assert.deepEqual((await walk(path.join(extracted, "iris-1.0.0"))).sort(), Object.keys(f.files).sort());
  for (const [name, data] of Object.entries(f.files)) assert.deepEqual(await fs.readFile(path.join(extracted, "iris-1.0.0", name)), Buffer.from(data));
  assert.equal((await fs.stat(path.join(extracted, "iris-1.0.0/db/init/01-create-iris-user.sh"))).mode & 0o777, 0o755);
});

test("explicit manifests cannot smuggle excluded paths, traversal, duplicate names or symlinks", async (t) => {
  const f = await fixture(t);
  for (const name of [".env", ".env.local", "src/.env", "data/x", ".drafts/x", ".superpowers/x", "node_modules/x", "docs/superpowers/x", "src/private.key", "test/output.log", "src/x~", "../secret", "/absolute", "src/../README.md", "src\\secret", "src/server.js"]) {
    await fs.writeFile(f.manifest, JSON.stringify([...Object.keys(f.files), name]));
    const result = f.run();
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /excluded|unsafe|duplicate/i, name);
    await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
  }
  await fs.symlink(path.join(f.source, "README.md"), path.join(f.source, "src/link.js"));
  await fs.writeFile(f.manifest, JSON.stringify([...Object.keys(f.files), "src/link.js"]));
  assert.match(f.run().stderr, /symbolic link/i);
  await fs.symlink(path.join(f.source, "src"), path.join(f.source, "alias"));
  await fs.writeFile(f.manifest, JSON.stringify([...Object.keys(f.files), "alias/server.js"]));
  assert.equal(f.run().status, 1);
});

test("release rejects mismatched metadata, incomplete manifests, implicit checkout and existing output", async (t) => {
  const f = await fixture(t);
  let result = spawnSync(process.execPath, [release, "--output", f.output], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--ref|--candidate/);
  await fs.writeFile(path.join(f.source, "package-lock.json"), JSON.stringify({ version: "0.9.0", packages: { "": { version: "1.0.0" } } }));
  assert.match(f.run().stderr, /version|metadata/i);
  await fs.writeFile(path.join(f.source, "package-lock.json"), f.files["package-lock.json"]);
  await fs.writeFile(f.manifest, JSON.stringify(Object.keys(f.files).filter((name) => name !== "db/schema.sql")));
  assert.match(f.run().stderr, /missing.*db\/schema.sql/i);
  await fs.writeFile(f.manifest, JSON.stringify(Object.keys(f.files)));
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.run().status, 1, "never replace an existing release directory");
});
