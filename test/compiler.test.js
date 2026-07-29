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
