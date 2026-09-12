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

> **Release status:** Beta 2 (`1.0.0-beta2`)

> **Beta software and stability:** Iris is provided **as is**, without warranty,
> as described in the [GNU GPL v3](LICENSE). This is a
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
  downloads, renaming, deletion, and an indicator for the main compilation source.
- A CodeMirror 6 source editor with syntax highlighting, document outline,
  search and replace, formatting, optional word wrapping, and configurable
  autosave.
- Enter completes LaTeX environments and LilyPond `{ … }` / `<< … >>` blocks,
  placing the caret inside and following the auto-indent preference.
- Contextual autocompletion for LaTeX commands, environments, labels and citations,
  and LilyPond commands, contexts and variables, with automatic curly-brace pairs.
- Realtime collaborative editing of the same document by several members, with
  the server as the single authority that orders concurrent changes.
- Presence for the open file: who else is editing it, where their cursors and
  selections are, and a non-blocking warning when two people are inside the same
  LaTeX environment, section or LilyPond block; the file tree and the outline
  mark where in the project everyone else is working.
- A notice in the preview when another member has compiled something newer, with
  a one-click load of the most recent build.
- Server-side LaTeX compilation with `pdflatex`, `xelatex`, or `lualatex`.
- Built-in LaTeX pipelines for quick builds, BibTeX, Biber, and indexes, plus
  constrained custom pipelines.
- Server-side LilyPond compilation to PDF, PNG, SVG, PS, or EPS.
- An integrated PDF.js viewer, zoomable image preview, compiler log, warnings,
  errors, build duration, and downloadable artifacts.
- Preview refreshes retain the page and reading position for PDFs and LilyPond
  image outputs.
- Clickable LaTeX and LilyPond diagnostics with source-line navigation and editor
  gutter messages, including diagnostics from saved builds.
- Project-local font uploads, including XeLaTeX and LuaLaTeX font discovery.
- Local password authentication and optional OAuth 2.0/OpenID Connect SSO.
- Localized interface with English as the default and Italian included.

Iris does not currently provide Git integration or a hosted compilation service.
It is designed to run on infrastructure you control.

## Editor completion

Suggestions appear while typing a command or a supported argument. Press
**Ctrl+Space** to request suggestions, use the arrow keys to choose one, and
accept with **Enter** or **Tab**. **Escape** dismisses the list.

LaTeX references use labels from the project's TeX sources, and citations use
keys from its `.bib` files. Project-defined macros and environments, and
LilyPond variables in `.ly` and `.ily` files, also contribute suggestions.

Under **Settings → Editor → Custom completion commands**, add one command name
per line in the LaTeX or LilyPond list. The leading backslash is optional.
Each language accepts up to 200 commands, with at most 80 characters per name.
Apply the lists and save the project to share them with collaborators; these
settings also travel with project ZIP exports and imports.

## Bibliography editor

Open a UTF-8 BibTeX/BibLaTeX (`.bib`) or RIS (`.ris`) source to read its references
in **Table** view. Iris also recognizes bibliography content in ordinary text
files. **Text** reveals the same CodeMirror document for editing; switching views
does not rewrite the file, discard undo history, or send collaboration updates.
Each reference has a **Show source** action that selects its exact source range.

Iris initially shows every populated field, including custom fields and fields
outside the usual entry-type metadata. Use **Columns** to hide individual fields
and **Show all** to recover them, even after hiding everything. Column choices
last for the project/file in this browser session and do not enter project saves.
Search includes hidden fields, and the column choices cover the entire file even
while searching or changing pages. Iris sorts and searches before pagination:
each page contains up to 100 references, with previous/next controls and totals.
Narrow editor panels use cards instead of a horizontally scrolling table. Long
values have keyboard-accessible disclosures with selectable full text.

Use **Add**, including in an empty bibliography of a known format, or
select one reference to **Edit** or **Remove** it. The shared add/edit form shows
the entry type, BibTeX citation key, main fields, and an **Other fields** section.
Labels include native field names and occurrence numbers for repeated fields.
You can add fields by native name, including custom fields and repeated RIS tags,
or remove individual editable occurrences. Changing type retains existing fields;
dates and numbers stay text so you can keep leading zeros and punctuation.
Complex BibTeX expressions, including macros and concatenations, remain read-only
in the form with access to **Text** for source editing.

Form input stays in a draft until **Apply** validates the resulting document and
updates the current CodeMirror buffer in one undoable transaction. Apply does not
confirm a server save: changes use the existing collaboration and project
save/autosave flow, with no separate bibliography store. An unchanged Apply,
including an unchanged multiline CRLF value, creates no transaction or dirty
state. Edits preserve untouched source, comments, field order and delimiters;
additions append a reference, and removal leaves comments outside its range.
**Undo** works from the table and retains concurrent peer edits. Removal requires
confirmation; changing a key/ID or removing a reference does not rewrite citations
or cross-references.

Cancel, Escape, ordinary dialog close, and source navigation ask before discarding
a changed draft. Edits outside the selected reference shift its tracked range.
Overlapping edits, replacement, reload/resync, or revoked write permission block
Apply and retain the draft with a conflict message; Iris does not search for a
matching key to retarget it. Pending analysis keeps the draft until you can retry
Apply. A save acknowledgement assigning a canonical ID to the same open file
preserves the draft and its mapped or conflicted state. Changing file/project,
leaving the app, or losing the source context closes the draft so it cannot apply
elsewhere. Add/edit/remove and undo follow current source permissions, including
viewer, maintenance, unavailable and read-only/generated-file restrictions.

Validation checks complete syntax, not whether a citation is academically correct
or accepted by a particular BibTeX/Biber style. Missing metadata, duplicates, and
unknown macros can produce warnings without blocking the table. Iris retains
native/custom fields, repeated RIS tags, directives, and raw expressions; it does
not expand macros, execute LaTeX or HTML, fetch reference URLs, or convert formats.
The form blocks invalid syntax and newly introduced duplicate BibTeX keys, while
allowing unrelated edits to entries with pre-existing duplicate keys. Iris does
not look up DOI or academic metadata.

A local Worker validates the buffer after an edit debounce. Initial recognition
while typing or pasting keeps the source visible and focused. An incomplete or
malformed file has diagnostics and no partial table. Empty files, files containing
only directives/comments, unrecognized text, and Worker failures have separate
states; a Worker failure offers retry. Corrections enable Table without switching
away from the source. Invalid UTF-8 or NUL-containing bibliography files show a
read-only explanation outside parsing and saving, preserving their original bytes.
Bibliography editing retains CRLF, bare CR, and UTF-16 coordinates used by realtime
collaboration; Enter inserts LF without normalizing the rest of the document.

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
to localhost only. On first startup, Iris initializes an empty application schema
from `db/schema.sql` and records its current version. See
[Fresh beta schema and incompatible installations](#fresh-beta-schema-and-incompatible-installations)
before using a database from another beta release.

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
permission to create tables and indexes in an empty application schema. Iris does
not create the database itself. Ordinary restarts require a matching schema
version and preserve the existing rows.

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

Projects expose a server-owned integer `revision`, starting at zero.
Saving a whole-project snapshot requires its `baseRevision`; name-only updates
use the same precondition without replacing the file tree. Missing or malformed
preconditions return `428 PROJECT_REVISION_REQUIRED`; stale snapshots return
`409 PROJECT_REVISION_CONFLICT` before changing files or metadata. Successful
snapshot saves advance the revision, including the save phase of compilation.
Realtime text flushes and checkpoints without a submitted tree do not advance it.

The browser serializes its mutations and retains local edits on conflict. It does
not fetch a newer revision and blindly replay an older tree. Preserve local work
before explicitly discarding/reopening a conflicting project. Reload browser tabs
after deploying a new client build.

Backend mutations are serialized per project through their database transaction
and filesystem compensation. Required renames fail explicitly rather than
falling back to empty files; ambiguous chains, swaps and occupied destinations
are rejected. Handled pre-commit failures restore source bytes and the manifest.
An uncertain commit or failed compensation retains a backup below
`DATA_DIR/.project-backups/<project-id>` and blocks access with
`503 PROJECT_RECOVERY_REQUIRED`. Stop Iris and inspect both persistence layers
before repairing the project and removing that backup; restart after recovery.
This is not automatic crash recovery or multi-process filesystem coordination.

Project deletion uses a current PostgreSQL receipt in `project_deletions`.
The server snapshots the owners, quarantines storage, and deletes project metadata
in one transaction. It revokes collaboration rooms after acknowledging `COMMIT`,
then marks the receipt `cleanup_ready` before removing quarantine bytes. Missing
source storage counts as an absent payload; other filesystem errors still fail.
An uncertain commit leaves a `prepared` receipt and requires operator inspection.
The server does not infer deletion from an unknown backup or an absent project row.

Both owner and admin DELETE routes return `{ok:true, cleanupPending:false}` after
cleanup. A confirmed deletion whose filesystem cleanup fails returns
`{ok:true, cleanupPending:true}`. A retry can finish partial cleanup. Historical
owners must authenticate with a current session on the owner route; admins must
use the admin route with current administrator authority. Other users receive
`404`. Authorized requests for `prepared` receipts receive
`503 PROJECT_RECOVERY_REQUIRED`. Readiness or completion database errors also
return recovery-required and retain the receipt for inspection or retry.

Completed receipts support repeated `200` responses without filesystem writes or
duplicate deletion audit events. A cleanup pass prunes them after seven days from
completion; retries then return `404`. Prepared and pending-cleanup receipts do
not expire. Startup resumes ready cleanup even with `RETENTION_ENABLED=false`;
the existing retention sweep also resumes it when enabled. Maintenance and shutdown
prevent new background cleanup work. The server leaves any ready receipt with a
live project row untouched for operator inspection.

This beta changes the database definition. Existing beta installations require an
explicit reset for the new baseline; Iris does not convert deletion receipts or
reset an installation on startup.

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

### Project templates

Iris stores the mutable instance catalog below `TEMPLATE_DIR` (by default
`DATA_DIR/templates`). Administrators create, edit, rename, move and delete
LaTeX and LilyPond templates from the **Templates** section of the Admin
dashboard; changes are available the next time the new-project dialog opens.
The files in `public/templates` seed a new instance once and are not used as its
mutable catalog afterward. See [`public/templates/README.md`](public/templates/README.md)
for placeholders, limits and storage details.

### LaTeX projects

A new LaTeX project starts with `main.tex` generated from the selected instance
template. The selected compiler engine and pipeline are stored with the project.

Project settings name the main source file passed to the compiler. Left on
**Automatic**, Iris detects it as before: the open file when it carries
`\documentclass` (a `\score` block for LilyPond), otherwise the first source
that does. Choosing a file fixes it for every compilation of the project,
whichever file is open. If that file is later renamed or deleted, settings keep
showing the stale choice and Iris falls back to detection until another one is
picked.

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
`APP_BASE_URL`. To override discovery, configure all three of
`OAUTH_AUTHORIZATION_URL`, `OAUTH_TOKEN_URL`, and `OAUTH_USERINFO_URL`
directly. `OAUTH_ISSUER_URL` is required for sign-in even with explicit endpoints:
it identifies the provider when Iris matches accounts.

Iris identifies an OIDC account by the configured issuer URL and the provider's
`sub` claim. A known identity can sign in to its active OIDC account even if its
email changes or the provider no longer reports verified email.

For an unknown identity whose email matches an existing account, an administrator
must open that account's one-time linking window (`oidcLinkPending`). The account
must be active and have neither an issuer nor a subject binding, and the provider
must return `email_verified` as the literal boolean `true`. Iris compares email
addresses case-insensitively. A successful link removes the local password,
clears any forced password change, closes the linking window and ends existing
sessions. Existing users retain their current role. A callback whose linking
preconditions change before the write is refused, including after a password
reset, email change, deactivation or competing link.

With `OAUTH_AUTO_REGISTER=false`, a user needs an existing OIDC identity or an
account eligible for the linking flow above. With auto-registration enabled, Iris
creates an account without a local password when neither identity nor email
matches. The verified-email requirement applies to linking an existing account;
it does not change the auto-registration policy.

Concurrent registrations can recover only the current active OIDC account with
the same issuer and subject. A collision on email or username alone cannot grant
access to the other account. Pending and disabled identities remain refused.

An auto-registered account is created *pending* unless
`OAUTH_APPROVAL_REQUIRED=false`: the row exists so an administrator can decide on
it, and the sign-in that created it is refused until they do. Approve or turn it
away from the users console, where pending accounts are their own status. Note
that deleting one is not a durable refusal — the same identity signing in again is
provisioned afresh — so refusing for good means leaving the account pending or
disabling it.

`OAUTH_DEFAULT_ROLE` decides what an approved newcomer may do. It accepts
`regular` or `external` only, never `admin`, and an unrecognised value stops the
server rather than falling back. Set it to `external` when the identity provider
is federated with people outside the organisation: they will be able to work on
projects they are invited to, but not to create projects or own one.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_BASE_URL` | empty (automatic) | Public HTTP(S) base URL: pins the origin for API writes and WebSocket upgrades and supplies the callback base, retaining its base path. No credentials, query or fragment; invalid nonempty values stop startup. A public URL pin is recommended for deployment. |
| `OAUTH_ISSUER_URL` | empty | Required for SSO sign-in; identifies the provider and supplies discovery unless endpoints are explicit. |
| `OAUTH_AUTHORIZATION_URL` | empty | Explicit authorization endpoint. |
| `OAUTH_TOKEN_URL` | empty | Explicit token endpoint. |
| `OAUTH_USERINFO_URL` | empty | Explicit user-info endpoint. |
| `OAUTH_CLIENT_ID` | empty | OIDC client identifier. |
| `OAUTH_CLIENT_SECRET` | empty | OIDC client secret. |
| `OAUTH_REDIRECT_URI` | derived | Explicit callback override. |
| `OAUTH_SCOPE` | `openid email profile` | Requested scopes. |
| `OAUTH_CLIENT_AUTH_METHOD` | `client_secret_basic` | Token endpoint authentication; `client_secret_post` is also supported. |
| `OAUTH_AUTO_REGISTER` | `false` | Create accounts for unknown OIDC identities whose email does not match an existing account. |
| `OAUTH_DEFAULT_ROLE` | `regular` | Server role for auto-registered accounts; `regular` or `external` only. |
| `OAUTH_APPROVAL_REQUIRED` | `true` | Create auto-registered accounts pending an administrator's approval. |

## Configuration reference

All settings are read from environment variables. When launched from the
repository, Iris also loads a root-level `.env` file without overwriting values
already present in the process environment.

### Application and storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `BIND_ADDRESS` | every interface | Single interface to bind, such as a private or VPN address. Leave empty in containers, where the published port controls exposure. |
| `IRIS_SECRET` | none | Required secret used to sign sessions and OAuth state. |
| `DATA_DIR` | `./data` | Root directory for project files, templates and server-managed working directories. |
| `PUBLIC_DIR` | `./public` | Static frontend directory. |
| `TEMPLATE_DIR` | `DATA_DIR/templates` | Mutable LaTeX and LilyPond project-template catalog. |
| `MAX_BODY_MB` | `25` | Maximum request body size in MiB, including JSON and raw ZIP imports. |
| `PROJECT_DOWNLOAD_TIMEOUT_MS` | `30000` | Hard source-file transfer deadline; a stalled receiver cannot indefinitely block the project's mutations. |
| `COOKIE_SECURE` | `false` | Set `true` when Iris is served over HTTPS. |
| `TRUST_PROXY` | `false` | Trust forwarded client addresses and, with an empty `APP_BASE_URL`, forwarded host/protocol. Enable only when the proxy overwrites or strips incoming `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`; preserve browser origin metadata. |
| `MAINTENANCE_FILE` | `DATA_DIR/.maintenance` | Path whose presence puts Iris into maintenance mode: writes are refused, reads continue. |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Deadline for the complete shutdown drain, including background/realtime work, direct compiler children and database-pool closure. |

### Admission control

Iris applies token-bucket rate limits and bounded FIFO work queues in each backend
process. Buckets refill continuously up to the configured burst allowance.

| Variables | Defaults | Scope |
| --- | --- | --- |
| `AUTH_RATE_LIMIT` / `AUTH_RATE_WINDOW_MS` | `10` / `60000` ms | Local login attempts per source IP, before reading the body. |
| `AUTH_ACCOUNT_RATE_LIMIT` / `AUTH_ACCOUNT_RATE_WINDOW_MS` | `12` / `900000` ms | Local login attempts per normalized submitted identifier, across source IPs. |
| `AUTH_FAILURE_PENALTY` | `4` | Total token charge for a failed login, including its initial admission token. |
| `PASSWORD_HASH_CONCURRENCY` / `PASSWORD_HASH_QUEUE` | `2` / `24` | Active Argon2 operations / waiting operations, shared by login, password changes, admin password operations and seeding. |
| `COMPILE_RATE_LIMIT` / `COMPILE_RATE_WINDOW_MS` | `30` / `300000` ms | Compile attempts per user/project pair, after project authorization. |
| `COMPILE_CONCURRENCY` / `COMPILE_QUEUE` | `2` / `8` | Active compilations / waiting compilations across users and projects. |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_MS` | `600` / `60000` ms | General authenticated API requests per user, across sessions. |

These settings accept positive integers (`>=1`); zero, negative, fractional or
invalid values fall back to the defaults. In particular, zero does not disable a
queue. Restart Iris after changing them.

For login, Iris trims and lowercases the submitted identifier and retains a
fixed-size SHA-256-derived limiter key. Long invalid identifiers therefore do not
enlarge individual retained keys. Username and email submissions for the same
user have separate budgets; casing and surrounding whitespace share a budget.
A successful login clears its IP and submitted-identifier debt. Forwarded client
IPs apply only with `TRUST_PROXY=true`.

Exhausted rate budgets return **429** (`AUTH_RATE_LIMITED`, `COMPILE_RATE_LIMITED`
or `API_RATE_LIMITED`) with positive, rounded-up seconds in `Retry-After` and
`params.retryAfter`. Full password or compile queues return **503** (`AUTH_BUSY`
or `COMPILE_SERVER_BUSY`) without a retry-duration estimate. A busy compile
refusal still spends its rate-admission token.

A waiting compile creates no save, staging tree, checkpoint or build row until
it gets a slot; Iris rechecks project permission at that point. The slot covers
the entire pipeline, publication and audit, then releases before staging cleanup.
Accepted HTTP work remains counted in `pendingWrites` through that cleanup.
Password operations release their slots when hashing/verification finishes.
Handled failures release capacity for queued or later work; shutdown refuses
queued work and drains admitted operations.

These limits apply to one process and reset on restart; multiple instances do
not share their budgets or queues. They bound admission, not total resident memory
(RSS), and do not constitute a load benchmark or an OS-level memory cap.

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

Multipass TeX builds keep the output of all executed steps in the log trace, but
select active diagnostics from the last complete successful pass with the same
engine and full normalized argument list. Different sources, engines or options
do not clear each other's warnings. A later complete successful pass also
supersedes earlier successful captures that were truncated. A truncated final
capture cannot clear prior observations. Auxiliary diagnostics (including BibTeX
and Biber), setup/publication errors, and observations from failed or interrupted
passes remain active. Final warnings retain their included-source
locations and revision references, whether bibliographic or not. The server
deduplicates and caps the selected diagnostics at 80 per severity; transient
first-pass warnings do not consume the final pass's allowance. A terminal
setup/publication cause takes priority within the error cap.

`build_outputs.diagnostics_version` is nullable. Finalized compiler builds use version `1`:
their structured JSONB warning/error arrays are authoritative even when empty,
so reopening a clean build does not recreate warnings from its trace. Startup
reconciliation of interrupted builds still writes diagnostics with `NULL` version;
the build reader supports those log/string-array diagnostics. Capture remains subject to `COMPILE_LOG_LIMIT`
per step and stored trace (1 MiB by default). A truncated capture cannot prove
that an earlier warning was resolved, and log recovery cannot recover output
beyond that limit.

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
Only owners can currently delete them. The retention sweep prunes surplus, old
builds while protecting the latest successful output and builds still running.
Startup reconciliation closes interrupted `running` builds after the configured
grace period when retention is enabled.

Back up PostgreSQL and `DATA_DIR` together: the database holds accounts,
ownership and the audit trail, while the filesystem holds the content itself.

### Maintenance window for backup and restore

A consistent backup requires that no write lands between the database dump and
the filesystem copy. Iris provides two mechanisms so the operator controls that
window; it intentionally does not prescribe a dump, snapshot or copy tool.

**Maintenance mode** is a reversible, no-restart window. When the file named by
`MAINTENANCE_FILE` (default `DATA_DIR/.maintenance`) exists, every request that
would write is refused with `503`, including the SSO callback GET, while reads
keep working. New realtime pushes and background retention work are refused too.
Already accepted operations finish, and deferred realtime files, revisions and
project timestamps are flushed. Create the file, wait for that work to drain,
take the backup, then remove it:

```sh
touch "$DATA_DIR/.maintenance"
# Wait until no write is still in progress:
while ! curl -sf localhost:3000/api/health | jq -e '.status == "maintenance" and .maintenance == true and .pendingWrites == 0' >/dev/null; do sleep 1; done
# Back up both layers at a mutually consistent point, then reopen writes:
rm "$DATA_DIR/.maintenance"
```

`GET /api/health` needs no authentication and reports
`{ "status", "maintenance", "pendingWrites" }`, so a script or load balancer can
observe the state. `pendingWrites` is a conservative count of unfinished durable
work, not a count of HTTP connections or SQL statements. It includes operations
whose client disconnected, response cleanup, background tasks and realtime work
still awaiting its timer or database write. A failed realtime write remains
pending; inspect the server log if the drain cannot finish. Wait for maintenance
to be active and this count to reach `0` before copying the two layers.

Open editors pause without discarding unconfirmed changes and resume their
existing stream when maintenance ends. Presence and reads remain available;
normal debounce timers resume after the window. The marker is observed on
admission/health checks and by a one-second poll. This barrier covers the running
Iris process, not concurrent maintenance scripts, external filesystem changes,
or another Iris instance. Startup initialization completes before health is
served; recheck the barrier after a restart.

Direct control through `MAINTENANCE_FILE` is the transitional operator interface.
When server roles and the administration console are introduced, entering and
leaving maintenance will become an authenticated, audited action reserved for
active Iris administrators; backup and restore tooling will remain outside Iris.

**Graceful shutdown** covers a clean stop, which is the safe way to restore.
On `SIGTERM` or `SIGINT` Iris stops new work and background timers, refuses queued
compile/password work, and drains accepted HTTP, realtime and background
operations before closing the database pool. `SHUTDOWN_TIMEOUT_MS` bounds the
entire sequence, including pool closure and direct compiler/font-cache children.
Exit code `0` and `Shutdown complete` indicate a completed drain. A deadline or
persistence/closure failure instead terminates direct children and connections,
logs the failure and exits with code `1`; this is not a clean backup barrier.
Restore both layers while the process is down, then start an Iris build that
accepts the backup's schema version. Startup validates that version before serving
requests.

A backup taken inside maintenance mode may include the `.maintenance` marker. If
it does, a restored instance starts in maintenance — a safe default that lets you
verify the restore before reopening writes. Remove the marker to resume.

Keep Iris stopped until you have restored both persistence layers. Keep the
`projects/<lowercase UUID>` layout under the restored `DATA_DIR`, then start Iris
and verify that each listed project opens. The database stores canonical POSIX
keys; absolute paths, traversal and other storage-key formats are invalid.

### Fresh beta schema and incompatible installations

This beta uses one current schema, version **1**. On an empty application schema,
`initializeSchema(pool)` creates the nine application tables from `db/schema.sql`
and a single `iris_schema` version marker in one transaction. Concurrent startup
attempts serialize on the initialization advisory lock. A matching marker permits
ordinary restarts with the existing accounts, projects, history and build records.

An unmarked nonempty schema, another version, or a malformed marker stops startup
with `IRIS_SCHEMA_INCOMPATIBLE`. Iris rolls back initialization and leaves existing
objects and rows untouched. Connection and permission failures retain their own
database errors.

For an incompatible beta installation:

1. Keep a consistent backup of PostgreSQL and `DATA_DIR`. Use the corresponding
   Iris release to export projects you want to carry forward in the current
   `.iris/project.json` archive format.
2. Stop that installation. Provision a fresh empty database and a fresh `DATA_DIR`
   for this release. If you choose to reuse disposable beta storage, reset both
   persistence layers yourself after confirming the backup.
3. Start Iris, sign in with the initial administrator credentials, and import the
   exported projects. Imports create new project and source-file identities.

Project archives carry project source/state; retain the full backup for accounts,
memberships, audit events and database history. Iris does not convert older schema
versions, relocate old storage layouts or reset an installation on startup.
Do not insert or change the marker to bypass an incompatibility error.

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
Promoting someone to owner is an explicit, owner-only action, and it is refused
for an account whose server role is `external` — the sharing console leaves owner
out of their menu and labels them, but the refusal is the server's. Sharing
changes are recorded in the audit trail.

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
- The status bar shows the state of the session for the open file, including
  whether this tab is still holding edits the server has not ordered yet. Until
  they come back through the update stream they are unconfirmed, and the status
  says so rather than claiming the document is settled.

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
each with a stable colour derived from their account, and the editor marks where
they are working in that colour: a bar beside their cursor's line with a faint
tint on it, and — when they have selected something — a shade over the range
itself, so text somebody is about to replace is visible before they replace it.
A selection is reported from the end the cursor is actually on, so dragging one
backwards puts the remote cursor where its owner sees it. The same person in two
tabs is one entry in the list and two cursors in the document, because that is
what is actually true.

The file tree carries the same information one level up: a file another member
has open is marked with their colour. It answers only "somebody is in there" and
deliberately carries no positions, so it changes when people come and go and
stays silent while they type. Opening a file is therefore no longer the only way
to find out that someone got there first.

### Structural awareness

Whether two people are working in the same place is decided by the document's
structure, not by how far apart their lines are. Iris parses the open file into
regions — `\section` and its subdivisions, every `\begin`/`\end` environment,
each LilyPond `\score`, variable, context and block — and asks whether one
person's position is inside the other's region. Distance is only a proxy for
shared intent, and it is wrong in both directions: two carets a line apart on
either side of a section boundary have nothing to do with each other, and two
carets thirty lines apart inside one `align` have everything to do with each
other. Containment answers it directly, so the first no longer warns and the
second now does.

When the two of you are inside the same construct, the status bar names it —
"the same `\begin{align}`", "the same § 2.1" — and the editor draws a spine down
the extent of what is shared. The outline panel marks which heading each
participant is working under, the same way the file tree marks which file.
Members who can only read are left out of all of it: a viewer on your line is
somebody reading over your shoulder, not a risk. Where a file has no structure
to compare — a preamble, a document without headings — the older rule still
applies and proximity is what raises the warning.

The warning is deliberately advisory and blocks nothing: operational
transformation already guarantees that no keystroke is lost, but it cannot tell
whether two people changing the same bar of music or the same command agree
about the result. That judgement stays with the people involved, which is also
why the file history exists.

The parsing runs entirely in the browser, against the replica each tab already
holds. The server never parses LaTeX or LilyPond — it compiles them by invoking
external binaries — and presence stays what it is on the wire: ephemeral
positions with no structure attached. Each client therefore names regions from
its own copy, which is one more reason the result is advisory rather than
authoritative. The index is rebuilt when typing settles and afterwards only
consulted, so a moving cursor never costs a parse.

Presence is ephemeral. It is never written to the database, never versioned and
never replayed: it lives only on the open connections, and it is visible only to
members who could already read the file. A position is reported at the version
its sender was on and is carried forward through the updates that sender had not
seen before it is drawn, so it lands on the text it was pointing at rather than
on whatever has since moved into place. A participant who disconnects simply
disappears.

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

Iris distinguishes two authorization levels. The **server role** (`admin`,
`regular` or `external`) governs account management, while the project role
governs project contents. A server admin is not automatically granted access to
any project's contents.

An **external** account is a guest of the organisation: it works on the projects
it is invited to and nothing else. It cannot create a project or import one — the
two are the same rule, since importing an archive it may legitimately download
would otherwise recreate the project under its own ownership — and it cannot hold
the `owner` project role, on any path, the admin console included. Ownership
carries the authority to manage membership and to destroy a project, and it is
the anchor of the at-least-one-owner invariant; leaving it with the organisation
is what keeps a project from ending up in external hands alone. An external
member can therefore be an editor or a viewer, with everything those roles imply.

Because no external account can be an owner, every owner is internal by
construction. Turning an account external strips whatever it owns: memberships on
co-owned projects drop to `editor`, while a project it owns alone blocks the
change until ownership is reassigned in the projects console — the same guard as
deleting such an account.

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

A third status, **pending**, belongs to accounts auto-provisioned by the identity
provider and not yet approved (see [OAuth 2.0 / OpenID
Connect](#oauth-20--openid-connect)). It is kept distinct from
`disabled` because the two mean opposite things to whoever reads the list — a
stranger who knocked versus a colleague whose access was revoked — and every
access check admits `active` and refuses the rest, so a pending account has no
access anywhere. An administrator can filter for them, then approve one by setting
it active or turn it away by disabling it; the status cannot be assigned back.

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
sign-ins and failed sign-in attempts, account creation, approval of an
auto-provisioned account, role and status changes,
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

### Request admission and reverse proxies

Iris checks the request origin before authentication or body processing for API
`POST`, `PUT`, `PATCH` and `DELETE` requests and collaboration WebSocket upgrades.
The expected origin is the origin of `APP_BASE_URL` when configured. Otherwise,
Iris uses the validated `Host` and the actual HTTP/HTTPS connection scheme.
`COOKIE_SECURE` and an absolute request target do not determine that origin.

Origin comparison uses normalized HTTP(S) scheme, hostname and effective port.
Host/scheme case and default ports are equivalent; bracketed IPv6 is supported.
Sibling hosts, different schemes or nondefault ports, and trailing-dot differences
do not match. DNS hostnames with a trailing dot remain valid but distinct from
their non-dotted spelling. IPv4 authority forms with a terminal dot, such as
`127.0.0.1.`, are unsupported and rejected before origin normalization in Host,
Origin/Referer, trusted forwarded host and APP_BASE_URL inputs.
An Origin must contain only `scheme://authority`, with no credentials,
path, trailing slash, query or fragment. Empty, `null`, malformed, list-valued and
duplicate Origins fail admission, including identical duplicate fields.

Browser metadata follows this order:

1. A present `Origin` must match. Referer and Fetch Metadata cannot rescue a bad
   Origin and do not override a matching one.
2. Without Origin, `Sec-Fetch-Site: same-site` or `cross-site`, or an invalid or
   ambiguous Fetch token, fails admission. A present `Referer` must be a single
   absolute, credential-free HTTP(S) URL with the expected origin; paths and query
   strings, including commas, are allowed.
3. Without Origin or Referer, `Sec-Fetch-Site: same-origin` provides browser
   evidence. `none` alone is insufficient. A matching Referer works with absent,
   `none` or `same-origin` Fetch Metadata.
4. Requests with all three fields absent pass this layer for native HTTP/WS client
   compatibility. Routes still enforce their authentication requirements; native
   headers are spoofable and do not authenticate callers.

Origin refusals return `403 REQUEST_ORIGIN_FORBIDDEN` for HTTP APIs and 403 for WS
handshakes. Ordinary GET/HEAD reads keep their existing behavior. The SSO callback
GET accepts cross-site metadata and continues to require matching state cookies
and unexpired signed state before the provider exchange. Maintenance/shutdown
refusals retain precedence over these admission checks.

Unsafe API requests require `Content-Type: application/json`, case-insensitive,
with at most one optional `charset=utf-8` parameter. The charset is case-insensitive
and may be quoted; spaces/tabs around the parameter are allowed. Other media types,
vendor `+json` types, extra or duplicate parameters, unsupported charsets and
duplicate Content-Type fields receive `415 REQUEST_CONTENT_TYPE_UNSUPPORTED`.
An explicit wrong type fails even with an empty body. A missing type is allowed
only without Transfer-Encoding and with Content-Length absent or zero; even an
empty chunked request needs the JSON type. No-body commands remain usable.

Only `POST /api/projects/import`, matched by the parsed pathname, exempts raw ZIP
uploads from the media check. Native clients may send ZIP, octet-stream or no type;
Origin checks, body limits and archive validation still apply. Safe reads and WS
handshakes have no JSON media gate. HTTP header refusals close the connection after
the final response, including for incomplete bodies; successful requests retain
normal keep-alive.

For deployment, set a public URL pin such as `APP_BASE_URL=https://iris.example.com`.
It takes precedence over forwarding regardless of `TRUST_PROXY`. The default is
empty, including in Compose, so local access can derive its origin from the request.
With an empty pin and `TRUST_PROXY=true`, Iris accepts single nonempty validated
`X-Forwarded-Host` and HTTP(S) `X-Forwarded-Proto` values. Each missing component
falls back to Host or the actual connection. Repeated fields and comma chains are
invalid. With `TRUST_PROXY=false`, Iris ignores these forwarded fields, including
when constructing SSO callback URLs. `OAUTH_REDIRECT_URI` remains the explicit
callback override.

Before enabling proxy trust, configure your proxy to overwrite or strip incoming
`X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`, and to preserve browser
`Origin`, `Referer` and `Sec-Fetch-Site`. Restrict backend access to the trusted proxy.
Forwarded-For affects audit attribution and rate limiting even with a public URL
pin; host/protocol forwarding affects origin derivation only without a pin.

### Compilation

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
npm test -- --test-timeout=30000
```

Set `DB_PASSWORD` and `IRIS_SECRET` to non-default test-only values for tests that
import the server, and `TEST_DATABASE_URL` to a disposable PostgreSQL database to
run the database cases rather than skip them. Do not point tests at user storage
or a production database. Apply a process deadline in addition to the per-test
timeout (for example, 240 seconds for the full suite).

### Bibliography browser gate

The browser gate uses the exact development dependency `playwright-core` 1.63.0
with installed Chrome. It does not download a browser. Set
`IRIS_BROWSER_EXECUTABLE` if Chrome is not available through its installed channel.

With the test database environment above, run:

```sh
IRIS_TEST_BROWSER=1 npm run test:bibliography:browser
```

This explicit opt-in starts the existing server fixture on an ephemeral loopback
HTTP port, with an isolated database schema and temporary storage. The fixture
does not load `.env`. Tests open the shipped app, CodeMirror modules and Worker;
they supply in-memory authenticated-session/project API responses, enter the
visible app workspace, and close page WebSockets. These UI tests do not exercise
real HTTP project persistence or a WebSocket transport; separate PostgreSQL and
collaboration suites cover those paths. Cleanup closes
the browser/server, drops the schema, and removes fixture storage. An optional
`IRIS_TEST_BASE_URL=http://127.0.0.1:PORT` uses an already-running disposable test
server instead; the harness does not stop that server. Only loopback HTTP URLs
are accepted. Neither mode should target a normal user instance.

Set `IRIS_TEST_ARTIFACT_DIR` to an ignored local directory to capture desktop,
390x844 mobile, and narrow-split screenshots. Tests cover columns, full-file
filtering and pagination, native controls/focus, source selection/scroll/undo,
raw-text OT, first recognition, and 10,000 references. Form cases cover both
formats, add/edit/remove, native/repeated fields, draft discard, mapped peer edits,
conflicts, permissions, same-file canonical acknowledgement, and CRLF no-ops.
Paste tests dispatch native
`ClipboardEvent`/`DataTransfer` objects through CodeMirror's DOM boundary; they
do not read or overwrite the OS clipboard and do not verify OS clipboard integration.
Without either opt-in, the browser tests skip in `npm test`; that is not a passed
browser gate. With the database environment configured, run both gates together:

```sh
IRIS_TEST_BROWSER=1 npm test -- --test-timeout=30000 --test-concurrency=4
```

Use a bounded process-group deadline (240 seconds for the full suite or standalone
browser gate) in addition to the 30-second test timeout. Browser coverage uses
Chrome desktop and mobile viewport emulation, not a physical phone or a screen
reader. Compiler fixtures exercise multipass diagnostics and PostgreSQL history
round-trips with controlled executables, not a real TeX distribution.

The declarative current schema lives in `db/schema.sql`.
`src/database.js` exposes `initializeSchema(pool)` and keeps an explicit
`CURRENT_SCHEMA_VERSION = 1`. Bump this version for future incompatible schema
changes and update the fresh-schema tests and release notes. SQL comments and
formatting do not change compatibility. The `iris_schema` marker has a boolean
singleton primary key/check and an integer version; it is initialization metadata,
separate from the nine application tables. The initializer owns its transaction
and advisory lock `49524953` and rejects incompatible state without changing it.

The full database/bootstrap suite needs a disposable test-cluster administrator
with permission to create databases and roles, including a restricted-role test.
Ordinary application startup only needs the dedicated application's schema access.

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
TEST_DATABASE_URL=postgresql://iris_test:test-only-password@127.0.0.1:5432/iris_test \
  npm run test:integration
```

Repository layout:

```text
public/   browser UI and frontend assets
src/      Node.js HTTP server, API, persistence, and compiler orchestration
db/       current PostgreSQL schema and fresh restricted-role provisioning
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
