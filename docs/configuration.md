# Configuration reference

Iris 1.0.0 reads configuration at startup from the process environment and
`.env` in its working directory. An existing environment value wins over the
file. Relative paths resolve from that working directory. Restart Iris after
changing configuration.

Use [`.env.example`](../.env.example) as the editable starting point. The file
sets some relative paths explicitly; changing `DATA_DIR` also requires updating
or removing its `TEMPLATE_DIR` line. The parser supports `NAME=value` and quoted
values, without shell expansion.

## Application and database

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Iris HTTP listening port. |
| `BIND_ADDRESS` | empty | Empty binds all interfaces; use `127.0.0.1` for native loopback access. In Compose, use the host publication settings below. |
| `IRIS_SECRET` | required | Session and OAuth-state signing secret. Empty and known example secrets fail startup. Generate a random value. |
| `DATA_DIR` | `./data` | Project sources, outputs and server working directories. |
| `PUBLIC_DIR` | `./public` | Shipped frontend assets. |
| `TEMPLATE_DIR` | `DATA_DIR/templates` | Mutable instance template catalog. |
| `DB_HOST` | `127.0.0.1` | PostgreSQL host. |
| `DB_PORT` | `5432` | PostgreSQL port. |
| `DB_USER` | `iris` | Restricted application login. |
| `DB_PASSWORD` | required | Application database password. Empty and the example value `iris` fail startup. |
| `DB_NAME` | `iris` | Existing database to initialize or reopen. |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | Connection timeout in milliseconds. |
| `MAX_BODY_MB` | `25` | Maximum JSON or raw project ZIP request body, in MiB. |
| `PROJECT_DOWNLOAD_TIMEOUT_MS` | `30000` | Hard source-file transfer deadline while the project read gate remains held. |
| `MAINTENANCE_FILE` | `DATA_DIR/.maintenance` | Presence refuses writes and initiates a drain. Reads continue. |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Complete SIGTERM/SIGINT drain deadline, including database closure and direct compiler children. |

`PROJECT_DOWNLOAD_TIMEOUT_MS` and `SHUTDOWN_TIMEOUT_MS` accept positive integers;
invalid values use their defaults. Supply valid positive numbers for ports,
body size and the database timeout; those settings use direct numeric conversion.

## HTTPS, proxy and SSO

Boolean settings use the exact string **`true`** to enable a behavior. Use
`false` to disable it; `1` and `yes` do not enable it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APP_BASE_URL` | empty | Public HTTP(S) base URL. Pins the expected origin for API writes and WebSocket upgrades, and supplies the SSO callback base. May include a base path, but no credentials, query or fragment. An invalid nonempty value fails startup. |
| `COOKIE_SECURE` | `false` | Use secure cookies for HTTPS deployment. Does not set the expected request origin. |
| `TRUST_PROXY` | `false` | Accept forwarded client addresses; also forwarded host/protocol when `APP_BASE_URL` is empty. Requires a proxy that replaces incoming forwarded headers. |
| `OAUTH_ISSUER_URL` | empty | Provider identity and discovery base. Required for sign-in even with explicit endpoints. |
| `OAUTH_AUTHORIZATION_URL` | empty | Explicit authorization endpoint; configure all three endpoints to bypass discovery. |
| `OAUTH_TOKEN_URL` | empty | Explicit token endpoint. |
| `OAUTH_USERINFO_URL` | empty | Explicit user-info endpoint. |
| `OAUTH_CLIENT_ID` | empty | Provider client identifier. |
| `OAUTH_CLIENT_SECRET` | empty | Provider client secret. |
| `OAUTH_REDIRECT_URI` | derived | Callback override; otherwise Iris appends `/api/auth/sso/callback` to the base URL. |
| `OAUTH_SCOPE` | `openid email profile` | Requested scopes. |
| `OAUTH_CLIENT_AUTH_METHOD` | `client_secret_basic` | Token authentication; `client_secret_post` also supported. |
| `OAUTH_AUTO_REGISTER` | `false` | Create accounts for new identities with no matching identity or email. |
| `OAUTH_DEFAULT_ROLE` | `regular` | Auto-registration role: `regular` or `external`. Other nonempty values fail startup. |
| `OAUTH_APPROVAL_REQUIRED` | `true` | Create auto-registered accounts pending administrator approval. |

Read the [proxy](administration.md#reverse-proxy-and-https) and
[OIDC](administration.md#openid-connect) procedures before enabling them.
`APP_BASE_URL` describes the public URL; a base-path deployment still needs
appropriate proxy routing to Iris's root routes.

## Compilers and archives

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEX_BIN_PATH` | empty | Directory of TeX-related executables; empty uses PATH. |
| `TEX_PATH_LOCKED` | `false` | Prevent a project from overriding that directory. |
| `LILYPOND_BIN_PATH` | empty | Directory containing `lilypond`; empty uses PATH. |
| `LILYPOND_PATH_LOCKED` | `false` | Prevent a project from overriding that directory. |
| `COMPILE_TIMEOUT_MS` | `30000` | Timeout for each compiler step, not the entire multipass build. |
| `COMPILE_LOG_LIMIT` | `1048576` | Captured log bytes per step and stored trace. |
| `BUILD_ARCHIVE_MAX_MB` | `128` | Aggregate generated-file bytes buffered into a build ZIP, in MiB. |
| `BUILD_ARCHIVE_MAX_ENTRIES` | `10000` | File/directory entries in a build ZIP. |
| `PROJECT_ARCHIVE_MAX_MB` | `256` | Aggregate project bytes buffered into an export ZIP, in MiB. |
| `PROJECT_ARCHIVE_MAX_ENTRIES` | `20000` | File/directory entries in a project ZIP. |

Archive limits accept positive integers and fall back on invalid input. Supply
positive numeric values for compiler timeout/log limits; they use direct numeric
conversion. ZIP import limits both the request and expanded contents to
`MAX_BODY_MB`, with a fixed 10,000-entry cap. A permitted export can exceed
the receiving instance's import limits.

Paths refer to the environment running Iris. The stock Linux container has no
compilers. Native toolchains, custom profile arguments and the reduced compiler
environment are described under [Compilation](development.md#compiler-contract).
PDF navigation has separate fixed [resource budgets](source-navigation.md#storage-and-budgets).

## Password hashing and admission

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARGON2_MEMORY_COST` | `65536` | KiB per new Argon2id hash. |
| `ARGON2_TIME_COST` | `3` | Argon2 time cost for new hashes. |
| `ARGON2_PARALLELISM` | `1` | Argon2 parallelism for new hashes. |
| `PASSWORD_HASH_CONCURRENCY` | `2` | Active hash/verify operations across login, password changes, resets and seeding. |
| `PASSWORD_HASH_QUEUE` | `24` | Waiting password operations. |
| `AUTH_RATE_LIMIT` | `10` | Local login allowance per source IP. |
| `AUTH_RATE_WINDOW_MS` | `60000` | IP allowance refill period. |
| `AUTH_ACCOUNT_RATE_LIMIT` | `12` | Local login allowance per normalized submitted username/email, across IPs. |
| `AUTH_ACCOUNT_RATE_WINDOW_MS` | `900000` | Submitted-identifier allowance refill period. |
| `AUTH_FAILURE_PENALTY` | `4` | Total token charge for failed login, including admission. |
| `COMPILE_RATE_LIMIT` | `30` | Compile allowance per user/project after authorization. |
| `COMPILE_RATE_WINDOW_MS` | `300000` | Compile allowance refill period. |
| `COMPILE_CONCURRENCY` | `2` | Active compilations across the instance. |
| `COMPILE_QUEUE` | `8` | Waiting compilations, in arrival order. |
| `API_RATE_LIMIT` | `600` | Authenticated API allowance per user across sessions. |
| `API_RATE_WINDOW_MS` | `60000` | API allowance refill period. |

These fields accept integers of at least 1. Zero, negative, fractional or invalid
values use defaults; zero does not disable a queue. Stored password hashes carry
their verification costs; changing Argon2 settings changes new hashes.

Rate buckets refill over the specified window up to the allowance. Iris trims
and lowercases submitted login identifiers; username and email have separate
budgets even for the same account. Successful login clears the submitted
identifier's and IP's debt.

Exhausted rate limits return HTTP 429 with `Retry-After` in seconds. Full password
or compile queues return HTTP 503 without a retry-time estimate. A waiting
compile performs no save or staging work until admission; Iris checks permission
again when it gets a slot. The compile slot covers setup through publication
and audit. The shutdown/maintenance write count also includes subsequent cleanup.

These controls belong to one process and reset on restart. They limit admitted
work, not total resident memory or operating-system resources.

## Realtime collaboration

All values below accept positive integers, with fallback to the listed default.
Times use milliseconds.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COLLAB_FLUSH_MS` | `2000` | Idle delay before accepted text reaches disk. |
| `COLLAB_FLUSH_MAX_MS` | `15000` | Maximum unflushed interval during continuous editing. |
| `COLLAB_REVISION_IDLE_MS` | `120000` | Quiet interval before consolidating a realtime history revision. |
| `COLLAB_HEARTBEAT_MS` | `30000` | Ping interval and account revalidation opportunity. |
| `COLLAB_MAX_MESSAGE_BYTES` | `4194304` | Maximum collaboration message size. |
| `COLLAB_PUSH_DEBOUNCE_MS` | `300` | Browser batching of keystrokes; served in `/api/config`. |
| `COLLAB_PRESENCE_DEBOUNCE_MS` | `200` | Browser batching of cursor movement. |
| `COLLAB_PEERS_TICK_MS` | `200` | Server coalescing of peer-position broadcasts. |
| `COLLAB_FILE_PRESENCE_TICK_MS` | `5000` | Server coalescing of project file-presence broadcasts. |
| `COLLAB_TOUCH_MS` | `30000` | Coalesced project timestamp updates during live editing. |
| `COLLAB_MAX_ROOMS_PER_SESSION` | `50` | Document rooms held by one WebSocket connection. |
| `COLLAB_MAX_SESSIONS_PER_USER` | `12` | Concurrent collaboration connections for one account. |

Typing updates the local editor before the batching delay. Increasing the delay
reduces message frequency and makes changes arrive later at other clients. Open
rooms retain whole text documents in memory.

## Retention

| Variable | Default | Accepted range / meaning |
| --- | --- | --- |
| `RETENTION_ENABLED` | `true` | Enables timed pruning and interrupted-build reconciliation. Confirmed project-deletion cleanup still runs at startup when false. |
| `RETENTION_SWEEP_MS` | `3600000` | Positive integer milliseconds between sweeps. |
| `RETENTION_BUILD_KEEP` | `20` | Default retained build count, from 3 to the configured ceiling. |
| `RETENTION_BUILD_KEEP_MAX` | `200` | Owner's build-count ceiling, clamped to 3–200. |
| `RETENTION_BUILD_DAYS` | `30` | Default build age in days, from 1 to the configured ceiling. |
| `RETENTION_BUILD_DAYS_MAX` | `365` | Owner's build-age ceiling, clamped to 1–365. |
| `RETENTION_VERSION_KEEP` | `100` | Default retained revisions per file, from 10 to the configured ceiling. |
| `RETENTION_VERSION_KEEP_MAX` | `1000` | Owner's revision-count ceiling, clamped to 10–1000. |
| `RETENTION_VERSION_DAYS` | `180` | Default revision age in days, from 7 to the configured ceiling. |
| `RETENTION_VERSION_DAYS_MAX` | `1095` | Owner's revision-age ceiling, clamped to 7–1095. |
| `RETENTION_AUDIT_DAYS` | `365` | Instance audit age, clamped to 90–36500 days. |
| `RETENTION_ORPHAN_GRACE_MS` | `21600000` | Positive integer milliseconds before reclaiming abandoned staging/output directories. Default six hours. |

Count/day policy fields floor fractional numbers and clamp out-of-range values.
Empty or invalid input uses the default. Iris clamps instance defaults within
the effective ceiling. A project's empty preference follows the current instance
default; an explicit preference stays within the operator's limits.

Pruning requires **both** age and count conditions. It protects running builds,
the most recent successful build and the newest revision of each file. Audit
pruning uses age alone. See [Retention](administration.md#retention) for cleanup
timing and recovery distinctions.

## Compose settings and environment forwarding

| Variable | Default | Meaning |
| --- | --- | --- |
| `IRIS_PORT` | `3000` | Host-published Iris port; container `PORT` stays 3000. |
| `IRIS_BIND_ADDRESS` | `127.0.0.1` | Host-published interface. |
| `POSTGRES_ADMIN_PASSWORD` | required | Official PostgreSQL image's administrator password on first initialization. Iris does not receive it. |

Compose reads `.env` for **interpolation**. It passes only the keys listed under
`webapp.environment` into Iris. Adding a variable to `.env` alone does not pass
it through. For a setting absent from the active environment list, add its
interpolation there, for example:

```yaml
      RETENTION_AUDIT_DAYS: "${RETENTION_AUDIT_DAYS:-365}"
```

For SSO, add the OIDC keys you need in the same way; replace the commented sample
credentials rather than treating them as configured values. Keep one Compose
file for both engines. Its fixed container paths and database settings take
precedence over the native example values.

`PODMAN_COMPOSE_PROVIDER` and `CONTAINER_CONNECTION` configure the Podman CLI,
not Iris. The installation guide uses `PODMAN_CONNECTION` as a shell variable
for the explicit `--connection` argument. `PATH`, `HOME` and `TMPDIR` come from
the runtime and also affect tool discovery and temporary files. Test-runner
options belong in [Development](development.md#run-the-tests), not an instance's
configuration.
