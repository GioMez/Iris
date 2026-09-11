/* Iris - conservative bibliography changes */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./iris-bibliography.js"));
  } else root.IrisBibliographyEdit = factory(root.IrisBibliography);
})(typeof window === "undefined" ? globalThis : window, function (Bibliography) {
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
   * @typedef {Span & {insert: string}} Change
   * @typedef {{type: string, key: string | null,
   *   fields: Array<{index: number | null, name: string, value: string, remove: boolean}>}} Draft
   * @typedef {{kind: "add", draft: Draft} | {kind: "update", target: Span, draft: Draft} |
   *   {kind: "remove", target: Span}} Operation
   * @typedef {{changes: Change[], diagnostics: Diagnostic[],
   *   status: "ready" | "unchanged" | "invalid" | "conflict"}} EditResult
   */

  const BIB_NAME = /^(?![0-9])[^\s\u0000-\u001f\u007f"#$%'(),={}@\\]+$/;

  function safeText(value) {
    // UTF-8 encoding repairs lone surrogates; strict reopening rejects NUL.
    return typeof value === "string" && value.isWellFormed() && !value.includes("\0");
  }

  function failure(status, code, span = { from: 0, to: 0 }, params = {}) {
    return { status, changes: [], diagnostics: [{ from: span.from, to: span.to,
      severity: "error", code: "bibliographyEdit." + code, params }] };
  }

  function encodeValue(value, raw, format, newline) {
    if (format === "ris") return value.replace(/\r\n|\r|\n/g, newline + "      ");
    let depth = 0, quote = false;
    // Backslashes do not escape BibTeX structural braces or depth-zero quotes.
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "{") depth++;
      else if (value[i] === "}" && --depth < 0) return null;
      else if (value[i] === '"' && depth === 0) quote = true;
    }
    if (depth !== 0) return null;
    if (raw[0] === '"' && !quote) return '"' + value + '"';
    if (/^[0-9]+$/.test(raw) && /^[0-9]+$/.test(value)) return value;
    return "{" + value + "}";
  }

  function commaIn(text, from, to) {
    for (let i = from; i < to; i++) {
      if (text[i] === "%") {
        while (i < to && text[i] !== "\r" && text[i] !== "\n") i++;
      } else if (text[i] === ",") return i;
    }
    return -1;
  }

  /**
   * Pure, localized changes in the original text's UTF-16 coordinates. A target
   * must exactly match one current entry; revision/bookmark checks belong to the
   * caller. Omitted fields are untouched; indices address native occurrences.
   * Display equality is only a no-op signal, never a serialization source.
   * @param {Parsed} parsed
   * @param {Operation} operation
   * @returns {EditResult}
   */
  function buildChanges(parsed, operation) {
    const { text, format } = parsed;
    if (!["valid", "empty"].includes(parsed.status) || !["bib", "ris"].includes(format)) {
      return failure("invalid", "invalidSource");
    }
    if (!operation || !["add", "update", "remove"].includes(operation.kind)) return failure("invalid", "invalidOperation");
    let entry = null, entryIndex = -1;
    if (operation.kind !== "add") {
      const matches = parsed.entries.filter((item) => item.from === operation.target?.from && item.to === operation.target?.to);
      if (matches.length !== 1) return failure("conflict", "targetConflict");
      entry = matches[0];
      entryIndex = parsed.entries.indexOf(entry);
    }
    let changes = [], expected = [], type, key;
    const newline = /\r\n|\r|\n/.exec(text)?.[0] || "\n";
    const span = entry?.typeRange || { from: text.length, to: text.length };
    if (operation.kind === "remove") {
      changes.push({ from: entry.from, to: entry.to, insert: "" });
    } else {
      const draft = operation.draft;
      if (!draft || !Array.isArray(draft.fields)) return failure("invalid", "invalidOperation", span);
      const normalize = (name) => format === "bib" ? name.toLowerCase() : name.toUpperCase();
      if (!safeText(draft.type) || (format === "bib" ?
        !BIB_NAME.test(draft.type) || /^(comment|string|preamble)$/i.test(draft.type) :
        !draft.type || draft.type.trim() !== draft.type || /[\r\n\u0000-\u001f\u007f]/.test(draft.type))) {
        return failure("invalid", "invalidType", span);
      }
      type = normalize(draft.type);
      key = draft.key;
      if (format === "ris" ? key !== null : key !== null &&
          (!safeText(key) || !key || /[\s,]/.test(key) ||
            ((!entry || text[entry.bodyTo] === "}") && key.includes("}")))) {
        return failure("invalid", "invalidKey", entry?.keyRange || span);
      }
      if (key !== null && key !== entry?.key && parsed.entries.some((item) => item !== entry && item.key === key)) {
        return failure("invalid", "duplicateKey", entry?.keyRange || span, { key });
      }
      if (entry) {
        if (type !== entry.type) changes.push({ ...entry.typeRange, insert: type });
        if (key !== entry.key) changes.push({ ...(entry.keyRange || { from: entry.bodyFrom, to: entry.bodyFrom }),
          insert: (key || "") + (!entry.keyRange && key && text[entry.bodyFrom] === "%" ? " " : "") });
        expected = entry.fields.map((item) => ({ name: item.name, rawName: item.rawName,
          raw: text.slice(item.valueFrom, item.valueTo), syntax: text.slice(item.from, item.to) }));
      }
      const seen = new Set(), additions = [], removedCommas = new Set();
      const after = format === "bib" && entry ? entry.fields.map((item, index) =>
        commaIn(text, item.to, entry.fields[index + 1]?.from ?? entry.bodyTo)) : [];
      for (const item of draft.fields) {
        if (!item || !safeText(item.name) || typeof item.value !== "string" || typeof item.remove !== "boolean" ||
            (format === "bib" ? !BIB_NAME.test(item.name) : !/^[A-Z][A-Z0-9]$/i.test(item.name) || /^(TY|ER)$/i.test(item.name))) {
          return failure("invalid", "invalidField", span);
        }
        if (!safeText(item.value)) return failure("invalid", "invalidText", span, { index: item.index ?? -1 });
        const name = normalize(item.name);
        if (item.index !== null && (!Number.isInteger(item.index) || !entry?.fields[item.index] || seen.has(item.index))) {
          return failure("conflict", "fieldConflict", span);
        }
        if (item.index === null && item.remove) continue;
        const original = item.index === null ? null : entry.fields[item.index];
        const wanted = original ? expected[item.index] : { name, rawName: name, raw: "", syntax: null };
        let sameValue = false;
        if (original) {
          seen.add(item.index);
          sameValue = item.value === original.value ||
            item.value === (format === "ris" || !original.editable || /^[0-9]+$/.test(wanted.raw) ? wanted.raw : wanted.raw.slice(1, -1));
          if (!item.remove && name === original.name && sameValue) continue;
          if (!original.editable) return failure("invalid", "readOnlyField", original, { index: item.index });
          if (item.remove) {
            let to = original.to;
            if (format === "ris") to += /^(\r\n|\r|\n)/.exec(text.slice(to))?.[0].length || 0;
            changes.push({ from: original.from, to, insert: "" });
            expected[item.index] = null;
            if (format === "bib") {
              // Prefer the following comma; never remove the key's delimiter.
              const comma = after[item.index] >= 0 ? after[item.index] : after[item.index - 1];
              if (comma >= 0) removedCommas.add(comma);
            }
            continue;
          }
          if (name !== original.name) {
            changes.push({ from: original.from, to: original.from + original.rawName.length, insert: name });
            wanted.name = wanted.rawName = name;
            wanted.syntax = null;
          }
        }
        if (sameValue) continue;
        const raw = encodeValue(item.value, wanted.raw, format, newline);
        if (raw === null) return failure("invalid", "unsafeValue", original || span, { index: item.index ?? -1 });
        if (original) {
          const prefix = format === "ris" && text[original.valueFrom - 1] === "-" ? " " : "";
          changes.push({ from: original.valueFrom, to: original.valueTo, insert: prefix + raw });
        } else additions.push(wanted);
        wanted.raw = raw;
        wanted.syntax = null;
        wanted.value = format === "bib" ? item.value : item.value.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean).join(" ");
      }
      for (const from of removedCommas) changes.push({ from, to: from + 1, insert: "" });
      // An empty parenthesized key needs a comma even without new fields.
      if (entry && format === "bib" && (additions.length ||
          (key === null && !entry.fields.length && text[entry.bodyTo] === ")"))) {
        const last = expected.findLastIndex(Boolean);
        const keyEnd = entry.keyRange?.to ?? entry.bodyFrom;
        const comma = last < 0 ? commaIn(text, keyEnd, entry.fields[0]?.from ?? entry.bodyTo) :
          after.slice(last).find((position) => position >= 0 && !removedCommas.has(position));
        if (comma === undefined || comma < 0) {
          const from = last < 0 ? keyEnd : entry.fields[last].to;
          changes.push({ from, to: from, insert: "," });
        }
      }
      if (!entry) {
        const body = format === "bib" ? additions.map((item) => "  " + item.name + " = " + item.raw).join("," + newline) :
          additions.map((item) => item.name + "  - " + item.raw + newline).join("");
        const record = format === "bib" ? "@" + type + "{" + (key || "") + "," +
          (body ? newline + body + newline : "") + "}" : "TY  - " + type + newline + body + "ER  -";
        const prefix = text && text !== "\uFEFF" && !/[\r\n]$/.test(text) ? newline : "";
        changes.push({ from: text.length, to: text.length, insert: prefix + record + newline });
      } else if (additions.length) {
        if (format === "ris") {
          changes.push({ from: entry.bodyTo, to: entry.bodyTo,
            insert: additions.map((item) => item.name + "  - " + item.raw + newline).join("") });
        } else {
          const multiline = /[\r\n]/.test(text.slice(entry.bodyFrom, entry.bodyTo));
          const lineStart = Math.max(text.lastIndexOf("\n", entry.bodyTo - 1), text.lastIndexOf("\r", entry.bodyTo - 1)) + 1;
          const ownLine = multiline && /^[ \t]*$/.test(text.slice(lineStart, entry.bodyTo));
          const indent = entry.fields.length ? /(?:^|[\r\n])([ \t]*)[^\r\n]*$/.exec(text.slice(entry.bodyFrom, entry.fields[0].from))?.[1] || "  " : "  ";
          const from = ownLine ? lineStart : entry.bodyTo;
          const body = additions.map((item) => item.name + " = " + item.raw).join(multiline ? "," + newline + indent : ", ");
          changes.push({ from, to: from, insert: multiline ? (ownLine ? "" : newline) + indent + body + newline : " " + body });
        }
      }
      expected = expected.filter(Boolean).concat(additions);
    }
    changes = changes.filter((change) => text.slice(change.from, change.to) !== change.insert);
    if (!changes.length) return { status: "unchanged", changes: [], diagnostics: [] };
    changes.sort((a, b) => a.from - b.from || a.to - b.to);
    // Key, comma and new fields can insert at the same empty-body boundary.
    for (let i = 1; i < changes.length; i++) {
      const previous = changes[i - 1], current = changes[i];
      if (previous.from === previous.to && current.from === current.to && previous.from === current.from) {
        previous.insert += current.insert;
        changes.splice(i--, 1);
      } else if (previous.to > current.from) return failure("conflict", "fieldConflict", span);
    }
    const next = changes.toReversed().reduce((text, change) =>
      text.slice(0, change.from) + change.insert + text.slice(change.to), text);
    const checked = Bibliography.parse(next, parsed.format);
    if (checked.status !== "valid" && checked.status !== "empty") {
      return { status: "invalid", changes: [], diagnostics: checked.diagnostics };
    }
    // Valid syntax alone is insufficient: verify exact ordered occurrences and
    // untouched entry/directive slices, not a name-keyed map or display projection.
    const actual = checked.entries[operation.kind === "add" ? parsed.entries.length : entryIndex];
    const count = parsed.entries.length + (operation.kind === "add" ? 1 : operation.kind === "remove" ? -1 : 0);
    if (checked.format !== format || checked.entries.length !== count ||
        (operation.kind !== "remove" && (!actual || actual.type !== type || actual.key !== key || actual.fields.length !== expected.length ||
        expected.some((wanted, index) => {
          const item = actual.fields[index];
          return item.name !== wanted.name || item.rawName !== wanted.rawName || item.raw !== wanted.raw ||
            (wanted.syntax !== null && next.slice(item.from, item.to) !== wanted.syntax) ||
            (wanted.value !== undefined && item.value !== wanted.value);
        }))) || parsed.entries.some((item, index) => {
          if (index === entryIndex) return false;
          const other = checked.entries[index - (operation.kind === "remove" && index > entryIndex ? 1 : 0)];
          return text.slice(item.from, item.to) !== next.slice(other.from, other.to);
        }) ||
        parsed.directives.length !== checked.directives.length || parsed.directives.some((item, index) =>
          text.slice(item.from, item.to) !== next.slice(checked.directives[index].from, checked.directives[index].to))) {
      return failure("invalid", "intentMismatch", entry || span);
    }
    return { status: "ready", changes, diagnostics: checked.diagnostics };
  }

  return { buildChanges };
});
