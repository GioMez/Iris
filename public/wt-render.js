/* ===================== WebTeX · LaTeX → preview renderer ===================== */
(function () {
  const T0 = "\uE000", T1 = "\uE001"; // placeholder delimiters

  function escapeHTML(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function todayStr() {
    return new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  }
  function firstArg(src, re) {
    const m = src.match(re);
    return m ? m[1].trim() : null;
  }

  /* validation: environment balance */
  function validate(src) {
    const errors = [], warnings = [];
    const lines = src.split("\n");
    const stack = [];
    const re = /\\(begin|end)\s*\{([^}]*)\}/g;
    lines.forEach((ln, idx) => {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(ln))) {
        const env = m[2];
        if (m[1] === "begin") stack.push({ env, line: idx + 1 });
        else {
          const top = stack.pop();
          if (!top) errors.push({ line: idx + 1, msg: `\\end{${env}} senza \\begin corrispondente` });
          else if (top.env !== env) errors.push({ line: idx + 1, msg: `atteso \\end{${top.env}}, trovato \\end{${env}}` });
        }
      }
    });
    stack.forEach((s) => errors.push({ line: s.line, msg: `ambiente \\begin{${s.env}} mai chiuso` }));
    if (!/\\begin\s*\{document\}/.test(src)) warnings.push({ line: 0, msg: "manca \\begin{document}" });
    return { errors, warnings };
  }

  function compile(src, ctx) {
    ctx = ctx || {};
    const assets = ctx.assets || {};
    const math = [];
    const blocks = [];
    const { errors, warnings } = validate(src);

    // metadata (search whole source / preamble)
    const meta = {
      title: firstArg(src, /\\title\s*\{([^]*?)\}/),
      author: firstArg(src, /\\author\s*\{([^]*?)\}/),
      date: firstArg(src, /\\date\s*\{([^]*?)\}/),
    };

    // body between \begin{document}..\end{document}
    let body;
    const dm = src.match(/\\begin\s*\{document\}([\s\S]*?)\\end\s*\{document\}/);
    body = dm ? dm[1] : src;

    // strip comments (keep \%)
    body = body.replace(/([^\\])%[^\n]*/g, "$1").replace(/^%[^\n]*/gm, "");

    const pushMath = (tex, display) => {
      const idx = math.length;
      math.push({ tex: tex.trim(), display });
      return display ? `\n\n${T0}m${idx}${T1}\n\n` : `${T0}m${idx}${T1}`;
    };
    const pushBlock = (html) => {
      const idx = blocks.length;
      blocks.push(html);
      return `\n\n${T0}b${idx}${T1}\n\n`;
    };

    // protect math
    body = body.replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => pushMath(e, true));
    body = body.replace(/\\\[([\s\S]+?)\\\]/g, (_, e) => pushMath(e, true));
    body = body.replace(/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}/g,
      (_, env, e) => {
        e = e.replace(/\\label\{[^}]*\}/g, "");
        if (/^align/.test(env)) e = `\\begin{aligned}${e}\\end{aligned}`;
        else if (/^gather/.test(env)) e = `\\begin{gathered}${e}\\end{gathered}`;
        return pushMath(e, true);
      });
    body = body.replace(/\$([^$\n][^$]*?)\$/g, (_, e) => pushMath(e, false));
    body = body.replace(/\\\(([\s\S]+?)\\\)/g, (_, e) => pushMath(e, false));

    // figures
    body = body.replace(/\\begin\{figure\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{figure\}/g, (_, inner) => {
      const ig = inner.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/);
      const cap = inner.match(/\\caption\{([^]*?)\}/);
      return pushBlock(figureHTML(ig ? ig[1] : null, cap ? cap[1] : null, assets));
    });
    // bare includegraphics
    body = body.replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g, (_, p) =>
      pushBlock(figureHTML(p, null, assets)));

    // lists
    body = body.replace(/\\begin\{(itemize|enumerate)\}([\s\S]*?)\\end\{\1\}/g, (_, kind, inner) => {
      const items = inner.split(/\\item\b/).slice(1).map((s) => `<li>${inlineFmt(s.trim())}</li>`).join("");
      return pushBlock(`<${kind === "itemize" ? "ul" : "ol"}>${items}</${kind === "itemize" ? "ul" : "ol"}>`);
    });

    // title
    body = body.replace(/\\maketitle/g, () => {
      const t = meta.title ? `<div class="doc-title">${inlineFmt(meta.title)}</div>` : "";
      const a = meta.author ? `<div class="doc-auth">${inlineFmt(meta.author)}</div>` : "";
      const dRaw = meta.date != null ? meta.date : "\\today";
      const d = `<div class="doc-date">${inlineFmt(dRaw)}</div>`;
      return pushBlock(t + a + d);
    });

    // isolate sections
    body = body.replace(/(\\(?:sub)?section\*?\s*\{[^}]*\})/g, "\n\n$1\n\n");

    // split into segments
    const segs = body.split(/\n[ \t]*\n/);
    let secN = 0, subN = 0;
    let html = "";
    for (let seg of segs) {
      const s = seg.trim();
      if (!s) continue;
      let m;
      if ((m = s.match(/^\\section\*?\s*\{([^}]*)\}$/))) {
        const star = /\\section\*/.test(s);
        if (!star) { secN++; subN = 0; }
        html += `<h2 class="sec">${star ? "" : secN + " "}${inlineFmt(m[1])}</h2>`;
        continue;
      }
      if ((m = s.match(/^\\subsection\*?\s*\{([^}]*)\}$/))) {
        const star = /\\subsection\*/.test(s);
        if (!star) subN++;
        html += `<h3 class="sub">${star ? "" : secN + "." + subN + " "}${inlineFmt(m[1])}</h3>`;
        continue;
      }
      if ((m = s.match(/^\uE000b(\d+)\uE001$/))) { html += blocks[+m[1]]; continue; }
      if ((m = s.match(/^\uE000m(\d+)\uE001$/))) {
        html += `<div class="eqn kx" data-idx="${m[1]}"></div>`;
        continue;
      }
      // paragraph
      html += `<p>${inlineFmt(s)}</p>`;
    }

    return { html, math, blocks, meta, errors, warnings };

    /* ---- inline formatting ---- */
    function inlineFmt(seg) {
      // protect escaped specials
      seg = seg.replace(/\\([%&#_${}])/g, (_, ch) => `\uE010${ch.charCodeAt(0)}\uE011`);
      seg = escapeHTML(seg);
      seg = seg
        .replace(/\\textbf\s*\{([^{}]*)\}/g, "<strong>$1</strong>")
        .replace(/\\textit\s*\{([^{}]*)\}/g, "<em>$1</em>")
        .replace(/\\emph\s*\{([^{}]*)\}/g, "<em>$1</em>")
        .replace(/\\underline\s*\{([^{}]*)\}/g, "<u>$1</u>")
        .replace(/\\texttt\s*\{([^{}]*)\}/g, '<span class="tt">$1</span>')
        .replace(/\\textsc\s*\{([^{}]*)\}/g, '<span style="font-variant:small-caps">$1</span>')
        .replace(/\\LaTeX\b/g, 'L<sup style="font-size:.7em;vertical-align:.3em;margin-left:-.35em;margin-right:-.12em">A</sup>T<sub style="vertical-align:-.3em;margin-left:-.12em">E</sub>X')
        .replace(/\\TeX\b/g, 'T<sub style="vertical-align:-.3em">E</sub>X')
        .replace(/\\today\b/g, todayStr())
        .replace(/``/g, "\u201C").replace(/''/g, "\u201D").replace(/`/g, "\u2018").replace(/'/g, "\u2019")
        .replace(/---/g, "\u2014").replace(/--/g, "\u2013")
        .replace(/\\\\/g, "<br>")
        .replace(/\\[,; !]/g, " ")
        .replace(/~/g, "&nbsp;")
        // math placeholders → inline spans
        .replace(/\uE000m(\d+)\uE001/g, '<span class="kx" data-idx="$1"></span>')
        // drop unhandled simple commands (no args) quietly
        .replace(/\\(?:par|noindent|centering|small|large|Large|huge|footnotesize|normalsize|bigskip|medskip|smallskip|hfill|vfill|clearpage|newpage|indent)\b/g, "")
        // restore escaped specials
        .replace(/\uE010(\d+)\uE011/g, (_, n) => {
          const ch = String.fromCharCode(+n);
          return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
        });
      return seg;
    }
  }

  function figureHTML(path, caption, assets) {
    let inner;
    const src = path ? (assets[path] || assets[path.split("/").pop()]) : null;
    if (src) inner = `<img class="fig" src="${src}" alt="">`;
    else inner = `<div class="figbox">[ ${path ? escapeHTML(path) : "immagine"} ]</div>`;
    const cap = caption ? `<div class="cap">${escapeHTML(caption)}</div>` : "";
    return `<figure style="margin:0">${inner}${cap}</figure>`;
  }

  window.WTRender = { compile };
})();
