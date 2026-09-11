const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.IRIS_SECRET = "test-only-secret-with-sufficient-entropy";
process.env.DB_PASSWORD = "test-only-database-password";

const {
  fileKindForPath,
  inferProjectType,
  findCompileFile,
  normalizeCompileProfile,
  sanitizeCompileProfileForStorage,
  parseCompileArguments,
  sanitizeLilypondArgsForStorage,
  sanitizeMainPathForStorage,
  normalizeLilypondFormat,
  reconcileProjectFonts,
  safeProjectSourcePath,
  validateProjectSourceTree,
  syncNodesWithFilesystem,
  resolveProjectFile,
  readCompileArtifacts,
  runCompilePipeline,
} = require("../src/server");

function project(files, projectType) {
  return {
    ...(projectType ? { projectType } : {}),
    project: {
      nodes: files.map((file, index) => ({
        type: "file",
        id: `f${index}`,
        name: file.path,
        path: file.path,
        kind: fileKindForPath(file.path),
        content: file.content || "",
      })),
    },
  };
}

test("recognizes legacy LilyPond projects from .ly sources", () => {
  assert.equal(inferProjectType(project([{ path: "main.ly" }])), "lilypond");
  assert.equal(inferProjectType(project([{ path: "main.tex" }, { path: "music.ly" }])), "latex");
  assert.equal(inferProjectType(project([{ path: "main.ly" }], "latex")), "latex");
});

test("selects a LilyPond score as the main source", () => {
  const data = project([
    { path: "include.ly", content: "theme = { c4 d }" },
    { path: "score.ly", content: "\\score { \\relative c' { c1 } }" },
  ]);
  assert.equal(findCompileFile(data, undefined, "lilypond").path, "score.ly");
  assert.throws(
    () => findCompileFile(data, undefined, "latex"),
    (error) => error.errorCode === "COMPILE_NO_SOURCE" && error.params.extension === ".tex"
  );
});

test("the configured main file outranks source detection", () => {
  const data = project([
    { path: "main.tex", content: "\\documentclass{article}\\begin{document}a\\end{document}" },
    { path: "poster.tex", content: "\\documentclass{article}\\begin{document}b\\end{document}" },
  ]);
  // Detection would settle on main.tex; naming poster.tex must win, and a
  // per-request override must win over both.
  assert.equal(findCompileFile(data, undefined, "latex").path, "main.tex");
  assert.equal(findCompileFile(data, "poster.tex", "latex").path, "poster.tex");
});

test("a main file that no longer exists falls back to detection", () => {
  const data = project([
    { path: "main.tex", content: "\\documentclass{article}\\begin{document}a\\end{document}" },
  ]);
  assert.equal(findCompileFile(data, "renamed.tex", "latex").path, "main.tex");
});

test("a stored main file stays inside the project sources", () => {
  assert.equal(sanitizeMainPathForStorage("chapters/intro.tex"), "chapters/intro.tex");
  assert.equal(sanitizeMainPathForStorage("  "), "");
  assert.equal(sanitizeMainPathForStorage(null), "");
  assert.equal(sanitizeMainPathForStorage("./chapters/../main.tex"), "main.tex");
  // An absolute path is clamped into the project rather than refused, the same
  // way every other source path is treated.
  assert.equal(sanitizeMainPathForStorage("/etc/passwd"), "etc/passwd");
  for (const escape of ["../secrets.tex", "output/main.tex", ".iris/main.tex"]) {
    assert.throws(
      () => sanitizeMainPathForStorage(escape),
      (error) => error.errorCode === "PROJECT_PATH_INVALID",
      `expected ${escape} to be refused`
    );
  }
});

test("builds a constrained LilyPond PDF pipeline", () => {
  const additionalArgs = parseCompileArguments('--loglevel=WARNING -I "include musicali" --output=/tmp/escape');
  const profile = normalizeCompileProfile(
    { mode: "custom", steps: [{ tool: "[engine]", args: ["--output=/tmp/escape", "-o", "/tmp/other", "[main]"] }] },
    "lilypond",
    "scores/main.ly",
    "lilypond",
    additionalArgs
  );
  assert.deepEqual(profile.steps, [{
    tool: "lilypond",
    args: ["--pdf", "--output=output/main", "--loglevel=WARNING", "-I", "include musicali", "scores/main.ly"],
  }]);
});

test("parses LilyPond parameter strings without invoking a shell", () => {
  assert.deepEqual(
    parseCompileArguments('--loglevel=WARNING -I "include musicali" -dno-point-and-click'),
    ["--loglevel=WARNING", "-I", "include musicali", "-dno-point-and-click"]
  );
  assert.throws(() => parseCompileArguments('-I "unterminated'), (error) => error.errorCode === "LILYPOND_ARGUMENTS_UNTERMINATED");
  assert.equal(sanitizeLilypondArgsForStorage('-I "bozza'), '-I "bozza');
});

test("selects and constrains every supported LilyPond output format", () => {
  for (const format of ["pdf", "png", "svg", "ps", "eps"]) assert.equal(normalizeLilypondFormat(format), format);
  assert.throws(() => normalizeLilypondFormat("jpg"), (error) => error.errorCode === "LILYPOND_FORMAT_UNSUPPORTED");
  const profile = normalizeCompileProfile(
    { mode: "quick" },
    "lilypond",
    "main.ly",
    "lilypond",
    ["--pdf", "-fsvg", "-E", "-dresolution=180"],
    "png"
  );
  assert.deepEqual(profile.steps[0].args, [
    "--png",
    "--output=output/main",
    "-dresolution=180",
    "main.ly",
  ]);
});

test("collects all numbered artifacts for the selected format", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-artifacts-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "main.png"), "page one");
  await fs.writeFile(path.join(root, "main-page2.png"), "page two");
  await fs.writeFile(path.join(root, "main2.png"), "unrelated");
  await fs.writeFile(path.join(root, "main.pdf"), "other format");
  const artifacts = await readCompileArtifacts(root, "main", "png");
  assert.deepEqual(artifacts.map((artifact) => artifact.name), ["output/main.png", "output/main-page2.png"]);
  assert.equal(Buffer.from(artifacts[1].base64, "base64").toString(), "page two");
});

test("keeps versioned build storage out of the editor source tree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-output-tree-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "output", "build-id"), { recursive: true });
  await fs.writeFile(path.join(root, "output", "build-id", "main.pdf"), "pdf");
  await fs.writeFile(path.join(root, "main.tex"), "source");
  const data = { project: { nodes: [{ type: "file", id: "main", name: "main.tex", path: "main.tex", content: "" }] } };
  await syncNodesWithFilesystem(root, data);
  assert.deepEqual(data.project.nodes.map((node) => node.name), ["main.tex"]);
});

test("reserves the output namespace for immutable build storage", () => {
  assert.equal(safeProjectSourcePath("sources/output.tex"), "sources/output.tex");
  for (const filePath of ["output", "Output/main.pdf", "output/build-id/main.midi", ".iris/project.json"]) {
    assert.throws(
      () => safeProjectSourcePath(filePath),
      (error) => error.errorCode === "PROJECT_PATH_INVALID" && error.status === 400
    );
  }
  assert.throws(
    () => validateProjectSourceTree({
      project: { nodes: [{ type: "file", name: "injected.pdf", path: "output/build-id/injected.pdf" }] },
    }),
    (error) => error.errorCode === "PROJECT_PATH_INVALID"
  );
  assert.throws(
    () => validateProjectSourceTree({
      project: { nodes: [{ type: "file", name: "injected.pdf", path: "output/build-id/injected.pdf", readOnly: true }] },
    }),
    (error) => error.errorCode === "PROJECT_PATH_INVALID"
  );
  assert.doesNotThrow(() => validateProjectSourceTree({
    project: { nodes: [{ type: "folder", name: "output", generated: true, readOnly: true, children: [] }] },
  }));
});

test("resolves downloadable files only inside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-download-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".iris"));
  await fs.writeFile(path.join(root, "main.ly"), "{ c1 }");
  await fs.writeFile(path.join(root, ".iris", "project.json"), "{}");
  const file = await resolveProjectFile(root, "main.ly");
  assert.equal(file.name, "main.ly");
  assert.equal(file.mimeType, "text/plain; charset=utf-8");
  await assert.rejects(() => resolveProjectFile(root, ".iris/project.json"), (error) => error.errorCode === "PROJECT_PATH_INVALID");
  await assert.rejects(() => resolveProjectFile(root, "missing.ly"), (error) => error.errorCode === "PROJECT_FILE_NOT_FOUND");

  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  await fs.writeFile(outside, "outside");
  t.after(() => fs.rm(outside, { force: true }));
  await fs.symlink(outside, path.join(root, "outside.txt"));
  await assert.rejects(() => resolveProjectFile(root, "outside.txt"), (error) => error.errorCode === "PROJECT_FILE_NOT_FOUND");
});

test("font settings follow the files currently present below fonts", () => {
  const data = {
    project: {
      nodes: [{
        type: "folder",
        name: "fonts",
        children: [{ type: "file", name: "Current.otf", path: "fonts/Current.otf", data: "data:font/otf;base64,AQID" }],
      }],
    },
    fonts: [
      { family: "ExistingFamily", name: "Current.otf", path: "fonts/Current.otf", data: "current" },
      { family: "DeletedFamily", name: "Deleted.otf", path: "fonts/Deleted.otf", data: "stale" },
    ],
  };
  reconcileProjectFonts(data);
  assert.deepEqual(data.fonts.map((font) => font.path), ["fonts/Current.otf"]);
  assert.equal(data.fonts[0].family, "ExistingFamily");

  data.project.nodes[0].children = [{ type: "file", name: "Added Font.ttf", path: "fonts/Added Font.ttf", data: "new" }];
  reconcileProjectFonts(data);
  assert.deepEqual(data.fonts, [{
    family: "IrisUser_Added_Font",
    name: "Added Font.ttf",
    path: "fonts/Added Font.ttf",
    data: "new",
  }]);

  data.project.nodes[0].children = [];
  reconcileProjectFonts(data);
  assert.deepEqual(data.fonts, []);
});

test("always reduces LilyPond compilation to one managed step", () => {
  const profile = normalizeCompileProfile(
    { mode: "custom", steps: [{ tool: "pdflatex", args: ["unsafe.tex"] }] },
    "lilypond",
    "main.ly",
    "lilypond"
  );
  assert.equal(profile.mode, "quick");
  assert.deepEqual(profile.steps, [{ tool: "lilypond", args: ["--pdf", "--output=output/main", "main.ly"] }]);
  assert.deepEqual(sanitizeCompileProfileForStorage({ mode: "bibtex" }, "lilypond"), { mode: "quick" });
  assert.deepEqual(sanitizeCompileProfileForStorage({ mode: "custom", steps: [{ tool: "lilypond", args: ["[main]"] }] }, "lilypond"), { mode: "quick" });
});

test("keeps the existing hardened LaTeX invocation", () => {
  const profile = normalizeCompileProfile({ mode: "quick" }, "xelatex", "main.tex", "latex");
  assert.equal(profile.steps[0].tool, "xelatex");
  assert.deepEqual(profile.steps[0].args.slice(0, 5), [
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    "-no-shell-escape",
    "-output-directory=output",
  ]);
  assert.equal(profile.steps[0].args.at(-1), "main.tex");
});

test("LaTeX custom pipelines reject shell escape switches, aliases and abbreviations", () => {
  for (const engine of ["pdflatex", "xelatex", "lualatex", "xetex"]) {
    for (const option of [
      "-shell-escape", "--shell-escape", "-shell-escape=true",
      "-shell-restricted", "--shell-restricted", "-enable-write18", "--enable-write18",
      "-shell-e", "--shell-e", "-shell-r",
    ]) {
      for (const args of [[option, "[main]"], ["[main]", option]]) {
        const stored = sanitizeCompileProfileForStorage({
          mode: "custom", steps: [{ tool: "[engine]", args }],
        });
        assert.throws(
          () => normalizeCompileProfile(stored, engine, "main.tex"),
          (error) => error.errorCode === "COMPILE_ARGUMENT_INVALID" && error.status === 400,
          `${engine}: ${args.join(" ")}`
        );
      }
    }
  }
});

test("LaTeX custom pipelines reject configuration and alternate execution modes", () => {
  for (const tool of ["pdflatex", "xelatex", "lualatex", "xetex"]) {
    for (const args of [
      ["--cnf-line=shell_escape=t", "[main]"],
      ["-cnf-line", "openout_any=a", "[main]"],
      ["--lua=bootstrap.lua", "[main]"],
      ["--luaonly", "bootstrap.lua"],
      ["--luaconly", "bootstrap.lua"],
      ["--ini", "[main]"],
      ["--fmt=custom", "[main]"],
      ["--progname=custom", "[main]"],
      ["--ipc-start", "[main]"],
      ["--socket", "[main]"],
      ["--unknown-option", "[main]"],
    ]) {
      assert.throws(
        () => normalizeCompileProfile({ mode: "custom", steps: [{ tool, args }] }, "pdflatex", "main.tex"),
        (error) => error.errorCode === "COMPILE_ARGUMENT_INVALID" && error.status === 400,
        `${tool}: ${args.join(" ")}`
      );
    }
  }
});

test("LaTeX custom pipelines cannot override managed output and interaction options", () => {
  for (const args of [
    ["-output-directory=/tmp/escape", "[main]"],
    ["--output-directory=/tmp/escape", "[main]"],
    ["-output-directory", "/tmp/escape", "[main]"],
    ["--output-dir=/tmp/escape", "[main]"],
    ["--jobname=/tmp/escape", "[main]"],
    ["--interaction=errorstopmode", "[main]"],
    ["--no-file-line-error", "[main]"],
  ]) {
    assert.throws(
      () => normalizeCompileProfile({ mode: "custom", steps: [{ tool: "[engine]", args }] }, "pdflatex", "main.tex"),
      (error) => error.errorCode === "COMPILE_ARGUMENT_INVALID" && error.status === 400,
      args.join(" ")
    );
  }
});

test("LaTeX steps accept one project source rather than inline commands or format selectors", () => {
  for (const args of [
    [], ["--recorder"], ["[main]", "other.tex"], ["&custom", "[main]"],
    ["\\input{main.tex}"], ["[main]", "\\end"], [" main.tex"],
    ["/tmp/main.tex"], ["C:/main.tex"], ["../main.tex"],
    ["main.tex\n\\end"], ['"main.tex"'], ["|command"],
    ["main.tex^^5cerrorstopmode"], ["main.tex^^^^005cerrorstopmode"],
  ]) {
    assert.throws(
      () => normalizeCompileProfile({ mode: "custom", steps: [{ tool: "[engine]", args }] }, "pdflatex", "main.tex"),
      (error) => error.status === 400,
      JSON.stringify(args)
    );
  }
  assert.throws(
    () => normalizeCompileProfile({ mode: "quick" }, "pdflatex", "&custom.tex"),
    (error) => error.status === 400
  );
});

test("LaTeX custom pipelines retain safe options before the source operand", () => {
  const stored = sanitizeCompileProfileForStorage({ mode: "custom", steps: [{
    tool: "[engine]",
    args: ["[main]", "--synctex=-1", "-recorder", "-draftmode", "-8bit", "--no-shell-escape"],
  }] });
  const profile = normalizeCompileProfile(stored, "pdflatex", "chapters/part one.tex");
  assert.deepEqual(profile.steps, [{ tool: "pdflatex", args: [
    "-interaction=nonstopmode", "-halt-on-error", "-file-line-error",
    "-no-shell-escape", "-output-directory=output",
    "--synctex=-1", "-recorder", "-draftmode", "-8bit", "--no-shell-escape",
    "chapters/part one.tex",
  ] }]);
});

test("LaTeX source operands preserve valid relative paths", () => {
  for (const source of ["./main.tex", "chapters/../main.tex"]) {
    const profile = normalizeCompileProfile({
      mode: "custom", steps: [{ tool: "[engine]", args: [source] }],
    }, "pdflatex", "main.tex");
    assert.equal(profile.steps[0].args.at(-1), source);
  }
});

test("LaTeX presets retain their bibliography and index steps", () => {
  const expected = {
    quick: [],
    bibtex: [{ tool: "bibtex", args: ["output/main"] }],
    biber: [{ tool: "biber", args: ["--input-directory=output", "--output-directory=output", "main"] }],
    index: [{ tool: "makeindex", args: ["-o", "output/main.ind", "output/main.idx"] }],
  };
  for (const engine of ["pdflatex", "xelatex", "lualatex", "xetex"]) {
    for (const [mode, auxiliarySteps] of Object.entries(expected)) {
      const profile = normalizeCompileProfile({ mode }, engine, "main.tex");
      assert.deepEqual(profile.steps.filter((step) => step.tool !== engine), auxiliarySteps);
      for (const step of profile.steps.filter((step) => step.tool === engine)) {
        assert.deepEqual(step.args, [
          "-interaction=nonstopmode", "-halt-on-error", "-file-line-error",
          "-no-shell-escape", "-output-directory=output", "main.tex",
        ]);
      }
    }
  }
});

test("invokes LilyPond with project-local XDG data and reads its PDF", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-lilypond-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "project");
  await fs.mkdir(bin);
  await fs.mkdir(path.join(cwd, "output"), { recursive: true });
  await fs.writeFile(path.join(cwd, "main.ly"), "\\score { { c1 } }", "utf8");
  const executable = path.join(bin, "lilypond");
  await fs.writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const output = process.argv.find((arg) => arg.startsWith("--output=")).slice(9);
if (fs.realpathSync(process.env.XDG_DATA_HOME) !== process.cwd()) process.exit(3);
fs.writeFileSync(output + ".pdf", "%PDF-1.4 fake");
`, { mode: 0o755 });

  const profile = normalizeCompileProfile({ mode: "quick" }, "lilypond", "main.ly", "lilypond");
  const result = await runCompilePipeline({ profile, binPath: bin, cwd, fontDir: "", texmfVar: "", preLog: "" });
  assert.equal(result.code, 0);
  assert.match(result.log, /--pdf --output=output\/main main\.ly/);
  assert.equal(await fs.readFile(path.join(cwd, "output", "main.pdf"), "utf8"), "%PDF-1.4 fake");
});

async function multipassFixture(t, observations) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "iris-multipass-test-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const binPath = path.join(cwd, "bin");
  await fs.mkdir(binPath);
  await fs.mkdir(path.join(cwd, "output"));
  for (const tool of ["pdflatex", "xelatex", "lualatex", "xetex", "bibtex", "biber"]) {
    await fs.writeFile(path.join(binPath, tool), `#!${process.execPath}
const fs = require("node:fs");
const index = Number(fs.existsSync("step-count") ? fs.readFileSync("step-count", "utf8") : 0);
fs.writeFileSync("step-count", String(index + 1));
const observation = ${JSON.stringify(observations)}[index];
if (!observation) throw new Error("Unexpected compile step");
console.log(observation.log || "");
if (observation.flood) console.log("x".repeat(2 * 1024 * 1024));
if (observation.signal) process.kill(process.pid, observation.signal);
process.exitCode = observation.code || 0;
`, { mode: 0o755 });
  }
  return { cwd, binPath, fontDir: "", texmfVar: "", preLog: "" };
}

for (const engine of ["pdflatex", "xelatex", "lualatex", "xetex"]) {
  for (const mode of ["bibtex", "biber"]) {
    for (const [truncated, unresolved] of [[false, false], [false, true], [true, false], [true, true]]) {
      test(`${engine}/${mode} actual multipass with ${truncated ? "truncated" : "complete"} first capture selects ${unresolved ? "final included-source warnings" : "a clean final pass"} without losing trace`, async (t) => {
        const first = Array.from({ length: 100 }, (_, i) => `LaTeX Warning: Citation 'transient-${i}' undefined on input line 7.`).join("\n");
        const final = unresolved ? "(./main.tex\n(./chapters/intro.tex\nLaTeX Warning: Citation 'missing' undefined on input line 9.\n)\nPackage hyperref Warning: Token not allowed on input line 12.\n)" : "Output written on main.pdf";
        const auxiliary = unresolved ? (mode === "bibtex" ? "Warning--empty journal in persistent-key" : "[123] Utils.pm:399> WARN - empty journal in persistent-key") : "Bibliography processed";
        const f = await multipassFixture(t, [{ log: first, flood: truncated }, { log: auxiliary }, { log: "LaTeX Warning: Rerun to get cross-references right." }, { log: final }]);
        const result = await runCompilePipeline({ ...f, profile: normalizeCompileProfile({ mode }, engine, "main.tex") });
        assert.equal(result.code, 0);
        assert.deepEqual(result.errors, []);
        assert.match(result.log, /transient-99/);
        assert.match(result.log, /Iris step 4\/4/);
        assert.equal(result.warnings.length, unresolved ? 3 : 0);
        assert.ok(result.warnings.every((message) => !/transient|Rerun/.test(message)));
        if (unresolved) {
          assert.ok(result.warnings.some((message) => message.includes("persistent-key")));
          assert.deepEqual(result.diagnostics.slice(1).map(({ file, line }) => ({ file, line })), [
            { file: "chapters/intro.tex", line: 9 }, { file: "main.tex", line: 12 },
          ]);
        } else assert.deepEqual(result.diagnostics, []);
      });
    }
  }
}

test("custom jobs with different sources, arguments or engines cannot clear each other's warnings", async (t) => {
  const f = await multipassFixture(t, [
    { log: "warning: main job" }, { log: "warning: other source" }, { log: "warning: draft job" },
    { log: "warning: other engine" }, { log: "clean main job" },
  ]);
  const profile = normalizeCompileProfile({ mode: "custom", steps: [
    { tool: "pdflatex", args: ["main.tex"] }, { tool: "pdflatex", args: ["other.tex"] },
    { tool: "pdflatex", args: ["-draftmode", "main.tex"] }, { tool: "xelatex", args: ["main.tex"] },
    { tool: "pdflatex", args: ["main.tex"] },
  ] }, "pdflatex", "main.tex");
  const result = await runCompilePipeline({ ...f, profile, preLog: "Iris: font setup failed" });
  assert.deepEqual(result.warnings, ["warning: other source", "warning: draft job", "warning: other engine"]);
  assert.deepEqual(result.errors, ["Iris: font setup failed"]);
});

for (const mode of ["bibtex", "biber"]) {
  test(`${mode} intermediate failure is structured and never selects unexecuted TeX passes`, async (t) => {
    const f = await multipassFixture(t, [
      { log: "warning: still unresolved" }, { log: "unrecognized auxiliary failure", code: 2 },
    ]);
    const result = await runCompilePipeline({ ...f, profile: normalizeCompileProfile({ mode }, "pdflatex", "main.tex") });
    assert.equal(result.code, 2);
    assert.deepEqual(result.warnings, ["warning: still unresolved"]);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], new RegExp(`${mode}.*2`));
    assert.equal(result.diagnostics.at(-1).file, null);
    assert.equal(result.diagnostics.at(-1).line, null);
    assert.doesNotMatch(result.log, /Iris step 3/);
    assert.equal(await fs.readFile(path.join(f.cwd, "step-count"), "utf8"), "2");
  });
}

for (const observation of [{ signal: "SIGTERM" }, { flood: true }, { flood: true, code: 2 }]) {
  test(`incomplete final TeX capture preserves previous observations (${JSON.stringify(observation)})`, async (t) => {
    const f = await multipassFixture(t, [{ log: "warning: previous" }, { log: "warning: observed", ...observation }]);
    const profile = normalizeCompileProfile({ mode: "custom", steps: [
      { tool: "pdflatex", args: ["main.tex"] }, { tool: "pdflatex", args: ["main.tex"] },
    ] }, "pdflatex", "main.tex");
    const result = await runCompilePipeline({ ...f, profile });
    assert.deepEqual(result.warnings, ["warning: previous", "warning: observed"]);
    if (observation.signal || observation.code) {
      assert.equal(result.errors.length, 1);
      assert.equal(result.diagnostics.at(-1).line, null);
    }
    if (observation.flood) assert.ok(result.log.length < 1024 * 1024 + 1024);
  });
}
