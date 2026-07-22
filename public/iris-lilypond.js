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

  function outline(src) {
    const items = [];
    const re = /\\(book|bookpart|score|header|layout|midi)\b/g;
    let match;
    let score = 0;
    while ((match = re.exec(src))) {
      if (match[1] === "score") score += 1;
      items.push({
        level: /^(layout|midi)$/.test(match[1]) ? 2 : 1,
        num: match[1] === "score" ? String(score) : "",
        title: match[1] === "score" ? `Partitura ${score}` : `\\${match[1]}`,
        offset: match.index,
      });
    }
    return items;
  }

  window.IrisLilyPond = { highlight, format, indentOnEnter, outline };
})();
