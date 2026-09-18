// Editorial signatures, authored for Iris (not macro execution or package loading).
// Argument order is explicit, including optional arguments after declared names.
export const headings = Object.freeze({ part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 });
export const mathEnvironments = new Set("math displaymath equation align alignat flalign gather multline eqnarray aligned alignedat gathered split cases array matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix".split(" ").flatMap(n => [n, n + "*"]));
export const literalEnvironments = Object.freeze(Object.assign(Object.create(null), {
  verbatim: { args: [], line: false }, "verbatim*": { args: [], line: false },
  Verbatim: { args: ["?text"], line: true }, BVerbatim: { args: ["?text"], line: true }, LVerbatim: { args: ["?text"], line: true },
  lstlisting: { args: ["?text"], line: true }, minted: { args: ["?text", "text"], line: true },
  comment: { args: [], line: "exact" }, filecontents: { args: ["?text", "path"], line: true }, "filecontents*": { args: ["?text", "path"], line: true },
}));
const signatures = Object.create(null);
function add(names, args, properties = {}) {
  for (const name of names.split(" ")) signatures[name] = Object.freeze({ star: false, args: Object.freeze(args), ...properties });
}
for (const [name, rank] of Object.entries(headings)) add(name, ["?text", "heading"], { star: true, rank });
add("text textrm textsf texttt textnormal mbox", ["text"]);
add("label", ["label"]);
add("ref pageref eqref autoref nameref vref Vref", ["reference"], { star: true });
add("cref Cref cpageref Cpageref", ["reference-list"], { star: true });
add("cite citep citet citealp citealt citeauthor citeyear citeyearpar Citet Citep Citeauthor autocite parencite textcite footcite footcitetext smartcite supercite fullcite footfullcite nocite", ["?text", "?text", "citation-list"], { star: true });
add("input include", ["path"], { include: true });
add("includegraphics", ["?text", "?text", "path"], { star: true, include: true });
add("bibliography", ["path-list"], { include: true });
add("addbibresource", ["?text", "path"], { include: true });
add("newcommand renewcommand providecommand DeclareRobustCommand", ["definition-command", "?text", "?default", "body"], { star: true, definition: "command" });
add("NewDocumentCommand RenewDocumentCommand ProvideDocumentCommand DeclareDocumentCommand", ["definition-command", "spec", "body"], { definition: "command" });
add("def gdef edef xdef cs_new:Npn cs_new_protected:Npn cs_set:Npn cs_set_protected:Npn cs_gset:Npn", ["definition-command", "body"], { definition: "command", parameters: true });
add("newenvironment renewenvironment provideenvironment", ["definition-environment", "?text", "?default", "body", "body"], { star: true, definition: "environment" });
add("NewDocumentEnvironment RenewDocumentEnvironment ProvideDocumentEnvironment DeclareDocumentEnvironment", ["definition-environment", "spec", "body", "body"], { definition: "environment" });
add("makeatletter makeatother ExplSyntaxOn ExplSyntaxOff", [], { profile: true });
export const commandSignatures = Object.freeze(signatures);
export const profileCommands = Object.freeze({ makeatletter: "internal", makeatother: "standard", ExplSyntaxOn: "expl3", ExplSyntaxOff: "standard" });

// Completion includes ordinary commands without claiming special parser arity.
export const completionCommands = Object.freeze([...new Set([...Object.keys(commandSignatures), ...`documentclass usepackage begin end title author date maketitle tableofcontents item bibliographystyle printbibliography includeonly caption centering footnote marginpar textbf textit textsc emph underline tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge newtheorem theoremstyle newlength setlength addtolength hspace vspace hfill vfill quad qquad newline linebreak pagebreak newpage clearpage cleardoublepage noindent multicolumn multirow hline cline toprule midrule bottomrule frac dfrac tfrac sqrt sum prod int iint lim sin cos tan log ln exp min max left right mathrm mathit mathbf mathcal mathbb mathsf mathtt operatorname overline vec hat bar dot ddot alpha beta gamma delta epsilon varepsilon theta vartheta lambda mu nu xi pi rho sigma tau phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega infty times cdot pm mp leq geq neq approx equiv in notin subset subseteq cup cap forall exists partial nabla degree percent verb url href`.split(" ")])]);
export const completionEnvironments = Object.freeze([...new Set([...mathEnvironments, ...Object.keys(literalEnvironments), ...`document abstract itemize enumerate description figure figure* table table* tabular tabular* tabularx center flushleft flushright minipage quote quotation tikzpicture theorem lemma proposition corollary definition proof frame columns column`.split(" ")])]);
