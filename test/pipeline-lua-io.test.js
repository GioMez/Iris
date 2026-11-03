const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, files = { "source/main.tex": Buffer.from("source\0bytes") }) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "iris-lua-io-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputRoot = path.join(root, "input"), outputRoot = path.join(root, "output"), members = [];
  await fs.mkdir(inputRoot); await fs.mkdir(outputRoot);
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(inputRoot, "inputs", "source", name)), { recursive: true });
    await fs.writeFile(path.join(inputRoot, "inputs", "source", name), bytes);
    members.push({ path: name, size: bytes.length, contentHash: hash(bytes) });
  }
  const { createLuaIO } = require("../src/pipeline/lua-io");
  const inputs = { source: { kind: "collection", mediaType: "application/vnd.iris.source-tree", files: members } };
  return { root, inputRoot, outputRoot, inputs, create: (extra = {}) => createLuaIO({ inputRoot, outputRoot, inputs,
    outputs: { include: { kind: "file", path: "generated/include.tex", mediaType: "text/plain" },
      assets: { kind: "collection", path: "assets", mediaType: "application/octet-stream" } }, ...extra }) };
}

test("Lua I/O reads exact declared bytes and lists logical members without host paths", async t => {
  const f = await fixture(t), io = f.create();
  assert.deepEqual(io.read("source", "source/main.tex"), Buffer.from("source\0bytes"));
  assert.deepEqual(io.list("source"), [{ path: "source/main.tex", size: 12, contentHash: hash(Buffer.from("source\0bytes")) }]);
  const listed = io.list("source"); listed[0].path = "other";
  assert.equal(io.list("source")[0].path, "source/main.tex");
  for (const [input, file] of [["unknown", "source/main.tex"], ["source", "iris.lua"], ["source", "../outside"], ["source", "/etc/passwd"]]) {
    assert.throws(() => io.read(input, file), { code: "PIPELINE_INPUT_INVALID" });
  }
});

test("Lua I/O refuses changed input bytes, links and nonregular members", async t => {
  const f = await fixture(t), file = path.join(f.inputRoot, "inputs/source/source/main.tex"), io = f.create();
  await fs.writeFile(file, Buffer.from("tamper\0bytes"));
  assert.throws(() => io.read("source", "source/main.tex"), { code: "PIPELINE_INPUT_CHANGED" });
  await fs.rm(file); await fs.symlink(path.join(f.root, "outside"), file);
  await fs.writeFile(path.join(f.root, "outside"), Buffer.from("source\0bytes"));
  assert.throws(() => io.read("source", "source/main.tex"), { code: "PIPELINE_PATH_INVALID" });
  await fs.rm(file); await fs.link(path.join(f.root, "outside"), file);
  assert.throws(() => io.read("source", "source/main.tex"), { code: "PIPELINE_PATH_INVALID" });
  await fs.rm(file); await fs.mkdir(file);
  assert.throws(() => io.read("source", "source/main.tex"), { code: "PIPELINE_PATH_INVALID" });
});

test("Lua I/O writes declared files and collections while rejecting port and path escapes", async t => {
  const f = await fixture(t), io = f.create(), bytes = Buffer.from([0, 255, 128, 10]);
  io.write("include", "generated/include.tex", bytes);
  io.write("assets", "assets/sub/bytes.bin", bytes);
  assert.deepEqual(await fs.readFile(path.join(f.outputRoot, "assets/sub/bytes.bin")), bytes);
  for (const [port, file] of [["unknown", "owned"], ["include", "other.tex"], ["assets", "outside.bin"],
    ["assets", "assets/../outside"], ["assets", "assets"]]) {
    assert.throws(() => io.write(port, file, bytes), { code: "PIPELINE_OUTPUT_UNDECLARED" });
  }
  assert.deepEqual(await fs.readFile(path.join(f.inputRoot, "inputs/source/source/main.tex")), Buffer.from("source\0bytes"));
});

test("Lua output limits count retained bytes and directories across replacement writes", async t => {
  const f = await fixture(t), io = f.create({ limits: { maxArtifactBytes: 16, maxOutputBytes: 20, maxOutputEntries: 4 } });
  io.write("assets", "assets/one", Buffer.alloc(16, 1));
  io.write("assets", "assets/one", Buffer.alloc(8, 2));
  io.write("assets", "assets/two", Buffer.alloc(12, 3));
  assert.equal((await fs.readFile(path.join(f.outputRoot, "assets/one"))).length, 8);
  assert.throws(() => io.write("assets", "assets/three", Buffer.alloc(1)), { code: "PIPELINE_OUTPUT_LIMIT" });
  assert.throws(() => io.write("assets", "assets/two", Buffer.alloc(17)), { code: "PIPELINE_OUTPUT_LIMIT" });
  assert.throws(() => io.write("assets", "assets/sub/three", Buffer.alloc(0)), { code: "PIPELINE_OUTPUT_LIMIT" });
  assert.deepEqual(await fs.readFile(path.join(f.outputRoot, "assets/two")), Buffer.alloc(12, 3));
});

test("Lua output writes reject linked ancestors and hardlinks before altering outside bytes", async t => {
  const f = await fixture(t), io = f.create(), outside = path.join(f.root, "outside");
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep"), "original");
  await fs.symlink(outside, path.join(f.outputRoot, "assets/link"));
  assert.throws(() => io.write("assets", "assets/link/keep", Buffer.from("changed")), { code: "PIPELINE_PATH_INVALID" });
  await fs.link(path.join(outside, "keep"), path.join(f.outputRoot, "assets/hard"));
  assert.throws(() => io.write("assets", "assets/hard", Buffer.from("changed")), { code: "PIPELINE_PATH_INVALID" });
  assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "original");
});

test("Lua collection listings retain the supported 20000-member capacity", async t => {
  const f = await fixture(t), files = Array.from({ length: 20000 }, (_, i) => ({ path: `files/${i}.tex`, size: 0, contentHash: hash("") }));
  const io = f.create({ inputs: { many: { kind: "collection", mediaType: "text/plain", files } } });
  assert.equal(io.list("many").length, 20000);
  assert.deepEqual(io.list("many")[19999], { path: "files/19999.tex", size: 0, contentHash: hash("") });
});

test("Lua logging stays bounded and diagnostic locations must name declared inputs", async t => {
  const f = await fixture(t), events = [], io = f.create({ emit: event => events.push(event),
    eventLimits: { maxLogBytes: 100, maxDiagnosticBytes: 512, maxEvents: 2 } });
  io.log("info", "first"); io.log("info", "second"); io.log("info", "third");
  assert.equal(events.length, 2);
  assert.equal(io.result().logsTruncated, true);
  io.diagnostic({ severity: "warning", code: "sample", message: "check source", input: "source", file: "source/main.tex", line: 2, column: 0 });
  assert.deepEqual(io.result().diagnostics, [{ severity: "warning", code: "sample", message: "check source", input: "source", file: "source/main.tex", line: 2, column: 0 }]);
  assert.deepEqual(events[2], { diagnostic: { severity: "warning", code: "sample", message: "check source", input: "source", file: "source/main.tex", line: 2, column: 0 } });
  assert.throws(() => io.diagnostic({ severity: "error", message: "bad", input: "source", file: "outside" }), { code: "PIPELINE_DIAGNOSTICS_INVALID" });
  assert.throws(() => io.diagnostic({ severity: "error", message: "bad", sourceFileId: "forged" }), { code: "PIPELINE_DIAGNOSTICS_INVALID" });
  assert.throws(() => io.diagnostic({ severity: "error", message: "x".repeat(513) }), { code: "PIPELINE_DIAGNOSTICS_LIMIT" });
  assert.throws(() => io.log("unknown", "message"), { code: "PIPELINE_LOG_INVALID" });
});

test("Lua diagnostic byte limits include their array envelope", async t => {
  const f = await fixture(t), io = f.create({ eventLimits: { maxDiagnosticBytes: 37 } });
  // The record is 36 UTF-8 bytes; its one-element JSON array needs 38.
  assert.throws(() => io.diagnostic({ severity: "warning", message: "x" }), { code: "PIPELINE_DIAGNOSTICS_LIMIT" });
  assert.deepEqual(io.result().diagnostics, []);
});
