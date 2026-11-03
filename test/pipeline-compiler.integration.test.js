const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { PDFDocument } = require("pdf-lib");
const { uuidv7 } = require("../src/ids");
const { ConcurrencyGate } = require("../src/throttle");
const { createRegistry } = require("../src/pipeline/registry");
const { validatePlan } = require("../src/pipeline/contracts");
const { createRunWorkspace, disposeRunWorkspace } = require("../src/pipeline/workspaces");
const { executePlan } = require("../src/pipeline/executor");
const { createPodmanRuntime } = require("../src/pipeline/runtime");
const helpers = require("../src/server");
const native = { skip: !process.env.IRIS_TEST_PIPELINE_IMAGE || process.env.IRIS_TEST_COMPILERS !== "1", timeout: 180000 };

async function fixture(t, files, settings = {}, { onOutput, onCompiled, onArtifacts, timeoutMs = 60000, adapters = [] } = {}) {
  const { createCompilerTools, createCompilerAdapters } = require("../src/pipeline/compilers");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-compilers-"));
  const source = path.join(root, "source"), stateRoot = path.join(root, "runtime");
  await fs.mkdir(source);
  const transport = { command: "podman", connection: process.env.IRIS_TEST_PODMAN_CONNECTION || null, home: process.env.IRIS_TEST_PODMAN_HOME };
  let workspace, runtime;
  t.after(async () => {
    if (runtime) {
      await runtime.close();
      const { installationId } = JSON.parse(await fs.readFile(path.join(stateRoot, "installation.json"), "utf8"));
      for (const args of [["ps", "--all"], ["volume", "ls"]]) {
        const { stdout } = await promisify(execFile)("podman", [...(transport.connection ? ["--connection", transport.connection] : []),
          ...args, "--filter", `label=iris.installation=${installationId}`, "--format", "{{.Name}}"],
        { env: { PATH: process.env.PATH, HOME: transport.home }, timeout: 15000 });
        assert.equal(stdout.trim(), "");
      }
    }
    if (workspace) await disposeRunWorkspace(workspace);
    await fs.rm(root, { recursive: true, force: true });
  });
  runtime = await createPodmanRuntime({ root: stateRoot, coordinatorId: uuidv7(), transport,
    policy: { image: process.env.IRIS_TEST_PIPELINE_IMAGE, memoryBytes: 805306368, totalMemoryBytes: 1342177280,
      outputBytes: 134217728, tempBytes: 268435456, timeoutMs, runTimeoutMs: 300000 }, tools: createCompilerTools({ timeoutMs }),
  });
  if (typeof files === "function") files = await files(runtime, root);
  for (const [file, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), body);
  }
  workspace = await createRunWorkspace({ root: source, settings: { projectType: "latex", sourceMapping: true, ...settings },
    files: Object.keys(files).map(file => ({ id: uuidv7(), path: file, sourceRevisionId: typeof files[file] === "string" ? uuidv7() : null,
      binary: typeof files[file] !== "string" })), directories: [],
  }, { root: path.join(root, "runs") });
  const compiled = new Map();
  const registry = createRegistry([...createCompilerAdapters({ ...helpers, runtime, runId: uuidv7(), onOutput,
    onCompiled: async (context, result) => { compiled.set(context.step.id, result); await onCompiled?.(context, result); },
  }), ...adapters]);
  return { source, workspace, registry, compiled, async run(steps, targets = { main: { steps: steps.map(s => s.id), publish: steps.map(s => ({ step: s.id, port: "output" })) } }, target = "main", signal) {
    const plan = validatePlan({ apiVersion: 1, pluginId: "compiler-fixture", steps, targets }, { registry });
    return executePlan({ plan, target, workspace, registry, gate: new ConcurrencyGate({ limit: 1, queueLimit: 4 }), signal, onArtifacts });
  } };
}
const step = (id, family, main, options = {}, kind = "file") => ({ id, adapter: { id: `iris.${family}`, version: "1.0.0" },
  inputs: { source: { snapshot: true } }, options: { main, ...options },
  outputs: { output: { kind, mediaType: "application/pdf", path: kind === "file" ? `${id}/result.pdf` : `${id}/documents` } },
});

test("one graph compiles LaTeX and LilyPond from read-only sources and publishes only its selected target", native, async t => {
  const files = {
    "main.tex": "\\documentclass{article}\r\n\\begin{document}\\input{parts/text}\\end{document}\r\n",
    "parts/text.tex": "Snapshot include.\r\n",
    "main.ly": '\\version "2.24.1"\n\\include "parts/music.ily"\n\\score { \\melody }\n',
    "parts/music.ily": "melody = { c'1 d'1 }\n",
  };
  const f = await fixture(t, files);
  const result = await f.run([step("text", "latex", "main.tex"), step("music", "lilypond", "main.ly"), step("unused", "latex", "absent.tex")], {
    main: { steps: ["text", "music"], publish: [{ step: "music", port: "output" }], primaryPreview: { step: "music", port: "output" } },
    unused: { steps: ["unused"], publish: [] },
  });
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map(s => s.id), ["text", "music"]);
  assert.deepEqual(result.artifacts.map(a => a.producerStep), ["music"]);
  for (const [id, family] of [["text", "latex"], ["music", "lilypond"]]) {
    const compiled = f.compiled.get(id);
    assert.equal(compiled.family, family);
    const names = await fs.readdir(compiled.outputDir);
    assert.ok(names.includes("main.pdf"));
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(compiled.outputDir, "main.pdf")))).getPageCount(), 1);
  }
  for (const [file, body] of Object.entries(files)) assert.equal(await fs.readFile(path.join(f.source, file), "utf8"), body);
});

test("compiler collections preserve independently named LilyPond books and private navigation sidecars", native, async t => {
  const f = await fixture(t, { "main.ly": '\\version "2.24.1"\n\\book { \\bookOutputName "first" \\score { { c\'1 } } }\n\\book { \\bookOutputName "second" \\score { { d\'1 } } }\n' });
  const result = await f.run([step("books", "lilypond", "main.ly", {}, "collection")]);
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.deepEqual(result.artifacts[0].files.map(file => file.path), ["books/documents/first.pdf", "books/documents/second.pdf"]);
  assert.ok((await fs.readdir(f.compiled.get("books").outputDir)).some(file => file.endsWith(".iris-map.tsv")));
});

test("failed contained compilation retains source diagnostics and blocks its dependent step", native, async t => {
  const f = await fixture(t, { "main.tex": "\\documentclass{article}\n\\begin{document}\n\\input{parts/broken}\n\\end{document}\n",
    "parts/broken.tex": "\\UndefinedIrisCommand\n" });
  const downstream = step("later", "latex", "main.tex"); downstream.after = ["broken"];
  const result = await f.run([step("broken", "latex", "main.tex"), downstream]);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.steps.map(s => s.state), ["failed", "blocked"]);
  assert.ok(result.steps[0].diagnostics.some(d => d.severity === "error" && d.file === "parts/broken.tex" && d.line === 1));
  const diagnostic = result.steps[0].diagnostics.find(d => d.file === "parts/broken.tex");
  const source = f.workspace.snapshot.files.find(file => file.path === "parts/broken.tex");
  assert.equal(diagnostic.stepId, "broken");
  assert.equal(diagnostic.sourceFileId, source.id);
  assert.match(diagnostic.sourceRevisionId, /^[a-f0-9-]{36}$/);
  assert.equal(diagnostic.sourceRevisionId, source.sourceRevisionId);
  assert.equal(diagnostic.sourceContentHash, createHash("sha256").update("\\UndefinedIrisCommand\n").digest("hex"));
  assert.equal(diagnostic.generatedSource, undefined);
  assert.deepEqual(result.artifacts, []);
});

for (const family of ["latex", "lilypond"]) {
  test(`contained ${family} diagnostics identify the generating artifact without inventing a project file`, native, async t => {
    const generatedPath = family === "latex" ? "generated/broken.tex" : "generated/broken.ily";
    const bytes = "\\UndefinedIrisCommand\n";
    const generator = { id: "fixture-generator", version: "1.0.0", implementationHash: "a".repeat(64), capabilities: [],
      inputs: {}, optionsSchema: { type: "object" }, outputs: { includes: { kinds: ["collection"], mediaTypes: ["text/plain"], required: true } },
      async execute(context) {
        await fs.mkdir(path.join(context.outputDir, "generated"));
        await fs.writeFile(path.join(context.outputDir, generatedPath), bytes);
      },
    };
    let generated;
    const main = family === "latex" ? "main.tex" : "main.ly";
    const f = await fixture(t, { [main]: family === "latex"
      ? "\\documentclass{article}\n\\begin{document}\\input{generated/broken}\\end{document}\n"
      : '\\version "2.24.1"\n\\include "generated/broken.ily"\n\\score { { c\'1 } }\n' }, {},
    { adapters: [generator], onCompiled: context => { generated = context.inputs.generated.files[0]; } });
    const generate = { id: "generate", adapter: { id: "fixture-generator", version: "1.0.0" },
      outputs: { includes: { kind: "collection", mediaType: "text/plain", path: "generated" } } };
    const compile = step("compile", family, main);
    compile.inputs.generated = { step: "generate", port: "includes" };
    const result = await f.run([generate, compile], { main: { steps: ["compile"], publish: [{ step: "compile", port: "output" }] } });
    assert.equal(result.state, "failed", JSON.stringify(result.steps));
    const diagnostic = result.steps.find(s => s.id === "compile").diagnostics.find(d => d.severity === "error" && d.file === generatedPath);
    assert.ok(diagnostic, JSON.stringify(result.steps));
    assert.equal(diagnostic.stepId, "compile");
    assert.equal(diagnostic.line, 1);
    assert.equal(diagnostic.sourceFileId, undefined);
    assert.equal(diagnostic.sourceRevisionId, undefined);
    assert.deepEqual(diagnostic.generatedSource, { artifactId: generated.id, producerStep: "generate", outputPort: "includes",
      path: generatedPath, contentHash: createHash("sha256").update(bytes).digest("hex") });
    assert.match(diagnostic.generatedSource.artifactId, /^[a-f0-9-]{36}$/);
    assert.equal(f.workspace.snapshot.files.length, 1);
  });
}

test("declared build-file collections retain auxiliary outputs and exclude private navigation data", native, async t => {
  const f = await fixture(t, { "main.tex": "\\documentclass{article}\n\\begin{document}Public output fixture.\\end{document}\n" });
  const compile = step("build", "latex", "main.tex");
  compile.outputs.files = { kind: "collection", mediaType: "application/vnd.iris.build-files", path: "build/files" };
  const result = await f.run([compile], { main: { steps: ["build"], publish: [{ step: "build", port: "output" }, { step: "build", port: "files" }] } });
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  const names = result.artifacts.find(a => a.outputPort === "files").files.map(file => file.path);
  assert.deepEqual(names, ["build/files/main.aux", "build/files/main.log", "build/files/main.pdf"]);
  assert.ok((await fs.readdir(f.compiled.get("build").outputDir)).includes("main.synctex.gz"));
});

test("compiler metadata binds renamed and duplicated PDFs to each validated output member", native, async t => {
  let compiled, bound;
  const f = await fixture(t, { "main.ly": '\\version "2.24.1"\n\\book { \\bookOutputName "first" \\score { { c\'1 } } }\n\\book { \\bookOutputName "second" \\score { { d\'1 } } }\n' }, {}, {
    onCompiled: (context, result) => { compiled = result; },
    onArtifacts: (context, artifacts) => { bound = artifacts; },
  });
  const compile = step("books", "lilypond", "main.ly");
  compile.outputs.files = { kind: "collection", mediaType: "application/vnd.iris.build-files", path: "all" };
  const result = await f.run([compile]);
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.equal(compiled.stepId, "books");
  assert.equal(compiled.mappingEnabled, true);
  assert.ok(bound);
  assert.deepEqual(compiled.outputs.filter(file => file.compiledPath.endsWith(".pdf")).map(file => [file.outputPort, file.path, file.compiledPath]),
    [["output", "books/result.pdf", "first.pdf"], ["files", "all/first.pdf", "first.pdf"], ["files", "all/second.pdf", "second.pdf"]]);
  for (const product of bound) for (const file of product.files) {
    const origin = compiled.outputs.find(item => item.outputPort === product.outputPort && item.path === file.path);
    assert.ok(origin);
    assert.equal(origin.contentHash, file.contentHash);
    assert.equal(origin.size, file.size);
    assert.equal(createHash("sha256").update(await fs.readFile(path.join(compiled.outputDir, origin.compiledPath))).digest("hex"), file.contentHash);
  }
});

for (const family of ["latex", "lilypond"]) {
  test(`contained ${family} maps bind final artifact hashes and recorded source revisions`, native, async t => {
    const { collectCompilerMapping } = require("../src/pipeline/navigation");
    const main = family === "latex" ? "main.tex" : "main.ly", include = family === "latex" ? "parts/text.tex" : "parts/music.ily";
    let compiled, navigation, rejected;
    const projectId = uuidv7(), runId = uuidv7();
    const f = await fixture(t, family === "latex" ? {
      [main]: "\\documentclass{article}\n\\begin{document}\\input{parts/text}\\end{document}\n", [include]: "Included source.\r\n",
    } : { [main]: '\\version "2.24.1"\n\\include "parts/music.ily"\n\\score { \\melody }\n', [include]: "melody = { c'1 d'1 }\r\n" }, {}, {
      onCompiled: (context, result) => { compiled = result; },
      onArtifacts: async (context, products) => {
        navigation = await collectCompilerMapping({ context, compiled, products, projectId, runId });
        const forged = products.map(product => ({ ...product, files: product.files.map(file => ({ ...file, contentHash: "0".repeat(64) })) }));
        rejected = await collectCompilerMapping({ context, compiled, products: forged, projectId, runId });
      },
    });
    const result = await f.run([step("compile", family, main)]);
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    assert.equal(navigation.manifest.status, "ready", JSON.stringify(navigation.manifest));
    const artifact = result.artifacts[0];
    assert.equal(navigation.manifest.artifacts[0].id, artifact.id);
    assert.equal(navigation.manifest.artifacts[0].contentHash, artifact.contentHash);
    assert.equal(navigation.manifest.artifacts[0].size, artifact.size);
    const source = f.workspace.snapshot.files.find(file => file.path === include);
    const mapped = navigation.manifest.sources.find(file => file.path === include);
    assert.equal(mapped.sourceFileId, source.id);
    assert.equal(mapped.sourceRevisionId, source.sourceRevisionId);
    assert.ok(!mapped.text.includes("\r"));
    if (family === "latex") {
      assert.ok(navigation.manifest.artifacts[0].inputs.some(input => input.sourceFileId === source.id));
      assert.equal(navigation.nativeFiles.length, 1);
    } else {
      assert.ok(navigation.manifest.entries.some(entry => entry.sourceFileId === source.id && entry.artifactId === artifact.id));
      assert.deepEqual(navigation.nativeFiles, []);
    }
    assert.equal(rejected.manifest.status, "unavailable");
    assert.equal(rejected.manifest.reason, "stale-artifact");
    assert.deepEqual(rejected.nativeFiles, []);
  });
}

for (const [format, mediaType] of [["png", "image/png"], ["svg", "image/svg+xml"], ["ps", "application/postscript"], ["eps", "application/postscript"]]) {
  test(`contained LilyPond retains ${format} output selection`, native, async t => {
    const f = await fixture(t, { "main.ly": '\\version "2.24.1"\n\\score { { c\'1 } }\n' });
    const compile = step("score", "lilypond", "main.ly", { format, args: "-dresolution=72" }, "collection");
    compile.outputs.output.mediaType = mediaType;
    const result = await f.run([compile]);
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    const artifact = result.artifacts[0];
    assert.ok(artifact.files.length > 0);
    for (const file of artifact.files) {
      assert.ok(file.path.endsWith(`.${format}`));
      const bytes = await fs.readFile(path.join(artifact.root, file.path));
      if (format === "png") assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
      else assert.match(bytes.toString("utf8"), format === "svg" ? /<svg\b/ : /^%!PS/);
    }
  });
}

for (const engine of ["xelatex", "lualatex", "xetex"]) {
  test(`contained ${engine} preserves a custom multipass profile`, native, async t => {
    const f = await fixture(t, { "main.tex": engine === "xetex" ? "Iris plain XeTeX.\\bye\n" : "\\documentclass{article}\n\\begin{document}Iris engine fixture.\\end{document}\n" });
    const result = await f.run([step("custom", "latex", "main.tex", { engine, profile: { mode: "custom", steps: [
      { tool: "[engine]", args: ["-recorder", "[main]"] }, { tool: "[engine]", args: ["-recorder", "[main]"] },
    ] } })]);
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    assert.match(f.compiled.get("custom").log, /Iris step 2\/2/);
    assert.ok((await fs.readdir(f.compiled.get("custom").outputDir)).includes("main.fls"));
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(result.artifacts[0].root, result.artifacts[0].path)))).getPageCount(), 1);
  });
}

for (const mode of ["bibtex", "biber", "index"]) {
  test(`contained ${mode} profile retains auxiliary output and selects final-pass diagnostics`, native, async t => {
    const preamble = mode === "biber" ? "\\usepackage{biblatex}\\addbibresource{refs.bib}" : mode === "index" ? "\\usepackage{makeidx}\\makeindex" : "";
    const body = mode === "biber" ? "\\cite{iris}\\printbibliography" : mode === "index" ? "Iris\\index{Iris}\\printindex" : "\\cite{iris}\\bibliographystyle{plain}\\bibliography{refs}";
    const f = await fixture(t, { "main.tex": `\\documentclass{article}\n${preamble}\n\\begin{document}${body}\\end{document}\n`,
      "refs.bib": '@book{iris,author={Test Author},title={Synthetic reference},year={2026},publisher={Fixture Press}}\n' });
    const result = await f.run([step("references", "latex", "main.tex", { profile: { mode } })]);
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    const compiled = f.compiled.get("references");
    assert.match(await fs.readFile(path.join(compiled.outputDir, mode === "index" ? "main.ind" : "main.bbl"), "utf8"), mode === "index" ? /Iris/ : /Synthetic reference/);
    assert.ok(!result.steps[0].diagnostics.some(d => /undefined|Please.*(?:Biber|LaTeX)|Rerun/.test(d.message)), JSON.stringify(result.steps[0].diagnostics));
  });
}

test("cancelling an active contained compiler drains it and blocks further passes", native, async t => {
  const controller = new AbortController();
  const f = await fixture(t, { "main.tex": "\\documentclass{article}\n\\begin{document}\\message{IRIS-CANCEL-READY}\\loop\\iftrue\\repeat\\end{document}\n" }, {}, {
    timeoutMs: 15000, onOutput: (context, chunk) => { if (chunk.toString().includes("IRIS-CANCEL-READY")) controller.abort(); },
  });
  const result = await f.run([step("loop", "latex", "main.tex", { profile: { mode: "bibtex" } })], undefined, undefined, controller.signal);
  assert.equal(result.state, "cancelled", JSON.stringify(result.steps));
  assert.deepEqual(result.artifacts, []);
  assert.equal(f.compiled.size, 0);
});

test("generated include artifacts feed both compiler families without mutating the snapshot", native, async t => {
  const generator = { id: "fixture-generator", version: "1.0.0", implementationHash: "a".repeat(64), capabilities: [],
    inputs: {}, optionsSchema: { type: "object" }, outputs: { includes: { kinds: ["collection"], mediaTypes: ["text/plain"], required: true } },
    async execute(context) {
      await fs.mkdir(path.join(context.outputDir, "generated"));
      await fs.writeFile(path.join(context.outputDir, "generated/text.tex"), "Generated text.");
      await fs.writeFile(path.join(context.outputDir, "generated/music.ily"), "melody = { c'1 d'1 }\n");
    },
  };
  const f = await fixture(t, { "main.tex": "\\documentclass{article}\n\\begin{document}\\input{generated/text}\\end{document}\n",
    "main.ly": '\\version "2.24.1"\n\\include "generated/music.ily"\n\\score { \\melody }\n' }, {}, { adapters: [generator] });
  const generate = { id: "generate", adapter: { id: "fixture-generator", version: "1.0.0" }, outputs: { includes: { kind: "collection", mediaType: "text/plain", path: "generated" } } };
  const compilers = [step("latex", "latex", "main.tex"), step("lily", "lilypond", "main.ly")];
  for (const compiler of compilers) compiler.inputs.generated = { step: "generate", port: "includes" };
  const result = await f.run([generate, ...compilers], { main: { steps: ["latex", "lily"], publish: compilers.map(s => ({ step: s.id, port: "output" })) } });
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.equal(result.artifacts.length, 2);
  await assert.rejects(fs.stat(path.join(f.workspace.snapshot.root, "generated")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.source, "generated")), { code: "ENOENT" });
});

for (const engine of ["xelatex", "lualatex"]) {
  test(`contained ${engine} loads a byte-exact project font through a nested source include`, native, async t => {
    const f = await fixture(t, async (runtime, root) => {
      const worker = await runtime.createWorkspace({ runId: uuidv7(), stepId: "font-fixture" });
      try {
        const result = await runtime.runContained({ workspace: worker, tool: runtime.resolveTool("compiler-setup"), args: ["-e",
          "const fs=require('node:fs');fs.mkdirSync('/work/font');fs.copyFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf','/work/font/Project.ttf')"] });
        assert.equal(result.code, 0, result.log);
        const exported = await runtime.exportWorkspace({ workspace: worker, directory: "font", destination: path.join(root, "font-source") });
        return { "fonts/Project.ttf": await fs.readFile(path.join(exported.root, "font/Project.ttf")),
          "main.tex": "\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Project.ttf}[Path=fonts/]\n\\begin{document}\\input{parts/text}\\end{document}\n",
          "parts/text.tex": "Project font: café, music.\n" };
      } finally { await runtime.disposeWorkspace(worker); }
    });
    const result = await f.run([step("font", "latex", "main.tex", { engine })]);
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    const sourceBytes = await fs.readFile(path.join(f.source, "fonts/Project.ttf"));
    assert.deepEqual(await fs.readFile(path.join(f.workspace.snapshot.root, "fonts/Project.ttf")), sourceBytes);
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(result.artifacts[0].root, result.artifacts[0].path)))).getPageCount(), 1);
  });
}
