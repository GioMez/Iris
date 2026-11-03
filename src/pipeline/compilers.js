const fs = require("node:fs/promises");
const { readFileSync, constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { logicalPath, fail, SNAPSHOT_TYPE } = require("./contracts");
const { materializeOverlay } = require("./workspaces");
const { isPrivateBuildFile } = require("../builds");

const ENGINES = ["pdflatex", "xelatex", "lualatex", "xetex"];
const TYPES = { pdf: "application/pdf", png: "image/png", svg: "image/svg+xml", ps: "application/postscript", eps: "application/postscript" };
const collector = readFileSync(path.join(__dirname, "../lilypond/source-mapping.ily"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Paths belong to the operator's installed toolchain. Project options select registered
// tool IDs; they cannot supply executables or environment values.
function createCompilerTools({ texBinPath = "", lilypondBinPath = "", timeoutMs = 120000 } = {}) {
  const command = (bin, id) => bin ? path.resolve(bin, id) : id;
  const env = bin => ({ PATH: bin ? `${path.resolve(bin)}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH || "" });
  return [
    { id: "fc-cache", path: "fc-cache", timeoutMs: Math.min(timeoutMs, 10000) },
    ...[...ENGINES, "bibtex", "biber", "makeindex"].map(id => ({ id, path: command(texBinPath, id), timeoutMs, env: env(texBinPath) })),
    { id: "lilypond", path: command(lilypondBinPath, "lilypond"), timeoutMs, env: env(lilypondBinPath) },
  ];
}

function createCompilerAdapters(services) {
  const { runtime, runId, normalizeCompileProfile, runCompilePipeline, parseCompileArguments, kpathseaSearchPath, onCompiled } = services;
  // Include the owning shared compiler helpers and collector in adapter identity.
  // Executable identity remains a separate run-policy responsibility.
  const implementationHash = hash(Buffer.concat([readFileSync(__filename), collector,
    readFileSync(path.join(__dirname, "../server.js")), readFileSync(path.join(__dirname, "../compile-diagnostics.js"))]));
  return ["latex", "lilypond"].map(family => ({
    id: `iris.${family}`, version: "1.0.0", implementationHash, capabilities: [`compile.${family}`],
    optionsSchema: { type: "object", required: ["main"], properties: {
      main: { type: "string", minLength: 1, maxLength: 500 },
      ...(family === "latex" ? {
        engine: { type: "string", enum: ENGINES },
        profile: { type: "object", properties: {
          mode: { type: "string", enum: ["quick", "bibtex", "biber", "index", "custom"] },
          steps: { type: "array", maxItems: 12, items: { type: "object", required: ["tool", "args"], properties: {
            tool: { type: "string", enum: ["[engine]", ...ENGINES, "bibtex", "biber", "makeindex"] },
            args: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
          } } },
        } },
      } : { format: { type: "string", enum: Object.keys(TYPES) }, args: { type: "string", maxLength: 2000 } }),
      sourceMapping: { type: "boolean" },
    } },
    inputs: { source: { kinds: ["collection"], mediaTypes: [SNAPSHOT_TYPE], required: true } },
    additionalInputs: { kinds: ["file", "collection"], mediaTypes: ["*/*"] },
    outputs: {
      output: { kinds: ["file", "collection"], mediaTypes: family === "latex" ? [TYPES.pdf] : [...new Set(Object.values(TYPES))], required: true },
      files: { kinds: ["collection"], mediaTypes: ["application/vnd.iris.build-files"] },
    },
    async execute(context) {
      const { options, signal } = context, settings = context.inputs.source.settings || {};
      const main = logicalPath(options.main, "PIPELINE_COMPILE_SOURCE_INVALID");
      const engine = family === "lilypond" ? "lilypond" : options.engine || (ENGINES.includes(settings.engine) ? settings.engine : "pdflatex");
      const format = family === "latex" ? "pdf" : options.format || settings.lilypondFormat || "pdf";
      const mapping = options.sourceMapping ?? settings.sourceMapping ?? true;
      const output = context.step.outputs.output;
      if (output.mediaType !== TYPES[format]) fail("PIPELINE_COMPILE_FORMAT_INVALID", "Compiler output does not match its declared media type");
      let profile;
      try {
        profile = normalizeCompileProfile(options.profile || settings.compileProfile, engine, main, family,
          family === "lilypond" ? parseCompileArguments(options.args ?? settings.lilypondArgs ?? "") : [], format, mapping);
      } catch (error) { if (error.errorCode) error.code = error.errorCode; throw error; }
      const tools = profile.steps.map(step => runtime.resolveTool(step.tool));
      const input = await materializeOverlay(context, Object.keys(context.inputs), { signal });
      if (!input.files.some(file => file.path === main)) fail("PIPELINE_COMPILE_SOURCE_INVALID", "Compiler main source is absent from its declared inputs");
      for (const entry of [...input.files.map(file => file.path), ...input.directories]) {
        if (["output", ".iris"].includes(entry.split("/", 1)[0].toLowerCase())) fail("PIPELINE_INPUT_COLLISION", "Compiler input overlaps reserved scratch paths");
      }
      let staged = input;
      if (family === "lilypond" && mapping && format === "pdf") {
        const relative = ".iris/source-mapping.ily";
        await fs.mkdir(path.join(input.root, ".iris"));
        await fs.writeFile(path.join(input.root, relative), collector, { flag: "wx", mode: 0o400 });
        staged = { ...input, files: [...input.files, { path: relative, size: collector.length, contentHash: hash(collector) }],
          directories: [...input.directories, ".iris"] };
      }
      signal?.throwIfAborted();
      const worker = await runtime.createWorkspace({ runId, stepId: context.step.id, input: staged, signal, deadlineAt: services.deadlineAt });
      try {
        for (const entry of await fs.readdir(worker.inputRoot)) {
          signal?.throwIfAborted();
          await fs.symlink(path.join(worker.inputRoot, entry), path.join(worker.workRoot, entry));
        }
        await fs.mkdir(path.join(worker.workRoot, "output"));
        const cache = path.join(worker.tempRoot, "texmf-var"), fontsPath = path.join(worker.inputRoot, "fonts");
        await fs.mkdir(cache);
        const search = kpathseaSearchPath(worker.workRoot, path.join(worker.workRoot, "output"));
        const env = { TEXMFVAR: cache, TEXMFCACHE: cache, OSFONTDIR: fontsPath,
          TEXINPUTS: search, LUAINPUTS: search, BIBINPUTS: search, BSTINPUTS: search,
          XDG_CACHE_HOME: worker.tempRoot, XDG_DATA_HOME: worker.workRoot, max_print_line: "1000", openin_any: "p", openout_any: "p" };
        if (family === "lilypond") {
          // LilyPond changes directory for --output; use the checked input root.
          const args = profile.steps[0].args;
          args[args.length - 1] = path.join(worker.inputRoot, main);
          if (mapping && format === "pdf") args.splice(args.length - 1, 0, `-dinclude-settings=${path.join(worker.inputRoot, ".iris/source-mapping.ily")}`);
        }
        signal?.throwIfAborted();
        let preLog = "";
        if (input.files.some(file => file.path.startsWith("fonts/"))) {
          try {
            const fonts = await runtime.runTool({ workspace: worker, tool: runtime.resolveTool("fc-cache"), args: ["-f", fontsPath], env, signal });
            preLog = fonts.log;
            if (fonts.code !== 0) preLog += "\nwarning: Project font cache refresh failed.\n";
          } catch (error) {
            if (error.code !== "PIPELINE_RUNTIME_UNAVAILABLE") throw error;
            preLog += "\nwarning: Project font cache refresh is unavailable.\n";
          }
          signal?.throwIfAborted();
        }
        const result = await runCompilePipeline({ profile, cwd: worker.workRoot, preLog, signal,
          runStep: ({ step }) => runtime.runTool({ workspace: worker, tool: runtime.resolveTool(step.tool), args: step.args, env, signal,
            onOutput: services.onOutput ? chunk => services.onOutput(context, chunk) : undefined }),
        });
        const sources = new Map(input.files.map(file => [file.path, file]));
        result.diagnostics = result.diagnostics.map(item => {
          const file = item.file?.startsWith(worker.inputRoot + path.sep) ? item.file.slice(worker.inputRoot.length + 1) : item.file;
          const source = sources.get(file);
          const location = !source ? {} : source.producerStep ? {
            generatedSource: { artifactId: source.id, producerStep: source.producerStep, outputPort: source.outputPort,
              path: source.path, contentHash: source.contentHash },
          } : { sourceFileId: source.id, sourceRevisionId: source.sourceRevisionId, sourceContentHash: source.contentHash };
          return { ...item, file, stepId: context.step.id, ...location };
        });
        const metadata = { ...result, stepId: context.step.id, family, engine, format, main, mappingEnabled: mapping,
          snapshotRoot: family === "latex" ? worker.workRoot : worker.inputRoot,
          tools: tools.map(tool => ({ id: tool.id, path: tool.path, env: tool.env })), outputDir: null, outputs: [] };
        if (result.code !== 0 || result.signal || result.timedOut) {
          await onCompiled?.(context, metadata);
          return { diagnostics: result.diagnostics, errorCode: "PIPELINE_COMPILE_FAILED" };
        }
        const exported = await runtime.exportWorkspace({ workspace: worker, directory: "output", destination: path.join(context.workDir, "compiled"), signal });
        metadata.outputDir = path.join(exported.root, "output");
        const documents = exported.files.filter(file => file.path.startsWith("output/") && file.path.endsWith(`.${format}`) && !isPrivateBuildFile(file.path));
        const expected = `output/${path.posix.basename(main).replace(/\.[^.]+$/, "")}.${format}`;
        documents.sort((a, b) => a.path === expected ? -1 : b.path === expected ? 1 : a.path.localeCompare(b.path, "en", { numeric: true }));
        if (!documents.length) {
          await onCompiled?.(context, metadata);
          return { diagnostics: result.diagnostics, errorCode: "PIPELINE_COMPILE_OUTPUT_MISSING" };
        }
        if (output.kind === "file") documents.splice(1);
        else await fs.mkdir(path.join(context.outputDir, output.path), { recursive: true });
        async function copy(file, relative, outputPort) {
          signal?.throwIfAborted();
          const target = path.join(context.outputDir, relative);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(exported.root, file.path), target, constants.COPYFILE_EXCL);
          metadata.outputs.push({ outputPort, path: relative, compiledPath: file.path.slice(7), size: file.size, contentHash: file.contentHash });
        }
        for (const file of documents) await copy(file, output.kind === "file" ? output.path : `${output.path}/${file.path.slice(7)}`, "output");
        const files = context.step.outputs.files;
        if (files) {
          await fs.mkdir(path.join(context.outputDir, files.path), { recursive: true });
          for (const file of exported.files) {
            if (file.path.startsWith("output/") && !isPrivateBuildFile(file.path)) await copy(file, `${files.path}/${file.path.slice(7)}`, "files");
          }
        }
        await onCompiled?.(context, metadata);
        return { diagnostics: result.diagnostics };
      } finally { await runtime.disposeWorkspace(worker); }
    },
  }));
}

module.exports = { createCompilerTools, createCompilerAdapters };
