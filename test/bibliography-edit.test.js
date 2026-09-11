const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../public/iris-bibliography.js");
const E = require("../public/iris-bibliography-edit.js");

function apply(source, result) {
  assert.equal(result.status, "ready", JSON.stringify(result.diagnostics));
  let end = 0;
  for (const change of result.changes) {
    assert.ok(Number.isInteger(change.from) && Number.isInteger(change.to));
    assert.ok(end <= change.from && change.from <= change.to && change.to <= source.length);
    end = change.to;
  }
  const next = result.changes.toReversed().reduce((text, change) =>
    text.slice(0, change.from) + change.insert + text.slice(change.to), source);
  assert.equal(B.decodeUtf8(Buffer.from(next, "utf8")), next);
  assert.equal(B.decodeUtf8(new TextEncoder().encode(next)), next);
  return next;
}

test("editing one field preserves comments, macros and other entries", () => {
  const source = "% keep\r\n@book{a,title={Old},publisher=pub,x_note={X}}\r\n" +
    "@string{pub={Publisher}}\r\n@article{b,title={B}}\r\n";
  const parsed = B.parse(source, "bib");
  const entry = parsed.entries[0];
  const result = E.buildChanges(parsed, { kind: "update", target: entry,
    draft: { type: entry.type, key: entry.key,
      fields: [{ index: 0, name: "title", value: "New", remove: false }] } });
  assert.equal(result.status, "ready");
  const next = apply(source, result);
  assert.equal(next, source.replace("{Old}", "{New}"));
  assert.deepEqual(result.changes, [{ from: entry.fields[0].valueFrom,
    to: entry.fields[0].valueTo, insert: "{New}" }]);
  assert.equal(B.parse(next, "bib").status, "valid");
});

function update(parsed, fields = [], extra = {}, entryIndex = 0) {
  const target = parsed.entries[entryIndex];
  return E.buildChanges(parsed, { kind: "update", target,
    draft: { type: target.type, key: target.key, fields, ...extra } });
}

const field = (index, name, value, remove = false) => ({ index, name, value, remove });

function rejected(result, status, code) {
  assert.equal(result.status, status);
  assert.deepEqual(result.changes, []);
  assert.ok(result.diagnostics.some((item) => item.code === code && item.severity === "error"),
    JSON.stringify(result.diagnostics));
}

test("an unchanged display draft preserves every raw occurrence without mutating its inputs", () => {
  for (const [format, text] of [
    ["bib", '@BoOk{k,TiTle="A",year=0007,title={B},note=pub # {X}}'],
    ["ris", "ty  - book\r\nTi  -  A \r\n\t B  \r\n\r\n% paragraph\r\nAU  - One\r\nAU  - Two\r\ner  -"],
  ]) {
    const parsed = B.parse(text, format), before = structuredClone(parsed), target = parsed.entries[0];
    for (const fields of [[], target.fields.map((item, index) => field(index, item.name, item.value))]) {
      const operation = { kind: "update", target, draft: { type: target.type, key: target.key, fields } };
      const original = structuredClone(operation);
      assert.deepEqual(E.buildChanges(parsed, operation), { status: "unchanged", changes: [], diagnostics: [] });
      assert.deepEqual(operation, original);
      assert.deepEqual(parsed, before);
    }
  }
});

test("scalar edits retain safe delimiters, TeX braces, backslashes and textual numbers", () => {
  for (const [raw, value, want] of [
    ['"Old"', 'A {nested "quote"}', '"A {nested "quote"}"'],
    ['"Old"', String.raw`a\"b`, String.raw`{a\"b}`],
    ['"Old"', "end\\", '"end\\"'],
    ["{Old}", String.raw`A \{B\} \LaTeX{} 50%`, String.raw`{A \{B\} \LaTeX{} 50%}`],
    ["0007", "0008", "0008"], ["0007", "0008-09-01", "{0008-09-01}"],
    ["{0007}", "0008", "{0008}"], ["{Old}", "", "{}"],
  ]) {
    const text = `@book(k,TiTle % name\r\n = ${raw},x_note={untouched})`;
    const parsed = B.parse(text, "bib");
    const result = update(parsed, [field(0, "title", value)]);
    const next = apply(text, result);
    assert.equal(next, text.replace(`= ${raw},`, `= ${want},`));
    assert.equal(B.parse(next, "bib").entries[0].fields[0].value, value);
  }
});

test("balanced-looking delimiters cannot inject BibTeX fields or entries", () => {
  for (const value of ["} {", "},author={Injected", "}}\n@book{evil,title={Injected", String.raw`a\} ,author={bad`, "{open"]) {
    const parsed = B.parse("@book{k,title={Old}}", "bib");
    rejected(update(parsed, [field(0, "title", value)]), "invalid", "bibliographyEdit.unsafeValue");
  }
  const text = '@book{k,title="Old"}';
  const value = 'A",author="Injected';
  const next = apply(text, update(B.parse(text, "bib"), [field(0, "title", value)]));
  assert.equal(next, '@book{k,title={A",author="Injected}}');
  assert.deepEqual(B.parse(next, "bib").entries[0].fields.map((item) => [item.name, item.value]), [["title", value]]);
});

test("complex BibTeX expressions remain source-only rather than becoming scalar values", () => {
  const parsed = B.parse('@book{k,title=pub # " X",publisher=pub}', "bib");
  for (const item of [field(0, "title", "New"), field(1, "publisher", "New"), field(0, "title", "", true)]) {
    rejected(update(parsed, [item]), "invalid", "bibliographyEdit.readOnlyField");
  }
});

test("type and key changes keep native fields and do not rewrite cross-references", () => {
  const text = '% \u{1F600}\r\n@BoOk(old(2026),TiTle={A},X_Note=macro)\r\n@book{b,crossref={old(2026)}}';
  const parsed = B.parse(text, "bib");
  const next = apply(text, update(parsed, [], { type: "article", key: "new)unpaired\u{1F600}" }));
  assert.equal(next, text.replace("BoOk(old(2026)", "article(new)unpaired\u{1F600}"));
  assert.deepEqual(B.parse(next, "bib").entries.map((item) => item.key), ["new)unpaired\u{1F600}", "b"]);
});

test("only newly introduced duplicate BibTeX keys block edits", () => {
  const text = "@book{dup,title={A}}\n@book{dup,title={B}}\n@book{other,title={C}}";
  const parsed = B.parse(text, "bib");
  assert.equal(apply(text, update(parsed, [field(0, "title", "New")])), text.replace("{A}", "{New}"));
  assert.equal(apply(text, update(parsed, [], { type: "article" }, 1)), text.replace("@book{dup,title={B}", "@article{dup,title={B}"));
  rejected(update(parsed, [], { key: "dup" }, 2), "invalid", "bibliographyEdit.duplicateKey");
  const distinct = apply(text, update(parsed, [], { key: "Dup" }, 2));
  assert.equal(B.parse(distinct, "bib").entries[2].key, "Dup");
});

test("RIS updates preserve omitted continuations and distinct repeated indices", () => {
  const text = "\uFEFFty  - jOuR\r\nID  - 0007\r\nAU  - One\r\nau  - Two\r\nN1  - First\r\n\r\n% paragraph\r\n\t literal\r\nPY  - 0007/09/01\r\ner  -\r\n% outside";
  const parsed = B.parse(text, "ris");
  const next = apply(text, update(parsed, [field(2, "AU", "Changed")], { type: "book" }));
  assert.equal(next, text.replace("jOuR", "BOOK").replace("au  - Two", "au  - Changed"));
  const entry = B.parse(next, "ris").entries[0];
  assert.equal(entry.key, null);
  assert.deepEqual(entry.fields.map((item) => item.raw), ["0007", "One", "Changed", "First\r\n\r\n% paragraph\r\n\t literal", "0007/09/01"]);
});

test("RIS scalar encoding makes injected and malformed tag lines literal continuations", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const text = ["TY  - JOUR", "TI  - Old", "AU  - Kept", "ER  -"].join(newline);
    const value = 'A\u{1F600}\u2028B\nER  -\r\nTY  - BOOK\rTI - injected\n% paragraph\n\nend';
    const result = update(B.parse(text, "ris"), [field(0, "TI", value)]);
    const next = apply(text, result);
    const raw = ['A\u{1F600}\u2028B', '      ER  -', '      TY  - BOOK', '      TI - injected', '      % paragraph', '      ', '      end'].join(newline);
    assert.equal(next, text.replace("Old", raw));
    const checked = B.parse(next, "ris");
    assert.equal(checked.status, "valid");
    assert.equal(checked.entries.length, 1);
    assert.deepEqual(checked.entries[0].fields.map((item) => [item.name, item.raw]), [["TI", raw], ["AU", "Kept"]]);
  }
});

test("RIS empty native tag separators can receive a value without rewriting the field", () => {
  const text = "TY  - BOOK\rN1  -\rER  -";
  const parsed = B.parse(text, "ris"), item = parsed.entries[0].fields[0];
  const result = update(parsed, [field(0, "N1", "0008")]);
  assert.equal(apply(text, result), "TY  - BOOK\rN1  - 0008\rER  -");
  assert.deepEqual(result.changes, [{ from: item.valueFrom, to: item.valueTo, insert: " 0008" }]);
});

test("missing or ambiguous targets and repeated draft indices never produce partial changes", () => {
  const parsed = B.parse("@book{k,title={A}}", "bib"), target = parsed.entries[0];
  for (const span of [undefined, { from: 0, to: target.to - 1 }, { from: 1, to: target.to }]) {
    rejected(E.buildChanges(parsed, { kind: "remove", target: span }), "conflict", "bibliographyEdit.targetConflict");
  }
  rejected(E.buildChanges({ ...parsed, entries: [target, target] }, { kind: "remove", target }),
    "conflict", "bibliographyEdit.targetConflict");
  for (const fields of [[field(1, "title", "B")], [field(0, "title", "B"), field(0, "title", "C")]]) {
    rejected(update(parsed, fields), "conflict", "bibliographyEdit.fieldConflict");
  }
});

test("invalid source, scalar types and identifier injection are rejected atomically", () => {
  rejected(E.buildChanges(B.parse("@book{broken", "bib"), { kind: "add",
    draft: { type: "book", key: "k", fields: [] } }), "invalid", "bibliographyEdit.invalidSource");
  const bib = B.parse("@book{k,title={A}}", "bib");
  for (const type of ["comment", "string", "preamble", "book{k,}", ""]) {
    rejected(update(bib, [], { type }), "invalid", "bibliographyEdit.invalidType");
  }
  for (const key of ["k,title={bad}", "a b", "", 123]) {
    rejected(update(bib, [], { key }), "invalid", "bibliographyEdit.invalidKey");
  }
  for (const item of [field(0, "title,author", "B"), field(0, "1title", "B"), field(0, "title", 2026)]) {
    rejected(update(bib, [item]), "invalid", "bibliographyEdit.invalidField");
  }
  const ris = B.parse("TY  - BOOK\nTI  - A\nER  -", "ris");
  rejected(update(ris, [], { key: "fake" }), "invalid", "bibliographyEdit.invalidKey");
  rejected(update(ris, [], { type: "BOOK\nER  -" }), "invalid", "bibliographyEdit.invalidType");
  for (const name of ["ER", "TY", "TIT", "T1\nER  -"]) {
    rejected(update(ris, [field(0, name, "B")]), "invalid", "bibliographyEdit.invalidField");
  }
});

function add(parsed, fields = [], extra = {}) {
  return E.buildChanges(parsed, { kind: "add", draft: {
    type: parsed.format === "bib" ? "book" : "BOOK", key: parsed.format === "bib" ? "new" : null, fields, ...extra,
  } });
}

for (const format of ["bib", "ris"]) for (const kind of ["add", "update"]) {
  test(`guided UTF-8: ${format} ${kind} rejects NUL and lone surrogates without mutation`, () => {
    const text = format === "bib" ? "@book{k,title={Old}}" : "TY  - BOOK\r\nTI  - Old\r\nER  -";
    const parsed = B.parse(text, format), snapshot = structuredClone(parsed), results = [], expected = [];
    for (const bad of ["\0", "\uD800", "\uDC00"]) {
      const value = "new" + bad;
      const drafts = [
        [[field(kind === "add" ? null : 0, format === "bib" ? "title" : "TI", value)], {}, "invalidText"],
        [[], { type: value }, "invalidType"],
        [[field(null, "x" + bad, "Value")], {}, "invalidField"],
        ...(format === "bib" ? [[[], { key: value }, "invalidKey"]] : [[[field(null, "ID", value)], {}, "invalidText"]]),
      ];
      for (const [fields, extra, code] of drafts) {
        const before = structuredClone({ fields, extra });
        const result = (kind === "add" ? add : update)(parsed, fields, extra);
        results.push([bad.charCodeAt(0), code, result.status, result.changes.length, result.diagnostics[0]?.code]);
        expected.push([bad.charCodeAt(0), code, "invalid", 0, "bibliographyEdit." + code]);
        assert.deepEqual({ fields, extra }, before);
        assert.deepEqual(parsed, snapshot);
      }
    }
    assert.deepEqual(results, expected);
  });

  test(`guided UTF-8: ${format} ${kind} preserves valid Unicode through strict reopening`, () => {
    for (const value of ["Normal 0007", "Astral\u{1F600}", "Actual\uFFFD"]) {
      const text = format === "bib" ? "% kept\r\n@book{k,title={Old}}" : "% kept\r\nTY  - BOOK\r\nTI  - Old\r\nER  -";
      const parsed = B.parse(text, format), name = format === "bib" ? "title" : "TI";
      const token = value.replaceAll(" ", "");
      const extra = { type: token, ...(format === "bib" ? { key: token } : {}) };
      const fields = [field(kind === "add" ? null : 0, name, value), field(null, format === "bib" ? "x" + token : "ID", value)];
      const next = apply(text, (kind === "add" ? add : update)(parsed, fields, extra));
      const reopened = B.parse(B.decodeUtf8(Buffer.from(next)), format);
      assert.equal(reopened.status, "valid");
      const entry = reopened.entries.at(-1);
      assert.deepEqual(entry.fields.map((item) => item.value), [value, value]);
      assert.equal(entry.type, format === "bib" ? token.toLowerCase() : token.toUpperCase());
      if (format === "bib") {
        assert.equal(entry.key, token);
        assert.equal(entry.fields[1].name, "x" + token.toLowerCase());
      }
    }
  });
}

test("new entries append in the known format and source newline style, including empty collections", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (const format of ["bib", "ris"]) {
      for (const text of ["", "\uFEFF", `% \u{1F600}${newline}% footer`, format === "bib" ?
        `@string{pub={Publisher}}${newline}@book{old,title=pub}${newline}% footer` :
        `TY  - JOUR${newline}TI  - Old${newline}ER  -${newline}% footer`]) {
        const parsed = B.parse(text, format);
        const item = format === "bib" ? field(null, "TiTle", "A {B}") : field(null, "ti", "A {B}");
        const next = apply(text, add(parsed, [item]));
        assert.equal(next.slice(0, text.length), text);
        const checked = B.parse(next, format);
        assert.equal(checked.status, "valid");
        assert.equal(checked.format, format);
        assert.equal(checked.entries.length, parsed.entries.length + 1);
        const entry = checked.entries.at(-1);
        assert.equal(entry.type, format === "bib" ? "book" : "BOOK");
        assert.equal(entry.key, format === "bib" ? "new" : null);
        assert.deepEqual(entry.fields.map((item) => [item.name, item.value]), [[format === "bib" ? "title" : "TI", "A {B}"]]);
        const eol = /\r\n|\r|\n/.exec(text)?.[0] || "\n";
        assert.equal(next.slice(text.length).replaceAll(eol, "").includes("\n"), false);
        assert.equal(next.slice(text.length).replaceAll(eol, "").includes("\r"), false);
      }
    }
  }
  assert.equal(apply("", add(B.parse("", "bib"))), "@book{new,}\n");
  assert.equal(apply("", add(B.parse("", "ris"))), "TY  - BOOK\nER  -\n");
});

test("new scalar fields are encoded too, without native RIS IDs becoming keys", () => {
  const ris = B.parse("", "ris"), value = "0007\nER  -\nTY  - JOUR";
  const next = apply("", add(ris, [field(null, "id", "0007"), field(null, "au", "One"),
    field(null, "AU", "Two"), field(null, "n1", value), field(null, "py", "0007/09/01")]));
  const entries = B.parse(next, "ris").entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, null);
  assert.deepEqual(entries[0].fields.map((item) => [item.rawName, item.raw]), [
    ["ID", "0007"], ["AU", "One"], ["AU", "Two"], ["N1", "0007\n      ER  -\n      TY  - JOUR"], ["PY", "0007/09/01"],
  ]);
  const bib = B.parse("@book{new,}", "bib");
  rejected(add(bib), "invalid", "bibliographyEdit.duplicateKey");
  rejected(add(B.parse("", "bib"), [field(null, "title", "},author={bad")]), "invalid", "bibliographyEdit.unsafeValue");
  rejected(add(ris, [field(null, "ER", "")]), "invalid", "bibliographyEdit.invalidField");
  rejected(add(ris, [field(0, "TI", "A")]), "conflict", "bibliographyEdit.fieldConflict");
});

test("entry removal deletes only its exact range, including the final or only entry", () => {
  for (const [format, entry] of [["bib", "@book{k,title={A}}"], ["ris", "TY  - BOOK\r\nTI  - A\r\nER  -"]]) {
    for (const text of [entry, `\uFEFF% before \u{1F600}\r\n${entry}\r\n% after`, `${entry}\r\n% between\r\n${entry}`]) {
      const parsed = B.parse(text, format), target = parsed.entries.at(-1);
      const result = E.buildChanges(parsed, { kind: "remove", target: { from: target.from, to: target.to } });
      const next = apply(text, result);
      assert.deepEqual(result.changes, [{ from: target.from, to: target.to, insert: "" }]);
      assert.equal(next, text.slice(0, target.from) + text.slice(target.to));
      assert.equal(B.parse(next, format).status, parsed.entries.length === 1 ? "empty" : "valid");
      assert.equal(B.parse(next, format).format, format);
    }
  }
});

test("BibTeX additions use contextual commas without consuming comments or existing fields", () => {
  for (const text of [
    "@book{k}", "@book{k,}", "@book{}", "@book(,)",
    "@book{k,title={A}}", "@book{k,title={A},}",
    "@book{k,title={A} % tail, not a separator\r\n}",
    "@book{k,\r\n\tTiTle={A}, % keep,\r\n  }",
    "@book{k % key, comment\r\n}", "@book{% before key\r\n, % no fields\r\n}",
  ]) {
    const parsed = B.parse(text, "bib"), before = parsed.entries[0];
    const result = update(parsed, [field(null, "X_Note", "B {C}"), field(null, "date", "0007-09-01")]);
    const next = apply(text, result), checked = B.parse(next, "bib");
    assert.equal(checked.status, "valid", next);
    assert.equal(checked.entries[0].key, before.key);
    assert.deepEqual(checked.entries[0].fields.map((item) => [item.name, item.raw]), [
      ...before.fields.map((item) => [item.name, item.raw]), ["x_note", "{B {C}}"], ["date", "{0007-09-01}"],
    ]);
    for (const change of result.changes) assert.equal(change.from, change.to, "adding fields only inserts bytes");
    for (const comment of text.match(/%[^\r\n]*/g) || []) assert.ok(next.includes(comment));
  }
});

test("field removals retain external BibTeX comments and parenthesized key delimiters", () => {
  for (const [text, index, want] of [
    ["@book{k,a={A}, % keep,\r\n b={B},c={C}}", 1, "@book{k,a={A}, % keep,\r\n c={C}}"],
    ["@book{k,a={A} % A\r\n, % before B\r\nb={B} % B\r\n}", 1, "@book{k,a={A} % A\r\n % before B\r\n % B\r\n}"],
    ["@book(k,a={A})", 0, "@book(k,)"],
    ["@book{k,a={A}, % trailing\n}", 0, "@book{k, % trailing\n}"],
  ]) {
    const parsed = B.parse(text, "bib"), original = parsed.entries[0].fields[index];
    assert.equal(apply(text, update(parsed, [field(index, original.name, original.value, true)])), want);
  }
});

test("combined removals, value updates and appends preserve distinct native occurrence order", () => {
  for (const trailing of ["", ","]) {
    for (let mask = 0; mask < 8; mask++) {
      const text = `@book(k,A={One}, % first,\r\na={Two}, % second,\r\nA={Three}${trailing} % last,\r\n)`;
      const parsed = B.parse(text, "bib");
      const fields = [field(null, "x", "Added"), ...parsed.entries[0].fields.map((item, index) =>
        field(index, item.name, index === 1 ? "Changed" : item.value, Boolean(mask & (1 << index))))];
      const next = apply(text, update(parsed, fields));
      const checked = B.parse(next, "bib");
      assert.equal(checked.status, "valid", next);
      assert.deepEqual(checked.entries[0].fields.map((item) => [item.rawName, item.value]), [
        ...[["A", "One"], ["a", "Changed"], ["A", "Three"]].filter((item, index) => !(mask & (1 << index))), ["x", "Added"],
      ]);
      for (const comment of ["% first,", "% second,", "% last,"]) assert.ok(next.includes(comment));
    }
  }
});

test("RIS field removals remove owned blank and percent continuations, not external trivia", () => {
  const text = "% outside\rTY  - BOOK\r% before fields\r\rAU  - One\r\r% owned\rAU  - Two\rN1  - Kept\rER  -\r% after";
  const parsed = B.parse(text, "ris");
  const next = apply(text, update(parsed, [field(0, "AU", "", true), field(1, "AU", "Changed"), field(null, "au", "Three")]));
  assert.equal(next, "% outside\rTY  - BOOK\r% before fields\r\rAU  - Changed\rN1  - Kept\rAU  - Three\rER  -\r% after");
  const again = B.parse(next, "ris");
  const empty = apply(next, update(again, again.entries[0].fields.map((item, index) => field(index, item.name, "", true))));
  assert.equal(empty, "% outside\rTY  - BOOK\r% before fields\r\rER  -\r% after");
});

test("missing keys and native parentheses can be edited without losing contextual comments", () => {
  for (const [text, key, want] of [
    ["@book{% before\r\n, title={A}}", "new(2026)", "@book{new(2026) % before\r\n, title={A}}"],
    ["@book{old,title={A}}", null, "@book{,title={A}}"],
    ["@book(k,title={A})", "a}b", "@book(a}b,title={A})"],
  ]) assert.equal(apply(text, update(B.parse(text, "bib"), [], { key })), want);
  const text = "@book{}";
  const next = apply(text, update(B.parse(text, "bib"), [field(null, "title", "A")], { key: "new" }));
  assert.equal(B.parse(next, "bib").entries[0].key, "new");
  assert.equal(B.parse(next, "bib").entries[0].fields[0].value, "A");
});

test("clearing a comma-less parenthesized key preserves its required separator and trivia", () => {
  for (const [text, want] of [
    ["@book(k )", "@book(, )"],
    ["@book(k % keep\n)", "@book(, % keep\n)"],
    ["@book(k % keep,\r\n)", "@book(, % keep,\r\n)"],
    ["@book(k(\u{1F600}) % keep,\r)", "@book(, % keep,\r)"],
    ["@book(k, % keep\n)", "@book(, % keep\n)"],
    ["@book{k % keep\n}", "@book{ % keep\n}"],
  ]) {
    const parsed = B.parse(text, "bib");
    assert.equal(parsed.status, "valid", text);
    const result = update(parsed, [], { key: null }), next = apply(text, result);
    assert.equal(next, want);
    const checked = B.parse(next, "bib");
    assert.equal(checked.status, "valid");
    assert.equal(checked.entries[0].key, null);
    assert.deepEqual(checked.entries[0].fields, []);
    const range = parsed.entries[0].keyRange;
    assert.ok(result.changes.every((change) => change.from >= range.from && change.to <= range.to));
    assert.equal(update(checked, [], { key: null }).status, "unchanged");
  }
});

test("clearing a key while appending a field does not duplicate its separator", () => {
  for (const [text, want] of [
    ["@book(k )", "@book(,  title = {New})"],
    ["@book(k % keep\n)", "@book(, % keep\n  title = {New}\n)"],
    ["@book(k, % keep,\r\n)", "@book(, % keep,\r\n  title = {New}\r\n)"],
    ["@book{k}", "@book{, title = {New}}"],
  ]) {
    const parsed = B.parse(text, "bib");
    assert.equal(parsed.status, "valid", text);
    const next = apply(text, update(parsed, [field(null, "title", "New")], { key: null }));
    assert.equal(next, want);
    const checked = B.parse(next, "bib");
    assert.equal(checked.status, "valid");
    assert.equal(checked.entries[0].key, null);
    assert.deepEqual(checked.entries[0].fields.map((item) => [item.name, item.raw]), [["title", "{New}"]]);
  }
});

test("post-parse validation rejects both invalid syntax and valid but unintended entries", () => {
  rejected(update(B.parse("@book{k}", "bib"), [], { key: "%hidden" }), "invalid", "bibtex.syntax");
  // The replacement parses as an empty, keyless entry, not the requested key.
  assert.equal(B.parse("@book{%hidden,\n}", "bib").status, "valid");
  rejected(update(B.parse("@book{k,\n}", "bib"), [], { key: "%hidden" }), "invalid", "bibliographyEdit.intentMismatch");
});

test("field renames preserve the original value expression and omitted native syntax", () => {
  for (const [format, text, name, want] of [
    ["bib", '@book{k,TiTle % keep\n = "A",x_note={B}}', "BookTitle", '@book{k,booktitle % keep\n = "A",x_note={B}}'],
    ["ris", "ty  - book\r\nTi  -  A\r\n\t B  \r\nID  - 0007\r\ner  -", "T1", "ty  - book\r\nT1  -  A\r\n\t B  \r\nID  - 0007\r\ner  -"],
  ]) {
    const parsed = B.parse(text, format), item = parsed.entries[0].fields[0];
    assert.equal(apply(text, update(parsed, [field(0, name, item.value)])), want);
  }
});

test("all field-removal subsets work without appends and never remove comments", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    for (let mask = 1; mask < 8; mask++) {
      const text = `@book(k,a={A}, % one,${newline}b={B}, % two,${newline}c={C} % three,${newline})`;
      const parsed = B.parse(text, "bib");
      const next = apply(text, update(parsed, parsed.entries[0].fields.flatMap((item, index) =>
        mask & (1 << index) ? [field(index, item.name, "", true)] : [])));
      const checked = B.parse(next, "bib");
      assert.equal(checked.status, "valid");
      assert.equal(checked.entries[0].key, "k");
      assert.deepEqual(checked.entries[0].fields.map((item) => item.value), ["A", "B", "C"].filter((item, index) => !(mask & (1 << index))));
      for (const comment of ["% one,", "% two,", "% three,"]) assert.ok(next.includes(comment));
    }
  }
});

test("RIS appends preserve pre-field trivia and raw drafts, including trailing blank values", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const text = `TY  - BOOK${newline}% before${newline}${newline}ER  -`;
    const next = apply(text, update(B.parse(text, "ris"), [field(null, "n1", ` A${newline}\t B${newline}`)]));
    assert.equal(next, `TY  - BOOK${newline}% before${newline}${newline}N1  -  A${newline}      \t B${newline}      ${newline}ER  -`);
    const parsed = B.parse(next, "ris"), item = parsed.entries[0].fields[0];
    assert.equal(update(parsed, [field(0, "N1", item.raw)]).status, "unchanged");
    const removed = apply(next, E.buildChanges(parsed, { kind: "remove", target: parsed.entries[0] }));
    assert.equal(removed, "");
    assert.equal(B.parse(removed, "ris").status, "empty");
  }
});

test("successful and failed operations never mutate the parsed snapshot or draft", () => {
  const parsed = B.parse("@book{k,title={A},year=0007}", "bib"), snapshot = structuredClone(parsed);
  for (const value of ["B\u{1F600}", "0008\n", "},author={B"]) {
    const operation = { kind: "update", target: parsed.entries[0], draft: {
      type: "article", key: "new", fields: [field(1, "year", value)],
    } };
    const before = structuredClone(operation), result = E.buildChanges(parsed, operation);
    assert.equal(result.status, value.startsWith("}") ? "invalid" : "ready");
    if (result.status === "ready") assert.equal(B.parse(apply(parsed.text, result), "bib").entries[0].fields[1].value, value);
    assert.deepEqual(parsed, snapshot);
    assert.deepEqual(operation, before);
  }
});

test("invalid operations and ignored new-field removals have explicit non-mutating results", () => {
  const parsed = B.parse("@book{k,}", "bib");
  for (const operation of [null, {}, { kind: "replace" }, { kind: "add" }, { kind: "add", draft: { fields: null } }]) {
    rejected(E.buildChanges(parsed, operation), "invalid", "bibliographyEdit.invalidOperation");
  }
  assert.deepEqual(update(parsed, [field(null, "title", "", true)]), { status: "unchanged", changes: [], diagnostics: [] });
  for (const result of [add(parsed, [field(null, "title", "}")]), update(parsed, [], { key: "" })]) {
    for (const diagnostic of result.diagnostics) {
      assert.ok(0 <= diagnostic.from && diagnostic.from <= diagnostic.to && diagnostic.to <= parsed.text.length);
      assert.ok(Object.values(diagnostic.params).every((value) => ["string", "number"].includes(typeof value)));
    }
  }
});

test("browser and worker globals expose only the pure change builder without DOM access", () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const parsed = B.parse("@book{k,title={A}}", "bib");
  const operation = { kind: "update", target: parsed.entries[0], draft: { type: "book", key: "k", fields: [field(0, "title", "B")] } };
  for (const context of [{ window: {} }, {}]) {
    for (const name of ["bibtex", "ris", "bibliography", "bibliography-edit"]) {
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../public/iris-${name}.js`), "utf8"), context, { timeout: 1000 });
    }
    const api = (context.window || context).IrisBibliographyEdit;
    assert.deepEqual(Object.keys(api), ["buildChanges"]);
    assert.deepEqual(JSON.parse(JSON.stringify(api.buildChanges(parsed, operation))), E.buildChanges(parsed, operation));
  }
});
