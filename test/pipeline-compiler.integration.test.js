const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { PDFDocument } = require("pdf-lib");
const { redPixels } = require("./helpers/pdf-raster.cjs");
const { uuidv7 } = require("../src/ids");
const { ConcurrencyGate } = require("../src/throttle");
const { createRegistry } = require("../src/pipeline/registry");
const { validatePlan } = require("../src/pipeline/contracts");
const { createRunWorkspace, disposeRunWorkspace } = require("../src/pipeline/workspaces");
const { executePlan } = require("../src/pipeline/executor");
const { createNativeRuntime } = require("../src/pipeline/runtime");
const helpers = require("../src/server");
const native = { skip: process.env.IRIS_TEST_COMPILERS !== "1", timeout: 180000 };
const nativeLua = { ...native, skip: native.skip || process.env.IRIS_TEST_LUA !== "1" };

async function fixture(t, files, settings = {}, { onOutput, onCompiled, onArtifacts, timeoutMs = 60000, adapters = [], tools = [] } = {}) {
  const { createCompilerTools, createCompilerAdapters } = require("../src/pipeline/compilers");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-compilers-"));
  const source = path.join(root, "source"), stateRoot = path.join(root, "runtime");
  await fs.mkdir(source);
  let workspace, runtime;
  t.after(async () => {
    if (runtime) {
      await runtime.close();
      assert.deepEqual(await fs.readdir(stateRoot), ["installation.json"]);
    }
    if (workspace) await disposeRunWorkspace(workspace);
    await fs.rm(root, { recursive: true, force: true });
  });
  runtime = await createNativeRuntime({ root: stateRoot, coordinatorId: uuidv7(),
    policy: { outputBytes: 134217728, timeoutMs, runTimeoutMs: 300000 }, tools: [...createCompilerTools({ timeoutMs }), ...tools],
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
  return { source, workspace, registry, compiled, runtime, async run(steps, targets = { main: { steps: steps.map(s => s.id), publish: steps.map(s => ({ step: s.id, port: "output" })) } }, target = "main", signal) {
    const plan = validatePlan({ apiVersion: 1, pluginId: "compiler-fixture", steps, targets }, { registry });
    return executePlan({ plan, target, workspace, registry, gate: new ConcurrencyGate({ limit: 1, queueLimit: 4 }), signal, onArtifacts });
  } };
}
const step = (id, family, main, options = {}, kind = "file") => ({ id, adapter: { id: `iris.${family}`, version: "1.0.0" },
  inputs: { source: { snapshot: true } }, options: { main, ...options },
  outputs: { output: { kind, mediaType: "application/pdf", path: kind === "file" ? `${id}/result.pdf` : `${id}/documents` } },
});

test("a required layout cannot silently compile without a declared layout output", native, async t => {
  const f = await fixture(t, { "main.tex": "\\documentclass{article}\\begin{document}Text.\\end{document}" });
  const compile = step("compile", "latex", "main.tex");
  compile.requiredCapabilities = ["layout.occupied.complete"];
  const result = await f.run([compile]);
  assert.equal(result.state, "failed");
  assert.equal(result.steps[0].errorCode, "PIPELINE_LAYOUT_CAPABILITY_UNAVAILABLE");
  assert.equal(f.compiled.size, 0);
});

for (const family of ["latex", "lilypond"]) test(`${family} layout sidecars preserve independent native source navigation`, native, async t => {
  const { collectCompilerMapping } = require("../src/pipeline/navigation");
  const main = family === "latex" ? "main.tex" : "main.ly";
  let navigation;
  const f = await fixture(t, { [main]: family === "latex"
    ? "\\documentclass{article}\n\\begin{document}\nMapped source.\n\\end{document}\n"
    : '\\version "2.26.0"\n\\score { \\new Staff { c\'1 } }\n' }, { projectType: family }, {
    onArtifacts: async (context, products) => { navigation = await collectCompilerMapping({ context, products,
      compiled: f.compiled.get("compile"), projectId: uuidv7(), runId: uuidv7() }); },
  });
  const compile = step("compile", family, main, { sourceMapping: true });
  compile.outputs.layout = { kind: "layout", mediaType: "application/vnd.iris.layout+json", path: "layout.json" };
  const result = await f.run([compile]);
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.equal(navigation.manifest.status, "ready", JSON.stringify(navigation.manifest));
  assert.deepEqual(navigation.mappedArtifacts, [result.artifacts[0].id]);
});

for (const family of ["latex", "lilypond"]) test(`installed Lua reads the typed final ${family} layout and exact PDF identity`, nativeLua, async t => {
  const { createLuaCoordinator, createLuaAdapter, createLuaTools } = require("../src/pipeline/lua");
  const plugin = await fs.readFile(path.join(__dirname, "fixtures/pipelines/inspect-layout.lua"), "utf8");
  const main = family === "latex" ? "main.tex" : "main.ly";
  let host, plan;
  const f = await fixture(t, { "iris.lua": plugin, [main]: family === "latex"
    ? "\\documentclass{article}\n\\begin{document}Final layout.\\end{document}\n"
    : '\\version "2.26.0"\n\\score { \\new Staff { c\'1 } }\n' }, { projectType: family }, {
    tools: createLuaTools(), adapters: [createLuaAdapter({ execute: context => host.transformLua({ approval: host.identity, plan, context }) })],
  });
  host = createLuaCoordinator({ runtime: f.runtime, workspace: f.workspace, runId: uuidv7(), registry: f.registry });
  const descriptor = await host.inspectLua({ approval: host.identity });
  plan = await host.planLua({ approval: host.identity, descriptor, parameters: { family } });
  const result = await executePlan({ plan, target: "main", workspace: f.workspace, registry: f.registry,
    gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }) });
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  const report = result.artifacts[0];
  assert.equal(await fs.readFile(path.join(report.root, report.path), "utf8"), "inspected matching final PDF layout");
});

for (const family of ["latex", "lilypond"]) test(`approved Lua generates a native ${family} include with retained output and diagnostic provenance`, nativeLua, async t => {
  const { createLuaCoordinator, createLuaAdapter } = require("../src/pipeline/lua");
  const plugin = await fs.readFile(path.join(__dirname, "fixtures/pipelines/generate.lua"), "utf8");
  const main = family === "latex" ? "main.tex" : "main.ly";
  const source = family === "latex" ? "\\documentclass{article}\n\\begin{document}\n\\input{generated/include.tex}\n\\end{document}\n"
    : '\\version "2.24.1"\n\\include "generated/include.ily"\n\\score { \\new Staff { \\generatedMusic } }\n';
  for (const broken of [false, true]) {
    let host, plan;
    const f = await fixture(t, { "iris.lua": plugin, [main]: source }, { projectType: family }, {
      tools: require("../src/pipeline/lua").createLuaTools(),
      adapters: [createLuaAdapter({ execute: context => host.transformLua({ approval: host.identity, plan, context }) })],
    });
    host = createLuaCoordinator({ runtime: f.runtime, workspace: f.workspace, runId: uuidv7(), registry: f.registry });
    const descriptor = await host.inspectLua({ approval: host.identity });
    plan = await host.planLua({ approval: host.identity, descriptor, parameters: { family, count: 3, broken } });
    const result = await executePlan({ plan, target: "main", workspace: f.workspace, registry: f.registry,
      gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }) });
    assert.equal(await fs.readFile(path.join(f.source, main), "utf8"), source);
    await assert.rejects(fs.stat(path.join(f.source, "generated")), { code: "ENOENT" });
    assert.equal(f.compiled.size, 1);
    assert.equal(f.compiled.get("compile").family, family);
    if (!broken) {
      assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
      assert.equal(result.artifacts.length, 2);
      const include = result.artifacts[0];
      assert.equal(await fs.readFile(path.join(include.root, include.path), "utf8"), family === "latex"
        ? "Generated Iris text. Generated Iris text. Generated Iris text. \n" : "generatedMusic = { c'4 c'4 c'4 }\n");
      assert.equal((await PDFDocument.load(await fs.readFile(path.join(result.artifacts[1].root, result.artifacts[1].path)))).getPageCount(), 1);
    } else {
      assert.equal(result.state, "failed");
      assert.deepEqual(result.artifacts, []);
      const diagnostic = result.steps[1].diagnostics.find(item => item.generatedSource?.producerStep === "generate");
      assert.ok(diagnostic, JSON.stringify(result.steps));
      assert.equal(diagnostic.sourceFileId, undefined);
      assert.equal(diagnostic.generatedSource.outputPort, "include");
    }
  }
});

test("changing a Lua-generated include changes only its declared dependent LilyPond score", nativeLua, async t => {
  const { createLuaCoordinator, createLuaAdapter } = require("../src/pipeline/lua");
  const base = await fs.readFile(path.join(__dirname, "fixtures/pipelines/generate.lua"), "utf8");
  const plugin = `local plugin=(function() ${base} end)()
    local original=plugin.plan
    plugin.plan=function(ctx)
      local graph=original(ctx)
      table.insert(graph.steps,{id='control',adapter={id='iris.lilypond',version='1.0.0'},
        inputs={source={snapshot=true}},options={main='control.ly',sourceMapping=false},
        outputs={output={kind='file',mediaType='application/pdf',path='control.pdf'}}})
      table.insert(graph.targets.main.steps,'control')
      table.insert(graph.targets.main.publish,{step='control',port='output'})
      return graph
    end
    return plugin`;
  const samples = [];
  for (const count of [1, 4]) {
    let host, plan;
    const f = await fixture(t, { "iris.lua": plugin,
      "main.ly": '\\version "2.24.1"\n\\include "generated/include.ily"\n\\score { \\new Staff { \\generatedMusic } }\n',
      "control.ly": '\\version "2.24.1"\n\\score { \\new Staff { d\'1 } }\n',
    }, { projectType: "lilypond" }, {
      tools: require("../src/pipeline/lua").createLuaTools(),
      adapters: [createLuaAdapter({ execute: context => host.transformLua({ approval: host.identity, plan, context }) })],
    });
    host = createLuaCoordinator({ runtime: f.runtime, workspace: f.workspace, runId: uuidv7(), registry: f.registry });
    const descriptor = await host.inspectLua({ approval: host.identity });
    plan = await host.planLua({ approval: host.identity, descriptor, parameters: { family: "lilypond", count } });
    const result = await executePlan({ plan, target: "main", workspace: f.workspace, registry: f.registry,
      gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }) });
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    const rendered = {};
    for (const stepId of ["compile", "control"]) {
      const output = result.artifacts.find(item => item.producerStep === stepId);
      rendered[stepId] = await redPixels(path.join(output.root, output.path), f.workspace.root, stepId, "black");
      assert.ok(rendered[stepId][0].red.length > 0);
    }
    samples.push(rendered);
  }
  assert.notDeepEqual(samples[0].compile, samples[1].compile);
  assert.deepEqual(samples[0].control, samples[1].control);
});

test("native SyncTeX navigates retained renamed PDFs after source removal and rejects changed sidecars", native, async t => {
  const { collectCompilerMapping, navigateCompilerMapping, createNavigationTools } = require("../src/pipeline/navigation");
  const projectId = uuidv7(), runId = uuidv7(), include = "parts/é text.tex";
  let navigation, context;
  const f = await fixture(t, { "main.tex": '\\documentclass{article}\n\\begin{document}\n\\input{parts/é text}\n\\newpage\\input{parts/é text}\n\\end{document}\n',
    [include]: "Included Unicode path.\r\n" }, {}, { tools: createNavigationTools(),
    onArtifacts: async (value, products) => {
      context = value;
      navigation = await collectCompilerMapping({ context, compiled: f.compiled.get(value.step.id), products, projectId, runId });
    },
  });
  const result = await f.run([step("compile", "latex", "main.tex")]);
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.equal(navigation.manifest.status, "ready");
  const source = navigation.manifest.sources.find(file => file.path === include);
  await fs.rm(f.source, { recursive: true });
  await fs.rm(context.inputs.source.root, { recursive: true });
  const options = { navigation, products: result.artifacts, runtime: f.runtime, projectId, runId, enabled: true };
  const forward = await navigateCompilerMapping({ ...options,
    query: { direction: "forward", sourceFileId: source.sourceFileId, line: 1, column: 0, page: 2 } });
  assert.equal(forward.status, "ready", JSON.stringify(forward));
  const match = forward.matches[0];
  assert.equal(match.artifactId, result.artifacts[0].id);
  assert.equal(match.page, 2);
  assert.equal(match.sourceRevisionId, source.sourceRevisionId);
  const inverse = await navigateCompilerMapping({ ...options,
    query: { direction: "inverse", artifactId: match.artifactId, page: 2, x: match.x + 3, y: match.y + match.height / 2 } });
  assert.equal(inverse.status, "ready", JSON.stringify(inverse));
  assert.equal(inverse.matches[0].sourceFileId, source.sourceFileId);
  assert.equal(inverse.matches[0].line, 1);
  const raster = path.join(f.workspace.root, "raster");
  await fs.mkdir(raster);
  const pages = await redPixels(path.join(result.artifacts[0].root, result.artifacts[0].path), raster, "tex", "black");
  const textInk = pages[1].red.filter(([, y]) => y < 300);
  assert.ok(textInk.length > 100);
  assert.equal(textInk.filter(([x, y]) => x < match.x - 1 || x > match.x + match.width + 1 || y < match.y - 1 || y > match.y + match.height + 1).length, 0);
  t.diagnostic(JSON.stringify({ compiler: "contained TeX Live 2022", page: 2, textPixels: textInk.length, rectangle: match }));
  const sidecar = navigation.nativeFiles[0];
  await fs.chmod(path.join(sidecar.root, sidecar.path), 0o600);
  await fs.appendFile(path.join(sidecar.root, sidecar.path), "changed");
  assert.equal((await navigateCompilerMapping({ ...options,
    query: { direction: "forward", sourceFileId: source.sourceFileId, line: 1, column: 0 } })).reason, "malformed-map");
});

for (const mode of ["standard", "transformed", "landscape"]) {
  test(`native LilyPond navigation matches rendered music across books and physical pages (${mode})`, native, async t => {
    const { collectCompilerMapping, navigateCompilerMapping } = require("../src/pipeline/navigation");
    const projectId = uuidv7(), runId = uuidv7(), include = "parts/é air.ly";
    const transform = mode === "transformed" ? `#(let* ((m (resolve-module '(lily framework-ps))) (original (module-ref m 'output-stencils)))
      (module-set! m 'output-stencils (lambda (name stencils header paper formats)
        (original name (map (lambda (s) (ly:stencil-translate (ly:stencil-rotate (ly:stencil-scale s 0.8 0.9) 8 0 0) '(15 . -20))) stencils) header paper formats))))\n` : "";
    let navigation;
    const f = await fixture(t, {
      "main.ly": `\\version "2.24.1"\n${transform}\\include "${include}"\n\\paper { first-page-number = 7 print-page-number = ##t ${mode === "landscape" ? '#(set-paper-size "a4" \'landscape)' : ""} }\n\\book { \\bookOutputSuffix "one" \\score { \\theme } \\pageBreak \\score { \\theme } }\n\\book { \\bookOutputSuffix "two" \\score { \\theme } }\n`,
      [include]: `theme = { \\override NoteHead.color = #red \\override Rest.color = #red c'4^"é😀" <e' g'>4 r4 d'4 }\r\n`,
    }, {}, { onArtifacts: async (context, products) => {
      navigation = await collectCompilerMapping({ context, compiled: f.compiled.get(context.step.id), products, projectId, runId });
    } });
    const result = await f.run([step("music", "lilypond", "main.ly", {}, "collection")]);
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    assert.equal(navigation.manifest.status, "ready", JSON.stringify(navigation.manifest));
    const source = navigation.manifest.sources.find(file => file.path === include), column = source.text.indexOf("d'4");
    const entries = navigation.manifest.entries.filter(entry => entry.sourceFileId === source.sourceFileId);
    assert.ok(entries.some(entry => entry.column === column));
    const product = result.artifacts[0];
    assert.equal(product.files.length, 2);
    const raster = path.join(f.workspace.root, "raster");
    await fs.mkdir(raster);
    let physicalPages = 0;
    for (const file of product.files) {
      const pdf = path.join(product.root, file.path), document = await PDFDocument.load(await fs.readFile(pdf));
      const pages = await redPixels(pdf, raster, file.id);
      for (const page of pages) {
        physicalPages++;
        const pdfPage = document.getPage(page.page - 1), { width, height } = pdfPage.getMediaBox(), rotation = pdfPage.getRotation().angle;
        const pixels = page.red.map(([x, y]) => rotation === 90 ? [y, height - x] : rotation === 270 ? [width - y, x] : [x, y]);
        const rectangles = entries.filter(entry => entry.artifactId === file.id && entry.page === page.page);
        assert.ok(pixels.length > 20);
        const uncovered = pixels.filter(([x, y]) => !rectangles.some(m => x >= m.x - 2 && x <= m.x + m.width + 2 && y >= m.y - 2 && y <= m.y + m.height + 2));
        assert.equal(uncovered.length, 0, JSON.stringify({ mode, uncovered: uncovered.slice(0, 10), rectangles }));
        t.diagnostic(JSON.stringify({ compiler: "contained LilyPond 2.24.1", mode, path: file.path, page: page.page, width, height, rotation, pixels: pixels.length }));
      }
    }
    assert.equal(physicalPages, 3);
    const options = { navigation, products: result.artifacts, runtime: f.runtime, projectId, runId, enabled: true };
    const forward = await navigateCompilerMapping({ ...options, query: { direction: "forward", sourceFileId: source.sourceFileId, line: 1, column, page: 2 } });
    assert.equal(forward.status, "ready");
    const match = forward.matches[0];
    assert.equal(match.page, 2);
    const inverse = await navigateCompilerMapping({ ...options, query: { direction: "inverse", artifactId: match.artifactId,
      page: match.page, x: match.x + match.width / 2, y: match.y + match.height / 2 } });
    assert.equal(inverse.status, "ready");
    assert.equal(inverse.matches[0].sourceFileId, source.sourceFileId);
    assert.equal(inverse.matches[0].sourceRevisionId, source.sourceRevisionId);
  });
}

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

test("a mixed run navigates both compiler families through one shared-source manifest", native, async t => {
  const { createRunMappingCollector, navigateCompilerMapping, createNavigationTools } = require("../src/pipeline/navigation");
  const projectId = uuidv7(), runId = uuidv7(), collector = createRunMappingCollector({ projectId, runId });
  const f = await fixture(t, {
    "main.tex": "\\documentclass{article}\n\\begin{document}\\input{parts/text}\\end{document}\n",
    "parts/text.tex": "Mixed run text.\n",
    "main.ly": '\\version "2.24.1"\n\\include "parts/music.ily"\n\\score { \\melody }\n',
    "parts/music.ily": "melody = { c'1 d'1 }\n",
  }, {}, { tools: createNavigationTools(), onArtifacts: async (context, products) => {
    await collector.collect({ context, compiled: f.compiled.get(context.step.id), products });
  } });
  const result = await f.run([step("text", "latex", "main.tex"), step("music", "lilypond", "main.ly")]);
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  const navigation = collector.assemble(result.artifacts);
  assert.equal(navigation.manifest.status, "ready", JSON.stringify(navigation.manifest));
  assert.equal(navigation.manifest.sources.length, 4);
  assert.deepEqual(navigation.manifest.artifacts.map(a => a.backend), ["latex", "lilypond"]);
  const options = { navigation, products: result.artifacts, projectId, runId, enabled: true, runtime: f.runtime };
  for (const [index, name, column] of [[0, "parts/text.tex", 0], [1, "parts/music.ily", 11]]) {
    const source = navigation.manifest.sources.find(s => s.path === name);
    const forward = await navigateCompilerMapping({ ...options, query: { direction: "forward", sourceFileId: source.sourceFileId, line: 1, column } });
    assert.equal(forward.status, "ready", JSON.stringify(forward));
    const m = forward.matches[0];
    assert.equal(m.artifactId, result.artifacts[index].id);
    const inverse = await navigateCompilerMapping({ ...options, query: { direction: "inverse", artifactId: m.artifactId,
      page: m.page, x: m.x + Math.min(3, m.width / 2), y: m.y + m.height / 2 } });
    assert.equal(inverse.status, "ready", JSON.stringify(inverse));
    assert.equal(inverse.matches[0].sourceFileId, source.sourceFileId);
  }
});

test("two compiler steps with the same native PDF name retain distinct query identities", native, async t => {
  const { createRunMappingCollector, navigateCompilerMapping, createNavigationTools } = require("../src/pipeline/navigation");
  const projectId = uuidv7(), runId = uuidv7(), collector = createRunMappingCollector({ projectId, runId });
  const f = await fixture(t, { "main.tex": "\\documentclass{article}\n\\begin{document}\nTwo independently identified outputs.\n\\end{document}\n" }, {}, {
    tools: createNavigationTools(), onArtifacts: (context, products) => collector.collect({ context, products, compiled: f.compiled.get(context.step.id) }),
  });
  const result = await f.run([step("first", "latex", "main.tex"), step("second", "latex", "main.tex")]);
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  const navigation = collector.assemble(result.artifacts);
  assert.equal(navigation.manifest.sources.length, 1);
  assert.equal(navigation.nativeFiles.length, 2);
  assert.equal(new Set(navigation.nativeFiles.map(file => file.path)).size, 1);
  assert.equal(new Set(navigation.nativeFiles.map(file => file.name)).size, 2);
  const query = { direction: "forward", sourceFileId: navigation.manifest.sources[0].sourceFileId, line: 3, column: 0,
    artifactId: result.artifacts[1].id, page: 1 };
  const forward = await navigateCompilerMapping({ navigation, products: result.artifacts, projectId, runId, enabled: true, runtime: f.runtime, query });
  assert.equal(forward.status, "ready", JSON.stringify(forward));
  assert.equal(forward.matches[0].artifactId, result.artifacts[1].id);
  assert.deepEqual(new Set(forward.matches.map(match => match.artifactId)), new Set(result.artifacts.map(artifact => artifact.id)));
});

test("compiler collections preserve independently named LilyPond books and private navigation sidecars", native, async t => {
  const f = await fixture(t, { "main.ly": '\\version "2.24.1"\n\\book { \\bookOutputName "first" \\score { { c\'1 } } }\n\\book { \\bookOutputName "second" \\score { { d\'1 } } }\n' });
  const result = await f.run([step("books", "lilypond", "main.ly", {}, "collection")]);
  assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
  assert.deepEqual(result.artifacts[0].files.map(file => file.path), ["books/documents/first.pdf", "books/documents/second.pdf"]);
  assert.ok((await fs.readdir(f.compiled.get("books").outputDir)).some(file => file.endsWith(".iris-map.tsv")));
});

test("failed native compilation retains source diagnostics and blocks its dependent step", native, async t => {
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
  test(`native ${family} diagnostics identify the generating artifact without inventing a project file`, native, async t => {
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
  test(`native ${family} maps bind final artifact hashes and recorded source revisions`, native, async t => {
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
  test(`native LilyPond retains ${format} output selection`, native, async t => {
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
  test(`native ${engine} preserves a custom multipass profile`, native, async t => {
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
  test(`native ${mode} profile retains auxiliary output and selects final-pass diagnostics`, native, async t => {
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

test("cancelling an active native compiler drains it and blocks further passes", native, async t => {
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
  test(`native ${engine} loads a byte-exact project font through a nested source include`, native, async t => {
    const f = await fixture(t, async () => {
        const { stdout } = await promisify(execFile)("fc-match", ["-f", "%{file}", "serif"], { timeout: 5000 });
        assert.ok(path.isAbsolute(stdout));
        return { "fonts/Project.ttf": await fs.readFile(stdout),
          "main.tex": "\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Project.ttf}[Path=fonts/]\n\\begin{document}\\input{parts/text}\\end{document}\n",
          "parts/text.tex": "Project font: café, music.\n" };
    });
    const result = await f.run([step("font", "latex", "main.tex", { engine })]);
    assert.equal(result.state, "succeeded", JSON.stringify(result.steps));
    const sourceBytes = await fs.readFile(path.join(f.source, "fonts/Project.ttf"));
    assert.deepEqual(await fs.readFile(path.join(f.workspace.snapshot.root, "fonts/Project.ttf")), sourceBytes);
    assert.equal((await PDFDocument.load(await fs.readFile(path.join(result.artifacts[0].root, result.artifacts[0].path)))).getPageCount(), 1);
  });
}
