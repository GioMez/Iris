/* Iris - conservative BibTeX/BibLaTeX scanner */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IrisBibtex = api;
})(typeof window === "undefined" ? globalThis : window, function () {
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
   */

  const SPACE = /[^\S\uFEFF]/;
  const NAME_CHAR = /[^\s\u0000-\u001f\u007f"#$%'(),={}@\\]/;

  // BibTeX counts braces and depth-zero quotes even after a backslash.
  function bracedEnd(text, from) {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) return i + 1;
    }
    return -1;
  }

  function quotedEnd(text, from) {
    let depth = 0;
    for (let i = from + 1; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth < 0) return -1;
      else if (text[i] === '"' && depth === 0) return i + 1;
    }
    return -1;
  }

  function commentEnd(text, from) {
    if (text[from] === "{") return bracedEnd(text, from);
    let depth = 1;
    for (let i = from + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "{") {
        const end = bracedEnd(text, i);
        if (end < 0) return -1;
        i = end - 1;
      } else if (text[i] === "}") return -1;
      else if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) return i + 1;
    }
    return -1;
  }

  /**
   * All spans are half-open UTF-16 offsets into the unchanged input. Entry bodies
   * include everything between the outer delimiters (including the key). Fields
   * exclude surrounding comments, whitespace and commas; raw is the exact value
   * expression. Simple values lose only their outer delimiters for display.
   * Macros and concatenations are not expanded and are not form-editable.
   *
   * Recognition deliberately rejects arbitrary text outside entries/directives,
   * unlike BibTeX compilers that may ignore it. "unrecognized" is not evidence of
   * corruption. Whitespace, an initial BOM and percent comments alone are empty;
   * directive-only files are also empty, with their directive spans retained.
   * Structural errors suppress all entries; scanning stops at the first error.
   * Warnings do not validate a style's required fields or evaluate TeX/macros.
   * @param {string} text
   * @returns {Parsed}
   */
  function parse(text) {
    const entries = [], directives = [], diagnostics = [];
    const keys = new Set(), macros = new Set();
    let i = text[0] === "\uFEFF" ? 1 : 0;
    let invalid = false, unrecognized = false;

    function warn(code, from, to, params = {}) {
      diagnostics.push({ from, to, severity: "warning", code, params });
    }

    function syntax(expected, from = i, to = Math.min(i + 1, text.length)) {
      invalid = true;
      diagnostics.push({ from, to, severity: "error", code: "bibtex.syntax", params: { expected } });
      return null;
    }

    function trivia() {
      while (i < text.length) {
        if (SPACE.test(text[i])) i++;
        else if (text[i] === "%") {
          while (i < text.length && text[i] !== "\r" && text[i] !== "\n") i++;
        } else break;
      }
    }

    function name() {
      const from = i;
      if (/[0-9]/.test(text[i])) return "";
      while (i < text.length && NAME_CHAR.test(text[i])) i++;
      return text.slice(from, i);
    }

    function expression() {
      const valueFrom = i;
      let valueTo = i, count = 0, editable = true, value = "";
      while (true) {
        const from = i, ch = text[i];
        if (ch === "{" || ch === '"') {
          const end = ch === "{" ? bracedEnd(text, i) : quotedEnd(text, i);
          if (end < 0) return syntax(ch === "{" ? "}" : '"', from, text.length);
          i = end;
          value = text.slice(from + 1, i - 1);
        } else if (i < text.length && /[0-9]/.test(ch)) {
          while (i < text.length && /[0-9]/.test(text[i])) i++;
          value = text.slice(from, i);
        } else {
          const macro = name();
          if (!macro) return syntax("value");
          editable = false;
          value = macro;
          // Definitions are observed in source order; external style macros may warn.
          if (!macros.has(macro.toLowerCase())) warn("bibtex.undefinedMacro", from, i, { name: macro });
        }
        count++;
        valueTo = i;
        trivia();
        if (text[i] !== "#") break;
        i++;
        trivia();
      }
      const raw = text.slice(valueFrom, valueTo);
      if (count > 1) { editable = false; value = raw; }
      return { valueFrom, valueTo, raw, value, editable };
    }

    function field() {
      const from = i, rawName = name();
      if (!rawName) return syntax("field-name");
      trivia();
      if (text[i] !== "=") return syntax("=");
      i++;
      trivia();
      const parsedValue = expression();
      if (!parsedValue) return null;
      return { from, to: parsedValue.valueTo, name: rawName.toLowerCase(), rawName, ...parsedValue };
    }

    while (i < text.length) {
      trivia();
      if (i === text.length) break;
      const from = i;
      if (text[i] !== "@") {
        while (i < text.length && text[i] !== "@" && text[i] !== "%") i++;
        warn("bibtex.unrecognized", from, i);
        unrecognized = true;
        continue;
      }
      i++;
      trivia();
      const typeFrom = i, rawType = name();
      if (!rawType) { syntax("entry-type"); break; }
      const type = rawType.toLowerCase(), typeRange = { from: typeFrom, to: i };
      trivia();
      const open = text[i], close = open === "{" ? "}" : ")";
      if (open !== "{" && open !== "(") { syntax("{ or ("); break; }
      if (type === "comment") {
        const end = commentEnd(text, i);
        if (end < 0) { syntax(close, i, text.length); break; }
        i = end;
        directives.push({ from, to: i });
        continue;
      }
      const bodyFrom = ++i;
      trivia();
      if (type === "string" || type === "preamble") {
        const content = type === "string" ? field() : expression();
        if (!content) break;
        if (text[i] === ",") { i++; trivia(); }
        if (text[i] !== close) { syntax(close); break; }
        i++;
        if (type === "string") macros.add(content.name);
        directives.push({ from, to: i });
        continue;
      }

      const keyFrom = i;
      // Parentheses are key content, even in parenthesis-delimited entries.
      while (i < text.length && !/[\s,]/.test(text[i]) && (close !== "}" || text[i] !== "}")) i++;
      const key = text.slice(keyFrom, i) || null;
      const keyRange = key === null ? null : { from: keyFrom, to: i };
      const fields = [], fieldNames = new Set();
      trivia();
      if (text[i] !== close) {
        if (text[i] !== ",") { syntax(", or " + close); break; }
        i++;
        trivia();
        while (text[i] !== close) {
          const item = field();
          if (!item) break;
          if (fieldNames.has(item.name)) {
            warn("bibtex.duplicateField", item.from, item.from + item.rawName.length, { name: item.name });
          }
          fieldNames.add(item.name);
          fields.push(item);
          if (text[i] === close) break;
          if (text[i] !== ",") { syntax(", or " + close); break; }
          i++;
          trivia();
        }
      }
      if (invalid) break;
      const bodyTo = i++;
      const entry = { from, to: i, type, typeRange, key, keyRange, bodyFrom, bodyTo, fields };
      entries.push(entry);
      if (key === null) warn("bibtex.missingKey", keyFrom, keyFrom);
      else {
        if (keys.has(key)) warn("bibtex.duplicateKey", keyRange.from, keyRange.to, { key });
        keys.add(key);
      }
      // These are reading hints, not a BibTeX/BibLaTeX entry-type schema.
      const populated = new Set(fields.filter((item) => item.value.trim()).map((item) => item.name));
      for (const names of [["title"], ["author", "editor"], ["year", "date"]]) {
        if (!names.some((item) => populated.has(item))) {
          warn("bibtex.missingMetadata", typeRange.from, typeRange.to, { fields: names.join("/") });
        }
      }
    }

    const status = invalid ? "invalid" : unrecognized ? "unrecognized" : entries.length ? "valid" : "empty";
    return {
      text, format: status === "unrecognized" ? null : "bib", status,
      entries: invalid || unrecognized ? [] : entries, directives, diagnostics,
    };
  }

  // Incremental lexical state only, independent of full-document validation.
  const stream = {
    startState: () => ({ phase: "outside", type: "", close: "}", mode: null, depth: 0, parens: 0, escaped: false }),
    copyState: (state) => ({ ...state }),
    languageData: { commentTokens: { line: "%" } },
    token(input, state) {
      if (state.mode) {
        const comment = state.mode === "comment";
        while (!input.eol()) {
          const ch = input.next();
          if (comment && state.close === ")" && state.depth === 0) {
            if (state.escaped) { state.escaped = false; continue; }
            if (ch === "\\") { state.escaped = true; continue; }
            if (ch === "(") state.parens++;
            if (ch === ")" && --state.parens === 0) { state.mode = null; state.phase = "outside"; break; }
          }
          if (ch === "{") state.depth++;
          else if (ch === "}") {
            state.depth--;
            if (state.depth === 0 && (state.mode === "braced" || (comment && state.close === "}"))) {
              state.mode = null; state.phase = comment ? "outside" : "afterValue"; break;
            }
          } else if (ch === '"' && state.depth === 0 && state.mode === "quoted") {
            state.mode = null; state.phase = "afterValue"; break;
          }
        }
        // The parser's parenthesized comment escape cannot cross a line ending.
        if (input.eol()) state.escaped = false;
        return comment ? "comment" : "value";
      }
      if (input.eatWhile(/\s/)) return null;
      if (input.peek() === "%") { input.eatWhile(/[^\r]/); return "comment"; }
      if (state.phase === "key") {
        if (input.eatWhile(state.close === "}" ? /[^\s,}]/ : /[^\s,]/)) {
          state.phase = "afterKey";
          return "key";
        }
      }
      const ch = input.next();
      if (ch === "@") { state.phase = "type"; return "entryType"; }
      if (state.phase === "type" && NAME_CHAR.test(ch)) {
        input.eatWhile(NAME_CHAR);
        state.type = input.current().toLowerCase();
        state.phase = "open";
        return "entryType";
      }
      if (state.phase === "open" && (ch === "{" || ch === "(")) {
        state.close = ch === "{" ? "}" : ")";
        state.phase = state.type === "string" ? "field" : state.type === "preamble" ? "value" : "key";
        if (state.type === "comment") {
          state.mode = "comment"; state.depth = ch === "{" ? 1 : 0; state.parens = ch === "(" ? 1 : 0;
          return "comment";
        }
        return "brace";
      }
      if (state.phase === "outside") return null;
      if (ch === state.close) { state.phase = "outside"; return "brace"; }
      if (ch === ",") { state.phase = "field"; return "brace"; }
      if (ch === "=") { state.phase = "value"; return "brace"; }
      if (ch === "#") { state.phase = "value"; return "special"; }
      if (state.phase === "field" && NAME_CHAR.test(ch)) {
        input.eatWhile(NAME_CHAR); state.phase = "equals";
        return "field";
      }
      if (state.phase === "value") {
        if (ch === "{" || ch === '"') {
          state.mode = ch === "{" ? "braced" : "quoted"; state.depth = ch === "{" ? 1 : 0;
        } else {
          input.eatWhile(NAME_CHAR); state.phase = "afterValue";
        }
        return "value";
      }
      return null;
    },
  };

  return { parse, stream };
});
