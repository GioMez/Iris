const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.IRIS_SECRET = "test-only-secret-with-sufficient-entropy";
process.env.DB_PASSWORD = "test-only-database-password";

const { writeProjectFile, readProjectFile, hydrateProjectPayloads } = require("../src/server");

const BIB = "@article{knuth1984,\n  author = {Donald E. Knuth},\n  title = {Literate Programming},\n}\n";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

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
  const { isTextUploadName, decodeTextUpload } = new Function(
    `${helpers}; return { isTextUploadName, decodeTextUpload };`
  )();

  assert.equal(isTextUploadName("refs.bib"), true);
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

  // And the node it builds carries that text instead of the upload payload.
  const upload = app.slice(app.indexOf("function doUpload"), app.indexOf("/* ---------------- fonts"));
  assert.match(upload, /const text = af\.isImg \|\| !isTextUploadName\(name\) \? null : decodeTextUpload\(af\.data\)/);
  assert.match(upload, /folder\.push\(\{ type: "file", id, name, kind, path, encoding: "utf8", content: text \}\)/);
  assert.match(upload, /markFileDirty\(id\)/);
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
