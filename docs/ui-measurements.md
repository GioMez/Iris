# Interface measurement tokens

Iris defines its interface scales in `public/iris.css`, under `:root`. Use these
tokens for spacing, text and corners when editing a component. Choose by role:
an inset around a panel and clearance for an icon inside a field serve different
purposes, even when their current pixel values happen to match.

## Spacing

| Tokens | Values | Use |
| --- | --- | --- |
| `--space-px` | 1 px | Micro-separation between metadata lines or dense tree actions |
| `--space-1` through `--space-4` | 2, 4, 6, 8 px | Compact gaps, labels, icons and small controls |
| `--space-5`, `--space-6` | 12, 16 px | Control insets, form fields and dialog sections |
| `--space-7`, `--space-8` | 24, 32 px | Panel and screen insets |
| `--space-9`, `--space-10` | 48, 64 px | Large-screen margins and empty states |

Zero, `auto` and proportional layout values retain their CSS meanings. Responsive
rules select from the same scale. When a width depends on an inset, derive it
from that token too, as the settings accordion does.

The settings markup uses `settings-section` for a section's top gap and
`settings-section-label` for a section label's top and bottom gaps.
The compact workflow uses a 2 px gap so its pinned sharing/account controls fit
between the label-hiding breakpoints.

## Typography

| Token | Value | Use |
| --- | --- | --- |
| `--text-xs` | 11 px | Small metadata, labels and badges |
| `--text-sm` | 12 px | Secondary text, dense lists and small controls |
| `--text-md` | 13 px | Main controls, fields and workspace text |
| `--text-body` | 14 px | Body copy and prominent form text |
| `--text-lg` | 16 px | Section titles |
| `--text-title` | 18 px | Dialog or login titles |
| `--text-heading` | 24 px | Screen headings |

Use `--leading-ui` (1.4) for compact multiline text, `--leading-copy` (1.5) for
ordinary paragraphs, and `--leading-relaxed` (1.65) for longer help or log text.
Icon-only elements may need zero or unit line height; inherited line metrics
also remain valid.

Letter spacing has three roles: `--tracking-ui` (.02 em), `--tracking-caps`
(.04 em) and `--tracking-label` (.05 em). `--font-ui`, `--font-code` and
`--font-document` keep interface text, code and document specimens independent.

## Corners

`--radius-detail` (2 px) and `--radius-small` (4 px) cover markers and small
decorations. Use `--radius-compact` (6 px) for compact or nested controls,
`--radius-control` (8 px) for ordinary controls, `--radius-panel` (12 px) for
cards and panels, and `--radius-dialog` (16 px) for dialogs.

`--radius-round` is 50% for circles; `--radius-pill` is 999 px for capsules.
Keep these roles distinct. Joined controls can use the appropriate token on
their outside corners and zero on their shared edge.

## Controls and input methods

Use `--control-sm` (32 px) for compact actions, `--control-md` (36 px) for
ordinary actions and `--control-form` (40 px) for form fields. An action beside
a form field uses the same form height. Multiline buttons use a minimum height
and grow with their text. The segmented preview and admin controls retain their
inner-box geometry.

Ordinary text fields use `--font-ui`. Add `code` to an `input` with class `input`
for a filename, command, path or native bibliography identifier. Source editors
and completion-command textareas retain `--font-code`.

Action icons use `--icon-md` (16 px), dense utilities use `--icon-sm` (14 px),
and section navigation uses `--icon-lg` (18 px). Font specimens and decorative
marks have separate dimensions.

Keyboard outlines use `--focus-width`, `--focus-color` and `--focus-offset`.
Validation changes the border without removing the focus outline. Scrollers
draw focus inside their clipping boundary; a grouped number field draws it on
the outer group.

With a coarse pointer, the three control-height tokens resolve to
`--control-touch` (44 px). Workspace actions scroll when space is limited,
sharing/account controls remain pinned, and an active tree row places its
actions below the filename. Preview controls and file-tab close buttons also
provide 44 px targets. The file-tab strip scrolls instead of shrinking tabs until
their close buttons overlap. Outline rows, notices, menus and bibliography
navigation/disclosures use the same minimum target. Touch checks use browser
emulation and include hit-testing, not just rectangle sizes.

Card content and actions share horizontal insets. Status/retry rows reserve
ordinary layout space and wrap text, without negative-margin compensation.

## Geometry exceptions

- CodeMirror has its own `--editor-font-size`, `--editor-line-height`, editor
  padding and gutter width. Its line-number inset and diagnostic marker sizes
  belong to that coordinate system.
- Tree and outline indentation preserve a fixed 16 px hierarchy step.
- Image previews retain 30 px per side: `layoutImagePages()` includes the total
  60 px inset in its border-box width and zoom calculation.
- The preview and administration segmented controls retain fixed 2 px insets
  and gaps within their explicit width/height budgets.
- `--field-icon-inset` (34 px) and `--field-password-inset` (52 px) reserve room
  for an overlaid search/select icon or password visibility button.
- Negative margins center a fixed-size spinner or overlap presence dots.
  Adjust those as a layout unit.
- Document-font specimens, initials inside 18 px presence dots and a decorative
  SVG fallback keep their own font sizes. Inline code can scale relative to its
  surrounding paragraph.

Borders, focus rings, icon dimensions, panel widths, breakpoints and motion
distances describe other layout or rendering constraints. A pixel value alone
does not make one of these an interface-spacing token.

## Visibility, motion and layers

Use `hidden` for an unavailable or inactive element. CSS defines its visible
layout; JavaScript does not set `style.display`. Whole application surfaces and
animated transitions use their existing state classes. Dynamic widths, menu
coordinates, document-font samples, peer colors and dialog-stack indices remain
data-driven styles.

The `--motion-*` and `--ease-*` tokens describe control feedback, layout changes,
surface entry/exit and progress indicators. `IrisMotion.afterMotion()` waits for
finite animations/transitions on the element and its dialog surface, with a
timer fallback derived from the CSS token and actual animation timing plus a
50 ms allowance. It clears that timer on completion and tolerates cancellation.
Generation guards still prevent an older close from hiding a reopened dialog.

One reduced-motion block suppresses CSS transitions and animations, including
progress spinners. Dialog/project changes complete immediately in that mode,
and programmatic preview page navigation uses instant scrolling. Toasts retain
their reading interval and leave through a CSS state class.

Opacity tokens distinguish disabled controls, busy surfaces, secondary details,
icons, decorations and persistent actions. Keyframes retain their own entry,
pulse and endpoint values.

The `--layer-*` tokens name local editor layers and the global surface order:
workspace overlays, home, administration, login, account menu, dialogs, then
non-interactive toasts. Dialogs add the current `--iris-dialog-layer` index to
their base, matching the focus/inert stack. Toasts do not intercept pointer input.

## Responsive map

Viewport rules stay with the component whose available space they describe.
Equal thresholds in separate component sections are intentional.

| Maximum viewport width | Layout decision |
| --- | --- |
| 1180 px | Sidebar drawer; editor/preview split retained |
| 820 px | Single-pane workspace; admin rows adapt to cards |
| 760 px | Build history stacks its list and detail |
| 720 px | File history stacks its list and detail |
| 700 px | Settings tabs become an accordion |
| 680 px | Compact toolbar action cluster |
| 640 px | Project home, admin filters and forms become narrow layouts |
| 600 px | Bibliography form becomes one column |
| 520 px | Compact branding and status utilities |
| 480 px | Build metadata/actions stack |
| 430 px | Workspace controls use icon-only labels |

Container queries are separate: bibliography uses its own 700 px width; the
preview toolbar adapts at 660 px and 400 px. Panel percentage/viewport limits
bound scrolling areas, while multiline descriptions and diagnostics can grow.

## Collapsible preview

In a split workspace, the right-panel toolbar button hides or shows the preview
and its resizer. The editor takes the freed width. Hiding preserves the output,
reading position and saved panel width. Starting a compilation or explicitly
requesting a preview reveals the panel; background build notifications do not.
Compact layouts use the Editor/Preview navigation instead of a second pane.
Revealing waits for the grid to settle before refitting and protects the reading
anchor from provisional scroll clamping. PDF pages/canvases are reused when the
document, fit width or zoom, and pixel density are unchanged. New dimensions or
documents still render through the normal generation-checked path.

## Verification

`test/ui-visibility.browser.test.js` exercises token propagation with non-default
values and checks that editor metrics remain independent. It also covers
login, project home, administration and settings at desktop, tablet and compact
sizes in English and Italian, plus a half-size CSS viewport at double pixel
density to model 200% zoom reflow. The bibliography browser suite covers its
table/card layout, scrolling, multiline messages and dialogs.
Boundary-width checks cover the pinned toolbar controls; rendered PNG/SVG build
checks compare the image's dimensions with its 100% and 110% zoom labels.
