# Language qualification corpus (HP-01)

This corpus contains 21 original synthetic sources for LaTeX and LilyPond. The
authors chose the roles, modes and titles from the language constructs, without
using Iris parser output as an oracle. `cases.json` records **target expectations
for HP04-06**. HP-01 tests validate the data and its tooling; they do not certify
the current grammars against those targets.

**User corpus and user acceptance are pending.** These small cases cover named
requirements, not the distribution or complexity of personal projects.

## Origin, license and syntax

The Iris contributors created these fixture sources and annotations for this
task and dedicate them under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/).
They contain no personal project data or copied third-party examples. Each case
has its own `origin`, `syntax` and `validity` metadata, including `included.ily`.
The metadata lives in the manifest so the exact minimal math fixture needs no
license header that would shift its offsets. Repository code retains its existing
license.

LaTeX cases use LaTeX2e (2025-06 syntax), with the packages/profiles named per
case: amsmath, graphicx, minted, listings, cleveref, biblatex, xparse and expl3. LilyPond
cases use 2.26.0 syntax and embedded Guile Scheme. `complete` means a complete
lexical fragment under those assumptions. Most TeX fragments need a document
wrapper; paths and reference keys are placeholders. HP-01 does not claim native
compilation, engraving or font availability.

`latex-arguments.tex` assumes biblatex's `\cite[prenote][postnote]{keys}`
signature. Its two optional notes are `see` and `p.~2`; `alpha,beta` is the
citation-key list. This probe depends on that citation profile rather than the
kernel's single-optional-note `\cite` signature.

`latex-incomplete.tex` is malformed and incomplete. `lilypond-scheme.ly` has
balanced delimiters but deliberately supplies a non-music Scheme value inside
music, so its status is `invalid`. The three `lilypond-*-incomplete.ly` cases
leave a string, Scheme list or block comment open. Their metadata distinguishes
these probes from complete fragments.

## Format and offset contract

`cases.json` is an array. A case contains:

| Field | Meaning |
| --- | --- |
| `id` | Unique lowercase identifier (`a-z`, digits, hyphens). |
| `kind` | `tex` or `ly`; `.ily` belongs to `ly`. |
| `file` | Relative source path inside this folder. |
| `expectations` | `target`, separate from current baseline output. |
| `origin` | `{type, author, license}`; type is `synthetic` or `user-supplied`. |
| `syntax` | Version and package/profile assumptions. |
| `validity` | `{status, note}`; status is `complete`, `incomplete` or `invalid`. |
| `requirements` | Requirement IDs supported by this case's annotations. |
| `roles` | `{from, to, role, text, requirement}` spans. |
| `contexts` | `{pos, mode, before, after, requirement}` insertion-caret probes. |
| `outline` | Ordered expected title strings, including an empty list where appropriate. |
| `regions` | Optional `{from, to, label, text, requirement}` structural ranges. |

Offsets are **UTF-16 code units**, zero-based and half-open (`[from,to)`). A caret
describes the mode before the character at `pos`. Thus caret 17 in
`latex-math.tex` is still in math before its closing dollar. The comment is
exactly `[3,15)`, excluding LF:

```text
$a % $ commento
b$ testo
```

`text` must equal the source slice. `before` and `after` must match the immediate
caret neighbors; one can be empty at a document boundary. These anchors catch
offset drift without interpreting the grammar. Spans cannot split a surrogate
pair. Role spans cannot overlap. Region spans can nest or be adjacent but cannot
cross or duplicate one another. The validator does not infer outline titles or
prove semantic role choices; review those against the source.

The sources use UTF-8 without BOM and LF only. The local `.gitattributes` sets
`text eol=lf` so Windows checkouts retain the annotated offsets. The loader
rejects CR/CRLF, BOM and malformed Unicode instead of normalizing the source.

### Roles and modes

Roles: `command`, `structure`, `environment`, `context`, `definition`, `variable`,
`reference`, `citation`, `path`, `string`, `literal`, `lyric`, `math`, `pitch`,
`number`, `duration`, `rest`, `operator`, `articulation`, `comment`, `delimiter`,
`property`, `scheme`, `text`.

Defining commands such as `\newcommand`, `\def` and `\cs_new:Npn` use `command`.
The name being defined, such as `\hello`, `boxnote` or `\iris_name:n`, uses
`definition`. Macro definitions and their calls do not contribute expanded
headings to the local outline.

LilyPond slur endpoints `(`/`)` and beam endpoints `[`/`]` are musical events
and use `articulation`, alongside dynamics and hairpins. Braces, chord brackets
and simultaneous-music brackets `<<`/`>>` use `delimiter`.

`text` explicitly means plain text. Unannotated gaps make no assertion; they do
not imply `text` or `null`. Semantic argument roles can cover a list (for example
`alpha,beta` is a citation argument). `pitch` covers note names with alterations
and octave marks, and the chord-repeat token `q`; separate spans cover durations.
Drum names and pitch-looking markup stay `text` in this vocabulary. Literal,
string and multiline text spans can include LF. Future rendering checks should
distinguish lexical spans from painting line breaks.

Modes: `text`, `math`, `comment`, `literal`, `music`, `lyrics`, `markup`, `chords`,
`drums`, `figures`, `scheme`, `string`. A mode is context, not a token color.
For example `\text{testo}` inside align is text in a surrounding math environment.

Outline titles use long titles with raw nested braces/internal newlines;
short optional titles do not replace them. LilyPond score numbering uses the
English fallback `Score 1`. `regions` is a partial list of required ranges;
`outline` is the complete expected title list for that fixture.

## Requirement coverage

| ID | Main files and hand-labelled construct |
| --- | --- |
| TX-01 | `latex-core.tex`: control words/symbols, escaped punctuation, comment, nested group, optional argument, star, Unicode. |
| TX-02 | `latex-math.tex`, `latex-math-delimiters.tex`: dollar/control-symbol delimiters, comments containing fake closers, commands, caret before closer. |
| TX-03 | `latex-environments.tex`: align*, equation, pmatrix, alignment operator and text inside math. |
| TX-04 | `latex-literal.tex`: verb/verb*, verbatim, minted, lstlisting; fake headings and labels; return to normal text. |
| TX-05 | `latex-headings.tex`: part through subparagraph, optional/starred/nested/multiline titles. |
| TX-06 | `latex-custom.tex`, `latex-incomplete.tex`: same-name nesting with exact regions, stray/mismatched ends and unfinished begin. |
| TX-07 | `latex-macros.tex`: newcommand, def, xparse command/environment definitions, parameters and calls; fake heading in an unexpanded definition. |
| TX-08 | `latex-arguments.tex`: labels, ref/cref lists, cite options/list, include/input/graphics paths. |
| TX-09 | `latex-profiles.tex`: makeatletter/internal control words, expl3 toggles and control words. |
| LY-01 | `lilypond-core.ly`, `lilypond-incomplete.ly`, `lilypond-comment-incomplete.ly`: comments, strings, escapes, Unicode and EOF modes. |
| LY-02 | `lilypond-core.ly`: alterations/octaves, dotted/factored durations, r/R/s, q. |
| LY-03 | `lilypond-core.ly`: chords, simultaneous voices, braces, bars, beams/slurs, dynamics/hairpins and articulations. |
| LY-04 | `lilypond-core.ly`, `lilypond-properties.ly`: variables, score/context blocks and a with header longer than 240 units. |
| LY-05 | `lilypond-modes.ly`: music, lyrics, markup, chords, drums and figures; pitch-looking prose. |
| LY-06 | `lilypond-languages.ly`, `included.ily`, `included-default.ily`: four local language profiles, neutral pitches after includes, recovery through a local directive, and the editorial nederlands default for a standalone .ily. |
| LY-07 | `lilypond-properties.ly`: override/set, grob/property paths, Staff/Voice contexts. |
| LY-08 | `lilypond-scheme.ly`, `lilypond-scheme-incomplete.ly`: #/$, quote/list, numbers, strings, semicolon comments, `#\)`, `#{...#}`, incomplete list and return to music. |

The loader returns include files as separate local-analysis cases. A literal
include makes subsequent pitch-language interpretation uncertain: ambiguous
names stay `text`, while duration, structure and `music` mode remain available.
An explicit local `\language` restores pitch classification. Local analysis does
not resolve includes or infer the compiler's include-carried language. The
existing `included.ily` declares italiano locally; `included-default.ily` has no
directive and documents the editor's nederlands assumption. Macro expansion is
also outside local analysis.

## Helpers and historical baseline

Use Node 24+ from the repository root:

```powershell
node --test test/language-fixtures.test.js test/ui-colors.test.js test/editor-stream.test.js test/structure.test.js test/completion.test.js
node -e "const h=require('./test/helpers/language-fixtures.cjs'); console.log(h.loadFixtures().map(f=>({id:f.id,...f.metrics})));"
```

`test/helpers/language-fixtures.cjs` exports:

| Export | Contract |
| --- | --- |
| `FIXTURE_ROOT` | Absolute corpus directory. |
| `REQUIREMENT_IDS`, `ROLE_NAMES`, `CONTEXT_MODES` | Frozen vocabulary arrays. |
| `resolveFixturePath(root, file)` | Contained existing file path; accepts slash/backslash relative forms, rejects traversal/absolute paths and escaping symlinks. |
| `validateCase(item, source)` | Validate metadata, ranges, anchors and coverage; return `item` without mutation. Filesystem checks belong to manifest validation. |
| `validateManifest(manifest, root = FIXTURE_ROOT)` | Reject duplicate IDs/file aliases and invalid cases; return enriched cases with `source` and `metrics`. |
| `loadFixtures(root = FIXTURE_ROOT)` | Read `cases.json`, then validate it. |
| `collectBaseline(spec, source)` | Return `{tokens, lines, classes, state, metrics}` using a fresh tokenizer state. |
| `generateFixture(kind, bytes, {singleLine = false} = {})` | Return `{source, metrics}` with exact UTF-8 byte size and a complete lexical envelope. |
| `rolesFor(kind, source, options)` / `analysisRolesFor(...)` | Actual service roles; the latter includes tree, summary and availability metadata. |

HP07 removed the legacy runtime TeX/LY scanners and `loadBaselineModules`.
The observations below describe the HP01 checkout (`4d37c4e`) and remain
historical evidence. Current gates exercise the Lezer service, its immutable
summaries and the mounted editor. All annotated source fixtures remain in use.

Metrics are `{bytes, codeUnits, lines}`. Lines include the final empty line after
a trailing newline. The collector accepts LF, CRLF and CR and preserves their
raw offsets, even though checked-in fixtures require LF. Its token objects are
`{from,to,style,line}`; `line` is one-based. Line objects are `{from,to,end}` where
`to` excludes and `end` includes the line separator. `classes` has one entry per
UTF-16 unit, with `null` at separators and unclassified positions. The collector
calls `blankLine`, checks progress/bounds and retains raw current token names
(`cmd`, `brace`, etc.). It performs no mapping to target roles.

Generators support 102400, 1048576 and 5242880 bytes (100 KiB, 1 MiB, 5 MiB), plus
`generateFixture(kind, 102400, {singleLine:true})`. They repeat complete TeX
text/math units or LilyPond music with balanced block comments. Bounded whitespace
fills the final remainder before the closer. They do not cut UTF-8, surrogate
pairs, commands or comments. Unicode makes byte size differ from code-unit length.
The generated inputs are synthetic lexical workloads, not native compiler tests.

### Historical differences observed in HP01 (2026-09-15)

- In the exact math fixture, the stream consumes the comment's dollar as a
  closer, returns `state.math = null` at caret 17 and paints the following prose
  as math. It supplies no comment token for `[3,15)`.
- The outline emits `Comment fake` and five literal fake headings from
  `latex-literal.tex`; regions also include those five literal headings.
  Completion suppresses suggestions inside `verb`, so current consumers disagree.
- The outline truncates nested titles and omits part/chapter/deeper levels.
  It also emits `Definition fake` from a macro definition.
- The LilyPond stream leaves the annotated notes and durations unclassified.
  It has no pitch-language/mode/Scheme interpretation.
- The long `\new Staff \with` case yields only the nested Voice region; the
  Staff region `[0,438)` is missing. Existing region scans also attach some
  point directives or scalar variables to a later music block.

These are measured baseline observations, not tests that require bugs to persist.
See `.drafts/highlighting-parsing-qualification.md` for measurements and the
HP-01 report for commands and TDD evidence.

## Extending with user-supplied cases

1. Add a source directly in this folder with permission to redistribute it.
   Record the supplied author/license and `origin.type: "user-supplied"`. Remove
   private content before adding it. Preserve a minimal reproduction of the issue.
2. Record the syntax version, required packages/includes, and a validity note.
   Include local dependencies as their own manifest entries.
3. Assign a unique ID/file and the requirement IDs being exercised. Keep source
   names distinct even under Windows case-folding.
4. Review roles, caret modes and outline titles by hand. Add exact UTF-16 ranges
   and source/neighbor anchors. Leave uncertain spans unannotated and explain
   the gap in the case note; do not copy current tokenizer output into targets.
5. Run the command above. Check target behavior through HP04-06 grammar tests
   and the controller's browser workflow when available. Record user acceptance
   separately from a passing corpus validator.
