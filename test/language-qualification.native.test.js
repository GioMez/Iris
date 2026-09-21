const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const exec = promisify(require("node:child_process").execFile);
const { save } = require("./helpers/language-performance.cjs");
const enabled = process.env.IRIS_TEST_COMPILERS === "1";
// Original synthetic fragments selecting the valid constructs from TX02/03/04/07
// and LY02/05/06/08. Explicit wrappers/dependencies; deliberately malformed,
// dynamic, asset-dependent and emoji corpus examples are not compiler inputs.
const cases = {
  tex: String.raw`\documentclass{article}
\usepackage{amsmath}
\newcommand{\localname}[1]{\textbf{#1}}
\begin{document}
\section{Native qualification}
\localname{Text} $a_1+\alpha=2$.
\begin{align}
x &= 2 + \text{word}\\
y &= 3
\end{align}
\begin{verbatim}
  \section{Fake}  
  raw spacing
\end{verbatim}
\end{document}
`,
  ly: String.raw`\version "2.26.0"
\language "nederlands"
#(define motif #{ c'4 d'8 e'8 f'2 #})
music = { cis'8. d'16 r4 <c' e' g'>2 }
\header { title = "Native qualification" }
\score {
\new Staff { \music #motif }
\layout { }
}
`,
};
for (const kind of ["tex", "ly"]) test(`HP08 native valid ${kind} subset before/after protected formatting`, { skip: !enabled, timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "iris-hp08-native-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { analyze, loadLanguage } = await import("../public/iris-language-service.mjs");
  const source = cases[kind], adapter = await loadLanguage(kind), analysis = await analyze(kind, source);
  const changes = adapter.formatChanges(analysis.tree, analysis.doc, null);
  let formatted = source;
  for (const c of changes.slice().sort((a,b) => b.from - a.from)) formatted = formatted.slice(0, c.from) + c.insert + formatted.slice(c.to);
  assert.equal(formatted.split("\n").length, source.split("\n").length, "formatting preserves native source rows");
  const protectedText = kind === "tex" ? "  \\section{Fake}  \n  raw spacing" : "c'4 d'8 e'8 f'2";
  assert.ok(formatted.includes(protectedText));
  const tool = kind === "tex" ? "pdflatex" : "lilypond";
  const version = await exec(tool, ["--version"], { timeout: 10000, env: process.env });
  const report = { kind, provenance: "original synthetic valid subset of annotated TX/LY constructs, explicit article+amsmath / LilyPond wrappers", version: version.stdout, source, formatted, changes, runs: [] };
  try {
    for (const [name, text] of [["original", source], ["formatted", formatted]]) {
      await fs.writeFile(path.join(directory, `${name}.${kind}`), text);
      const args = kind === "tex" ? ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", `${name}.tex`]
        : ["--pdf", `--output=${name}`, `${name}.ly`];
      const result = await exec(tool, args, { cwd: directory, env: process.env, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
      const pdf = await fs.readFile(path.join(directory, `${name}.pdf`));
      assert.equal(pdf.subarray(0,5).toString(), "%PDF-");
      report.runs.push({ name, args, stdout: result.stdout, stderr: result.stderr, pdfBytes: pdf.length });
    }
  } finally { await save(`native-${kind}`, report); }
  t.diagnostic(JSON.stringify(report));
});
