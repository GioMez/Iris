/* Iris - conservative RIS scanner */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IrisRis = api;
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

  /**
   * Spans are half-open UTF-16 offsets into unchanged text. Entry ranges run
   * from TY through ER, excluding ER's line ending; bodies run from after TY's
   * line ending to the start of ER. Types/tags are uppercase, with native type
   * ranges and rawName retained. ID remains an ordinary field, never a fake key.
   *
   * Field/value ranges exclude the final line ending but include continuation
   * line endings and indentation. raw is the exact value slice; value trims
   * each line and joins continuations with spaces, for display only. Untagged
   * lines continue the preceding field, including indented tag-like literals;
   * unindented malformed tag prefixes are errors. Blank and percent-prefixed
   * lines continue an open field; with no field they remain trivia.
   * Foreign outside text is unrecognized.
   * Either failure suppresses every entry, with scanning stopping at that line.
   * @param {string} text
   * @returns {Parsed}
   */
  function parse(text) {
    if (typeof text !== "string") throw new TypeError("BIBLIOGRAPHY_TEXT_REQUIRED");
    const entries = [], diagnostics = [];
    let i = text[0] === "\uFEFF" ? 1 : 0;
    let entry = null, field = null, invalid = false, unrecognized = false;

    function syntax(expected, from, to) {
      invalid = true;
      diagnostics.push({ from, to, severity: "error", code: "ris.syntax", params: { expected } });
    }

    while (i < text.length) {
      const lineFrom = i;
      while (i < text.length && text[i] !== "\r" && text[i] !== "\n") i++;
      const lineTo = i, line = text.slice(lineFrom, lineTo);
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      const content = line.replace(/^[^\S\uFEFF]+/, "");
      if (!field && (!content || content[0] === "%")) continue;

      // Outside records, leading whitespace is trivia; inside, it is a continuation.
      const source = entry ? line : content;
      const from = entry ? lineFrom : lineTo - content.length;
      const tag = /^([A-Za-z][A-Za-z0-9]) {2}-(?:[ \t](.*))?$/s.exec(source);
      if (!tag) {
        const malformedTag = /^[A-Za-z][A-Za-z0-9](?:[ \t]+-|-[ \t])/.test(line);
        if (entry && field && !malformedTag) {
          field.to = field.valueTo = lineTo;
          field.raw = text.slice(field.valueFrom, field.valueTo);
          const value = line.trim();
          field.value += (field.value && value ? " " : "") + value;
          continue;
        }
        if (entry || /^[A-Za-z][A-Za-z0-9] {2}-/.test(source)) syntax("tag", from, lineTo);
        else {
          unrecognized = true;
          diagnostics.push({ from, to: lineTo, severity: "warning", code: "ris.unrecognized", params: {} });
        }
        break;
      }

      const rawName = tag[1], name = rawName.toUpperCase(), raw = tag[2] || "";
      const valueFrom = lineTo - raw.length, value = raw.trim();
      if (name === "TY") {
        if (entry) { syntax("ER", from, lineTo); break; }
        if (!value) { syntax("record-type", valueFrom, lineTo); break; }
        const typeFrom = valueFrom + raw.indexOf(value);
        entry = {
          from, to: lineTo, type: value.toUpperCase(), typeRange: { from: typeFrom, to: typeFrom + value.length },
          key: null, keyRange: null, bodyFrom: i, bodyTo: i, fields: [],
        };
        field = null;
      } else if (name === "ER") {
        if (!entry) { syntax("TY", from, lineTo); break; }
        if (value) { syntax("empty-ER", valueFrom, lineTo); break; }
        entry.bodyTo = from;
        entry.to = lineTo;
        entries.push(entry);
        entry = field = null;
      } else {
        if (!entry) { syntax("TY", from, lineTo); break; }
        field = { from, to: lineTo, name, rawName, valueFrom, valueTo: lineTo, raw, value, editable: true };
        entry.fields.push(field);
      }
    }

    if (entry && !invalid && !unrecognized) syntax("ER", text.length, text.length);
    const status = invalid ? "invalid" : unrecognized ? "unrecognized" : entries.length ? "valid" : "empty";
    return {
      text, format: status === "unrecognized" ? null : "ris", status,
      entries: invalid || unrecognized ? [] : entries, directives: [], diagnostics,
    };
  }

  const stream = {
    startState: () => ({ first: true, record: false, field: false, separator: false, style: null }),
    copyState: (state) => ({ ...state }),
    languageData: {},
    token(input, state) {
      // A raw LF-only CodeMirror line can contain several CR-delimited RIS lines.
      if (input.eat("\r")) return null;
      if (input.sol() || input.string[input.pos - 1] === "\r") {
        if (state.first && input.peek() === "\uFEFF") input.next();
        state.first = false;
        state.separator = false;
        if (!state.record) input.eatWhile(/[^\S\uFEFF\r]/);
        const tag = input.match(/^([A-Za-z][A-Za-z0-9])(?= {2}-(?:[ \t\r]|$))/);
        if (tag) {
          const name = tag[1].toUpperCase();
          state.style = name === "TY" ? "entryType" : "value";
          if (name === "TY") { state.record = true; state.field = false; }
          else if (name === "ER") { state.record = false; state.field = false; }
          else state.field = state.record;
          state.separator = true;
          return "field";
        }
        const style = state.field ? "value" : /^[^\S\uFEFF\r]*%/.test(input.string.slice(input.pos)) ? "comment" : null;
        input.eatWhile(/[^\r]/);
        return style;
      }
      if (state.separator) {
        input.match(/^ {2}-[ \t]?/);
        state.separator = false;
        return "brace";
      }
      input.eatWhile(/[^\r]/);
      return state.style;
    },
  };

  return { parse, stream };
});
