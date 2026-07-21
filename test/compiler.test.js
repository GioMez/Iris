const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.WEBTEX_SECRET = "test-only-secret-with-sufficient-entropy";

const {
  fileKindForPath,
  inferProjectType,
  findCompileFile,
  normalizeCompileProfile,
  sanitizeCompileProfileForStorage,
  parseCompileArguments,
  sanitizeLilypondArgsForStorage,
  normalizeLilypondFormat,
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
  assert.throws(() => findCompileFile(data, undefined, "latex"), /Nessun file \.tex/);
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
  assert.throws(() => parseCompileArguments('-I "non terminato'), /non terminati/);
  assert.equal(sanitizeLilypondArgsForStorage('-I "bozza'), '-I "bozza');
});

test("selects and constrains every supported LilyPond output format", () => {
  for (const format of ["pdf", "png", "svg", "ps", "eps"]) assert.equal(normalizeLilypondFormat(format), format);
  assert.throws(() => normalizeLilypondFormat("jpg"), /non supportato/);
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webtex-artifacts-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "main.png"), "page one");
  await fs.writeFile(path.join(root, "main-page2.png"), "page two");
  await fs.writeFile(path.join(root, "main2.png"), "unrelated");
  await fs.writeFile(path.join(root, "main.pdf"), "other format");
  const artifacts = await readCompileArtifacts(root, "main", "png");
  assert.deepEqual(artifacts.map((artifact) => artifact.name), ["output/main.png", "output/main-page2.png"]);
  assert.equal(Buffer.from(artifacts[1].base64, "base64").toString(), "page two");
});

test("rejects LaTeX tools in a LilyPond custom pipeline", () => {
  assert.throws(
    () => normalizeCompileProfile({ mode: "custom", steps: [{ tool: "pdflatex", args: ["[main]"] }] }, "lilypond", "main.ly", "lilypond"),
    /non supportato/
  );
  assert.deepEqual(sanitizeCompileProfileForStorage({ mode: "bibtex" }, "lilypond"), { mode: "quick" });
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

test("invokes LilyPond and reads its PDF from output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "webtex-lilypond-test-"));
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
fs.writeFileSync(output + ".pdf", "%PDF-1.4 fake");
`, { mode: 0o755 });

  const profile = normalizeCompileProfile({ mode: "quick" }, "lilypond", "main.ly", "lilypond");
  const result = await runCompilePipeline({ profile, binPath: bin, cwd, fontDir: "", texmfVar: "", preLog: "" });
  assert.equal(result.code, 0);
  assert.match(result.log, /--pdf --output=output\/main main\.ly/);
  assert.equal(await fs.readFile(path.join(cwd, "output", "main.pdf"), "utf8"), "%PDF-1.4 fake");
});
