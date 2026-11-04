# Install Iris 1.1.0

Choose **native installation** for the documented LaTeX/LilyPond compilation
workflow. The **local container build** runs Iris and PostgreSQL with Docker or
Podman; the lightweight Iris image contains no compiler toolchains.

The release instructions below obtain `R1.1.0`. The
[Lua pipeline engine](lua-pipelines.md) belongs to the development source and
needs that source checkout or a candidate archive built from it. It is not in
the released `R1.1.0` archive. No new version or release tag has been assigned.

## Obtain the release sources

Use the source at the exact Git tag **`R1.1.0`**. From a directory where you want
to keep the installation:

```sh
git clone --branch R1.1.0 --depth 1 https://github.com/GioMez/Iris.git iris-1.1.0
cd iris-1.1.0
```

Or download **`iris-1.1.0.tar.gz`** and **`SHA256SUMS`** from the
[R1.1.0 release](https://github.com/GioMez/Iris/releases/tag/R1.1.0).
Check the download before extracting it, using `sha256sum -c SHA256SUMS` on
Linux or `shasum -a 256 -c SHA256SUMS` on macOS. The supplied source archive has
one `iris-1.1.0/` directory:

```sh
tar -xzf iris-1.1.0.tar.gz
cd iris-1.1.0
```

Run the following installation commands from that source directory. The archive
includes the lockfile, database schema, templates, guides and verification tools;
installation and tests work without Git history.

## Native installation

### Requirements

- Node.js **24 or later**, with npm.
- PostgreSQL **18 or later**, with an empty database for Iris. PostgreSQL 18 is
  the tested baseline; startup accepts newer majors.
- A LaTeX distribution for document builds, LilyPond for score builds, or both.
  Install BibTeX, Biber and MakeIndex if your chosen pipelines use them.
- `synctex` for LaTeX PDF/source navigation. It usually comes with TeX Live.
- Lua **5.4 or 5.5** for Lua pipeline execution, available as `lua`. Iris ships
  its JSON codec; you do not need LuaRocks or interpreter extension modules.

The qualified native environment uses macOS arm64, Node 26.8.2, PostgreSQL 18.6,
TeX Live 2026 (pdfTeX 1.40.29, SyncTeX utility 1.5), LilyPond 2.26.0/Guile 3.0
and Chrome 152.0.7977.83. See [navigation qualification](source-navigation.md#native-adapters)
for engine-specific details. Install the tools through your operating system or
the upstream distributions, then check the executables available to Iris:

```sh
node --version
psql --version
pdflatex --version
synctex help
lilypond --version
lua -v
```

### Dependencies and configuration

Install the locked packages and copy the configuration example:

```sh
npm ci
cp .env.example .env
```

Run the following command **twice** to generate two independent values:

```sh
openssl rand -hex 32
```

After each run, copy the output into the corresponding entry in `.env`:

1. First value → `IRIS_SECRET`.
2. Second value → `DB_PASSWORD`.

Set `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER` for your PostgreSQL service.
For a local-only native instance, set `BIND_ADDRESS=127.0.0.1`. The example's
`DATA_DIR=./data` and `PUBLIC_DIR=./public` resolve from the directory where you
start Iris.

Use an absolute `DATA_DIR` for a managed service and set `TEMPLATE_DIR` to its
`templates` subdirectory, or remove the example's explicit `TEMPLATE_DIR` to use
the derived default. Set `PUBLIC_DIR` to the installation's `public` directory
if the service starts elsewhere. Iris reads `.env` from its **working directory**;
exported process variables take precedence.

Leave compiler paths empty to use the server's PATH. To select fixed directories,
set `TEX_BIN_PATH` and `LILYPOND_BIN_PATH`. Set their respective `*_PATH_LOCKED`
flags to `true` to prevent project overrides. A service manager may give Iris
a different PATH from your interactive terminal.

Set `LUA_BIN_PATH` to the directory containing `lua`, or leave it empty to use
PATH. If your package names the executable `lua5.4`, provide a `lua` symlink in
an operator-owned directory and select that directory. Projects cannot change
this setting. Missing optional executables do not prevent editor startup.
See [Lua runtime limits](configuration.md#lua-pipeline-runtime-limits) for the
current integration status and execution bounds.

Native Lua/runtime qualification used macOS 27.0.1 arm64, Node 26.12.1 and
Lua 5.5.1, with TeX Live 2026, LilyPond 2.26.0, Ghostscript 10.08.0 and
Biber 2.22. A separate source-built Lua 5.4.9 passed bridge, worker and
extracted-source-package checks. These checks cover source generation, binary
I/O, explicit compiler passes and retained navigation; they exclude browser
author controls and production pipeline HTTP workflows.

### Provision PostgreSQL

As a PostgreSQL administrator, create a restricted role and an empty database.
Replace the password below with the value you entered as `DB_PASSWORD`:

```sql
CREATE ROLE iris LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '<your generated DB_PASSWORD>';
CREATE DATABASE iris OWNER iris;
```

Iris creates its tables, not the database or login role. The application role
needs schema creation rights for initialization; owning the database provides
those rights in a fresh PostgreSQL 18 installation.

Start Iris:

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Follow
[First administrator](#first-administrator) below. Stop the foreground process
with Ctrl+C and wait for `Shutdown complete`. For continuous operation, run
`node src/server.js` under a service manager with the same working directory and
configuration and allow a clean SIGTERM shutdown.

## Local container build

Use the supplied [Dockerfile](../Dockerfile) and
[docker-compose.yml](../docker-compose.yml) with either engine. Build the local
image **`localhost/iris:1.1.0`** from the tagged or extracted source. You do not
need a published Iris image or registry credentials. The build downloads the
official Node base image, pinned Alpine Lua package and locked npm dependencies;
Compose downloads official PostgreSQL 18.

The image runs Node 24.18.0 and Lua 5.4.8 on Alpine 3.23 as UID 1000.
`/usr/local/bin/lua` selects the packaged interpreter. Compose gives Iris a
read-only root filesystem, writable project storage and a 256 MiB temporary
`/tmp`. It runs two services: **`webapp`** and **`postgres`**.

### Configure the instance

Create `.env` if you have not done so:

```sh
cp .env.example .env
```

Run the following command **three times** to generate three independent values:

```sh
openssl rand -hex 32
```

After each run, copy the output into the corresponding entry in `.env`:

1. First value → `IRIS_SECRET`.
2. Second value → `DB_PASSWORD`.
3. Third value → `POSTGRES_ADMIN_PASSWORD`.

The last credential initializes the PostgreSQL administrator; Iris receives
only the restricted `iris` role's password.
Compose refuses to start if any required secret is missing.

Set `IRIS_PORT` to change the host port and `IRIS_BIND_ADDRESS` to change its
binding. The default is **`127.0.0.1:3000`**. PostgreSQL has no published host
port. Compose fixes the internal database host to `postgres`, its port to 5432,
and the database/user to `iris`; the native `DB_HOST` values in `.env` do not
override those container settings.

In both procedures below, the build command creates the local Iris image.
Compose then starts PostgreSQL, waits for its healthcheck to pass, and starts
Iris. A single `up -d` starts both services; `-d` leaves them running in the
background.

### Docker

Start your Docker engine, then run:

```sh
docker build -t localhost/iris:1.1.0 .
docker compose --env-file .env -f docker-compose.yml -p iris up -d
```

Earlier compiler-free-image qualification used **Docker Engine 29.8.0 /
Docker Compose 5.5.1** on Linux arm64, with Docker running as a separate nested
daemon in a disposable VM. That result does not cover the added Lua package.

### Podman

Start your Podman engine and make sure a Compose provider, such as
`podman-compose`, is installed through your package manager. `podman compose`
detects an installed provider. These commands use your default Podman environment:

```sh
podman build -t localhost/iris:1.1.0 .
podman compose --env-file .env -f docker-compose.yml -p iris up -d
```

If Podman runs in a VM, keep the source directory in a folder shared with that
VM: Compose mounts the PostgreSQL initialization script from it. Both engines
use the same Compose file. Earlier qualification used **rootless Podman 6.1.1 /
podman-compose 1.6.0** on Linux arm64 with SELinux.

The Lua-enabled development image passed installation smoke on 2026-11-04 using macOS arm64
Podman client **6.1.4**, Linux arm64 server **5.6.1** and podman-compose **1.6.0**.
The smoke ran the HTTP approval/inspection/run workflow with project modules,
binary publication, diagnostics, revocation and import without transferred
approval. It also checked process-group cancellation inside the Compose service,
restart and separate-instance restore, comparing all 13 schema-4 tables and
75 filesystem entries by bytes/mode. The stock image reported missing compilers.
Browser painting and successful native compilation were disabled in this smoke.

The native installation smoke on the same date passed the Lua HTTP workflow,
LaTeX/LilyPond builds,
forward/inverse source navigation, restart and separate-instance restore under
Node 26.12.1 and PostgreSQL 18.6 on macOS arm64. Chromium **156.0.8078.80** painted
both compiler PDFs in Iris. Restore compared 13 tables and 93 filesystem entries.
A separate reproducible candidate archive passed `npm ci --omit=dev`, native
HTTP smoke and 103 selected database/Lua/layout/composition/recovery checks without Git or
ancestor dependencies. These results cover the tested source and platform;
the [source-navigation guide](source-navigation.md#pipeline-and-composed-outputs)
records the separate composed-PDF browser journeys.

### Check service status (optional)

Use `ps` to inspect the services and their health status after startup.
With Docker:

```sh
docker compose --env-file .env -f docker-compose.yml -p iris ps
```

With Podman:

```sh
podman compose --env-file .env -f docker-compose.yml -p iris ps
```

### Compiler availability

**The stock image has neither TeX nor LilyPond.** Editing, accounts, project
storage and import/export work; compilation reports a missing executable until
you provide a compatible toolchain in Iris's runtime. A host path in a setting
does not install a compiler. Install a toolchain inside the container that
matches its environment, architecture and runtime dependencies.

The distribution supplies one Iris image recipe with Lua and the
PostgreSQL service. Use the native installation above for the qualified
compilation setup. Container smoke verification checks the stock image's
missing-compiler result.

### Persistence and restart

With Compose project name `iris`, the volumes are `iris_project-data` and
`iris_postgres-data`. PostgreSQL 18 mounts its volume at `/var/lib/postgresql`;
Iris mounts its data at `/app/data`, including the mutable template catalog.

For Docker, stop and restart with:

```sh
docker compose --env-file .env -f docker-compose.yml -p iris stop
docker compose --env-file .env -f docker-compose.yml -p iris up -d
```

For Podman, use the same `stop` and `up -d` arguments after the Podman
Compose prefix above. These operations preserve the volumes.
`down --volumes` destroys them; it belongs
to disposal of an installation, not ordinary restart.

PostgreSQL's initialization script runs only with an empty volume. Changing
`DB_PASSWORD` or `POSTGRES_ADMIN_PASSWORD` in `.env` does not change an existing
database role's password. Coordinate password rotation with PostgreSQL itself.
See [Administration](administration.md#backup-and-restore) before moving data.

## First administrator

On startup with an empty `users` table, Iris creates **`admin`**, assigns the
administrator role, and prints a random password once in server output. For
a native installation, read the terminal or service logs. With Compose, follow
the `webapp` logs until the credentials appear.

Docker:

```sh
docker compose --env-file .env -f docker-compose.yml -p iris logs -f webapp
```

Podman:

```sh
podman compose --env-file .env -f docker-compose.yml -p iris logs -f webapp
```

Press Ctrl+C to stop following the logs; the services keep running in the
background. Save the password, sign in, and change it through the account UI.
Iris stores an Argon2id hash, not the password.

Open **Admin** on the project dashboard to create additional users. There
is no public signup. Existing accounts and roles survive restarts; Iris does
not promote a familiar username or email on later startup.

Iris 1.1.0 initializes **database schema 2** and reopens a matching schema.
An unmarked nonempty schema, incompatible version or malformed marker stops
startup with `IRIS_SCHEMA_INCOMPATIBLE` without changing the stored objects or
rows. Keep the reported error and check the database selection; do not change
the marker to bypass validation.

## Check the installation

Read `/api/health`, sign in, create a project, save and reopen it. On a native
setup, compile a small source for each installed language and inspect its PDF
and diagnostics. Restart Iris and check the project again.

The [development guide](development.md#installation-smokes) provides disposable
installation and restore smokes, including the commands used for the actual
Docker and Podman qualification. Qualification covers the versions/platforms
listed here, not other browser engines, architectures or Compose providers.
