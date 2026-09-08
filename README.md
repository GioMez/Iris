<h1 align="center">
  <img alt="" src="branding/iris_logo.svg" width="240">
  <br>
  <sub>&nbsp;</sub>
  <br>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="branding/iris_text_logo_w.svg" width="160">
    <source media="(prefers-color-scheme: light)" srcset="branding/iris_text_logo.svg" width="160">
    <img alt="Iris" src="branding/iris_text_logo.svg" width="160">
  </picture>
</h1>

LaTeX produces gorgeous typography, and LilyPond does the same for engraved
music and I use and love them both. But working with both usually means
juggling more than one editor, and the price of admission is gigabytes of
toolchain installed on every machine where you want to compile a source. In the
end, I never found a good web editor for LilyPond that handled compilation, font
management, and preview all from a browser tab (and could run on a server of my
own).

*So… I vibe coded it.*

Iris is a self-hosted, browser-based writing and compilation environment for
LaTeX documents and LilyPond scores. It combines a project-oriented source
editor, server-side compilation, output preview, and authenticated storage in a
single web application.

> **Release status:** Beta 1 (`1.0.0-beta.1`)

> **Beta software and stability:** Iris is provided **as is**, without warranty,
> as described in the [GNU GPL v3](LICENSE). Beta 1 is the first public
> prerelease, not a promise that the next release will be stable: the beta
> series will continue for as many releases as needed. Until a stable release,
> breaking changes may affect configuration, deployment, data formats, APIs,
> and user-facing workflows. Back up both PostgreSQL and `DATA_DIR`, review the
> release notes, and test upgrades before applying them to an important
> installation. Backward compatibility between prereleases is not guaranteed.
> Face each change with the joy of pioneers and the perseverance of the
> frontier. 🤠

Iris is not a client-only editor. Projects are stored on the server as real
files, associated with individual user accounts, and compiled by toolchains
installed on the host running the backend. The browser provides the workspace;
the Node.js service handles authentication, persistence, and compilation.

## What Iris provides

- Separate workspaces for LaTeX documents and LilyPond scores.
- A project dashboard scoped to the authenticated user.
- Portable project export and import through ZIP archives.
- A refreshable file tree with folders, multiple open tabs, uploads, per-file
  downloads, renaming, and deletion.
- A CodeMirror 6 source editor with syntax highlighting, document outline,
  search and replace, formatting, optional word wrapping, and configurable
  autosave.
- Realtime collaborative editing of the same document by several members, with
  the server as the single authority that orders concurrent changes.
- Presence for the open file: who else is editing it, the lines they are on, and
  a non-blocking warning when two people work in the same area.
- A notice in the preview when another member has compiled something newer, with
  a one-click load of the most recent build.
- Server-side LaTeX compilation with `pdflatex`, `xelatex`, or `lualatex`.
- Built-in LaTeX pipelines for quick builds, BibTeX, Biber, and indexes, plus
  constrained custom pipelines.
- Server-side LilyPond compilation to PDF, PNG, SVG, PS, or EPS.
- An integrated PDF.js viewer, zoomable image preview, compiler log, warnings,
  errors, build duration, and downloadable artifacts.
- Project-local font uploads, including XeLaTeX and LuaLaTeX font discovery.
- Local password authentication and optional OAuth 2.0/OpenID Connect SSO.
- Localized interface with English as the default and Italian included.

Iris does not currently provide real-time collaboration, Git integration, or a
hosted compilation service. It is designed to run on infrastructure you
control.

## Localization

The browser interface loads i18next v4-compatible JSON catalogs from
`public/locales/`. English is the source and fallback language; users can switch
to Italian from the login screen or Settings, and the choice is stored in their
browser. UI labels, accessibility attributes, dynamic messages, plural forms,
dates, starter documents, and API errors all use the same localization layer.

See [TRANSLATING.md](TRANSLATING.md) for the Weblate component settings,
translation conventions, and the checks required when adding or updating a
language.

## How it works

```text
Browser
  │  static UI + same-origin JSON API
  ▼
Node.js backend
  ├── PostgreSQL   users, project ownership, timestamps
  ├── DATA_DIR     source files, assets, fonts, project state, outputs
  └── Toolchains   LaTeX / BibTeX / Biber / MakeIndex / LilyPond
```

A typical session follows this sequence:

1. The user signs in with a local account or an OIDC identity.
2. The backend returns only the projects owned by that user.
3. Opening a project loads its manifest and source files into the browser
   workspace.
4. Saving synchronizes the browser's project tree to real files below
   `DATA_DIR`.
5. Compiling first saves the current project, then runs the selected allowlisted
   tools in an isolated copy of the project without invoking a shell.
6. A successful build is atomically published below `output/<build-id>/`; prior
   builds remain available, and the new artifacts are sent back to the browser.

PostgreSQL stores accounts, the project index, and the audit trail. The filesystem
stores the actual project content, so a complete backup must include both the
database and `DATA_DIR`.

## Requirements

- Node.js 24 or later.
- PostgreSQL 18 or later. 18 is the baseline the schema is tested against; a newer
  major is accepted and does not block startup. The supplied Compose file ships 18.
- A LaTeX distribution for LaTeX compilation.
- LilyPond for score compilation.

The compiler toolchains are optional if you only want to inspect or edit the
application, but the corresponding build actions will not work until their
executables are available to the backend.

## Quick start for local development

Install the Node.js dependencies:

```sh
npm install
```

Create the local configuration file and generate a session secret and database
passwords:

```sh
cp .env.example .env
for name in IRIS_SECRET DB_PASSWORD POSTGRES_ADMIN_PASSWORD; do
  printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
done
```

Replace the corresponding blank lines in `.env` with the three generated lines.
Iris refuses to start without a non-default session secret and application
database password. Compose additionally requires the PostgreSQL administrator
password, which is not exposed to the application container.

Start PostgreSQL with Docker Compose:

```sh
docker compose up -d postgres
```

The non-secret database settings in `.env.example` match the development
database exposed by the Compose service. The published database port is bound
to localhost only. Iris applies pending versioned migrations during startup.

Start the application:

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000).

On the first successful startup, if the `users` table is empty, Iris creates one
local administrator account with:

- Username: `admin`
- Role: `admin`
- A randomly generated password printed once to the server console

Save that password immediately. Only its Argon2id hash is stored.

### Using an existing PostgreSQL server

Create a database and a dedicated user, then update the `DB_*` values in `.env`:

```sql
CREATE USER iris WITH LOGIN PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE iris OWNER iris;
```

The commands must be run by a PostgreSQL administrator. The configured database
must already exist and the application user must own it, or otherwise have
permission to create and alter tables and indexes. Iris does not create the
database itself.

## Running with Docker Compose

Create `.env` and generate the three required secrets:

```sh
cp .env.example .env
for name in IRIS_SECRET DB_PASSWORD POSTGRES_ADMIN_PASSWORD; do
  printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
done
```

Replace the corresponding blank lines in `.env` with the generated lines, then
start both services:

```sh
docker compose up --build
```

The application is available at
[http://localhost:3000](http://localhost:3000). PostgreSQL data and project files
are stored in the named volumes `postgres-data` and `project-data`. Both
published ports listen on localhost only; place a reverse proxy on the same host
in front of Iris when exposing it externally.

PostgreSQL initialization variables only apply when the data directory is empty.
If `postgres-data` already exists, update the existing database user's password
before changing `DB_PASSWORD`. For disposable development data, you can instead
recreate the volume with `docker compose down -v`, which permanently deletes
the database and project volumes.

To retrieve the initial administrator password from a detached deployment:

```sh
docker compose logs webapp | sed -n '/Iris initial admin account created/,+5p'
```

### Compiler availability in containers

The application image deliberately does not bundle TeX or LilyPond. The sample
Compose configuration declares compiler paths, but you must either:

- mount compatible compiler installations into the container; or
- build a derived image that installs the required toolchains.

The commented volume examples in `docker-compose.yml` show the intended mount
points. Adjust them to the layout of your compiler installation.

When `TEX_PATH_LOCKED=true` or `LILYPOND_PATH_LOCKED=true`, the corresponding
path remains visible in project settings but cannot be changed from the browser.
This is useful when the deployment controls compiler locations centrally.

## Working with projects

### Concurrent saves

Projects expose a server-owned integer `revision`, introduced by migration `015`.
Saving a whole-project snapshot requires its `baseRevision`; name-only updates
use the same precondition without replacing the file tree. Missing or malformed
preconditions return `428 PROJECT_REVISION_REQUIRED`; stale snapshots return
`409 PROJECT_REVISION_CONFLICT` before changing files or metadata. Successful
snapshot saves advance the revision, including the save phase of compilation.
Realtime text flushes and checkpoints without a submitted tree do not advance it.

The browser serializes its mutations and retains local edits on conflict. It does
not fetch a newer revision and blindly replay an older tree. Preserve local work
before explicitly discarding/reopening a conflicting project. Reload browser tabs
after upgrading so they use the revision-aware save protocol.

Backend mutations are serialized per project through their database transaction
and filesystem compensation. Required renames fail explicitly rather than
falling back to empty files; ambiguous chains, swaps and occupied destinations
are rejected. Handled pre-commit failures restore source bytes and the manifest.
An uncertain commit or failed compensation retains a backup below
`DATA_DIR/.project-backups/<project-id>` and blocks access with
`503 PROJECT_RECOVERY_REQUIRED`. Stop Iris and inspect both persistence layers
before repairing the project and removing that backup; restart after recovery.
This is not automatic crash recovery or multi-process filesystem coordination.

### Portable project archives

Every project card can download a ZIP archive. The archive keeps the project
directory structure, including sources, uploaded assets, fonts, empty folders,
and existing `output/` artifacts. It also contains `.iris/project.json`, a
versioned manifest with the project type, compiler settings, output format,
editor state, and compilation pipeline. Runtime caches below `.iris/` are not
exported.

The project chooser can import an archive previously exported by Iris. Import
creates a separate project with a new identifier and timestamps while restoring
the archived name, files, folders, and settings. The normal `MAX_BODY_MB`
request limit also applies to imported archives.

### LaTeX projects

A new LaTeX project starts with `main.tex` and a basic document template. The
selected compiler engine and pipeline are stored with the project.

The available pipeline presets are:

- **Quick:** one run of the selected engine.
- **BibTeX:** engine, BibTeX, then two additional engine runs.
- **Biber:** engine, Biber, then two additional engine runs.
- **Index:** engine, MakeIndex, then one additional engine run.
- **Custom:** up to twelve ordered steps using allowlisted tools and constrained
  TeX-engine arguments.

Custom pipeline arguments can use these placeholders:

| Placeholder | Value |
| --- | --- |
| `[engine]` | Selected LaTeX engine |
| `[main]` | Main source file path |
| `[jobname]` | Main filename without its extension |
| `[pdf]` | Expected PDF path below `output/` |

LaTeX processes run with `-no-shell-escape`, nonstop interaction, file-and-line
errors, and a forced `output/` destination.

Custom TeX-engine steps accept one relative project source filename (normally
`[main]`) and the options `-synctex=<integer>`, `-recorder`, `-draftmode`, and
`-8bit`. The backend-managed options may also be repeated with their exact
values: `-interaction=nonstopmode`, `-halt-on-error`, `-file-line-error`,
`-no-shell-escape`, and `-output-directory=output`. Both one- and two-dash forms
are accepted; abbreviations and other options are rejected before compilation,
including in saved or imported profiles. Inline TeX commands, format selectors,
and additional source operands are not accepted as pipeline arguments. BibTeX,
Biber, MakeIndex and LilyPond argument handling is unchanged. These restrictions
do not replace the process isolation described in the security notes below.

For XeLaTeX and LuaLaTeX, fonts uploaded through project settings are stored in
`fonts/` and exposed through `OSFONTDIR`. Iris also keeps a project-local TeX
cache in `.iris/texmf-var` and refreshes Fontconfig when available.

The font card's preview control only changes the sample shown in project
settings. It does not select a font for compilation; the document source remains
responsible for using the desired family. The uploaded-font list is reconciled
with the actual files below `fonts/`, so deleting or renaming one from the file
tree also updates project settings.

### LilyPond projects

A new LilyPond project starts with `main.ly`. Iris also recognizes an older
untyped project as LilyPond when it contains `.ly` sources and no `.tex` files.

LilyPond projects use a single constrained compiler step and support PDF, PNG,
SVG, PS, and EPS output. Multi-page or multi-score builds may produce multiple
artifacts. PDF, PNG, and SVG can be previewed in Iris; every format remains
available in the file tree and as a download.

Additional LilyPond arguments can be entered in project settings. Quoted values
are preserved as one argument, but Iris removes user-provided output and format
overrides so that artifacts always remain in the managed `output/` directory and
use the selected project format.

Fonts uploaded through project settings remain project-local in `fonts/`. When a
LilyPond project is compiled, Iris exposes the project root through
`XDG_DATA_HOME`, allowing Fontconfig to discover the `fonts/` directory. The
score remains responsible for selecting the desired font family; no font is
installed in the host or container.

## Authentication

### Local accounts

Local passwords are hashed with Argon2id. The first administrator is created
only when the user table is empty; Iris does not repeatedly promote a username
or email address on later startups.

Iris has no public sign-up or account-management interface. Additional users
must currently be provisioned externally or created through OIDC
auto-registration.

Argon2id costs can be configured with:

```env
ARGON2_MEMORY_COST=65536
ARGON2_TIME_COST=3
ARGON2_PARALLELISM=1
```

`ARGON2_MEMORY_COST` is expressed in KiB.

### OAuth 2.0 / OpenID Connect

Iris supports a generic OIDC login flow. It can discover endpoints from an
issuer URL or use explicitly configured authorization, token, and user-info
endpoints.

Minimal issuer-based configuration:

```env
APP_BASE_URL=https://iris.example.com
OAUTH_ISSUER_URL=https://auth.example.com/application/o/iris
OAUTH_CLIENT_ID=iris
OAUTH_CLIENT_SECRET=replace-with-the-client-secret
OAUTH_SCOPE=openid email profile
OAUTH_CLIENT_AUTH_METHOD=client_secret_basic
OAUTH_AUTO_REGISTER=false
```

Register this callback with the identity provider:

```text
https://iris.example.com/api/auth/sso/callback
```

Set `OAUTH_REDIRECT_URI` when the callback cannot be derived from
`APP_BASE_URL`. Without `OAUTH_ISSUER_URL`, configure
`OAUTH_AUTHORIZATION_URL`, `OAUTH_TOKEN_URL`, and `OAUTH_USERINFO_URL`
directly.

OIDC identities are matched to local users by normalized email address. With
`OAUTH_AUTO_REGISTER=false`, the matching local user must already exist. With
auto-registration enabled, Iris creates a `user` account without a local
password. Existing users retain their current role.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_BASE_URL` | request origin | Public application URL used to build the callback. |
| `OAUTH_ISSUER_URL` | empty | OIDC issuer used for discovery. |
| `OAUTH_AUTHORIZATION_URL` | empty | Explicit authorization endpoint. |
| `OAUTH_TOKEN_URL` | empty | Explicit token endpoint. |
| `OAUTH_USERINFO_URL` | empty | Explicit user-info endpoint. |
| `OAUTH_CLIENT_ID` | empty | OIDC client identifier. |
| `OAUTH_CLIENT_SECRET` | empty | OIDC client secret. |
| `OAUTH_REDIRECT_URI` | derived | Explicit callback override. |
| `OAUTH_SCOPE` | `openid email profile` | Requested scopes. |
| `OAUTH_CLIENT_AUTH_METHOD` | `client_secret_basic` | Token endpoint authentication; `client_secret_post` is also supported. |
| `OAUTH_AUTO_REGISTER` | `false` | Create missing users from verified OIDC profiles. |

## Configuration reference

All settings are read from environment variables. When launched from the
repository, Iris also loads a root-level `.env` file without overwriting values
already present in the process environment.

### Application and storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `IRIS_SECRET` | none | Required secret used to sign sessions and OAuth state. |
| `DATA_DIR` | `./data/projects` | Root directory for project files. |
| `PUBLIC_DIR` | `./public` | Static frontend directory. |
| `MAX_BODY_MB` | `25` | Maximum JSON request body size in MiB. |
| `PROJECT_DOWNLOAD_TIMEOUT_MS` | `30000` | Hard source-file transfer deadline; a stalled receiver cannot indefinitely block the project's mutations. |
| `COOKIE_SECURE` | `false` | Set `true` when Iris is served over HTTPS. |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy that rewrites `X-Forwarded-For`, so audit events record the client address instead of the proxy. |
| `MAINTENANCE_FILE` | `DATA_DIR/.maintenance` | Path whose presence puts Iris into maintenance mode: writes are refused, reads continue. |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | How long a graceful shutdown waits for in-flight requests before forcing connections closed. |

### Realtime collaboration

| Variable | Default | Purpose |
| --- | --- | --- |
| `COLLAB_FLUSH_MS` | `2000` | Idle delay before a document edited in realtime is written to disk. |
| `COLLAB_FLUSH_MAX_MS` | `15000` | Longest a continuously edited document may go unwritten. |
| `COLLAB_REVISION_IDLE_MS` | `120000` | Quiet period after which realtime edits are consolidated into one revision. |
| `COLLAB_HEARTBEAT_MS` | `30000` | Ping interval used to drop connections whose peer vanished. |
| `COLLAB_MAX_MESSAGE_BYTES` | `4194304` | Maximum size of a single collaboration message. |
| `COLLAB_PUSH_DEBOUNCE_MS` | `300` | How long a browser batches keystrokes before sending them. Served to the client through `/api/config`. |
| `COLLAB_PRESENCE_DEBOUNCE_MS` | `200` | How long a browser batches cursor moves before reporting them. |

Typing is always instant locally: the two debounce values only decide how often a
browser talks to the server. Raising them lowers the message rate on a busy
installation at the cost of a slightly later appearance on other screens; keeping
the total round trip under about a second is what makes editing feel shared.

### Database

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_HOST` | `127.0.0.1` | PostgreSQL host. |
| `DB_PORT` | `5432` | PostgreSQL port. |
| `DB_USER` | `iris` | PostgreSQL user. |
| `DB_PASSWORD` | none | Required non-default PostgreSQL application password. |
| `DB_NAME` | `iris` | PostgreSQL database. |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | PostgreSQL connection timeout. |

`POSTGRES_ADMIN_PASSWORD` is also required by the supplied Compose configuration
and initializes the PostgreSQL `postgres` account. A startup script uses
`DB_PASSWORD` to create `iris` as `NOSUPERUSER`, `NOCREATEDB`, and `NOCREATEROLE`.
The web application receives only the restricted `iris` credential.

### Compilers

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEX_BIN_PATH` | empty | Directory containing LaTeX-related executables; an empty value uses `PATH`. |
| `TEX_PATH_LOCKED` | `false` | Prevent projects from overriding the LaTeX binary directory. |
| `LILYPOND_BIN_PATH` | empty | Directory containing `lilypond`; an empty value uses `PATH`. |
| `LILYPOND_PATH_LOCKED` | `false` | Prevent projects from overriding the LilyPond binary directory. |
| `COMPILE_TIMEOUT_MS` | `30000` | Maximum duration of each compiler step. |
| `COMPILE_LOG_LIMIT` | `1048576` | Maximum captured log size in bytes. |
| `BUILD_ARCHIVE_MAX_MB` | `128` | Maximum aggregate build-file size buffered into one ZIP download. |
| `BUILD_ARCHIVE_MAX_ENTRIES` | `10000` | Maximum number of files and directories in one build ZIP. |
| `PROJECT_ARCHIVE_MAX_MB` | `256` | Maximum aggregate project size buffered into one portable ZIP export. |
| `PROJECT_ARCHIVE_MAX_ENTRIES` | `20000` | Maximum number of files and directories in one project ZIP. |

The OIDC and Argon2id variables are documented in their respective sections
above and listed together in [`.env.example`](.env.example).

## Persistence and backups

Each project is stored below `DATA_DIR` in a directory derived exclusively from
its immutable project id. Its layout is broadly:

```text
DATA_DIR/
└── projects/
    └── <project-id>/
        ├── .iris/
        │   ├── project.json
        │   └── texmf-var/
        ├── fonts/
        ├── output/
        │   └── <build-id>/
        ├── main.tex or main.ly
        └── other project files and folders
```

`project.json` stores editor state, the project tree, and compilation settings;
it does not duplicate source file contents. Uploaded assets and fonts remain
ordinary files.

The directory name carries the project id and nothing else. Ownership lives only
in the database, so it can change without moving any data. `projects.storage_path`
records the location relative to `DATA_DIR`, which keeps a dump restorable next
to a filesystem backup mounted at a different path.

Each source file also has a stable identity in `project_files`: a UUIDv7 that
survives renames and moves, so history can be keyed to a file rather than to its
path. The database is authoritative for this identity; on every save the server
reconciles the tree against the ledger, updating a row's path on a rename and
soft-deleting a removed file so its history is never erased. On a rename the bytes
are moved on disk rather than rewritten. A project's files are populated in the
ledger on its first save after this schema is applied.

### File history and rollback

Text source files carry a revision history in `document_versions`, anchored to the
stable file id. A revision is captured on a compilation and on an explicit
checkpoint, and only when the content actually changed since the file's previous
revision, so the history stays meaningful rather than recording every keystroke.
Binary assets are not document revisions. Generated output has a separate,
build-oriented history described below. Inline document history is limited to
text files of at most 16 MiB.

History is append-only. A rollback does not delete the revisions in between: it
first snapshots the current server-authoritative text, including accepted edits
not yet flushed to disk, then writes the chosen revision back to the file and
records it as a new `rollback` revision. Each
revision is attributed to a user, and the attribution — like the audit trail —
outlives a deleted account through a denormalized label. Deleting a project
cascades its history away; soft-deleting a file keeps it.

File deletion also captures changed, versionable text before pruning its bytes.
An unreadable existing file aborts the destructive operation; an already-absent
file does not prevent filesystem refresh or restoration from its history.
Push admission, snapshots and filesystem changes share the project gate, so an
edit cannot be acknowledged midway through a destructive transaction and then
erased. Room changes and restore notifications occur only after confirmed commit.

The relevant endpoints are `POST /api/projects/:id/checkpoint`,
`GET /api/projects/:id/files/:fileId/versions`,
`GET …/versions/:versionId` for a revision's content, and
`POST …/versions/:versionId/restore`. Retention and garbage collection of old
revisions are deferred to a later phase.

### Versioned build outputs

Each compilation has an immutable UUIDv7 build id. The compiler runs in a private
workspace below `DATA_DIR/.build-staging/`. After the save commits, Iris copies
the effective source bytes into it while still holding the project gate. Omitted
payloads retain their saved text, binary assets and fonts; accepted room text is
already authoritative in that save. Prior output and unrelated runtime caches
are not copied. Once the snapshot is complete, compilation runs outside the gate,
so later edits cannot change its inputs. On success, the generated directory is moved atomically to
`output/<build-id>/`; a failed build keeps its diagnostics in PostgreSQL but does
not publish partial artifacts.

Main-file selection uses effective saved content and normalized paths for the
project's source type. Snapshot and compile-checkpoint reads are strict: missing
or unreadable expected inputs fail setup rather than produce empty or incomplete
build sources. An error after the save committed still reports `savedRevision`;
an error before commit does not acknowledge a save. Partial staging is cleaned up.

`build_outputs` stores status, author, compiler, format, source file and revision,
duration, diagnostics, aggregate size and hash. `build_artifacts` stores the
one-or-many previewable artifacts and their individual hashes. Compile revisions
and source hashes are read from the staging snapshot, never a newer live room.
If the main source is too large or cannot be represented losslessly as UTF-8 text
in document history, the build retains its raw source content hash while
`source_revision_id` remains empty. Composite foreign keys prevent a build from
referencing a source file or revision belonging to another project.

The build detail also scans the immutable build directory and exposes every
safely addressable regular generated file, including MIDI and LaTeX
bibliography/auxiliary products.
These safely addressable files are deliberately separate from the preview artifact registry, so
opening a PDF does not load the whole build into browser memory. Symlinks and
special filesystem entries, plus names containing ambiguous path separators, are
never exposed or archived. ZIP generation is bounded by `BUILD_ARCHIVE_MAX_MB`
and `BUILD_ARCHIVE_MAX_ENTRIES`. The physical `output/`
directory remains storage-only and is not shown in the editor's source tree.

The build endpoints are:

- `GET /api/projects/:id/builds` for the paginated chronological list and latest
  successful id (`limit` and `offset` are optional);
- `GET /api/projects/:id/builds/:buildId` for diagnostics, preview artifacts and
  metadata for every file in the published build directory;
- `GET /api/projects/:id/builds/:buildId/artifacts/:artifactId` for inline preview;
- the same artifact endpoint with `?download=1` for download;
- `GET /api/projects/:id/builds/:buildId/files/download?path=...` to download any
  regular file from that immutable build;
- `GET /api/projects/:id/builds/:buildId/archive` to download the complete build
  directory as a ZIP archive;
- `DELETE /api/projects/:id/builds/:buildId` for owner-authorized deletion.

Project members with read access can list, inspect, preview and download builds.
Only owners can currently delete them; editor deletion can be enabled later by a
dedicated project setting. Automatic retention and garbage collection remain a
later hardening task. A `running` row left by a process interruption can be
deleted after restart; automatic crash reconciliation remains part of hardening.
Files produced before migration `012` remain directly below `output/` as readable
legacy output; they are preserved but are not backfilled into the build registry.

Back up PostgreSQL and `DATA_DIR` together: the database holds accounts,
ownership and the audit trail, while the filesystem holds the content itself.

### Maintenance window for backup and restore

A consistent backup requires that no write lands between the database dump and
the filesystem copy. Iris provides two mechanisms so the operator controls that
window; it intentionally does not prescribe a dump, snapshot or copy tool.

**Maintenance mode** is a reversible, no-restart window. When the file named by
`MAINTENANCE_FILE` (default `DATA_DIR/.maintenance`) exists, every request that
would write is refused with `503`, while reads keep working. Create the file,
wait for in-flight writes to drain, take the backup, then remove it:

```sh
touch "$DATA_DIR/.maintenance"
# Wait until no write is still in progress:
while [ "$(curl -sf localhost:3000/api/health | jq .pendingWrites)" != "0" ]; do sleep 1; done
# Back up both layers at a mutually consistent point, then reopen writes:
rm "$DATA_DIR/.maintenance"
```

`GET /api/health` needs no authentication and reports
`{ "status", "maintenance", "pendingWrites" }`, so a script or load balancer can
observe the state. `pendingWrites` counts write requests still being served; once
it reaches `0` inside the window, the two layers can be copied consistently.

Direct control through `MAINTENANCE_FILE` is the transitional operator interface.
When server roles and the administration console are introduced, entering and
leaving maintenance will become an authenticated, audited action reserved for
active Iris administrators; backup and restore tooling will remain outside Iris.

**Graceful shutdown** covers a clean stop, which is the safe way to restore.
On `SIGTERM` or `SIGINT` Iris stops accepting requests, waits up to
`SHUTDOWN_TIMEOUT_MS` for in-flight requests to finish, closes the database pool
and exits. Restore both layers while the process is down, then start Iris: it
reconciles pending migrations and relocations on startup.

A backup taken inside maintenance mode may include the `.maintenance` marker. If
it does, a restored instance starts in maintenance — a safe default that lets you
verify the restore before reopening writes. Remove the marker to resume.

Keep Iris stopped until both persistence layers have been handled. After a
restore, run `npm run migrate:storage` while the application is still stopped,
then start Iris and verify that every project listed by the application opens.

Databases created before this layout stored absolute paths under a per-user
directory. Migration `002` rewrites those rows and Iris relocates the
directories on the next startup. To do it during a maintenance window instead,
run the same step with the server stopped:

```sh
npm run migrate:storage
```

It is safe to repeat. A missing legacy directory remains pending so a temporarily
unavailable mount can be retried later. Same-filesystem moves are atomic; the
cross-filesystem fallback compares directory structure, file sizes and SHA-256
content hashes before removing the source. If an interrupted copy leaves data at
both locations, the command stops and names the project for manual comparison
rather than guessing which copy to keep.

## Project sharing

A project is shared through memberships, each carrying a **project role**
independent of the server role:

| Role | Read / download | Edit | Compile | Manage sharing | Delete project |
| --- | :---: | :---: | :---: | :---: | :---: |
| Owner | yes | yes | yes | yes | yes |
| Editor | yes | yes | yes | no | no |
| Viewer | yes | no | no | no | no |

Membership is the single authority for access: `project_members` decides who may
do what, and `projects.created_by` is kept only as historical provenance.
Endpoints check the required capability on every request, so a permission change
takes effect immediately — a removed collaborator loses access on their next
request. A non-member cannot tell a project apart from one that does not exist
(the API answers `404`), while a member attempting an action above their role is
told plainly (`403`). A server admin gets no automatic access to project contents.

Projects can have several owners, with an invariant mirroring the last-admin rule:
at least one owner always remains, so the last owner cannot be demoted or leave.
Promoting someone to owner is an explicit, owner-only action. Sharing changes are
recorded in the audit trail.

From the in-project sharing console, owners search active accounts by partial
username or email and can inspect display name, username and email before choosing
a role. The effective grant always references the user's immutable id. If no
account matches, the owner is asked to have an administrator provision one — there
are no public links and no pending invitations for strangers in this release.

The sharing endpoints are `GET/POST /api/projects/:id/members`,
`GET /api/projects/:id/members/search?q=...` and
`PATCH/DELETE /api/projects/:id/members/:userId`. They require the project owner
capability; the last owner cannot demote or remove themselves.

### Realtime collaboration

Members who open the same text file edit it together. Changes are exchanged over
an authenticated WebSocket at `/api/collab` and reconciled with **operational
transformation**, using the primitives of `@codemirror/collab` in the browser and
a matching authority on the server.

The server is the single authority. It holds the document and a version number,
and accepts a client's changes only when they are based on that version; a client
that is behind pulls what it missed, rebases its own pending edits on top and
retries. Because the order is decided in one place, permissions, revocation and
history stay under server control — which is why OT was chosen over a CRDT. The
trade-off accepted is that robust offline editing is not supported.

Accepted updates are sent to every replica, including their author, before the
push acknowledgement. Broadcasts and pull replies share one version-indexed
stream: the browser discards already-applied prefixes and catches up missing
ranges before sending further edits. Delayed replies from obsolete sockets or
file openings cannot replace the current session.

What this changes for a document being edited live:

- Persistence belongs to the server, not to a save action. The text is written to
  disk shortly after typing pauses, and at least every `COLLAB_FLUSH_MAX_MS`
  while it does not. A burst of live edits later becomes a single `realtime`
  revision in the file history rather than one revision per keystroke.
- A save no longer risks overwriting a collaborator. A client sends the content
  of the files it actually edited; for the rest the bytes on disk are kept, and a
  file with a live session is always written from the server's authoritative text.
- Losing write access mid-session takes effect at once: the workspace becomes
  read-only in place. Losing membership closes the session immediately.
- A rollback moves every participant onto the restored text.
- The status bar shows the state of the session for the open file.

Renaming a live file updates its room's path without resetting the OT stream.
Deleting it closes only that file's session and cancels pending persistence; other
files and project-wide build notices remain available. The browser retains the
unavailable file's buffer for copying and locks it against further local changes,
including Format and Replace. Unconfirmed local text stays protected as unsaved
work until an explicit discard/reload; deletion never falls back to an ordinary
save that could recreate the file.

A file can only join a session once it has a canonical id, so a document created
in the current session becomes collaborative after its first save. Binary assets
are never shared this way, and a viewer receives changes without being able to
send any. On a dropped connection the client reconnects with exponential backoff
and resumes from the version it still holds; if the server has already trimmed
that far back in its update log, it sends the whole document instead.

### Presence and overlap

While a document is shared, the status bar names the other members editing it,
each with a stable colour derived from their account, and the editor marks the
lines they are working on with that colour — a bar beside the line and a faint
tint on it. The same person in two tabs is one entry in the list and two marks in
the document, because that is what is actually true.

When someone else is working on your line or the one either side of it, the
indicator turns to a warning naming them. It is deliberately advisory and blocks
nothing: operational transformation already guarantees that no keystroke is lost,
but it cannot tell whether two people changing the same bar of music or the same
command agree about the result. That judgement stays with the people involved,
which is also why the file history exists.

Presence is ephemeral. It is never written to the database, never versioned and
never replayed: it lives only on the open connections of a document, and it is
visible only to members who could already read that file. Positions follow the
text as it changes, and a participant who disconnects simply disappears from the
list.

Remaining work for a later phase: structural awareness (naming the LaTeX
environment or LilyPond `score` two people share, rather than the line number).

### Compilation notices

A compilation is a project-wide event, so a tab follows the project it has open
regardless of which document it is editing. When any member's build finishes, a
notice appears above the preview of everyone whose preview is older, with a
button that loads the most recent finished build — the button exists only while
that notice does. A failed build is announced too: it is still newer than what is
on screen, and its log is what the author will want to talk about.

The notice is driven by what is on screen rather than by who compiled, so it
stays silent for your own compilation, and it appears if you open a project whose
preview is already behind. The message carries only the fact that a build
finished and who caused it; the output itself is fetched through the same
authorized route as always, so the socket never becomes a second way to read a
build. Dismissing the notice leaves the preview alone.

## Server administration

Iris distinguishes two authorization levels. The **server role** (`admin` or
`regular`) governs account management, while the project role governs project
contents. A server admin is not automatically granted access to any project's
contents.

Admins manage the ordinary account lifecycle over `/api/admin/users`, so it no
longer requires direct database access:

- `GET /api/admin/users` — list, with `q`, `status` and `role` filters.
- `POST /api/admin/users` — create a local account; a one-time temporary password
  is returned and only its Argon2id hash is stored.
- `PATCH /api/admin/users/:id` — update the profile, promote/demote the server
  role, or deactivate/reactivate the account.
- `POST /api/admin/users/:id/reset-password` — issue a new one-time password for a
  local account and end its existing sessions.

Accounts are **deactivated, not deleted**, in this release: a disabled account
loses access immediately while its projects, history, attributions and audit are
preserved, and it can be reactivated. Physical deletion, which requires
transferring or anonymizing owned content, is deferred.

Two invariants are enforced: at least one active admin must always remain (the
last one cannot be demoted or disabled, including by themselves), and role or
status changes take effect on live sessions at once. Because sessions are stateless
tokens validated against the database on every request, a demotion applies on the
next request without a forced logout, while a deactivation or a password reset ends
existing sessions immediately. Every administrative change is written to the audit
trail.

Sessions carry the account's integer `session_version`, which is incremented
atomically on deactivation, password reset or change, and local/SSO conversion.
Older cookies are rejected even when both operations occur in the same second;
a successful password change issues a replacement cookie only to that client.
Migration `014` introduces this check, so users must sign in again after upgrading
from an earlier schema.

Account revocation through Iris closes existing collaboration sockets immediately.
WebSockets also validate the account on each message and heartbeat, and expire
without waiting for new activity. Out-of-band account changes are detected on
the next message or heartbeat (`COLLAB_HEARTBEAT_MS`, 30 seconds by default).
Accounts awaiting a mandatory password change cannot open a collaboration socket.
Joins and upgrades already waiting on I/O cannot retain revoked access.

For OIDC accounts, Iris does not replace the identity provider: the durable
identity is the `issuer` + `subject` pair, and email is only a searchable
attribute. The console governs the account's server role and enabled state, while
name and credentials may remain under the provider.

## Audit trail

Administrative and destructive actions are appended to the `audit_events` table:
sign-ins and failed sign-in attempts, account creation, role and status changes,
password changes and resets, project creation, import and deletion, sharing
changes (add, role change, removal, leaving), and file checkpoints and rollbacks.

Each event records the action, its outcome, the actor, the target, the client
address and a small JSON object of context. Attribution is meant to outlive the
account: removing a user clears the foreign key but keeps the event and the
readable actor label, so deactivating or deleting an account never rewrites
history. Metadata holds bounded scalars only and never credentials.

There is no console for browsing the trail yet, and no automatic retention. On a
long-lived instance the table grows mainly through failed sign-in attempts, so
plan for pruning before it matters:

```sql
SELECT occurred_at, action, outcome, actor_label, target_type, target_id, ip
FROM audit_events ORDER BY occurred_at DESC LIMIT 50;
```

## Security notes

Iris applies several boundaries to compilation:

- Compiler processes are spawned directly without a shell.
- Custom pipelines accept only known tools.
- LaTeX always runs with `-no-shell-escape`.
- Compiler processes receive a reduced environment without backend database or
  authentication secrets.
- Output paths and LilyPond format overrides are controlled by the backend.
- The application container runs as a non-root user and the sample Compose
  service uses a read-only root filesystem, a temporary `/tmp`, dropped Linux
  capabilities, and `no-new-privileges`.

These controls do **not** make arbitrary LaTeX or LilyPond input safe. LilyPond
embeds Guile, and document compilers are complex native programs. A public or
multi-tenant deployment should run compilation in a separate disposable worker
or container with strict CPU, memory, time, filesystem, and network limits.

For a production deployment, also:

- use HTTPS and set `COOKIE_SECURE=true`;
- place Iris behind a properly configured reverse proxy;
- generate unique `DB_PASSWORD` and `POSTGRES_ADMIN_PASSWORD` values;
- restrict PostgreSQL to the application network instead of publishing it;
- keep session, database, and OIDC secrets outside version control; and
- back up and test restoration of both persistence layers.

## Development

Run the test suite with:

```sh
npm test
```

Database migrations live in `db/migrations/` and are applied atomically at
startup. Applied filenames and SHA-256 checksums are recorded in
`schema_migrations`; never edit a migration that has already shipped—add the
next numbered SQL file instead.

### Identifiers

Every persistent entity is identified by a **UUIDv7** (RFC 9562), generated by
the application through [`src/ids.js`](src/ids.js). The 48-bit timestamp prefix
makes identifiers sort by creation time, which keeps primary key inserts local in
the index instead of scattering them the way version 4 does.

Three rules go with it:

- **Never `crypto.randomUUID()` for an entity id.** Node has no UUIDv7 generator:
  it returns version 4 and *silently ignores* a `{ version: 7 }` option, so the
  mistake does not announce itself. `src/ids.js` lays out the bytes directly.
- **Never a column default.** Identifiers are generated before the INSERT because
  they are needed first—a project id names its storage directory. PostgreSQL 18
  offers `uuidv7()`, but relying on it would both raise the required server
  version and break that ordering.
- **An identifier is not a secret.** UUIDv7 embeds a timestamp and carries 74
  random bits. Session tokens, OAuth state and any future invitation or reset
  token stay opaque `crypto.randomBytes` values.

One deliberate exception: `audit_events.id` remains a `BIGINT` identity. It is
append-only, never exposed in a URL and never referenced by another table, so the
narrower key is worth more there than uniformity.

The PostgreSQL integration test creates and removes an isolated schema in a
real test database. The configured user therefore needs `CREATE` permission on
that database:

```sh
TEST_DATABASE_URL=postgresql://iris:password@127.0.0.1:5432/iris \
  npm run test:integration
```

Repository layout:

```text
public/   browser UI and frontend assets
src/      Node.js HTTP server, API, persistence, and compiler orchestration
db/       versioned PostgreSQL migrations
scripts/  maintenance commands run outside the request path
test/     Node.js test suite
data/     local project data, excluded from Git
```

## License

Iris is distributed under the GNU General Public License v3.0 or later. See
[`LICENSE`](LICENSE) for the complete terms and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled third-party
components.

## Scope, and a note on how Iris was built

Iris is meant to stay simple, and to keep its ambitions modest. It is **not** a
WYSIWYG editor and does not try to become one: no snippet libraries, no shortcut
cheat sheets, no buttons that drop in ready-made constructs. It bets instead on
compatibility, speed, being yours to self-host, and the plain convenience of
having editing, compilation, fonts, attachments and preview together on a single
web page.

And yes — Iris was vibe coded, though *agentic coding* is the more honest name
for it. That label gets dismissed a lot, and usually unfairly: done carelessly
it shows, but done with care it is simply another way to write software. This
codebase is reviewed, cross-checked across more than one model, and tested. And,
not least, it is used by me — who, for what it's worth, is exactly the person
who wanted it to exist.
