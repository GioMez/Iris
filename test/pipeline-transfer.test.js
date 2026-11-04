const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { once } = require("node:events");
const { finished, pipeline } = require("node:stream/promises");
const tar = require("tar-stream");
const { createTransferArchive, extractTransferArchive } = require("../src/pipeline/transfers");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-transfer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function archive(entries) {
  const pack = tar.pack();
  for (const { data, ...header } of entries) {
    if (header.type && header.type !== "file") pack.entry(header);
    else pack.entry(header, Buffer.from(data || ""));
  }
  pack.finalize(); return pack;
}
const rejected = code => ({ code });

test("a consumer attaching after packing failed receives the original error without hanging", async t => {
  const root = await fixture(t);
  const packed = createTransferArchive({ root, directories: [], files: [{ path: "../escape", size: 0, contentHash: "0".repeat(64) }] });
  await once(packed, "error");
  await assert.rejects(extractTransferArchive(packed, path.join(root, "received"), {}, { signal: AbortSignal.timeout(1000) }),
    rejected("PIPELINE_PATH_INVALID"));
  await assert.rejects(fs.stat(path.join(root, "received")), rejected("ENOENT"));
});

test("streaming transfers preserve binary and large sources, Unicode paths and empty directories", async t => {
  const root = await fixture(t), source = path.join(root, "source"), destination = path.join(root, "received");
  await fs.mkdir(path.join(source, "parts", "empty"), { recursive: true });
  const binary = Buffer.from([0, 255, 13, 10, 128]), large = Buffer.alloc(16777217, 97);
  await fs.writeFile(path.join(source, "parts", "é.bin"), binary);
  await fs.writeFile(path.join(source, "large.tex"), large);
  const manifest = { root: source, directories: ["parts", "parts/empty"], files: [
    { path: "parts/é.bin", size: 5, contentHash: createHash("sha256").update(binary).digest("hex") },
    { path: "large.tex", size: 16777217, contentHash: createHash("sha256").update(large).digest("hex") },
  ] };
  const result = await extractTransferArchive(createTransferArchive(manifest), destination);
  assert.deepEqual(await fs.readFile(path.join(destination, "parts", "é.bin")), binary);
  assert.deepEqual(await fs.readFile(path.join(destination, "large.tex")), large);
  assert.deepEqual(result.directories, ["parts", "parts/empty"]);
  assert.deepEqual(result.files, [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)));
});

test("transfer packing rejects changed source bytes rather than delivering a false manifest", async t => {
  const root = await fixture(t), source = path.join(root, "source"); await fs.mkdir(source);
  await fs.writeFile(path.join(source, "file"), "changed");
  const packed = createTransferArchive({ root: source, directories: [], files: [{ path: "file", size: 7, contentHash: "0".repeat(64) }] });
  await assert.rejects(extractTransferArchive(packed, path.join(root, "received")), rejected("PIPELINE_INPUT_CHANGED"));
  await assert.rejects(fs.stat(path.join(root, "received")), rejected("ENOENT"));
});

test("host transfer aliases stream checked files from separate roots without exporting their source paths", async t => {
  const root = await fixture(t), pdfRoot = path.join(root, "pdf"), mapRoot = path.join(root, "map");
  await fs.mkdir(pdfRoot); await fs.mkdir(mapRoot);
  await fs.writeFile(path.join(pdfRoot, "original.pdf"), "PDF");
  await fs.writeFile(path.join(mapRoot, "original.synctex"), "MAP");
  const files = [[pdfRoot, "original.pdf", "alias.pdf", "PDF"], [mapRoot, "original.synctex", "alias.synctex", "MAP"]]
    .map(([root, original, path, bytes]) => ({ path, source: { root, path: original }, size: 3,
      contentHash: createHash("sha256").update(bytes).digest("hex") }));
  const input = { directories: [], files };
  const destination = path.join(root, "received");
  const manifest = await extractTransferArchive(createTransferArchive(input), destination);
  assert.deepEqual(manifest.files.map(file => file.path), ["alias.pdf", "alias.synctex"]);
  assert.equal(await fs.readFile(path.join(destination, "alias.pdf"), "utf8"), "PDF");
  assert.equal(await fs.readFile(path.join(destination, "alias.synctex"), "utf8"), "MAP");
  await fs.writeFile(path.join(mapRoot, "original.synctex"), "BAD");
  await assert.rejects(extractTransferArchive(createTransferArchive(input), path.join(root, "changed")), rejected("PIPELINE_INPUT_CHANGED"));
  await fs.unlink(path.join(mapRoot, "original.synctex"));
  await fs.symlink(path.join(pdfRoot, "original.pdf"), path.join(mapRoot, "original.synctex"));
  await assert.rejects(extractTransferArchive(createTransferArchive(input), path.join(root, "linked")), rejected("PIPELINE_PATH_INVALID"));
});

test("transfer packing rejects source symlinks and linked inodes", async t => {
  const root = await fixture(t), source = path.join(root, "source"); await fs.mkdir(source);
  await fs.writeFile(path.join(root, "outside"), "secret");
  await fs.symlink(path.join(root, "outside"), path.join(source, "link"));
  await fs.link(path.join(root, "outside"), path.join(source, "hardlink"));
  for (const name of ["link", "hardlink"]) {
    const packed = createTransferArchive({ root: source, directories: [], files: [{ path: name, size: 6, contentHash: "0".repeat(64) }] });
    await assert.rejects(extractTransferArchive(packed, path.join(root, name)), rejected("PIPELINE_PATH_INVALID"));
  }
  assert.equal(await fs.readFile(path.join(root, "outside"), "utf8"), "secret");
});

test("incoming transfers refuse escaping paths, links, special files and conflicting entries", async t => {
  const root = await fixture(t);
  const fixtures = [
    [{ name: "../outside", data: "bad" }], [{ name: "/outside", data: "bad" }],
    [{ name: "a/../outside", data: "bad" }], [{ name: "a\\outside", data: "bad" }],
    [{ name: "link", type: "symlink", linkname: "../outside" }],
    [{ name: "link", type: "link", linkname: "../outside" }], [{ name: "pipe", type: "fifo" }],
    [{ name: "same", data: "a" }, { name: "same", data: "b" }],
    [{ name: "same", data: "a" }, { name: "./same", data: "b" }],
    [{ name: "same", data: "a" }, { name: "same/child", data: "b" }],
    [{ name: "same/child", data: "a" }, { name: "same", data: "b" }],
  ];
  for (const [index, entries] of fixtures.entries()) {
    const destination = path.join(root, `received-${index}`);
    await assert.rejects(extractTransferArchive(archive(entries), destination), rejected("PIPELINE_PATH_INVALID"));
    await assert.rejects(fs.stat(destination), rejected("ENOENT"));
  }
});

test("transfer budgets count inferred directories and cumulative bytes", async t => {
  const root = await fixture(t);
  const cases = [
    { entries: [{ name: "a", data: "12345" }], policy: { maxArtifactBytes: 4 } },
    { entries: [{ name: "a", data: "123" }, { name: "b", data: "123" }], policy: { maxOutputBytes: 5 } },
    { entries: [{ name: "a/b/c", data: "x" }], policy: { maxOutputEntries: 2 } },
  ];
  for (const [index, { entries, policy }] of cases.entries()) {
    await assert.rejects(extractTransferArchive(archive(entries), path.join(root, `over-${index}`), policy), rejected("PIPELINE_OUTPUT_LIMIT"));
  }
  const result = await extractTransferArchive(archive([
    { name: "./", type: "directory" }, { name: "a/b", data: "1234" }, { name: "a/", type: "directory" },
  ]), path.join(root, "exact"), { maxOutputEntries: 2, maxArtifactBytes: 4, maxOutputBytes: 4 });
  assert.equal(result.files[0].size, 4);
  assert.deepEqual(result.directories, ["a"]);
});

test("truncated archive bodies fail and remove the partial received tree", async t => {
  const root = await fixture(t), chunks = [];
  for await (const chunk of archive([{ name: "file", data: "1234567890" }])) chunks.push(chunk);
  const destination = path.join(root, "received");
  await assert.rejects(extractTransferArchive(Readable.from([Buffer.concat(chunks).subarray(0, 517)]), destination), rejected("PIPELINE_TRANSFER_INVALID"));
  await assert.rejects(fs.stat(destination), rejected("ENOENT"));
});

test("incoming transfers reject invalid extended sizes and sparse metadata", async t => {
  const root = await fixture(t);
  for (const [index, pax] of [{ size: "1junk" }, { size: "1.5" }, { size: "-1" }, { "GNU.sparse.map": "0,1" }].entries()) {
    const destination = path.join(root, `received-${index}`);
    await assert.rejects(extractTransferArchive(archive([{ name: "file", data: "x", pax }]), destination),
      error => ["PIPELINE_PATH_INVALID", "PIPELINE_TRANSFER_INVALID"].includes(error.code));
    await assert.rejects(fs.stat(destination), rejected("ENOENT"));
  }
});

test("transfers require end markers even when truncation ends on a complete zero-filled body", async t => {
  const root = await fixture(t), chunks = [];
  for await (const chunk of archive([{ name: "file", data: Buffer.alloc(2048) }])) chunks.push(chunk);
  const complete = Buffer.concat(chunks);
  for (const [index, removed] of [512, 1024].entries()) {
    const destination = path.join(root, `received-${index}`);
    await assert.rejects(extractTransferArchive(Readable.from([complete.subarray(0, -removed)]), destination),
      rejected("PIPELINE_TRANSFER_INVALID"));
    await assert.rejects(fs.stat(destination), rejected("ENOENT"));
  }
  assert.deepEqual((await extractTransferArchive(archive([]), path.join(root, "empty"))).files, []);
});

test("archive overhead has a byte bound even without output entries", async t => {
  const root = await fixture(t), destination = path.join(root, "received");
  const stream = Readable.from((function* () { for (let i = 0; i < 80; i++) yield Buffer.alloc(65536); })());
  await assert.rejects(extractTransferArchive(stream, destination,
    { maxArtifactBytes: 1, maxOutputBytes: 1, maxOutputEntries: 1 }), rejected("PIPELINE_OUTPUT_LIMIT"));
  assert.equal(stream.destroyed, true);
  await assert.rejects(fs.stat(destination), rejected("ENOENT"));
});

test("packing cancellation releases a backpressured archive without a reader", async t => {
  const root = await fixture(t), body = Buffer.alloc(8388608), controller = new AbortController();
  await fs.writeFile(path.join(root, "large"), body);
  const packed = createTransferArchive({ root, directories: [], files: [
    { path: "large", size: body.length, contentHash: createHash("sha256").update(body).digest("hex") },
  ] }, { signal: controller.signal });
  const completion = finished(packed); completion.catch(() => {});
  await once(packed, "readable");
  controller.abort();
  await assert.rejects(completion, { name: "AbortError" });
  assert.equal(packed.closed, true);
});

test("source growth during transfer fails input integrity and leaves no received artifact", async t => {
  const root = await fixture(t), body = Buffer.alloc(8388608), file = path.join(root, "large");
  await fs.writeFile(file, body);
  const packed = createTransferArchive({ root, directories: [], files: [
    { path: "large", size: body.length, contentHash: createHash("sha256").update(body).digest("hex") },
  ] });
  let changed = false;
  const change = new Transform({ transform(chunk, encoding, callback) {
    if (changed) return callback(null, chunk);
    changed = true;
    fs.appendFile(file, Buffer.alloc(65536)).then(() => callback(null, chunk), callback);
  } });
  const copying = pipeline(packed, change); copying.catch(() => {});
  await assert.rejects(extractTransferArchive(change, path.join(root, "received")), rejected("PIPELINE_INPUT_CHANGED"));
  await assert.rejects(copying, rejected("PIPELINE_INPUT_CHANGED"));
  await assert.rejects(fs.stat(path.join(root, "received")), rejected("ENOENT"));
});

test("transfer cancellation drains input and removes incomplete output without touching an existing destination", async t => {
  const root = await fixture(t), destination = path.join(root, "received"), controller = new AbortController();
  const packed = archive([{ name: "large", data: Buffer.alloc(1048576) }]);
  const stream = Readable.from((async function* () {
    for await (const chunk of packed) { yield chunk; controller.abort(); }
  })());
  await assert.rejects(extractTransferArchive(stream, destination, {}, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(stream.destroyed, true);
  await assert.rejects(fs.stat(destination), rejected("ENOENT"));
  await fs.mkdir(destination); await fs.writeFile(path.join(destination, "keep"), "owned");
  await assert.rejects(extractTransferArchive(archive([{ name: "keep", data: "bad" }]), destination), rejected("EEXIST"));
  assert.equal(await fs.readFile(path.join(destination, "keep"), "utf8"), "owned");
});
