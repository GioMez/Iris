# Custom highlighting: architectural assessment

Status: proposal for a possible follow-up after HP-08, not an implemented user
feature. Requested on 17 September 2026 while building the language services.

## Conclusion

The architecture supports custom syntax palettes and themes. HP-02 separates
named syntax roles, shared highlight tags, CSS classes and color variables.
Changing a color can therefore update CSS without reparsing the document,
replacing the editor, or modifying its undo history.

Custom command appearance also fits the architecture, but needs a separate
context-aware rule layer. Declaring the meaning of command arguments requires
language-catalog extensions. A display preference must not silently change
outline, completion, collaborative regions or editing behavior.

There is no additional runtime change required now solely to keep this feature
possible. The shared parsers, context queries and consumer/lifecycle integration
are implemented through HP-07. [HP-08 qualification](language-qualification.md)
records passing final edit/viewport/publication and strict feature profiles,
with Linux gates and their source scopes documented. User-source and visual
acceptance remain follow-ups. A future HP-09 needs
its own approved scope.

## Existing foundations and remaining work

| Foundation | Available or planned | Future work |
| --- | --- | --- |
| 23 named roles plus ordinary text | Implemented in `iris-syntax-style.mjs` and `iris.css` | Theme data, settings controls, preview and persistence |
| Independent bibliography colors | Implemented with separate tags and `--bibliography-*` | Decide whether bibliography customization belongs in the first release |
| System/light/dark preference | Implemented, browser-local | Syntax preset selection and per-role overrides |
| Custom completion lists | Implemented, shared in project settings | Exact-name appearance rules and optional argument signatures |
| Language-specific catalogs and tree contexts | Implemented in HP-04 through HP-07 | A validated extension format for the supported kinds of declarations |
| Normalized adapter options, document identities and cancellation | HP-03 foundation, integrated by HP-07 | Include rule-configuration identity when configuration becomes mutable |

## 1. Colors and themes

Use the stable role vocabulary: `command`, `structure`, `environment`, `context`,
`definition`, `variable`, `reference`, `citation`, `path`, `string`, `literal`,
`lyric`, `math`, `pitch`, `number`, `duration`, `rest`, `operator`, `articulation`,
`comment`, `delimiter`, `property`, `scheme`, plus inherited `text`.

Apply overrides to `--syntax-<role>`, not to global primitives such as
`--palette-green`, which also serve application states and categories. Keep
compatibility classes such as `t-cmd` out of the persisted format.

A theme can provide separate light and dark variants. `system` chooses the
resolved variant; it does not require a third palette. Missing role values
inherit from the selected built-in base. A missing variant falls back to Iris
for that mode rather than applying a dark foreground to a light surface.

Illustrative future format, not accepted by the current application:

```json
{
  "format": "iris-syntax-theme",
  "schemaVersion": 1,
  "id": "personal-reading",
  "name": "Personal reading",
  "basePreset": "iris",
  "variants": {
    "dark": { "roles": { "command": "#8fbdff", "comment": "#b3b6bf" } },
    "light": { "roles": { "command": "#1557a0", "comment": "#59616c" } }
  }
}
```

Start with normalized opaque sRGB colors and known role names. Iris should own
the generated classes and properties; a theme need not contain CSS selectors,
URLs, JavaScript or parser callbacks. A single-name custom color would require
an additional bounded collection of named display styles, rather than adding
an unbounded set of parser tags.

Custom editor backgrounds would expand the scope: selection and overlay colors
must remain coherent. CSS aliases defined at the root do not necessarily
recompute when only a descendant's `--editor-bg` changes. The initial proposal
therefore targets syntax palettes on the existing editor backgrounds.

## 2. Preference scope and persistence

Recommended precedence:

1. Resolve the user's system/light/dark choice.
2. Choose the explicitly selected personal syntax preset, otherwise an available
   project default, otherwise Iris.
3. Apply explicit personal overrides for that mode and role.

Personal display preferences can remain browser-local, following `iris_theme`,
with an in-memory fallback. Read-only project members should still be able to
choose their personal palette. Account-synchronized preferences would require
separate storage and API work.

Shared command signatures belong to project metadata so collaborators agree
about document structure. Preserve the existing completion-only `customCommands`
format; do not infer a semantic declaration from an old list entry.

Project settings must be added to client snapshots, server normalization and
the existing `.iris/project.json` archive manifest. The current import contract
does not make an arbitrary `.iris/highlighting.json` file a supported extension.
Personal theme export can use a dedicated JSON format; importing a project must
not overwrite the browser's personal choice.

Version theme data and command-rule data independently. Normalize known fields,
check duplicate rules and define size/count/name limits. Missing roles in older
themes inherit current defaults. Explain unsupported keys or incompatible
schema versions instead of applying ambiguous partial settings.

## 3. Custom commands: three distinct capabilities

### Completion

The existing setting suggests names. It does not teach the parser what their
arguments mean. Unknown but valid control words already receive a generic command
role. The completion name validator is not a universal lexer: TeX profiles and
LilyPond have different rules for punctuation, Unicode and starred forms.

### Appearance by exact name

A future rule may select a language, exact case-sensitive command name, eligible
contexts and a display role. `foo`, `Foo` and `foobar` remain distinct. Apply the
rule to a recognized command node, not a substring or arbitrary regex scan.

`styleTags` sees node types/paths and a highlighter receives tags; neither receives
the spelling of every command. Per-name appearance therefore needs a tree query
and presentation decorations, or an existing catalog classification where that
classification is already semantically correct. A color table alone cannot
distinguish two generic `ControlWord` nodes.

Keep these decorations viewport-aware and update them on text, tree, viewport
or rule changes. Respect comments, literals, strings, TeX profiles and Scheme
boundaries. With absent or uncertain context, retain base styling.

### Argument signatures and structural behavior

Making `\myref{key}` offer label completion requires a supported declaration of
its arguments and roles. Making a custom command act as a heading, enter music
mode or insert a closer requires a stronger structural declaration and tests.

Setting `displayRole: "definition"` must not create a symbol definition. Setting
`displayRole: "structure"` must not create an outline entry. Neither a custom
color nor a completion list can override comment/literal boundaries, evaluate
TeX macros or execute Scheme. Arity found in a definition does not prove that an
argument is a citation, heading or music expression.

Prefer a first command-customization release limited to exact-name appearance
and supported argument signatures. Evaluate structural extensions separately.

## 4. Cache, lifecycle and worker compatibility

| Change | Invalidate | Retain |
| --- | --- | --- |
| Palette values | CSS rendering and preview measurements | Parser, tree, summaries, document revision |
| Appearance rules | Matching decorations | Structural tree and summaries |
| Query-only signatures | Dependent summaries, argument contexts and completion | Tree if grammar interpretation is unaffected |
| Lexical/structural declarations | Adapter, incompatible fragments and derived results | Document, undo and collaboration session |

Use canonical configuration identity when rules become mutable, distinct from
their schema version and the text revision. Create immutable adapter/configuration
instances and cancel obsolete jobs. Include relevant options/catalog identity
in parser-fragment reuse and analysis caches; never include colors or UI locale
in parser keys. Bound the cache if user-defined configurations make its key space
larger than today's fixed profiles.

The declarative formats can cross a worker boundary. Send names, options,
configuration identity, request/document identity and UTF-16 ranges; never use
numeric Lezer term IDs or `Tag` object identity as a cross-thread protocol.
The current native tree/Source objects require an explicit transfer strategy.
Module workers also need locally resolvable dependencies: the document import
map alone does not provide worker module resolution.

The measured large-file limitations and analysis-size policy belong to the
base language architecture. Theme customization neither fixes nor worsens that
limit when color updates remain CSS-only.

## 5. Preview, acceptance and verification

Provide a live preview with both languages, both modes, currently supported
roles and actual selection/search/bracket/presence layers. Show the lowest
contrast ratio and affected combination. Iris's built-in qualification target
is 4.5:1; decide explicitly in the future specification whether users may apply
personal values below that target. Imported values must not be silently changed.

Reset should distinguish a role override, all personal overrides, the chosen
preset and shared rules. Cancelling a preview should restore the previous display
without touching document text. Perceptual checks should include command/text,
comment/delimiter, string/environment, pitch/duration and pitch/rest.

Meaningful tests for a future HP-09:

- Theme changes preserve editor identity, selection, history, PDF position and
  collaboration revision, and trigger no parse work.
- Theme data round-trips; missing fields inherit; reset, inaccessible storage,
  mode changes and unsupported schema versions have defined outcomes.
- Appearance matches exact names only in allowed language contexts, including
  protected literal/comment regions and nested Scheme/music.
- Signature changes invalidate old analysis even with identical source text;
  results from another project/configuration cannot install late.
- Project export includes shared settings and preserves private browser choices.
- All custom palette measurements use effective mounted backgrounds.

## 6. Likely implementation surface after HP-08

- `public/iris-theme.js`, `iris.css`, settings markup/controller and EN/IT locales:
  selection, preview, reset, persistence and application of palettes.
- A dedicated data-only validator/theme model, importable by the server for
  shared fields without importing CodeMirror.
- Language catalogs and query modules, plus a small appearance-decoration
  extension, for exact-name rules and supported signatures.
- `iris-language-service.mjs`, `iris-language-state.mjs` and completion caches:
  configuration identity only where analysis depends on it.
- Project snapshots, server settings validation and archive tests for shared
  declarations; dedicated JSON import/export for personal themes.
- `docs/ui-colors.md` and the language support documentation: public format,
  inheritance, supported rule semantics and contrast expectations.

This is an extension assessment, not a commitment to an arbitrary plugin system
or an implementation ahead of the current parsing work.
