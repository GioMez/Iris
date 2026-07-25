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
- Syntax highlighting, document outline, search and replace, formatting,
  optional word wrapping, and configurable autosave.
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
   tools in the project directory without invoking a shell.
6. Generated files are written to the project's `output/` directory and sent
   back to the browser for preview or download.

PostgreSQL stores accounts, the project index, and the audit trail. The filesystem
stores the actual project content, so a complete backup must include both the
database and `DATA_DIR`.

## Requirements

- Node.js 24 or later.
- PostgreSQL 17 or later. The supplied Compose file ships PostgreSQL 18; keep the
  development and deployment majors aligned, and note that raising the major on an
  existing volume requires `pg_upgrade` or a dump and restore.
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
- **Custom:** up to twelve ordered steps using allowlisted tools and arguments.

Custom pipeline arguments can use these placeholders:

| Placeholder | Value |
| --- | --- |
| `[engine]` | Selected LaTeX engine |
| `[main]` | Main source file path |
| `[jobname]` | Main filename without its extension |
| `[pdf]` | Expected PDF path below `output/` |

LaTeX processes run with `-no-shell-escape`, nonstop interaction, file-and-line
errors, and a forced `output/` destination.

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
| `COOKIE_SECURE` | `false` | Set `true` when Iris is served over HTTPS. |
| `TRUST_PROXY` | `false` | Set `true` only behind a reverse proxy that rewrites `X-Forwarded-For`, so audit events record the client address instead of the proxy. |

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

The OIDC and Argon2id variables are documented in their respective sections
above and listed together in [`.env.example`](.env.example).

## Persistence and backups

Each project is stored below `DATA_DIR` in a user-specific directory. Its layout
is broadly:

```text
DATA_DIR/
└── projects/
    └── <project-id>/
        ├── .iris/
        │   ├── project.json
        │   └── texmf-var/
        ├── fonts/
        ├── output/
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

Back up PostgreSQL and `DATA_DIR` together: the database holds accounts,
ownership and the audit trail, while the filesystem holds the content itself.
Restore both from the same point in time, then start Iris and confirm that the
project list matches.

Databases created before this layout stored absolute paths under a per-user
directory. Migration `002` rewrites those rows and Iris relocates the
directories on the next startup. To do it during a maintenance window instead,
run the same step with the server stopped:

```sh
npm run migrate:storage
```

It is safe to repeat and resumes an interrupted run. If a project has data at
both the old and the new location it stops and names the project rather than
guessing which copy to keep.

## Audit trail

Administrative and destructive actions are appended to the `audit_events` table:
sign-ins and failed sign-in attempts, account creation, password changes, and
project creation, import and deletion.

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
