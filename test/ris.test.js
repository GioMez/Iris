const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../public/iris-ris.js");

test("RIS retains complete records, repeated authors and custom tags without inventing keys", () => {
  const text = "TY  - JOUR\r\nAU  - Doe, Jane\r\nAU  - Doe, John\r\nX1  - custom\r\nID  - native-id\r\nER  - \r\n";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.equal(result.format, "ris");
  assert.equal(result.text, text);
  assert.deepEqual(result.directives, []);
  assert.deepEqual(result.diagnostics, []);
  const entry = result.entries[0];
  assert.equal(entry.key, null);
  assert.equal(entry.keyRange, null);
  assert.deepEqual(entry.fields.map(({ name, value }) => [name, value]), [
    ["AU", "Doe, Jane"], ["AU", "Doe, John"], ["X1", "custom"], ["ID", "native-id"],
  ]);
});

test("RIS spans retain BOM, CRLF, astral characters and indented continuations exactly", () => {
  const text = "\uFEFFTY  - jOuR\r\nTi  - A\u{1F600}\r\n      B  \r\nER  - \r\n";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.equal(result.text, text);
  assert.deepEqual(result.entries, [{
    from: 1, to: 41, type: "JOUR", typeRange: { from: 7, to: 11 },
    key: null, keyRange: null, bodyFrom: 13, bodyTo: 35,
    fields: [{
      from: 13, to: 33, name: "TI", rawName: "Ti", valueFrom: 19, valueTo: 33,
      raw: "A\u{1F600}\r\n      B  ", value: "A\u{1F600} B", editable: true,
    }],
  }]);
  const entry = result.entries[0], field = entry.fields[0];
  assert.equal(text.slice(entry.typeRange.from, entry.typeRange.to), "jOuR");
  assert.equal(text.slice(entry.from, entry.to), text.slice(1, -2));
  assert.equal(text.slice(entry.bodyFrom, entry.bodyTo), "Ti  - A\u{1F600}\r\n      B  \r\n");
  assert.equal(text.slice(field.from, field.to), "Ti  - A\u{1F600}\r\n      B  ");
  assert.equal(text.slice(field.valueFrom, field.valueTo), field.raw);
});

test("RIS accepts unknown types and case variants without losing native spelling", () => {
  const text = "% outside\r\n  ty  -  my-Custom \t\r\nx9  - first\r\nX9  - second\r\ner  -\r\n";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.diagnostics, []);
  const entry = result.entries[0];
  assert.equal(entry.type, "MY-CUSTOM");
  assert.equal(text.slice(entry.typeRange.from, entry.typeRange.to), "my-Custom");
  assert.equal(text.slice(entry.from, entry.from + 2), "ty");
  assert.deepEqual(entry.fields.map(({ name, rawName }) => [name, rawName]), [["X9", "x9"], ["X9", "X9"]]);
});

test("RIS accepts empty ER values and retains empty ordinary fields", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    for (const er of ["ER  -", "ER  - ", "ER  - \t "]) {
      const text = ["TY  - BOOK", "N1  -", "N2  -   ", er].join(eol);
      const result = parse(text);
      assert.equal(result.status, "valid", JSON.stringify(text));
      const entry = result.entries[0];
      assert.equal(text.slice(entry.from, entry.to), text);
      assert.deepEqual(entry.fields.map(({ name, raw, value }) => [name, raw, value]), [
        ["N1", "", ""], ["N2", "  ", ""],
      ]);
      for (const field of entry.fields) assert.equal(text.slice(field.valueFrom, field.valueTo), field.raw);
    }
    const minimal = parse(`TY  - JOUR${eol}ER  -`);
    assert.equal(minimal.status, "valid");
    assert.deepEqual(minimal.entries[0].fields, []);
    assert.equal(minimal.entries[0].bodyFrom, minimal.entries[0].bodyTo);
  }
});

test("RIS continuation values join for display but keep raw indentation and line endings", () => {
  const text = "TY  - JOUR\nN1  - \n\t first  \r\n      TY  - literal\rN1  - second\nER  -\n";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.entries[0].fields.map(({ name, raw, value }) => [name, raw, value]), [
    ["N1", "\n\t first  \r\n      TY  - literal", "first TY  - literal"],
    ["N1", "second", "second"],
  ]);
});

test("RIS percent-prefixed lines remain native continuations of an open field", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    for (const line of ["% change: 12", "  % change: 12", "% \u{1F600}"]) {
      const prefix = `TY  - JOUR${eol}`, raw = `First paragraph${eol}${line}`;
      const text = `${prefix}N1  - ${raw}${eol}ER  -`;
      const result = parse(text);
      assert.equal(result.status, "valid");
      assert.equal(result.text, text);
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.entries[0].fields, [{
        from: prefix.length, to: prefix.length + 6 + raw.length, name: "N1", rawName: "N1",
        valueFrom: prefix.length + 6, valueTo: prefix.length + 6 + raw.length,
        raw, value: `First paragraph ${line.trim()}`, editable: true,
      }]);
      const field = result.entries[0].fields[0];
      assert.equal(text.slice(field.from, field.to), `N1  - ${raw}`);
      assert.equal(text.slice(field.valueFrom, field.valueTo), raw);
    }
  }
});

test("RIS blank lines preserve open paragraphs and trailing blank continuation spans", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    for (const [continuation, value] of [
      [`${eol}Second paragraph`, "First paragraph Second paragraph"],
      [` \t${eol}${eol}  Second paragraph  `, "First paragraph Second paragraph"],
      ["", "First paragraph"],
    ]) {
      const prefix = `TY  - JOUR${eol}`, raw = `First paragraph${eol}${continuation}`;
      const text = `${prefix}AB  - ${raw}${eol}ER  -`;
      const result = parse(text);
      assert.equal(result.status, "valid", JSON.stringify(text));
      assert.equal(result.text, text);
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.entries[0].fields, [{
        from: prefix.length, to: prefix.length + 6 + raw.length, name: "AB", rawName: "AB",
        valueFrom: prefix.length + 6, valueTo: prefix.length + 6 + raw.length,
        raw, value, editable: true,
      }]);
      const field = result.entries[0].fields[0];
      assert.equal(text.slice(field.from, field.to), `AB  - ${raw}`);
      assert.equal(text.slice(field.valueFrom, field.valueTo), raw);
    }
  }
});

test("RIS unindented continuations retain their source without absorbing malformed tags", () => {
  const text = "TY  - JOUR\r\nTI  - First\r\nIn-depth discussion \r\nAU  - Author\r\nER  -\r\n";
  const result = parse(text);
  assert.equal(result.status, "valid");
  const [title, author] = result.entries[0].fields;
  assert.equal(title.raw, "First\r\nIn-depth discussion ");
  assert.equal(title.value, "First In-depth discussion");
  assert.equal(text.slice(title.from, title.to), "TI  - First\r\nIn-depth discussion ");
  assert.equal(text.slice(title.valueFrom, title.valueTo), "First\r\nIn-depth discussion ");
  assert.equal(author.name, "AU");
  assert.equal(author.value, "Author");
  for (const malformed of ["TY  -BOOK", "TI - Bad", "ER -", "X1- Bad", "TI  -Bad"]) {
    const broken = parse(`TY  - JOUR\nTI  - First\n${malformed}\nER  -`);
    assert.equal(broken.status, "invalid", malformed);
    assert.deepEqual(broken.entries, []);
    assert.ok(broken.diagnostics.some((item) => item.severity === "error"));
  }
});

test("RIS value scanning treats Unicode separators as literal content, not CR or LF", () => {
  for (const value of ["A\u2028B", "A\u2029B"]) {
    const text = `TY  - JOUR\r\nN1  - ${value}\r\nER  -\r\n`;
    const result = parse(text);
    assert.equal(result.status, "valid", JSON.stringify(value));
    const field = result.entries[0].fields[0];
    assert.equal(field.raw, value);
    assert.equal(field.value, value);
    assert.equal(text.slice(field.valueFrom, field.valueTo), value);
    assert.equal(text.slice(field.from, field.to), `N1  - ${value}`);
  }
});

test("RIS outside-record trivia stays separate while in-record percent and blank lines belong to fields", () => {
  const text = "\uFEFF% leading\r\nTY  - JOUR\nTI  - A\n% between fields\n\nAU  - B\nER  -\r\n% trailing\n";
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.deepEqual(result.entries[0].fields.map(({ from, to }) => text.slice(from, to)), [
    "TI  - A\n% between fields\n", "AU  - B",
  ]);
  assert.deepEqual(result.directives, []);
});

test("RIS requires TY before fields, a nonempty type, and one empty ER per record", () => {
  for (const broken of [
    "TY  - JOUR", "TY  - JOUR\nTI  - A", "TY  - JOUR\nTY  - BOOK\nER  -",
    "ER  -", "AU  - Nobody\nER  -", "TY  - \nER  -", "TY  - \t\nER  -",
    "TY  - JOUR\nER  - not empty", "TY  -JOUR\nER  -", "TY  - JOUR\nTI - Bad\nER  -",
    "TY  - JOUR\nTI  -Bad\nER  -", "TY  - JOUR\nordinary prose\nER  -",
    "TY  - JOUR\n      orphan continuation\nER  -", "TY  - JOUR\n% before any field\n  orphan\nER  -",
    "TY  - JOUR\nER  -\nAU  - outside",
  ]) {
    for (const prefix of ["", "TY  - BOOK\nTI  - complete\nER  -\n"]) {
      const text = prefix + broken;
      const result = parse(text);
      assert.equal(result.status, "invalid", text);
      assert.equal(result.format, "ris");
      assert.equal(result.text, text);
      assert.deepEqual(result.entries, []);
      assert.ok(result.diagnostics.some((item) => item.severity === "error" && item.code === "ris.syntax"));
    }
  }
});

test("RIS foreign text including data after the last record never produces a partial table", () => {
  for (const text of [
    "ordinary prose", "<html>TY  - JOUR</html>", "data:text/plain,TY%20%20-%20JOUR",
    "TY  - JOUR\nER  -\ntrailing prose", "prefix\nTY  - JOUR\nER  -",
    "TY  - JOUR\nER  -\ntrailing\nTY  - BOOK\nER  -", " \uFEFFTY  - JOUR\nER  -",
  ]) {
    const result = parse(text);
    assert.equal(result.status, "unrecognized", text);
    assert.equal(result.format, null);
    assert.deepEqual(result.entries, []);
    assert.ok(result.diagnostics.some((item) => item.code === "ris.unrecognized" && item.severity === "warning"));
  }
});

test("RIS empty input, whitespace, an initial BOM and percent comments are empty", () => {
  for (const text of ["", " \t\r\n", "\uFEFF", "\uFEFF % note\r\n% TY  - fake\r"]) {
    assert.deepEqual(parse(text), { text, format: "ris", status: "empty", entries: [], directives: [], diagnostics: [] });
  }
});

test("RIS diagnostics have bounded UTF-16 spans and serializable parameters", () => {
  for (const text of ["TY  -", "ER  -", "TY  - JOUR\r\nTI  - \u{1F600}", "foreign \u{1F600}"]) {
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
  const incomplete = parse("TY  - JOUR\n");
  assert.deepEqual(incomplete.diagnostics, [{
    from: 11, to: 11, severity: "error", code: "ris.syntax", params: { expected: "ER" },
  }]);
});

test("RIS scanning retains every record in a large bibliography", () => {
  const text = Array.from({ length: 2000 }, (_, i) => `TY  - JOUR\r\nID  - ${i}\r\nER  -\r\n`).join("\r\n");
  const result = parse(text);
  assert.equal(result.status, "valid");
  assert.equal(result.entries.length, 2000);
  assert.equal(result.entries[1999].fields[0].value, "1999");
  assert.equal(text.slice(result.entries[1999].from, result.entries[1999].to), "TY  - JOUR\r\nID  - 1999\r\nER  -");
});

test("RIS does not turn invalid caller types into parse diagnostics", () => {
  for (const text of [null, undefined, 42, {}, []]) assert.throws(() => parse(text), TypeError);
});
