const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const B = require("../public/iris-bibliography.js");
const bibtex = require("../public/iris-bibtex.js");
const ris = require("../public/iris-ris.js");

test("RIS requires complete records and keeps repeated authors", () => {
  const text = "TY  - JOUR\r\nAU  - Doe, Jane\r\nAU  - Doe, John\r\nTI  - Title\r\nER  - \r\n";
  const result = B.parse(text, "ris");
  assert.equal(result.status, "valid");
  assert.equal(result.entries[0].key, null);
  assert.deepEqual(result.entries[0].fields.filter((f) => f.name === "AU")
    .map((f) => f.value), ["Doe, Jane", "Doe, John"]);
  assert.equal(B.parse(text.replace("ER  - \r\n", ""), "ris").status, "invalid");
});

test("bibliography dispatch preserves RIS percent and blank continuations with every hint", () => {
  for (const [raw, value] of [
    ["First paragraph\n% change: 12", "First paragraph % change: 12"],
    ["First paragraph\n\nSecond paragraph", "First paragraph Second paragraph"],
    ["First \u{1F600}\r\n\r\n  % change: 12\r\n \t\r\nSecond paragraph", "First \u{1F600} % change: 12 Second paragraph"],
  ]) {
    const text = `\uFEFF% outside\r\nTY  - JOUR\r\nN1  - ${raw}\r\nAU  - Author\r\nER  -\r\n\r\n% outside`;
    for (const hint of [null, "bib", "ris"]) {
      const result = B.parse(text, hint);
      assert.equal(result.status, "valid", JSON.stringify([raw, hint]));
      assert.equal(result.format, "ris");
      assert.equal(result.text, text);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.entries.length, 1);
      const fields = result.entries[0].fields;
      assert.deepEqual(fields.map((field) => [field.name, field.raw, field.value]), [
        ["N1", raw, value], ["AU", "Author", "Author"],
      ]);
      assert.equal(text.slice(fields[0].from, fields[0].to), `N1  - ${raw}`);
      assert.equal(text.slice(fields[0].valueFrom, fields[0].valueTo), raw);
      const incomplete = B.parse(text.replace("ER  -\r\n", ""), hint);
      assert.equal(incomplete.status, "invalid");
      assert.deepEqual(incomplete.entries, []);
      assert.ok(incomplete.diagnostics.some((item) => item.severity === "error"));
    }
  }
});

test("extension is a hint, not proof", () => {
  assert.equal(B.parse("ordinary prose", "bib").status, "unrecognized");
  assert.equal(B.parse("", "bib").status, "empty");
  assert.equal(B.parse("", null).status, "unrecognized");
  assert.equal(B.parse("@book{a,title={A}}", null).format, "bib");
});

test("UTF-8 decoding rejects damaged bytes and preserves a BOM", () => {
  assert.throws(() => B.decodeUtf8(Uint8Array.of(0xc3, 0x28)));
  assert.equal(B.decodeUtf8(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41)), "\ufeffA");
});

test("candidate uses a known hint or only the first header after BOM, whitespace and comments", () => {
  for (const [text, hint, expected] of [
    ["ordinary prose", "bib", "bib"], ["", "ris", "ris"], ["", null, null],
    ["\uFEFF \r\n% comment\r% another\n@book{unfinished", null, "bib"],
    ["% @book{fake,}\n\tTY  - JOUR\r\n", null, "ris"], ["ty  - custom\n", null, "ris"],
    ["@string{j={J}}", null, "bib"], ["TY  -JOUR", null, "ris"],
    ["@book{k,}", "ris", "ris"], ["TY  - JOUR\nER  -", "bib", "bib"],
    ["prose\n@book{k,}", null, null], ["prose\nTY  - JOUR\nER  -", null, null],
    ["% @book{fake,}", null, null], [" \uFEFF@book{k,}", null, null],
    ["<html>@book{k,}</html>", null, null], ["data:text/plain,@book{k,}", null, null],
  ]) assert.equal(B.candidate(text, hint), expected, JSON.stringify([text, hint]));
});

test("parse recognizes content before a contradictory extension hint", () => {
  for (const hint of [null, "bib", "ris"]) {
    for (const [text, expected, parser] of [
      ["\uFEFF% comment\r\n@book{smith(2026),title={A}}\r\n", "bib", bibtex],
      ["\uFEFF% comment\r\nTY  - JOUR\r\nTI  - A\r\nER  -\r\n", "ris", ris],
    ]) {
      const result = B.parse(text, hint);
      assert.equal(result.status, "valid");
      assert.equal(result.format, expected);
      assert.equal(result.text, text);
      assert.deepEqual(result, parser.parse(text));
    }
  }
});

test("failed hint fallback preserves recognizable parser diagnostics and suppresses all entries", () => {
  for (const [text, hint, parser, status] of [
    ["TY  - JOUR\nTI  - unfinished", "bib", ris, "invalid"],
    ["@book{k,title={broken", "ris", bibtex, "invalid"],
    ["TY  - JOUR\nER  -\ntrailing prose", "bib", ris, "unrecognized"],
    ["@book{k,title={A}}\ntrailing prose", "ris", bibtex, "unrecognized"],
    ["AU  - orphan", "ris", ris, "invalid"],
  ]) {
    const result = B.parse(text, hint);
    assert.equal(result.status, status, text);
    assert.deepEqual(result.entries, []);
    assert.ok(result.diagnostics.length > 0);
    assert.deepEqual(result, parser.parse(text));
  }
});

test("empty and comment-only input needs a hint, while BibTeX directives identify an empty bibliography", () => {
  for (const text of ["", " \t\r\n", "\uFEFF", "% comment\r\n"]) {
    for (const hint of ["bib", "ris"]) {
      const result = B.parse(text, hint);
      assert.equal(result.status, "empty");
      assert.equal(result.format, hint);
      assert.equal(result.text, text);
      assert.deepEqual(result.entries, []);
    }
    assert.deepEqual(B.parse(text), { text, format: null, status: "unrecognized", entries: [], directives: [], diagnostics: [] });
  }
  const text = '@comment{kept}\r\n@string{j="J"}\r\n@preamble{j}';
  for (const hint of [null, "bib", "ris"]) {
    const result = B.parse(text, hint);
    assert.equal(result.status, "empty");
    assert.equal(result.format, "bib");
    assert.deepEqual(result, bibtex.parse(text));
    assert.deepEqual(result.directives.map(({ from, to }) => text.slice(from, to)), [
      "@comment{kept}", '@string{j="J"}', "@preamble{j}",
    ]);
  }
});

test("renamed HTML and data URLs are not decoded or accepted as bibliographies", () => {
  for (const text of [
    "<!doctype html><html><body>ordinary prose</body></html>",
    "<html>@book{k,title={A}}</html>", "data:application/x-bibtex;base64,QGJvb2t7ayx9",
    "data:text/plain,%40book%7Bk%2Ctitle%3D%7BA%7D%7D", "data:text/plain,@book{k,title={A}}",
  ]) {
    for (const hint of [null, "bib", "ris"]) {
      const result = B.parse(text, hint);
      assert.equal(result.status, "unrecognized", text);
      assert.equal(result.format, null);
      assert.equal(result.text, text);
      assert.deepEqual(result.entries, []);
    }
  }
});

test("UTF-8 decoding rejects NUL, overlong, truncated and surrogate encodings", () => {
  assert.throws(() => B.decodeUtf8(Uint8Array.of(65, 0, 66)), {
    name: "TypeError", message: "BIBLIOGRAPHY_BINARY_CONTENT",
  });
  for (const bytes of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    assert.throws(() => B.decodeUtf8(Uint8Array.from(bytes)), TypeError);
  }
});

test("UTF-8 decoding preserves source text and respects a Uint8Array subview", () => {
  const text = "\uFEFFTY  - JOUR\r\nTI  - A\u{1F600}\r\nER  -\r\n";
  assert.equal(B.decodeUtf8(new TextEncoder().encode(text)), text);
  assert.equal(B.decodeUtf8(Uint8Array.of(0xff, 0x41, 0x42, 0xff).subarray(1, 3)), "AB");
  assert.equal(B.decodeUtf8(new Uint8Array()), "");
});

test("browser and worker globals parse and decode without DOM or CommonJS", () => {
  for (const context of [{ window: {}, TextDecoder }, { TextDecoder }]) {
    for (const name of ["iris-bibtex", "iris-ris", "iris-bibliography"]) {
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../public/${name}.js`), "utf8"), context, { timeout: 1000 });
    }
    const root = context.window || context, api = root.IrisBibliography;
    assert.equal(typeof root.IrisRis.parse, "function");
    for (const [text, hint, format] of [["@book{k,}", "ris", "bib"], ["TY  - JOUR\nER  -", "bib", "ris"]]) {
      const result = api.parse(text, hint);
      assert.equal(result.status, "valid");
      assert.equal(result.format, format);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), B.parse(text, hint));
      assert.deepEqual(JSON.parse(JSON.stringify(api.project(result))), B.project(B.parse(text, hint)));
      assert.deepEqual(JSON.parse(JSON.stringify(api.metadataWarnings(result))), B.metadataWarnings(B.parse(text, hint)));
    }
    assert.equal(api.decodeUtf8(Uint8Array.of(0xef, 0xbb, 0xbf, 65)), "\uFEFFA");
    const bug = new Error("parser programmer error");
    root.IrisBibtex.parse = root.IrisRis.parse = () => { throw bug; };
    assert.equal(api.candidate("@book{unfinished", null), "bib");
    assert.equal(api.candidate("TY  - JOUR", null), "ris");
    assert.equal(api.candidate("ordinary prose", "bib"), "bib");
    assert.throws(() => api.parse("@book{k,}", "ris"), (error) => error === bug);
  }
});

test("bibliography calls do not swallow invalid text argument errors", () => {
  for (const text of [null, undefined, 42, {}, []]) {
    assert.throws(() => B.parse(text, "bib"), TypeError);
    assert.throws(() => B.candidate(text, null), TypeError);
  }
});

test("the shared core exports the Task 3 read-only APIs", () => {
  for (const name of ["project", "visibleColumns", "queryRows", "describeField", "fieldsForType", "metadataWarnings"]) {
    assert.equal(typeof B[name], "function", name);
  }
});

test("BibTeX catalogs supply absent common and contextual fields for the documented families", () => {
  for (const [types, expected] of [
    [["article"], { journal: "journal", journaltitle: "journal", volume: "volume", number: "number", pages: "pages", eid: "articleId" }],
    [["book", "mvbook", "collection", "mvcollection", "proceedings", "mvproceedings"],
      { editor: "editors", publisher: "publisher", address: "location", location: "location", edition: "edition", series: "series", volume: "volume", isbn: "isbn" }],
    [["inbook", "incollection", "inproceedings", "conference"],
      { booktitle: "bookTitle", editor: "editors", publisher: "publisher", pages: "pages", eventtitle: "eventTitle", eventdate: "eventDate", venue: "eventLocation" }],
    [["phdthesis", "mastersthesis", "thesis"], { school: "institution", institution: "institution", type: "workType", location: "location" }],
    [["techreport", "report"], { institution: "institution", type: "workType", number: "number", address: "location" }],
    [["online", "electronic", "www"], { organization: "organization", date: "date", urldate: "accessDate" }],
  ]) {
    for (const type of types) {
      const catalog = B.fieldsForType("bib", type);
      for (const [name, label] of Object.entries({ author: "authors", title: "title", year: "year", date: "date", ...expected, doi: "doi", url: "url" })) {
        assert.deepEqual(catalog.find((field) => field.name === name), {
          name, labelKey: `bibliography.fields.${label}`, primary: true, repeatable: false,
        }, `${type}:${name}`);
      }
      assert.equal(catalog.length, new Set(catalog.map((field) => field.name)).size, type);
    }
  }
});

test("RIS catalogs describe native fields without creating a citation key or guessing overloaded tags", () => {
  for (const [types, expected] of [
    [["JOUR", "EJOUR"], { T2: "journal", JO: "journal", JF: "journal", VL: "volume", IS: "issue", SP: "pages", EP: "endPage", SN: "issn" }],
    [["BOOK", "EBOOK", "EDBOOK"], { ED: "editors", PB: "publisher", CY: "location", ET: "edition", T2: "series", VL: "volume", SN: "isbn", SP: null }],
    [["CHAP", "ECHAP"], { T2: "bookTitle", BT: "bookTitle", ED: "editors", PB: "publisher", SP: "pages", EP: "endPage" }],
    [["CONF", "CPAPER"], { T2: null, C3: null, CY: null, ED: "editors", PB: "publisher", SP: "pages", EP: "endPage" }],
    [["THES"], { PB: "institution", M3: "workType", CY: "location", SP: null }],
    [["RPRT"], { PB: "institution", M3: "workType", SN: null, CY: "location" }],
    [["ELEC", "WEB"], { PB: "publisher", A2: null, DA: "date", Y2: "accessDate", UR: "url" }],
  ]) {
    for (const type of types) {
      const catalog = B.fieldsForType("ris", type);
      for (const [name, label] of Object.entries({ ID: "id", AU: type === "EDBOOK" ? "editors" : "authors", TI: "title", PY: "yearDate", Y1: "yearDate", DA: "date", ...expected, DO: "doi", UR: "url" })) {
        const field = catalog.find((item) => item.name === name);
        assert.ok(field, `${type}:${name}`);
        assert.equal(field.labelKey, label === null ? null : `bibliography.fields.${label}`, `${type}:${name}`);
        assert.equal(field.primary, true, `${type}:${name}`);
      }
      assert.equal(catalog.some((field) => ["key", "TY", "ER"].includes(field.name)), false);
      assert.equal(catalog.length, new Set(catalog.map((field) => field.name)).size, type);
    }
  }
});

test("descriptors normalize case, retain safe out-of-type labels and fall back for custom or ambiguous names", () => {
  for (const [format, type, name, labelKey, primary, repeatable] of [
    ["bib", "ARTICLE", "JOURNALTITLE", "bibliography.fields.journal", true, false],
    ["bib", "book", "journal", "bibliography.fields.journal", false, false],
    ["bib", "custom", "author", "bibliography.fields.authors", true, false],
    ["bib", "article", "x_score", null, false, false],
    ["bib", "article", "__proto__", null, false, false],
    ["bib", "constructor", "constructor", null, false, false],
    ["ris", "jour", "au", "bibliography.fields.authors", true, true],
    ["ris", "CHAP", "A2", "bibliography.fields.editors", true, true],
    ["ris", "BOOK", "BT", "bibliography.fields.title", true, false],
    ["ris", "ELEC", "UR", "bibliography.fields.url", true, true],
    ["ris", "THES", "KW", "bibliography.fields.keywords", false, true],
    ["ris", "BOOK", "JO", null, false, false],
    ["ris", "CPAPER", "JF", null, false, false],
    ["ris", "CUSTOM", "PB", null, false, false],
    ["ris", "CUSTOM", "SN", null, false, false],
    ["ris", "CUSTOM", "T2", null, false, false],
    ["ris", "CUSTOM", "SP", null, false, false],
    ["ris", "CUSTOM", "EP", null, false, false],
    ["ris", "CUSTOM", "Y2", null, false, false],
    ["ris", "JOUR", "C7", null, false, false],
    ["ris", "THES", "A2", null, false, true],
    ["ris", "CUSTOM", "ZZ", null, false, false],
  ]) assert.deepEqual(B.describeField(format, type, name), { labelKey, primary, repeatable }, `${format}:${type}:${name}`);
});

test("catalogs for custom types expose common fields and cannot mutate later descriptor results", () => {
  for (const [format, type, title, contextual] of [
    ["bib", "custom", "title", "journal"], ["bib", "contribution", "title", "booktitle"], ["ris", "CUSTOM", "TI", "T2"],
  ]) {
    const catalog = B.fieldsForType(format, type);
    assert.ok(catalog.some((field) => field.name === title));
    assert.equal(catalog.some((field) => field.name === contextual), false);
    catalog.find((field) => field.name === title).labelKey = "changed";
    catalog.splice(0);
    assert.equal(B.describeField(format, type, title).labelKey, "bibliography.fields.title");
    assert.ok(B.fieldsForType(format, type).some((field) => field.name === title));
  }
});

test("RIS title aliases precede dates only when the type identifies a primary title", () => {
  for (const [type, expected] of [
    ["BOOK", ["ris:ID", "type", "ris:AU", "ris:A1", "ris:TI", "ris:T1", "ris:BT", "ris:PY", "ris:DA", "ris:T2"]],
    ["CHAP", ["ris:ID", "type", "ris:AU", "ris:A1", "ris:TI", "ris:T1", "ris:PY", "ris:DA", "ris:T2", "ris:BT"]],
  ]) {
    const text = `TY  - ${type}\nBT  - Book\nT2  - Series or container\nPY  - 2026\nDA  - 2026/09/10\n` +
      "T1  - Alias\nTI  - Title\nA1  - Alternate\nAU  - Author\nID  - ref\nER  -";
    assert.deepEqual(B.project(B.parse(text, "ris")).columns.map((column) => column.id), expected);
    const catalog = B.fieldsForType("ris", type);
    assert.deepEqual(catalog.filter((field) => expected.includes(`ris:${field.name}`)).map((field) => `ris:${field.name}`),
      expected.filter((id) => id !== "type"));
  }
});

test("mixed types expose all populated native and custom columns", () => {
  const parsed = B.parse("@article{a,title={A},journal={J},x_score={0}}\n" +
    "@book{b,title={B},publisher={P},isbn={},x_note={kept}}", "bib");
  const table = B.project(parsed);
  const ids = table.columns.map((c) => c.id);
  for (const id of ["bib:journal", "bib:publisher", "bib:x_score", "bib:x_note"])
    assert.ok(ids.includes(id), id);
  assert.equal(ids.includes("bib:isbn"), false);
  const hidden = new Set(["bib:journal"]);
  assert.equal(B.visibleColumns(table.columns, hidden).some((c) => c.id === "bib:journal"), false);
  assert.equal(B.queryRows(table, "J", null).length, 1);
  assert.deepEqual(table.columns.map((c) => c.id), ids);
  assert.equal(parsed.text.includes("x_note={kept}"), true);
});

test("projection orders common, contextual and custom columns independently of field and entry order", () => {
  const sources = [
    "@book{b,x_z={z},publisher={P},title={B},author={Author},date={2026-09-10},year={2026},x_a={a}}",
    "@article{a,journaltitle={Long},journal={Short},title={A},isbn={out of type},x_blank={ \t},__proto__={safe}}",
  ];
  for (const text of [sources.join("\n"), sources.toReversed().join("\n")]) {
    const table = B.project(B.parse(text, "bib"));
    assert.deepEqual(table.columns.map((column) => column.id), [
      "key", "type", "bib:author", "bib:title", "bib:year", "bib:date", "bib:journal", "bib:journaltitle",
      "bib:publisher", "bib:isbn", "bib:__proto__", "bib:x_a", "bib:x_z",
    ]);
    assert.deepEqual(table.columns.find((column) => column.id === "bib:__proto__"), {
      id: "bib:__proto__", labelKey: null, nativeName: "__proto__",
    });
    assert.equal(table.rows.find((row) => row.cells.key === "a").cells["bib:isbn"], "out of type");
  }
});

test("RIS columns retain native IDs and use native labels when populated type contexts disagree", () => {
  const sources = [
    "TY  - JOUR\nT2  - Journal\nSN  - ISSN\nPB  - Press\nID  - 0\nZZ  - custom\nER  -\n",
    "TY  - BOOK\nT2  - Series\nSN  - ISBN\nPB  - Books\nER  -\n",
    "TY  - THES\nPB  - University\nER  -\n",
  ];
  for (const text of [sources.join(""), sources.toReversed().join("")]) {
    const parsed = B.parse(text, "ris"), table = B.project(parsed);
    assert.deepEqual(table.columns.slice(0, 2), [
      { id: "ris:ID", nativeName: "ID", labelKey: "bibliography.fields.id" },
      { id: "type", nativeName: "TY", labelKey: "bibliography.fields.type" },
    ]);
    for (const name of ["T2", "SN", "PB", "ZZ"]) {
      assert.deepEqual(table.columns.find((column) => column.id === `ris:${name}`), {
        id: `ris:${name}`, nativeName: name, labelKey: null,
      });
    }
    assert.equal(table.columns.some((column) => column.id === "key"), false);
    assert.equal(table.rows.find((row) => row.cells.type === "JOUR").cells["ris:ID"], "0");
    assert.ok(parsed.entries.every((entry) => entry.key === null));
  }
  const table = B.project(B.parse("TY  - BOOK\nPB  - Press\nER  -\nTY  - THES\nPB  - \nER  -", "ris"));
  assert.equal(table.columns.find((column) => column.id === "ris:PB").labelKey, "bibliography.fields.publisher");
});

test("repeated occurrences, full dates, literal HTML and complex BibTeX remain display strings with unchanged source", () => {
  for (const [text, format, expected] of [
    ["\uFEFF% comment\r\n@article{k,author={First},author={Second},date={2026-09-10},title={<img src=x onerror=alert(1)>},note=macro # { \\TeX},x={0}}\r\n", "bib",
      { "bib:author": "First\nSecond", "bib:date": "2026-09-10", "bib:title": "<img src=x onerror=alert(1)>", "bib:note": "macro # { \\TeX}", "bib:x": "0" }],
    ["\uFEFF% comment\r\nTY  - JOUR\r\nAU  - First\r\nAU  - \r\nAU  - Second\r\nA1  - Alias\r\nDA  - 2026/09/10\r\nY2  - 2026/09/11\r\nTI  - <script>alert(1)</script>\r\nN1  - Line\r\n  continued \u{1F600}\r\nER  -\r\n", "ris",
      { "ris:AU": "First\n\nSecond", "ris:A1": "Alias", "ris:DA": "2026/09/10", "ris:Y2": "2026/09/11", "ris:TI": "<script>alert(1)</script>", "ris:N1": "Line continued \u{1F600}" }],
  ]) {
    const parsed = B.parse(text, format), original = structuredClone(parsed);
    const table = B.project(parsed);
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0].entryIndex, 0);
    for (const [id, value] of Object.entries(expected)) assert.equal(table.rows[0].cells[id], value, id);
    B.visibleColumns(table.columns, new Set(table.columns.map((column) => column.id)));
    B.queryRows(table, "", { id: "type", descending: true });
    B.metadataWarnings(parsed);
    assert.deepEqual(parsed, original);
    for (const field of parsed.entries[0].fields) assert.equal(parsed.text.slice(field.valueFrom, field.valueTo), field.raw);
  }
});

test("blank values do not create columns or fake identifiers and non-valid input has no partial table", () => {
  for (const [text, format] of [["@misc{,title={ \t},x={}}", "bib"], ["TY  - CUSTOM\nID  - \t\nZZ  - \nER  -", "ris"]]) {
    const table = B.project(B.parse(text, format));
    assert.deepEqual(table.columns.map((column) => column.id), ["type"]);
    assert.equal(table.rows.length, 1);
    assert.equal(table.rows[0].cells.key, undefined);
  }
  for (const [text, format] of [["", "bib"], ["% comment", "ris"], ["@string{m={M}}", "bib"], ["ordinary text", null],
    ["@book{k,}\n@book{broken", "bib"], ["TY  - JOUR\nER  -\nTY  - BOOK", "ris"]]) {
    assert.deepEqual(B.project(B.parse(text, format)), { columns: [], rows: [] });
  }
});

test("visibleColumns supports hiding all and restoring without mutating session exclusions or the column union", () => {
  const columns = [{ id: "type", labelKey: null, nativeName: "TY" }, { id: "ris:TI", labelKey: null, nativeName: "TI" }];
  const hidden = new Set(["type", "ris:TI", "ris:ZZ"]), original = structuredClone(columns);
  assert.deepEqual(B.visibleColumns(columns, hidden), []);
  assert.deepEqual(B.visibleColumns(columns, new Set()), columns);
  assert.deepEqual(B.visibleColumns([...columns, { id: "ris:AU", labelKey: null, nativeName: "AU" }], hidden).map((column) => column.id), ["ris:AU"]);
  assert.deepEqual([...hidden], ["type", "ris:TI", "ris:ZZ"]);
  assert.deepEqual(columns, original);
});

test("queryRows searches all cells case-insensitively even when every column is hidden", () => {
  const table = B.project(B.parse("@article{a,title={First},x_hidden={Needle}}\n@book{b,title={Second}}", "bib"));
  const original = structuredClone(table);
  assert.deepEqual(B.visibleColumns(table.columns, new Set(table.columns.map((column) => column.id))), []);
  assert.deepEqual(B.queryRows(table, " nEeDlE ", null).map((row) => row.entryIndex), [0]);
  assert.deepEqual(B.queryRows(table, "BOOK", null).map((row) => row.entryIndex), [1]);
  assert.deepEqual(B.queryRows(table, "not here", null), []);
  assert.deepEqual(B.queryRows(table, " \t", null).map((row) => row.entryIndex), [0, 1]);
  assert.deepEqual(table, original);
});

test("queryRows sorts stably with empty cells last in both directions and never reorders the projection", () => {
  const table = { columns: [{ id: "bib:title", labelKey: null, nativeName: "title" }], rows: [
    { entryIndex: 0, cells: { "bib:title": "Beta" } }, { entryIndex: 1, cells: {} },
    { entryIndex: 2, cells: { "bib:title": "alpha" } }, { entryIndex: 3, cells: { "bib:title": "Alpha" } },
    { entryIndex: 4, cells: { "bib:title": " \t" } }, { entryIndex: 5, cells: { "bib:title": "0" } },
  ] };
  const original = structuredClone(table);
  assert.deepEqual(B.queryRows(table, "", { id: "bib:title", descending: false }).map((row) => row.entryIndex), [5, 2, 3, 0, 1, 4]);
  assert.deepEqual(B.queryRows(table, "", { id: "bib:title", descending: true }).map((row) => row.entryIndex), [0, 2, 3, 5, 1, 4]);
  assert.deepEqual(B.queryRows(table, "alpha", { id: "bib:title", descending: true }).map((row) => row.entryIndex), [2, 3]);
  assert.deepEqual(B.queryRows(table, "", { id: "missing", descending: true }), table.rows);
  assert.deepEqual(B.queryRows(table, "", null), table.rows);
  assert.deepEqual(table, original);
});

test("RIS metadataWarnings emits only the three missing common groups without changing validity or parser diagnostics", () => {
  const parsed = B.parse("\uFEFF% \u{1F600}\r\nTY  - JOUR\r\nTI  - \t\r\nAU  - \r\nDA  - \r\nDO  - present\r\nER  -", "ris");
  const original = structuredClone(parsed), { from, to } = parsed.entries[0].typeRange;
  assert.deepEqual(B.metadataWarnings(parsed), [
    { from, to, severity: "warning", code: "ris.missingMetadata", params: { fields: "TI/T1" } },
    { from, to, severity: "warning", code: "ris.missingMetadata", params: { fields: "AU/A1/ED/A2" } },
    { from, to, severity: "warning", code: "ris.missingMetadata", params: { fields: "PY/Y1/DA" } },
  ]);
  assert.equal(parsed.text.slice(from, to), "JOUR");
  assert.equal(parsed.status, "valid");
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed, original);
});

test("RIS metadataWarnings recognizes native title, author/editor and date aliases without requiring ID, DOI or ISBN", () => {
  const records = [];
  for (const [type, titleTags, authorTags] of [
    ["JOUR", ["TI", "T1"], ["AU", "A1", "ED", "A2"]],
    ["BOOK", ["TI", "T1", "BT"], ["AU", "A1", "ED", "A2", "A3"]],
    ["CHAP", ["TI", "T1"], ["AU", "A1", "ED", "A2"]],
    ["CUSTOM", ["TI", "T1"], ["AU", "A1", "ED"]],
  ]) {
    for (const title of titleTags) for (const author of authorTags) for (const date of ["PY", "Y1", "DA"]) {
      records.push(`TY  - ${type}\n${title}  - 0\n${author}  - Contributor\n${date}  - 2026/09/10\nER  -\n`);
    }
  }
  const parsed = B.parse(records.join(""), "ris");
  assert.equal(parsed.status, "valid");
  assert.equal(parsed.entries.length, 111);
  assert.deepEqual(B.metadataWarnings(parsed), []);
});

test("RIS book A3 editors have repeatable catalog metadata and satisfy contributor warnings", () => {
  for (const type of ["BOOK", "EBOOK", "EDBOOK"]) {
    const parsed = B.parse(`TY  - ${type}\r\nTI  - Title\r\nA3  - First\r\nA3  - Second\r\nPY  - 2026\r\nER  -`, "ris");
    const original = structuredClone(parsed);
    assert.deepEqual(B.describeField("ris", type.toLowerCase(), "a3"), {
      labelKey: "bibliography.fields.editors", primary: true, repeatable: true,
    });
    assert.deepEqual(B.fieldsForType("ris", type).filter((field) => field.name === "A3"), [
      { name: "A3", labelKey: "bibliography.fields.editors", primary: true, repeatable: true },
    ]);
    assert.deepEqual(B.metadataWarnings(parsed), []);
    const table = B.project(parsed);
    assert.deepEqual(table.columns.find((column) => column.id === "ris:A3"), {
      id: "ris:A3", nativeName: "A3", labelKey: "bibliography.fields.editors",
    });
    assert.equal(table.rows[0].cells["ris:A3"], "First\nSecond");
    assert.deepEqual(parsed, original);
    const blank = B.parse(`TY  - ${type}\nTI  - Title\nA3  - \t\nPY  - 2026\nER  -`, "ris");
    assert.equal(B.metadataWarnings(blank).length, 1, "blank editors still warn");
  }
  for (const type of ["THES", "CHAP", "CUSTOM"]) {
    assert.deepEqual(B.describeField("ris", type, "A3"), { labelKey: null, primary: false, repeatable: true });
    assert.equal(B.fieldsForType("ris", type).some((field) => field.name === "A3"), false);
  }
});

test("EDBOOK AU editors retain native occurrences and mixed BOOK roles use a native column label", () => {
  const sources = [
    "TY  - BOOK\nTI  - Authored\nAU  - Author\nPY  - 2026\nER  -\n",
    "TY  - EDBOOK\nTI  - Edited\nAU  - First editor\nAU  - Second editor\nPY  - 2026\nER  -\n",
  ];
  for (const text of [sources.join(""), sources.toReversed().join("")]) {
    const parsed = B.parse(text, "ris"), original = structuredClone(parsed), table = B.project(parsed);
    assert.deepEqual(table.columns.find((column) => column.id === "ris:AU"), {
      id: "ris:AU", nativeName: "AU", labelKey: null,
    });
    assert.equal(table.rows.find((row) => row.cells.type === "BOOK").cells["ris:AU"], "Author");
    assert.equal(table.rows.find((row) => row.cells.type === "EDBOOK").cells["ris:AU"], "First editor\nSecond editor");
    assert.equal(table.columns.some((column) => column.id === "ris:A3"), false, "do not retag AU as A3");
    assert.deepEqual(B.metadataWarnings(parsed), []);
    assert.deepEqual(parsed, original);
  }
  assert.deepEqual(B.describeField("ris", "edbook", "au"), {
    labelKey: "bibliography.fields.editors", primary: true, repeatable: true,
  });
  assert.deepEqual(B.fieldsForType("ris", "EDBOOK").filter((field) => field.name === "AU"), [
    { name: "AU", labelKey: "bibliography.fields.editors", primary: true, repeatable: true },
  ]);
  assert.deepEqual(B.project(B.parse(sources[1], "ris")).columns.find((column) => column.id === "ris:AU"), {
    id: "ris:AU", nativeName: "AU", labelKey: "bibliography.fields.editors",
  });
  assert.equal(B.describeField("ris", "EDBOOK", "A1").labelKey, "bibliography.fields.authors", "the verified EndNote override concerns AU only");
});

test("RIS container titles and access dates do not stand in for missing title and publication metadata", () => {
  const parsed = B.parse("TY  - CHAP\nBT  - Container\nED  - Editor\nPY  - 2026\nER  -\n" +
    "TY  - ELEC\nTI  - Page\nAU  - Author\nY2  - 2026/09/10\nER  -", "ris");
  assert.deepEqual(B.metadataWarnings(parsed).map((item) => [item.from, item.params.fields]), [
    [parsed.entries[0].typeRange.from, "TI/T1"], [parsed.entries[1].typeRange.from, "PY/Y1/DA"],
  ]);
});

test("metadataWarnings adds nothing for BibTeX or non-valid results", () => {
  const bib = B.parse("@book{k,}", "bib"), original = structuredClone(bib);
  assert.equal(bib.diagnostics.filter((item) => item.code === "bibtex.missingMetadata").length, 3);
  assert.deepEqual(B.metadataWarnings(bib), []);
  assert.deepEqual(bib, original);
  for (const [text, format] of [["", "ris"], ["ordinary", null], ["TY  - JOUR", "ris"]]) {
    assert.deepEqual(B.metadataWarnings(B.parse(text, format)), []);
  }
});
