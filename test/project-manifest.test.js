const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.IRIS_SECRET ||= "test-only-secret-with-sufficient-entropy";
process.env.DB_PASSWORD ||= "test-only-database-password";

const { writeProjectFile, readProjectFile } = require("../src/server");
const { extractZip } = require("../src/zip");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture } = require("./helpers/server-fixture.cjs");
const options = { timeout: 5000 };
const pgOptions = { skip: !connectionString, timeout: 20000 };
const text = '\uFEFF{"title":"Perché"}\r\n';
const metadataText = '{"project":{"name":"Ordinary source","nodes":[]},"assets":{},"revision":99}\r\n';
const binary = Buffer.from([0, 255, 128, 13, 10, 1]);
const samples = [
  { label: "text", payload: { content: text }, bytes: Buffer.from(text), readText: text },
  { label: "metadata-shaped text", payload: { content: metadataText }, bytes: Buffer.from(metadataText), readText: metadataText },
  { label: "binary upload", payload: { binary: true, data: "data:application/octet-stream;base64,AP+ADQoB" }, bytes: binary, readText: "\0\uFFFD\uFFFD\r\n\u0001" },
];

function textNode(name, content) {
  return { type: "file", id: name, name, path: name, kind: "file", content };
}

function projectData(nodes) {
  return { project: { name: "Canonical project", nodes }, assets: {} };
}

function rootNode(sample) {
  return { type: "file", id: "root", name: "project.json", path: "project.json", kind: "file", ...sample.payload };
}

function replayRootPayload(data, sample) {
  const node = data.project.nodes.find((node) => node.path === "project.json");
  // .json keeps the current text-extension policy even for binary uploads.
  // Replay the original upload bytes, not a text edit of replacement-decoded content.
  delete node.content;
  delete node.data;
  Object.assign(node, sample.payload);
}

function sparse(data) {
  const copy = structuredClone(data);
  const strip = (nodes) => {
    for (const node of nodes) {
      if (node.type === "folder") strip(node.children);
      else { delete node.content; delete node.data; }
    }
  };
  strip(copy.project.nodes);
  copy.assets = {};
  return copy;
}

async function projectDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-manifest-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function assertRootBytes(dir, bytes) {
  assert.ok((await fs.readdir(dir)).includes("project.json"), "save must retain the listed root project.json source");
  assert.deepEqual(await fs.readFile(path.join(dir, "project.json")), bytes);
}

for (const sample of samples) {
  test(`root project.json ${sample.label} survives creation and repeated payload/sparse filesystem saves`, options, async (t) => {
    const dir = await projectDir(t);
    let data = projectData([textNode("main.tex", "main"), rootNode(sample)]);
    for (const mode of ["initial", "payload", "sparse", "payload", "sparse"]) {
      if (mode === "sparse") data = sparse(data);
      else replayRootPayload(data, sample);
      data.project.nodes[0].content = mode;
      await writeProjectFile(dir, data);
      await assertRootBytes(dir, sample.bytes);
      data = await readProjectFile(dir, { strictRead: true });
      assert.equal(data.project.name, "Canonical project");
      const node = data.project.nodes.find((node) => node.path === "project.json");
      assert.equal(node.id, "root");
      assert.equal(node.encoding, "utf8");
      assert.equal(node.content, sample.readText);
      assert.equal(node.data, undefined);
      const manifest = JSON.parse(await fs.readFile(path.join(dir, ".iris/project.json"), "utf8"));
      const stored = manifest.project.nodes.find((node) => node.path === "project.json");
      assert.equal(stored.encoding, "utf8");
      assert.equal(stored.content, undefined);
      assert.equal(stored.data, undefined);
    }
  });
}

for (const sample of [samples[0], samples[2]]) {
  test(`a sparse filesystem save retains existing root project.json ${sample.label} bytes`, options, async (t) => {
    const dir = await projectDir(t);
    await writeProjectFile(dir, projectData([textNode("main.tex", "main")]));
    await fs.writeFile(path.join(dir, "project.json"), sample.bytes);
    const data = sparse(projectData([textNode("main.tex", "main"), rootNode(sample)]));
    data.project.nodes[0].content = "unrelated edit";
    await writeProjectFile(dir, data);
    await assertRootBytes(dir, sample.bytes);
    const loaded = await readProjectFile(dir);
    assert.equal(loaded.project.nodes.find((node) => node.path === "project.json").content, sample.readText);
  });
}

function folderData() {
  return projectData([
    textNode("main.tex", "main"),
    { type: "folder", name: "project.json", children: [
      { ...textNode("project.json", metadataText), path: "project.json/project.json" },
    ] },
    { type: "folder", name: "nested", children: [
      { ...textNode("project.json", text), path: "nested/project.json" },
    ] },
  ]);
}

test("a root project.json directory and nested project.json sources survive full and sparse saves", options, async (t) => {
  const dir = await projectDir(t);
  await assert.doesNotReject(writeProjectFile(dir, folderData()));
  for (let pass = 0; pass < 2; pass++) {
    const data = await readProjectFile(dir, { strictRead: true });
    const folder = data.project.nodes.find((node) => node.name === "project.json");
    assert.equal(folder.type, "folder");
    assert.equal(folder.children[0].content, metadataText);
    await writeProjectFile(dir, sparse(data));
    assert.equal((await fs.stat(path.join(dir, "project.json"))).isDirectory(), true);
    assert.deepEqual(await fs.readFile(path.join(dir, "project.json/project.json")), Buffer.from(metadataText));
    assert.deepEqual(await fs.readFile(path.join(dir, "nested/project.json")), Buffer.from(text));
  }
});

test("readProjectFile requires the canonical manifest even when root project.json looks like metadata", options, async (t) => {
  const dir = await projectDir(t);
  await fs.writeFile(path.join(dir, "project.json"), metadataText);
  for (const strictRead of [false, true]) {
    await assert.rejects(readProjectFile(dir, { strictRead }), { code: "ENOENT", path: path.join(dir, ".iris/project.json") });
  }
  assert.deepEqual(await fs.readFile(path.join(dir, "project.json")), Buffer.from(metadataText));
  await assert.rejects(fs.stat(path.join(dir, ".iris")), { code: "ENOENT" });
});

test("a malformed canonical manifest is not rescued by metadata-shaped root source", options, async (t) => {
  const dir = await projectDir(t);
  await fs.mkdir(path.join(dir, ".iris"));
  await fs.writeFile(path.join(dir, ".iris/project.json"), "{broken");
  await fs.writeFile(path.join(dir, "project.json"), metadataText);
  for (const strictRead of [false, true]) await assert.rejects(readProjectFile(dir, { strictRead }), SyntaxError);
  assert.equal(await fs.readFile(path.join(dir, ".iris/project.json"), "utf8"), "{broken");
  assert.deepEqual(await fs.readFile(path.join(dir, "project.json")), Buffer.from(metadataText));
});

test("authoritative pruning removes unlisted project.json files and directories like ordinary source", options, async (t) => {
  const dir = await projectDir(t);
  const data = projectData([textNode("main.tex", "keep")]);
  await writeProjectFile(dir, data);
  await fs.mkdir(path.join(dir, "output"));
  await fs.writeFile(path.join(dir, "output/keep.pdf"), "output");
  await fs.writeFile(path.join(dir, ".iris/cache"), "cache");
  for (const directory of [false, true]) {
    if (directory) {
      await fs.mkdir(path.join(dir, "project.json"));
      await fs.writeFile(path.join(dir, "project.json/child.txt"), "unlisted");
    } else await fs.writeFile(path.join(dir, "project.json"), metadataText);
    await fs.writeFile(path.join(dir, "unlisted.txt"), "unlisted");
    await writeProjectFile(dir, data);
    for (const rel of ["project.json", "unlisted.txt"]) await assert.rejects(fs.stat(path.join(dir, rel)), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(dir, "main.tex"), "utf8"), "keep");
    assert.equal(await fs.readFile(path.join(dir, "output/keep.pdf"), "utf8"), "output");
    assert.equal(await fs.readFile(path.join(dir, ".iris/cache"), "utf8"), "cache");
  }
});

async function setup(t, data) {
  const f = await serverFixture(t);
  const user = (await f.pool.query("INSERT INTO users (id, username, email, display_name) VALUES ($1, 'manifest', 'manifest@example.test', 'Manifest') RETURNING *", [uuidv7()])).rows[0];
  const request = (url, opts = {}) => f.request(url, { cookie: f.cookieFor(user), ...opts });
  const created = await request("/api/projects", { method: "POST", body: { name: "Canonical project", data } });
  assert.equal(created.status, 201);
  const out = await created.json();
  const id = out.project.id;
  return { ...f, request, out, id, url: `/api/projects/${id}`, dir: path.join(f.dataDir, "projects", id) };
}

for (const sample of samples) {
  test(`PostgreSQL HTTP root project.json ${sample.label} survives saves, download and archive with separate canonical metadata`, pgOptions, async (t) => {
    const f = await setup(t, projectData([textNode("main.tex", "main"), rootNode(sample)]));
    const rootId = f.out.data.project.nodes.find((node) => node.path === "project.json").id;
    for (let revision = 0; revision <= 3; revision++) {
      const response = await f.request(f.url);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.revision, revision);
      assert.equal(data.project.name, "Canonical project");
      const node = data.project.nodes.find((node) => node.path === "project.json");
      assert.ok(node, "GET must include the saved root project.json source");
      assert.equal(node.id, rootId);
      assert.equal(node.encoding, "utf8");
      assert.equal(node.content, sample.readText);
      assert.equal(node.data, undefined);
      await assertRootBytes(f.dir, sample.bytes);
      if (revision < 3) {
        const next = revision === 1 ? data : sparse(data);
        if (revision === 1) replayRootPayload(next, sample);
        next.project.nodes[0].content = `unrelated edit ${revision}`;
        const saved = await f.request(f.url, { method: "PUT", body: { baseRevision: revision, data: next } });
        assert.equal(saved.status, 200);
        assert.equal((await saved.json()).data.revision, revision + 1);
      }
    }
    const download = await f.request(f.url + "/files/download?path=project.json");
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), sample.bytes);
    const exported = await f.request(f.url + "/archive");
    assert.equal(exported.status, 200);
    const archive = extractZip(Buffer.from(await exported.arrayBuffer()));
    assert.deepEqual(archive.files.get("project.json"), sample.bytes);
    const manifest = JSON.parse(archive.files.get(".iris/project.json"));
    assert.equal(manifest.project.name, "Canonical project");
    assert.equal(manifest.revision, 3);
    assert.equal(manifest.irisArchive.format, "iris-project");
    assert.equal(manifest.irisArchive.version, 1);
    const stored = manifest.project.nodes.find((node) => node.path === "project.json");
    assert.equal(stored.id, rootId);
    assert.equal(stored.encoding, "utf8");
    assert.equal(stored.content, undefined);
    assert.equal(stored.data, undefined);
    assert.deepEqual(manifest.assets, {});
    const row = (await f.pool.query("SELECT path, deleted_at FROM project_files WHERE id = $1", [rootId])).rows[0];
    assert.deepEqual(row, { path: "project.json", deleted_at: null });
  });
}

test("PostgreSQL HTTP saves and exports a directory named project.json and nested sources", pgOptions, async (t) => {
  const f = await setup(t, folderData());
  const response = await f.request(f.url);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.project.nodes.find((node) => node.name === "project.json").type, "folder");
  const saved = await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data: sparse(data) } });
  assert.equal(saved.status, 200);
  const exported = await f.request(f.url + "/archive");
  assert.equal(exported.status, 200);
  const archive = extractZip(Buffer.from(await exported.arrayBuffer()));
  assert.ok(archive.directories.has("project.json/"));
  assert.deepEqual(archive.files.get("project.json/project.json"), Buffer.from(metadataText));
  assert.deepEqual(archive.files.get("nested/project.json"), Buffer.from(text));
  assert.equal(JSON.parse(archive.files.get(".iris/project.json")).project.name, "Canonical project");
});

for (const state of ["missing", "malformed"]) {
  test(`PostgreSQL HTTP rejects a ${state} canonical manifest despite a metadata-shaped root source`, pgOptions, async (t) => {
    const f = await setup(t, projectData([textNode("main.tex", "main")]));
    const manifestPath = path.join(f.dir, ".iris/project.json");
    await fs.writeFile(path.join(f.dir, "project.json"), metadataText);
    if (state === "missing") await fs.unlink(manifestPath);
    else await fs.writeFile(manifestPath, "{broken");
    for (const suffix of ["", "/archive"]) {
      const response = await f.request(f.url + suffix);
      assert.equal(response.status, 500, `GET ${suffix || "/"} requires valid canonical metadata`);
      assert.equal((await response.json()).errorCode, "SERVER_ERROR");
    }
    assert.deepEqual(await fs.readFile(path.join(f.dir, "project.json")), Buffer.from(metadataText));
    assert.equal(await fs.readFile(path.join(f.dir, "main.tex"), "utf8"), "main");
    if (state === "missing") await assert.rejects(fs.stat(manifestPath), { code: "ENOENT" });
    else assert.equal(await fs.readFile(manifestPath, "utf8"), "{broken");
    assert.equal((await f.pool.query("SELECT revision FROM projects WHERE id = $1", [f.id])).rows[0].revision, 0);
  });
}
