const test = require("node:test");
const assert = require("node:assert/strict");

process.env.IRIS_SECRET = "test-only-secret-with-sufficient-entropy";
process.env.DB_PASSWORD = "test-only-database-password";
const { parseCompileLog, buildOutputView, runCompilePipeline } = require("../src/server");

test("LilyPond warnings with file, line and column never count as errors", () => {
  const result = parseCompileLog("./parts/violin.ily:12:7: warning: barcheck failed at: 1/4\n");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.diagnostics, [{
    severity: "warning", file: "parts/violin.ily", line: 12, column: 7,
    message: "barcheck failed at: 1/4",
  }]);
});

test("file-line diagnostics preserve messages, spaces and Windows drive letters", () => {
  const result = parseCompileLog([
    "./chapters/first draft.tex:9: Undefined control sequence.",
    "C:\\build\\score\\parts\\violin.ily:3:0: error: syntax error, unexpected '}'",
    "C:\\build\\score\\parts\\violin.ily:4:8: programming error: broken spanner",
  ].join("\r\n"), { cwd: "C:\\build\\score" });
  assert.deepEqual(result.diagnostics, [
    { severity: "error", file: "chapters/first draft.tex", line: 9, column: null, message: "Undefined control sequence." },
    { severity: "error", file: "parts/violin.ily", line: 3, column: 0, message: "syntax error, unexpected '}'" },
    { severity: "error", file: "parts/violin.ily", line: 4, column: 8, message: "broken spanner" },
  ]);
});

test("TeX classic errors and wrapped warnings follow the input file stack", () => {
  const result = parseCompileLog(String.raw`(./main.tex
(/usr/share/texmf/tex/latex/base/article.cls
Document Class: article
)
(./chapters/intro.tex
! Undefined control sequence.
l.17 \unknown
LaTeX Warning: Reference [33m'fig:one'[0m on page 1 undefined on input line 21.
)
Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing '\\' on input line 30.
)
LaTeX Warning: There were undefined references.`);
  assert.deepEqual(result.diagnostics, [
    { severity: "error", file: "chapters/intro.tex", line: 17, column: null, message: "Undefined control sequence." },
    { severity: "warning", file: "chapters/intro.tex", line: 21, column: null, message: "LaTeX Warning: Reference 'fig:one' on page 1 undefined on input line 21." },
    { severity: "warning", file: "main.tex", line: 30, column: null, message: "Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing '\\\\' on input line 30." },
    { severity: "warning", file: null, line: null, column: null, message: "LaTeX Warning: There were undefined references." },
  ]);
});

test("absolute staging paths become project-relative without aliasing external files", () => {
  const result = parseCompileLog([
    "/tmp/build/parts/../chapters/intro.tex:4: Missing $ inserted.",
    "/usr/share/texmf/main.tex:4: package error",
    "../main.tex:4: outside project",
  ].join("\n"), { cwd: "/tmp/build" });
  assert.deepEqual(result.diagnostics.map((d) => d.file), ["chapters/intro.tex", "/usr/share/texmf/main.tex", "../main.tex"]);
});

test("pipeline repeats are deduplicated, while distinct source locations survive", () => {
  const result = parseCompileLog([
    "===== Iris step 1/2: pdflatex =====",
    "./main.tex:2: Missing $ inserted.",
    "===== Iris step 2/2: pdflatex =====",
    "main.tex:2: Missing $ inserted.",
    "main.tex:3: Missing $ inserted.",
  ].join("\n"));
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.diagnostics.map((d) => d.line), [2, 3]);
});

test("unlocated tool failures remain visible without mistaking normal output for errors", () => {
  const result = parseCompileLog([
    "$ pdflatex -file-line-error main.tex",
    "Document Class: article 2025/01/22",
    "Output written on error-handling.pdf (2 pages).",
    "Iris: unable to start lilypond: spawn lilypond ENOENT",
    "fatal error: failed files: main.ly",
    "Iris: compilation stopped after 120000ms.",
  ].join("\n"));
  assert.equal(result.diagnostics.length, 3);
  assert.ok(result.diagnostics.every((d) => d.severity === "error" && d.file === null && d.line === null));
  assert.equal(result.warnings.length, 0);
});

test("diagnostics stay bounded after deduplication", () => {
  const result = parseCompileLog(Array.from({ length: 100 }, (_, i) =>
    `main.ly:${i + 1}:2: error: bad note\nmain.ly:${i + 1}:2: error: bad note\nmain.ly:${i + 1}:3: warning: bad bar`
  ).join("\n"));
  assert.equal(result.errors.length, 80);
  assert.equal(result.warnings.length, 80);
  assert.equal(result.diagnostics.length, 160);
});

test("build history exposes persisted locations and retains the legacy string arrays", () => {
  const warning = { severity: "warning", file: "parts/voice.ily", line: 8, column: 2, message: "barcheck failed" };
  const view = buildOutputView({ warnings: [warning], errors: [], log: "raw log" }, true);
  assert.deepEqual(view.diagnostics, [warning]);
  assert.deepEqual(view.warnings, ["barcheck failed"]);
  assert.deepEqual(view.errors, []);
  assert.equal(view.log, "raw log");
});

test("old builds recover diagnostics from their logs and retain failures absent from the log", () => {
  const view = buildOutputView({
    warnings: ["main.ly:8:2: warning: barcheck failed"],
    errors: ["main.ly:8:2: warning: barcheck failed", "publication failed"],
    log: "main.ly:8:2: warning: barcheck failed",
  }, true);
  assert.equal(view.warnings.length, 1);
  assert.deepEqual(view.errors, ["publication failed"]);
  assert.equal(view.diagnostics.length, 2);
  assert.equal(view.diagnostics[0].file, "main.ly");
});

test("the actual pipeline returns structured diagnostics with portable source paths", async () => {
  const result = await runCompilePipeline({
    profile: { steps: [{ tool: process.execPath, args: ["-e", "console.error(process.cwd() + '/parts/voice.ily:2:0: warning: barcheck failed')"] }] },
    cwd: process.cwd(), binPath: "", fontDir: "", texmfVar: "", preLog: "",
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.diagnostics, [{ severity: "warning", file: "parts/voice.ily", line: 2, column: 0, message: "barcheck failed" }]);
});

test("explicit file-line warnings retain their severity even without a LilyPond prefix", () => {
  const result = parseCompileLog("./main.tex:7: LaTeX Warning: Reference 'one' undefined on input line 7.");
  assert.equal(result.errors.length, 0);
  assert.equal(result.diagnostics[0].severity, "warning");
});

test("engine warnings remain visible alongside package and LilyPond warnings", () => {
  for (const engine of ["pdfTeX", "LuaTeX", "XeTeX"]) {
    const result = parseCompileLog(`${engine} warning (ext4): destination with the same identifier (name{page.1}) has been already used, duplicate ignored`);
    assert.equal(result.warnings.length, 1, engine);
    assert.equal(result.errors.length, 0);
  }
});
