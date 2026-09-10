/* ===================== Iris · project-aware completion ===================== */
// The normalizer is also used by the server when saving/importing a project.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IrisCompletion = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  const MAX_COMMANDS = 200;
  const COMMAND_NAME = /^[\p{L}@][\p{L}\p{N}@_-]*\*?$/u;
  const COMMAND_PREFIX = /\\[\p{L}\p{N}@_-]*\*?$/u;
  const TEX_COMMANDS = `documentclass usepackage begin end title author date maketitle tableofcontents part chapter section subsection subsubsection paragraph subparagraph item label ref eqref pageref autoref cref Cref vref nameref cite citep citet parencite textcite autocite footcite citeauthor citeyear nocite bibliography bibliographystyle addbibresource printbibliography input include includeonly includegraphics caption centering footnote marginpar textbf textit texttt textsf textsc textrm textnormal emph underline tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge newcommand renewcommand providecommand DeclareRobustCommand NewDocumentCommand RenewDocumentCommand newenvironment renewenvironment def gdef edef xdef newtheorem theoremstyle newlength setlength addtolength hspace vspace hfill vfill quad qquad newline linebreak pagebreak newpage clearpage cleardoublepage noindent multicolumn multirow hline cline toprule midrule bottomrule frac dfrac tfrac sqrt sum prod int iint lim sin cos tan log ln exp min max left right text mathrm mathit mathbf mathcal mathbb mathsf mathtt operatorname overline vec hat bar dot ddot alpha beta gamma delta epsilon varepsilon theta vartheta lambda mu nu xi pi rho sigma tau phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega infty times cdot pm mp leq geq neq approx equiv in notin subset subseteq cup cap forall exists partial nabla degree percent verb url href`.split(" ");
  const TEX_ENVIRONMENTS = `document abstract itemize enumerate description figure figure* table table* tabular tabular* tabularx array matrix pmatrix bmatrix vmatrix cases equation equation* align align* aligned gather gather* multline multline* split center flushleft flushright minipage quote quotation verbatim verbatim* lstlisting minted tikzpicture theorem lemma proposition corollary definition proof frame columns column`.split(" ");
  const LY_COMMANDS = `version include language score book bookpart header paper layout midi new context with relative absolute fixed transpose key major minor time tempo clef repeat alternative volta tuplet times partial bar break noBreak pageBreak noPageBreak mark rehearsalMark textMark markup markuplist lyricmode lyrics addlyrics chordmode chords drummode drums figuremode figures notemode override revert set unset once tweak omit undo accidentalStyle ottava dynamicUp dynamicDown dynamicNeutral stemUp stemDown stemNeutral slurUp slurDown slurNeutral tieUp tieDown tieNeutral voiceOne voiceTwo voiceThree voiceFour oneVoice autoBeamOff autoBeamOn p ppp pp mp mf f ff fff cresc decresc dim glissando fermata trill turn mordent prall appoggiatura acciaccatura grace afterGrace arpeggio sustainOn sustainOff sostenutoOn sostenutoOff unaCorda treCorde compressMMRests compressEmptyMeasures skip rest barNumberCheck transposition removeWithTag keepWithTag tag unfoldRepeats alternative mm bold italic underline fontsize concat column line center-column overrideProperty applyContext shape shiftOn shiftOff cadenzaOn cadenzaOff`.split(" ");
  const LY_CONTEXTS = `Score Staff Voice StaffGroup GrandStaff PianoStaff ChoirStaff Lyrics ChordNames DrumStaff DrumVoice FiguredBass FretBoards TabStaff TabVoice Dynamics RhythmicStaff VaticanaStaff GregorianTranscriptionStaff MensuralStaff PetrucciStaff`.split(" ");

  function normalizeCustomCommands(value) {
    const invalid = (kind, line) => Object.assign(new Error("Invalid custom command"), { code: "CUSTOM_COMMANDS_INVALID", kind, line });
    if (value == null) value = {};
    if (typeof value !== "object" || Array.isArray(value)) throw invalid("tex", 1);
    const result = { tex: [], ly: [] };
    for (const kind of ["tex", "ly"]) {
      const input = value[kind] ?? [];
      if (typeof input !== "string" && !Array.isArray(input)) throw invalid(kind, 1);
      if (input.length > (typeof input === "string" ? 20000 : 1000)) throw invalid(kind, 1);
      const lines = typeof input === "string" ? input.split(/\r?\n/) : input;
      const seen = new Set();
      lines.forEach((line, index) => {
        if (typeof line !== "string" || line.length > 256) throw invalid(kind, index + 1);
        const name = line.trim().replace(/^\\/, "");
        if (!line.trim()) return;
        if (name.length > 80 || !COMMAND_NAME.test(name)) throw invalid(kind, index + 1);
        if (!seen.has(name)) { seen.add(name); result[kind].push("\\" + name); }
        if (result[kind].length > MAX_COMMANDS) throw invalid(kind, index + 1);
      });
    }
    return result;
  }

  function bibliographyKeys(src) {
    const keys = [];
    const re = /%[^\n]*|@([A-Za-z]+)\s*([{(])/g;
    let match;
    while ((match = re.exec(src))) {
      if (!match[1]) continue;
      const type = match[1].toLowerCase(), braceEntry = match[2] === "{";
      const key = src.slice(re.lastIndex).match(/^\s*([^\s,{}()"]+)\s*,/);
      if (key && !["comment", "string", "preamble"].includes(type)) keys.push(key[1]);
      let braces = braceEntry ? 1 : 0, quoted = false, i = re.lastIndex;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "\\") { i++; continue; }
        if (ch === '"' && (quoted || braces === (braceEntry ? 1 : 0))) { quoted = !quoted; continue; }
        if (quoted) continue;
        if (ch === "%") { const end = src.indexOf("\n", i); i = end < 0 ? src.length : end; continue; }
        if (ch === "{") braces++;
        else if (ch === "}") { if (--braces === 0 && braceEntry) { i++; break; } }
        else if (ch === ")" && !braceEntry && !braces) { i++; break; }
      }
      re.lastIndex = i;
    }
    return keys;
  }

  function terms(kind, text, syntax) {
    if (kind === "bib") return { citations: bibliographyKeys(text) };
    const code = syntax[kind].completionText(text).code;
    if (kind === "ly") return { commands: [...code.matchAll(/^\s*([\p{L}_][\p{L}\p{N}_-]*)\s*=/gmu)].map((m) => "\\" + m[1]) };
    const commands = [...code.matchAll(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand)\*?\s*\{?\s*(\\[\p{L}@]+)/gu),
      ...code.matchAll(/\\(?:def|gdef|edef|xdef)\s*(\\[\p{L}@]+)/gu)].map((m) => m[1]);
    return {
      commands,
      environments: [...code.matchAll(/\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment)\*?\s*\{([^{}\n]+)\}/g)].map((m) => m[1].trim()),
      labels: [...code.matchAll(/\\label\s*\{([^{}\\\s#]+)\}/g)].map((m) => m[1]),
    };
  }

  function completionTarget(prefix, kind, explicit) {
    let category = "commands", from, used = new Set();
    const argument = kind === "tex" && prefix.match(/\\(begin|end|ref|eqref|pageref|autoref|cref|Cref|vref|nameref|[A-Za-z]*cite[A-Za-z]*)\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}\\\n]*)$/);
    const lyContext = kind === "ly" && prefix.match(/\\(?:new|context)\s+([\p{L}\p{N}_-]*)$/u);
    const command = prefix.match(COMMAND_PREFIX);
    if (argument) {
      category = ["begin", "end"].includes(argument[1]) ? "environments" : /cite/i.test(argument[1]) ? "citations" : "labels";
      const parts = argument[2].split(","), tail = parts.pop();
      used = new Set(parts.map((part) => part.trim()));
      from = prefix.length - tail.length + (tail.length - tail.trimStart().length);
    } else if (lyContext) { category = "contexts"; from = prefix.length - lyContext[1].length; }
    else if (command) from = prefix.length - command[0].length;
    else if (explicit) from = prefix.length;
    else return null;
    return { category, from, used };
  }

  function createSource(kind, getProject, syntax) {
    const cache = new Map();
    return (context) => {
      if (context.state.readOnly || !["tex", "ly"].includes(kind)) return null;
      const text = context.state.doc.toString(), prefix = text.slice(0, context.pos);
      const explicit = context.explicit && /^[\t ]*$/.test(prefix.slice(prefix.lastIndexOf("\n") + 1));
      // Ordinary prose never needs the full comment/string/literal scanner.
      if (!completionTarget(prefix, kind, explicit)) return null;
      const scanned = syntax[kind].completionText(prefix);
      if (!scanned.active) return null;
      const target = completionTarget(scanned.code, kind, explicit);
      if (!target) return null;
      const { category, from, used } = target;
      const scope = getProject() || {}, options = new Map(), paths = new Set();
      const type = category === "commands" ? "function" : ["environments", "contexts"].includes(category) ? "class" : "constant";
      const add = (label, detail, optionType = type) => { if (label && !used.has(label)) options.set(label, { label, type: optionType, ...(detail ? { detail } : {}) }); };
      if (category === "commands") (kind === "tex" ? TEX_COMMANDS : LY_COMMANDS).forEach((name) => add("\\" + name));
      if (category === "environments") TEX_ENVIRONMENTS.forEach((name) => add(name));
      if (category === "contexts") LY_CONTEXTS.forEach((name) => add(name));
      const addTerms = (fileKind, content, path) => {
        let entry = cache.get(path);
        if (!entry || entry.text !== content || entry.kind !== fileKind) {
          entry = { text: content, kind: fileKind, terms: terms(fileKind, content, syntax) };
          cache.set(path, entry);
        }
        paths.add(path);
        if (fileKind === kind || (fileKind === "bib" && category === "citations")) {
          (entry.terms[category] || []).forEach((label) => add(label, path, fileKind === "ly" ? "variable" : type));
        }
      };
      const visit = (nodes, parent = "") => (nodes || []).forEach((node) => {
        if (node.generated) return;
        const path = node.path || (parent ? parent + "/" : "") + node.name;
        if (node.type === "folder") return visit(node.children, path);
        const fileKind = /\.(tex|sty|cls|ltx)$/i.test(path) ? "tex" : /\.(ly|ily)$/i.test(path) ? "ly" : /\.bib$/i.test(path) ? "bib" : null;
        if (fileKind) addTerms(fileKind, path === scope.activePath ? text : String(node.content || ""), path);
      });
      visit(scope.nodes);
      if (!scope.activePath || !paths.has(scope.activePath)) addTerms(kind, text, scope.activePath || "");
      for (const path of cache.keys()) if (!paths.has(path)) cache.delete(path);
      if (category === "commands") normalizeCustomCommands(scope.customCommands)[kind].forEach((label) => add(label, scope.customLabel));
      return { from, options: Array.from(options.values()), validFor: category === "commands" ? /^\\?[\p{L}\p{N}@_-]*\*?$/u : /^[^\s,{}\\]*$/u };
    };
  }

  function canPairBrace(kind, prefix, syntax) {
    if (!syntax[kind]) return false;
    const slashes = prefix.match(/\\+$/)?.[0].length || 0;
    if (slashes % 2 || (kind === "ly" && prefix.endsWith("#"))) return false;
    return syntax[kind].completionText(prefix).active;
  }

  return { normalizeCustomCommands, createSource, canPairBrace, MAX_COMMANDS };
});
