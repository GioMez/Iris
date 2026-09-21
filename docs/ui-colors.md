# Interface color contract

Iris defines interface colors in `public/iris.css`. Choose tokens by
purpose: components use role tokens, and role definitions use named
`--palette-*` primitives. Keep syntax, status, category and action-label roles
separate even where they share a color.

The default root defines the dark palette. `:root[data-theme="light"]`
overrides primitives and derived roles while retaining shared component rules.
For user controls, see [theme selection](user-guide.md#sign-in-and-choose-your-workspace).

## Role families

HP08 measures every one of the 23 syntax roles on real parser-emitted source
spans, including selection and peer/search overlays: 2120 samples per theme,
minimum 4.582:1 dark and 4.708:1 light on Chrome 153/Windows. Matching/nonmatching
brackets and historical BibTeX/RIS paint also pass their mounted checks. These
results preserve the **4.5:1** contract; CSS swatches alone are not recognition
evidence. See [scope, raw results and outstanding gates](language-qualification.md).

The local-font continuation repeats the mounted role/reflow/theme checks with
Chrome 153.0.8010.53: 42 selected UI cases pass, with the same contrast minima.
The performance report now distinguishes actual syntax publication from later
paint observation; color qualification does not certify the separate 5/8 ms
feature-work budgets.

The final Linux nine-file browser aggregate passes 300/300, including UI
visibility 124/124. The peer audit now resolves the selector and samples its
connected node/styles atomically; absent pigments fail explicitly. It preserves
the 4.5:1 text/3:1 indicator assertions and palette. Earlier detached-node audit
failures remain historical, as detailed in the qualification report.

| Roles | Use |
| --- | --- |
| `--bg`, `--editor-bg`, `--panel`, `--panel-2`, `--topbar` | Main surfaces. |
| `--preview-bg`, `--number-field-bg`, `--toast-bg`, `--thumbnail-bg` | Specialized surfaces. |
| `--txt`, `--txt-dim`, `--txt-mut`, `--provider-text` | Text hierarchy. |
| `--border`, `--border-soft`, `--line`, `--border-hover` | Dividers and control edges. |
| `--accent`, `--accent-press`, `--on-accent`, `--on-danger` | Filled actions and labels. |
| `--semantic-*`, `--category-*`, `--syntax-*` | Independent status, category and source colors. |
| `--bibliography-*` | BibTeX/RIS entry type, key, field, value, comment, delimiter and operator colors. |
| `--permission-editor`, `--history-compile`, `--build-accent` | Editor permissions, compile-history reason and build metadata. |
| `--selection`, `--selection-tint`, `--selection-soft`, `--selection-line` | Selected controls and rows. |
| `--editor-selection`, `--editor-selection-idle` | Opaque local editor selections. |
| `--native-selection`, `--editor-match-active-bg` | Browser selection and current search result. |
| `--editor-match-bg`, `--editor-bracket-match-bg`, `--editor-bracket-error-bg`, `--editor-special-bg` | Opaque editor-relative decoration fills. |
| `--editor-focus-ring`, `--completion-detail-selected` | Editor focus and selected completion detail. |
| `--switch-track`, `--switch-thumb`, `--switch-track-active`, `--switch-thumb-active` | Switch states. |
| `--switch-compact-track`, `--switch-compact-thumb` | Compact footer switch. |
| `--scrollbar-thumb`, `--scrollbar-thumb-hover`, `--scroll-edge` | Scroll handles and overflow gradients. |
| `--shadow-color`, `--shadow-panel`, `--shadow-document`, `--shadow-card`, `--shadow-drawer` | Shadow pigments. |
| `--dialog-backdrop`, `--drawer-backdrop`, `--compile-backdrop` | Scrims and busy overlay. |
| `--brand-gradient-end`, `--brand-glow`, `--brand-glow-large`, `--topbar-sheen` | Brand/surface gradients. |
| `--peer-fallback`, `--region-fallback`, `--on-peer` | Peer defaults and initials. |
| `--peer-marker-edge`, `--peer-badge-edge`, `--peer-tree-edge` | Peer boundaries on light surfaces. |
| `--status-active-tint`, `--status-disabled-tint`, `--status-halo` | Admin status tints and build halo. |
| `--history-manual-selected` | Snapshot badge in a selected history row. |
| `--select-arrow` | Select chevrons. |

Derive a danger tint from `--semantic-danger`, for example
`color-mix(in srgb,var(--semantic-danger) 12%,transparent)`. A category tint
should use its category role, not a syntax role with a matching RGB value.
Selected history/build/sharing metadata uses `--txt-dim` to retain contrast on
the selected background.

## Overlay and editor rules

`--surface-overlay` supplies the neutral pigment: white in dark mode and black
in light mode. The shared strengths use fractions of 255:

| Roles | Alpha numerator |
| --- | --- |
| `--surface-disabled`, `--surface-subtle`, `--surface-control`, `--surface-raised` | 4, 5, 6, 8 |
| `--hover-subtle`, `--hover-soft`, `--hover-field`, `--hover` | 10, 12, 13, 14 |
| `--hover-medium`, `--hover-icon`, `--hover-strong` | 16, 18, 20 |
| `--grid-dot`, `--preview-grid-dot` | 10, 8 |
| `--skeleton-bg`, `--skeleton-shimmer` | 10, 11 |
| `--spinner-track`, `--spinner-provider-track` | 26, 38 |

Preserve these fractions in a role change: 6/255 means 2.352941%, not 2%.
`--surface-inset` uses the shadow pigment at 13/255. The action spinner uses
35% of `--on-accent`.

The mounted CodeMirror editor inherits root roles. Iris supplies content/gutter
surfaces, selections, cursors, brackets, special characters, completion and
diagnostic paint through CSS. Theme switching needs no editor-state transaction.
The root `color-scheme` controls native fields and scrollbars.

Use opaque editor-relative fills for peer selections, search matches and bracket
decorations so stacked translucent bands do not erase syntax contrast. Keep the
peer's marker and underline data-driven. The `--peer-selection-bg` derivation
must resolve on the peer element; a root derivation resolves before that peer's
custom property exists.

Bracket selectors include the host, editor and content classes to outrank the
enabled CodeMirror bracket extension. Contrast measurements must sample syntax
text inside a decoration and composite its ancestor backgrounds, rather than
using only the wrapper's inherited foreground.

Iris enables active-line gutter highlighting with transparent background and
`--txt-dim` text. Audit vendor paints when enabling an additional extension;
excluding vendor source from the literal scanner does not exempt mounted UI.

## Data and artwork exceptions

- **Document paper/ink:** PDFs, incoming images/SVGs and font specimens retain
  their document colors. `--document-paper` and `--document-ink` stay fixed across
  themes.
- **Peer colors:** `src/collab.js` assigns eight identity colors in `PEER_COLORS`.
  Missing values use the peer/region fallback roles. Neutral light-theme edges
  distinguish bright peer markers from their background.
- **Mask coverage:** the encoded `%23000` stroke in `--icon-alert-circle` defines
  coverage; the visible icon uses `currentColor`. Select chevrons use the
  `--select-arrow` role.
- **Brand assets:** `iris_logo.svg`, `iris_logo_w.svg` and `iris_text_logo_w.svg`
  retain artwork fills. The wordmark's CSS mask uses `--brand-wordmark`, while
  the image retains its dimensions and alt text.
- **CSS keywords:** `transparent`, `currentColor`, `inherit`, `none` and native
  control styling retain their browser meanings.

## Theme controller

`public/iris-theme.js` runs in the document head before the stylesheet and does
not depend on the body/app. It reads `iris_theme`, normalizes unknown values to
`system`, and sets `html[data-theme]` plus inline `color-scheme`.

```js
IrisTheme.preference();           // "system" | "dark" | "light"
IrisTheme.resolved();             // "dark" | "light"
IrisTheme.setPreference("light"); // apply and attempt local persistence
```

One `matchMedia('(prefers-color-scheme: dark)')` listener follows OS changes in
System mode. Manual overrides take precedence. If browser storage fails, the
controller keeps the current page's choice in memory. The settings field updates
on change, settings entry and language refresh, outside project persistence.

## Source syntax roles (HP02)

`public/iris-syntax-style.mjs` exports one shared set of CodeMirror tags. Import
this module and CodeMirror through the same native-ESM graph. Node tests must
use `import()` for `@lezer/highlight`, `@codemirror/language` and editor state
when they consume these tags; mixing CommonJS and ESM duplicates identities.

| Export | Contract |
| --- | --- |
| `syntaxTags` | Frozen role-to-tag table; one tag per role in the palette below. |
| `syntaxClasses` | Frozen role-to-class-string table. Each string includes `t-<role>`. Command, environment, delimiter and operator also include their compatibility class. |
| `legacyTokenTable` | TeX/LilyPond stream names: `cmd → command`, `env → environment`, `brace → delimiter`, `math → math`, `comment → comment`, `special → operator`, `string → string`. |
| `bibliographyTokenTable` | Separate frozen tags for `entryType`, `key`, `field`, `value`, `comment`, `brace` and `special`. Use this table for BibTeX/RIS streams. |
| `roleHighlighter` | Semantic mapper for the 23 source tags: returns bare names such as `command`, `pitch`, `duration` and `rest`. It has no bibliography mappings. |
| `cssHighlighter` | Rendering mapper for source `syntaxClasses` and bibliography aliases, including compatibility classes. |
| `syntaxExtension` | Ready-to-use `syntaxHighlighting(cssHighlighter)` extension. |

The editor imports the module from the local server and installs the extension
with the appropriate stream table. Plain source text inherits `--syntax-text`
from `.cm-content`; it needs no tag. LilyPond quoted strings now emit `string`,
including escapes, multiline content and incomplete input.

Semantic consumers pass `roleHighlighter` to Lezer's `highlightTree()` and use
the callback's role string directly. For a single source tag,
`roleHighlighter.style([syntaxTags.command])` returns `"command"`, while
`cssHighlighter.style([syntaxTags.command])` returns `"t-command t-cmd"`.
`roleHighlighter.style()` returns `null` for unmapped tags, including bibliography
tags. Untagged text produces no semantic callback; callers can keep their plain
text default. Semantic consumers need no CSS-prefix stripping or compatibility
class decoding.

### Initial palette

Each role has a `--syntax-<role>` variable and a `.t-<role>` class. The table
groups roles that share an initial primitive. Ratios show the lowest WCAG
contrast against the editor background, active selection and idle selection,
computed from the checked-in CSS. These Node measurements do not qualify
browser compositing or future parser output.

| Roles | Dark | Light | Min dark | Min light |
| --- | --- | --- | ---: | ---: |
| command, structure | `#8fbdff` | `#1557a0` | 6.335 | 5.832 |
| environment, context, rest, property | `#c7adff` | `#65358e` | 6.312 | 6.901 |
| definition, variable, reference, citation, path, scheme | `#7dcfff` | `#006079` | 7.121 | 5.740 |
| string, literal, lyric, operator, articulation | `#e0af68` | `#694500` | 6.109 | 6.904 |
| math, pitch | `#9ece6a` | `#245629` | 6.684 | 6.943 |
| number, duration | `#ff9e64` | `#843a16` | 6.007 | 6.516 |
| comment | `#b3b6bf` | `#59616c` | 6.027 | 5.052 |
| delimiter | `#d0d3da` | `#343e4b` | 8.151 | 8.741 |
| text (inherited) | `#c8cee8` | `#242c40` | 7.824 | 11.216 |

Structure and definition use weight 600; other roles use 400. Syntax rules add
no text opacity or underline. Neutral delimiters are more prominent than
comments. Syntax-only blue, purple, cyan, comment and delimiter primitives let source
colors change without recoloring action/status controls or document paper/ink.
Node checks also composite the existing 9% peer caret line over active and idle
selection, using the fixed peer palette, fallback and white stress case. The
lowest ratio across those combinations is **4.582:1 dark / 4.711:1 light**.
The mounted qualification above confirms the corresponding emitted-token paint.

HP02 originally prequalified the full vocabulary with **palette-only** swatches
while the streams emitted a smaller role set. The implemented language adapters
now emit all 23 syntax roles, and HP08 checks their real mounted spans. Swatches
remain separate evidence for weights, role propagation and composed backgrounds,
including the eight peer colors, fallback and white stress case. User-source
corpus and subjective visual acceptance remain follow-ups.

### Bibliography compatibility

BibTeX/RIS keep their existing meanings and initial paint through explicit
aliases. Shared names such as `comment`, `brace` and `special` also use separate
bibliography tags so source palette changes cannot leak into them.

| Stream name | Explicit class | Retained class | Role / primitive |
| --- | --- | --- | --- |
| `entryType` | `t-bib-entry-type` | `t-cmd` | `--bibliography-entry-type` / `--palette-blue` |
| `key` | `t-bib-key` | `t-env` | `--bibliography-key` / `--palette-purple` |
| `field` | `t-bib-field` | `t-special` | `--bibliography-field` / `--palette-red` |
| `value` | `t-bib-value` | `t-math` | `--bibliography-value` / `--palette-green` |
| `comment` | `t-bib-comment` | `t-comment` | `--bibliography-comment` / `--palette-comment` |
| `brace` | `t-bib-delimiter` | `t-brace` | `--bibliography-delimiter` / `--palette-bracket` |
| `special` | `t-bib-operator` | `t-special` | `--bibliography-operator` / `--palette-red` |

The bibliography rules follow compatibility rules in the stylesheet and take
precedence when a span has both classes. Existing `--syntax-bracket`,
`--syntax-argument`, `--syntax-special` and legacy classes remain available to
older consumers.

## Verification

```sh
node scripts/test.cjs test/ui-colors.test.js test/ui-theme.test.js test/ui-accessibility.test.js
node --test test/editor-stream.test.js test/ui-theme.test.js test/ui-colors.test.js test/language-fixtures.test.js test/codemirror-vendor.test.js test/syntax-style.test.js
node scripts/test.cjs --browser test/ui-visibility.browser.test.js
```

The literal scanner covers first-party runtime CSS/JS/MJS/HTML/SVG under `public/`
and `src/`, including inline styles, encoded SVG and fallback colors, with the
named exceptions above. Mutation cases exercise named colors, modern functions,
hex literals and interpolated fallbacks. A filesystem regression checks nested
`.mjs` traversal, and ESM regressions apply the JS paint rules to `.mjs` files.
The scanner keeps its Windows/POSIX artwork and peer exceptions local.

Browser checks measure current role propagation, focus, selected metadata,
syntax and layered peer/search/bracket colors. They exercise head initialization,
blocked storage, OS changes, reload persistence, EN/IT controls, editor identity
and PDF reading position in both themes. No check needs historical Git objects.

Thresholds are 4.5:1 for ordinary text/syntax and 3:1 for required UI/focus
indicators. Disabled controls, grid dots, scrims and shadows are exceptions for
inactive/decorative paint. Peer checks cover the fixed server palette, fallback
and a white-peer stress case. They do not qualify arbitrary externally supplied
identity colors. See [Development](development.md#browser-and-native-gates) for
browser scope and [measurement tokens](ui-measurements.md) for layout rules.
