const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const mapping = require("../src/source-mapping");
const { runNativeQuery, parseSyncTeX, readSyncTeXInputs } = require("../src/source-mapping-synctex");
const { parseLilyMap, queryLilyMap } = require("../src/source-mapping-lilypond");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const projectId = randomUUID(), buildId = randomUUID(), sourceFileId = randomUUID(), revision = randomUUID(), artifactId = randomUUID();
const source = { sourceFileId, sourceRevisionId: revision, sourceHash: hash("é😀 c\n"), path: "parts/é air.ly", text: "é😀 c\n" };
const artifact = { id: artifactId, fileName: "main.pdf", contentHash: hash("pdf"), size: 3 };

test("setting defaults only absent values and preserves explicit false", () => {
  assert.equal(mapping.normalizeSourceMapping(undefined), true);
  assert.equal(mapping.normalizeSourceMapping(false), false);
  for (const value of [null, 0, 1, "false", [], {}]) assert.throws(() => mapping.normalizeSourceMapping(value), { status: 400 });
});

test("navigation validates UUIDs, finite coordinates, positive rows/pages and UTF-16 columns", () => {
  assert.doesNotThrow(() => mapping.validateNavigationQuery({ direction: "forward", sourceFileId, line: 1, column: 0 }));
  assert.doesNotThrow(() => mapping.validateNavigationQuery({ direction: "inverse", artifactId, page: 1, x: 0, y: 12.5 }));
  for (const patch of [{ line: 0 }, { line: 1.5 }, { column: null }, { column: -1 }, { sourceFileId: "../a" }, { artifactId: "bad" }, { page: 0 }, { path: "main.ly" }]) {
    assert.throws(() => mapping.validateNavigationQuery({ direction: "forward", sourceFileId, line: 1, column: 0, ...patch }), { status: 400 });
  }
  for (const patch of [{ x: NaN }, { y: Infinity }, { page: -1 }, { x: -1 }, { artifactId: undefined }]) {
    assert.throws(() => mapping.validateNavigationQuery({ direction: "inverse", artifactId, page: 1, x: 1, y: 2, ...patch }), { status: 400 });
  }
});

test("snapshot identity normalizes newlines and retains lossless column conversion after source deletion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-unit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "one.ly"), "é😀 c\r\nnext\rlast");
  await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 255]));
  await fs.writeFile(path.join(root, "font.ttf"), "font bytes");
  const files = [{ id: sourceFileId, path: "one.ly", kind: "ly" }, { id: randomUUID(), path: "binary", binary: true }, { id: randomUUID(), path: "font.ttf", kind: "font" }];
  const sources = await mapping.captureMappingSources(root, files, new Map([[sourceFileId, revision]]));
  await fs.unlink(path.join(root, "one.ly"));
  assert.equal(sources.length, 1);
  assert.equal(sources[0].sourceHash, hash("é😀 c\nnext\nlast"));
  assert.equal(sources[0].sourceRevisionId, revision);
  const convert = mapping.columnConverter();
  assert.equal(convert(sources[0], 1, 3), 4);
  assert.equal(convert(sources[0], 2, 4), 4);
  assert.equal(convert(sources[0], 1, -1), null);
  assert.equal(convert(sources[0], 1, 10), null);
});

test("native paths resolve only exact recorded snapshot paths with Darwin and dot aliases", () => {
  const root = "/var/tmp/build";
  const resolve = mapping.sourceResolver([source], root);
  for (const input of ["parts/é air.ly", "./parts/./é air.ly", "/private/var/tmp/build/parts/é air.ly"]) {
    assert.equal(resolve(input), source);
  }
  for (const input of ["../parts/é air.ly", "/etc/passwd", "/tmp/else/parts/é air.ly", "parts/../é air.ly", "parts/é air.ly\0"]) assert.equal(resolve(input), null);
});

test("Lily map retains physical pages and artifact identity, supports repeats and bounded near-point inverse", () => {
  const raw = "IRIS-LILYPOND\t1\nP\t1\t595.276\t841.89\nP\t2\t595.276\t841.89\n" +
    [1, 2].map((page) => `G\t${page}\tparts%2F%C3%A9%20air.ly\t1\t3\t5\t100\t200\t10\t8\n`).join("");
  const entries = parseLilyMap(raw, { sources: [source], snapshotRoot: "/tmp/build", artifact });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].column, 4);
  assert.equal(entries[0].sourceHash, source.sourceHash);
  const matches = queryLilyMap(entries, { direction: "forward", sourceFileId, line: 1, column: 4, page: 2, artifactId });
  assert.deepEqual(matches.map((m) => m.page), [2, 1]);
  assert.equal(queryLilyMap(entries, { direction: "inverse", artifactId, page: 1, x: 105, y: 205 }).length, 1);
  assert.equal(queryLilyMap(entries, { direction: "inverse", artifactId, page: 1, x: 400, y: 600 }).length, 0);
  assert.equal(queryLilyMap(Array(100).fill(entries[0]), { direction: "forward", sourceFileId, line: 1, column: 4 }).length <= 32, true);
  for (const bad of ["garbage", raw.replace("100\t200", "NaN\t200"), raw.replace("P\t1", "P\t0"), raw + "E\tbudget\n"]) assert.throws(() => parseLilyMap(bad, { sources: [source], snapshotRoot: "/tmp/build", artifact }));
});

test("SyncTeX parsing rejects external input and malformed geometry and preserves row precision", () => {
  const input = "SyncTeX Version:1\nInput:1:/etc/article.cls\nInput:2:./parts/é air.ly\nContent:\n";
  const inputs = readSyncTeXInputs(Buffer.from(input), { sources: [source], snapshotRoot: "/tmp/build" });
  assert.deepEqual(inputs, [{ tag: 2, input: "./parts/é air.ly", sourceFileId }]);
  const out = "SyncTeX result begin\nOutput:main.pdf\nPage:2\nx:105\ny:208\nh:100\nv:208\nW:10\nH:8\nSyncTeX result end\n";
  const ctx = { sources: [source], snapshotRoot: "/tmp/build", artifact, source, query: { direction: "forward", line: 1 } };
  assert.deepEqual(parseSyncTeX(out, ctx)[0], { artifactId, page: 2, x: 100, y: 200, width: 10, height: 8, sourceFileId, sourceRevisionId: revision, sourceHash: source.sourceHash, line: 1, column: null });
  assert.deepEqual(parseSyncTeX(out.replace("W:10", "W:NaN"), ctx), []);
  assert.deepEqual(parseSyncTeX("SyncTeX result begin\nInput:/etc/passwd\nLine:1\nColumn:-1\nSyncTeX result end", { ...ctx, query: { direction: "inverse", page: 2, x: 100, y: 200 } }), []);
});

test("native queries clear launch variables, use no shell, and bound output", async () => {
  const old = process.env.SYNCTEX_EDITOR;
  process.env.SYNCTEX_EDITOR = "must not launch";
  try {
    const result = await runNativeQuery(process.execPath, ["-e", "console.log(JSON.stringify([process.env.SYNCTEX_EDITOR,process.env.SYNCTEX_VIEWER,process.argv[1]]))", "literal;touch nope"], {});
    assert.deepEqual(JSON.parse(result.stdout), ["", "", "literal;touch nope"]);
    await assert.rejects(runNativeQuery(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"], {}), { reason: "output-limit" });
    await assert.rejects(runNativeQuery("/no/such/synctex", [], {}), { reason: "engine-missing" });
  } finally { if (old === undefined) delete process.env.SYNCTEX_EDITOR; else process.env.SYNCTEX_EDITOR = old; }
});

test("native busy rejection has no queue; cancelled and timed-out children exit before slots release", async () => {
  const a = new AbortController(), b = new AbortController();
  const args = ["-e", "setInterval(()=>{},1000)"];
  const first = assert.rejects(runNativeQuery(process.execPath, args, { signal: a.signal }), { reason: "cancelled" });
  const second = assert.rejects(runNativeQuery(process.execPath, args, { signal: b.signal }), { reason: "cancelled" });
  await assert.rejects(runNativeQuery(process.execPath, ["-e", ""], {}), { reason: "busy" });
  a.abort(); b.abort();
  await Promise.all([first, second]);
  await assert.rejects(runNativeQuery(process.execPath, args, { timeoutMs: 30 }), { reason: "timeout" });
  const next = await runNativeQuery(process.execPath, ["-e", "console.log('released')"], {});
  assert.equal(next.stdout.trim(), "released");
});

test("manifest storage rejects wrong identities, symlinks, oversize and stale PDFs; disabled skips reads", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "output", buildId);
  await fs.mkdir(directory, { recursive: true });
  const ctx = { projectStorageDir: root, projectId, buildId, storagePath: `output/${buildId}`, artifacts: [artifact] };
  assert.deepEqual(await mapping.navigateBuild({ ...ctx, enabled: false }), { status: "disabled", matches: [] });
  assert.equal((await mapping.navigateBuild({ ...ctx, enabled: true })).status, "missing");
  const manifest = { version: 1, projectId, buildId, backend: "lilypond", status: "ready", snapshotRoot: "/tmp/build", sources: [source], artifacts: [artifact], entries: [] };
  const file = path.join(directory, mapping.MANIFEST_NAME);
  await fs.writeFile(file, JSON.stringify({ ...manifest, buildId: randomUUID() }));
  assert.equal((await mapping.navigateBuild({ ...ctx, enabled: true })).status, "unavailable");
  await fs.unlink(file);
  await fs.writeFile(path.join(root, "outside"), JSON.stringify(manifest));
  await fs.symlink(path.join(root, "outside"), file);
  assert.equal((await mapping.navigateBuild({ ...ctx, enabled: true })).status, "missing");
  await fs.unlink(file);
  await fs.writeFile(file, " ".repeat(16 * 1024 * 1024 + 1));
  assert.equal((await mapping.navigateBuild({ ...ctx, enabled: true })).reason, "map-limit");
  await fs.writeFile(file, JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, "main.pdf"), "bad");
  assert.equal((await mapping.navigateBuild({ ...ctx, enabled: true, query: { direction: "forward", sourceFileId, line: 1, column: 0 } })).reason, "stale-artifact");
});

test("Lily forward hints preserve output artifact order rather than random UUID order", () => {
  const first = "ffffffff-ffff-ffff-ffff-ffffffffffff", second = "00000000-0000-0000-0000-000000000000";
  const entry = { artifactId: first, page: 1, x: 10, y: 20, width: 3, height: 4, ...source, line: 1, column: 0 };
  const entries = [entry, { ...entry, artifactId: second }];
  assert.deepEqual(queryLilyMap(entries, { direction: "forward", sourceFileId, line: 1, column: 0 }).map((m) => m.artifactId), [first, second]);
  assert.equal(queryLilyMap(entries, { direction: "forward", sourceFileId, line: 1, column: 0, artifactId: second })[0].artifactId, second);
});

test("Lily native columns reject out-of-source rows and offsets rather than fabricating row-only matches", () => {
  for (const [line, column] of [[500, 0], [1, 100000], [1, -1], [1, 0.5]]) {
    const raw = `IRIS-LILYPOND\t1\nP\t1\t595\t842\nG\t1\tparts%2F%C3%A9%20air.ly\t${line}\t${column}\t0\t10\t20\t3\t4\n`;
    assert.throws(() => parseLilyMap(raw, { sources: [source], snapshotRoot: "/tmp/build", artifact }), { reason: "malformed-map" });
  }
});

test("manifest entry budget counts native SyncTeX records across artifacts and compressed expansion", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-budget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zlib = require("node:zlib");
  const artifacts = [artifact, { ...artifact, id: randomUUID(), fileName: "second.pdf" }];
  const raw = "SyncTeX Version:1\nInput:1:parts/é air.ly\nContent:\n" + "x\n".repeat(110000);
  for (const a of artifacts) await fs.writeFile(path.join(root, a.fileName.replace(".pdf", ".synctex.gz")), zlib.gzipSync(raw));
  const result = await mapping.publishSourceMapping({ outputDir: root, snapshotRoot: "/tmp/build", sources: [source], projectId, buildId, artifacts, backend: "latex", enabled: true, format: "pdf" });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "map-limit");
  assert.throws(() => readSyncTeXInputs(zlib.gzipSync("x".repeat(16 * 1024 * 1024 + 1)), { sources: [source], snapshotRoot: "/tmp/build" }), { reason: "map-limit" });
});

test("empty collected Lily pages are a supported no-match map and off performs no sidecar work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "main.iris-map.tsv"), "IRIS-LILYPOND\t1\nP\t1\t595\t842\n");
  const ctx = { outputDir: root, snapshotRoot: "/tmp/build", sources: [source], projectId, buildId, artifacts: [artifact], backend: "lilypond", format: "pdf" };
  assert.deepEqual(await mapping.publishSourceMapping({ ...ctx, enabled: false }), { status: "disabled", matches: [] });
  assert.deepEqual(await fs.readdir(root), ["main.iris-map.tsv"]);
  assert.equal((await mapping.publishSourceMapping({ ...ctx, enabled: true })).status, "ready");
});

test("native runner awaits actual close even after cancellation and never releases a killed process slot early", async () => {
  const { spawn } = require("node:child_process");
  const controller = new AbortController();
  let closed = false, pid;
  const promise = runNativeQuery(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal, spawnChild(command, args, options) {
    const child = spawn(command, args, options); pid = child.pid;
    child.once("close", () => { closed = true; });
    return child;
  } });
  controller.abort();
  await assert.rejects(promise, { reason: "cancelled" });
  assert.equal(closed, true);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("publication replaces a compiler-authored manifest instead of trusting its identities", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-poison-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, mapping.MANIFEST_NAME), JSON.stringify({ version: 1, projectId: "compiler-controlled" }));
  await fs.writeFile(path.join(root, "main.iris-map.tsv"), "IRIS-LILYPOND\t1\nP\t1\t595\t842\n");
  const result = await mapping.publishSourceMapping({ outputDir: root, snapshotRoot: "/tmp/build", sources: [source], projectId, buildId, artifacts: [artifact], backend: "lilypond", enabled: true, format: "pdf" });
  assert.equal(result.status, "ready");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, mapping.MANIFEST_NAME))).projectId, projectId);
});

test("a PDF changed during an asynchronous SyncTeX query cannot yield ready matches", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-stale-query-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "output", buildId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "main.pdf"), "pdf");
  await fs.writeFile(path.join(directory, "main.synctex"), "SyncTeX Version:1\nInput:1:parts/é air.ly\nContent:\n");
  await mapping.publishSourceMapping({ outputDir: directory, snapshotRoot: "/tmp/build", sources: [source], projectId, buildId, artifacts: [artifact], backend: "latex", enabled: true, format: "pdf" });
  const result = await mapping.navigateBuild({ projectStorageDir: root, projectId, buildId, storagePath: `output/${buildId}`, artifacts: [artifact], enabled: true,
    query: { direction: "forward", sourceFileId, line: 1, column: 0 }, spawnChild(_command, _args, options) {
      return require("node:child_process").spawn(process.execPath, ["-e", `require('node:fs').writeFileSync('main.pdf','BAD'); console.log('SyncTeX result begin\\nOutput:main.pdf\\nPage:1\\nh:10\\nv:24\\nW:3\\nH:4\\nSyncTeX result end');`], options);
    } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "stale-artifact");
});

test("unknown map/native format versions report unsupported and invalid native source rows yield no match", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "output", buildId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, mapping.MANIFEST_NAME), JSON.stringify({ version: 2, projectId, buildId, status: "ready" }));
  const result = await mapping.navigateBuild({ projectStorageDir: root, projectId, buildId, storagePath: `output/${buildId}`, enabled: true, artifacts: [artifact] });
  assert.equal(result.status, "unsupported");
  assert.throws(() => readSyncTeXInputs(Buffer.from("SyncTeX Version:2\nContent:\n"), { sources: [source], snapshotRoot: "/tmp/build" }), { reason: "unsupported" });
  const raw = "SyncTeX result begin\nInput:parts/é air.ly\nLine:900\nColumn:-1\nSyncTeX result end";
  assert.deepEqual(parseSyncTeX(raw, { sources: [source], snapshotRoot: "/tmp/build", artifact, query: { direction: "inverse", page: 1, x: 10, y: 20 } }), []);
});

function syncRecords(pages, output = "main.pdf") {
  return "SyncTeX result begin\n" + pages.map((page) => `Output:${output}\nPage:${page}\nh:10\nv:24\nW:3\nH:4\n`).join("") + "SyncTeX result end\n";
}

test("review M1: SyncTeX retains the preferred page beyond result 32 before applying its cap", () => {
  const raw = syncRecords(Array.from({ length: 40 }, (_, i) => i + 1));
  for (const hint of [{ page: 40 }, { artifactId, page: 40 }]) {
    const matches = parseSyncTeX(raw, { sources: [source], snapshotRoot: "/tmp/build", artifact, source,
      query: { direction: "forward", sourceFileId, line: 1, column: 0, ...hint } });
    assert.deepEqual(matches.map((m) => m.page), [40, ...Array.from({ length: 31 }, (_, i) => i + 1)]);
  }
});

test("review M1: a page-only hint reaches a later artifact after the first PDF fills the cap", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-map-hint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "output", buildId);
  await fs.mkdir(directory, { recursive: true });
  const artifacts = [artifact, { ...artifact, id: randomUUID(), fileName: "second.pdf" }];
  for (const a of artifacts) {
    await fs.writeFile(path.join(directory, a.fileName), "pdf");
    await fs.writeFile(path.join(directory, a.fileName.replace(".pdf", ".synctex")), "SyncTeX Version:1\nInput:1:parts/é air.ly\nContent:\n");
  }
  await mapping.publishSourceMapping({ outputDir: directory, snapshotRoot: "/tmp/build", sources: [source], projectId, buildId, artifacts, backend: "latex", enabled: true, format: "pdf" });
  const result = await mapping.navigateBuild({ projectStorageDir: root, projectId, buildId, storagePath: `output/${buildId}`, artifacts, enabled: true,
    query: { direction: "forward", sourceFileId, line: 1, column: 0, page: 90 }, spawnChild(_command, args, options) {
      const second = args.at(-1).endsWith("second.pdf");
      const raw = syncRecords(second ? [90] : Array.from({ length: 40 }, (_, i) => i + 1));
      return require("node:child_process").spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(raw)})`], options);
    } });
  assert.equal(result.status, "ready");
  assert.equal(result.matches.length, 32);
  assert.equal(result.matches[0].page, 90);
  assert.equal(result.matches[0].artifactId, artifacts[1].id);
});

test("review I2: an already-aborted map call does not begin sidecar resolution", async () => {
  let reads = 0;
  const result = await mapping.navigateBuild({ enabled: true, signal: AbortSignal.abort(),
    get projectStorageDir() { reads++; throw new Error("unexpected map resolution"); } });
  assert.deepEqual(result, { status: "unavailable", matches: [], reason: "cancelled" });
  assert.equal(reads, 0);
});
