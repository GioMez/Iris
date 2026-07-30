// Parity tests for the CodeMirror stream tokenizers introduced by the editor
// migration: for every character of a corpus, the token emitted by
// IrisLatex.stream / IrisLilyPond.stream must match the t-* class produced by
// the reference highlight() renderers the legacy editor painted with.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSyntaxModules() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/iris-latex.js"), "utf8"), context);
  context.IrisLatex = context.window.IrisLatex;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/iris-lilypond.js"), "utf8"), context);
  return { latex: context.window.IrisLatex, lilypond: context.window.IrisLilyPond };
}

// Minimal CodeMirror StringStream: the subset of the contract the tokenizers
// rely on (sol/eol/peek/next/eat/eatWhile/match/skipToEnd/current).
class StringStream {
  constructor(string) { this.string = string; this.pos = 0; this.start = 0; }
  sol() { return this.pos === 0; }
  eol() { return this.pos >= this.string.length; }
  peek() { return this.string.charAt(this.pos) || undefined; }
  next() { if (this.pos < this.string.length) return this.string.charAt(this.pos++); }
  eat(match) {
    const ch = this.string.charAt(this.pos);
    // Duck-typed: RegExp literals created inside the vm context do not pass an
    // instanceof check from this realm.
    const ok = typeof match === "string" ? ch === match
      : ch && (typeof match.test === "function" ? match.test(ch) : match(ch));
    if (ok) { this.pos += 1; return ch; }
  }
  eatWhile(match) { const start = this.pos; while (this.eat(match)) {} return this.pos > start; }
  skipToEnd() { this.pos = this.string.length; }
  match(pattern, consume) {
    if (typeof pattern === "string") {
      if (this.string.slice(this.pos, this.pos + pattern.length) !== pattern) return null;
      if (consume !== false) this.pos += pattern.length;
      return true;
    }
    const found = this.string.slice(this.pos).match(pattern);
    if (!found || found.index > 0) return null;
    if (consume !== false) this.pos += found[0].length;
    return found;
  }
  current() { return this.string.slice(this.start, this.pos); }
}

// Runs the stream tokenizer over the whole source and returns one token name
// (or null) per character. Also asserts the tokenizer always makes progress —
// the invariant CodeMirror itself enforces at runtime.
function streamClasses(spec, src) {
  const classes = [];
  const state = spec.startState();
  const lines = src.split("\n");
  lines.forEach((line, index) => {
    const stream = new StringStream(line);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const token = spec.token(stream, state);
      assert.ok(stream.pos > stream.start,
        `tokenizer stalled at line ${index + 1}, pos ${stream.pos}: ${JSON.stringify(line)}`);
      for (let i = stream.start; i < stream.pos; i++) classes.push(token || null);
    }
    if (index < lines.length - 1) classes.push(null);
  });
  return classes;
}

// Converts highlight()'s HTML into the same one-class-per-character shape.
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
function highlightClasses(highlight, src) {
  const html = highlight(src);
  const classes = [];
  const spanRe = /<span class="t-([a-z]+)">([\s\S]*?)<\/span>/g;
  let last = 0, m;
  while ((m = spanRe.exec(html))) {
    for (const _ of decodeEntities(html.slice(last, m.index))) classes.push(null);
    for (const _ of decodeEntities(m[2])) classes.push(m[1]);
    last = spanRe.lastIndex;
  }
  for (const _ of decodeEntities(html.slice(last))) classes.push(null);
  return classes;
}

function assertParity(spec, highlight, src) {
  const expected = highlightClasses(highlight, src);
  const actual = streamClasses(spec, src);
  assert.equal(actual.length, src.length, "stream classes must cover the source 1:1");
  assert.equal(expected.length, src.length, "highlight classes must cover the source 1:1");
  // Newlines carry no visible colour; both sides are normalised there (the
  // legacy renderer folds line breaks into multi-line math/string spans).
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") { expected[i] = null; actual[i] = null; }
    if (actual[i] !== expected[i]) {
      const lineNo = src.slice(0, i).split("\n").length;
      assert.fail(`token mismatch at offset ${i} (line ${lineNo}, char ${JSON.stringify(src[i])}): ` +
        `stream=${actual[i]} highlight=${expected[i]}\ncontext: ${JSON.stringify(src.slice(Math.max(0, i - 20), i + 20))}`);
    }
  }
}

const LATEX_CORPUS = String.raw`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
% comment with \commands and $math$ and \begin{x}
\begin{document}
\section*{Hello & World}
Text with ~ special, \% escaped, and braces {like [these]}.
Inline $a^2 + b_1 \$ still$ and \(x+y\) math.
Display: \[ \int_0^1 x\,dx \]
$$\sum_{i=1}^n i$$
\begin{align*}
  a &= b \\
  c &= d
\end{align*}
\begin {spaced}
text\end{spaced}
Multi-line math $a +
b$ then prose.
\begin{}
Unclosed inline \( math to the end`;

const LILYPOND_CORPUS = String.raw`\version "2.24.0"
% line comment with \score
%{ block
comment across lines %}
global = { \key c \major \time 4/4 }
\score {
  \relative c' {
    c4 d e2 | <c e g>1 |
    d8-. e-- \f g\p
    << { c2 } \\ { e2 } >>
  }
  \addlyrics { la la "quoted lyric" }
  \layout { }
}
"multi
line string"
\markup { \bold "text with \"escape\" inside" }
angle singles: a < b > c`;

test("LaTeX stream tokenizer matches highlight() class for class", () => {
  const { latex } = loadSyntaxModules();
  assertParity(latex.stream, latex.highlight, LATEX_CORPUS);
});

test("LilyPond stream tokenizer matches highlight() class for class", () => {
  const { latex, lilypond } = loadSyntaxModules();
  assert.ok(latex, "LilyPond highlighting reuses the LaTeX escape helper");
  assertParity(lilypond.stream, lilypond.highlight, LILYPOND_CORPUS);
});

test("stream tokenizers keep state across lines for math, strings and block comments", () => {
  const { latex, lilypond } = loadSyntaxModules();
  const mathClasses = streamClasses(latex.stream, "$a\n+ b$ x");
  assert.equal(mathClasses[3], "math", "math continues on the following line");
  assert.equal(mathClasses[8], null, "text after the closing $ is plain");
  const stringClasses = streamClasses(lilypond.stream, '"a\nb" x');
  assert.equal(stringClasses[3], "env", "strings span lines like the reference renderer");
  assert.equal(stringClasses[6], null, "text after the closing quote is plain");
  const commentClasses = streamClasses(lilypond.stream, "%{ a\nb %} c4");
  assert.equal(commentClasses[5], "comment", "block comments span lines");
  assert.equal(commentClasses[9], null, "code after %} is plain again");
});

// Runs the tokenizers inside the real CodeMirror StreamLanguage — the same
// realm setup as the browser — and checks corpus parity via highlightTree.
test("tokenizers drive the real CodeMirror StreamLanguage", async () => {
  const [{ StreamLanguage }, { Tag, tagHighlighter, highlightTree }] = await Promise.all([
    import("@codemirror/language"),
    import("@lezer/highlight"),
  ]);
  // Same-realm load: cross-realm RegExp literals would fail the instanceof
  // checks inside CodeMirror's own StringStream.
  const hadWindow = "window" in globalThis;
  const previousWindow = globalThis.window;
  const previousLatex = globalThis.IrisLatex;
  globalThis.window = {};
  try {
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../public/iris-latex.js"), "utf8"));
    globalThis.IrisLatex = globalThis.window.IrisLatex;
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, "../public/iris-lilypond.js"), "utf8"));
    const modules = [
      [globalThis.window.IrisLatex, LATEX_CORPUS],
      [globalThis.window.IrisLilyPond, LILYPOND_CORPUS],
    ];
    const names = ["cmd", "env", "brace", "math", "comment", "special"];
    const tokenTable = Object.fromEntries(names.map((name) => [name, Tag.define()]));
    const highlighter = tagHighlighter(names.map((name) => ({ tag: tokenTable[name], class: name })));
    for (const [mod, corpus] of modules) {
      const language = StreamLanguage.define({
        startState: mod.stream.startState,
        copyState: mod.stream.copyState,
        token: mod.stream.token,
        tokenTable,
      });
      const tree = language.parser.parse(corpus);
      const actual = new Array(corpus.length).fill(null);
      highlightTree(tree, highlighter, (from, to, cls) => {
        for (let i = from; i < to; i++) actual[i] = cls;
      });
      const expected = highlightClasses(mod.highlight, corpus);
      for (let i = 0; i < corpus.length; i++) {
        if (corpus[i] === "\n") continue;
        assert.equal(actual[i], expected[i],
          `real-parser mismatch at offset ${i}: ${JSON.stringify(corpus.slice(Math.max(0, i - 20), i + 20))}`);
      }
    }
  } finally {
    if (hadWindow) globalThis.window = previousWindow; else delete globalThis.window;
    if (previousLatex === undefined) delete globalThis.IrisLatex; else globalThis.IrisLatex = previousLatex;
  }
});

test("stream state copies are independent", () => {
  const { latex, lilypond } = loadSyntaxModules();
  [latex, lilypond].forEach((mod) => {
    const state = mod.stream.startState();
    const copy = mod.stream.copyState(state);
    assert.notEqual(copy, state);
    assert.deepEqual(copy, state);
  });
});
