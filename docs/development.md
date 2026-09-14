# Develop Iris

Use Node.js 24+ and the locked dependencies:

```sh
npm ci
```

For an interactive local instance, follow [native installation](installation.md#native-installation).
`npm run dev` and `npm start` both run `node src/server.js`; there is no separate
frontend bundling step. The server serves browser modules from `public/` and
allowlisted installed dependency paths.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/server.js` | HTTP routes, authentication, project operations and compiler orchestration. |
| `src/database.js`, `db/schema.sql` | Current schema initialization and compatibility checks. |
| `src/project-*.js`, `src/versions.js`, `src/builds.js` | Project storage/identity, authorization, mutation compensation, deletion, history and builds. |
| `src/collab.js` | Text authority and collaboration protocol support. |
| `src/compile-diagnostics.js`, `src/source-mapping*.js`, `src/lilypond/` | Diagnostics and native PDF/source adapters. |
| `src/admin.js`, `src/audit.js`, `src/retention.js` | Account rules, audit records and retention policy. |
| `src/request-security.js`, `src/throttle.js`, `src/lifecycle.js` | Request admission, work bounds and shutdown. |
| `public/Iris.html`, `public/iris.css`, `public/iris-*.js` | Shipped UI, CodeMirror integration, preview, bibliography and administration. |
| `public/locales/`, `public/templates/` | Translation catalogs and fresh-instance template seeds. |
| `test/` | Node, real PostgreSQL, browser and native compiler checks. |
| `scripts/` | Disposable verification, installation smokes, source packaging and demo captures. |
| `docs/`, `branding/` | User/technical guides, screenshots and project artwork. |

Runtime data belongs outside source inputs. `DATA_DIR` defaults to ignored
`./data`; the verification runner creates a separate temporary root instead.

## Run the tests

The repository runner requires an **unprivileged POSIX user** and installed
**PostgreSQL 18+ tools**, including `initdb`, `pg_ctl` and `psql`. It discovers
their directory through `pg_config --bindir`; use `--pg-bin DIR` to select it.

```sh
node scripts/test.cjs
```

`npm test` invokes the same command. The runner creates a new loopback-only
SCRAM PostgreSQL cluster and test credentials, isolates HOME/TMPDIR/cwd/storage,
and cleans owned resources on completion or interruption. It ignores inherited
database/application credentials, browser base URLs and opt-in test variables.
You do not need a test `.env` or an existing database.

Select files or filter test names through its CLI:

```sh
node scripts/test.cjs test/project-deletion.test.js test/retention.test.js
node scripts/test.cjs --pattern 'crowded tabs' --browser test/ui-visibility.browser.test.js
node scripts/test.cjs --help
```

| Option | Default / effect |
| --- | --- |
| `--browser` | Enable browser cases with installed Chrome. |
| `--browser-executable PATH` | Enable browser cases with this Chromium executable. |
| `--native` | Enable real compiler cases. |
| `--pg-bin DIR` | Override `pg_config --bindir` discovery. |
| `--pattern REGEXP` | Node test-name filter. |
| `--concurrency N` | Test-file concurrency; default 4. |
| `--timeout MS` | Whole-suite bound; default 600000. |
| `--test-timeout MS` | Per-test bound; default 60000. |
| File paths | Selected top-level test files; default all `test/*.test.js`. |

### Browser and native gates

Playwright Core **1.63.0** uses an installed browser; `npm ci` does not download
one. Native navigation tests need `pdflatex`, `synctex`, `lilypond` and `gs` on
PATH. Browser source-navigation cases also use those native tools. An enabled
gate fails if required tools are missing; a skipped gate does not verify them.

The combined qualified command is:

```sh
node scripts/test.cjs --browser --native \
  test/bibliography.browser.test.js \
  test/browser-lifecycle.browser.test.js \
  test/request-security.browser.test.js \
  test/source-navigation.browser.test.js \
  test/ui-visibility.browser.test.js \
  test/source-mapping.native.test.js
```

`npm run test:integration`, `npm run test:bibliography:browser`,
`npm run test:browser` and `npm run test:native` provide selected entrypoints.
Use the runner's flag names, such as `npm test -- --test-timeout 30000`.

The suite uses several kinds of evidence:

- PostgreSQL cases exercise actual authorization, schema integrity, transactions,
  concurrency and history. Compiler pipeline cases often use controlled
  executables to provoke diagnostics and failure paths.
- Bibliography browser cases mount the shipped CodeMirror/Worker UI with
  controlled project/session responses; they cover table/form editing, source
  preservation, conflicts, permissions and large files. Separate HTTP/database
  suites cover persistence.
- Source-navigation browser journeys compile real fixture projects through HTTP
  and paint retained PDFs in PDF.js. Controlled PDF fixtures add crop/rotation,
  cancellation and geometry error cases.
- UI cases measure current layout, focus, contrast and preview state, including
  crowded tabs in both themes. They do not require a historical Git checkout.
- Browser lifecycle cases run the capture and native-smoke entrypoints with
  real Chrome, Iris and disposable PostgreSQL. They interrupt launch, active
  browser work and close, and check process and storage cleanup.

Browser qualification uses Chrome 152.0.7977.83 on macOS arm64, including
viewport/touch emulation. It does not establish physical-phone, screen-reader
or other-browser qualification. Native qualification uses TeX Live 2026 and
LilyPond 2.26.0; see the [source-navigation contract](source-navigation.md#native-adapters).

Direct `node --test` remains useful for a pure module. Database-dependent direct
runs require an explicitly isolated `TEST_DATABASE_URL`; the complete bootstrap
suite also creates databases and restricted roles. Prefer the disposable runner
for those checks. Its CLI flags map to the tests' internal opt-in variables.

## Installation smokes

Run a complete disposable native install with real browser previews:

```sh
node scripts/smoke.cjs --native --browser
```

It verifies first-admin login/password changes, project creation, LaTeX/LilyPond
builds, PDF bytes/navigation, export/import, full PostgreSQL/application restart,
and a coordinated database/filesystem restore into a separate installation.
`--native` without `--browser` skips browser painting; it still verifies native
PDFs and navigation through HTTP.

For an already-running test engine:

```sh
node scripts/smoke.cjs --engine docker
node scripts/smoke.cjs --engine podman
node scripts/smoke.cjs --help
```

For a dedicated Podman test environment, you can select a connection and provider
explicitly. Set `PODMAN_CONNECTION` to the test connection's name and
`PODMAN_COMPOSE_PROVIDER` to the provider executable's absolute path:

```sh
node scripts/smoke.cjs --engine podman \
  --connection "$PODMAN_CONNECTION" \
  --compose-provider "$PODMAN_COMPOSE_PROVIDER"
```

Both flags are optional; omit them to use Podman's configured defaults.

The source path must be visible to the engine for Compose's init-script bind
mount. Docker uses your selected context/host; Podman accepts an explicit
connection and provider. The script provisions no VM or daemon.

Container smoke builds `localhost/iris:1.0.0`, checks the same Compose on the
selected engine, and exercises initialization, health, login, storage, restart,
permissions and separate-volume/database restore. It checks missing-compiler
failures in the lightweight image. It refuses to overwrite an existing Iris
image; pass `--use-image` to use that local image and retain it afterward.

Smoke creates uniquely named projects, containers, volumes and networks, then
removes the resources it owns. Native smoke creates two databases in one
disposable cluster and distinct app storage/ports; container restore uses a
separate PostgreSQL service/volume. Cleanup failures retain diagnostic workspace
state and name the resources in output. An interrupted engine connection or
SIGKILL may require cleanup of those named resources by the operator.

Actual-engine qualification covers Docker Engine 29.8.0 / Compose 5.5.1 and
rootless Podman 6.1.1 / podman-compose 1.6.0 on Linux arm64. It covers a nested
Docker daemon with VFS and a SELinux-enabled Podman VM, rather than claiming
other host/storage-driver combinations.

## Source packaging

After the reviewed release commit and annotated tag exist:

```sh
node scripts/release.cjs --ref R1.0.0 --output .drafts/release-1.0.0
```

The output directory must be new. The script creates `iris-1.0.0.tar.gz` and
`SHA256SUMS` from immutable Git objects. It does not create a tag or change the
index. Working-tree modifications do not enter ref-based packaging.

For a pre-tag candidate, supply an explicit JSON array of relative source paths:

```sh
node scripts/release.cjs --candidate "$SOURCE" \
  --manifest "$MANIFEST" --output "$NEW_OUTPUT_DIRECTORY"
node scripts/release.cjs --help
```

Review the manifest: candidate mode includes exactly the named permitted bytes,
including new files. This mode works without Git. Both modes check package/lock
agreement and required inputs, and reject unsafe paths, symlinks and excluded
files. Secrets, application data, dependencies, drafts and planning records do
not enter the archive. Root `.env.example` is an intended input.

Packaging sorts UTF-8 paths and normalizes ustar ownership, timestamps and file
modes (0755 for `.sh`, 0644 otherwise), plus gzip metadata. Identical inputs
produce identical source-archive bytes. Limits are 20,000 entries, 64 MiB per
file, 512 MiB total source and ustar's path bounds. Review
`scripts/release.cjs:included()` before adding a new source/asset format.
Reproducible source bytes do not imply reproducible container image digests.

Extract the candidate into a new directory, run `npm ci`, and run the relevant
test/smoke commands from there. This verifies that packaged guides, fixtures and
scripts work without local dependencies or repository history. The release
workflow publishes no prebuilt image; operators build from the source tag/archive.

## Persistence contract

Product **1.0.0** uses database schema **2**. `initializeSchema()` owns the
initialization transaction and advisory lock `49524953`. It creates nine
application tables plus the singleton `iris_schema` marker in an empty schema,
reopens a matching marker, and rejects incompatible or malformed state without
modifying it. Bump `CURRENT_SCHEMA_VERSION` for an incompatible schema change.

Project storage keys have the form `projects/<lowercase UUID>`, relative to
`DATA_DIR`. Sources, fonts and assets live there; `.iris/project.json` stores
the tree/settings without duplicating source content. Published output uses
`output/<build-id>/`. The mutable template catalog is a sibling under the data
root by default.

Persistent entity IDs come from `src/ids.js` as UUIDv7. Generate them before
insertion when filesystem paths need them. Node's `crypto.randomUUID()` returns
UUIDv4; it is not the entity-ID generator. Use random bytes for secrets.
`audit_events.id` is a BIGINT identity.

`project_files` holds canonical source identity through renames/moves and
soft deletion. Creation/import/save reconcile current draft IDs, including
client-generated names and discovered `fs_gen_*` IDs, into that ledger.
Imports allocate new identities. Membership, not creator provenance, determines
content permissions.

Whole-project snapshots and name-only updates require `baseRevision`. A missing
or malformed precondition returns `428 PROJECT_REVISION_REQUIRED`; a stale
snapshot returns `409 PROJECT_REVISION_CONFLICT` before mutation. Successful
snapshot saves advance the server revision, including compilation's save phase.
Realtime flushes/checkpoints without a submitted tree do not advance it.

The per-project gate coordinates DB transactions and filesystem compensation.
Strict source reads fail instead of supplying empty data. Uncertain commits or
failed compensation retain recovery backups and block access. Project deletion
uses durable receipts, with cleanup only after confirmed commit. See the
[operator recovery states](administration.md#recovery-states).

Text history stores changed lossless UTF-8 source up to 16 MiB, with revisions
for compilation, explicit snapshots, idle realtime editing, deletion and restore.
Restore records current changed text before appending a new rollback revision.
Retention can prune history; file identity and readable author labels outlive
renames or account deletion.

## Collaboration contract

`/api/collab` uses authenticated WebSockets and CodeMirror operational
transformation. The server owns the ordered document/version. A stale client
pulls accepted updates, rebases its unconfirmed edits and retries. Broadcasts
and replies form one version-indexed stream; obsolete sockets/file openings
cannot replace a current session. New files join after obtaining canonical IDs.

Room text is authoritative for live files during saves, checkpoints and builds.
Deleting a file closes that room; renaming updates its path without resetting
the stream. Revocation rechecks permissions and can make an editor read-only or
close membership access. Robust offline editing is outside this model.

Presence is ephemeral, scoped to readable projects/files and absent from history
and the database. Positions move through intervening text updates before display.
Browser structure parsing labels shared sections/blocks; those overlap notices
are advisory. Build notices carry completion/author information; clients fetch
output through ordinary authorized HTTP routes.

## Compiler contract

The declared `projectType` selects LaTeX or LilyPond; omission defaults to LaTeX.
Compilation saves effective content and copies byte-exact sources/assets/fonts
under the project gate into `DATA_DIR/.build-staging/`. The compiler runs outside
the gate against that snapshot. Successful publication renames the generated
directory to immutable `output/<build-id>/`; failure retains diagnostics but
publishes no partial artifacts.

LaTeX tools are `pdflatex`, `xelatex`, `lualatex`, `xetex`, `bibtex`, `biber` and
`makeindex`. LilyPond uses one constrained `lilypond` step. Custom LaTeX profiles
have at most twelve ordered steps and these substitutions:

| Placeholder | Value |
| --- | --- |
| `[engine]` | Selected TeX engine. |
| `[main]` | Relative main source path. |
| `[jobname]` | Main filename without extension. |
| `[pdf]` | Expected PDF path under `output/`. |

TeX engine steps accept one relative source operand plus `-synctex=<integer>`,
`-recorder`, `-draftmode` and `-8bit`. Backend-managed arguments may repeat only
their exact values: `-interaction=nonstopmode`, `-halt-on-error`,
`-file-line-error`, `-no-shell-escape`, `-output-directory=output`. One- and
two-dash forms work; abbreviations, inline TeX, format selectors and extra source
operands fail validation, including in imported profiles. Mapping adds one
managed `-synctex=1` or `-synctex=0`.

Processes use argument arrays and a reduced environment without backend
credentials. XeLaTeX/LuaLaTeX receive `OSFONTDIR` and a project-local
`.iris/texmf-var` cache; Fontconfig refresh runs when available. LilyPond receives
the project root as `XDG_DATA_HOME` for its local fonts. Compiler execution still
has the [native trust boundary](administration.md#compiler-trust-and-instance-boundaries).

Build responses expose structured `diagnostics` and derived string
`warnings`/`errors` arrays. Finalization and interrupted-build reconciliation
store structured entries. Stored empty arrays are authoritative; a build reader
does not reconstruct active warnings from raw trace text.

Multipass diagnostic selection uses the last complete successful pass with the
same engine and normalized arguments, retaining auxiliary diagnostics, failed
passes and setup/publication errors. A truncated final capture cannot prove an
earlier warning resolved. The retained trace and per-step capture obey
`COMPILE_LOG_LIMIT`; selected diagnostics cap at 80 per severity.

The artifact registry lists previewable products. Build-file scanning exposes
other safe regular outputs, including MIDI and bibliography products. Symlinks,
special files and private navigation sidecars stay out of build-file downloads
and build ZIPs. Project exports copy ordinary output files, including retained
navigation sidecars, alongside source/settings. They do not copy database
history or original sharing memberships. A soft-deleted file retains recorded
revisions, but the restore endpoint refuses that file while deleted.

## HTTP and session boundaries

Content routes recheck membership capabilities; a nonmember receives 404 and
a member lacking the requested capability receives 403. Admin routes require
current administrator authority. Sessions carry an integer `session_version`;
password changes/resets, disable and local/SSO conversion invalidate earlier
cookies. Role changes apply through current database authorization. WebSockets
also validate on messages, heartbeats and expiry.

Unsafe API methods (POST/PUT/PATCH/DELETE) and WebSocket upgrades require a valid
same-origin request when browser metadata is present. A present Origin must be
a single matching `scheme://authority`, with no path, credentials, query or
fragment. Duplicate, null or malformed values fail. Without Origin, Iris first
rejects invalid, cross-site or same-site Fetch Metadata, then checks a present
Referer. That Referer must be valid and match the expected origin; `same-origin`
Fetch Metadata cannot override a foreign or malformed Referer. With both Origin
and Referer absent, `same-origin` Fetch Metadata supplies origin evidence, but
`none` alone does not. With all three headers absent, native clients pass this
layer but still need authentication.

Unsafe API requests require `application/json`, optionally one UTF-8 charset.
An explicit wrong type returns 415 even with an empty body. Missing type works
only without a transferred body; empty chunked requests still need JSON type.
`POST /api/projects/import` permits raw ZIP. The SSO callback GET uses state
validation rather than rejecting its expected cross-site return. Maintenance
and shutdown refusals take precedence over request admission.

For route-level work, consult the handlers and their behavioral tests rather
than treating an example request as a full API schema. The
[navigation API](source-navigation.md#http-api) has its own coordinate and
resource contract.

## UI and documentation contributions

Use the shared [color](ui-colors.md) and [measurement](ui-measurements.md)
tokens. Test mounted controls and editor/preview behavior when changing layout
or focus. [Translations](../TRANSLATING.md) use catalog keys and placeholders;
[templates](../public/templates/README.md) use the instance catalog.

For screenshots, run the [synthetic capture](images/README.md#reproduce-the-captures).
For docs edits, validate local links, heading anchors, image paths and named
configuration fields against the current source. Exercise changed commands;
tests that assert prose wording do not establish user-facing correctness.
