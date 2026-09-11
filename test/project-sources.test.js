const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.IRIS_SECRET ||= "test-only-secret-with-sufficient-entropy";
process.env.DB_PASSWORD ||= "test-only-database-password";

const { writeProjectFile, readProjectFile, hydrateProjectPayloads, buildProjectArchive } = require("../src/server");
const { extractZip } = require("../src/zip");
const Bibliography = require("../public/iris-bibliography");

const BIB = "@article{knuth1984,\n  author = {Donald E. Knuth},\n  title = {Literate Programming},\n}\n";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const options = { timeout: 5000 };

async function projectDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-sources-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function projectData(nodes, assets = {}) {
  return { project: { name: "Sources", nodes }, assets };
}

function textNode(name, content) {
  return { type: "file", id: name, name, kind: "tex", path: name, content };
}

for (const kind of ["bib", "ris"]) {
  const name = `refs.${kind}`;
  const text = kind === "bib" ? "\uFEFF@book{a, title={Perch\u00e9}}\r\n" : "\uFEFFTY  - BOOK\r\nTI  - Perch\u00e9\r\nER  - \r\n";
  test(`${kind} UTF-8 BOM and CRLF round-trip as editable text`, options, async (t) => {
    const dir = await projectDir(t);
    const bytes = Buffer.from(text);
    const upload = `data:application/octet-stream;base64,${bytes.toString("base64")}`;
    await writeProjectFile(dir, projectData([{ type: "file", id: "refs", name, path: name, data: upload }]));
    const data = await readProjectFile(dir);
    const node = data.project.nodes[0];
    assert.equal(node.kind, kind);
    assert.equal(node.content, text);
    assert.equal(node.encoding, "utf8");
    assert.equal(node.data, undefined);
    assert.equal(data.assets[name], undefined);
    await writeProjectFile(dir, data);
    assert.deepEqual(await fs.readFile(path.join(dir, name)), bytes);
  });

  for (const [label, bytes] of [["invalid UTF-8", Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28, 0xff, 13, 10])], ["NUL", Buffer.from("text\0text")]]) {
    test(`${kind} ${label} stays in the manifest and preserves bytes through saves, materialization and export`, options, async (t) => {
      const dir = await projectDir(t);
      await writeProjectFile(dir, projectData([textNode("main.tex", "original")]));
      await fs.writeFile(path.join(dir, name), bytes);
      // First read discovers an unlisted filesystem file; the second hydrates its manifest entry.
      for (let pass = 0; pass < 2; pass++) {
        const data = await readProjectFile(dir, { strictRead: true });
        const node = data.project.nodes.find((node) => node.name === name);
        assert.equal(node.sourceError, "BIBLIOGRAPHY_INVALID_ENCODING");
        assert.equal(node.content, undefined);
        assert.equal(node.readOnly, undefined);
        data.project.nodes[0].content = "unrelated edit";
        await writeProjectFile(dir, data);
        assert.deepEqual(await fs.readFile(path.join(dir, name)), bytes);
        const manifest = JSON.parse(await fs.readFile(path.join(dir, ".iris/project.json"), "utf8"));
        const stored = manifest.project.nodes.find((node) => node.name === name);
        assert.ok(stored);
        assert.equal(Object.hasOwn(stored, "sourceError"), false);
        assert.equal(Object.hasOwn(stored, "readOnly"), false);
        await hydrateProjectPayloads(dir, data);
        assert.equal(node.content, undefined);
        assert.equal(node.data, `data:text/plain; charset=utf-8;base64,${bytes.toString("base64")}`);
        const staging = await projectDir(t);
        await writeProjectFile(staging, data);
        assert.deepEqual(await fs.readFile(path.join(staging, name)), bytes);
        const archive = extractZip(await buildProjectArchive(dir, "Sources"));
        assert.deepEqual(archive.files.get(name), bytes);
        assert.equal(JSON.parse(archive.files.get(".iris/project.json")).project.nodes.find((node) => node.name === name).sourceError, undefined);
      }
      await fs.writeFile(path.join(dir, name), text);
      const repaired = (await readProjectFile(dir)).project.nodes.find((node) => node.name === name);
      assert.equal(repaired.sourceError, undefined);
      assert.equal(repaired.content, text);
    });
  }

  test(`${kind} malformed bibliography in valid UTF-8 remains editable source`, options, async (t) => {
    const dir = await projectDir(t);
    const malformed = kind === "bib" ? "@book{broken," : "TY  - BOOK\r\nTI  - missing ER\r\n";
    await writeProjectFile(dir, projectData([textNode(name, malformed)]));
    const data = await readProjectFile(dir);
    assert.equal(data.project.nodes[0].content, malformed);
    assert.equal(data.project.nodes[0].sourceError, undefined);
    data.project.nodes[0].content += "edited";
    await writeProjectFile(dir, data);
    assert.equal(await fs.readFile(path.join(dir, name), "utf8"), malformed + "edited");
  });
}

test("a text file attached as a data URL is stored as its decoded text", async (t) => {
  const dir = await projectDir(t);
  const upload = `data:application/octet-stream;base64,${Buffer.from(BIB, "utf8").toString("base64")}`;
  await writeProjectFile(dir, projectData([
    textNode("main.tex", "\\documentclass{article}"),
    { type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib", data: upload },
  ], { "refs.bib": upload }));

  assert.equal(await fs.readFile(path.join(dir, "refs.bib"), "utf8"), BIB);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, ".iris", "project.json"), "utf8"));
  const stored = manifest.project.nodes.find((node) => node.name === "refs.bib");
  assert.equal(stored.encoding, "utf8");
  assert.equal(stored.binary, undefined);
});

test("saving a project again never rewrites a text source as its data URL", async (t) => {
  const dir = await projectDir(t);
  // What an older client holds after loading a project whose manifest flagged the
  // uploaded .bib as base64: the node still claims to be binary and the asset map
  // still carries the data URL the server built with a parameterised media type.
  const stale = `data:text/plain; charset=utf-8;base64,${Buffer.from(BIB, "utf8").toString("base64")}`;
  await fs.mkdir(dir, { recursive: true });
  await writeProjectFile(dir, projectData([textNode("main.tex", "x")]));
  await fs.writeFile(path.join(dir, "refs.bib"), BIB, "utf8");

  await writeProjectFile(dir, projectData([
    textNode("main.tex", "x"),
    { type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib", binary: true, encoding: "base64", content: BIB },
  ], { "refs.bib": stale }));

  assert.equal(await fs.readFile(path.join(dir, "refs.bib"), "utf8"), BIB);
});

test("a legacy manifest that flags a text source as base64 heals on the next read", async (t) => {
  const dir = await projectDir(t);
  await writeProjectFile(dir, projectData([textNode("main.tex", "x")]));
  await fs.writeFile(path.join(dir, "refs.bib"), BIB, "utf8");
  const manifestPath = path.join(dir, ".iris", "project.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.project.nodes.push({
    type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib", binary: true, encoding: "base64",
  });
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const data = await readProjectFile(dir);
  const node = data.project.nodes.find((entry) => entry.name === "refs.bib");
  assert.equal(node.content, BIB);
  assert.equal(node.encoding, "utf8");
  assert.equal(node.binary, undefined);
  assert.equal(node.data, undefined);
  // The bytes are the file's own, so they are not duplicated into the asset map
  // that the write path replays for binary files.
  assert.equal(data.assets["refs.bib"], undefined);
});

test("binary files still round-trip through their data URL", async (t) => {
  const dir = await projectDir(t);
  const upload = `data:image/png;base64,${PNG.toString("base64")}`;
  await writeProjectFile(dir, projectData([
    textNode("main.tex", "x"),
    { type: "file", id: "i", name: "plot.png", kind: "img", path: "plot.png", data: upload },
  ], { "plot.png": upload }));
  assert.deepEqual(await fs.readFile(path.join(dir, "plot.png")), PNG);

  const data = await readProjectFile(dir);
  const node = data.project.nodes.find((entry) => entry.name === "plot.png");
  assert.equal(node.encoding, "base64");
  assert.equal(node.binary, true);
  assert.equal(node.data, upload);
  assert.equal(data.assets["plot.png"], upload);

  // A save that carries only the asset map, as the browser sends for a file it
  // never opened, must leave the bytes untouched.
  await writeProjectFile(dir, data);
  assert.deepEqual(await fs.readFile(path.join(dir, "plot.png")), PNG);
});

test("a build compiles the sources the client did not send, not empty files", async (t) => {
  const dir = await projectDir(t);
  const style = "%% bibliography style\n";
  await writeProjectFile(dir, projectData([
    textNode("main.tex", "\\documentclass{article}\\bibliography{refs}"),
    { type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib", content: BIB },
    { type: "file", id: "s", name: "num.bst", kind: "file", path: "num.bst", content: style },
    { type: "file", id: "i", name: "plot.png", kind: "img", path: "plot.png", data: `data:image/png;base64,${PNG.toString("base64")}` },
  ]));

  // What the browser sends on compile: content only for the file being edited.
  const snapshot = projectData([
    textNode("main.tex", "\\documentclass{article}\\bibliography{refs}"),
    { type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib" },
    { type: "file", id: "s", name: "num.bst", kind: "file", path: "num.bst", binary: true, encoding: "base64" },
    { type: "file", id: "i", name: "plot.png", kind: "img", path: "plot.png" },
  ]);
  await writeProjectFile(dir, snapshot);
  await hydrateProjectPayloads(dir, snapshot);

  // The staging tree of a build starts empty, so what the snapshot omits is lost.
  const staging = await projectDir(t);
  await writeProjectFile(staging, snapshot);
  assert.equal(await fs.readFile(path.join(staging, "refs.bib"), "utf8"), BIB);
  assert.equal(await fs.readFile(path.join(staging, "num.bst"), "utf8"), style);
  assert.deepEqual(await fs.readFile(path.join(staging, "plot.png")), PNG);
});

test("completing a build snapshot never replaces what the client did send", async (t) => {
  const dir = await projectDir(t);
  await writeProjectFile(dir, projectData([
    textNode("main.tex", "on disk"),
    { type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib", content: BIB },
  ]));
  const snapshot = projectData([
    textNode("main.tex", "just typed"),
    { type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib", content: "" },
  ]);
  await hydrateProjectPayloads(dir, snapshot);
  assert.equal(snapshot.project.nodes[0].content, "just typed");
  // An empty string is an edit that cleared the file, not an omission.
  assert.equal(snapshot.project.nodes[1].content, "");
});

test("the build copies saved source bytes while holding the project gate", () => {
  const server = require("node:fs").readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const compile = server.slice(server.indexOf("async function compileProject"), server.indexOf("/* ---------------- retention and garbage collection"));
  const gatedSetup = compile.match(/await authorizedProjectGate\(id, user, "compile", async \(project\) => \{[\s\S]*?return setup;\s*\}\);/)?.[0];
  assert.ok(gatedSetup, "the entire save and snapshot copy must share the project gate");
  const save = gatedSetup.indexOf("await saveProjectTree(");
  const commit = gatedSetup.indexOf("confirmedSetup = setup;");
  const read = gatedSetup.indexOf("await fs.readFile(path.join(setup.row.storageDir, file.path))");
  const write = gatedSetup.indexOf("await fs.writeFile(dest, bytes)");
  assert.ok(save >= 0 && commit > save && read > commit && write > read,
    "staging must copy the committed bytes, not hydrate or replay the sparse request");
  assert.match(gatedSetup, /for \(const file of setup\.buildFiles\)/);
  assert.match(gatedSetup, /const dest = path\.join\(stagingDir, file\.path\)/);
});

test("the upload dialog attaches a text file as text, not as a data URL", () => {
  const app = require("node:fs").readFileSync(path.join(__dirname, "..", "public", "iris-app.js"), "utf8");
  const helpers = app.slice(app.indexOf("function isTextUploadName"), app.indexOf("function uploadNameWithExtension"));
  const { isTextUploadName, decodeTextUpload } = new Function("window",
    `${helpers}; return { isTextUploadName, decodeTextUpload };`
  )({ IrisBibliography: Bibliography });

  assert.equal(isTextUploadName("refs.bib"), true);
  assert.equal(isTextUploadName("refs.RIS"), true);
  assert.equal(isTextUploadName("chapter.TEX"), true);
  assert.equal(isTextUploadName("figure.png"), false);

  const utf8 = "@book{a, title = {Perché}}\n";
  assert.equal(
    decodeTextUpload(`data:application/octet-stream;base64,${Buffer.from(utf8, "utf8").toString("base64")}`),
    utf8
  );
  // Bytes the editor could not represent stay on the binary path.
  assert.equal(decodeTextUpload(`data:application/octet-stream;base64,${Buffer.from([0xff, 0xfe, 0x41]).toString("base64")}`), null);
  assert.equal(decodeTextUpload("not-a-data-url"), null);

  const bom = "\uFEFFTY  - BOOK\r\nER  - \r\n";
  assert.equal(decodeTextUpload(`data:text/plain;base64,${Buffer.from(bom).toString("base64")}`, "refs.ris"), bom);
});

test("a text source the client does not send keeps the bytes already on disk", async (t) => {
  const dir = await projectDir(t);
  await writeProjectFile(dir, projectData([textNode("main.tex", "x")]));
  await fs.writeFile(path.join(dir, "refs.bib"), BIB, "utf8");
  await writeProjectFile(dir, projectData([
    textNode("main.tex", "x"),
    { type: "file", id: "b", name: "refs.bib", kind: "bib", path: "refs.bib" },
  ]));
  assert.equal(await fs.readFile(path.join(dir, "refs.bib"), "utf8"), BIB);
});

const pgOptions = { skip: !process.env.TEST_DATABASE_URL, timeout: 20000 };
async function bibliographyServer(t, kind, extension = kind) {
  const { serverFixture } = require("./helpers/server-fixture.cjs");
  const { uuidv7 } = require("../src/ids");
  const f = await serverFixture(t, { IRIS_SECRET: process.env.IRIS_SECRET, DB_PASSWORD: process.env.DB_PASSWORD });
  const user = (await f.pool.query("INSERT INTO users (id, username, email, display_name) VALUES ($1, 'sources', 'sources@example.test', 'Sources') RETURNING *", [uuidv7()])).rows[0];
  // makeToken uses the fixture's explicitly supplied process secret.
  const cookie = `iris_session=${f.app.makeToken(user)}`;
  const request = (url, opts = {}) => f.request(url, { cookie, ...opts });
  const text = kind === "bib" ? "\uFEFF@book{a, title={Perch\u00e9}}\r\n" : "\uFEFFTY  - BOOK\r\nTI  - Perch\u00e9\r\nER  - \r\n";
  const res = await request("/api/projects", { method: "POST", body: { name: "Bibliography", data: projectData([
    textNode("main.tex", "main"), { ...textNode(`refs.${extension}`, text), kind: extension === kind ? kind : "file" },
  ]) } });
  assert.equal(res.status, 201);
  const out = await res.json();
  const id = out.project.id;
  return { ...f, user, request, out, text, name: `refs.${extension}`, url: `/api/projects/${id}`, dir: path.join(f.dataDir, "projects", id), fileId: out.data.project.nodes[1].id };
}

for (const kind of ["bib", "ris"]) {
  test(`PostgreSQL bibliography ${kind}: HTTP reads, sparse saves, versions and export preserve exact UTF-8`, pgOptions, async (t) => {
    const f = await bibliographyServer(t, kind);
    const response = await f.request(f.url);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.project.nodes[1].kind, kind);
    assert.equal(data.project.nodes[1].content, f.text);
    delete data.project.nodes[1].content;
    data.project.nodes[0].content = "unrelated edit";
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } })).status, 200);
    assert.deepEqual(await fs.readFile(path.join(f.dir, `refs.${kind}`)), Buffer.from(f.text));
    assert.equal((await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).status, 200);
    const versions = (await (await f.request(`${f.url}/files/${f.fileId}/versions`)).json()).versions;
    assert.equal(versions.length, 1);
    const version = await (await f.request(`${f.url}/files/${f.fileId}/versions/${versions[0].id}`)).json();
    assert.equal(version.content, f.text);
    assert.equal(version.size, Buffer.byteLength(f.text));
    const exported = await f.request(f.url + "/archive");
    assert.equal(exported.status, 200);
    assert.deepEqual(extractZip(Buffer.from(await exported.arrayBuffer())).files.get(`refs.${kind}`), Buffer.from(f.text));
  });

  test(`PostgreSQL bibliography ${kind}: corrupt bytes reject direct join and survive unrelated saves and export`, pgOptions, async (t) => {
    const f = await bibliographyServer(t, kind);
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0xff, 13, 10]);
    await fs.writeFile(path.join(f.dir, `refs.${kind}`), bytes);
    const session = { user: { sub: f.user.id, exp: Math.floor(Date.now() / 1000) + 60 }, rooms: new Map(), socket: { OPEN: 1, readyState: 1 } };
    await assert.rejects(f.app.collabJoin(session, f.fileId), (err) => err.code === "BIBLIOGRAPHY_INVALID_ENCODING");
    assert.equal(f.app.collabRooms.get(f.fileId), null);
    assert.equal(session.rooms.size, 0);
    const WebSocket = require("ws");
    const ws = new WebSocket(f.baseUrl.replace("http:", "ws:") + "/api/collab", { headers: { cookie: `iris_session=${f.app.makeToken(f.user)}` } });
    t.after(() => ws.terminate());
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bibliography join response timed out")), 4000);
      t.after(() => clearTimeout(timer));
      ws.on("error", reject);
      ws.on("open", () => ws.send(JSON.stringify({ t: "open", fileId: f.fileId })));
      ws.on("message", (raw) => {
        const message = JSON.parse(raw);
        if (message.t === "error" || message.t === "opened") { clearTimeout(timer); resolve(message); }
      });
    });
    assert.deepEqual(answer, { t: "error", code: "BIBLIOGRAPHY_INVALID_ENCODING", request: "open", fileId: f.fileId });
    const data = await (await f.request(f.url)).json();
    assert.equal(data.project.nodes[1].sourceError, "BIBLIOGRAPHY_INVALID_ENCODING");
    assert.equal(Object.hasOwn(data.project.nodes[1], "content"), false);
    assert.equal(Object.hasOwn(data.project.nodes[1], "readOnly"), false);
    data.project.nodes[0].content = "other source saved";
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: 0, data } })).status, 200);
    const stored = JSON.parse(await fs.readFile(path.join(f.dir, ".iris/project.json"), "utf8")).project.nodes[1];
    assert.equal(stored.id, f.fileId);
    assert.equal(Object.hasOwn(stored, "sourceError"), false);
    const row = (await f.pool.query("SELECT deleted_at FROM project_files WHERE id = $1", [f.fileId])).rows[0];
    assert.equal(row.deleted_at, null);
    const exported = await f.request(f.url + "/archive");
    assert.equal(exported.status, 200);
    assert.deepEqual(extractZip(Buffer.from(await exported.arrayBuffer())).files.get(`refs.${kind}`), bytes);
    assert.deepEqual(await fs.readFile(path.join(f.dir, `refs.${kind}`)), bytes);
  });

  test(`PostgreSQL bibliography ${kind}: text checkpoints and rollback reject invalid source explicitly`, pgOptions, async (t) => {
    const f = await bibliographyServer(t, kind);
    assert.equal((await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).status, 200);
    const version = (await f.pool.query("SELECT id FROM document_versions WHERE file_id = $1", [f.fileId])).rows[0];
    const bytes = Buffer.from([0xc3, 0x28, 0xff]);
    await fs.writeFile(path.join(f.dir, `refs.${kind}`), bytes);
    for (const suffix of ["/checkpoint", `/files/${f.fileId}/versions/${version.id}/restore`, "/compile"]) {
      const res = await f.request(f.url + suffix, { method: "POST", body: {} });
      assert.equal(res.status, 422);
      const error = await res.json();
      assert.equal(error.errorCode, "BIBLIOGRAPHY_INVALID_ENCODING");
      assert.equal(error.params.path, `refs.${kind}`);
      assert.deepEqual(await fs.readFile(path.join(f.dir, `refs.${kind}`)), bytes);
    }
    assert.equal(Number((await f.pool.query("SELECT count(*) FROM document_versions WHERE file_id = $1", [f.fileId])).rows[0].count), 1);
  });

  test(`PostgreSQL bibliography ${kind}: join revalidates bytes after its permission wait`, pgOptions, async (t) => {
    const f = await bibliographyServer(t, kind);
    const file = path.join(f.dir, `refs.${kind}`);
    const bytes = Buffer.from([0xff, 0xc3]);
    let reads = 0;
    f.hooks.afterReadFile = async (name) => {
      if (name === file && ++reads === 1) await fs.writeFile(file, bytes);
    };
    const session = { user: { sub: f.user.id, exp: Math.floor(Date.now() / 1000) + 60 }, rooms: new Map(), socket: { OPEN: 1, readyState: 1 } };
    await assert.rejects(f.app.collabJoin(session, f.fileId), (err) => err.code === "BIBLIOGRAPHY_INVALID_ENCODING");
    assert.equal(reads, 2);
    assert.equal(f.app.collabRooms.get(f.fileId), null);
    assert.deepEqual(await fs.readFile(file), bytes);
  });
}

for (const format of ["bib", "ris"]) for (const extension of ["txt", "md"]) {
  test(`generic ${format} ${extension} PG reads, saves, versions, rooms and export retain BOM/CRLF`, pgOptions, async (t) => {
    const f = await bibliographyServer(t, format, extension);
    const data = await (await f.request(f.url)).json();
    assert.equal(data.project.nodes[1].kind, "file");
    assert.equal(data.project.nodes[1].content, f.text);
    delete data.project.nodes[1].content;
    data.project.nodes[0].content = "unrelated edit";
    assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: data.revision, data } })).status, 200);
    assert.equal((await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).status, 200);
    const versions = (await (await f.request(`${f.url}/files/${f.fileId}/versions`)).json()).versions;
    const version = await (await f.request(`${f.url}/files/${f.fileId}/versions/${versions[0].id}`)).json();
    assert.equal(version.content, f.text);
    const session = { user: { sub: f.user.id, exp: Math.floor(Date.now() / 1000) + 60 }, rooms: new Map(), socket: { OPEN: 1, readyState: 1 } };
    assert.equal((await f.app.collabJoin(session, f.fileId)).room.text(), f.text);
    const exported = await f.request(f.url + "/archive");
    assert.deepEqual(extractZip(Buffer.from(await exported.arrayBuffer())).files.get(f.name), Buffer.from(f.text));
    assert.deepEqual(await fs.readFile(path.join(f.dir, f.name)), Buffer.from(f.text));
  });

  test(`generic ${format} ${extension} PG damaged sources survive GET, sparse save, materialization and export`, pgOptions, async (t) => {
    const f = await bibliographyServer(t, format, extension);
    for (const bytes of [Buffer.concat([Buffer.from("\uFEFF"), Buffer.from(f.text.slice(1), "latin1")]), Buffer.from(f.text.replace("\u00e9", "\0"))]) {
      await fs.writeFile(path.join(f.dir, f.name), bytes);
      const data = await (await f.request(f.url)).json();
      const node = data.project.nodes[1];
      assert.equal(node.sourceError, "BIBLIOGRAPHY_INVALID_ENCODING");
      assert.equal(node.content, undefined);
      data.project.nodes[0].content += " unrelated";
      assert.equal((await f.request(f.url, { method: "PUT", body: { baseRevision: data.revision, data } })).status, 200);
      await hydrateProjectPayloads(f.dir, data);
      assert.equal(node.content, undefined);
      const staging = await projectDir(t);
      await writeProjectFile(staging, data);
      assert.deepEqual(await fs.readFile(path.join(staging, f.name)), bytes);
      const exported = await f.request(f.url + "/archive");
      assert.deepEqual(extractZip(Buffer.from(await exported.arrayBuffer())).files.get(f.name), bytes);
      assert.deepEqual(await fs.readFile(path.join(f.dir, f.name)), bytes);
    }
  });

  test(`generic ${format} ${extension} PG damaged bytes cannot seed rooms or versions`, pgOptions, async (t) => {
    const f = await bibliographyServer(t, format, extension);
    assert.equal((await f.request(f.url + "/checkpoint", { method: "POST", body: {} })).status, 200);
    const version = (await f.pool.query("SELECT id FROM document_versions WHERE file_id = $1", [f.fileId])).rows[0];
    for (const bytes of [Buffer.concat([Buffer.from("\uFEFF"), Buffer.from(f.text.slice(1), "latin1")]), Buffer.from(f.text.replace("\u00e9", "\0"))]) {
      await fs.writeFile(path.join(f.dir, f.name), bytes);
      const session = { user: { sub: f.user.id, exp: Math.floor(Date.now() / 1000) + 60 }, rooms: new Map(), socket: { OPEN: 1, readyState: 1 } };
      for (const suffix of ["/checkpoint", `/files/${f.fileId}/versions/${version.id}/restore`]) {
        const response = await f.request(f.url + suffix, { method: "POST", body: {} });
        assert.equal(response.status, 422, `${suffix}: ${bytes.includes(0) ? "NUL" : "Latin-1"}`);
        assert.equal((await response.json()).errorCode, "BIBLIOGRAPHY_INVALID_ENCODING");
      }
      await assert.rejects(f.app.collabJoin(session, f.fileId), (err) => err.code === "BIBLIOGRAPHY_INVALID_ENCODING");
      assert.equal(f.app.collabRooms.get(f.fileId), null);
      assert.equal(Number((await f.pool.query("SELECT count(*) FROM document_versions WHERE file_id = $1", [f.fileId])).rows[0].count), 1);
      assert.deepEqual(await fs.readFile(path.join(f.dir, f.name)), bytes);
    }
  });
}

test("ordinary non-bibliography filesystem text keeps replacement decoding", options, async (t) => {
  const dir = await projectDir(t);
  const bytes = Buffer.from("Caf\u00e9", "latin1");
  await writeProjectFile(dir, projectData([textNode("ordinary.txt", "initial")]));
  await fs.writeFile(path.join(dir, "ordinary.txt"), bytes);
  assert.equal((await readProjectFile(dir)).project.nodes[0].content, "Caf\uFFFD");
});
