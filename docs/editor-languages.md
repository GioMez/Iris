# Editor language support

**Qualification (21 September 2026):** the final gate-v2 matrix and selected strict
5/8 ms profiles pass. All 300 normal 1 MiB edit publications, including warmups,
meet 500 ms (maximum 407.3 ms). Linux full Node, covering, browser, native and
navigation gates have run with their recorded source scopes; the final query-only
optimization has separate 208/208 coverage. User-source/subjective acceptance
remains a follow-up. See [qualification](language-qualification.md) for hashes,
platform versions, invocation counts and historical results.

## LaTeX support (TX01–TX09)

| Cases | Editorial support |
| --- | --- |
| TX01 | Control words/symbols, escapes, comments, nested groups and optional arguments |
| TX02–03 | Inline/display math and catalogued math environments; internal commands, numbers/operators, comments and nested text/math |
| TX04 | `verb` and catalogued verbatim/listing/comment/filecontents bodies, with construct-specific boundaries |
| TX05–06 | Seven heading levels, nested/multiline titles, custom literal environment names and recovery |
| TX07 | Classic/xparse/primitive definitions, with deferred bodies excluded from document structure |
| TX08 | Signature-based labels/references/citations/paths and literal includes |
| TX09 | Standard, internal `.sty/.cls`, `makeatletter` and expl3 lexical profiles |

Arbitrary catcodes, macro expansion, dynamic names and executed conditional
branches are not inferred. Unknown commands remain editable generic commands;
unsupported or incomplete contexts are conservative rather than compiler errors.
Both adapters supply structural bracket metadata, including musical/Scheme
delimiters, to CodeMirror's existing matching decoration.

## Shared editor consumers: HP07

The editor installs one `createLanguageState` owner for its current TeX or
LilyPond document. Highlighting, outline, region presence, completion and edit
plans use that owner's CodeMirror language/tree. BibTeX and RIS keep their stream
languages and bibliography policies.

### Editor API and lifetime

- `IrisEditor.syntaxSnapshot()` returns a frozen snapshot or `null` for a document
  without a TeX/LY owner. Its `revision` equals `IrisEditor.snapshot().revision`.
- `IrisEditor.onSyntax(fn)` follows the existing event-registration convention.
  Listeners receive partial/ready/unavailable snapshots and `null` on retirement.
  Parser progress can publish a better summary without changing text revision.
- `load(content, kind, {path})` resets file metadata and creates a new generation.
  `loadCollab(content, kind, {version, path})` also replaces the generation;
  a resync that omits path retains the current metadata.
- `setLanguage(kind, {path})` changes language/profile in place, preserving text,
  revision, selections, bookmarks, history and collaborative version. `.sty` and
  `.cls` select the internal TeX profile; `.tex` uses standard. Source profile
  toggles still apply. App open, rename, restore, refresh and prepared source
  navigation pass this metadata through the collaboration client. Included files
  stored with generic `kind: "file"` use the same extension-derived language for
  the outline and Format action.
- Replacement disposes the old owner and rejects its queued publications.
  Same-kind profile replacement closes pending and installed completion. Accepted
  project replacement retires the source owner even for an image-active target;
  a same-project image preview retains its source document. App consumers also
  check the project/file association recorded at source load.
  CodeMirror's phrase-only view redraw can destroy/remount the plugin in one
  turn: retirement waits until the next microtask so this redraw retains the
  owner and published snapshot. EN/IT changes translate labels at render time;
  they do not select a pitch convention or advance text revision.

Headless consumers call `owner.update(state)` to commit a new document state.
`read` can start an idle owner; subsequent speculative/historical reads and
context queries cannot adopt a different document or cancel its current job.
The owner accepts initial `revision` and `generation` scheduler hooks. The
headless `identityEffect` increments both identity revision and generation;
the editor instead seeds each replacement owner from its text-revision field.

The owner publishes real prefix/full trees through public CodeMirror APIs.
Verified prefix roles paint before full coverage; a partial tree is never extended
or labelled ready merely to refresh highlighting. For browser sources of at least
32,768 UTF-16 units, a local bundled Worker constructs the full tree using the
same generated grammar, tokens, contexts and recovery rules. Small sources and
Node/headless owners retain cooperative parsing. Full publication triggers a
parse-only view update and a fresh summary. The normal 1,048,576-unit support
limit remains unchanged.

Revision/generation replacement, disposal and the size guard cancel work. Worker
asset/load/protocol failures or deadlines yield explicit unavailable syntax
(`limitReason: "worker-unavailable"`), while editing remains available. Source
windows and tree decoding are cooperative; transferred trees retain real Lezer
nodes, compact buffers, local highlight/bracket props and supported dynamic props.
A bounded owner/configuration-scoped history supports exact undo and validated
incremental restoration. Cold and changed-content restores still require real
parsing. The guarded main Input keeps four 4096-unit random-access windows; a
fresh small prefix avoids preparing a whole transferred tree on the UI thread.
The initial prefix target survives an early zero/short stopped tree. Owned 5 ms
turns continue real prefix parsing while full Worker work is pending; viewport
growth can request coverage up to the existing 3000-unit main-prefix bound.
EOF/replacement/disposal retires pending prefix work. Beyond that bound, far or
long-line viewports wait for Worker coverage rather than starting a full UI parse.
The 5 ms parsing/query and 8 ms application budgets have passing final strict
diagnostics. Earlier overruns remain historical evidence; finite measurements
are not a hard real-time guarantee for arbitrary input or browser GC.

The outline uses full semantic levels and caps visual indent at four levels.
`IrisStructure.fromRegions(regions, length)` preserves names, certainty and
translation metadata, normalizes `heading` to `section`, and uses `[from,to)`
ownership. Only `openEnded` regions include their EOF endpoint. During pending
analysis the app disables stale outline links and suspends structural presence;
line proximity remains the conservative fallback. EN/IT outline status text
distinguishes partial analysis from the oversized unavailable state.
Peer notification identity includes UTF-16 anchor/head offsets, so same-line
boundary crossings and mapped edits refresh structural presence.

### Completion and project summaries

`iris-language-completion.mjs` exports `createProjectCache`, `createSource`,
`fileOptions` and the context-based curly-pair policy. The source returns a
Promise, observes CodeMirror aborts, and rechecks active document and cache
identity after cooperative work. It uses catalog argument roles, exact summary
symbols, generic builtins, project custom commands and BibTeX keys. Names in
actual musical literals remain local to those literal regions, including their
open EOF. Scalar references preserve comma-containing keys; list references and
citations exclude already-used entries. A quoted lyric has the `string` argument
role even though its highlighting mode is `lyrics`.
Context-name completion also works in an unfinished `\new`/`\context` header.
Context queries expose optional `argumentFrom/argumentTo` and
`commandFrom/commandTo` raw UTF-16 spans. Arguments exclude delimiters; a `null`
end marks an uncertified partial-tree cutoff. Completion supplies `[from, caret)`
as CodeMirror's matching range, keeping its native prefix/fuzzy filtering. Each
option's `apply` callback uses the separately captured full target span, including
the suffix to the right of the caret. Scalar keys retain internal whitespace/commas, and list separators remain
outside the edit. Queries decline argument containers above 2,048 units or
individual targets above 1,024 units. Header comments cannot enter a replacement.
Bibliography key extraction yields while reading long keys and does not truncate
them to the chunk size.

Empty leading, trailing and consecutive list slots leave adjacent commas intact.
At acceptance, the callback checks document/owner identity, project scope,
selection, readonly/composition state and matching coordinates. It uses
CodeMirror's `insertCompletionText` and `pickedCompletion` annotation in one
isolated history transaction. Completion of pending project analysis alone does
not invalidate a displayed builtin; the source's publication-time cache checks
still apply.

`CompletionResult.map` discards an installed result on any document change,
including an edit outside its matching range. Empty mappings preserve it. Normal
typing can request a fresh result through CodeMirror's completion lifecycle.
If an apply guard rejects an option that is still in the popup, the callback
closes that popup without editing source. A discarded callback cannot close a
newer result. This prevents stale completion from repeatedly consuming Tab/Enter.

The editor waits for the next syntax publication or a 250 ms fallback, using
exact records inside the available prefix. `cache.read(scope, signal, wait = Infinity)`
adds an optional wait budget; browser completion requests 250 ms and then uses
available project summaries. Abort and identity checks still apply.
Builtins/custom commands therefore remain available while other analysis is
pending. Reopening completion picks up subsequently analyzed symbols.

The shared project cache keys its lifetime by project ID and load generation;
entries compare path, file ID, kind, revision and content. File extension fixes
the initial TeX options. It excludes generated/deleted/error files and the active
path, whose symbols come from the live editor snapshot. Each changed non-open
file starts in a later task, with one cooperative analysis in flight. Unchanged
files reuse immutable summaries; the cache retains no Lezer trees. Replacement,
deletion and project closure abort obsolete work. Completion symbol collection
also yields in 8 ms turns. Cache refresh visits at most 4,096 project nodes and
skips sources above the shared analysis limit.

`iris-completion.js` now contains only the CommonJS/browser custom-command
normalizer. Server callers require no CodeMirror imports. The obsolete
`iris-latex.js` and `iris-lilypond.js` scanners and their HTML script entries
have been removed; callers use the service rather than compatibility parsers.

### Safe edits and bounds

Both language `editing.mjs` modules export `blockAtEnter(tree, doc, pos)` and
`formatChanges(tree, doc, range = null)`. Enter plans recognize complete openers,
including open EOF blocks, and reserve missing same-name outer closers. Inline
pairs expand their existing closer; a reserved outer closer also requires an
inserted inner close, including multicursor plans. A comment after a real opener
on the same line remains supported; comment-only fake openers do not produce plans. A
verbatim opener can complete its environment; its body stays protected.
Musical literals insert `#}`, and `SchemeFinish` supplies no source closer.

The editor plans multiple cursors from right to left with updated temporary
states and actual composed ChangeSets. Explicit parser requests share a 5 ms
budget for the command, then fall back to newline/current indentation. Queries bound
the line window to 1,024 units, inherited indentation to 256 units, and ancestor
walks to 256 nodes. Curly pairing checks escape parity in a 256-unit window and
does not insert ordinary `{}` after `#`. Read-only and composition guards apply
to automatic edits, and existing brace markers govern overtype/backspace.
Enter declines environment names longer than 64 UTF-16 units; syntax analysis
and outline extraction retain their existing long-name support.

`IrisEditor.format(expectedSnapshot?)` applies ordered indentation changes via
the existing revision/text guard and an isolated history transaction. It returns
`applied`, `unchanged`, `stale`, `readonly` or `unavailable`. The formatter preserves
non-indentation bytes, including CRLF, blank lines and trailing whitespace; it
protects literal, multiline string and Scheme bodies. During native composition
it returns `unavailable` without changing text or revision. It declines recovered
or incomplete structural trees. Synchronous formatting is limited to 65,536 UTF-16
units, 4,096 lines, 32,768 visited nodes and an 8 ms planning deadline, with visual
indent capped at 64 nesting levels (128 spaces). Larger sources remain editable
with syntax support up to the shared 1,048,576-unit analysis limit.
Internal unsafe-tree, line/node-cap and deadline declines return an empty plan
and therefore `unchanged` / “No safe indentation changes.” Outer size, coverage
and IME checks return `unavailable`. Neither path applies a partial format plan.

These are functional/work bounds, not hard elapsed-time guarantees. HP08's
synthetic native subset and mounted heap/lifecycle checks are recorded in the
[qualification report](language-qualification.md), with passing latest gates,
their exact source scopes and the remaining user-acceptance follow-up.

## LilyPond parser delivery: HP06

The language service supports `loadLanguage("ly", options)` and
`analyze("ly", source, options)` for music, text, configuration and embedded
Scheme. The editor installs guarded Lezer highlighting through its document
owner. `iris-lilypond-highlighting.mjs` also offers a standalone guarded factory.
The guard runs before LR startup and permits
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

HP07 implements summary/completion/Enter migration and the editing methods
described above. Standalone highlighting factories install a reusable guarded
language without a summary owner or timer. Scoped mounted lifecycle/contrast
tests cover both languages and embedded music. HP08 records final passing gates
and preserves earlier failures as history; subjective user acceptance remains external.
