const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { uuidv7 } = require("../src/ids");
const { createRunWorkspace, materializeInputs, validateOutputs } = require("../src/pipeline/workspaces");
const { collectCompilerMapping } = require("../src/pipeline/navigation");

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
