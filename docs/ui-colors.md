# Interface color contract

Iris 1.0.0 defines interface colors in `public/iris.css`. Choose tokens by
purpose: components use role tokens, and role definitions use named
`--palette-*` primitives. Keep syntax, status, category and action-label roles
separate even where they share a color.

The default root defines the dark palette. `:root[data-theme="light"]`
overrides primitives and derived roles while retaining shared component rules.
For user controls, see [theme selection](user-guide.md#sign-in-and-choose-your-workspace).

## Role families

| Roles | Use |
| --- | --- |
| `--bg`, `--editor-bg`, `--panel`, `--panel-2`, `--topbar` | Main surfaces. |
| `--preview-bg`, `--number-field-bg`, `--toast-bg`, `--thumbnail-bg` | Specialized surfaces. |
| `--txt`, `--txt-dim`, `--txt-mut`, `--provider-text` | Text hierarchy. |
| `--border`, `--border-soft`, `--line`, `--border-hover` | Dividers and control edges. |
| `--accent`, `--accent-press`, `--on-accent`, `--on-danger` | Filled actions and labels. |
| `--semantic-*`, `--category-*`, `--syntax-*` | Independent status, category and source colors. |
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

## Verification

```sh
node scripts/test.cjs test/ui-colors.test.js test/ui-theme.test.js test/ui-accessibility.test.js
node scripts/test.cjs --browser test/ui-visibility.browser.test.js
```

The literal scanner covers first-party runtime CSS/JS/HTML/SVG under `public/`
and `src/`, including inline styles, encoded SVG and fallback colors, with the
named exceptions above. Mutation cases exercise named colors, modern functions,
hex literals and interpolated fallbacks.

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
