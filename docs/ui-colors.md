# Interface color contract (R8)

Iris `1.0.0-beta2` defines interface colors in `public/iris.css`. Choose a token
by its purpose. Components consume role tokens; role definitions consume named
`--palette-*` primitives. Keep syntax, status, category and action-label roles
separate even when they share a primitive.

R8 supplies the dark palette and the abstraction for R10. A future theme can
override primitives and derived roles without copying component rules.

## Inventory

Audit base: `9b206d18f9e9710e7113843defed52f3f6c32e81`. Scope: first-party
runtime CSS, JavaScript, HTML and SVG under `public/` and `src/`, including inline styles,
encoded SVG colors and collaboration fallbacks. Exclude `public/vendor/` and
the prototype `public/Iris Wireframes.html`.

Counts represent occurrences, not distinct RGB values. The baseline CSS had
252 plain hex/functional literals and two encoded SVG literals, for 254 total.
Its initial color-token block contained 34 of those literals.

| Path | Baseline literals | R8 literals | Classification |
| --- | ---: | ---: | --- |
| `public/iris.css` | 254 | 48 | 47 palette definitions and one mask stroke |
| `public/iris-app.js` | 1 | 0 | Tree/outline peer fallback now consumes `--peer-fallback` |
| `public/iris-editor.js` | 2 | 0 | Peer and region fallbacks now consume CSS roles |
| `public/Iris.html` | 0 | 0 | Runtime markup uses component styles and inherited icon colors |
| Other first-party runtime JS | 0 | 0 | No color literals found |
| `public/iris_logo.svg` | 6 | 6 | Brand illustration fills and gradient stops |
| `public/iris_logo_w.svg` | 1 | 1 | Named `white` brand fill |
| `public/iris_text_logo_w.svg` | 4 | 4 | White wordmark paths |
| `src/collab.js`, `PEER_COLORS` | 8 | 8 | Server-assigned peer identity data |
| Other `src/` modules | 0 | 0 | No server-generated UI color literals found |
| **Total** | **276** | **67** | **No unclassified runtime UI literals** |

The two `&#8203;` occurrences in `iris-app.js` are empty-source HTML entities,
not colors. A raw hex search counts them unless it excludes entities.

Reproduce the numeric/encoded CSS count with:

```sh
git show 9b206d1:public/iris.css | rg --count-matches '(#[0-9a-fA-F]{3,8}\b|%23[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))'
rg --count-matches '(#[0-9a-fA-F]{3,8}\b|%23[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\))' public/iris.css
node --test test/ui-colors.test.js
```

The contract test checks declaration values, JS fallback strings, inline
styles and SVG paint attributes. Its mutation examples include named colors,
modern color functions, hex, template-interpolation fallbacks and encoded SVG.
It exempts the three named brand assets, the exact alert-mask stroke and the
server's `PEER_COLORS` data array.

## Role families

| Roles | Use |
| --- | --- |
| `--bg`, `--editor-bg`, `--panel`, `--panel-2`, `--topbar` | Existing main surfaces |
| `--preview-bg`, `--number-field-bg`, `--toast-bg`, `--thumbnail-bg` | Specialized surfaces |
| `--txt`, `--txt-dim`, `--txt-mut`, `--provider-text` | Interface text hierarchy |
| `--border`, `--border-soft`, `--line`, `--border-hover` | Dividers and control edges |
| `--accent`, `--accent-press`, `--on-accent`, `--on-danger` | Filled actions and their labels |
| `--semantic-*`, `--category-*`, `--syntax-*` | Independent status, category and source-color roles |
| `--permission-editor`, `--history-compile`, `--build-accent` | Editor permission badges, compile-history reasons and generic build UI; each shares the dark purple primitive without consuming the music role |
| `--selection`, `--selection-tint`, `--selection-soft`, `--selection-line` | Selected interface controls and rows |
| `--editor-selection`, `--editor-selection-idle` | Opaque local editor selection bands |
| `--native-selection`, `--editor-match-active-bg` | Browser selection and current editor search result |
| `--editor-match-bg`, `--editor-bracket-match-bg`, `--editor-bracket-error-bg`, `--editor-special-bg` | Opaque editor-relative decoration fills, including inactive search results |
| `--editor-focus-ring`, `--completion-detail-selected` | Editor focus paint and selected completion source/detail labels |
| `--switch-track`, `--switch-thumb`, `--switch-track-active`, `--switch-thumb-active` | Switch states; track and thumb remain distinct |
| `--switch-compact-track`, `--switch-compact-thumb` | Footer switch's original smaller-scale colors |
| `--scrollbar-thumb`, `--scrollbar-thumb-hover`, `--scroll-edge` | Scroll handles and overflow gradients |
| `--shadow-color`, `--shadow-panel`, `--shadow-document`, `--shadow-card`, `--shadow-drawer` | Shadow pigments; `--shadow` retains the panel geometry |
| `--dialog-backdrop`, `--drawer-backdrop`, `--compile-backdrop` | Scrims and busy preview overlay |
| `--brand-gradient-end`, `--brand-glow`, `--brand-glow-large`, `--topbar-sheen` | Brand/surface gradients |
| `--peer-fallback`, `--region-fallback`, `--on-peer` | Collaboration defaults and initials |
| `--status-active-tint`, `--status-disabled-tint`, `--status-halo` | Original admin status tints and neutral build halo |
| `--select-arrow` | Select chevron strokes |

Use `color-mix(in srgb,var(--semantic-danger) 12%,transparent)` for a translucent
danger treatment. Derive a category shade from its category role rather than
a syntax role with the same RGB value. The original admin success/disabled
tints have separate primitives because their hues differ from status text.

### Neutral overlays

`--surface-overlay` supplies the neutral overlay pigment. R8 retains the exact
byte-alpha fractions from the original stylesheet. For example, `6 / 255`
means 2.352941% coverage, not a rounded 2% or 3%.

| Roles | Alpha numerator (out of 255) |
| --- | --- |
| `--surface-disabled`, `--surface-subtle`, `--surface-control`, `--surface-raised` | 4, 5, 6, 8 |
| `--hover-subtle`, `--hover-soft`, `--hover-field`, `--hover` | 10, 12, 13, 14 |
| `--hover-medium`, `--hover-icon`, `--hover-strong` | 16, 18, 20 |
| `--grid-dot`, `--preview-grid-dot` | 10, 8 |
| `--skeleton-bg`, `--skeleton-shimmer` | 10, 11 |
| `--spinner-track`, `--spinner-provider-track` | 26, 38 |

`--surface-inset` uses the shadow pigment at 13/255. The action spinner derives
35% coverage from `--on-accent`. Shadows retain their original 55%, 70%, 60%
and 90% coverages; scroll edges retain 80%.

## Documented exceptions and data boundaries

- **Document paper and ink:** `.pdf-page`, `.image-preview` and `.fontprev`
  consume `--document-paper`; the font specimen also consumes `--document-ink`.
  Keep those document primitives fixed when changing the interface theme.
  PDF canvases and incoming image/SVG artifacts retain their document colors.
- **Peer/region data:** the application retains incoming collaboration colors.
  `src/collab.js` assigns eight stable identity colors in `PEER_COLORS`; these
  values belong to the collaboration data contract.
  Missing values use `var(--peer-fallback)` or `var(--region-fallback)` so an
  already-mounted marker follows a role update. Peer initials use `--on-peer`.
  The local `--peer-selection-bg` resolves the peer's own custom property;
  defining that derived value on `:root` would resolve it before the peer exists.
- **Mask paint:** `--icon-alert-circle` contains the sole encoded `%23000`
  stroke. That stroke defines mask coverage. `.login-error::before` paints
  the visible icon with `currentColor`, inherited from the danger role.
- **Brand assets:** the six color uses in `iris_logo.svg`, the white path in
  `iris_logo_w.svg`, and four white paths in `iris_text_logo_w.svg` belong to
  brand artwork. R8 preserves them. The white wordmark remains visible on the
  dark surfaces; the white emblem over its accent gradient is a logotype,
  not a required state indicator. R10 needs a suitable wordmark variant on
  light surfaces.
- **CSS keywords:** `transparent`, `currentColor`, `inherit`, `none`, and native
  control styling retain their CSS/browser meanings. CodeMirror's transparent
  gutter spacer does not represent a participant.

The former encoded select chevron was visible UI paint, so it did not qualify
as a mask exception. Two CSS gradient strokes now draw it with `--select-arrow`.
The 8px-wide chevron retains the control's inset and contributes only a small
raster difference in the screenshot comparison.

## CodeMirror and browser styling audit

The mounted CodeMirror editor lives in the document DOM and inherits root
tokens. Iris overrides its editor/content/gutter surfaces, local selections,
cursors, matching/nonmatching brackets, special characters, autocomplete list,
selected completion, matched text and detail text. Its diagnostic gutter,
search ruler, peer decorations and contested-region spine consume roles.

`highlightActiveLineGutter` is enabled and Iris gives it a transparent background
with `--txt-dim` text. Iris does not enable CodeMirror's active-line background,
placeholder, search panel, tooltip-info or snippet-field UI. Those unused vendor
defaults remain in the package. Audit a vendor surface when enabling it; vendor
source exclusion does not exempt a newly mounted UI from the color contract.
R10 also needs to revisit `EditorView.darkTheme.of(true)` and native control
color schemes when resolving a light theme.

CodeMirror's enabled bracket extension adds focused-editor background rules.
Iris's bracket selectors include the host, editor and content classes to outrank
those rules. Tests measure the syntax text inside the decoration wrapper and
composite its ancestor backgrounds; sampling only the wrapper's inherited
foreground would overstate contrast.

## Measured dark adjustments

R8 preserves the dark surfaces, normal interface text and action colors.
Contrast tests exposed these source-reading issues:

| Treatment | Before | R8 | Evidence |
| --- | --- | --- | --- |
| Comment text | `#7782aa` | `#929dc3` | Active selection: 3.233 → 4.557:1; idle: 3.761 → 5.300:1 |
| Bracket text | `#7f89b2` | `#939ec4` | Active selection: 3.562 → 4.612:1; idle: 4.143 → 5.365:1 |
| Current search fill | Accent at 28%, translucent | Accent at 14% over opaque editor background | Prevents stacking over a peer line from lowering muted syntax below 4.5:1 |
| Peer selection fill | Peer at 22%, translucent | Peer at 10% over opaque editor background | White-peer stress case previously measured 2.479:1; full-color underline still identifies the range |

The peer's actual marker/underline color stays data-driven. The opaque range
fill prevents several decorations from accumulating into an unreadable band.
Disabled controls and decorative shadows/grid dots do not use the ordinary
text/required-indicator thresholds.

### Review-round corrections

Mounted-browser checks reproduced additional failures and prompted these changes:

- The editor's 1px inset focus ring now derives 50% coverage from `--focus-color`
  through `--editor-focus-ring`, up from 40%. Canvas-composited contrast rose
  from **2.686:1 to 3.478:1**. The test checks the active `:focus-visible` state,
  pseudo-element paint, and removal of the ring when focus leaves the editor.
- Selected completion details use `--completion-detail-selected` (`--txt-dim`)
  while ordinary details keep `--txt-mut`. A real selected `main.tex` source
  label rose from **3.808:1 to 5.378:1** over its selected row.
- Inactive search results now use `--editor-match-bg`: the existing 14%
  selection tint over opaque editor background. Comment text over a white
  peer's caret line rose from **3.909:1 to 5.027:1**.
- Matching/nonmatching brackets and special characters also use opaque
  editor-relative fills. The expanded audit caught stacking failures for all
  three, including CodeMirror's higher-specificity bracket backgrounds.
  Matching brackets rose from **3.492:1 to 4.762:1**, nonmatching brackets
  from **3.911:1 to 5.003:1**, and special characters from **4.050:1 to 5.191:1**.

Canvas byte rounding explains the small differences from the review's
floating-point estimates. The dark screenshot gate records focus-ring changes
inside the exact 1px host edge separately, preserving its existing threshold
for unrelated pixels. Music-category changes now leave permission, history
and generic build consumers alone; their new roles retain the original purple
RGB values.

## Verification

- `test/ui-colors.test.js`: palette/exception contract and scanner mutation cases.
- `test/ui-accessibility.test.js`: role-alias resolution, UI text contrast,
  all nine syntax roles on normal/active/idle backgrounds, action labels and
  switch indicators, plus the existing accessibility contracts.
- `test/ui-visibility.browser.test.js`: live role propagation, computed contrast,
  desktop/compact same-DOM baseline comparisons, and the R6/R7 browser gates.
- Bibliography and request-security browser suites cover the shared surfaces.

The comparison tests load `9b206d1:public/iris.css` from Git on the same mounted
fixture, capture before/after PNGs, and save computed-color and pixel-difference
JSON in the isolated runner's `TMPDIR`. They permit the documented syntax/overlay
contrast corrections and bound screenshot differences. The task report records
the concrete artifact paths and test counts.
