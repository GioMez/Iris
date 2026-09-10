/* ===================== Iris · LaTeX engine ===================== */
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

  /* ---- CodeMirror stream tokenizer: same rules as highlight() ---- */
  // Token names map 1:1 onto the t-* CSS classes used by highlight():
  // cmd → t-cmd, env → t-env, brace → t-brace, math → t-math,
  // comment → t-comment, special → t-special, null → plain text.
  const stream = {
    startState() { return { math: null, expect: null }; },
    copyState(s) { return { math: s.math, expect: s.expect }; },
    token(stream, state) {
      if (state.math) {
        const close = state.math;
        if (close === "$" || close === "$$") {
          while (!stream.eol()) {
            if (stream.peek() === "\\") { stream.next(); if (!stream.eol()) stream.next(); continue; }
            if (close === "$$") {
              if (stream.match("$$")) { state.math = null; return "math"; }
              stream.next();
            } else if (stream.next() === "$") { state.math = null; return "math"; }
          }
          return "math";
        }
        while (!stream.eol()) {
          if (stream.match(close)) { state.math = null; return "math"; }
          stream.next();
        }
        return "math";
      }

      // \begin / \end argument: { → brace, name → env, } → brace
      if (state.expect === "open") {
        if (stream.sol()) state.expect = null;
        else if (stream.eatWhile(/[ \t]/)) {
          if (stream.peek() !== "{") state.expect = null;
          return null;
        } else if (stream.peek() === "{") {
          stream.next();
          state.expect = "name";
          return "brace";
        } else state.expect = null;
      }
      if (state.expect === "name") {
        state.expect = null;
        if (stream.eat("}")) return "brace";
        if (stream.match(/^[^}\n]+(?=\})/)) { state.expect = "close"; return "env"; }
      }
      if (state.expect === "close") {
        state.expect = null;
        if (stream.eat("}")) return "brace";
      }

      const c = stream.next();
      if (c === "%") { stream.skipToEnd(); return "comment"; }
      if (c === "\\") {
        if (stream.eatWhile(/[a-zA-Z]/)) {
          stream.eat("*");
          const cmd = stream.current();
          if (cmd === "\\begin" || cmd === "\\end") state.expect = "open";
          return "cmd";
        }
        stream.next();
        const cmd = stream.current();
        if (cmd === "\\\\") return "special";
        if (cmd === "\\[") { state.math = "\\]"; return "math"; }
        if (cmd === "\\(") { state.math = "\\)"; return "math"; }
        return "cmd";
      }
      if (c === "$") { state.math = stream.eat("$") ? "$$" : "$"; return "math"; }
      if (c === "{" || c === "}" || c === "[" || c === "]") return "brace";
      if (c === "&" || c === "~") return "special";
      stream.eatWhile(/[^\\%${}[\]&~]/);
      return null;
    },
  };

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
  function indentOnEnter(value, pos, block = blockAtEnter(value, pos)) {
    const before = value.slice(0, pos);
    const line = before.slice(before.lastIndexOf("\n") + 1);
    const lead = (line.match(/^[\t ]*/) || [""])[0];
    return "\n" + lead + (block ? "  " : "");
  }

  const LITERAL_ENVIRONMENTS = new Set(["verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*"]);

  function environmentTokens(src, context = null) {
    const tokens = [];
    const mask = (from, to) => { if (context) context.ranges.push({ from, to }); };
    // Consume escaped backslashes and percent signs before interpreting the
    // next environment or comment. Verbatim bodies are literal.
    const re = /\\(begin|end)\s*\{([^{}\r\n]+)\}|\\verb\*?([^\sA-Za-z])|\\[\p{L}@]+|\\[\s\S]|%[^\n]*/gu;
    let match;
    while ((match = re.exec(src))) {
      if (match[3]) {
        const end = src.indexOf(match[3], re.lastIndex);
        const lineEnd = src.indexOf("\n", re.lastIndex);
        const closed = end >= 0 && (lineEnd < 0 || end < lineEnd);
        re.lastIndex = closed ? end + 1 : (lineEnd < 0 ? src.length : lineEnd);
        mask(match.index, re.lastIndex);
        if (context && !closed && lineEnd < 0) context.active = false;
        continue;
      }
      if (!match[1]) {
        if (match[0].startsWith("%")) {
          mask(match.index, re.lastIndex);
          if (context && re.lastIndex === src.length) context.active = false;
        } else if (/^\\[^\p{L}@]$/u.test(match[0])) mask(match.index, re.lastIndex);
        continue;
      }
      const token = { type: match[1], name: match[2].trim(), from: match.index, to: re.lastIndex };
      tokens.push(token);
      if (token.type === "begin" && LITERAL_ENVIRONMENTS.has(token.name)) {
        const close = `\\end{${token.name}}`;
        const end = src.indexOf(close, re.lastIndex);
        mask(token.to, end < 0 ? src.length : end);
        if (end < 0) { if (context) context.active = false; break; }
        tokens.push({ type: "end", name: token.name, from: end, to: end + close.length });
        re.lastIndex = end + close.length;
      }
    }
    return tokens;
  }

  function completionText(src) {
    const context = { ranges: [], active: true };
    environmentTokens(src, context);
    let code = "", from = 0;
    for (const range of context.ranges) {
      code += src.slice(from, range.from) + src.slice(range.from, range.to).replace(/[^\n]/g, " ");
      from = range.to;
    }
    return { code: code + src.slice(from), active: context.active };
  }

  // Describes the block immediately before the caret and its existing closer,
  // if any. The editor owns insertion, indentation and cursor placement.
  function blockAtEnter(src, pos) {
    const lineStart = src.lastIndexOf("\n", pos - 1) + 1;
    if (!/\\begin\b/.test(src.slice(lineStart, pos))) return null;
    const tokens = environmentTokens(src);
    const open = [], unclosed = [], closings = new Map();
    let candidate = null;
    for (const token of tokens) {
      if (token.type === "begin") {
        open.push(token);
        if (token.from >= lineStart && token.to <= pos && !withoutComments(src.slice(token.to, pos)).trim()) candidate = token;
      } else {
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i].name !== token.name) continue;
          closings.set(open[i].from, token.from);
          unclosed.push(...open.slice(i + 1).map((entry) => ({ ...entry, until: token.from })));
          open.splice(i);
          break;
        }
      }
    }
    if (!candidate || !candidate.name) return null;
    unclosed.push(...open.map((entry) => ({ ...entry, until: src.length })));
    // When a new nested opener was typed before an outer end, that end must
    // remain available to the enclosing environment, including same-name nests.
    const reserved = unclosed.some((entry) => entry.from < candidate.from && candidate.from < entry.until && entry.name === candidate.name);
    const closingFrom = closings.get(candidate.from) ?? null;
    return { close: `\\end{${candidate.name}}`, closingFrom, needsClose: reserved || closingFrom == null };
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

  /* ---- structural regions: the areas two people can share ---- */
  // The outline answers "where does this heading start"; this answers "how far
  // does it reach", which is what tells whether two carets are inside the same
  // construct rather than merely near each other in the file.

  // Comments carry no structure, and a commented-out \end would unbalance every
  // environment after it. They are blanked in place, so every offset still
  // points at the same character of the original source. A backslash escapes
  // whatever follows it, which is what keeps \% from opening a comment.
  function withoutComments(src) {
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const char = src[i];
      if (char === "\\") {
        out += char + (i + 1 < src.length ? src[i + 1] : "");
        i += 1;
        continue;
      }
      if (char !== "%") {
        out += char;
        continue;
      }
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      out += i < src.length ? "\n" : "";
    }
    return out;
  }

  // The contents of a {...} starting at `open`, counting nested braces so a
  // title containing a command is not cut at the first closing brace.
  function braced(src, open) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "\\") { i += 1; continue; }
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (!depth) return { text: src.slice(open + 1, i), end: i + 1 };
      }
    }
    return { text: src.slice(open + 1), end: src.length };
  }

  // Sectioning commands, outermost first. A heading runs until the next heading
  // of the same or higher rank.
  const SECTION_RANKS = {
    part: 1, chapter: 2, section: 3, subsection: 4, subsubsection: 5, paragraph: 6, subparagraph: 7,
  };

  function regions(src) {
    const clean = withoutComments(src);
    const found = [];

    const envRe = /\\(begin|end)\s*\{([^}]*)\}/g;
    const open = [];
    let match;
    while ((match = envRe.exec(clean))) {
      const name = match[2].trim();
      // `document` wraps the whole body: sharing it says no more than sharing
      // the file, which the tree already shows.
      if (name === "document") continue;
      if (match[1] === "begin") {
        open.push({ name, from: match.index });
        continue;
      }
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].name !== name) continue;
        found.push({ kind: "environment", label: `\\begin{${name}}`, name, from: open[i].from, to: envRe.lastIndex });
        // Anything opened inside it and never closed dies with it.
        open.splice(i);
        break;
      }
    }
    // An environment left open runs to the end of the file rather than being
    // dropped: half-written markup is exactly when people collide.
    open.forEach((entry) => {
      found.push({ kind: "environment", label: `\\begin{${entry.name}}`, name: entry.name, from: entry.from, to: clean.length });
    });

    const headRe = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g;
    const heads = [];
    while ((match = headRe.exec(clean))) {
      heads.push({
        rank: SECTION_RANKS[match[1]],
        name: match[1],
        title: braced(clean, headRe.lastIndex - 1).text.trim(),
        from: match.index,
      });
    }
    heads.forEach((head, index) => {
      let to = clean.length;
      for (let next = index + 1; next < heads.length; next++) {
        if (heads[next].rank <= head.rank) { to = heads[next].from; break; }
      }
      found.push({
        kind: "section",
        label: head.title || `\\${head.name}`,
        name: head.name,
        level: head.rank,
        from: head.from,
        to,
      });
    });

    // Outermost first at the same position, so the nesting can be rebuilt by a
    // single pass (see iris-structure.js).
    return found.sort((a, b) => a.from - b.from || b.to - a.to);
  }

  window.IrisLatex = { highlight, format, indentOnEnter, blockAtEnter, completionText, outline, regions, escAll, stream };
})();
