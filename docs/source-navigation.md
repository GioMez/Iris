# PDF–source navigation

This is the developer contract. For gestures, settings and troubleshooting, see
[Move between PDF and source](user-guide.md#move-between-pdf-and-source).

Iris creates source maps for PDF builds of LaTeX and LilyPond projects. The
project setting `sourceMapping` defaults to `true`. An explicit `false` survives
creation, import, saves and compilation. A sparse save that omits the setting
preserves its stored value. Requests with a non-boolean value receive HTTP 400.

The compile snapshot determines whether Iris generates a map. The current
project setting determines whether readers can query it. Disabling the setting
does not delete historical builds. Enabling it again permits navigation in a
retained build that already has a map; a build without a map needs recompilation.
Non-PDF builds retain the setting and skip mapping work.

## Using the editor and preview

In **Settings → Compilation**, use **Enable PDF–source mapping**, beside the
main-file selector. Owners and editors can change the setting. Viewers can use
the navigation controls with a read-only source editor.

Use Ctrl-click on Windows/Linux or Cmd-click on macOS for both languages:

- In the editor, click the source position you want to locate. Iris keeps your
  existing selection, reveals the preview, selects the mapped PDF if needed,
  and highlights the returned area.
- In the PDF, click an object or text position. Iris opens the source by file
  identity, focuses the editor, and selects the reported column or row.
  Compact layouts switch to the relevant pane.
- For builds with several PDFs, **PDF document** above the preview lets you
  select one. Source queries prefer the current artifact and physical page,
  then use the backend's result order.

Ordinary clicks and Alt/Shift gestures retain their editing behavior. Blank PDF
areas can have no match. SyncTeX row precision selects the complete row instead
of guessing a column. A source jump changes the reading position; zoom, refit
and closing/reopening the preview retain its existing reading anchor.

The footer's **Open preview / Close preview** control and the toolbar panel
button toggle the preview without a source-map query. They also work before
compilation and with mapping disabled. On compact screens the footer switches
between the editor and preview workspaces. Both controls expose their current
expanded state and can be activated from the keyboard.

The highlight uses document ink on document paper, with the shared selection
tint. Switching themes keeps the PDF's paper colors. Iris retains the selected
PDF's canvases when the layout still fits, and retains artifact bytes when you
choose another PDF.

### Current text and asynchronous work

Iris checks SHA-256 of the current text after CRLF/CR-to-LF normalization before
applying a match. A changed or deleted source requires recompilation. A rename
keeps its file ID, and a historical build remains usable when its compiled text
matches the current source.

For an inactive file without local edits, the client opens a temporary room
subscription through the existing collaboration socket. It holds the received authoritative document
apart from the editor until hash validation succeeds, then activates that same
subscribed version. A room update, deletion, permission change, disconnect,
cancellation or five-second expiry invalidates the prepared document. Rejected
navigation does not load cached file text into the editor. The active file also
requires its live authoritative room, rather than a pending initial load.

An inactive file with unsaved local text also requires an authoritative room
check. Both texts must agree after newline normalization, and the room text must
match the compiled hash. A mismatch leaves the current editor and the unsaved
buffer intact. If both qualify, Iris opens the retained local buffer on its
ordinary save path; it does not replace it with the prepared room document or
clear its dirty revision.

Each navigation owns an abort signal and generation. The controller checks the
project session, build, artifact, file, editor revision, physical page and viewer
load/render generations after asynchronous work. It prepares another PDF before
applying the result, then checks the source again. The current checkbox state
takes effect at once, including while compilation is running.

A forward operation remains cancellable through its final reveal. Iris keeps a
one-shot target while a collapsed pane finishes opening and the current PDF
layout finishes painting. Immediately before scrolling, it rechecks source and
project/build/artifact identities, document revision, and the current PDF
document and render generation. Later refits and reopenings preserve the reading
anchor instead of replaying that target.

The viewer saves each page's PDF.js CSS viewport transform. Hit testing scales
the current DOM rectangle back to that viewport, inverts its transform and
measures the PDF point from the original unrotated MediaBox's top-left.
Forward highlights reverse that conversion before applying the viewport
transform. PDF.js handles the display CropBox and rotation; raster DPR does not
multiply input coordinates.

PDF.js exposes the cropped page view through its public API. On the first
enabled navigation that needs an artifact's geometry, Iris reads its original
bytes with **pdf-lib 1.17.1** in a dedicated worker. The parser resolves inherited
MediaBoxes and indirect/compressed PDF objects. Iris retains only the page-box
arrays with that in-memory artifact and terminates the worker. Replacing the
artifact discards its geometry; reopening a historical build reads its original
bytes again. The parser does no work while mapping is off. A parser failure
leaves navigation unavailable and the PDF usable.

## HTTP API

Use the existing session cookie, same-origin rules and JSON transport:

```text
POST /api/projects/:projectId/builds/:buildId/navigation
```

Forward request:

```json
{
  "direction": "forward",
  "sourceFileId": "019c01f0-3aa0-7000-8000-000000000001",
  "line": 12,
  "column": 4
}
```

Forward requests accept optional `artifactId` and `page` hints. These hints
prefer a displayed artifact/page without excluding other matching outputs.
Iris retains a bounded best-candidate set before applying the 32-match cap, so
a preferred page late in native output or a later PDF can still rank first.

Inverse request:

```json
{
  "direction": "inverse",
  "artifactId": "019c01f0-3aa0-7000-8000-000000000002",
  "page": 1,
  "x": 120.5,
  "y": 240
}
```

IDs are canonical UUIDs, not file paths. Lines and physical pages start at 1.
Columns start at 0 and count UTF-16 code units. Both navigation directions use
the native unrotated page's **MediaBox top-left**, with x increasing right and y
increasing down. For MediaBox `[left, bottom, right, top]`, a native point `(x,y)`
corresponds to PDF default user-space `(left+x, top-y)`. Width and height are
unrotated extents. These units are 1/72 inch for the qualified native compilers;
the viewer applies PDF.js's UserUnit/rotation/scale transform for display.
A CropBox changes the visible area, not the API origin. A printed page number
does not change the physical page index.

This contract assumes the compiler's native mapping page agrees with the
original PDF MediaBox. Runtime qualification covers zero-origin MediaBoxes from
pdfLaTeX and LilyPond, including a pdfLaTeX-authored nonzero CropBox. Controlled
fixtures also verify translated MediaBoxes. They do not qualify external tools
that relocate or resize a compiler PDF without updating its native map.

Response:

```json
{
  "status": "ready",
  "matches": [
    {
      "artifactId": "019c01f0-3aa0-7000-8000-000000000002",
      "page": 1,
      "x": 120.5,
      "y": 236,
      "width": 10,
      "height": 8,
      "sourceFileId": "019c01f0-3aa0-7000-8000-000000000001",
      "sourceRevisionId": "019c01f0-3aa0-7000-8000-000000000003",
      "sourceHash": "a68b0abc07f0f1cacfc16b6c95f3a40a3075f5a0ab49a88ba26b2d8124603e78",
      "line": 12,
      "column": null
    }
  ]
}
```

Iris returns at most 32 matches. `column: null` means row precision. SyncTeX
inverse results use the requested PDF point with a zero-width, zero-height
rectangle; the native CLI supplies the source row rather than an inverse box.

| Status | Meaning |
| --- | --- |
| `ready` | One or more matches. |
| `disabled` | The current project setting disables navigation. |
| `missing` | The build lacks a map, has no successful PDF, or a referenced source is gone. |
| `unsupported` | Non-PDF output, an unsupported map version, or unavailable LilyPond mapping APIs/backend. |
| `no-match` | A supported map has no match for the requested position. |
| `unavailable` | A map/query failed validation, exceeded a budget or encountered an I/O error. |

Non-ready responses contain `matches: []`. An unavailable response may include
one of these stable `reason` values: `busy`, `cancelled`, `timeout`,
`output-limit`, `engine-missing`, `query-failed`, `map-limit`, `malformed-map`,
`collector-failed`, `stale-artifact`, `storage-error`.

Invalid fields receive HTTP 400. Unknown or foreign project/build/artifact/file
identities use the existing 404 behavior. A project member without a required
capability receives 403. Owners, editors and viewers can navigate. Iris checks
authorization and build state again after native work; a disconnected request
cancels its child process.
Request admission has two slots and no queue, before body consumption or a
project-gate wait. Iris observes disconnects from handler entry and checks for
an already-closed connection. A cancelled gate waiter keeps its reservation
until its queued callback drains; it then releases the slot without loading a
map or starting a native query. This bounds cancelled callbacks as well as live
requests. Admission covers final validation and releases on early returns and
errors too.

### Applying results in a client

Resolve sources by `sourceFileId`, including after a rename. Before applying a
result, normalize authoritative current text from CRLF/CR to LF, encode it as
UTF-8 and compare its SHA-256 hash with `sourceHash`. A mismatch requires
recompilation. Build age alone does not invalidate a result. A retained manifest
keeps its compiled revision identity even if history retention later prunes the
corresponding database revision.

`IrisProjects.navigateBuild(buildId, query, { signal })` uses IrisNet's existing
same-origin JSON transport and rejects a replaced project session. The frontend
controller also checks the viewer and document context described above.

## Native adapters

### LaTeX / SyncTeX

Iris removes duplicate SyncTeX profile options and appends exactly one managed
`-synctex=1` or `-synctex=0` before the source operand. Other validated profile
options and bibliography/index steps retain their existing behavior.

Iris records input tags from the generated `.synctex` or `.synctex.gz` file and
keeps that file beside its PDF. Query processes run `synctex view` or
`synctex edit` against this retained directory, after staging cleanup. Iris uses
the selected compile-time TeX binary directory, or PATH if compilation used
PATH. An operator-locked `TEX_BIN_PATH` takes precedence at query time.

Processes receive argument arrays without a shell. Iris clears
`SYNCTEX_EDITOR` and `SYNCTEX_VIEWER`; it supplies no launch command. Input paths
from the CLI can only match recorded snapshot sources. Path normalization
handles dot segments and macOS `/var` versus `/private/var` aliases. Iris does
not open source paths returned by the compiler.

Native qualification on macOS arm64: pdfTeX 1.40.29, TeX Live 2026/Homebrew, SyncTeX CLI utility
1.5 (help also identifies command-line client 1.21). The tested engine emits row
precision. XeLaTeX, LuaLaTeX and XeTeX use the same managed option/query adapter;
the native suite qualifies pdfLaTeX. An engine that supplies no
SyncTeX file yields `missing`.

### LilyPond

For an enabled PDF build, Iris adds its compilation-local
`-dinclude-settings=.../src/lilypond/source-mapping.ily`. LilyPond supports
multiple settings includes; user includes remain effective. The collector wraps
the standard PS backend's final-page outputter and calls the original outputter
after collection, including after collector errors.

The collector visits final stencils once and records origins, physical page
ordinals and rectangles. It composes scale/rotation transforms and translation
offsets, then converts LilyPond units to PDF points and reverses the vertical
axis. It also applies the PS backend's landscape page turn to return unrotated
PDF coordinates. The adapter converts LilyPond Unicode-character offsets to UTF-16 using
the saved normalized source text. Each PDF, including independently named book
outputs, receives its own artifact identity.

Native qualification on macOS arm64: LilyPond 2.26.0 with Guile 3.0, standard PS backend.
The suite measures real rendered PDF geometry for spaced/Unicode include paths,
reused music, chords/rests, physical pages with printed numbering starting at 7,
multiple books/PDFs, landscape pages and scaled/rotated/translated final stencils. It also checks
user settings includes, collector I/O errors and the transform-depth budget.
Ghostscript 10.08.0 supplies the test rasters; production Lily mapping queries
do not spawn Ghostscript.

Other LilyPond versions/backends have no native qualification for this release.
Missing final-page mapping output yields `unsupported`. An exception or invalid
sidecar yields `unavailable` while the compiler's valid PDF remains usable.

## Storage and budgets

Iris writes version 1 of `.iris-navigation.json` inside the staging output
directory, then publishes it with the build through the existing directory
rename. The manifest contains project/build IDs, artifact identities and hashes,
source file/revision IDs, compile-time relative paths, normalized source hashes
and text. Binary and font nodes do not enter text mapping.

LilyPond's temporary `*.iris-map.tsv` files become normalized manifest entries.
SyncTeX files retain their native format and checksums. Iris replaces any
compiler-authored file at the reserved manifest name before publication.
Navigation verifies artifact hashes, rejects symlink sidecars and validates
manifest identities. It does not mutate published maps.

Private navigation manifests, temporary Lily maps and SyncTeX files do not
appear in public build-file listings, build-file downloads or build ZIPs. They contain
snapshot text and compiler paths intended for the backend. Build deletion and
retention remove them with the build directory.

Portable project exports use a separate filesystem walk and include ordinary
output files, including retained navigation sidecars. Those ZIPs can therefore
carry snapshot text and compiler paths. Imports copy the bytes with new project
identities; they do not recreate database build records or a usable navigation
history. Compile the imported project to create its own builds/maps.

| Work | Budget |
| --- | --- |
| Native query | At most 5,000 ms and 1 MiB combined stdout/stderr. |
| Native concurrency | Two active queries; excess work receives `unavailable/busy`, with no native queue. Iris waits for child close after a kill before releasing a slot. |
| HTTP navigation admission | Two accepted requests including body/gate waits and final validation; excess requests receive `unavailable/busy` before joining a project gate. |
| Navigation reads | Two active map operations; bounded on-demand reads, no persistent build cache. |
| Manifest/maps | 16 MiB per build; includes normalized manifest and retained native data, with capped gzip expansion. |
| Map records | 200,000 per build, including native SyncTeX records across artifacts. |
| PDF integrity reads | At most 32 artifacts and 128 MiB aggregate PDF bytes per operation, hashed in 64 KiB chunks. |
| Viewer geometry | On-demand worker, five-second limit, at most 128 MiB input and 200,000 page boxes per artifact. Cancellation, failure and completion terminate the worker. Iris retains only box arrays for loaded artifacts. |
| Collector work | Five seconds of aggregate collection, 2,000,000 stencil callbacks, 200,000 records, 16 MiB text output and bounded transform nesting. |
| Column index | At most 200,000 source-line/astral-character index entries per parser invocation. |

These values bound resource use; they are not latency or throughput promises.
Mapping budget failures do not change a successful PDF build to failed.

Artifact and sibling build-file downloads own their resolved file handles
through response completion. A stream pipeline destroys the source on client
disconnect or stream failure; a final cleanup awaits stream closure and closes
the handle, including failures during header or stream setup. Disconnect checks
around authorization and database waits avoid opening files for abandoned
requests. A disconnect during file resolution closes the returned handle before
the handler settles.

## Verification commands

```sh
node scripts/test.cjs test/source-mapping.test.js test/source-navigation-client.test.js test/build-download-lifecycle.test.js test/source-mapping.integration.test.js
node scripts/test.cjs --native test/source-mapping.native.test.js
node scripts/test.cjs --browser test/source-navigation.browser.test.js
```

The [repository runner](development.md#run-the-tests) creates disposable
PostgreSQL and storage and removes its fixtures. The native suite skips without
`--native`; an enabled gate fails if a required compiler, SyncTeX CLI or
rasterizer is missing. The browser gate requires native pdfLaTeX, SyncTeX and
LilyPond plus installed Chrome through Playwright Core.

Browser journeys compile fixtures through real HTTP, open retained output in
PDF.js, and drive editor/PDF mouse events and the keyboard action. Qualification
uses Chromium 152.0.7977.83, PDF.js 6.3.289 and CodeMirror View 6.43.7. Ctrl-click
also runs with a controlled Linux platform identity on the macOS host;
Cmd-click uses the host identity.

Controlled viewer fixtures cover nonzero crop origins, rotations 0/90/180/270,
zoom and DPR 1/2, with rendered-pixel containment checks. A real pdfLaTeX cropped
PDF regression follows the native HTTP route into the viewer and checks marker
containment of rendered first-line pixels at DPR 2, plus inverse source-row
selection on that ink. It compares compile, retained-download and viewer
download bytes. Parser tests cover inherited indirect MediaBoxes in compressed
objects; browser tests cover lazy acquisition, off/re-enable, cancellation,
per-artifact reuse, parse failure and worker timeout. Native browser journeys
cover included sources, physical pages, multiple LilyPond PDFs, dirty text,
authoritative inactive rooms, rename/delete, delayed responses, compact Italian
light-theme layouts, readers, and preview reopen/cache behavior. UI, bibliography
and request-security browser gates accompany this suite; see the
[combined command](development.md#browser-and-native-gates).
