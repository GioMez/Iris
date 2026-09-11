const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require("../public/iris-bibtex.js");

test("BibTeX retains native fields and exact source spans", () => {
  const text = "% note\r\n@book{key, title={A {B}}, x_note={kept}}\r\n";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.equal(result.text, text);
  const entry = result.entries[0];
  assert.equal(entry.key, "key");
  assert.equal(text.slice(entry.from, entry.to),
    "@book{key, title={A {B}}, x_note={kept}}");
  const field = entry.fields.find((item) => item.name === "x_note");
  assert.equal(text.slice(field.valueFrom, field.valueTo), "{kept}");
});

test("an interrupted entry never yields a valid partial bibliography", () => {
  const result = parse("@book{a,title={A}}\n@article{b,title={broken");
  assert.equal(result.status, "invalid");
  assert.equal(result.entries.length, 0);
  assert.ok(result.diagnostics.some((item) => item.severity === "error"));
});

test("browser and worker globals expose the same parser contract as CommonJS", () => {
  const source = fs.readFileSync(path.join(__dirname, "../public/iris-bibtex.js"), "utf8");
  const text = "@book{key,title={A}}";
  for (const context of [{ window: {} }, {}]) {
    vm.runInNewContext(source, context, { timeout: 1000 });
    const api = (context.window || context).IrisBibtex;
    assert.equal(typeof api.parse, "function");
    assert.deepEqual(JSON.parse(JSON.stringify(api.parse(text))), parse(text));
  }
});

test("empty input and external comments are empty bibliographies", () => {
  for (const text of ["", " \t\r\n", "\uFEFF", "\uFEFF % note\r\n% @book{notAnEntry,}", "% note\r% more\r"]) {
    const result = parse(text);
    assert.equal(result.status, "empty", JSON.stringify(text));
    assert.equal(result.format, "bib");
    assert.equal(result.text, text);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.directives, []);
    assert.deepEqual(result.diagnostics, []);
  }
});

test("foreign text anywhere prevents a partial projection without claiming corruption", () => {
  for (const text of [
    "not a bibliography", "TY  - JOUR\nER  -", "text @book{k,title={A}}",
    "@book{k,title={A}} text", "@book{k,title={A}}\ntext\n@book{b,title={B}}",
    " \uFEFF@book{k,}", "@book{k,}\uFEFF", "<script>alert(1)</script>",
  ]) {
    const result = parse(text);
    assert.equal(result.status, "unrecognized", text);
    assert.equal(result.format, null);
    assert.equal(result.text, text);
    assert.deepEqual(result.entries, []);
    assert.ok(result.diagnostics.some((item) => item.code === "bibtex.unrecognized" && item.severity === "warning"));
    assert.ok(result.diagnostics.every((item) => item.severity !== "error"));
  }
});

test("types and field names normalize case without losing custom names or source spelling", () => {
  const text = "@X-Record2 ( Key:One, TiTle = {A}, X_Custom.Note = {kept}, )";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.equal(result.format, "bib");
  const entry = result.entries[0];
  assert.equal(entry.type, "x-record2");
  assert.equal(text.slice(entry.typeRange.from, entry.typeRange.to), "X-Record2");
  assert.equal(entry.key, "Key:One");
  assert.equal(text.slice(entry.keyRange.from, entry.keyRange.to), "Key:One");
  assert.equal(text.slice(entry.bodyFrom, entry.bodyTo), " Key:One, TiTle = {A}, X_Custom.Note = {kept}, ");
  assert.equal(text.slice(entry.from, entry.to), text);
  assert.deepEqual(entry.fields.map(({ name, rawName }) => ({ name, rawName })), [
    { name: "title", rawName: "TiTle" }, { name: "x_custom.note", rawName: "X_Custom.Note" },
  ]);
});

test("citation keys retain native punctuation and exact key and entry spans", () => {
  for (const key of [
    "smith(2026)", "10.1002/(SICI)1097-0258(19990115)18:1<1::AID-SIM1>3.0.CO;2-1",
    "doi:2026/foo[bar]+?v=1&x=2", String.raw`punctuation:"'#%$@\()`,
    "left(unpaired", "right)unpaired", "2026", "smith(\u{1F600})",
  ]) {
    for (const [open, close] of [["{", "}"], ["(", ")"]]) {
      const source = `@book${open}${key},title={A}${close}`;
      const text = "% note\r\n" + source + "\r\n@book{next,title={B}}";
      const result = parse(text);
      assert.equal(result.status, "valid", source);
      assert.equal(result.text, text);
      assert.deepEqual(result.entries.map((entry) => entry.key), [key, "next"]);
      const entry = result.entries[0];
      assert.deepEqual(entry.keyRange, { from: 14, to: 14 + key.length });
      assert.deepEqual({ from: entry.from, to: entry.to }, { from: 8, to: 8 + source.length });
      assert.equal(text.slice(entry.keyRange.from, entry.keyRange.to), key);
      assert.equal(text.slice(entry.from, entry.to), source);
      assert.equal(entry.fields[0].raw, "{A}");
      assert.ok(result.diagnostics.every((item) => item.severity !== "error"));
    }
  }
});

test("key delimiters do not balance parentheses or change identifier grammar", () => {
  for (const source of ["@book{smith(2026)}", "@book(smith(2026),)"]) {
    const result = parse(source);
    assert.equal(result.status, "valid", source);
    assert.equal(result.entries[0].key, "smith(2026)");
    assert.deepEqual(result.entries[0].keyRange, { from: 6, to: 17 });
    assert.equal(source.slice(result.entries[0].from, result.entries[0].to), source);
    assert.deepEqual(result.entries[0].fields, []);
  }
  for (const source of [
    "@book(smith(2026))", "@book{smith(2026) title={A}}",
    "@bo(ok{k,title={A}}", "@book{k,ti(tle={A}}", "@book{k,title=some(macro)}",
  ]) {
    const result = parse(source);
    assert.equal(result.status, "invalid", source);
    assert.deepEqual(result.entries, []);
    assert.ok(result.diagnostics.some((item) => item.severity === "error"));
  }
});

test("simple literals retain TeX, nesting, escapes, percentages and line endings", () => {
  for (const [raw, value] of [
    ["{A {B}}", "A {B}"],
    [String.raw`{A \{B\} \\ {C} \% 50% }`, String.raw`A \{B\} \\ {C} \% 50% `],
    [String.raw`"A {nested "quote"} and {\"escape\"} 50%"`, String.raw`A {nested "quote"} and {\"escape\"} 50%`],
    ["{first% not a comment\r\nsecond}", "first% not a comment\r\nsecond"],
    ['"first% not a comment\r\nsecond"', "first% not a comment\r\nsecond"],
    [String.raw`{\input{secret} <img src=x onerror=alert(1)>}`, String.raw`\input{secret} <img src=x onerror=alert(1)>`],
    ["2026", "2026"], ["{}", ""], ['""', ""],
  ]) {
    const text = `@book(k, title=${raw})`;
    const result = parse(text);
    assert.equal(result.status, "valid", raw);
    const field = result.entries[0].fields[0];
    assert.equal(field.raw, raw);
    assert.equal(field.value, value);
    assert.equal(field.editable, true);
    assert.equal(text.slice(field.valueFrom, field.valueTo), raw);
    assert.equal(text.slice(field.from, field.to), `title=${raw}`);
  }
});

test("backslashes cannot hide unbalanced braces or preserve a partial projection", () => {
  for (const broken of [
    String.raw`@book{bad,title={\{x}}`,
    String.raw`@book{bad,title="a \} b"}`,
    String.raw`@string{x={\{x}}`,
  ]) {
    for (const prefix of ["", "@book{good,title={A}}\n"]) {
      const text = prefix + broken;
      const result = parse(text);
      assert.equal(result.status, "invalid", text);
      assert.equal(result.text, text);
      assert.deepEqual(result.entries, []);
      assert.ok(result.diagnostics.some((item) => item.severity === "error"), text);
    }
  }
});

test("a depth-zero quote after a backslash terminates the value and rejects trailing text", () => {
  for (const broken of [String.raw`@book{k,title="a\"b"}`, String.raw`@preamble{"a\"b"}`]) {
    for (const prefix of ["", "@book{good,title={A}}\n"]) {
      const text = prefix + broken;
      const result = parse(text);
      assert.equal(result.status, "invalid", text);
      assert.equal(result.text, text);
      assert.deepEqual(result.entries, []);
      assert.ok(result.diagnostics.some((item) => item.severity === "error"), text);
    }
  }
});

test("backslashes remain literal while following braces and quotes retain their structure", () => {
  for (const [raw, value] of [
    [String.raw`{\{x}}`, String.raw`\{x}`],
    [String.raw`{x\}`, "x\\"],
    [String.raw`"a\"`, "a\\"],
    [String.raw`"a \{"b"}"`, String.raw`a \{"b"}`],
  ]) {
    for (const [open, close] of [["{", "}"], ["(", ")"]]) {
      const source = `@book${open}k,title=${raw}${close}`;
      const text = "% note\r\n" + source + "\r\n";
      const result = parse(text);
      assert.equal(result.status, "valid", text);
      assert.equal(result.text, text);
      assert.equal(result.entries.length, 1);
      const entry = result.entries[0], field = entry.fields[0];
      assert.equal(text.slice(entry.from, entry.to), source);
      assert.equal(text.slice(field.valueFrom, field.valueTo), raw);
      assert.equal(field.raw, raw);
      assert.equal(field.value, value);
      assert.equal(field.editable, true);
      assert.ok(result.diagnostics.every((item) => item.severity !== "error"));
    }
  }
});

test("macros and concatenations stay literal and non-editable without expansion", () => {
  const text = '@string{JOURNAL="Journal"}\n@article{k,title={A} # " B" # 2026, journal=JoUrNaL, x_note=unknown}';
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.entries[0].fields.map(({ raw, value, editable }) => ({ raw, value, editable })), [
    { raw: '{A} # " B" # 2026', value: '{A} # " B" # 2026', editable: false },
    { raw: "JoUrNaL", value: "JoUrNaL", editable: false },
    { raw: "unknown", value: "unknown", editable: false },
  ]);
  const warnings = result.diagnostics.filter((item) => item.code === "bibtex.undefinedMacro");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].severity, "warning");
  assert.equal(warnings[0].params.name, "unknown");
  assert.equal(text.slice(warnings[0].from, warnings[0].to), "unknown");
});

test("directives retain exact spans without becoming entries, even when alone", () => {
  const parts = [
    '@CoMmEnT{literal " unmatched quote, % @book{fake, title={A}}}',
    '@comment(outer (nested) {a ) group} \\) end)',
    '@StRiNg ( Journal = "J" # {ournal}, )',
    '@PrEaMbLe{ "prefix" # Journal, }',
  ];
  for (const suffix of ["", "\r\n@book{real,title={A}}\r\n"]) {
    const text = parts.join("\r\n") + suffix;
    const result = parse(text);
    assert.equal(result.status, suffix ? "valid" : "empty");
    assert.equal(result.format, "bib");
    assert.deepEqual(result.directives.map(({ from, to }) => text.slice(from, to)), parts);
    assert.deepEqual(result.entries.map((entry) => entry.key), suffix ? ["real"] : []);
    assert.ok(!result.diagnostics.some((item) => item.severity === "error"));
  }
});

test("undefined macros in directives produce warnings, not structural errors", () => {
  const result = parse("@string{x=missing}\n@preamble{x # other}");
  assert.equal(result.status, "empty");
  assert.equal(result.directives.length, 2);
  assert.deepEqual(result.diagnostics.map(({ code, severity, params }) => ({ code, severity, params })), [
    { code: "bibtex.undefinedMacro", severity: "warning", params: { name: "missing" } },
    { code: "bibtex.undefinedMacro", severity: "warning", params: { name: "other" } },
  ]);
});

test("comments between syntax tokens do not enter adjacent field or value spans", () => {
  const text = '@book % type\r\n( key, % before\r\n Title % name\r\n = % equals\r\n {A} % after\r\n , % between\r\n x_note = "B" % atom\r\n # % hash\r\n {C} % end\r\n, % trailing\r\n)';
  const result = parse(text);
  assert.equal(result.status, "valid");
  const [title, note] = result.entries[0].fields;
  assert.equal(text.slice(title.from, title.to), "Title % name\r\n = % equals\r\n {A}");
  assert.equal(title.raw, "{A}");
  assert.equal(text.slice(note.from, note.to), 'x_note = "B" % atom\r\n # % hash\r\n {C}');
  assert.equal(note.raw, '"B" % atom\r\n # % hash\r\n {C}');
  assert.equal(note.editable, false);
  assert.equal(result.entries[0].fields.length, 2);
});

test("duplicate fields and exact keys remain ordered with warning spans", () => {
  const text = "@book{Key,title={First},TITLE={Second}}\n@book{Key,title={Third}}\n@book{key,title={Fourth}}";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.entries.map((entry) => entry.key), ["Key", "Key", "key"]);
  assert.deepEqual(result.entries[0].fields.map((field) => field.value), ["First", "Second"]);
  const duplicates = result.diagnostics.filter((item) => item.code.startsWith("bibtex.duplicate"));
  assert.deepEqual(duplicates.map(({ code, severity, from, to }) => ({ code, severity, raw: text.slice(from, to) })), [
    { code: "bibtex.duplicateField", severity: "warning", raw: "TITLE" },
    { code: "bibtex.duplicateKey", severity: "warning", raw: "Key" },
  ]);
});

test("missing keys and common metadata warn without enforcing an entry-type schema", () => {
  for (const text of ["@book{}", "@book{key}", "@book{key,}", "@custom{,x_note={kept}}", "@book{key,title={},author=\"\",year={}}"] ) {
    const result = parse(text);
    assert.equal(result.status, "valid", text);
    assert.equal(result.entries.length, 1);
    assert.ok(result.diagnostics.some((item) => item.code === "bibtex.missingMetadata"));
    assert.ok(result.diagnostics.every((item) => item.severity === "warning"));
    if (text === "@book{}" || text.startsWith("@custom{,")) {
      assert.equal(result.entries[0].key, null);
      assert.equal(result.entries[0].keyRange, null);
      assert.ok(result.diagnostics.some((item) => item.code === "bibtex.missingKey"));
    }
  }
  const result = parse('@custom{key,title={A},editor={Someone},date={2026-09-10},unknown={B}}');
  assert.equal(result.status, "valid");
  assert.deepEqual(result.diagnostics, []);
});

test("UTF-16 offsets preserve astral characters and CRLF before and inside entries", () => {
  const text = '\uFEFF% \u{1F600}\r\n@Book{\u{1F511},\r\n  TiTle = {A\u{1F600}},\r\n}\r\n';
  const result = parse(text);
  assert.equal(result.status, "valid");
  const entry = result.entries[0];
  assert.deepEqual({ from: entry.from, to: entry.to, typeRange: entry.typeRange, keyRange: entry.keyRange, bodyFrom: entry.bodyFrom, bodyTo: entry.bodyTo }, {
    from: 7, to: 37, typeRange: { from: 8, to: 12 }, keyRange: { from: 13, to: 15 }, bodyFrom: 13, bodyTo: 36,
  });
  assert.deepEqual(entry.fields[0], {
    from: 20, to: 33, name: "title", rawName: "TiTle", valueFrom: 28, valueTo: 33,
    raw: "{A\u{1F600}}", value: "A\u{1F600}", editable: true,
  });
  assert.equal(result.text, text);
});

test("mismatched delimiters and malformed grammar invalidate the whole projection", () => {
  for (const broken of [
    "@book{k,title={A})", "@book(k,title={A}}", '@book{k,title="A}"}',
    '@book{k,title="{A"}', '@book{k,title="A"B"}', "@book{k title={A}}",
    "@book{k,title {A}}", "@book{k,title=}", "@book{k,title={A} author={B}}",
    "@book{k,,title={A}}", "@book{k,title={A},,}", "@book{k,title=# {A}}",
    "@book{k,title={A} #}", "@book{k,title={A} ## {B}}", "@book{k,year=2026x}",
    "@book{k,1field={A}}", "@book{k,title='A'}", "@book[k,title={A}]",
    "@string{}", "@string{x}", '@string{x="A",y="B"}', "@preamble{}", "@preamble{,}",
    "@preamble(x={A})", "@comment{broken)", "@comment(broken}", "@comment bare text",
  ]) {
    const text = `@book{good,title={A}}\n${broken}`;
    const result = parse(text);
    assert.equal(result.status, "invalid", broken);
    assert.equal(result.format, "bib");
    assert.equal(result.text, text);
    assert.deepEqual(result.entries, []);
    assert.ok(result.diagnostics.some((item) => item.severity === "error"), broken);
  }
});

test("EOF at each token boundary cannot publish an incomplete entry or directive", () => {
  for (const complete of [
    '@book{key,title={A {B}},note="C {"D"}" # macro,year=2026}',
    '@book(key,title={A},)', '@string{macro="Value"}', '@preamble("A" # {B})',
    '@comment{ignored {nested}}', '@comment(ignored (nested) {)})',
  ]) {
    for (let end = 1; end < complete.length; end++) {
      const text = "@book{good,title={A}}\n" + complete.slice(0, end);
      const result = parse(text);
      assert.equal(result.status, "invalid", complete.slice(0, end));
      assert.deepEqual(result.entries, []);
      assert.ok(result.diagnostics.some((item) => item.severity === "error"));
    }
    assert.ok(["valid", "empty"].includes(parse(complete).status), complete);
  }
  for (const text of ['@book{k,title={A\\', '@book{k,title="A\\', '@comment{A\\']) {
    assert.equal(parse(text).status, "invalid", text);
  }
});

test("structural errors take precedence over unrelated outside text", () => {
  const result = parse("foreign text\n@book{k,title={broken");
  assert.equal(result.status, "invalid");
  assert.deepEqual(result.entries, []);
  assert.ok(result.diagnostics.some((item) => item.code === "bibtex.unrecognized"));
  assert.ok(result.diagnostics.some((item) => item.severity === "error"));
});

test("diagnostics always use in-bounds UTF-16 spans and serializable parameters", () => {
  for (const text of ["@", "@book{", "@book{\u{1F600},title=missing}", "foreign \u{1F600}", "@book{k,title={A}}\n@book{k,}"]) {
    const result = parse(text);
    assert.ok(result.diagnostics.length > 0, text);
    for (const item of result.diagnostics) {
      assert.ok(Number.isInteger(item.from) && Number.isInteger(item.to));
      assert.ok(0 <= item.from && item.from <= item.to && item.to <= text.length);
      assert.ok(["error", "warning"].includes(item.severity));
      assert.equal(typeof item.code, "string");
      assert.equal(typeof item.params, "object");
      for (const value of Object.values(item.params)) assert.ok(["string", "number"].includes(typeof value));
    }
  }
});

test("deep groups are scanned iteratively without a recursion limit", () => {
  const raw = "{".repeat(20000) + "A" + "}".repeat(20000);
  for (const expression of [raw, '"' + raw + '"']) {
    const result = parse(`@book{k,title=${expression}}`);
    assert.equal(result.status, "valid");
    assert.equal(result.entries[0].fields[0].raw, expression);
  }
});
