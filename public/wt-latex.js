/* ===================== WebTeX · LaTeX engine ===================== */
(function () {
  function escAll(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---- syntax highlighter: returns HTML string aligned 1:1 with source ---- */
  function highlight(src) {
    let out = "";
    let i = 0;
    const n = src.length;
    const push = (cls, txt) => {
      out += cls ? `<span class="${cls}">${txt}</span>` : txt;
    };

    while (i < n) {
      const c = src[i];

      // line comment
      if (c === "%") {
        let j = i;
        while (j < n && src[j] !== "\n") j++;
        push("t-comment", escAll(src.slice(i, j)));
        i = j;
        continue;
      }

      // control sequence
      if (c === "\\") {
        let j = i + 1;
        if (j < n && /[a-zA-Z]/.test(src[j])) {
          while (j < n && /[a-zA-Z]/.test(src[j])) j++;
          if (src[j] === "*") j++; // starred form
        } else {
          j = i + 2; // single-char command: \\ \% \{ \, \[ ...
        }
        const cmd = src.slice(i, Math.min(j, n));

        // display / inline math via \[ \] and \( \)
        if (cmd === "\\[") {
          let k = src.indexOf("\\]", j);
          k = k === -1 ? n : k + 2;
          push("t-math", escAll(src.slice(i, k)));
          i = k; continue;
        }
        if (cmd === "\\(") {
          let k = src.indexOf("\\)", j);
          k = k === -1 ? n : k + 2;
          push("t-math", escAll(src.slice(i, k)));
          i = k; continue;
        }
        if (cmd === "\\\\") { push("t-special", "\\\\"); i = j; continue; }

        push("t-cmd", escAll(cmd));
        i = j;

        // \begin{env} / \end{env} → color env name
        if (cmd === "\\begin" || cmd === "\\end") {
          let k = i;
          while (k < n && (src[k] === " " || src[k] === "\t")) k++;
          if (src[k] === "{") {
            const e = src.indexOf("}", k);
            if (e !== -1) {
              push("", escAll(src.slice(i, k)));
              push("t-brace", "{");
              push("t-env", escAll(src.slice(k + 1, e)));
              push("t-brace", "}");
              i = e + 1;
              continue;
            }
          }
        }
        continue;
      }

      // inline / display math $ ... $  /  $$ ... $$
      if (c === "$") {
        const disp = src[i + 1] === "$";
        let k = i + (disp ? 2 : 1);
        while (k < n) {
          if (src[k] === "\\") { k += 2; continue; }
          if (disp) { if (src[k] === "$" && src[k + 1] === "$") { k += 2; break; } }
          else if (src[k] === "$") { k += 1; break; }
          k++;
        }
        push("t-math", escAll(src.slice(i, Math.min(k, n))));
        i = Math.min(k, n);
        continue;
      }

      if (c === "{" || c === "}" || c === "[" || c === "]") { push("t-brace", c); i++; continue; }
      if (c === "&" || c === "~") { push("t-special", escAll(c)); i++; continue; }

      out += escAll(c);
      i++;
    }
    return out;
  }

  /* ---- pretty printer: re-indents environments ---- */
  function format(src) {
    const unit = "  ";
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    let indent = 0;
    let blanks = 0;
    const out = [];
    for (let raw of lines) {
      const line = raw.replace(/[\t ]+$/g, "");
      const t = line.trim();
      if (t === "") {
        blanks++;
        if (blanks <= 1) out.push("");
        continue;
      }
      blanks = 0;
      const isEnd = /^\\end\b/.test(t) || /^[}\])]/.test(t);
      if (isEnd) indent = Math.max(0, indent - 1);
      out.push(indent > 0 ? unit.repeat(indent) + t : t);
      const isBegin = /^\\begin\b/.test(t);
      if (isBegin) indent++;
    }
    return out.join("\n");
  }

  /* ---- newline auto-indent ---- */
  function indentOnEnter(value, pos) {
    const before = value.slice(0, pos);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const lead = (line.match(/^[\t ]*/) || [""])[0];
    let extra = "";
    if (/\\begin\{[^}]*\}\s*$/.test(line.replace(/[\t ]+$/, ""))) extra = "  ";
    return "\n" + lead + extra;
  }

  /* ---- document outline from \section / \subsection ---- */
  function outline(src) {
    const re = /\\(section|subsection)\*?\s*\{([^}]*)\}/g;
    const res = [];
    let s = 0, ss = 0, m;
    while ((m = re.exec(src))) {
      if (m[1] === "subsection") {
        ss++;
        res.push({ level: 2, num: s + "." + ss, title: m[2], offset: m.index });
      } else {
        s++; ss = 0;
        res.push({ level: 1, num: "" + s, title: m[2], offset: m.index });
      }
    }
    return res;
  }

  window.WTLatex = { highlight, format, indentOnEnter, outline, escAll };
})();
