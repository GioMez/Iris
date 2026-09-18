const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const helperFile = path.join(__dirname, "helpers/language-fixtures.cjs");
const helpers = fs.existsSync(helperFile) ? require(helperFile) : {};
function helper(name) {
  assert.equal(typeof helpers[name], "function", `missing fixture helper: ${name}`);
  return helpers[name];
}

// Hand-labelled independent input: A=0, emoji=[1,3), LF=3, %=4, x=5.
function specimen() {
  return {
    id: "probe", kind: "tex", file: "probe.tex", expectations: "target",
    origin: { type: "synthetic", author: "Iris contributors", license: "CC0-1.0" },
    syntax: "LaTeX2e", validity: { status: "complete", note: "Lexical fragment." },
    requirements: ["TX-01"],
    roles: [{ from: 1, to: 3, role: "text", text: "😀", requirement: "TX-01" },
      { from: 4, to: 6, role: "comment", text: "%x", requirement: "TX-01" }],
    contexts: [{ pos: 4, mode: "text", before: "\n", after: "%x", requirement: "TX-01" }],
    outline: [],
  };
}
const specimenSource = "A😀\n%x";
function fixtureRoot(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, "language-fixture-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "probe.tex"), specimenSource);
  fs.writeFileSync(path.join(directory, "cases.json"), JSON.stringify([specimen()]));
  return directory;
}

test("loader preserves raw Unicode and reports bytes, UTF-16 length and lines separately", (t) => {
  const cases = helper("loadFixtures")(fixtureRoot(t));
  assert.equal(cases.length, 1);
  assert.equal(cases[0].source, "A😀\n%x");
  assert.deepEqual(cases[0].metrics, { bytes: 8, codeUnits: 6, lines: 2 });
});

test("validator accepts adjacent roles but rejects overlapping or duplicated roles", () => {
  const validate = helper("validateCase");
  assert.doesNotThrow(() => validate(specimen(), specimenSource));
  const adjacent = specimen();
  adjacent.roles.unshift({ from: 0, to: 1, role: "text", text: "A", requirement: "TX-01" });
  assert.doesNotThrow(() => validate(adjacent, specimenSource));
  for (const extra of [
    { from: 0, to: 3, role: "literal", text: "A😀", requirement: "TX-01" },
    { ...specimen().roles[0] },
  ]) {
    const item = specimen(); item.roles.push(extra);
    assert.throws(() => validate(item, specimenSource), /overlap/i);
  }
});

test("range validation rejects zero, reversed, fractional, outside and surrogate-split endpoints", () => {
  const validate = helper("validateCase");
  for (const [from, to] of [[1, 1], [3, 1], [-1, 1], [1, 7], [1.5, 3], [1, 2], [2, 3]]) {
    const item = specimen(); item.roles = [{ ...item.roles[0], from, to, text: specimenSource.slice(from, to) }];
    assert.throws(() => validate(item, specimenSource), /range|surrogate/i, `${from}:${to}`);
  }
});

test("mismatched role text and caret anchors cannot silently drift after fixture edits", () => {
  const validate = helper("validateCase");
  for (const mutate of [
    item => { item.roles[0].text = "wrong"; },
    item => { item.contexts[0].before = "A"; },
    item => { item.contexts[0].after = "wrong"; },
    item => { item.contexts[0].pos = 2; },
    item => { item.contexts[0].pos = -1; },
    item => { item.contexts[0].pos = 7; },
    item => { item.contexts[0].pos = 1.5; },
    item => { item.contexts.push({ ...item.contexts[0] }); },
  ]) {
    const item = specimen(); mutate(item);
    assert.throws(() => validate(item, specimenSource), /text|anchor|caret|surrogate|duplicate/i);
  }
});

test("validator rejects unknown roles, modes, requirements and incomplete provenance", () => {
  const validate = helper("validateCase");
  for (const mutate of [
    item => { item.kind = "bib"; }, item => { item.roles[0].role = "cmd"; },
    item => { item.contexts[0].mode = "unknown"; }, item => { item.requirements = ["TX-99"]; },
    item => { item.roles[0].requirement = "LY-01"; }, item => { item.requirements.push("TX-02"); },
    item => { item.origin.license = ""; }, item => { delete item.validity; },
    item => { item.syntax = ""; }, item => { item.expectations = "current"; },
    item => { item.outline = [42]; }, item => { item.roles = null; },
  ]) {
    const item = specimen(); mutate(item);
    assert.throws(() => validate(item, specimenSource));
  }
});

test("fixture EOL and Unicode policy fails explicitly instead of renumbering offsets", () => {
  const validate = helper("validateCase");
  for (const source of ["A😀\r\n%x", "A😀\r%x", "A\ud83d\n%x", "A\ude00\n%x", "\ufeffA😀\n%x"]) {
    assert.throws(() => validate(specimen(), source), /LF|Unicode|BOM/i);
  }
});

test("manifest rejects duplicate IDs and normalized file aliases", (t) => {
  const validate = helper("validateManifest"), root = fixtureRoot(t);
  assert.throws(() => validate({}, root), /array/i);
  assert.throws(() => validate([], root), /empty/i);
  assert.throws(() => validate([specimen(), specimen()], root), /duplicate.*id/i);
  for (const file of ["./probe.tex", ".\\probe.tex", "PROBE.TEX"]) {
    assert.throws(() => validate([specimen(), { ...specimen(), id: "second", file }], root), /duplicate.*file/i);
  }
});

test("loader contains POSIX and Windows paths including real symlink targets", (t) => {
  const resolve = helper("resolveFixturePath"), root = fixtureRoot(t);
  assert.equal(resolve(root, ".\\probe.tex"), path.join(root, "probe.tex"));
  for (const file of ["../probe.tex", "..\\probe.tex", "/probe.tex", "C:\\probe.tex", "C:probe.tex", "\\\\server\\share\\probe.tex", "", ".", "probe.tex:stream"]) {
    assert.throws(() => resolve(root, file), /path|contain|relative/i, file);
  }
  fs.mkdirSync(path.join(root, "inside"));
  fs.mkdirSync(path.join(root, "outside"));
  fs.writeFileSync(path.join(root, "outside/probe.tex"), specimenSource);
  fs.symlinkSync(path.join(root, "outside"), path.join(root, "inside/link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolve(path.join(root, "inside"), "link/probe.tex"), /contain/i);
});

test("loader rejects extension mismatch and malformed JSON", (t) => {
  const root = fixtureRoot(t);
  assert.throws(() => helper("validateManifest")([{ ...specimen(), kind: "ly" }], root), /extension/i);
  fs.writeFileSync(path.join(root, "cases.json"), "[broken");
  assert.throws(() => helper("loadFixtures")(root), /JSON/i);
});

test("loader rejects malformed UTF-8 and duplicate files reached through symlinks", (t) => {
  const load = helper("loadFixtures"), validate = helper("validateManifest"), root = fixtureRoot(t);
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested/probe.tex"), specimenSource);
  fs.symlinkSync(path.join(root, "nested"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => validate([
    { ...specimen(), file: "nested/probe.tex" },
    { ...specimen(), id: "second", file: "alias/probe.tex" },
  ], root), /duplicate.*file/i);
  fs.writeFileSync(path.join(root, "probe.tex"), Buffer.from([0xc3, 0x28]));
  assert.throws(() => load(root), /encoded data|UTF-8/i);
});

test("target region annotations allow nesting but reject crossed, duplicate and drifting ranges", () => {
  const validate = helper("validateCase");
  const item = specimen();
  item.regions = [
    { from: 0, to: 6, label: "outer", text: "A😀\n%x", requirement: "TX-01" },
    { from: 1, to: 3, label: "inner", text: "😀", requirement: "TX-01" },
  ];
  assert.doesNotThrow(() => validate(item, specimenSource));
  for (const mutate of [
    regions => { regions[1].to = 2; },
    regions => { regions[1].text = "wrong"; },
    regions => { regions[1].label = ""; },
    regions => { regions[1].requirement = "LY-01"; },
    regions => { regions.push({ ...regions[1] }); },
    regions => { regions[0].to = 5; regions[0].text = "A😀\n%"; regions[1].to = 6; regions[1].text = "😀\n%x"; },
  ]) {
    const changed = structuredClone(item); mutate(changed.regions);
    assert.throws(() => validate(changed, specimenSource), /region|range|text|label|requirement|cross|duplicate/i);
  }
});

test("checked-in manifest covers all requirement IDs and every original language fixture", () => {
  const cases = helper("loadFixtures")();
  assert.deepEqual([...new Set(cases.flatMap(item => item.requirements))].sort(), [
    "LY-01", "LY-02", "LY-03", "LY-04", "LY-05", "LY-06", "LY-07", "LY-08",
    "TX-01", "TX-02", "TX-03", "TX-04", "TX-05", "TX-06", "TX-07", "TX-08", "TX-09",
  ]);
  const files = fs.readdirSync(helpers.FIXTURE_ROOT).filter(file => /\.(tex|ly|ily)$/.test(file)).sort();
  assert.deepEqual(cases.map(item => item.file).sort(), files, "every source needs provenance and annotations");
  for (const file of ["latex-core.tex", "latex-math.tex", "latex-literal.tex", "latex-macros.tex", "lilypond-core.ly", "lilypond-modes.ly", "lilypond-scheme.ly", "included.ily"]) {
    assert.ok(files.includes(file), file);
  }
  for (const item of cases) {
    assert.equal(item.expectations, "target");
    assert.ok(item.roles.length && item.contexts.length, item.id);
  }
});

test("mandatory comment and caret expectations are hand-derived data, independent of old parsers", () => {
  const item = helper("loadFixtures")().find(item => item.id === "latex-math");
  assert.equal(item.source, "$a % $ commento\nb$ testo\n");
  assert.deepEqual(item.roles.find(span => span.role === "comment"), {
    from: 3, to: 15, role: "comment", text: "% $ commento", requirement: "TX-02",
  });
  assert.equal(item.contexts.find(context => context.pos === 17).mode, "math");
  const shifted = structuredClone(item); shifted.roles.find(span => span.role === "comment").to++;
  assert.throws(() => helper("validateCase")(shifted, item.source), /text mismatch/);
});

test("baseline collector retains UTF-16 offsets and CRLF, CR, LF and blank lines", () => {
  const { StringStream } = require("@codemirror/language");
  const spec = {
    startState: () => ({ blank: 0 }),
    blankLine: state => { state.blank++; },
    token(stream, state) {
      assert.ok(stream instanceof StringStream);
      stream.skipToEnd(); return state.blank ? "after-blank" : "plain";
    },
  };
  const actual = helper("collectBaseline")(spec, "😀\r\n\rZ\n");
  assert.deepEqual(actual.tokens, [
    { from: 0, to: 2, style: "plain", line: 1 },
    { from: 5, to: 6, style: "after-blank", line: 3 },
  ]);
  assert.deepEqual(actual.lines, [
    { from: 0, to: 2, end: 4 }, { from: 4, to: 4, end: 5 },
    { from: 5, to: 6, end: 7 }, { from: 7, to: 7, end: 7 },
  ]);
  assert.deepEqual(actual.classes, ["plain", "plain", null, null, null, "after-blank", null]);
  assert.deepEqual(actual.metrics, { bytes: 9, codeUnits: 7, lines: 4 });
  assert.equal(actual.state.blank, 2);
});

test("baseline collector refuses stalled and out-of-line tokenizers", () => {
  const collect = helper("collectBaseline");
  for (const token of [() => null, stream => { stream.pos = 20; }, stream => { stream.pos = -1; }, stream => { stream.pos = 0.5; }]) {
    assert.throws(() => collect({ startState: () => ({}), token }, "abc"), /progress|boundary/i);
  }
});

for (const kind of ["tex", "ly"]) {
  for (const [bytes, singleLine] of [[102400, false], [1048576, false], [5242880, false], [102400, true]]) {
    test(`${kind} generator produces exactly ${bytes} UTF-8 bytes (${singleLine ? "single line" : "multiline"}) without cutting syntax or Unicode`, () => {
      const generate = helper("generateFixture");
      const actual = generate(kind, bytes, { singleLine });
      assert.equal(Buffer.byteLength(actual.source, "utf8"), bytes);
      assert.equal(actual.metrics.bytes, bytes);
      assert.equal(actual.metrics.codeUnits, actual.source.length);
      assert.equal(actual.metrics.lines, actual.source.split("\n").length);
      assert.ok(actual.source.isWellFormed());
      assert.ok(actual.source.includes("😀"));
      assert.ok(actual.metrics.codeUnits < actual.metrics.bytes);
      assert.equal(generate(kind, bytes, { singleLine }).source, actual.source);
      assert.equal(actual.source.includes("\r"), false);
      if (singleLine) assert.equal(actual.metrics.lines, 1);
      else assert.ok(actual.source.split("\n").every(line => line.length < 100));
      // Independently specified complete envelopes and repeated grammar units.
      if (kind === "tex") {
        assert.match(actual.source, /^\\documentclass\{article\}[\n ]\\begin\{document\}[\n ](?:Testo 😀: \$a_1\+\\alpha\$\.[\n ])* *\\end\{document\}[\n ]$/u);
      } else {
        assert.match(actual.source, /^\\version "2\.26\.0"[\n ]\\language "nederlands"[\n ]\{[\n ](?:c4 d8 e8 f2 \| %\{ frase 😀 %\}[\n ])* *\}[\n ]$/u);
      }
    });
  }
}

test("generator rejects impossible sizes and handles exact unit and padding boundaries", () => {
  const generate = helper("generateFixture");
  for (const bytes of [-1, 0, 10, 60.5, NaN, Infinity]) assert.throws(() => generate("tex", bytes), /size/i);
  assert.throws(() => generate("bib", 102400), /kind/i);
  // TeX envelope = 56 bytes; one Unicode unit = 26 bytes. Tail is whitespace,
  // so the 81/82/83-byte boundary cannot truncate an emoji or a math closer.
  assert.equal(generate("tex", 56).source, "\\documentclass{article}\n\\begin{document}\n\\end{document}\n");
  assert.equal(generate("tex", 81).source, "\\documentclass{article}\n\\begin{document}\n" + " ".repeat(25) + "\\end{document}\n");
  assert.equal(generate("tex", 82).source, "\\documentclass{article}\n\\begin{document}\nTesto 😀: $a_1+\\alpha$.\n\\end{document}\n");
  assert.equal(generate("tex", 83).source, "\\documentclass{article}\n\\begin{document}\nTesto 😀: $a_1+\\alpha$.\n \\end{document}\n");
  // LilyPond envelope = 45 bytes; one balanced music/comment unit = 31 bytes.
  const lyPrefix = '\\version "2.26.0"\n\\language "nederlands"\n{\n';
  assert.equal(generate("ly", 45).source, lyPrefix + "}\n");
  assert.equal(generate("ly", 75).source, lyPrefix + " ".repeat(30) + "}\n");
  assert.equal(generate("ly", 76).source, lyPrefix + "c4 d8 e8 f2 | %{ frase 😀 %}\n}\n");
  assert.equal(generate("ly", 77).source, lyPrefix + "c4 d8 e8 f2 | %{ frase 😀 %}\n }\n");
});
