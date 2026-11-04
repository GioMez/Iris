# Install Iris

Choose **native installation** to run LaTeX/LilyPond tools on the host. The
**local container build** runs Iris and PostgreSQL with Docker or
Podman; the lightweight Iris image contains no compiler toolchains.

This guide describes Iris 1.2.0, including Lua plugins. Use the
documentation included with the source you install. For an existing installation,
follow [Upgrade Iris](administration.md#upgrade-iris).

## Obtain the source

Clone the release tag into your installation directory:

```sh
git clone --branch R1.2.0 --depth 1 https://github.com/GioMez/Iris.git iris
cd iris
```

Run the following commands from that source directory. If using a source archive,
check its supplied `SHA256SUMS` with `sha256sum -c SHA256SUMS` on Linux or
`shasum -a 256 -c SHA256SUMS` on macOS before extraction. Source archives include
the lockfile, migrations, templates and guides; installation needs no Git history.

## Native installation

### Requirements

- Node.js **24 or later**, with npm.
- PostgreSQL **18 or later**, with an empty database for a new Iris installation.
- A LaTeX distribution for document builds, LilyPond for score builds, or both.
  Install BibTeX, Biber and MakeIndex if your chosen pipelines use them.
- `synctex` for LaTeX PDF/source navigation. It usually comes with TeX Live.
- Lua **5.4 or 5.5** for Lua pipeline execution, available as `lua`. Iris ships
  its JSON codec; you do not need LuaRocks or interpreter extension modules.

Install the tools through your package manager or their upstream distributions.
Check the executables available to the account that runs Iris:

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
See [Lua runtime limits](configuration.md#lua-pipeline-runtime-limits) for
execution settings and [Lua pipelines](lua-pipelines.md) for project setup.

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
image **`localhost/iris:1.2.0`**, the tag referenced by Compose, from your source. You do not
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
docker build -t localhost/iris:1.2.0 .
docker compose --env-file .env -f docker-compose.yml -p iris up -d
```

### Podman

Start your Podman engine and make sure a Compose provider, such as
`podman-compose`, is installed through your package manager. `podman compose`
detects an installed provider. These commands use your default Podman environment:

```sh
podman build -t localhost/iris:1.2.0 .
podman compose --env-file .env -f docker-compose.yml -p iris up -d
```

If Podman runs in a VM, keep the source directory in a folder shared with that
VM: Compose mounts the PostgreSQL initialization script from it. Both engines
use the same Compose file.

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

For host-installed compilers, use the native installation procedure above.

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

Iris initializes an empty database and applies supported migrations at startup.
An unmarked nonempty schema, incompatible version or malformed marker stops
startup with `IRIS_SCHEMA_INCOMPATIBLE` without changing the stored objects or
rows. Keep the reported error and check the database selection; do not change
the marker to bypass validation.

## Check the installation

Read `/api/health`, sign in, create a project, save and reopen it. On a native
setup, compile a small source for each installed language and inspect its PDF
and diagnostics. Restart Iris and check the project again.

For automated installation and restore checks in a disposable environment, use
the [development smoke commands](development.md#installation-smokes).
