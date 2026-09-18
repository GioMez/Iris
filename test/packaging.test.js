const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { pathToFileURL } = require("node:url");

const release = path.resolve(__dirname, "../scripts/release.cjs");
const required = ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", ".npmrc", ".env.example",
  ".dockerignore", "Dockerfile", "docker-compose.yml", "db/schema.sql", "db/init/01-create-iris-user.sh",
  "src/server.js", "public/Iris.html", "public/templates/.metadata.json", "scripts/test.cjs", "scripts/smoke.cjs"];
async function fixture(t) {
  const root = await fs.mkdtemp(path.resolve(__dirname, "../.iris-package-test-"));
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
  // Windows extraction does not preserve POSIX mode bits. Assert the portable
  // release contract against the actual ustar header, on every platform.
  const bytes = gunzipSync(first);
  let scriptMode;
  for (let offset = 0; offset < bytes.length && bytes[offset];) {
    const header = bytes.subarray(offset, offset + 512);
    const field = (from, to) => header.subarray(from, to).toString().replace(/\0.*$/, "");
    if (field(0, 100).endsWith("db/init/01-create-iris-user.sh")) scriptMode = parseInt(field(100, 108), 8);
    offset += 512 + Math.ceil(parseInt(field(124, 136), 8) / 512) * 512;
  }
  assert.equal(scriptMode, 0o755);
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
  await fs.symlink(path.join(f.source, process.platform === "win32" ? "db" : "README.md"), path.join(f.source, "src/link.js"), process.platform === "win32" ? "junction" : "file");
  await fs.writeFile(f.manifest, JSON.stringify([...Object.keys(f.files), "src/link.js"]));
  assert.match(f.run().stderr, /symbolic link/i);
  await fs.symlink(path.join(f.source, "src"), path.join(f.source, "alias"), process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(f.manifest, JSON.stringify([...Object.keys(f.files), "alias/server.js"]));
  assert.equal(f.run().status, 1);
});

test("language archive retains generator inputs/runtime and regenerates without Git", async t => {
  const f = await fixture(t);
  const repo = path.resolve(__dirname, "..");
  const languageFiles = ["scripts/build-languages.cjs", "public/iris-language-service.mjs", "public/iris-language-state.mjs", "public/iris-syntax-style.mjs",
    "public/iris-language-policy.mjs", "public/iris-language-tasks.mjs", "public/iris-tex-highlighting.mjs", "public/iris-lilypond-highlighting.mjs",
    "public/iris-language-editing.mjs", "public/iris-language-completion.mjs",
    ...["latex.grammar", "tokens.mjs", "names.mjs", "catalog.mjs", "queries.mjs", "editing.mjs", "reuse.mjs", "index.mjs", "parser.mjs", "parser.terms.mjs"].map(name => `public/languages/latex/${name}`),
    ...["lilypond.grammar", "tokens.mjs", "scheme-tokens.mjs", "pitches.mjs", "catalog.mjs", "queries.mjs", "editing.mjs", "symbols.mjs", "reuse.mjs", "index.mjs", "parser.mjs", "parser.terms.mjs"].map(name => `public/languages/lilypond/${name}`),
    "test/fixtures/languages/lilypond-boundaries.grammar"];
  for (const name of [...languageFiles, "package.json", "package-lock.json"]) {
    await fs.mkdir(path.dirname(path.join(f.source, name)), { recursive: true });
    f.files[name] = await fs.readFile(path.join(repo, name));
    await fs.writeFile(path.join(f.source, name), f.files[name]);
  }
  await fs.writeFile(f.manifest, JSON.stringify(Object.keys(f.files)));
  const built = f.run();
  assert.equal(built.status, 0, built.stderr);
  const version = JSON.parse(f.files["package.json"]).version;
  const bytes = await fs.readFile(path.join(f.output, `iris-${version}.tar.gz`));
  const second = f.run("--output", path.join(f.root, "second"));
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(await fs.readFile(path.join(f.root, `second/iris-${version}.tar.gz`)), bytes);
  const extracted = path.join(f.root, "extracted");
  await fs.mkdir(extracted);
  const tar = spawnSync("tar", ["-xzf", path.join(f.output, `iris-${version}.tar.gz`), "-C", extracted], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const packaged = path.join(extracted, `iris-${version}`);
  await assert.rejects(fs.stat(path.join(packaged, ".git")), { code: "ENOENT" });
  for (const name of languageFiles) assert.deepEqual(await fs.readFile(path.join(packaged, name)), f.files[name]);
  // Dependency resolution uses the installed locked ancestor node_modules;
  // the candidate and extracted tree have no Git metadata or build fallback.
  const run = (...args) => spawnSync(process.execPath, ["scripts/build-languages.cjs", ...args], { cwd: packaged, encoding: "utf8" });
  assert.equal(run("--check").status, 0);
  for (const language of ["latex", "lilypond"]) for (const name of ["parser.mjs", "parser.terms.mjs"]) await fs.rm(path.join(packaged, `public/languages/${language}`, name));
  const rebuilt = run();
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.equal(run("--check").status, 0);
  for (const name of languageFiles) assert.deepEqual(await fs.readFile(path.join(packaged, name)), f.files[name]);
  const { loadLanguage } = await import(pathToFileURL(path.join(packaged, "public/iris-language-service.mjs")));
  const adapter = await loadLanguage("tex");
  assert.equal(adapter.language.parser.parse("{x}").toString(), "Document(Group(OpenBrace,Text,CloseBrace))");
  const ly = await loadLanguage("ly");
  assert.equal(ly.language.parser.parse("{c4}").toString(), "Document(Group(OpenBrace,Pitch,Duration,CloseBrace))");
  const { analyze } = await import(pathToFileURL(path.join(packaged, "public/iris-language-service.mjs")));
  assert.deepEqual((await analyze("ly", '\\score { c4 }')).data.outline.map(x => x.title), ["Score 1"]);
  assert.deepEqual((await analyze('ly', '#(list #; #{ \\score { c4 } #} #{ \\score { d4 } #})')).data.outline.map(x => x.title), ['Score 1']);
  const { createLilyPondHighlighting } = await import(pathToFileURL(path.join(packaged, 'public/iris-lilypond-highlighting.mjs')));
  const { EditorState } = await import('@codemirror/state'), { ensureSyntaxTree } = await import('@codemirror/language');
  const state = EditorState.create({ doc: '#{ c4 #}', extensions: [(await createLilyPondHighlighting())()] });
  assert.equal(ensureSyntaxTree(state, state.doc.length, 1000).toString(), 'Document(MusicLiteral(MusicLiteralOpen,Space,Pitch,Duration,Space,MusicLiteralClose))');
});

test("grammar packaging is restricted to intended language source and fixture trees", () => {
  const { included } = require(release);
  assert.equal(included("public/languages/latex/latex.grammar"), true);
  assert.equal(included("public/languages/lilypond/lilypond.grammar"), true);
  assert.equal(included("test/fixtures/languages/lilypond-boundaries.grammar"), true);
  for (const name of ["public/unrelated.grammar", "src/private.grammar", "test/unrelated.grammar", "public/languages/.private/x.grammar", "public/languages/tmp/x.grammar", "docs/superpowers/x.grammar"]) assert.equal(included(name), false, name);
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
