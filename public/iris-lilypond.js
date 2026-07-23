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

  function indentOnEnter(value, pos) {
    const before = value.slice(0, pos);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const lead = (line.match(/^[\t ]*/) || [""])[0];
    return "\n" + lead + (/({|<<)\s*$/.test(structuralLine(line)) ? "  " : "");
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

    return { code, structure };
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

  window.IrisLilyPond = { highlight, format, indentOnEnter, outline };
})();
