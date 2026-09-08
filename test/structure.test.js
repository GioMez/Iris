// The region parsers and the containment logic they feed. This is what decides
// whether two people are told they are working on the same thing, so the cases
// that matter are the ones where line distance and structure disagree.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

// The three modules run as browser scripts against a shared global, which is
// what lets iris-lilypond.js reach IrisLatex by bare name.
function load() {
  const context = { console: { error() {}, warn() {}, log() {} } };
  context.window = context;
  vm.createContext(context);
  ["public/iris-latex.js", "public/iris-lilypond.js", "public/iris-structure.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  });
  return context;
}

const iris = load();
const tex = (source) => iris.IrisLatex.regions(source);
const ly = (source) => iris.IrisLilyPond.regions(source);
// Array.from rebuilds the list in this realm: arrays made inside the vm carry
// a different Array.prototype, which deepEqual compares.
const labels = (nodes) => Array.from(nodes, (node) => node.label);

/* ---- LaTeX ---- */

test("an environment reaches from its \\begin to the end of its \\end", () => {
  const source = "text\n\\begin{align}\nx\n\\end{align}\nafter";
  const [region] = tex(source);
  assert.equal(region.kind, "environment");
  assert.equal(region.label, "\\begin{align}");
  assert.equal(source.slice(region.from, region.to), "\\begin{align}\nx\n\\end{align}");
});

test("environments nest, and the document wrapper is not a region", () => {
  const source = "\\begin{document}\n\\begin{figure}\n\\begin{center}\na\n\\end{center}\n\\end{figure}\n\\end{document}";
  const found = tex(source);
  // Sharing `document` says no more than sharing the file.
  assert.deepEqual(labels(found), ["\\begin{figure}", "\\begin{center}"]);
  const [figure, center] = found;
  assert.ok(figure.from < center.from && center.to < figure.to, "the inner one has to sit inside the outer");
});

test("a heading runs until the next heading of the same or higher rank", () => {
  const source = [
    "\\section{One}",      //  0
    "alpha",
    "\\subsection{Deep}",
    "beta",
    "\\section{Two}",
    "gamma",
  ].join("\n");
  const found = tex(source);
  const one = found.find((region) => region.label === "One");
  const deep = found.find((region) => region.label === "Deep");
  const two = found.find((region) => region.label === "Two");
  // The subsection stops where the next section starts, not at the end of file.
  assert.equal(source.slice(one.to).startsWith("\\section{Two}"), true);
  assert.equal(deep.to, one.to);
  assert.equal(two.to, source.length);
});

test("a heading title survives nested braces", () => {
  const [region] = tex("\\section{A \\emph{brave} title}\nbody");
  assert.equal(region.label, "A \\emph{brave} title");
});

test("commented-out markup cannot unbalance the document", () => {
  // The \end is commented out, so the environment is still open and runs on.
  const source = "\\begin{align}\nx\n% \\end{align}\ny";
  const [region] = tex(source);
  assert.equal(region.to, source.length, "an environment left open reaches the end of the file");
  // An escaped percent is a character, not the start of a comment.
  const escaped = tex("\\begin{align}\n50\\% done\n\\end{align}");
  assert.equal(escaped.length, 1);
  assert.equal(escaped[0].to, "\\begin{align}\n50\\% done\n\\end{align}".length);
});

test("a stray \\end does not close an environment that never opened", () => {
  const found = tex("\\end{align}\n\\begin{quote}\nq\n\\end{quote}");
  assert.deepEqual(labels(found), ["\\begin{quote}"]);
});

/* ---- LilyPond ---- */

test("a score block reaches its closing brace", () => {
  const source = "\\score {\n  c d e\n}\n";
  const [region] = ly(source);
  assert.equal(source.slice(region.from, region.to), "\\score {\n  c d e\n}");
});

test("a variable's block is the value assigned to it", () => {
  const source = "melody = \\relative c' {\n  c d e\n}\n";
  const [region] = ly(source);
  assert.match(region.label, /^melody =/);
  assert.equal(source.slice(region.to - 1, region.to), "}");
});

test("a \\with block configures a context, it is not the context's body", () => {
  const source = '\\new Staff \\with { instrumentName = "x" } {\n  c d\n}\n';
  const staff = ly(source).find((region) => /Staff/.test(region.label));
  assert.ok(staff, "the staff has to be found at all");
  // The body is the second block, so the region has to reach past the \with one.
  assert.equal(source.slice(staff.to - 1, staff.to), "}");
  assert.ok(staff.to > source.indexOf('instrumentName = "x" }') + 1);
});

test("simultaneous music delimits a region too", () => {
  const source = "\\score <<\n  \\new Staff { c }\n>>\n";
  const score = ly(source).find((region) => region.from === 0);
  assert.equal(source.slice(score.to - 2, score.to), ">>");
});

test("braces inside comments and strings do not unbalance the nesting", () => {
  const source = 'melody = {\n  % a stray } in a comment\n  c d\n}\n';
  const [region] = ly(source);
  assert.equal(region.to, source.lastIndexOf("}") + 1);
});

/* ---- containment ---- */

const structure = (source, kind) => iris.IrisStructure.index(source, kind);
const at = (tree, offset) => iris.IrisStructure.pathAt(tree, offset);

test("the path names every region containing a position, outermost first", () => {
  const source = "\\section{One}\nalpha\n\\begin{align}\nx = 1\n\\end{align}\n";
  const tree = structure(source, "tex");
  const path = at(tree, source.indexOf("x = 1"));
  assert.deepEqual(labels(path), ["One", "\\begin{align}"]);
  // A position before any region belongs to none of them.
  assert.deepEqual(labels(at(tree, 0)), ["One"]);
});

test("a position in no region at all yields an empty path", () => {
  const source = "\\documentclass{article}\n\\usepackage{amsmath}\n";
  assert.equal(at(structure(source, "tex"), 10).length, 0);
});

test("two people in the same construct are contained, however far apart", () => {
  const filler = "y\n".repeat(40);
  const source = `\\section{One}\n\\begin{align}\nx\n${filler}z\n\\end{align}\n`;
  const tree = structure(source, "tex");
  const mine = at(tree, source.indexOf("x"));
  const theirs = at(tree, source.lastIndexOf("z"));
  const shared = iris.IrisStructure.shared(mine, theirs);
  assert.equal(shared.contained, true, "forty lines apart inside one environment is still the same work");
  assert.equal(shared.node.label, "\\begin{align}");
});

test("two people in sibling constructs are not contained, however close", () => {
  const source = "\\section{One}\nalpha\n\\section{Two}\nbeta\n";
  const tree = structure(source, "tex");
  const mine = at(tree, source.indexOf("alpha"));
  const theirs = at(tree, source.indexOf("beta"));
  const shared = iris.IrisStructure.shared(mine, theirs);
  // Adjacent lines across a boundary: the old line rule warned, structure does not.
  assert.equal(shared.contained, false);
  assert.equal(shared.node, null, "two top-level siblings share no region at all");
});

test("one person inside the other's region counts as shared", () => {
  const source = "\\section{One}\nalpha\n\\begin{align}\nx\n\\end{align}\n";
  const tree = structure(source, "tex");
  const outer = at(tree, source.indexOf("alpha"));
  const inner = at(tree, source.indexOf("x\n\\end"));
  const shared = iris.IrisStructure.shared(outer, inner);
  assert.equal(shared.contained, true);
  // Named by what they actually have in common, not by the deeper one.
  assert.equal(shared.node.label, "One");
});

test("malformed markup is clamped rather than dropped", () => {
  // The align is left open and would overrun the section it started in.
  const source = "\\section{One}\n\\begin{align}\nx\n\\section{Two}\nbeta\n";
  const tree = structure(source, "tex");
  const path = at(tree, source.indexOf("beta"));
  assert.deepEqual(labels(path), ["Two"], "the second section is not swallowed by the open environment");
});

test("a parser that throws costs precision, not the editor", () => {
  const broken = load();
  broken.IrisLatex.regions = () => { throw new Error("boom"); };
  const tree = broken.IrisStructure.index("\\section{One}\n", "tex");
  assert.equal(broken.IrisStructure.pathAt(tree, 5).length, 0);
});
