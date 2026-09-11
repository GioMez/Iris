/* Iris - bibliography recognition, descriptors and read-only projection */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./iris-bibtex.js"), require("./iris-ris.js"));
  } else root.IrisBibliography = factory(root.IrisBibtex, root.IrisRis);
})(typeof window === "undefined" ? globalThis : window, function (bibtex, ris) {
  /**
   * @typedef {"bib" | "ris"} Format
   * @typedef {{from: number, to: number}} Span
   * @typedef {Span & {severity: "error" | "warning", code: string,
   *   params: Object<string, string | number>}} Diagnostic
   * @typedef {Span & {name: string, rawName: string, valueFrom: number,
   *   valueTo: number, raw: string, value: string, editable: boolean}} Field
   * @typedef {Span & {type: string, typeRange: Span, key: string | null,
   *   keyRange: Span | null, bodyFrom: number, bodyTo: number, fields: Field[]}} Entry
   * @typedef {{text: string, format: Format | null,
   *   status: "valid" | "empty" | "invalid" | "unrecognized",
   *   entries: Entry[], directives: Span[], diagnostics: Diagnostic[]}} Parsed
   * @typedef {{id: string, labelKey: string | null, nativeName: string}} Column
   * @typedef {{entryIndex: number, cells: Object<string, string>}} Row
   * @typedef {{columns: Column[], rows: Row[]}} Projection
   * @typedef {{labelKey: string | null, primary: boolean, repeatable: boolean}} Descriptor
   */

  /**
   * Cheap pre-load candidacy, not validation. A known hint wins here; otherwise
   * inspect only the first header after an initial BOM, whitespace and percent
   * comments. Do not search inside foreign text or invoke either full parser.
   * @param {string} text
   * @param {Format | null} hint
   * @returns {Format | null}
   */
  function candidate(text, hint = null) {
    if (typeof text !== "string") throw new TypeError("BIBLIOGRAPHY_TEXT_REQUIRED");
    if (hint === "bib" || hint === "ris") return hint;
    let i = text[0] === "\uFEFF" ? 1 : 0;
    while (i < text.length) {
      if (/[^\S\uFEFF]/.test(text[i])) i++;
      else if (text[i] === "%") {
        while (i < text.length && text[i] !== "\r" && text[i] !== "\n") i++;
      } else break;
    }
    if (text[i] === "@") return "bib";
    if (/^TY {2}-$/i.test(text.slice(i, i + 5))) return "ris";
    return null;
  }

  /**
   * Content gets the first parsing attempt, then a different hint if needed.
   * If neither succeeds, retain the content parser's diagnostics unchanged.
   * Empty input requires a hint; BibTeX directives can identify their own format.
   * All source text, UTF-16 spans and native occurrences come from the parsers.
   * @param {string} text
   * @param {Format | null} hint
   * @returns {Parsed}
   */
  function parse(text, hint = null) {
    const detected = candidate(text), formats = detected ? [detected] : [];
    if ((hint === "bib" || hint === "ris") && hint !== detected) formats.push(hint);
    let first = null;
    for (const format of formats) {
      const result = (format === "bib" ? bibtex : ris).parse(text);
      if (result.status === "valid" || result.status === "empty") return result;
      if (!first) first = result;
    }
    return first || { text, format: null, status: "unrecognized", entries: [], directives: [], diagnostics: [] };
  }

  /**
   * Decode text without replacing damaged UTF-8, dropping its BOM or normalizing
   * line endings. NUL is rejected as binary content; errors propagate to callers.
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function decodeUtf8(bytes) {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new TypeError("BIBLIOGRAPHY_BINARY_CONTENT");
    return text;
  }

  const families = {
    bib: [
      ["article", "article"],
      ["book mvbook collection mvcollection proceedings mvproceedings", "book"],
      ["inbook incollection inproceedings conference", "contribution"],
      ["phdthesis mastersthesis thesis", "thesis"], ["techreport report", "report"],
      ["online electronic www", "online"],
    ],
    ris: [
      ["JOUR EJOUR", "article"], ["BOOK EBOOK EDBOOK", "book"],
      ["CHAP ECHAP CONF CPAPER", "contribution"], ["THES", "thesis"],
      ["RPRT", "report"], ["ELEC WEB", "online"],
    ],
  };

  // Native names, label suffix, primary families/types (* = common), repeatable.
  // Empty scope is supplementary; null labels deliberately retain native names.
  // Order is common fields, contextual fields, then supplementary fields.
  const catalogs = {
    bib: [
      ["author", "authors", "*"], ["title", "title", "*"],
      ["year", "year", "*"], ["date", "date", "*"],
      ["journal journaltitle", "journal", "article"],
      ["volume", "volume", "article book contribution"],
      ["number", "number", "article book report"], ["issue", "issue", "article"],
      ["pages", "pages", "article contribution"], ["eid", "articleId", "article"],
      ["booktitle", "bookTitle", "contribution"], ["editor", "editors", "book contribution"],
      ["publisher", "publisher", "book contribution"],
      ["address location", "location", "book contribution thesis report"],
      ["edition", "edition", "book"], ["series", "series", "book"],
      ["isbn", "isbn", "book contribution"], ["school", "institution", "thesis"],
      ["institution", "institution", "thesis report"], ["type", "workType", "thesis report"],
      ["eventtitle", "eventTitle", "contribution"], ["eventdate", "eventDate", "contribution"],
      ["venue", "eventLocation", "contribution"], ["organization", "organization", "online contribution"],
      ["urldate", "accessDate", "online"], ["doi", "doi", "*"], ["url", "url", "*"],
      ["abstract", "abstract", ""], ["keywords", "keywords", ""], ["note", "notes", ""],
    ],
    ris: [
      ["ID", "id", "*"],
      // EndNote's EDBOOK AU denotes editors; keep this override before the default.
      ["AU", "editors", "EDBOOK", true], ["AU A1", "authors", "*", true], ["TI T1", "title", "*"],
      ["PY Y1", "yearDate", "*"], ["DA", "date", "*"],
      ["T2 JO JF", "journal", "article"], ["T2", "series", "book"],
      ["T2 BT", "bookTitle", "CHAP ECHAP"], ["BT", "title", "BOOK"],
      ["T2 C3 CY", null, "CONF CPAPER"],
      ["VL", "volume", "article book contribution"], ["IS", "issue", "article"],
      ["SP", "pages", "article contribution report"], ["EP", "endPage", "article contribution report"],
      ["SP", null, "book thesis"], ["ED", "editors", "*", true],
      ["A2", "editors", "article book contribution", true], ["A2", null, "online", true],
      ["A3", "editors", "book", true],
      ["PB", "publisher", "article book contribution online"], ["PB", "institution", "thesis report"],
      ["CY", "location", "book thesis report CHAP ECHAP"], ["ET", "edition", "book"],
      ["SN", "issn", "article"], ["SN", "isbn", "book CHAP ECHAP"], ["SN", null, "report CONF CPAPER"],
      ["M3", "workType", "thesis report"], ["Y2", "accessDate", "online"],
      ["DO", "doi", "*"], ["UR", "url", "*", true],
      ["AB N2", "abstract", ""], ["KW", "keywords", "", true], ["N1", "notes", ""],
    ],
  };
  const commonLabels = ["id", "authors", "title", "year", "yearDate", "date"].map((label) => `bibliography.fields.${label}`);

  /**
   * Schemas guide labels/forms, never validation or field retention. RIS meanings
   * are intentionally limited to these families: e.g. SP is not a book's first
   * page, SN is ambiguous on reports, and conference T2 is not safely a book title.
   * DA is only "Date", not a claim that an exporter supplied a publication date.
   * @param {Format} format
   * @param {string} type
   * @param {string} nativeName
   * @returns {Descriptor}
   */
  function describeField(format, type, nativeName) {
    type = format === "bib" ? type.toLowerCase() : type.toUpperCase();
    const name = format === "bib" ? nativeName.toLowerCase() : nativeName.toUpperCase();
    const family = families[format].find(([types]) => types.split(" ").includes(type))?.[1];
    let fallback = { labelKey: null, primary: false, repeatable: false };
    for (const [names, label, scope, repeatable = false] of catalogs[format]) {
      if (!names.split(" ").includes(name)) continue;
      const primary = scope === "*" || scope.split(" ").some((item) => item === family || (format === "ris" && item === type));
      const descriptor = {
        labelKey: label !== null && (format === "bib" || primary || scope === "") ? `bibliography.fields.${label}` : null,
        primary, repeatable,
      };
      if (primary || scope === "") return descriptor;
      fallback = descriptor;
    }
    return fallback;
  }

  /**
   * Ordered common/contextual fields, including absent fields for a new reference,
   * followed by supplementary fields. Results are fresh, mutable caller-owned data.
   * @param {Format} format
   * @param {string} type
   * @returns {Array<Descriptor & {name: string}>}
   */
  function fieldsForType(format, type) {
    const fields = [], seen = new Set();
    for (const [names, , scope] of catalogs[format]) {
      for (const name of names.split(" ")) {
        if (seen.has(name)) continue;
        seen.add(name);
        const descriptor = describeField(format, type, name);
        if (descriptor.primary || scope === "") fields.push({ name, ...descriptor });
      }
    }
    return fields.sort((a, b) => ((commonLabels.indexOf(a.labelKey) + 1) || commonLabels.length + 1) -
      ((commonLabels.indexOf(b.labelKey) + 1) || commonLabels.length + 1));
  }

  /**
   * Union over the entire valid document, before search or column exclusions.
   * Display strings join every native occurrence with a newline, even duplicates
   * the schema calls non-repeatable. Never use cells to regenerate source text.
   * Conflicting labels across populated RIS contexts fall back to the native tag.
   * @param {Parsed} parsed
   * @returns {Projection}
   */
  function project(parsed) {
    if (parsed.status !== "valid" || !parsed.entries.length) return { columns: [], rows: [] };
    const format = parsed.format, columns = new Map(), ranks = new Map(), descriptors = new Map();
    const order = new Map([["key", 0], ["ris:ID", 0], ["type", 1]]);
    for (const [names] of catalogs[format]) {
      for (const name of names.split(" ")) {
        const id = `${format}:${name}`;
        if (!order.has(id)) order.set(id, order.size);
      }
    }
    columns.set("type", { id: "type", nativeName: format === "ris" ? "TY" : "type", labelKey: "bibliography.fields.type" });
    ranks.set("type", 1);
    const rows = parsed.entries.map((entry, entryIndex) => {
      const cells = { type: entry.type };
      if (format === "bib" && entry.key !== null && entry.key.trim()) {
        cells.key = entry.key;
        columns.set("key", { id: "key", nativeName: "key", labelKey: "bibliography.fields.key" });
        ranks.set("key", 0);
      }
      if (!descriptors.has(entry.type)) descriptors.set(entry.type, new Map());
      const entryDescriptors = descriptors.get(entry.type);
      for (const field of entry.fields) {
        const id = `${format}:${field.name}`;
        cells[id] = Object.hasOwn(cells, id) ? cells[id] + "\n" + field.value : field.value;
        if (!field.value.trim()) continue;
        if (!entryDescriptors.has(field.name)) entryDescriptors.set(field.name, describeField(format, entry.type, field.name));
        const descriptor = entryDescriptors.get(field.name), previous = columns.get(id);
        if (!previous) columns.set(id, { id, nativeName: field.name, labelKey: descriptor.labelKey });
        else if (previous.labelKey !== descriptor.labelKey) previous.labelKey = null;
        // Common meaning takes precedence over tag order (BT is a title only on BOOK).
        const commonRank = commonLabels.indexOf(descriptor.labelKey);
        const rank = descriptor.labelKey !== null || descriptor.primary ?
          (commonRank < 0 ? commonLabels.length : commonRank) * order.size + order.get(id) : Infinity;
        ranks.set(id, Math.min(ranks.get(id) ?? Infinity, rank));
      }
      return { entryIndex, cells };
    });
    return {
      columns: [...columns.values()].sort((a, b) => (ranks.get(a.id) - ranks.get(b.id)) ||
        (a.nativeName < b.nativeName ? -1 : a.nativeName > b.nativeName ? 1 : 0)),
      rows,
    };
  }

  /** @param {Column[]} columns @param {Set<string>} hidden @returns {Column[]} */
  function visibleColumns(columns, hidden) {
    return columns.filter((column) => !hidden.has(column.id));
  }

  /**
   * Case-insensitive literal search and lexical sort, with empty cells last in
   * either direction. Stable ties retain source order; null/unknown sort restores it.
   * Visibility and pagination belong to the caller, not this full-file query.
   * @param {Projection} projection
   * @param {string} query
   * @param {{id: string, descending: boolean} | null} sort
   * @returns {Row[]}
   */
  function queryRows(projection, query, sort) {
    query = query.trim().toLowerCase();
    const rows = projection.rows.filter((row) => !query || Object.values(row.cells).some((value) => value.toLowerCase().includes(query)));
    if (!sort || !projection.columns.some((column) => column.id === sort.id)) return rows;
    return rows.sort((a, b) => {
      const left = (a.cells[sort.id] || "").trim().toLowerCase(), right = (b.cells[sort.id] || "").trim().toLowerCase();
      if (!left || !right) return Number(!left) - Number(!right);
      return (left < right ? -1 : left > right ? 1 : 0) * (sort.descending ? -1 : 1);
    });
  }

  /**
   * Supplement RIS parsing only; BibTeX already emits its common metadata hints.
   * A warning means an entire group is blank, not that every primary field is
   * required. Callers concatenate with parsed.diagnostics without mutating it.
   * @param {Parsed} parsed
   * @returns {Diagnostic[]}
   */
  function metadataWarnings(parsed) {
    if (parsed.format !== "ris" || parsed.status !== "valid") return [];
    const diagnostics = [], groupsByType = new Map();
    for (const entry of parsed.entries) {
      if (!groupsByType.has(entry.type)) {
        const fields = fieldsForType("ris", entry.type);
        groupsByType.set(entry.type, [["title"], ["authors", "editors"], ["yearDate", "date"]].map((labels) =>
          fields.filter((field) => labels.some((label) => field.labelKey === `bibliography.fields.${label}`)).map((field) => field.name)));
      }
      const populated = new Set(entry.fields.filter((field) => field.value.trim()).map((field) => field.name));
      for (const names of groupsByType.get(entry.type)) {
        if (!names.some((name) => populated.has(name))) {
          diagnostics.push({ ...entry.typeRange, severity: "warning", code: "ris.missingMetadata", params: { fields: names.join("/") } });
        }
      }
    }
    return diagnostics;
  }

  return { candidate, parse, decodeUtf8, project, visibleColumns, queryRows, describeField, fieldsForType, metadataWarnings };
});
