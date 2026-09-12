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
- Negative margins center a fixed-size spinner, overlap presence dots, or pair
  the project import status with its retry action. Adjust those as a layout unit.
- Document-font specimens, initials inside 18 px presence dots and a decorative
  SVG fallback keep their own font sizes. Inline code can scale relative to its
  surrounding paragraph.

Borders, focus rings, icon dimensions, panel widths, breakpoints and motion
distances describe other layout or rendering constraints. A pixel value alone
does not make one of these an interface-spacing token.

## Verification

`test/ui-visibility.browser.test.js` exercises token propagation with non-default
values and checks that editor metrics remain independent. It also covers
login, project home, administration and settings at desktop, tablet and compact
sizes in English and Italian, plus a half-size CSS viewport at double pixel
density to model 200% zoom reflow. The bibliography browser suite covers its
table/card layout, scrolling, multiline messages and dialogs.
Boundary-width checks cover the pinned toolbar controls; rendered PNG/SVG build
checks compare the image's dimensions with its 100% and 110% zoom labels.
