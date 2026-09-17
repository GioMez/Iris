# Editor language support

## LilyPond parser delivery: HP05

The language service supports `loadLanguage("ly", options)` and
`analyze("ly", source, options)` for music, text and configuration. The editor
still uses the LilyPond stream highlighter while HP06 completes Scheme syntax.

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

HP06 must replace `SchemeOpaque(SchemeStart, SchemeText*, SchemeEnd)` with
qualified Scheme datum productions. Currently simple list/music boundaries are
quarantined, and unsupported reader dispatch keeps the remainder unknown rather
than exposing fake music or structure. `#{…#}` is opaque, not highlighted music.
This includes named dispatch such as `##vu8(...)` and `##u8(...)`; HP05 only
qualifies the complete scalar boolean dispatch `##t` / `##f`. An opaque include
or note-language argument invalidates the pitch convention when its directive
reduces. The pending operation survives the opaque argument and its reuse.
The LY08 corpus is reserved for that task. HP07 owns editing plans and consumer
migration; the current editing methods return `null` and an empty frozen array.
Mounted-browser timing and native/compiler qualification remain later gates.
