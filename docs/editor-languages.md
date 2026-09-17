# Editor language support

## LilyPond parser delivery: HP06

The language service supports `loadLanguage("ly", options)` and
`analyze("ly", source, options)` for music, text, configuration and embedded
Scheme. The editor installs guarded Lezer highlighting through
`iris-lilypond-highlighting.mjs`. The guard runs before LR startup and permits
neutral editing above 1,048,576 UTF-16 units; shrinking restores highlighting.

The HP05 subset covers LY01–LY07: strings and LilyPond comments; pitches, rests,
durations, chords and simultaneous music; expressive events; structural blocks,
assignments and context bodies; input modes and wrappers; local note-language
directives; properties and basic Scheme scalar values. Offsets are raw UTF-16
half-open ranges, including CRLF and astral characters. This is editorial syntax
recognition, not execution or a replacement for the LilyPond compiler.

Contexts and wrappers accept recursive music bodies, including
`\new Staff \relative c' { ... }`, `\new Lyrics \lyricmode { ... }` and
`\relative c' \tuplet 3/2 { ... }`. Context regions include the full expression
after any `\with` configuration.

`catalog.mjs` exports prototype-free `markupSignatures` and `numericSignatures`:

| Markup signature | Commands |
| --- | --- |
| One markup expression | `bold`, `italic`, `underline`, `tiny`, `small`, `large`, `huge` |
| Number, then markup | `fontsize` |
| Braced markup list | `concat`, `line`, `column`, `center-column`, `fill-line` |
| String or bare text | `musicglyph` |
| No argument | `null` |

Known command chains and bare scalar text stay in markup through the complete
argument. An unknown/dynamic markup command has no inferred arity: the parser
keeps the remaining source neutral with unknown markup context through EOF.
`UnknownMarkup` records that boundary; it is a conservative editing fallback.

The numeric signatures distinguish `\time`'s fraction from music durations and
`\tempo`'s beat-unit duration from its metronome number/range. Tempo can have a
quoted label, with or without a metronome setting. Drum mode recognizes `r/R/s`
rests while drum names remain neutral.

### Note names and provenance

`public/languages/lilypond/pitches.mjs` exports:

- `pitchCatalogVersion`: `"2.26.0"`.
- `noteLanguages`: a frozen array of the four supported convention names.
- `noteNames(language)`: a frozen set-like view with `size`, `has`, `values`,
  `keys`, `entries`, iteration and `forEach`, or `null` for an unsupported name.
  The backing Set is private; callbacks receive the readonly view.
- `normalizeNoteLanguage(language)`: a supported name or `"unknown"`.

Membership is adapted from LilyPond's versioned
[`scm/define-note-names.scm`](https://github.com/lilypond/lilypond/blob/v2.26.0/scm/define-note-names.scm).
Copyright and GPL-3.0-or-later attribution are in `THIRD_PARTY_NOTICES.md`.

| Convention | Spellings | Examples and exceptions |
| --- | ---: | --- |
| `nederlands` | 67 | `cis`, `bes`, `ceseh`, `cisih`; `es/ees`, `eses/eeses`, `as/aes`, `ases/aeses` |
| `italiano` | 63 | `fad`, `sib`, `dobsb`, `dodsd`; no French `ré` or `dox` alias |
| `english` | 105 | `cs`, `bf`, `ctqf`, `ctqs`, `cx/css`, `c-flat`, `c-natural`, `c-sharpsharp` |
| `deutsch` | 67 | `h`, `b`, `asas/ases`, `asah/aseh`; retained compatibility `aeh`, `eeh` |

All four include natural, sharp/flat, double and quarter-tone spellings present
in that reference. Language-name aliases from other catalogs are not silently
mapped onto one of these four. Unknown languages keep ambiguous pitch words
neutral. `initialNoteLanguage` defaults to `nederlands`, also for a standalone
`.ily` without a directive. An include may change the convention: local pitch
classification becomes uncertain until another local `\language` directive.
There is no inherited/cross-file convention resolver. UI EN/IT is unrelated.

To update catalogs, review the chosen upstream release's four complete entries,
including alternative and compatibility spellings. Update version/attribution,
the membership counts and independent positive/negative tests, then regenerate
and run the language gates. Network access is not part of runtime or generation.

Block comments follow the
[`v2.26.0` lexer](https://github.com/lilypond/lilypond/blob/v2.26.0/lily/lexer.ll):
`%{` inside a block comment does not nest; the first `%}` closes it. Music-mode
comments do not inherit Scheme's comment rules.

### Scheme reader and embedded music (LY08)

`scheme-tokens.mjs` supplies bounded tokens to the same grammar and context
tracker as music. It never evaluates Guile. `#`, `$`, `#@` and `$@` introduce
exactly one datum after reader trivia. `#(define ...)` is a LilyPond introducer
plus a Scheme list; `##t` is an introducer plus a Scheme boolean. `#red` retains
the Scheme role and `#12.5` retains the number role, including their introducers.

Qualified forms:

- Parenthesized lists and dotted pairs; vectors `#(...)` inside Scheme.
- Bare delimiter-separated symbols, `#t`/`#f` (also uppercase), quote, quasiquote,
  unquote and unquote-splicing. Apostrophe, backtick and comma dispatch quotes
  only at datum start; inside an atom they remain part of that atom. Character
  names and numeric dispatch use the same complete-atom boundary for validation.
  Quote arity is parsed, not evaluated.
- Signed decimal integers, decimal fractions, rational numbers and exponents
  (`e/s/f/d/l`, either case). Numeric reader prefixes accept one radix
  (`#b/#o/#d/#x`) and one exactness (`#e/#i`) in either order. Prefix spelling and
  radix digits are checked for atoms up to 256 units. Non-prefixed long atoms
  retain their initial chunk's symbol/number highlighting through their actual
  delimiter; this is lexical styling, not validation of a numeric value.
- Escaped, possibly multiline Scheme strings. Parentheses and `#{`/`#}` in them
  cannot close lists or open/close music.
- Characters `#\)` and other single characters (including Unicode scalars),
  `#\xHEX` through U+10FFFF excluding surrogates, and the names `space`,
  `newline`, `tab`, `return`, `nul`, `alarm`, `backspace`, `delete`, `escape`.
- `;` line comments, nested `#|…|#`, non-nesting Guile `#!…!#`, and `#;` datum
  comments. `#;` consumes reader trivia followed by one complete datum. Thus
  `(#; #; a b c)` contains only `c`. `%` is a Scheme symbol character.

`MusicLiteral(MusicLiteralOpen, …, MusicLiteralClose)` represents actual
`#{…#}` music, including ordinary HP05 roles, nested Scheme and nested literals.
The closer is **two units, `#}`**, not `}`. LilyPond strings/comments protect it.
Recovery from a damaged inner music group can end at the actual `#}` while
retaining recovered certainty for that group/literal.

A literal inherits the entry note convention and known invocations, starts in
music mode, and restores its caller's mode, note convention and invocation
environment on exit. Local `\language` and include uncertainty affect its body
only. This note-language scope was checked with native LilyPond 2.26.0 / Guile
3.0.11. Discarded datums still have syntactic children for correct boundaries,
but their entire contents get the comment role and contribute no outline,
regions, symbols, references, includes or language-history effects.

#### Explicit conservative subset

`SchemeUnknown` quarantines its source through EOF with unknown certainty.
There is no reliable general closing delimiter for an unrecognized reader macro.
This includes typed vectors (`#vu8`, `#u8` and other typed arrays), keywords
`#:`, read-time evaluation `#.`, datum labels/references `#n=`/`#n#`, syntax-reader
dispatch such as `#'`, other custom `#` dispatch, unrecognized character names,
and **numeric-prefixed reader atoms longer than 256 units**. The latter may
start like a number and later turn into an unsupported dispatch; no suffix is
released into outer music. Guile square-bracket lists and bar-led/escaped symbol
reader conventions are also outside this qualification and stay unknown.
Malformed dotted tails use the same conservative fallback where no safe datum
boundary can be established.

Complex/polar/non-finite number spellings have no special numeric role; an
ordinary atom remains Scheme text. Reader-option changes, arbitrary Guile reader
extensions, evaluation, interpolation semantics and cross-file effects are not
inferred. Unknown means unsupported editorial knowledge, not a compiler error.

### Queries, limits and next steps

The adapter exposes `language`, `options`, `summarize`, `summarySteps`,
`contextAt`, `blockAtEnter` and `formatChanges`. Batch and scheduled summaries
share one tree visitor. Outline, region, symbol, reference and literal-include
records and arrays are frozen. A scalar assignment/include/version ends at its
own value; a context region includes the body after its optional `\with` block.
Generated labels carry translation keys/parameters and stable English fallbacks.

Simple invocable variable names up to 128 UTF-16 units are tracked in an immutable
bounded-depth radix trie. Longer, compound and non-invocable quoted names remain
in the outline/symbol records and are not guessed as command completions. Unknown
commands remain commands. A valid quoted `"melody"` and bare `melody` both produce
command symbols. Names come from syntactic name nodes; comments and recovery
debris do not enter the name. Damaged assignment heads produce recovered variable
records, not command suggestions, and do not establish a known invocation.
Query histories and recovery certificates are weakly
cached by immutable tree identity. A cold caret has a bounded inspection budget
and may return `certainty: "unknown"` until the cooperative summary is available.

Tokens are at most 256 UTF-16 units; long words, strings, comments and scalar
Scheme values use chunks. Fragment preparation is cooperative, recovered scopes
are excluded selectively, and reuse applies constant-size context effects or at
most 16 bounded leaf operations. It never scans an entire reused subtree in a
context callback. The shared 1,048,576-unit service/state guard applies to both
languages; larger documents return explicit unavailable syntax.

The context hash includes note language, persistent invocation state, reader
quote state, nested block-comment depth and the enclosing music-literal flag.
Reader/literal scopes restore their immutable entry frame. Pending nonliteral
include/language operations survive a Scheme expression and its reuse, then
invalidate the current convention when the directive reduces. Recovery-safe
fragment views retain healthy identities and exclude uncertain scopes; reuse
never traverses an entire subtree.

Cold queries and summary timelines apply a directive at its endpoint, after its
datum. A literal inside that datum inherits the convention in force before the
directive completes. Timeline events follow source-end order, including literal
restoration before a containing directive at the same offset. An enclosing
datum discard owns the comment context even when its child is unknown markup.

#### HP07 editing/consumer contract

- `SchemeExpression` contains its one/two-unit introducer, reader trivia, a datum,
  and a zero-width `SchemeFinish`. That finish is a parser handoff, **not a source
  closer to insert**. `SchemeList`/`SchemeVector` have their own parentheses;
  `SchemeQuote` and `SchemeDatumComment` own their following datum without an
  extra paired delimiter. `SchemeTail` owns a dotted tail.
- Use `MusicLiteral`'s direct opener/closer nodes for `#{`/`#}` plans. Its summary
  region has `kind: "group"`, `name: "MusicLiteral"`, raw `[from,to)`, certainty
  and `openEnded`. The two-unit delimiters are included in the region. Do not
  treat a literal as an ordinary brace group.
- Contexts use half-open ownership: the right-adjacent region wins, including
  immediately after `#}`. Open EOF lists, strings, block comments and literals
  retain context and conservative certainty. A closed scalar at EOF is complete.
  Exact means a qualified syntactic boundary, not successful Guile evaluation or
  LilyPond compilation. Recovery in unrelated siblings does not downgrade a
  healthy literal/group. Cold queries can return unknown when their budget ends.
- Comments and discarded datums override all descendant contexts and records.
  Do not select raw descendant music nodes for edit plans without checking the
  current query context. Symbols from actual literals are local to those literal
  regions; their presence in the flat symbol array is not a global binding.
  The tokenizer restores the caller's invocation environment on exit.
- Protect Scheme strings/comments, discarded datums and unknown spans from
  formatting/pairing. Suppress automatic structural edits for recovered/unknown
  contexts. Frozen summaries belong to the supplied tree/document, not to a file
  path or a previous editor revision.

HP07 owns full summary/completion/Enter migration. The editing methods still
return `null` and an empty frozen array. The highlighting factories install a
reusable guarded language, with no disposed summary owner or timer. Scoped
mounted lifecycle/contrast tests cover both languages and embedded music;
full-UI acceptance and mounted latency qualification remain HP08 work.
