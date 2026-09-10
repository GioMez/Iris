/* ===================== Iris · LilyPond text support ===================== */
(function () {
  const esc = (s) => IrisLatex.escAll(s);

  function highlight(src) {
    let out = "";
    let i = 0;
    while (i < src.length) {
      if (src.startsWith("%{", i)) {
        const end = src.indexOf("%}", i + 2);
        const next = end < 0 ? src.length : end + 2;
        out += `<span class="t-comment">${esc(src.slice(i, next))}</span>`;
        i = next;
        continue;
      }
      if (src[i] === "%") {
        const end = src.indexOf("\n", i);
        const next = end < 0 ? src.length : end;
        out += `<span class="t-comment">${esc(src.slice(i, next))}</span>`;
        i = next;
        continue;
      }
      if (src[i] === '"') {
        let next = i + 1;
        while (next < src.length) {
          if (src[next] === "\\") next += 2;
          else if (src[next++] === '"') break;
          else next += 0;
        }
        out += `<span class="t-env">${esc(src.slice(i, next))}</span>`;
        i = next;
        continue;
      }
      if (src[i] === "\\") {
        let next = i + 1;
        while (next < src.length && /[A-Za-z-]/.test(src[next])) next += 1;
        if (next === i + 1) next += 1;
        out += `<span class="t-cmd">${esc(src.slice(i, next))}</span>`;
        i = next;
        continue;
      }
      if (src[i] === "{" || src[i] === "}" || src.startsWith("<<", i) || src.startsWith(">>", i)) {
        const token = src.startsWith("<<", i) || src.startsWith(">>", i) ? src.slice(i, i + 2) : src[i];
        out += `<span class="t-brace">${esc(token)}</span>`;
        i += token.length;
        continue;
      }
      out += esc(src[i]);
      i += 1;
    }
    return out;
  }

  /* ---- CodeMirror stream tokenizer: same rules as highlight() ---- */
  // Token names map onto the t-* CSS classes used by highlight(): cmd → t-cmd,
  // env → t-env (strings), brace → t-brace, comment → t-comment, null → text.
  const stream = {
    startState() { return { block: false, str: false }; },
    copyState(s) { return { block: s.block, str: s.str }; },
    token(stream, state) {
      if (state.block) {
        while (!stream.eol()) {
          if (stream.match("%}")) { state.block = false; return "comment"; }
          stream.next();
        }
        return "comment";
      }
      if (state.str) {
        while (!stream.eol()) {
          if (stream.peek() === "\\") { stream.next(); if (!stream.eol()) stream.next(); continue; }
          if (stream.next() === '"') { state.str = false; break; }
        }
        return "env";
      }
      const c = stream.next();
      if (c === "%") {
        if (stream.eat("{")) {
          state.block = true;
          while (!stream.eol()) {
            if (stream.match("%}")) { state.block = false; break; }
            stream.next();
          }
          return "comment";
        }
        stream.skipToEnd();
        return "comment";
      }
      if (c === '"') {
        state.str = true;
        while (!stream.eol()) {
          if (stream.peek() === "\\") { stream.next(); if (!stream.eol()) stream.next(); continue; }
          if (stream.next() === '"') { state.str = false; break; }
        }
        return "env";
      }
      if (c === "\\") {
        if (!stream.eatWhile(/[A-Za-z-]/)) stream.next();
        return "cmd";
      }
      if (c === "{" || c === "}") return "brace";
      if (c === "<" && stream.eat("<")) return "brace";
      if (c === ">" && stream.eat(">")) return "brace";
      stream.eatWhile(/[^%"\\{}<>]/);
      return null;
    },
  };

  function structuralLine(line) {
    return line.replace(/"(?:\\.|[^"\\])*"/g, "").replace(/%.*$/, "");
  }

  function format(src) {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let indent = 0;
    let blanks = 0;
    for (const raw of lines) {
      const trimmed = raw.replace(/[\t ]+$/g, "").trim();
      if (!trimmed) {
        blanks += 1;
        if (blanks <= 1) out.push("");
        continue;
      }
      blanks = 0;
      const structure = structuralLine(trimmed);
      const closes = (structure.match(/}/g) || []).length + (structure.match(/>>/g) || []).length;
      const opens = (structure.match(/{/g) || []).length + (structure.match(/<</g) || []).length;
      if (/^(}|>>)/.test(structure)) indent = Math.max(0, indent - 1);
      out.push("  ".repeat(indent) + trimmed);
      indent = Math.max(0, indent + opens - closes + (/^(}|>>)/.test(structure) ? 1 : 0));
    }
    return out.join("\n");
  }

  function indentOnEnter(value, pos, block = blockAtEnter(value, pos)) {
    const before = value.slice(0, pos);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const lead = (line.match(/^[\t ]*/) || [""])[0];
    return "\n" + lead + (block ? "  " : "");
  }

  function blockAtEnter(src, pos) {
    const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
    if (!/(?:\{|<<)[\t ]*(?:%[^\n]*)?$/.test(src.slice(lineStart, pos))) return null;
    const { code, structure } = outlineSource(src);
    // Escaped braces are commands, not block delimiters. Keep the offsets used
    // by the outline parser while excluding them from the balanced-span scan.
    const clean = structure.replace(/\\(?:[A-Za-z-]+|[^\n])/g, (command) => " ".repeat(command.length));
    const match = clean.slice(lineStart, pos).match(/(\{|<<)[\t ]*$/);
    if (!match) return null;
    const from = lineStart + match.index;
    // Scheme music literals use #{ ... #}, not an ordinary brace pair.
    if (match[1] === "{" && clean[from - 1] === "#") return null;
    if (code.slice(from + match[1].length, pos).trim()) return null;
    const close = match[1] === "{" ? "}" : ">>";
    const { spans, unclosed } = scanBlockSpans(clean);
    const reserved = unclosed.some((entry) => entry.at < from && from < entry.until && entry.token === close);
    const end = spans.get(from);
    return { close, closingFrom: end == null ? null : end - close.length, needsClose: reserved || end == null };
  }

  function outlineSource(src) {
    let code = "";
    let structure = "";
    let state = "code";

    for (let i = 0; i < src.length; i += 1) {
      const char = src[i];
      const next = src[i + 1];

      if (state === "line-comment") {
        if (char === "\n") {
          code += char;
          structure += char;
          state = "code";
        } else {
          code += " ";
          structure += " ";
        }
        continue;
      }

      if (state === "block-comment") {
        if (char === "%" && next === "}") {
          code += "  ";
          structure += "  ";
          i += 1;
          state = "code";
        } else {
          const replacement = char === "\n" ? "\n" : " ";
          code += replacement;
          structure += replacement;
        }
        continue;
      }

      if (state === "string") {
        code += char;
        structure += char === "\n" ? "\n" : " ";
        if (char === "\\" && next !== undefined) {
          code += next;
          structure += next === "\n" ? "\n" : " ";
          i += 1;
        } else if (char === '"') {
          state = "code";
        }
        continue;
      }

      if (char === "%" && next === "{") {
        code += "  ";
        structure += "  ";
        i += 1;
        state = "block-comment";
      } else if (char === "%") {
        code += " ";
        structure += " ";
        state = "line-comment";
      } else if (char === '"') {
        code += char;
        structure += " ";
        state = "string";
      } else {
        code += char;
        structure += char;
      }
    }

    return { code, structure, active: state === "code" };
  }

  function completionText(src) {
    const { structure, active } = outlineSource(src);
    return { code: structure, active };
  }

  function quotedArgument(src, offset) {
    const match = src.slice(offset).match(/^\s*("(?:\\.|[^"\\])*")/);
    return match ? match[1] : "";
  }

  function isStandaloneMarkup(structure, offset) {
    const lineStart = structure.lastIndexOf("\n", offset - 1) + 1;
    return /^(?:\s*(?:\{|<<|\\\\))*\s*$/.test(structure.slice(lineStart, offset));
  }

  function contextTitle(src, offset) {
    const match = src.slice(offset).match(
      /^\\(new|context)\s+(\\?[A-Za-z][A-Za-z0-9_-]*)(?:\s*=\s*("(?:\\.|[^"\\])*"|[A-Za-z][A-Za-z0-9_-]*))?/
    );
    if (!match) return "";
    return `\\${match[1]} ${match[2]}${match[3] ? ` = ${match[3]}` : ""}`;
  }

  function addOutlineDepths(items, structure) {
    const ordered = items.slice().sort((a, b) => a.offset - b.offset || a.order - b.order);
    const stack = [];
    let cursor = 0;

    ordered.forEach((item) => {
      while (cursor < item.offset) {
        if (structure.startsWith("<<", cursor)) {
          stack.push(">>");
          cursor += 2;
          continue;
        }
        if (structure.startsWith(">>", cursor)) {
          const index = stack.lastIndexOf(">>");
          if (index >= 0) stack.splice(index, 1);
          cursor += 2;
          continue;
        }
        if (structure[cursor] === "{") stack.push("}");
        else if (structure[cursor] === "}") {
          const index = stack.lastIndexOf("}");
          if (index >= 0) stack.splice(index, 1);
        }
        cursor += 1;
      }
      item.level = Math.min(4, stack.length + 1);
    });

    return ordered;
  }

  function outline(src) {
    const { code, structure } = outlineSource(src);
    const items = [];
    const assignedCommands = new Set();
    const blockCommands = new Set(["book", "bookpart", "score", "header", "paper", "layout", "midi", "markup", "markuplist"]);
    const inputModes = new Set([
      "chordmode", "chords", "drummode", "drums", "figuremode", "figures",
      "lyricmode", "lyrics", "addlyrics", "notemode",
    ]);
    const variableWrappers = new Set([
      ...blockCommands, ...inputModes, "relative", "absolute", "fixed", "transpose", "repeat", "tuplet",
    ]);
    let order = 0;

    const variablePart = '(?:"(?:\\\\.|[^"\\\\])*"|[^\\s.=#{}<>\\\\%]+)';
    const variableRe = new RegExp(`^[\\t ]*(${variablePart}(?:\\.${variablePart})*)[\\t ]*=`, "gm");
    let match;
    while ((match = variableRe.exec(code))) {
      const offset = match.index + match[0].indexOf(match[1]);
      const equals = match.index + match[0].lastIndexOf("=");
      let valueOffset = equals + 1;
      while (/\s/.test(code[valueOffset] || "")) valueOffset += 1;
      const wrapperMatch = structure.slice(valueOffset).match(/^\\([A-Za-z][A-Za-z-]*)\b/);
      const wrapper = wrapperMatch && variableWrappers.has(wrapperMatch[1]) ? wrapperMatch[1] : "";
      if (wrapper) assignedCommands.add(valueOffset);
      items.push({
        level: 1,
        num: "",
        title: `${match[1]} =${wrapper ? ` \\${wrapper}` : ""}`,
        offset,
        order: order += 1,
        variable: true,
      });
    }

    const commandRe = /\\([A-Za-z][A-Za-z-]*)\b/g;
    while ((match = commandRe.exec(structure))) {
      const command = match[1];
      const offset = match.index;
      if (assignedCommands.has(offset)) continue;

      if (command === "new" || command === "context") {
        const title = contextTitle(src, offset);
        if (title) items.push({ level: 1, num: "", title, offset, order: order += 1 });
        continue;
      }

      if (command === "include" || command === "version") {
        const argument = quotedArgument(src, commandRe.lastIndex);
        items.push({
          level: 1,
          num: "",
          title: `\\${command}${argument ? ` ${argument}` : ""}`,
          offset,
          order: order += 1,
        });
        continue;
      }

      if (!blockCommands.has(command) && !inputModes.has(command)) continue;
      if ((command === "markup" || command === "markuplist") && !isStandaloneMarkup(structure, offset)) continue;
      items.push({ level: 1, num: "", title: `\\${command}`, offset, order: order += 1, command });
    }

    let score = 0;
    return addOutlineDepths(items, structure)
      .filter((item) => !item.variable || item.level === 1)
      .map((item) => {
        if (item.command === "score") {
          score += 1;
          item.num = String(score);
          item.title = window.IrisI18n
            ? window.IrisI18n.t("templates.scoreNumber", { number: score })
            : `Score ${score}`;
        }
        delete item.command;
        delete item.order;
        delete item.variable;
        return item;
      });
  }

  /* ---- structural regions: the areas two people can share ---- */
  // outline() already finds where every block begins; this adds where it ends,
  // which is what turns a list of landmarks into areas two carets can be inside
  // of. It reuses outlineSource(), so braces in comments and strings cannot
  // unbalance the nesting.

  // Every balanced { } and << >> span, keyed by the offset it opens at.
  function scanBlockSpans(structure) {
    const spans = new Map();
    const open = [];
    const unclosed = [];
    for (let i = 0; i < structure.length; i++) {
      const closeAt = (token, end) => {
        for (let k = open.length - 1; k >= 0; k--) {
          if (open[k].token !== token) continue;
          spans.set(open[k].at, end);
          unclosed.push(...open.slice(k + 1).map((entry) => ({ ...entry, until: end })));
          open.splice(k);
          return;
        }
      };
      if (structure.startsWith("<<", i)) { open.push({ token: ">>", at: i }); i += 1; continue; }
      if (structure.startsWith(">>", i)) { closeAt(">>", i + 2); i += 1; continue; }
      if (structure[i] === "{") { open.push({ token: "}", at: i }); continue; }
      if (structure[i] === "}") closeAt("}", i + 1);
    }
    unclosed.push(...open.map((entry) => ({ ...entry, until: structure.length })));
    return { spans, open, unclosed };
  }

  function blockSpans(structure) {
    const { spans, open } = scanBlockSpans(structure);
    // A block left open runs to the end of the file rather than being dropped.
    open.forEach((entry) => { if (!spans.has(entry.at)) spans.set(entry.at, structure.length); });
    return spans;
  }

  // How far a construct's header may run before its block opens: `\score {`,
  // but also `melody = \relative c' {` and `\new Staff = "up" \with { … } {`.
  const HEADER_CHAR = /[\s\\A-Za-z0-9_'`,.\-#!()=]/;
  const HEADER_LIMIT = 240;

  function blockOpenAfter(structure, offset, spans) {
    let i = offset;
    const limit = Math.min(structure.length, offset + HEADER_LIMIT);
    while (i < limit) {
      if (structure.startsWith("<<", i)) return i;
      if (structure[i] === "{") {
        // A \with block configures the context, it is not the context's body.
        const before = structure.slice(Math.max(0, i - 8), i);
        if (/\\with\s*$/.test(before)) {
          const close = spans.get(i);
          if (close == null) return -1;
          i = close;
          continue;
        }
        return i;
      }
      if (!HEADER_CHAR.test(structure[i])) return -1;
      i += 1;
    }
    return -1;
  }

  function regions(src) {
    const { structure } = outlineSource(src);
    const spans = blockSpans(structure);
    const found = [];
    outline(src).forEach((item) => {
      if (!Number.isInteger(item.offset)) return;
      const open = blockOpenAfter(structure, item.offset, spans);
      if (open < 0) return;
      const close = spans.get(open);
      // A landmark with no block of its own — \version, \include — is a point,
      // not an area, and nobody can be inside it.
      if (close == null || close <= item.offset) return;
      found.push({ kind: "block", label: item.title, from: item.offset, to: close });
    });
    return found.sort((a, b) => a.from - b.from || b.to - a.to);
  }

  window.IrisLilyPond = { highlight, format, indentOnEnter, blockAtEnter, completionText, outline, regions, stream };
})();
