const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { uuidv7 } = require("../src/ids");
const { hash, MAX_MAP_BYTES } = require("../src/source-mapping-common");
const { gzipSync } = require("node:zlib");
const { createRunWorkspace, materializeInputs, validateOutputs } = require("../src/pipeline/workspaces");
const { collectCompilerMapping, navigateCompilerMapping, createNavigationTools, assembleRunMapping, createRunMappingCollector } = require("../src/pipeline/navigation");
const { createTransferArchive, extractTransferArchive } = require("../src/pipeline/transfers");

async function fixture(t, family = "latex") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-map-")), source = path.join(root, "source");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "main.tex"), "source\r\n");
  const sourceId = uuidv7(), revision = uuidv7();
  const workspace = await createRunWorkspace({ root: source, settings: {}, directories: [],
    files: [{ id: sourceId, path: "main.tex", sourceRevisionId: revision }] }, { root: path.join(root, "runs") });
  const generate = { id: "generate", outputs: { files: { kind: "collection", mediaType: "text/plain", path: "generated" } } };
  const generated = await materializeInputs(workspace, generate, new Map());
  await fs.mkdir(path.join(generated.outputDir, "generated"));
  await fs.writeFile(path.join(generated.outputDir, "generated/include.tex"), "generated");
  const [input] = await validateOutputs(workspace, generate);
  const compile = { id: "compile", inputs: { source: { snapshot: true }, generated: { step: "generate", port: "files" } },
    outputs: { output: { kind: "file", mediaType: "application/pdf", path: "result.pdf" } } };
  const context = await materializeInputs(workspace, compile, new Map([["generate:files", input]]));
  await fs.writeFile(path.join(context.outputDir, "result.pdf"), "controlled PDF identity fixture");
  const products = await validateOutputs(workspace, compile);
  const outputDir = path.join(context.workDir, "native");
  await fs.mkdir(outputDir);
  const file = products[0].files[0];
  const compiled = { stepId: "compile", family, format: "pdf", mappingEnabled: true, outputDir,
    outputs: [{ outputPort: "output", path: "result.pdf", compiledPath: "main.pdf", size: file.size, contentHash: file.contentHash }] };
  const options = { context, compiled, products, projectId: uuidv7(), runId: uuidv7() };
  return { root, options, sourceId, revision, outputDir, input, collect: () => collectCompilerMapping(options) };
}

test("compiler maps exclude generated file IDs and retain only recorded source revisions", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outputDir, "main.synctex"), "SyncTeX Version:1\nInput:1:/work/main.tex\nInput:2:/work/generated/include.tex\nContent:\n");
  const result = await f.collect();
  assert.equal(result.manifest.status, "ready");
  assert.deepEqual(result.manifest.sources.map(source => [source.sourceFileId, source.sourceRevisionId]), [[f.sourceId, f.revision]]);
  assert.deepEqual(result.manifest.artifacts[0].inputs, [{ tag: 1, input: "/work/main.tex", sourceFileId: f.sourceId }]);
  assert.equal(result.nativeFiles[0].name, `${f.options.products[0].id}.synctex`);
  assert.equal(result.nativeFiles[0].path, "main.synctex");
});

test("compiler maps preserve disabled, unsupported and missing states", async t => {
  const f = await fixture(t);
  assert.equal((await f.collect()).manifest.status, "missing");
  f.options.compiled.family = "lilypond";
  assert.equal((await f.collect()).manifest.status, "unsupported");
  f.options.compiled.mappingEnabled = false;
  f.options.context = { ...f.options.context, inputs: null };
  assert.equal((await f.collect()).manifest.status, "disabled");
  f.options.compiled.mappingEnabled = true; f.options.compiled.format = "svg";
  assert.equal((await f.collect()).manifest.status, "unsupported");
});

test("pipeline collection accounts for native records that have no project source match", async t => {
  const f = await fixture(t, "lilypond");
  const raw = "IRIS-LILYPOND\t1\nP\t1\t595\t842\nG\t1\texternal.ly\t1\t0\t1\t10\t20\t3\t4\n";
  await fs.writeFile(path.join(f.outputDir, "main.iris-map.tsv"), raw);
  const navigation = await f.collect();
  assert.equal(navigation.manifest.status, "ready");
  assert.equal(navigation.manifest.entries.length, 0);
  assert.deepEqual(navigation.usage, { nativeRecords: 4, nativeBytes: Buffer.byteLength(raw) });
});

test("compiler mapping rejects linked sidecars and conflicting native alternatives", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await fs.writeFile(outside, "SyncTeX Version:1\nContent:\n");
  await fs.symlink(outside, path.join(f.outputDir, "main.synctex"));
  const linked = await f.collect();
  assert.equal(linked.manifest.status, "unavailable");
  assert.deepEqual(linked.nativeFiles, []);
  await fs.unlink(path.join(f.outputDir, "main.synctex"));
  await fs.copyFile(outside, path.join(f.outputDir, "main.synctex"));
  await fs.copyFile(outside, path.join(f.outputDir, "main.synctex.gz"));
  const conflicting = await f.collect();
  assert.equal(conflicting.manifest.reason, "malformed-map");
  assert.deepEqual(conflicting.nativeFiles, []);
  assert.equal(await fs.readFile(outside, "utf8"), "SyncTeX Version:1\nContent:\n");
});

test("cancelled compiler mapping returns no usable manifest", async t => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort();
  f.options.context = { ...f.options.context, signal: controller.signal };
  await assert.rejects(f.collect(), { name: "AbortError" });
});

// The real runtime has separate native containment/drain gates. These controlled
// native responses isolate provider races while exercising real transfer and I/O.
async function queryFixture(t) {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.outputDir, "main.synctex"), "SyncTeX Version:1\nInput:1:/work/main.tex\nContent:\n");
  const navigation = await f.collect(), tool = createNavigationTools()[0], worker = {}, received = path.join(f.root, "received");
  let creates = 0, closes = 0;
  const runtime = {
    resolveTool: id => { assert.equal(id, "synctex"); return tool; },
    async createWorkspace(options) {
      creates++;
      assert.equal(options.queue, false);
      assert.ok(options.deadlineAt > Date.now() && options.deadlineAt <= Date.now() + 5000);
      await extractTransferArchive(createTransferArchive(options.input, { signal: options.signal }), received);
      assert.deepEqual(await fs.readdir(received), [`${f.options.products[0].id}.pdf`, `${f.options.products[0].id}.synctex`]);
      return worker;
    },
    async runContained(options) {
      assert.equal(options.workspace, worker);
      assert.equal(options.tool, tool);
      assert.equal(options.outputLimitBytes, 1048576);
      assert.deepEqual(tool.env, { SYNCTEX_EDITOR: "", SYNCTEX_VIEWER: "" });
      assert.deepEqual(options.args, ["view", "-i", "1:0:/work/main.tex", "-o", `/input/${f.options.products[0].id}.pdf`]);
      return { code: 0, drained: true, stdout: "SyncTeX result begin\nOutput:ignored\nPage:1\nh:10\nv:20\nW:3\nH:4\nSyncTeX result end\n", stderr: "" };
    },
    async disposeWorkspace(value) { assert.equal(value, worker); closes++; await fs.rm(received, { recursive: true }); },
  };
  const options = { navigation, products: f.options.products, projectId: f.options.projectId, runId: f.options.runId, enabled: true,
    runtime, query: { direction: "forward", sourceFileId: f.sourceId, line: 1, column: 0 } };
  return { ...f, runtime, options, counts: () => ({ creates, closes }), query: overrides => navigateCompilerMapping({ ...options, ...overrides }) };
}

test("contained navigation stages only checked aliases and closes its workspace after final integrity checks", async t => {
  const f = await queryFixture(t);
  const result = await f.query();
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.matches[0].sourceFileId, f.sourceId);
  assert.deepEqual(f.counts(), { creates: 1, closes: 1 });
  const run = f.runtime.runContained;
  f.runtime.runContained = async options => {
    const result = await run(options);
    await fs.chmod(path.join(f.options.products[0].root, f.options.products[0].path), 0o600);
    await fs.writeFile(path.join(f.options.products[0].root, f.options.products[0].path), "changed");
    return result;
  };
  assert.equal((await f.query()).reason, "stale-artifact");
  assert.deepEqual(f.counts(), { creates: 2, closes: 2 });
});

test("contained navigation maps runtime refusal and native failure without leaking a worker", async t => {
  const f = await queryFixture(t), create = f.runtime.createWorkspace;
  f.runtime.createWorkspace = async () => { throw Object.assign(new Error("busy"), { code: "PIPELINE_WORKER_BUSY" }); };
  assert.equal((await f.query()).reason, "busy");
  assert.deepEqual(f.counts(), { creates: 0, closes: 0 });
  f.runtime.createWorkspace = create;
  for (const [native, reason] of [[{ timedOut: true }, "timeout"], [{ truncated: true }, "output-limit"],
    [{ code: 1 }, "query-failed"], [{ cancelled: true }, "cancelled"]]) {
    f.runtime.runContained = async () => native;
    assert.equal((await f.query()).reason, reason);
  }
  assert.deepEqual(f.counts(), { creates: 4, closes: 4 });
});

test("cancelled and disabled contained navigation avoids inputs; cancellation after staging drains the reserved worker", async t => {
  const f = await queryFixture(t);
  const unreadable = { get manifest() { throw new Error("unexpected read"); } };
  assert.equal((await f.query({ enabled: false, navigation: unreadable })).status, "disabled");
  assert.equal((await f.query({ signal: AbortSignal.abort(), navigation: unreadable })).reason, "cancelled");
  assert.deepEqual(f.counts(), { creates: 0, closes: 0 });
  const create = f.runtime.createWorkspace, controller = new AbortController();
  f.runtime.createWorkspace = async options => { const worker = await create(options); controller.abort(); return worker; };
  f.runtime.runContained = async () => { assert.fail("cancelled staging must not start the query"); };
  assert.equal((await f.query({ signal: controller.signal })).reason, "cancelled");
  assert.deepEqual(f.counts(), { creates: 1, closes: 1 });
});

async function mixedFixture(t) {
  const tex = await fixture(t), lily = await fixture(t, "lilypond");
  const input = lily.options.context.inputs.source;
  lily.options.context = { ...lily.options.context, inputs: { ...lily.options.context.inputs,
    source: { ...input, files: input.files.map(file => ({ ...file, id: tex.sourceId, sourceRevisionId: tex.revision })) } } };
  await fs.writeFile(path.join(tex.outputDir, "main.synctex"), "SyncTeX Version:1\nInput:1:/work/main.tex\nContent:\n");
  await fs.writeFile(path.join(lily.outputDir, "main.iris-map.tsv"), "IRIS-LILYPOND\t1\nP\t1\t595\t842\nG\t1\tmain.tex\t1\t0\t1\t10\t20\t3\t4\n");
  const projectId = tex.options.projectId, runId = tex.options.runId;
  lily.options.projectId = projectId; lily.options.runId = runId;
  const collections = [{ navigation: await tex.collect(), products: tex.options.products },
    { navigation: await lily.collect(), products: lily.options.products }];
  const options = { projectId, runId, collections, products: [...tex.options.products, ...lily.options.products] };
  return { tex, lily, options, assemble: overrides => assembleRunMapping({ ...options, ...overrides }) };
}

test("mixed run maps share source text, bind both families and retain only published artifacts", async t => {
  const f = await mixedFixture(t), combined = f.assemble();
  assert.equal(combined.manifest.version, 2);
  assert.equal(combined.manifest.status, "ready");
  assert.equal(combined.manifest.sources.length, 1);
  assert.deepEqual(combined.manifest.artifacts.map(a => [a.id, a.backend, a.status]),
    [[f.tex.options.products[0].id, "latex", "ready"], [f.lily.options.products[0].id, "lilypond", "ready"]]);
  assert.equal(combined.nativeFiles.length, 1);
  assert.equal(combined.manifest.entries[0].artifactId, f.lily.options.products[0].id);
  const selected = f.assemble({ products: f.lily.options.products });
  assert.equal(selected.manifest.artifacts.length, 1);
  assert.deepEqual(selected.nativeFiles, []);
  const inverse = await navigateCompilerMapping({ ...f.options, navigation: selected, enabled: true,
    query: { direction: "inverse", artifactId: f.lily.options.products[0].id, page: 1, x: 11, y: 21 } });
  assert.equal(inverse.status, "ready", JSON.stringify(inverse));
  assert.equal(inverse.matches[0].sourceFileId, f.tex.sourceId);
});

test("run maps reject conflicting source revisions and aggregate native records without invalidating the PDFs", async t => {
  const f = await mixedFixture(t);
  f.options.collections[1].navigation.manifest.sources[0].sourceRevisionId = uuidv7();
  assert.equal(f.assemble().manifest.reason, "malformed-map");
  f.options.collections[1].navigation.manifest.sources[0].sourceRevisionId = f.tex.revision;
  for (const item of f.options.collections) item.navigation.usage = { nativeRecords: 110000, nativeBytes: 1000 };
  const limited = f.assemble();
  assert.equal(limited.manifest.status, "unavailable");
  assert.equal(limited.manifest.reason, "map-limit");
  assert.deepEqual(limited.nativeFiles, []);
  assert.equal(await fs.readFile(path.join(f.tex.options.products[0].root, "result.pdf"), "utf8"), "controlled PDF identity fixture");
});

test("run mapping preserves shared-source capacity and bounds source/native bytes and PDF metadata in aggregate", async t => {
  const f = await mixedFixture(t), text = "s".repeat(8 * 1024 * 1024) + "\n";
  for (const { navigation } of f.options.collections) {
    Object.assign(navigation.manifest.sources[0], { text, sourceHash: hash(text) });
    for (const entry of navigation.manifest.entries) entry.sourceHash = hash(text);
  }
  const shared = f.assemble();
  assert.equal(shared.manifest.status, "ready");
  assert.equal(shared.manifest.sources.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(shared.manifest)) < MAX_MAP_BYTES);
  f.options.collections[1].navigation.manifest.sources.push({ ...shared.manifest.sources[0], sourceFileId: uuidv7(), path: "other.tex" });
  assert.equal(f.assemble().manifest.reason, "map-limit");
  f.options.collections[1].navigation.manifest.sources.pop();
  for (const item of f.options.collections) item.navigation.usage.nativeBytes = 8388609;
  assert.equal(f.assemble().manifest.reason, "map-limit");
  for (const item of f.options.collections) item.navigation.usage.nativeBytes = 1000;
  const product = f.options.products[0];
  const extra = size => ({ ...product, files: [{ ...product.files[0], id: uuidv7(), size }] });
  assert.equal(f.assemble({ products: Array.from({ length: 33 }, () => extra(1)) }).manifest.reason, "map-limit");
  assert.equal(f.assemble({ products: [extra(67108865), extra(67108865)] }).manifest.reason, "map-limit");
});

test("an unassociated PDF has its own unsupported state while published compiler maps remain usable", async t => {
  const f = await mixedFixture(t), original = f.options.products[0], id = uuidv7();
  const processed = { ...original, id, files: [{ ...original.files[0], id }] };
  const products = [...f.options.products, processed], navigation = f.assemble({ products });
  assert.equal(navigation.manifest.artifacts.at(-1).status, "unsupported");
  assert.equal(navigation.manifest.artifacts.at(-1).syncFile, undefined);
  const options = { ...f.options, products, navigation, enabled: true };
  assert.equal((await navigateCompilerMapping({ ...options, query: { direction: "inverse", artifactId: id, page: 1, x: 11, y: 21 } })).status, "unsupported");
  assert.equal((await navigateCompilerMapping({ ...options,
    query: { direction: "inverse", artifactId: f.lily.options.products[0].id, page: 1, x: 11, y: 21 } })).status, "ready");
});

test("run collection reuses immutable source capture and stops map I/O after aggregate exhaustion", async t => {
  const f = await mixedFixture(t), { projectId, runId } = f.options;
  const collector = createRunMappingCollector({ projectId, runId });
  const first = f.tex.options, second = f.lily.options;
  second.compiled.family = "latex";
  second.context = { ...second.context, inputs: { ...second.context.inputs,
    source: { ...second.context.inputs.source, files: first.context.inputs.source.files } } };
  const raw = "SyncTeX Version:1\nInput:1:/work/main.tex\nContent:\n" + "x\n".repeat(110000);
  await fs.writeFile(path.join(f.tex.outputDir, "main.synctex"), raw);
  await fs.writeFile(path.join(f.lily.outputDir, "main.synctex"), raw);
  assert.equal((await collector.collect(first)).manifest.status, "ready");
  await fs.rm(second.context.inputs.source.root, { recursive: true });
  // Source bytes already belong to the same immutable file manifest. Only the
  // second native map must be read to detect the run-wide record overflow.
  assert.equal((await collector.collect(second)).manifest.status, "ready");
  assert.equal(collector.assemble(f.options.products).manifest.reason, "map-limit");
  const stopped = await collector.collect({ ...second, context: { step: second.context.step,
    get inputs() { throw new Error("must not recapture sources after exhaustion"); } } });
  assert.equal(stopped.manifest.reason, "map-limit");
  assert.deepEqual(stopped.nativeFiles, []);
});

test("unpublished compressed maps still consume the run-wide expansion budget", async t => {
  const f = await mixedFixture(t);
  f.lily.options.compiled.family = "latex";
  await fs.unlink(path.join(f.tex.outputDir, "main.synctex"));
  const bytes = gzipSync("SyncTeX Version:1\nInput:1:/work/main.tex\nContent:\n" + "x".repeat(9 * 1024 * 1024));
  for (const compiler of [f.tex, f.lily]) await fs.writeFile(path.join(compiler.outputDir, "main.synctex.gz"), bytes);
  f.options.collections = [{ navigation: await f.tex.collect(), products: f.tex.options.products },
    { navigation: await f.lily.collect(), products: f.lily.options.products }];
  for (const { navigation } of f.options.collections) assert.equal(navigation.manifest.status, "ready");
  const combined = f.assemble({ products: f.lily.options.products });
  assert.equal(combined.manifest.reason, "map-limit");
  assert.deepEqual(combined.nativeFiles, []);
});

test("a compiler map that already exceeds its own limit exhausts further run collection", async t => {
  const f = await fixture(t), collector = createRunMappingCollector(f.options);
  await fs.writeFile(path.join(f.outputDir, "main.synctex"), "SyncTeX Version:1\nContent:\n" + "x\n".repeat(200000));
  assert.equal((await collector.collect(f.options)).manifest.reason, "map-limit");
  assert.equal(collector.assemble(f.options.products).manifest.status, "unavailable");
  assert.equal(collector.assemble(f.options.products).manifest.reason, "map-limit");
});
