const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const cases = require("./fixtures/languages/cases.json").filter(c => c.kind === "tex");
const source = text => ({ length: text.length, sliceString: (from, to) => text.slice(from, to) });
const load = async options => (await import("../public/iris-language-service.mjs")).loadLanguage("tex", options);

// Plain text (including newlines) is meaningful: do not silently skip gaps in
// highlightTree's output or only check that one matching span exists.
async function roles(tree, length) {
  const { highlightTree } = await import("@lezer/highlight");
  const { roleHighlighter } = await import("../public/iris-syntax-style.mjs");
  const result = Array(length).fill("text");
  highlightTree(tree, roleHighlighter, (from, to, role) => result.fill(role, from, to));
  return result;
}
function nodes(tree) {
  const rows = [];
  tree.iterate({ enter: n => rows.push([n.name, n.from, n.to]) });
  return rows;
}
function sameNodes(actual, expected) {
  const a = nodes(actual), b = nodes(expected);
  for (let i = 0; i < Math.min(a.length, b.length); i++) assert.deepEqual(a[i], b[i], `tree row ${i}`);
  assert.equal(a.length, b.length, "tree node count");
}
function sharedTrees(a, b) {
  const old = new Set(), shared = new Set();
  const visit = (tree, fn) => { fn(tree); for (const child of tree.children || []) if (child.children) visit(child, fn); };
  visit(a, n => old.add(n));
  visit(b, n => { if (n.length && old.has(n)) shared.add(n); });
  return shared.size;
}
async function parse(text, options) {
  const adapter = await load(options), tree = adapter.language.parser.parse(text), doc = source(text);
  return { adapter, tree, doc, data: adapter.summarize(tree, doc), roles: await roles(tree, text.length) };
}
function expectRole(result, text, needle, role, start = 0) {
  const from = text.indexOf(needle, start);
  assert.notEqual(from, -1, needle);
  assert.deepEqual(result.roles.slice(from, from + needle.length), Array(needle.length).fill(role), needle);
}

for (const fixture of cases) {
  test(`${fixture.id}: EVERY annotated role, caret, complete outline and region target`, async t => {
    const text = await fs.readFile(path.join(__dirname, "fixtures/languages", fixture.file), "utf8");
    const r = await parse(text);
    for (const span of fixture.roles) {
      assert.equal(text.slice(span.from, span.to), span.text, "annotation still selects its intended source");
      assert.deepEqual(r.roles.slice(span.from, span.to), Array(span.to - span.from).fill(span.role), `${span.requirement} ${JSON.stringify(span.text)} [${span.from},${span.to})`);
    }
    for (const caret of fixture.contexts) assert.equal(r.adapter.contextAt(r.tree, r.doc, caret.pos).mode, caret.mode, `caret ${caret.pos}`);
    assert.deepEqual(r.data.outline.map(x => x.title), fixture.outline, "complete outline, including absence of phantom entries");
    for (const target of fixture.regions || []) assert.ok(r.data.regions.some(r => r.from === target.from && r.to === target.to && r.label === target.label), JSON.stringify(target));
    if (fixture.validity.status === "complete") assert.deepEqual(nodes(r.tree).filter(n => n[0] === "⚠"), [], "valid corpus must not need error recovery");
    t.diagnostic(`${fixture.roles.length} role spans; ${fixture.contexts.length} carets; ${fixture.outline.length} complete-outline entries; ${(fixture.regions || []).length} region targets`);
  });
}

test("comments, literal bodies and deferred definition bodies cannot execute document structure", async () => {
  const { analyze } = await import("../public/iris-language-service.mjs");
  const text = '% \\section{Finta}\n\\begin{verbatim}\n\\section{Esempio}\n\\end{verbatim}\n\\section{Vera}';
  const result = await analyze("tex", text);
  assert.deepEqual(result.data.outline.map(x => x.title), ["Vera"]);
  assert.equal(result.data.regions.some(x => x.label.includes("Esempio")), false);
  const r = await parse("\\newcommand{\\hidden}{\\section{Fake}\\label{fake}\\input{fake.tex}}\\hidden\\section{Real}");
  assert.deepEqual(r.data.outline.map(x => x.title), ["Real"]);
  assert.deepEqual(r.data.symbols.map(x => [x.kind, x.name]), [["command", "hidden"]]);
  assert.deepEqual(r.data.references, []);
  assert.deepEqual(r.data.includes, []);
});

test("math environments, nested text/math and comments preserve internal roles", async () => {
  const names = "math displaymath equation equation* align align* alignat alignat* flalign flalign* gather gather* multline multline* eqnarray eqnarray* aligned alignedat gathered split cases array matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix".split(" ");
  for (const name of names) {
    const text = `\\begin{${name}}x_2+\\alpha% \\end{${name}}\r\n\\text{words $y^3$ words}z\\end{${name}} tail`;
    const r = await parse(text);
    for (const [needle, role] of [["x", "math"], ["_", "operator"], ["2", "number"], ["\\alpha", "command"], ["words", "text"], ["y^", "math"], ["3", "number"], ["z", "math"], ["tail", "text"]]) {
      if (needle === "y^") assert.equal(r.roles[text.indexOf("y^")], "math");
      else expectRole(r, text, needle, role, text.indexOf("}") + 1);
    }
    assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("words") + 2).mode, "text");
    assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("y^")).mode, "math");
    assert.equal(r.data.regions.find(x => x.name === name).certainty, "exact");
  }
});

test("literal families preserve headers, exact own closers, and known VerbBreak endpoints", async () => {
  for (const name of ["verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*"]) {
    const header = name === "minted" ? "[linenos]{python}" : name.startsWith("filecontents") ? "{out.tex}" : "";
    const text = `\\begin{${name}}${header}\n\\section{Fake}\\label{fake} $ \\end{other}\n\\end{${name}}\n\\section{Real}`;
    const r = await parse(text);
    assert.deepEqual(r.data.outline.map(x => x.title), ["Real"], name);
    assert.deepEqual(r.data.symbols, [], name);
    expectRole(r, text, "\\section{Fake}", "literal");
    expectRole(r, text, name, "environment");
    if (header) assert.notEqual(r.roles[text.indexOf(header)], "literal", "literal header is parsed");
  }
  for (const eol of ["\n", "\r", "\r\n"]) {
    const text = "\\verb*|fake" + eol + "\\section{Real}", r = await parse(text);
    const literal = r.data.regions.find(x => x.kind === "literal");
    assert.deepEqual([literal.to, literal.certainty, literal.openEnded], [11 + eol.length, "recovered", false]);
    assert.equal(r.adapter.contextAt(r.tree, r.doc, literal.to).mode, "text");
  }
});

test("headings retain long raw titles, editorial numbering, and next same/higher boundaries", async () => {
  const text = "😀\r\n\\begin{document}\\chapter[Short [nested]]{Long {title}\r\nline}\\section*{Star}\\subsection{Sub}\\chapter{Next}\\end{document}";
  const r = await parse(text);
  assert.deepEqual(r.data.outline.map(x => [x.level, x.num, x.title]), [[1, "1", "Long {title}\r\nline"], [2, "", "Star"], [3, "1.0.1", "Sub"], [1, "2", "Next"]]);
  assert.equal(r.data.outline[0].offset, text.indexOf("\\chapter"));
  const headings = r.data.regions.filter(x => x.kind === "heading");
  assert.deepEqual(headings.map(x => x.to), [text.indexOf("\\chapter{Next}"), text.indexOf("\\chapter{Next}"), text.indexOf("\\chapter{Next}"), text.length]);
  assert.equal(r.data.regions.some(x => x.name === "document"), false);
  const title = "A".repeat(5000) + " {B}\nC";
  assert.equal((await parse(`\\section{${title}}`)).data.outline[0].title, title);
});

test("literal environment names pair by name, recover mismatches, and have no short header limit", async () => {
  for (const [text, expected] of [
    ["\\begin{a}\\begin{a}x\\end{a}", [[0, 26, "recovered", true], [9, 26, "exact", false]]],
    ["\\begin{a}\\begin{b}x\\end{a}", [[0, 26, "recovered", false], [9, 19, "recovered", false]]],
    ["\\begin{a}x\\end{b}y\\end{a}", [[0, 25, "recovered", false]]],
  ]) {
    const r = await parse(text);
    assert.deepEqual(r.data.regions.filter(x => x.kind === "environment").map(x => [x.from, x.to, x.certainty, x.openEnded]), expected, text);
  }
  const name = "long".repeat(180), text = `\\begin {${name}}body\\end{${name}}`;
  const r = await parse(text);
  assert.deepEqual(r.data.regions.filter(x => x.kind === "environment").map(x => [x.name, x.to, x.certainty]), [[name, text.length, "exact"]]);
  r.tree.iterate({ enter(n) { if (!n.node.firstChild && !n.type.isError) assert.ok(n.to - n.from <= 256); } });
});

test("definition signatures collect names and suppress all deferred document content", async () => {
  const forms = [
    ...["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand"].map(c => `\\${c}*{\\café}[2][x]{\\section{Fake}#1}`),
    ...["NewDocumentCommand", "RenewDocumentCommand", "ProvideDocumentCommand"].map(c => `\\${c}{\\café}{O{x} m}{\\label{fake}#2}`),
    ...["def", "gdef", "edef", "xdef"].map(c => `\\${c}\\café#1#2{\\input{fake}#1}`),
    ...["newenvironment", "renewenvironment"].map(c => `\\${c}{box}[1]{\\section{Fake}}{\\label{fake}}`),
    ...["NewDocumentEnvironment", "RenewDocumentEnvironment", "ProvideDocumentEnvironment"].map(c => `\\${c}{box}{m}{\\section{Fake}}{\\input{fake}}`),
  ];
  for (const text of forms) {
    const r = await parse(text), env = text.includes("Environment") || text.includes("environment");
    assert.deepEqual(r.data.symbols.map(x => [x.kind, x.name, x.certainty]), [[env ? "environment" : "command", env ? "box" : "café", "exact"]], text);
    assert.deepEqual(r.data.outline, [], text);
    assert.deepEqual(r.data.references, [], text);
    assert.deepEqual(r.data.includes, [], text);
  }
});

test("catalog argument roles, literal records, lists and unknown dynamic arguments", async () => {
  const text = "\\label{a}\\cref*{a,b}\\citep[see][p.~2]{one,two}\\input{chap.tex}\\bibliography{a,b}\\addbibresource[location=local]{refs.bib}\\input{\\root/file}\\recite{plain}";
  const r = await parse(text);
  assert.deepEqual(r.data.symbols.map(x => [x.kind, x.name]), [["label", "a"]]);
  assert.deepEqual(r.data.references.map(x => [x.kind, x.name]), [["label", "a"], ["label", "b"], ["citation", "one"], ["citation", "two"]]);
  assert.deepEqual(r.data.includes.filter(x => x.certainty === "exact").map(x => x.path), ["chap.tex", "a", "b", "refs.bib"]);
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("/file") + 1).certainty, "unknown");
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("one") + 1).argumentRole, "citation-list");
  expectRole(r, text, "plain", "text");
  assert.deepEqual(nodes(r.tree).filter(x => x[0] === "⚠"), []);
});

test("lexical profile toggles are local to scope and static profiles support Unicode control words", async () => {
  const text = "{\\makeatletter\\def\\café@x{ok}\\café@x}\\café@x {\\ExplSyntaxOn\\cs_new:Npn \\iris_name:n #1{#1}\\iris_name:n{ok}}\\iris_name:n";
  const r = await parse(text);
  expectRole(r, text, "\\café@x", "definition");
  expectRole(r, text, "@x", "text", text.lastIndexOf("\\café"));
  expectRole(r, text, "\\iris_name:n", "definition");
  assert.deepEqual(r.data.symbols.map(x => x.name), ["café@x", "iris_name:n"]);
  for (const [profile, command] of [["internal", "\\café@x"], ["expl3", "\\café_name:n"]]) expectRole(await parse(command, { texProfile: profile }), command, command, "command");
});

test("escape parity, nested optional arguments, unknown names and interrupted signatures", async () => {
  for (let slashes = 1; slashes <= 6; slashes++) {
    const text = "\\".repeat(slashes) + "% fake\r\n\\unknownword{plain}";
    const r = await parse(text);
    assert.equal(r.roles[slashes], slashes % 2 ? "command" : "comment");
    expectRole(r, text, "\\unknownword", "command");
    expectRole(r, text, "plain", "text");
    assert.deepEqual(nodes(r.tree).filter(n => n[0] === "⚠"), []);
  }
  const text = "\\section[short {a[b]}]{Long}\\ref plain {ordinary}\\cite[nested [note]]{key}";
  const r = await parse(text);
  assert.deepEqual(r.data.outline.map(x => x.title), ["Long"]);
  assert.deepEqual(r.data.references.map(x => [x.kind, x.name]), [["citation", "key"]]);
  expectRole(r, text, "ordinary", "text");
  for (const text of ["\\ref{open", "\\cite[note]{one,two", "\\includegraphics[width={x[y]}]{dir/file"]) {
    const r = await parse(text), context = r.adapter.contextAt(r.tree, r.doc, text.length);
    assert.equal(context.certainty, "recovered");
    assert.ok(context.argumentRole);
  }
});

test("literal closing lines, parsed header contexts and deferred profile toggles", async () => {
  const text = "\\begin{minted}[escapeinside={||}]{python}\nprint('\\end{minted}')\n\\section{Fake}\n\\end{minted}\n\\section{Real}";
  const r = await parse(text);
  expectRole(r, text, "print('\\end{minted}')", "literal");
  assert.deepEqual(r.data.outline.map(x => x.title), ["Real"]);
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("python") + 2).mode, "text");
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("escapeinside") + 2).mode, "text");
  const deferred = "\\newcommand{\\later}{\\makeatletter\\ExplSyntaxOn}\\outside@name\\outside_name:n";
  const d = await parse(deferred);
  expectRole(d, deferred, "@name", "text");
  expectRole(d, deferred, "_name:n", "text");
});

test("comment package requires its own exact closing line", async () => {
  // comment.sty 3.8 documents: no starting spaces, nothing after the command.
  const text = "\\begin{comment}\n \\end{comment}\n\\section{Fake 1}\n\\end{comment} extra\n\\section{Fake 2}\n\\end{comment}\n\\section{Real}";
  const r = await parse(text);
  assert.deepEqual(r.data.outline.map(x => x.title), ["Real"]);
  expectRole(r, text, "\\section{Fake 1}", "literal");
  expectRole(r, text, "\\section{Fake 2}", "literal");
});

test("control-symbol and astral-letter definitions retain raw symbol ranges", async () => {
  const text = "😀\r\n\\newcommand{\\!}{ok}\\def\\𐐀é#1{#1}\\𐐀é{value}";
  const r = await parse(text);
  assert.deepEqual(r.data.symbols.map(x => [x.name, text.slice(x.from, x.to)]), [["!", "\\!"], ["𐐀é", "\\𐐀é"]]);
  expectRole(r, text, "\\!", "definition");
  expectRole(r, text, "\\𐐀é", "definition");
  expectRole(r, text, "\\𐐀é", "command", text.lastIndexOf("\\𐐀é"));
  for (const symbol of r.data.symbols) assert.equal(r.adapter.contextAt(r.tree, r.doc, symbol.from + 1).certainty, "exact");
});

test("static profile changes and long environment headers cannot reuse stale lexical modes", async () => {
  const { TreeFragment } = await import("@lezer/common");
  const text = "{\\iris@name \\iris_name:n} ".repeat(400);
  const standard = await load(), old = standard.language.parser.parse(text);
  for (const texProfile of ["internal", "expl3"]) {
    const a = await load({ texProfile }), tree = a.language.parser.parse(text, TreeFragment.addTree(old)), fresh = a.language.parser.parse(text);
    assert.deepEqual(nodes(tree), nodes(fresh));
    assert.deepEqual(await roles(tree, text.length), await roles(fresh, text.length));
  }
  const name = "custom".repeat(800);
  let s = `{prefix}\\begin{${name}}` + "{body} ".repeat(1000) + `\\end{${name}}\\section{Tail}`;
  let tree = standard.language.parser.parse(s);
  for (const [from, to, insert] of [[0, 0, " "], [1, 1, "\\makeatletter "], [1, 15, ""]]) {
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
    s = s.slice(0, from) + insert + s.slice(to);
    tree = standard.language.parser.parse(s, fragments);
    const fresh = standard.language.parser.parse(s);
    assert.deepEqual(nodes(tree), nodes(fresh));
    assert.deepEqual(standard.summarize(tree, source(s)), standard.summarize(fresh, source(s)));
    assert.deepEqual(standard.summarize(tree, source(s)).outline.map(x => x.title), ["Tail"]);
  }
});

test("math argument caret contexts agree with text tokens, including nested options", async () => {
  const text = "$x\\cite[outer [inner]]{one}\\ref{key}\\includegraphics{file.pdf}[y]$";
  const r = await parse(text);
  for (const [needle, argumentRole] of [["inner", "text"], ["one", "citation-list"], ["key", "reference"], ["file.pdf", "path"]]) {
    const context = r.adapter.contextAt(r.tree, r.doc, text.indexOf(needle) + 1);
    assert.equal(context.mode, "text", needle);
    assert.equal(context.argumentRole, argumentRole, needle);
    assert.equal(context.certainty, "exact", needle);
  }
  assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("y]")).mode, "math", "ordinary math brackets do not create a text argument");
});

test("literal environment names survive whitespace at token chunk boundaries", async () => {
  const name = "a".repeat(256) + " middle " + "b".repeat(300);
  const text = `\\begin \r\n{${name}}body\\end {${name}}`;
  const r = await parse(text);
  assert.deepEqual(nodes(r.tree).filter(x => x[0] === "⚠"), []);
  assert.deepEqual(r.data.regions.filter(x => x.kind === "environment").map(x => [x.name, x.to, x.certainty]), [[name, text.length, "exact"]]);
});

test("every short corpus prefix and repair has incremental tree/role/summary/context parity", async () => {
  const { TreeFragment } = await import("@lezer/common");
  const a = await load();
  for (const fixture of cases) {
    const full = await fs.readFile(path.join(__dirname, "fixtures/languages", fixture.file), "utf8");
    let text = "", tree = a.language.parser.parse(text);
    for (let end = 1; end <= full.length; end++) {
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: text.length, toA: text.length, fromB: text.length, toB: end }]);
      text = full.slice(0, end);
      tree = a.language.parser.parse(text, fragments);
      const fresh = a.language.parser.parse(text);
      assert.deepEqual(nodes(tree), nodes(fresh), `${fixture.id} prefix ${end}`);
      assert.deepEqual(await roles(tree, end), await roles(fresh, end));
      assert.deepEqual(a.summarize(tree, source(text)), a.summarize(fresh, source(text)));
      assert.deepEqual(a.contextAt(tree, source(text), end), a.contextAt(fresh, source(text), end));
    }
  }
});

test("profile/header/definition repair edits preserve meaning AND actual subtree identity beyond 4096 units", async t => {
  const { TreeFragment } = await import("@lezer/common");
  const a = await load();
  let text = "{plain} ".repeat(700) + "{\\makeatletter\\def\\a@b{\\section{Hidden}}\\a@b}\\begin{align}x_2\\text{words $z$}\\end{align}\\section{End}";
  let tree = a.language.parser.parse(text), reused = 0;
  const edits = [s => [s.indexOf("makeatletter"), 12, "makeatother"], s => [s.indexOf("makeatother"), 11, "makeatletter"], s => [s.indexOf("\\end{align}"), 11, ""], s => [s.indexOf("\\section{End}"), 0, "\\end{align}"], s => [s.indexOf("Hidden") + 6, 1, ""], s => [s.indexOf("Hidden") + 6, 0, "}"], () => [0, 0, "\\ExplSyntaxOn\n"], () => [0, 14, ""]];
  for (const edit of edits) {
    const [from, count, insert] = edit(text), previous = tree;
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: from + count, fromB: from, toB: from + insert.length }]);
    text = text.slice(0, from) + insert + text.slice(from + count);
    tree = a.language.parser.parse(text, fragments);
    const fresh = a.language.parser.parse(text), shared = sharedTrees(previous, tree);
    reused += shared;
    if (from > 5000) assert.ok(shared > 0, "unaffected prefix must really be reused");
    assert.deepEqual(nodes(tree), nodes(fresh));
    assert.deepEqual(await roles(tree, text.length), await roles(fresh, text.length));
    assert.deepEqual(a.summarize(tree, source(text)), a.summarize(fresh, source(text)));
    for (const pos of [0, 1600, from, text.length]) assert.deepEqual(a.contextAt(tree, source(text), pos), a.contextAt(fresh, source(text), pos));
  }
  assert.ok(reused > 0);
  t.diagnostic(`${reused} shared nonempty Tree identities across ${edits.length} edits`);
});

test("R1 literal closing-line prefix edits invalidate stale fragments and retain real reuse", async t => {
  const { TreeFragment } = await import("@lezer/common"), a = await load();
  for (const spaces of [5000, 12000]) for (const stableTail of [false, true]) {
    let text = "\\begin{minted}{tex}\nX" + " ".repeat(spaces) + "\\end{minted}\n\\section{Visible}\n" + "literal body ".repeat(800) + "\n\\end{minted}\n\\section{Tail}" + (stableTail ? "{unchanged} ".repeat(600) : "");
    let tree = a.language.parser.parse(text);
    const at = text.indexOf("X"), visible = text.indexOf("\\section{Visible}");
    for (const insert of [" ", "X", " "]) {
      const previous = tree;
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: at, toA: at + 1, fromB: at, toB: at + 1 }]);
      text = text.slice(0, at) + insert + text.slice(at + 1);
      tree = a.language.parser.parse(text, fragments);
      const fresh = a.language.parser.parse(text), count = sharedTrees(previous, tree);
      sameNodes(tree, fresh);
      assert.deepEqual(await roles(tree, text.length), await roles(fresh, text.length));
      assert.deepEqual(a.summarize(tree, source(text)), a.summarize(fresh, source(text)));
      assert.deepEqual(a.summarize(tree, source(text)).outline.map(x => x.title), insert === " " ? ["Visible", "Tail"] : ["Tail"]);
      assert.equal(a.contextAt(tree, source(text), visible).mode, insert === " " ? "text" : "literal");
      assert.deepEqual(a.contextAt(tree, source(text), visible), a.contextAt(fresh, source(text), visible));
      if (stableTail) assert.ok(count > 0, "the unaffected suffix must retain actual Tree identities; the reclassified literal body cannot");
      t.diagnostic(`R1 ${spaces} spaces, stable tail=${stableTail}, ${JSON.stringify(insert)}: ${count} shared trees`);
    }
  }
});

test("R2 prototype names are ordinary custom environments in adapter and guarded EditorState", async () => {
  const { EditorState } = await import("@codemirror/state"), { ensureSyntaxTree } = await import("@codemirror/language");
  const { createTexHighlighting } = await import("../public/iris-tex-highlighting.mjs"), extension = await createTexHighlighting();
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const text = `\\begin{${name}}x\\end{${name}}`;
    const r = await parse(text), state = EditorState.create({ doc: text, extensions: [extension()] });
    assert.deepEqual(r.data.regions.map(x => [x.kind, x.name, x.from, x.to, x.certainty]), [["environment", name, 0, text.length, "exact"]]);
    assert.deepEqual(nodes(ensureSyntaxTree(state, text.length, 1000)), nodes(r.tree));
  }
});

test("R3 primitive parameter control sequences and bracket delimiters cannot execute stored bodies", async () => {
  for (const command of ["def", "gdef", "edef", "xdef", "cs_new:Npn"]) for (const parameters of ["#1\\stop", "[#1]", "#1\\section[#2]\\stop", "$#1$"]) {
    const text = (command.includes(":") ? "\\ExplSyntaxOn " : "") + `\\${command}\\foo${parameters}{\\section{Fake}\\label{fake}\\ref{fake}\\input{fake.tex}}\\section{Real}`;
    const r = await parse(text);
    assert.deepEqual(r.data.outline.map(x => [x.num, x.title]), [["1", "Real"]], text);
    assert.deepEqual(r.data.symbols.map(x => [x.kind, x.name]), [["command", "foo"]]);
    assert.deepEqual(r.data.references, []);
    assert.deepEqual(r.data.includes, []);
    assert.ok(nodes(r.tree).some(x => x[0] === "BodyGroup"));
  }
});

test("R4 stored default arguments suppress structure, records and profile effects", async () => {
  for (const command of ["newcommand", "renewcommand", "providecommand", "DeclareRobustCommand", "newenvironment", "renewenvironment"]) {
    const env = command.endsWith("environment");
    const text = `\\${command}{${env ? "box" : "\\foo"}}[1][\\section{Fake}\\label{fake}\\ref{fake}\\input{fake.tex}\\makeatletter]{#1}${env ? "{}" : ""}\\outside@name\\section{Real}`;
    const r = await parse(text);
    assert.deepEqual(r.data.outline.map(x => [x.num, x.title]), [["1", "Real"]], command);
    assert.deepEqual(r.data.symbols.map(x => x.name), [env ? "box" : "foo"]);
    assert.deepEqual(r.data.references, []);
    assert.deepEqual(r.data.includes, []);
    expectRole(r, text, "@name", "text");
    expectRole(r, text, "\\section", "structure");
  }
});

test("R7 dynamic argument certainty rejects unsupported syntax even when its nodes are recognized", async () => {
  for (const argument of ["\\begin{a}x\\end{a}", "\\verb|foo|", "a~b.tex", "a\\verb|x|", "{grouped}", "\\text{word}", "$x$", "#1"]) {
    for (const command of ["input", "ref", "cite"]) {
      const text = `\\${command}{${argument}}`, r = await parse(text);
      const records = command === "input" ? r.data.includes : r.data.references;
      assert.equal(records.length, 1, text);
      assert.equal(records[0].certainty, "unknown", text);
      assert.equal(records[0].path || records[0].name, argument);
      assert.equal(r.adapter.contextAt(r.tree, r.doc, text.indexOf("{") + 1).certainty, "unknown", text);
    }
  }
});

test("R8 scalar reference signatures preserve a comma-containing label and raw range", async () => {
  for (const command of ["ref", "pageref", "eqref", "autoref", "nameref", "vref", "Vref"]) {
    const text = `😀\r\n\\label{a,b}\\${command}{a,b}`, r = await parse(text), from = text.lastIndexOf("a,b");
    assert.deepEqual(r.data.references, [{ kind: "label", name: "a,b", from, to: from + 3, certainty: "exact" }]);
    assert.equal(r.adapter.contextAt(r.tree, r.doc, from).argumentRole, "reference");
  }
  const r = await parse("\\cref{a,b}\\Cref{c,d}\\cpageref{e,f}");
  assert.deepEqual(r.data.references.map(x => x.name), ["a", "b", "c", "d", "e", "f"]);
});

test("R9 comments are incremental begin/end header trivia, with exact offsets and math roles", async () => {
  const { TreeFragment } = await import("@lezer/common"), a = await load();
  let text = "{stable} ".repeat(700) + "\\begin% first\r\n % second\n{align}x_2\\end% finish\r\n{align}\\section{Tail}";
  let tree = a.language.parser.parse(text);
  for (const insert of ["", "% extra\n"]) {
    const at = text.indexOf("{align}");
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: at, toA: at, fromB: at, toB: at + insert.length }]);
    text = text.slice(0, at) + insert + text.slice(at);
    const previous = tree; tree = a.language.parser.parse(text, fragments);
    const fresh = a.language.parser.parse(text), data = a.summarize(tree, source(text));
    assert.deepEqual(nodes(tree), nodes(fresh));
    assert.deepEqual(await roles(tree, text.length), await roles(fresh, text.length));
    assert.deepEqual(data, a.summarize(fresh, source(text)));
    assert.deepEqual(data.regions.filter(x => x.kind === "environment").map(x => [x.name, x.certainty, x.from, x.to]), [["align", "exact", text.indexOf("\\begin"), text.indexOf("\\section")]]);
    assert.deepEqual((await roles(tree, text.length)).slice(text.indexOf("x_2"), text.indexOf("x_2") + 3), ["math", "operator", "number"]);
    assert.equal(a.contextAt(tree, source(text), text.indexOf("first")).mode, "comment");
    assert.ok(sharedTrees(previous, tree) > 0);
  }
});

// Count real cursor operations as well as elapsed time: a fast CI machine must
// not hide a document-sized synchronous walk. Restore instrumentation per test.
async function countCursorWork(run) {
  const { TreeCursor } = await import("@lezer/common");
  const originals = {}, work = { count: 0 };
  for (const name of ["next", "firstChild", "nextSibling", "parent"]) {
    originals[name] = TreeCursor.prototype[name];
    TreeCursor.prototype[name] = function(...args) { work.count++; return originals[name].apply(this, args); };
  }
  try { return await run(work); }
  finally { for (const name of Object.keys(originals)) TreeCursor.prototype[name] = originals[name]; }
}

test("R5 long headers make bounded input progress and first large-group reuse avoids a bulk leaf replay", async t => {
  const a = await load(), { TreeFragment } = await import("@lezer/common");
  for (const length of [100000, 900000]) {
    const text = "\\begin{" + "a".repeat(length) + "}x";
    let readTo = 0;
    const input = { length: text.length, lineChunks: false, chunk(pos) { readTo = Math.max(readTo, Math.min(pos + 512, text.length)); return text.slice(pos, pos + 512); }, read(from, to) { readTo = Math.max(readTo, to); return text.slice(from, to); } };
    const parse = a.language.parser.startParse(input);
    let tree, maxLead = 0, maxMs = 0, steps = 0;
    while (!tree) {
      const before = parse.parsedPos, start = performance.now(); tree = parse.advance();
      maxMs = Math.max(maxMs, performance.now() - start); steps++;
      maxLead = Math.max(maxLead, readTo - Math.max(before, parse.parsedPos));
      assert.ok(readTo - Math.max(before, parse.parsedPos) <= 4096, `header read ${readTo} while parsed ${parse.parsedPos}`);
    }
    assert.equal(tree.length, text.length);
    const data = a.summarize(tree, source(text));
    assert.equal(data.regions[0].name.length, length, "no truncated long names");
    t.diagnostic(`R5 header ${length}: ${steps} advances, max input lead ${maxLead}, max advance ${maxMs.toFixed(3)}ms`);
  }
  const text = "{" + "{a} ".repeat(80000) + "}" + " tail ".repeat(1000), old = a.language.parser.parse(text);
  const at = text.length - 2, edited = text.slice(0, at) + "x" + text.slice(at + 1);
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(old), [{ fromA: at, toA: at + 1, fromB: at, toB: at + 1 }]);
  let tree, maxWork = 0, maxMs = 0;
  await countCursorWork(async work => {
    const parse = a.language.parser.startParse(edited, fragments);
    while (!tree) {
      work.count = 0; const start = performance.now(); tree = parse.advance();
      maxMs = Math.max(maxMs, performance.now() - start); maxWork = Math.max(maxWork, work.count);
      assert.ok(work.count <= 4096, `one advance traversed ${work.count} cursor operations`);
    }
  });
  assert.ok(sharedTrees(old, tree) > 0);
  const largeGroup = node => node.type?.name === "Group" && node.length === 320002 ? node :
    (node.children || []).filter(child => child.children).map(largeGroup).find(Boolean);
  assert.ok(largeGroup(old));
  assert.equal(largeGroup(tree), largeGroup(old), "the original 320002-unit Group itself must survive by identity");
  assert.deepEqual(nodes(tree), nodes(a.language.parser.parse(edited)));
  t.diagnostic(`R5 large-group first reuse: ${sharedTrees(old, tree)} shared trees; max ${maxWork} cursor operations/advance; max ${maxMs.toFixed(3)}ms`);
});

test("R6 record extraction yields bounded pieces and cold/warm caret certainty has bounded work", async t => {
  const a = await load();
  for (const [text, expected] of [["\\bibliography{" + "a,".repeat(200000) + "a}", 200001], ["\\input{" + "{a}".repeat(100000) + "}", 1]]) {
    const tree = a.language.parser.parse(text);
    let readUnits = 0, maxRead = 0;
    const doc = { length: text.length, sliceString(from, to) { readUnits += to - from; maxRead = Math.max(maxRead, to - from); return text.slice(from, to); } };
    await countCursorWork(async work => {
      const pos = text.indexOf("{") + 1;
      work.count = 0; readUnits = 0;
      const coldStart = performance.now(), cold = a.contextAt(tree, doc, pos), coldMs = performance.now() - coldStart, coldWork = work.count;
      assert.ok(coldWork <= 512, `cold caret walked ${coldWork} nodes`);
      assert.ok(readUnits <= 4096, `cold caret read ${readUnits} units`);
      assert.ok(["unknown", "exact"].includes(cold.certainty));
      const steps = a.summarySteps(tree, doc);
      let result, turns = 0, maxWork = 0, maxMs = 0;
      for (;;) {
        work.count = 0; readUnits = 0; const start = performance.now();
        const step = steps.next(); maxMs = Math.max(maxMs, performance.now() - start); turns++;
        maxWork = Math.max(maxWork, work.count);
        assert.ok(work.count <= 4096, `summary step walked ${work.count} nodes`);
        assert.ok(readUnits <= 4096, `summary step read ${readUnits} units`);
        if (step.done) { result = step.value; break; }
      }
      assert.equal(result.includes.length, expected);
      assert.ok(turns > text.length / 4096, "record work must yield rather than run as one step");
      work.count = 0; readUnits = 0;
      const warmStart = performance.now(), warm = a.contextAt(tree, doc, pos), warmMs = performance.now() - warmStart;
      assert.ok(work.count <= 512 && readUnits <= 4096);
      assert.equal(warm.certainty, expected === 1 ? "unknown" : "exact");
      if (expected > 1) {
        assert.deepEqual(result.includes[0], { path: "a", from: 14, to: 15, certainty: "exact" });
        assert.equal(result.includes.at(-1).to, text.length - 1);
      }
      t.diagnostic(`R6 ${text.length} units: ${turns} yields/steps, max ${maxWork} cursor operations, max read ${maxRead}, max step ${maxMs.toFixed(3)}ms, cold caret ${coldWork} operations/${coldMs.toFixed(3)}ms, warm caret ${warmMs.toFixed(3)}ms`);
    });
  }
});

test("R5 closing names and literal trailing-line validation progress in chunks", async t => {
  const a = await load();
  for (const text of [
    "\\begin{" + "a".repeat(400000) + "}x\\end% trivia\r\n{" + "a".repeat(400000) + "}",
    "\\begin{minted}{tex}\n\\end{minted}" + " ".repeat(100000) + "extra\n\\section{Fake}\n\\end{minted}\n\\section{Real}",
  ]) {
    let readTo = 0, maxLead = 0;
    const input = { length: text.length, lineChunks: false, chunk(pos) { readTo = Math.max(readTo, Math.min(pos + 512, text.length)); return text.slice(pos, pos + 512); }, read(from, to) { readTo = Math.max(readTo, to); return text.slice(from, to); } };
    const partial = a.language.parser.startParse(input);
    let tree;
    while (!tree) {
      const before = partial.parsedPos; tree = partial.advance();
      maxLead = Math.max(maxLead, readTo - Math.max(before, partial.parsedPos));
      assert.ok(readTo - Math.max(before, partial.parsedPos) <= 4096);
    }
    const data = a.summarize(tree, source(text));
    if (text.includes("minted")) assert.deepEqual(data.outline.map(x => x.title), ["Real"]);
    else assert.deepEqual(data.regions.map(x => [x.name.length, x.certainty, x.to]), [[400000, "exact", text.length]]);
    t.diagnostic(`R5 closing/tail ${text.length} units: max input lead ${maxLead}`);
  }
});

test("compositional reuse preserves outside-group profile effects and primitive argument lifetime", async () => {
  const a = await load(), { TreeFragment } = await import("@lezer/common");
  let text = ("{keep} \\makeatletter\\def\\a@b#1\\stop{#1}\\a@b \\makeatother ").repeat(160) + "\\section{Tail}";
  let tree = a.language.parser.parse(text);
  for (const [from, to, insert] of [[0, 0, " "], [1, 1, "%\n"], [0, 3, ""], [text.length - 2, text.length - 2, "x"]]) {
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
    text = text.slice(0, from) + insert + text.slice(to);
    const previous = tree; tree = a.language.parser.parse(text, fragments);
    const fresh = a.language.parser.parse(text);
    sameNodes(tree, fresh);
    assert.deepEqual(await roles(tree, text.length), await roles(fresh, text.length));
    assert.deepEqual(a.summarize(tree, source(text)), a.summarize(fresh, source(text)));
    assert.equal(a.summarize(tree, source(text)).symbols.length, 160);
    assert.ok(sharedTrees(previous, tree) > 0);
  }
});

test("cold caret certainty uses one total budget through nested large arguments", async () => {
  const a = await load();
  let text = "x";
  for (let i = 0; i < 20; i++) text = "\\input{" + "a ".repeat(256) + text + "}";
  const tree = a.language.parser.parse(text);
  await countCursorWork(async work => {
    work.count = 0;
    assert.equal(a.contextAt(tree, source(text), text.indexOf("x")).certainty, "unknown");
    assert.ok(work.count <= 512, `nested argument certainty used ${work.count} cursor operations`);
  });
});

test("long intervening argument trivia remains recognized by cooperative summary traversal", async () => {
  const text = "\\section" + "% trivia\n".repeat(1000) + "{Title}\\input" + "% path\n".repeat(1000) + "{file.tex}";
  const r = await parse(text);
  assert.deepEqual(r.data.outline.map(x => x.title), ["Title"]);
  assert.deepEqual(r.data.includes.map(x => x.path), ["file.tex"]);
});

test("literal header trivia carries its line prefix into an empty body", async () => {
  for (const name of ["Verbatim", "BVerbatim", "LVerbatim", "lstlisting"]) for (const header of ["", "[numbers=left]", "\n[numbers=left]", "% ignored"]) {
    const text = `\\begin{${name}}${header}\r\n  \\end{${name}}\n\\section{Real}`, r = await parse(text);
    assert.deepEqual(r.data.outline.map(x => x.title), ["Real"], text);
    assert.deepEqual(r.data.regions.filter(x => x.kind === "literal").map(x => [x.certainty, x.openEnded]), [["exact", false]]);
    assert.deepEqual(nodes(r.tree).filter(x => x[0] === "⚠"), []);
  }
});

for (const [label, text, inner] of [
  ["ancestor close through recovered children", "\\begin{a}\\begin{b}\\begin{c}x\\end{a}\\section{Tail}", [["b", 9, 28], ["c", 18, 28]]],
  ["earlier orphan close is not the recovery boundary", "\\begin{a}\\begin{b}x\\end{z} y\\end{a}\\section{Tail}", [["b", 9, 28]]],
]) test(`FR1-1 ${label}`, async () => {
  const a = await load(), doc = source(text), tree = a.language.parser.parse(text);
  assert.equal(text.indexOf("\\end{a}"), 28);
  const data = a.summarize(tree, doc);
  assert.deepEqual(data.regions.filter(x => x.kind === "environment").map(x => [x.name, x.from, x.to, x.certainty, x.openEnded]),
    [["a", 0, 35, "recovered", false], ...inner.map(row => [...row, "recovered", false])]);
  assert.deepEqual(data.outline.map(x => [x.title, x.offset]), [["Tail", 35]]);
  const steps = a.summarySteps(tree, doc);
  let cooperative;
  for (;;) { const step = steps.next(); if (step.done) { cooperative = step.value; break; } }
  assert.deepEqual(cooperative, data);
});

test("FR1-1 endpoint propagation stops at a normally closed environment and stays cooperative", async () => {
  const a = await load();
  const text = "\\begin{a}\\begin{b}\\begin{c}x\\end{c} y" + "\\end{z} ".repeat(1000) + "\\begin{d}z\\end{a}\\section{Tail}";
  const tree = a.language.parser.parse(text), doc = source(text), end = text.indexOf("\\end{a}"), steps = a.summarySteps(tree, doc);
  await countCursorWork(async work => {
    let data, turns = 0;
    for (;;) {
      work.count = 0; const step = steps.next(); turns++;
      assert.ok(work.count <= 128, `endpoint query step used ${work.count} cursor operations`);
      if (step.done) { data = step.value; break; }
    }
    assert.ok(turns > 1000, "traversal must yield through the orphan headers");
    assert.deepEqual(data.regions.filter(x => x.kind === "environment").map(x => [x.name, x.to, x.certainty, x.openEnded]),
      [["a", end + 7, "recovered", false], ["b", end, "recovered", false], ["c", 35, "exact", false], ["d", end, "recovered", false]]);
  });
});

test("FR1-2 definition roles agree with symbols across 127/128 header-trivia siblings", async () => {
  const a = await load();
  for (const count of [127, 128, 129, 1000]) for (const [command, declared, kind, role] of [
    ["newenvironment", "box", "environment", "definition-environment"],
    ["newcommand", "\\box", "command", "definition-command"],
  ]) {
    const text = `\\${command}` + "% trivia\n".repeat(count) + `{${declared}}{}{}`, tree = a.language.parser.parse(text), doc = source(text);
    const from = text.indexOf("{"), pos = text.indexOf("box");
    const context = a.contextAt(tree, doc, pos);
    assert.equal(context.argumentRole, role, `${command}, ${count} comments`);
    assert.equal(context.certainty, "exact");
    if (kind === "environment") assert.deepEqual([context.from, context.to], [from, from + 5]);
    assert.deepEqual(a.summarize(tree, doc).symbols.map(x => [x.kind, x.name, x.certainty]), [[kind, "box", "exact"]]);
  }
});

test("FR1-2 exhausted definition-role lookup is conservative rather than falsely exact", async () => {
  const a = await load();
  const text = "\\newenvironment" + "% trivia\n".repeat(128) + "{" + " ".repeat(256 * 129) + "box}{}{}";
  const tree = a.language.parser.parse(text), doc = source(text), context = a.contextAt(tree, doc, text.indexOf("box"));
  assert.equal(context.argumentRole, null, "the exhausted bounded lookup must not invent a declaration role");
  assert.equal(context.certainty, "unknown");
  assert.deepEqual(a.summarize(tree, doc).symbols.map(x => [x.kind, x.name]), [["environment", "box"]]);
});
