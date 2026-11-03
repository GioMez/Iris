const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { uuidv7 } = require("../src/ids");
const { createRunWorkspace, materializeInputs, validateOutputs } = require("../src/pipeline/workspaces");
const { collectCompilerMapping, navigateCompilerMapping, createNavigationTools } = require("../src/pipeline/navigation");
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
