const http = require("node:http");
const { WebSocketServer } = require("ws");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const argon2 = require("argon2");
const { createDatabase } = require("./database");
const { loadDotEnv } = require("./env");
const { uuidv7, isUuid, UUID_PATTERN } = require("./ids");
const { lifecycleGate, healthStatus, isWriteRequest, isMutatingMethod, HEALTH_PATH } = require("./lifecycle");
const { parseAppBaseUrl, requestAuthority, requestOrigin, isRequestOriginAllowed, isJsonMediaAllowed } = require("./request-security");
const { recordAuditEvent } = require("./audit");
const { normalizeProjectPath, collectProjectFiles, reconcileProjectFiles, remapImportedFileIds } = require("./project-files");
const { createProjectMutations } = require("./project-mutations");
const { hashContent, isVersionableText, contentChanged } = require("./versions");
const { CollabRooms, CollabError, peerColor, normalizePresence } = require("./collab");
const { isSystemRole, isUserStatus, isAccountStatus, leavesNoActiveAdmin, normalizeSearch, userDeletionBlock } = require("./admin");
const {
  isProjectRole,
  roleHasCapability,
  canCreateProjects,
  canHoldProjectRole,
  leavesNoOwner,
  normalizeMemberSearch,
  escapeLikePattern,
} = require("./project-access");
const { projectStorageKey, resolveProjectStorageDir, relocateProjectStorage } = require("./project-storage");
const {
  initializeProjectTemplates,
  discoverProjectTemplates,
  listAdminProjectTemplates,
  readProjectTemplate,
  getAdminProjectTemplate,
  createProjectTemplate,
  updateProjectTemplate,
  deleteProjectTemplate,
} = require("./project-templates");
const { createZip, extractZip } = require("./zip");
const { parseCompileLog, compileDiagnosticsView, selectCompileDiagnostics } = require("./compile-diagnostics");
const { normalizeCustomCommands } = require("../public/iris-completion");
const Bibliography = require("../public/iris-bibliography");
const {
  buildStoragePath,
  publishCompileOutput,
  versionCompileArtifacts,
  hashBuildArtifacts,
  resolveBuildDirectory,
  resolveBuildArtifact,
  listBuildFiles,
  collectBuildArchiveEntries,
  resolveBuildFile,
} = require("./builds");
const { RateLimiter, ConcurrencyGate, GateRejectedError } = require("./throttle");
const {
  retentionCaps,
  auditRetentionDays,
  clampRetention,
  normalizeRetentionInput,
  retentionView,
  cutoffDate,
} = require("./retention");

loadDotEnv(path.resolve(".env"));

const PORT = Number(process.env.PORT || 3000);
// Interface the HTTP server binds to. Empty means every interface, which is what
// a container needs for its published port to reach it. Set it to one address —
// a private or VPN interface — when Iris runs directly on a host whose other
// interfaces must not answer. A binding restricts which networks can open a
// connection; it does not authenticate the peer, so a proxy on another machine
// still needs a firewall or an encrypted link in front of it.
const BIND_ADDRESS = process.env.BIND_ADDRESS || "";
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT || 5432);
const DB_USER = process.env.DB_USER || "iris";
const DB_PASSWORD = requiredSecret("DB_PASSWORD", process.env.DB_PASSWORD, ["iris"]);
const DB_NAME = process.env.DB_NAME || "iris";
const DB_CONNECT_TIMEOUT = Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || "./public");
const TEMPLATE_DIR = path.resolve(process.env.TEMPLATE_DIR || path.join(DATA_DIR, "templates"));
const TEX_BIN_PATH = process.env.TEX_BIN_PATH || "";
const TEX_PATH_LOCKED = String(process.env.TEX_PATH_LOCKED || "false") === "true";
const LILYPOND_BIN_PATH = process.env.LILYPOND_BIN_PATH || "";
const LILYPOND_PATH_LOCKED = String(process.env.LILYPOND_PATH_LOCKED || "false") === "true";
const SECRET = requiredSecret("IRIS_SECRET", process.env.IRIS_SECRET, [
  "iris-dev-secret-change-me",
  "change-this-secret-in-production",
]);
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false") === "true";
const TRUST_PROXY = String(process.env.TRUST_PROXY || "false") === "true";
// Presence of this file puts Iris into maintenance mode without a restart: the
// operator creates it to open a consistent backup or restore window and removes
// it to reopen writes. Kept at the DATA_DIR root, a sibling of projects/.
const MAINTENANCE_FILE = process.env.MAINTENANCE_FILE || path.join(DATA_DIR, ".maintenance");
// Deadline for the entire drain, including realtime persistence and db.end.
const SHUTDOWN_TIMEOUT_MS = positiveIntEnv("SHUTDOWN_TIMEOUT_MS", 15000);
const MAX_BODY = Number(process.env.MAX_BODY_MB || 25) * 1024 * 1024;
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 30000);
const COMPILE_LOG_LIMIT = Number(process.env.COMPILE_LOG_LIMIT || 1024 * 1024);
const BUILD_ARCHIVE_MAX_BYTES = positiveIntEnv("BUILD_ARCHIVE_MAX_MB", 128) * 1024 * 1024;
const BUILD_ARCHIVE_MAX_ENTRIES = positiveIntEnv("BUILD_ARCHIVE_MAX_ENTRIES", 10000);
const PROJECT_ARCHIVE_MAX_BYTES = positiveIntEnv("PROJECT_ARCHIVE_MAX_MB", 256) * 1024 * 1024;
const PROJECT_ARCHIVE_MAX_ENTRIES = positiveIntEnv("PROJECT_ARCHIVE_MAX_ENTRIES", 20000);
const PROJECT_DOWNLOAD_TIMEOUT_MS = positiveIntEnv("PROJECT_DOWNLOAD_TIMEOUT_MS", 30000);
const ARGON2_MEMORY_COST = positiveIntEnv("ARGON2_MEMORY_COST", 65536);
const ARGON2_TIME_COST = positiveIntEnv("ARGON2_TIME_COST", 3);
const ARGON2_PARALLELISM = positiveIntEnv("ARGON2_PARALLELISM", 1);
// Admission control. Every limit below bounds work the caller can make this
// process do *before* it knows whether the caller is entitled to it, which is
// the only category of work an unauthenticated attacker can aim at scale.
//
// Password verification is the sharpest edge: Argon2 is configured to spend
// ARGON2_MEMORY_COST kibibytes per attempt and spends them whether or not the
// password turns out to be right, so an unthrottled login endpoint converts one
// HTTP request into 64 MB of resident memory on demand. Hence both a rate limit
// and a hard ceiling on simultaneous verifications: the rate limit makes the
// attack slow, the ceiling makes it survivable even when it is distributed
// widely enough that no single source ever trips the rate limit.
const AUTH_RATE_LIMIT = positiveIntEnv("AUTH_RATE_LIMIT", 10);
const AUTH_RATE_WINDOW_MS = positiveIntEnv("AUTH_RATE_WINDOW_MS", 60000);
// A wrong password costs several times a right one, so a credential-stuffing
// run exhausts its allowance far sooner than a person who mistyped once.
const AUTH_FAILURE_PENALTY = positiveIntEnv("AUTH_FAILURE_PENALTY", 4);
// Per account, independently of where the attempts come from: distributing an
// attack across a botnet defeats a per-address limit but not this one.
const AUTH_ACCOUNT_RATE_LIMIT = positiveIntEnv("AUTH_ACCOUNT_RATE_LIMIT", 12);
const AUTH_ACCOUNT_RATE_WINDOW_MS = positiveIntEnv("AUTH_ACCOUNT_RATE_WINDOW_MS", 900000);
const PASSWORD_HASH_CONCURRENCY = positiveIntEnv("PASSWORD_HASH_CONCURRENCY", 2);
const PASSWORD_HASH_QUEUE = positiveIntEnv("PASSWORD_HASH_QUEUE", 24);
// Compilation spawns real compiler processes. The gate is what stops N members
// pressing Compile from becoming N simultaneous TeX runs; the queue is short
// because a compilation the user is waiting on is worth queueing briefly and
// not worth queueing for a minute.
const COMPILE_CONCURRENCY = positiveIntEnv("COMPILE_CONCURRENCY", 2);
const COMPILE_QUEUE = positiveIntEnv("COMPILE_QUEUE", 8);
const COMPILE_RATE_LIMIT = positiveIntEnv("COMPILE_RATE_LIMIT", 30);
const COMPILE_RATE_WINDOW_MS = positiveIntEnv("COMPILE_RATE_WINDOW_MS", 300000);
// A general ceiling on authenticated API traffic per session. Generous enough
// that the editor never approaches it, low enough that a runaway client or a
// stolen cookie cannot be used to hammer the database.
const API_RATE_LIMIT = positiveIntEnv("API_RATE_LIMIT", 600);
const API_RATE_WINDOW_MS = positiveIntEnv("API_RATE_WINDOW_MS", 60000);
// How many realtime rooms one connection may hold open. Each room keeps the
// whole document in memory, so this bounds what a single socket can pin.
const COLLAB_MAX_ROOMS_PER_SESSION = positiveIntEnv("COLLAB_MAX_ROOMS_PER_SESSION", 50);
const COLLAB_MAX_SESSIONS_PER_USER = positiveIntEnv("COLLAB_MAX_SESSIONS_PER_USER", 12);
const APP_BASE_URL = parseAppBaseUrl(process.env.APP_BASE_URL || "");
const OAUTH_ISSUER_URL = String(process.env.OAUTH_ISSUER_URL || "").replace(/\/+$/, "");
const OAUTH_AUTHORIZATION_URL = process.env.OAUTH_AUTHORIZATION_URL || "";
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL || "";
const OAUTH_USERINFO_URL = process.env.OAUTH_USERINFO_URL || "";
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "";
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || "";
const OAUTH_SCOPE = process.env.OAUTH_SCOPE || "openid email profile";
const OAUTH_CLIENT_AUTH_METHOD = process.env.OAUTH_CLIENT_AUTH_METHOD || "client_secret_basic";
const OAUTH_AUTO_REGISTER = String(process.env.OAUTH_AUTO_REGISTER || "false") === "true";
// What an unknown SSO identity becomes when auto-registration is on. Both
// settings exist for an instance that is reachable from outside: the role decides
// how much an approved newcomer may do, and the approval requirement decides
// whether signing in successfully is enough to get in at all. Approval defaults to
// on, so an account provisioned by the identity provider waits for an
// administrator instead of walking straight into the workspace.
const OAUTH_DEFAULT_ROLE = autoRegisteredRole("OAUTH_DEFAULT_ROLE", process.env.OAUTH_DEFAULT_ROLE);
const OAUTH_APPROVAL_REQUIRED = String(process.env.OAUTH_APPROVAL_REQUIRED || "true") === "true";
const LATEX_ENGINES = new Set(["pdflatex", "xelatex", "lualatex", "xetex"]);
const LATEX_COMPILE_TOOLS = new Set(["pdflatex", "xelatex", "lualatex", "xetex", "bibtex", "biber", "makeindex"]);
const LILYPOND_COMPILE_TOOLS = new Set(["lilypond"]);
const LILYPOND_OUTPUT_FORMATS = new Set(["pdf", "png", "svg", "ps", "eps"]);
const PDFJS_BUILD_DIR = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "build");
// CodeMirror 6 is served as native ES modules resolved through the import map
// in Iris.html; the whitelist below maps public vendor names to each package's
// ESM entry inside node_modules (require.resolve anchors on the CJS entry).
const CODEMIRROR_MODULES = {
  "state.js": path.join(path.dirname(require.resolve("@codemirror/state")), "index.js"),
  "view.js": path.join(path.dirname(require.resolve("@codemirror/view")), "index.js"),
  "language.js": path.join(path.dirname(require.resolve("@codemirror/language")), "index.js"),
  "commands.js": path.join(path.dirname(require.resolve("@codemirror/commands")), "index.js"),
  "collab.js": path.join(path.dirname(require.resolve("@codemirror/collab")), "index.js"),
  "autocomplete.js": path.join(path.dirname(require.resolve("@codemirror/autocomplete")), "index.js"),
  "lezer-common.js": path.join(path.dirname(require.resolve("@lezer/common")), "index.js"),
  "lezer-highlight.js": path.join(path.dirname(require.resolve("@lezer/highlight")), "index.js"),
  "style-mod.js": path.join(path.dirname(require.resolve("style-mod")), "..", "src", "style-mod.js"),
  "w3c-keyname.js": path.join(path.dirname(require.resolve("w3c-keyname")), "index.js"),
  "crelt.js": path.join(path.dirname(require.resolve("crelt")), "..", "index.js"),
  "find-cluster-break.js": path.join(path.dirname(require.resolve("@marijn/find-cluster-break")), "..", "src", "index.js"),
};

let db;
const projectMutations = createProjectMutations({ fs, getDb: () => db, backupRoot: path.join(DATA_DIR, ".project-backups"), requestError });
let oauthDiscoveryCache = null;
let initialAdminCredentials = null;
let shuttingDown = false;
let inFlight = 0;
let inFlightMutations = 0;
const activeBuilds = new Set();
const backgroundPending = new Set();
const activeChildren = new Set();
let shutdownPromise = null;
let shutdownForced = false;
let maintenance = false;
let maintenancePoll = null;

// The admission controls declared above, instantiated. They are module state
// rather than per-request objects because a limiter that forgets between
// requests is not a limiter.
const authIpLimiter = new RateLimiter({ limit: AUTH_RATE_LIMIT, windowMs: AUTH_RATE_WINDOW_MS });
const authAccountLimiter = new RateLimiter({ limit: AUTH_ACCOUNT_RATE_LIMIT, windowMs: AUTH_ACCOUNT_RATE_WINDOW_MS });
const apiLimiter = new RateLimiter({ limit: API_RATE_LIMIT, windowMs: API_RATE_WINDOW_MS });
const compileLimiter = new RateLimiter({ limit: COMPILE_RATE_LIMIT, windowMs: COMPILE_RATE_WINDOW_MS });
const passwordHashGate = new ConcurrencyGate({ limit: PASSWORD_HASH_CONCURRENCY, queueLimit: PASSWORD_HASH_QUEUE });
const compileGate = new ConcurrencyGate({ limit: COMPILE_CONCURRENCY, queueLimit: COMPILE_QUEUE });

// Retention thresholds an owner may choose between, and the instance ceiling
// they cannot pass. Read once: changing them is an operator action that takes
// effect on restart, like every other environment setting here.
const RETENTION_CAPS = retentionCaps(process.env);
const AUDIT_RETENTION_DAYS = auditRetentionDays(process.env);
const RETENTION_ENABLED = String(process.env.RETENTION_ENABLED || "true") === "true";
const RETENTION_SWEEP_MS = positiveIntEnv("RETENTION_SWEEP_MS", 3600000);
// How long a directory abandoned by a crashed process is left alone before the
// sweep removes it. Long enough that it can never race a compilation that is
// merely slow, short enough that a crash does not cost a day of disk.
const RETENTION_ORPHAN_GRACE_MS = positiveIntEnv("RETENTION_ORPHAN_GRACE_MS", 6 * 60 * 60 * 1000);

// Observe on health/admission as well as the small poll: no watcher is needed.
function maintenanceActive() {
  const active = fsSync.existsSync(MAINTENANCE_FILE);
  if (active !== maintenance) {
    maintenance = active;
    collabSessions.forEach((session) => collabSend(session.socket, { t: "maintenance", active }));
    if (active && !shuttingDown) requestCollabDrain();
    if (!active && !shuttingDown) {
      // A failed drain retains its flags. Reopening restores ordinary debounce
      // and retry timers even if no client sends another edit.
      collabRooms.all().filter(collabRoomDirty).forEach(collabSchedulePersist);
      for (const [projectId, state] of collabProjects) {
        if (state.touchPending) collabScheduleTouch(projectId);
      }
    }
  }
  return active;
}

function startBackgroundWrite(work) {
  if (shuttingDown || maintenanceActive()) return Promise.resolve(null);
  const pending = Promise.resolve().then(work).finally(() => backgroundPending.delete(pending));
  backgroundPending.add(pending);
  return pending;
}

function trackedSpawn(command, args, options) {
  if (shutdownForced) throw requestError("SERVER_SHUTTING_DOWN", 503);
  const child = spawn(command, args, options);
  activeChildren.add(child);
  child.once("close", () => activeChildren.delete(child));
  return child;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".tex": "text/plain; charset=utf-8",
  ".ly": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function requiredSecret(name, value, insecureValues = []) {
  const secret = String(value || "");
  const normalized = secret.trim();
  if (!normalized || insecureValues.includes(normalized)) {
    throw new Error(`${name} must be set to a secure, non-default value`);
  }
  return secret;
}

// The server role auto-provisioning is allowed to assign. Admin is deliberately
// absent — an identity provider must never be able to mint one — and an
// unrecognised value stops the server instead of falling back: a typo would
// otherwise grant more access than the operator asked for, silently.
function autoRegisteredRole(name, value) {
  const role = String(value || "regular").trim().toLowerCase();
  if (role !== "regular" && role !== "external") {
    throw new Error(`${name} must be either "regular" or "external"`);
  }
  return role;
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function requestError(errorCode, status, params = {}, headers = {}) {
  const err = new Error(errorCode);
  err.errorCode = errorCode;
  err.status = status;
  err.params = params;
  err.headers = headers;
  return err;
}

// A refusal that tells the client when to come back. Retry-After is in seconds
// and is rounded up, never to zero: a client told to wait no time at all would
// retry immediately and be refused again, which is a busy loop rather than a
// backoff. The wait is also reported in the params so the interface can say it
// in words instead of leaving the user to guess.
function rateLimitError(errorCode, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return requestError(errorCode, 429, { retryAfter: seconds }, { "retry-after": String(seconds) });
}

// Charges a limiter and refuses the request when the caller cannot afford it.
function enforceRateLimit(limiter, key, errorCode, now = Date.now()) {
  const decision = limiter.consume(key, now);
  if (!decision.allowed) throw rateLimitError(errorCode, decision.retryAfterMs);
  return decision;
}

function errorJson(res, status, errorCode, params = {}, headers = {}) {
  return json(res, status, { errorCode, ...(Object.keys(params).length ? { params } : {}) }, headers);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { location, ...headers });
  res.end();
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("base64url");
}

function signedJson(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function verifySignedJson(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = String(token).split(".");
  const expected = sign(body);
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function makeToken(user, authMethod = "local") {
  if (!Number.isSafeInteger(user.session_version) || user.session_version < 0) throw new Error("Invalid session version");
  const payload = {
    sub: String(user.id),
    username: user.username,
    name: user.display_name,
    email: user.email,
    role: user.system_role || user.role || "regular",
    authMethod,
    sessionVersion: user.session_version,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  return signedJson(payload);
}

function verifyToken(token) {
  const payload = verifySignedJson(token);
  if (!payload || !Number.isSafeInteger(payload.sessionVersion) || payload.sessionVersion < 0) return null;
  // Sessions issued before migration 004 carry a numeric subject. Rejecting them
  // here turns a stale cookie into a clean re-login instead of a malformed uuid
  // reaching PostgreSQL.
  if (!isUuid(payload.sub)) return null;
  return payload;
}

function publicUser(rowOrToken) {
  const authMethod = rowOrToken.authMethod || rowOrToken.auth_method || (rowOrToken.auth_source === "oidc" ? "sso" : "local");
  return {
    id: String(rowOrToken.id || rowOrToken.sub),
    username: rowOrToken.username,
    name: rowOrToken.display_name || rowOrToken.name,
    email: rowOrToken.email,
    role: rowOrToken.system_role || rowOrToken.role || "regular",
    authMethod,
    canChangePassword: (rowOrToken.auth_source || authMethod) === "local",
    passwordChangeRequired:
      (rowOrToken.password_change_required ?? rowOrToken.passwordChangeRequired ?? false) === true,
  };
}

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: ARGON2_MEMORY_COST,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
};

// Every Argon2 call in the process funnels through the gate, so the ceiling
// holds no matter which endpoint reached it — login, password change, admin
// reset or seeding. ARGON2_MEMORY_COST kibibytes are resident for the duration
// of each one, so `PASSWORD_HASH_CONCURRENCY × ARGON2_MEMORY_COST` is the true
// worst-case memory this process will spend on password work, and it is a number
// the operator can compute in advance.
async function withPasswordHashSlot(work) {
  let release;
  try {
    if (shuttingDown) throw new GateRejectedError("AUTH_BUSY");
    release = await passwordHashGate.acquire();
  } catch (err) {
    if (err instanceof GateRejectedError) throw requestError("AUTH_BUSY", 503);
    throw err;
  }
  try {
    return await work();
  } finally {
    release();
  }
}

async function hashPassword(password) {
  return withPasswordHashSlot(() => argon2.hash(password, ARGON2_OPTIONS));
}

async function verifyPassword(password, stored) {
  const hash = String(stored || "");
  // Checked before the slot is taken: a malformed stored hash costs nothing and
  // must not be able to occupy a verification slot.
  if (!hash.startsWith("$argon2")) return { valid: false, needsRehash: false };
  return withPasswordHashSlot(async () => {
    try {
      const valid = await argon2.verify(hash, password);
      return {
        valid,
        needsRehash: valid && argon2.needsRehash(hash, ARGON2_OPTIONS),
      };
    } catch {
      return { valid: false, needsRehash: false };
    }
  });
}

function oauthEnabled() {
  return !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && (OAUTH_ISSUER_URL || (OAUTH_AUTHORIZATION_URL && OAUTH_TOKEN_URL && OAUTH_USERINFO_URL)));
}

function requestBaseUrl(req) {
  return APP_BASE_URL || requestOrigin(req, { trustProxy: TRUST_PROXY });
}

function oauthRedirectUri(req) {
  return OAUTH_REDIRECT_URI || `${requestBaseUrl(req)}/api/auth/sso/callback`;
}

// x-forwarded-for is caller-controlled, so it is honoured only where the
// deployment declares that a trusted proxy rewrites it.
function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

// The audit trail records what happened; it must never be the reason a request
// fails, so a failed write is logged and swallowed.
async function audit(event) {
  try {
    await recordAuditEvent(db, event);
  } catch (err) {
    console.error("Unable to record audit event", event && event.action, err.message || err);
  }
}

function sessionActor(req, user) {
  return { actorId: user.sub, actorLabel: user.username || user.email || `user:${user.sub}`, ip: clientIp(req) };
}

async function oauthEndpoints() {
  if (OAUTH_AUTHORIZATION_URL && OAUTH_TOKEN_URL && OAUTH_USERINFO_URL) {
    return {
      authorizationEndpoint: OAUTH_AUTHORIZATION_URL,
      tokenEndpoint: OAUTH_TOKEN_URL,
      userinfoEndpoint: OAUTH_USERINFO_URL,
    };
  }
  if (!OAUTH_ISSUER_URL) throw new Error("Incomplete OAuth configuration");
  if (oauthDiscoveryCache) return oauthDiscoveryCache;
  const discoveryUrl = `${OAUTH_ISSUER_URL}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OAuth discovery failed (${res.status})`);
  const data = await res.json();
  if (!data.authorization_endpoint || !data.token_endpoint || !data.userinfo_endpoint) {
    throw new Error("OAuth discovery response is missing required endpoints");
  }
  oauthDiscoveryCache = {
    authorizationEndpoint: data.authorization_endpoint,
    tokenEndpoint: data.token_endpoint,
    userinfoEndpoint: data.userinfo_endpoint,
  };
  return oauthDiscoveryCache;
}

function oauthStateToken() {
  return signedJson({
    state: crypto.randomBytes(24).toString("base64url"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 10 * 60,
  });
}

function timingSafeStringEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function oauthTokenRequest(code, redirectUri) {
  const endpoints = await oauthEndpoints();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (OAUTH_CLIENT_AUTH_METHOD === "client_secret_post") {
    body.set("client_id", OAUTH_CLIENT_ID);
    body.set("client_secret", OAUTH_CLIENT_SECRET);
  } else {
    headers.authorization = "Basic " + Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString("base64");
  }
  const res = await fetch(endpoints.tokenEndpoint, { method: "POST", headers, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "OAuth token exchange failed");
  return data;
}

async function oauthUserInfo(accessToken) {
  const endpoints = await oauthEndpoints();
  const res = await fetch(endpoints.userinfoEndpoint, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || "OAuth profile request failed");
  const email = String(data.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("The SSO provider did not return a valid email address");
  const subject = String(data.sub || "").trim();
  // The subject is the durable identity; without it there is nothing stable to
  // key the account on, so the profile is rejected rather than matched by email.
  if (!subject) throw new Error("The SSO provider did not return a subject (sub) claim");
  return {
    email,
    emailVerified: data.email_verified === true,
    subject,
    name: String(data.name || data.preferred_username || email).trim(),
    preferredUsername: String(data.preferred_username || email.split("@")[0]).trim(),
  };
}

function cleanUsername(value) {
  return String(value || "user")
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "user";
}

async function availableUsername(base) {
  const clean = cleanUsername(base);
  for (let i = 0; i < 100; i++) {
    const candidate = i ? `${clean}-${i + 1}`.slice(0, 80) : clean.slice(0, 80);
    const { rows } = await db.query("SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1", [candidate]);
    if (!rows.length) return candidate;
  }
  return `${clean.slice(0, 48)}-${crypto.randomBytes(4).toString("hex")}`;
}

const OAUTH_USER_COLUMNS =
  "id, username, email, display_name, system_role, status, auth_source, oidc_issuer, oidc_subject, oidc_link_pending, session_version, password_hash, password_change_required";

function disabledAccountError() {
  const err = new Error("Account disabled");
  err.status = 403;
  err.errorCode = "AUTH_ACCOUNT_DISABLED";
  return err;
}

// An account that was provisioned by the identity provider and is still waiting
// for an administrator. Told apart from a disabled one because they mean opposite
// things to the person reading the message: one has never had access, the other
// had it taken away.
function pendingAccountError() {
  const err = new Error("Account pending approval");
  err.status = 403;
  err.errorCode = "AUTH_ACCOUNT_PENDING";
  // The SSO callback can only carry a short code back to the login screen, and
  // this is the one refusal where the generic "sign-in failed" would send the
  // person to support instead of to whoever has to approve them.
  err.authError = "account_pending";
  return err;
}

// Every access check admits 'active' and refuses the rest; this only decides which
// refusal the account deserves.
function inactiveAccountError(status) {
  return status === "pending" ? pendingAccountError() : disabledAccountError();
}

// An SSO login whose durable identity is unknown but whose email matches an
// existing account: refused until an admin opens the one-time linking window.
function ssoLinkRequiredError() {
  const err = new Error("SSO account linking must be authorized by an administrator");
  err.status = 403;
  err.errorCode = "AUTH_SSO_LINK_REQUIRED";
  err.authError = "sso_link_required";
  return err;
}

async function userFromOAuthIdentity(issuer, subject) {
  const { rows } = await db.query(
    `SELECT ${OAUTH_USER_COLUMNS} FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2 LIMIT 1`,
    [issuer, subject]
  );
  const user = rows[0] || null;
  if (!user) return null;
  if (user.status !== "active") throw inactiveAccountError(user.status);
  if (user.auth_source !== "oidc") throw requestError("NOT_AUTHENTICATED", 401);
  return user;
}

async function userFromOAuthProfile(profile, ip = null) {
  const issuer = OAUTH_ISSUER_URL || null;
  const subject = profile.subject || null;
  // SSO sign-in needs an issuer even with explicit endpoints. oauthUserInfo
  // rejects an empty subject; the pair is the durable account identity.
  if (!issuer || !subject) throw new Error("SSO profile is missing a durable identity");

  const existing = await userFromOAuthIdentity(issuer, subject);
  if (existing) {
    const nextName = profile.name || existing.display_name;
    if (nextName && nextName !== existing.display_name) {
      await db.query("UPDATE users SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [nextName, existing.id]);
      existing.display_name = nextName;
    }
    return existing;
  }

  // No durable-identity match. Email is never used to silently adopt an account:
  // binding an existing account requires verified email and an admin-opened
  // one-time linking window, after which the account is SSO-only.
  const byEmail = await db.query(
    `SELECT ${OAUTH_USER_COLUMNS} FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [profile.email]
  );
  const emailMatch = byEmail.rows[0] || null;
  if (emailMatch) {
    if (emailMatch.status !== "active") throw inactiveAccountError(emailMatch.status);
    // Refuse email reuse, including accounts with only a partial binding.
    if (emailMatch.oidc_issuer !== null || emailMatch.oidc_subject !== null) {
      throw new Error("This email is already linked to a different SSO identity");
    }
    if (!emailMatch.oidc_link_pending) throw ssoLinkRequiredError();
    if (profile.emailVerified !== true) throw new Error("The SSO provider did not verify this email address");
    // Recheck the snapshot at the mutation boundary so an admin change or a
    // competing link wins over this stale callback without losing credentials.
    const converted = await db.query(
      `UPDATE users SET oidc_issuer = $1, oidc_subject = $2, auth_source = 'oidc',
         password_hash = NULL, oidc_link_pending = FALSE, oidc_linked_at = CURRENT_TIMESTAMP,
         password_change_required = FALSE, session_version = session_version + 1,
         session_epoch = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND LOWER(email) = LOWER($4)
         AND oidc_link_pending = TRUE AND status = 'active'
         AND oidc_issuer IS NULL AND oidc_subject IS NULL
         AND session_version = $5 AND auth_source = $6
       RETURNING ${OAUTH_USER_COLUMNS}`,
      [issuer, subject, emailMatch.id, emailMatch.email, emailMatch.session_version, emailMatch.auth_source]
    );
    if (!converted.rows.length) throw requestError("NOT_AUTHENTICATED", 401);
    collabRevokeUser(emailMatch.id);
    await audit({
      action: "user.oidc_linked",
      actorId: emailMatch.id,
      actorLabel: emailMatch.username,
      ip,
      targetType: "user",
      targetId: emailMatch.id,
      metadata: { issuer },
    });
    return converted.rows[0];
  }

  if (!OAUTH_AUTO_REGISTER) {
    const err = new Error("Unauthorized SSO user");
    err.status = 403;
    throw err;
  }

  const username = await availableUsername(profile.preferredUsername || profile.email);
  const displayName = profile.name || profile.email;
  // An identity the provider vouches for is still not an account this server has
  // accepted. Unless approval is switched off the row is created pending, and the
  // very sign-in that created it is refused like any other inactive account: the
  // account exists so an administrator can decide on it, not so it can be used.
  const status = OAUTH_APPROVAL_REQUIRED ? "pending" : "active";
  let id;
  let created;
  try {
    const result = await db.query(
      `INSERT INTO users (id, username, email, display_name, system_role, status, password_hash, auth_source, oidc_issuer, oidc_subject)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'oidc', $7, $8) RETURNING ${OAUTH_USER_COLUMNS}`,
      [uuidv7(), username, profile.email, displayName, OAUTH_DEFAULT_ROLE, status, issuer, subject]
    );
    created = result.rows[0];
    id = String(created.id);
  } catch (err) {
    if (err.code !== "23505") throw err;
    // Another provisioner may have created this identity. Email or username
    // collisions alone must never authenticate the account that won the race.
    const retry = await userFromOAuthIdentity(issuer, subject);
    if (retry) return retry;
    throw err;
  }
  await audit({
    action: "user.created",
    actorId: id,
    actorLabel: username,
    ip,
    targetType: "user",
    targetId: id,
    metadata: { authSource: "oidc", autoRegistered: true, email: profile.email, role: OAUTH_DEFAULT_ROLE, status },
  });
  if (status !== "active") throw pendingAccountError();
  return created;
}

async function initDb() {
  db = await createDatabase({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    connectTimeout: DB_CONNECT_TIMEOUT,
  });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await initializeProjectTemplates(TEMPLATE_DIR, path.join(PUBLIC_DIR, "templates"));
  // Migration 002 rewrote the recorded storage locations: the directories they
  // now name must hold the project data before the first request is served.
  await relocateProjectStorage({ db, dataDir: DATA_DIR });
  await seedUsers();
}

async function seedUsers() {
  const { rows } = await db.query("SELECT COUNT(*) AS n FROM users");
  if (Number(rows[0].n) > 0) return;
  const password = crypto.randomBytes(18).toString("base64url");
  const created = await db.query(
    "INSERT INTO users (id, username, email, display_name, system_role, password_hash, auth_source) VALUES ($1, $2, $3, $4, 'admin', $5, 'local') RETURNING id",
    [uuidv7(), "admin", "admin@iris.local", "Iris Admin", await hashPassword(password)]
  );
  initialAdminCredentials = { username: "admin", password };
  await audit({
    action: "user.created",
    actorLabel: "system",
    targetType: "user",
    targetId: created.rows[0].id,
    metadata: { username: "admin", role: "admin", reason: "initial_admin" },
  });
}

async function readRequestBuffer(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw requestError("REQUEST_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

async function readBody(req) {
  const body = await readRequestBuffer(req);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw requestError("INVALID_JSON", 400);
  }
}

// Authenticates against the current database state on every request, not just
// the signed token. This is what makes an account change take effect at once: a
// disabled account, a bumped session version (a forced sign-out or password reset)
// or a role change is honoured on the very next request rather than lingering
// until the token expires.
async function requireUser(req, queryable = db) {
  const token = parseCookies(req).iris_session;
  const payload = verifyToken(token);
  if (!payload) throw requestError("NOT_AUTHENTICATED", 401);

  const { rows } = await queryable.query(
    "SELECT id, username, email, display_name, system_role, status, auth_source, session_version, password_change_required FROM users WHERE id = $1 LIMIT 1",
    [payload.sub]
  );
  const row = rows[0];
  if (!row || row.status !== "active" || row.session_version !== payload.sessionVersion
      || payload.exp <= Math.floor(Date.now() / 1000)) throw requestError("NOT_AUTHENTICATED", 401);

  return {
    sub: String(row.id),
    username: row.username,
    email: row.email,
    name: row.display_name,
    role: row.system_role,
    status: row.status,
    auth_source: row.auth_source,
    passwordChangeRequired: row.password_change_required === true,
    authMethod: payload.authMethod || (row.auth_source === "oidc" ? "sso" : "local"),
    iat: payload.iat,
    sessionVersion: row.session_version,
    exp: payload.exp,
  };
}

function requireAdmin(user) {
  if (!user || user.role !== "admin") throw requestError("ADMIN_REQUIRED", 403);
  return user;
}

function cleanName(name) {
  const out = String(name || "").trim().replace(/\s+/g, " ");
  if (!out) {
    throw requestError("PROJECT_NAME_REQUIRED", 400);
  }
  if (out.length > 80) {
    throw requestError("PROJECT_NAME_TOO_LONG", 400);
  }
  return out;
}

function slugify(name) {
  return String(name || "project")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-")
    .slice(0, 48)
    .toLowerCase() || "project";
}

function encodeDispositionValue(value) {
  return encodeURIComponent(String(value || "download"))
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function toMillis(value) {
  if (!value) return Date.now();
  if (value instanceof Date) return value.getTime();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function countFiles(data) {
  let n = 0;
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((x) => {
      if (x.generated) return;
      if (x.type === "folder") walk(x.children);
      else n += 1;
    });
  };
  if (data && data.project) walk(data.project.nodes);
  return n;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function safeRelPath(relPath) {
  const raw = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw requestError("PROJECT_PATH_INVALID", 400);
  }
  return normalized;
}

function safeProjectSourcePath(relPath) {
  const normalized = safeRelPath(relPath);
  const rootName = normalized.split("/", 1)[0].toLowerCase();
  if (rootName === "output" || rootName === ".iris") {
    throw requestError("PROJECT_PATH_INVALID", 400);
  }
  return normalized;
}

function nodeRelPath(node, fallbackName, parentPath = "") {
  const rel = node.path || path.posix.join(parentPath, node.name || fallbackName || "");
  return safeProjectSourcePath(rel);
}

function validateProjectSourceTree(data) {
  const walk = (nodes, parentPath = "") => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || node.generated) continue;
      if (node.readOnly) throw requestError("PROJECT_PATH_INVALID", 400);
      if (node.type === "folder") {
        const relative = safeProjectSourcePath(path.posix.join(parentPath, node.name || ""));
        walk(node.children, relative);
      } else {
        nodeRelPath(node, node.name, parentPath);
      }
    }
  };
  walk(data && data.project && data.project.nodes);
}

// The header of a data URL is everything before the first comma, and the media
// type inside it may carry parameters: `data:text/plain; charset=utf-8;base64,`
// is what a browser produces for a text file. Splitting on the first `;` instead
// misses the encoding, and the caller then writes the URL itself as the file's
// bytes, which is how an uploaded .bib turned into one long base64 line.
function dataUrlToBuffer(value) {
  const textValue = String(value || "");
  const match = textValue.match(/^data:([^,]*),([\s\S]*)$/);
  if (!match) return Buffer.from(textValue, "utf8");
  const payload = match[2] || "";
  if (/;\s*base64\s*$/i.test(match[1])) return Buffer.from(payload, "base64");
  try {
    return Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    return Buffer.from(payload, "utf8");
  }
}

function mimeForProjectFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".tex", ".ly", ".ily", ".bib", ".ris", ".bst", ".bbx", ".cbx", ".lbx", ".txt", ".sty", ".cls", ".md", ".log", ".aux", ".bbl", ".blg", ".idx", ".ilg", ".ind", ".out", ".toc", ".bcf", ".fls", ".fdb_latexmk"].includes(ext)) return "text/plain; charset=utf-8";
  if (ext === ".xml") return "application/xml; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".ps" || ext === ".eps") return "application/postscript";
  if (ext === ".mid" || ext === ".midi") return "audio/midi";
  if (ext === ".ttf") return "font/ttf";
  if (ext === ".otf") return "font/otf";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

// Whether a node carries its bytes as a data URL rather than as text. The
// extension decides first: a text source stays text even when the node claims
// otherwise, so a .bib attached through the upload dialog — which used to flag
// every file it read as base64 — is stored, edited and versioned as text.
function fileIsBinaryNode(node) {
  const filePath = node.path || node.name || "";
  if (/\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(filePath)) return true;
  if (fileIsTextPath(filePath)) return false;
  return node.encoding === "base64" || node.binary === true || node.kind === "img" || node.data != null;
}

function fileIsFontPath(filePath) {
  return /\.(ttf|otf|woff2?)$/i.test(filePath || "");
}

function fontPreviewFamily(fileName) {
  return "IrisUser_" + path.basename(String(fileName || "font"), path.extname(String(fileName || "")))
    .replace(/[^a-zA-Z0-9]/g, "_");
}

function reconcileProjectFonts(data) {
  const nodesByPath = new Map();
  const walk = (nodes, parentPath = "") => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || node.generated || node.readOnly) continue;
      if (node.type === "folder") {
        const rel = safeProjectSourcePath(path.posix.join(parentPath, node.name || ""));
        walk(node.children, rel);
        continue;
      }
      const rel = nodeRelPath(node, node.name, parentPath);
      if (rel.startsWith("fonts/") && fileIsFontPath(rel)) nodesByPath.set(rel, node);
    }
  };
  walk(data && data.project && data.project.nodes);

  const existing = new Map();
  for (const font of Array.isArray(data && data.fonts) ? data.fonts : []) {
    if (!font || !font.path) continue;
    let rel;
    try { rel = safeRelPath(font.path); } catch { continue; }
    if (rel.startsWith("fonts/") && fileIsFontPath(rel)) existing.set(rel, font);
  }
  data.fonts = [...nodesByPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rel, node]) => {
      const prior = existing.get(rel) || {};
      return {
        ...prior,
        family: prior.family || fontPreviewFamily(rel),
        name: path.posix.basename(rel),
        path: rel,
        ...(prior.data || node.data ? { data: prior.data || node.data } : {}),
      };
    });
  return data.fonts;
}

function fileKindForPath(filePath) {
  if (/\.tex$/i.test(filePath)) return "tex";
  if (/\.ly$/i.test(filePath)) return "ly";
  if (/\.bib$/i.test(filePath)) return "bib";
  if (/\.ris$/i.test(filePath)) return "ris";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(filePath)) return "img";
  if (/\.(pdf|ps|eps|aux|bbl|bcf|blg|idx|ilg|ind|log|out|toc|run\.xml|fls|fdb_latexmk)$/i.test(filePath)) return "artifact";
  return "file";
}

// Bibliography styles (bst for BibTeX, bbx/cbx/lbx for biblatex) are plain text
// like any other source: a project that carries its own style keeps it editable
// and versioned instead of stored as an opaque payload.
function fileIsTextPath(filePath) {
  return /\.(tex|ly|ily|bib|ris|bst|bbx|cbx|lbx|txt|sty|cls|md|csv|dat|scm|lua|json|ya?ml|log|aux|bbl|blg|idx|ilg|ind|out|toc|xml|bcf|fls|fdb_latexmk)$/i.test(filePath || "");
}

function decodeProjectText(bytes, filePath) {
  const probe = bytes.toString("utf8");
  if (/\.(bib|ris)$/i.test(filePath) || (!/\.(sty|cls|bst|bbx|cbx|lbx)$/i.test(filePath) && Bibliography.candidate(probe))) {
    try { return Bibliography.decodeUtf8(bytes); }
    catch { throw requestError("BIBLIOGRAPHY_INVALID_ENCODING", 422, { path: filePath }); }
  }
  return probe;
}

function generatedIdFor(relPath) {
  return "gen_" + crypto.createHash("sha1").update(relPath).digest("hex").slice(0, 12);
}

function isIgnoredProjectFsEntry(name) {
  const normalized = String(name || "").toLowerCase();
  return normalized === ".iris" || normalized === ".ds_store" || normalized === "thumbs.db" || normalized === "desktop.ini";
}

function stripGeneratedNodes(nodes, isRoot = true) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((node) => !node.generated && !node.readOnly && !(isRoot && String(node.name || "").toLowerCase() === "output"))
    .map((node) => {
      if (node.type === "folder") node.children = stripGeneratedNodes(node.children, false);
      return node;
    });
}

function stripFilePayloads(data) {
  const meta = clonePlain(data);
  const strip = (nodes) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node) => {
      if (node.type === "folder") strip(node.children);
      else {
        // The manifest records how the bytes live on disk, so it is derived from
        // the file itself: a stale flag on an incoming node cannot keep a text
        // source in the data URL round-trip it never belonged in.
        if (fileIsBinaryNode(node)) {
          node.binary = true;
          node.encoding = "base64";
        } else {
          delete node.binary;
          node.encoding = "utf8";
        }
        delete node.content;
        delete node.data;
        delete node.sourceError;
      }
    });
  };
  if (meta.project) {
    meta.project.nodes = stripGeneratedNodes(meta.project.nodes);
    strip(meta.project.nodes);
  }
  if (Array.isArray(meta.fonts)) meta.fonts.forEach((font) => delete font.data);
  meta.assets = {};
  return meta;
}

async function ensureProjectDirs(storagePath, data) {
  const dirs = new Set([".iris"]);
  const walk = (nodes, parentPath = "") => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node) => {
      if (node.generated) return;
      if (node.type === "folder") {
        const rel = safeProjectSourcePath(path.posix.join(parentPath, node.name || ""));
        dirs.add(rel);
        walk(node.children, rel);
      }
    });
  };
  if (data.project) walk(data.project.nodes);
  if (Array.isArray(data.fonts) && data.fonts.length) dirs.add("fonts");
  for (const rel of dirs) await fs.mkdir(path.join(storagePath, rel), { recursive: true });
}

async function writeProjectNodes(storagePath, data) {
  const expectedFiles = new Set();
  const assets = data.assets || {};
  const walk = async (nodes, parentPath = "") => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.generated) continue;
      if (node.type === "folder") {
        const rel = safeProjectSourcePath(path.posix.join(parentPath, node.name || ""));
        await walk(node.children, rel);
        continue;
      }
      const rel = nodeRelPath(node, node.name, parentPath);
      expectedFiles.add(rel);
      const abs = path.join(storagePath, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      if (fileIsBinaryNode(node)) {
        const dataUrl = node.data || assets[rel] || assets[node.path];
        if (dataUrl != null) await fs.writeFile(abs, dataUrlToBuffer(dataUrl));
      } else if (node.content != null) {
        await fs.writeFile(abs, String(node.content), "utf8");
      } else {
        // A source node without content means the client is not writing this
        // file: it never edited it in this session. The bytes on disk stay, so a
        // save can no longer overwrite a collaborator's newer text with the copy
        // this client happened to load. A file that does not exist yet is still
        // created from its decoded upload payload when one was supplied.
        const stat = await fs.stat(abs).catch((err) => { if (err.code !== "ENOENT") throw err; return null; });
        if (!stat) {
          const dataUrl = node.data || assets[rel] || assets[node.path];
          await fs.writeFile(abs, dataUrl == null ? "" : dataUrlToBuffer(dataUrl));
        }
      }
    }
  };
  if (data.project) await walk(data.project.nodes);
  return expectedFiles;
}

// Fills in the payloads the client left out. A save omits the content of every
// file it did not edit so it cannot overwrite a collaborator's newer text, and
// the project directory answers for those files. Materializing that same
// snapshot into an empty directory — which is what a build staging tree is —
// would instead create them empty, so the bytes on disk are read back in first.
async function hydrateProjectPayloads(storagePath, data) {
  const assets = data.assets || {};
  const walk = async (nodes, parentPath = "") => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || node.generated) continue;
      if (node.type === "folder") {
        await walk(node.children, safeProjectSourcePath(path.posix.join(parentPath, node.name || "")));
        continue;
      }
      const rel = nodeRelPath(node, node.name, parentPath);
      if (fileIsBinaryNode(node)) {
        if (node.data != null || assets[rel] != null || assets[node.path] != null) continue;
        const buffer = await fs.readFile(path.join(storagePath, rel)).catch(() => null);
        if (buffer) node.data = `data:${mimeForProjectFile(rel)};base64,${buffer.toString("base64")}`;
      } else if (node.content == null) {
        const bytes = await fs.readFile(path.join(storagePath, rel)).catch(() => null);
        if (bytes != null) {
          try {
            node.content = decodeProjectText(bytes, rel);
            delete node.sourceError;
          } catch (err) {
            if (err.errorCode !== "BIBLIOGRAPHY_INVALID_ENCODING") throw err;
            delete node.content;
            node.sourceError = err.errorCode;
            node.data = `data:${mimeForProjectFile(rel)};base64,${bytes.toString("base64")}`;
          }
        }
      }
    }
  };
  if (data.project) await walk(data.project.nodes);
  for (const font of Array.isArray(data.fonts) ? data.fonts : []) {
    if (!font || !font.path || font.data != null) continue;
    let rel;
    try { rel = safeRelPath(font.path); } catch { continue; }
    const buffer = await fs.readFile(path.join(storagePath, rel)).catch(() => null);
    if (buffer) font.data = `data:${mimeForProjectFile(rel)};base64,${buffer.toString("base64")}`;
  }
  return data;
}

async function writeProjectFonts(storagePath, data, expectedFiles) {
  if (!Array.isArray(data.fonts)) return;
  for (const font of data.fonts) {
    if (!font || !font.path) continue;
    const rel = safeRelPath(font.path);
    if (!rel.startsWith("fonts/") || !fileIsFontPath(rel)) continue;
    expectedFiles.add(rel);
    if (!font.data) continue;
    const abs = path.join(storagePath, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, dataUrlToBuffer(font.data));
  }
}

async function pruneProjectFiles(storagePath, expectedFiles) {
  async function walkDir(dir, relBase = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.toLowerCase() === ".iris") continue;
      if (!relBase && entry.name.toLowerCase() === "output") continue;
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(abs, rel);
        const rest = await fs.readdir(abs);
        if (!rest.length) await fs.rmdir(abs);
      } else if (!expectedFiles.has(rel)) {
        await fs.unlink(abs);
      }
    }
  }
  await walkDir(storagePath);
}

async function buildFsNode(storagePath, relPath, entry, generated, textHint = false, strictRead = false) {
  const abs = path.join(storagePath, relPath);
  if (entry.isDirectory()) {
    const children = await scanFsTree(storagePath, relPath, generated, strictRead);
    return {
      type: "folder",
      name: entry.name,
      open: false,
      ...(generated ? { generated: true, readOnly: true } : {}),
      children,
    };
  }
  const kind = fileKindForPath(relPath);
  const node = {
    type: "file",
    id: generated ? generatedIdFor(relPath) : "fs_" + generatedIdFor(relPath),
    name: entry.name,
    kind,
    path: relPath,
    ...(generated ? { generated: true, readOnly: true } : {}),
  };
  if (!generated) {
    if (textHint || fileIsTextPath(relPath)) {
      node.encoding = "utf8";
      const bytes = await fs.readFile(abs).catch((err) => { if (strictRead) throw err; return Buffer.alloc(0); });
      try { node.content = decodeProjectText(bytes, relPath); }
      catch (err) {
        if (err.errorCode !== "BIBLIOGRAPHY_INVALID_ENCODING") throw err;
        node.sourceError = err.errorCode;
      }
    }
    else {
      const buf = await fs.readFile(abs).catch((err) => { if (strictRead) throw err; return null; });
      if (buf) {
        node.binary = true;
        node.encoding = "base64";
        node.data = `data:${mimeForProjectFile(relPath)};base64,${buf.toString("base64")}`;
      }
    }
  }
  return node;
}

async function scanFsTree(storagePath, relBase = "", generated = false, strictRead = false) {
  const absBase = path.join(storagePath, relBase);
  const entries = await fs.readdir(absBase, { withFileTypes: true }).catch((err) => { if (strictRead) throw err; return []; });
  const nodes = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isIgnoredProjectFsEntry(entry.name)) continue;
    if (!relBase && entry.name.toLowerCase() === "output") continue;
    const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
    nodes.push(await buildFsNode(storagePath, rel, entry, generated, false, strictRead));
  }
  return nodes;
}

async function resolveProjectFile(storagePath, requestedPath) {
  const rel = safeRelPath(requestedPath);
  if (rel === ".iris" || rel.startsWith(".iris/")) throw requestError("PROJECT_PATH_INVALID", 400);
  const storageReal = await fs.realpath(storagePath);
  const fileReal = await fs.realpath(path.join(storagePath, rel)).catch(() => null);
  if (!fileReal || (fileReal !== storageReal && !fileReal.startsWith(storageReal + path.sep))) {
    throw requestError("PROJECT_FILE_NOT_FOUND", 404);
  }
  const stat = await fs.stat(fileReal).catch(() => null);
  if (!stat || !stat.isFile()) throw requestError("PROJECT_FILE_NOT_FOUND", 404);
  return { path: fileReal, name: path.basename(rel), mimeType: mimeForProjectFile(rel), size: stat.size };
}

async function syncNodesWithFilesystem(storagePath, data, strictRead = false) {
  if (!data.project) data.project = { nodes: [] };
  data.project.nodes = stripGeneratedNodes(data.project.nodes);

  const merge = async (nodes, relBase = "") => {
    const absBase = path.join(storagePath, relBase);
    const entries = await fs.readdir(absBase, { withFileTypes: true }).catch((err) => { if (strictRead) throw err; return []; });
    const visibleEntries = entries.filter((entry) => !isIgnoredProjectFsEntry(entry.name) && (relBase || entry.name.toLowerCase() !== "output"));
    const entryByName = new Map(visibleEntries.map((entry) => [entry.name, entry]));
    const synced = [];

    for (const node of nodes || []) {
      const entry = entryByName.get(node.name);
      if (!entry) continue;
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (node.type === "folder") {
          node.children = await merge(node.children || [], rel);
          synced.push(node);
        } else {
          synced.push(await buildFsNode(storagePath, rel, entry, false, false, strictRead));
        }
      } else if (node.type === "folder") {
        synced.push(await buildFsNode(storagePath, rel, entry, false, false, strictRead));
      } else {
        const textHint = node.encoding === "utf8" || (node.content != null && !fileIsBinaryNode(node));
        const hydrated = await buildFsNode(storagePath, rel, entry, false, textHint, strictRead);
        const merged = {
          ...hydrated,
          ...node,
          kind: hydrated.kind,
          path: hydrated.path,
          content: hydrated.content,
          data: hydrated.data,
          // The flags describe how the bytes on disk were just read, so they
          // come from the file rather than from what the client believed.
          encoding: hydrated.encoding,
          binary: hydrated.binary,
          sourceError: hydrated.sourceError,
        };
        if (merged.sourceError) delete merged.content;
        synced.push(merged);
      }
    }

    const known = new Set(synced.map((node) => node.name));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredProjectFsEntry(entry.name)) continue;
      if (!relBase && entry.name.toLowerCase() === "output") continue;
      if (known.has(entry.name)) continue;
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      synced.push(await buildFsNode(storagePath, rel, entry, false, false, strictRead));
    }
    return synced;
  };

  data.project.nodes = await merge(data.project.nodes, "");
}

async function readProjectFile(storagePath, { strictRead = false } = {}) {
  const metaFile = path.join(storagePath, ".iris", "project.json");
  const data = JSON.parse(await fs.readFile(metaFile, "utf8")) || {};
  if (!data.project) data.project = { nodes: [] };
  data.assets = data.assets || {};
  // Missing stale manifest entries are reconciled by the scan below. Compile
  // must not mistake other read failures for empty text or absent assets.
  const hydrate = async (nodes, parentPath = "") => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.type === "folder") {
        const rel = safeProjectSourcePath(path.posix.join(parentPath, node.name || ""));
        await hydrate(node.children, rel);
        continue;
      }
      const rel = nodeRelPath(node, node.name, parentPath);
      const abs = path.join(storagePath, rel);
      // The filesystem reconciliation below reads bibliography bytes fatally.
      // Do not first hydrate these sources with a replacement-text decoder.
      if (/\.(bib|ris)$/i.test(rel)) continue;
      if (fileIsBinaryNode(node)) {
        const buf = await fs.readFile(abs).catch((err) => { if (strictRead && err.code !== "ENOENT") throw err; return null; });
        if (buf) {
          const dataUrl = `data:${mimeForProjectFile(rel)};base64,${buf.toString("base64")}`;
          node.data = dataUrl;
          data.assets[rel] = dataUrl;
        }
      } else {
        const bytes = await fs.readFile(abs).catch((err) => { if (strictRead && err.code !== "ENOENT") throw err; return null; });
        if (bytes != null) {
          try { node.content = decodeProjectText(bytes, rel); }
          catch (err) {
            if (err.errorCode !== "BIBLIOGRAPHY_INVALID_ENCODING") throw err;
            delete node.content;
            node.sourceError = err.errorCode;
          }
        }
        else node.content = "";
      }
    }
  };
  await hydrate(data.project.nodes);
  await syncNodesWithFilesystem(storagePath, data, strictRead);
  data.projectType = inferProjectType(data);
  reconcileProjectFonts(data);
  const hydratedFonts = [];
  for (const font of data.fonts) {
    const buf = await fs.readFile(path.join(storagePath, font.path)).catch((err) => { if (strictRead) throw err; return null; });
    if (!buf) continue;
    font.data = `data:${mimeForProjectFile(font.path)};base64,${buf.toString("base64")}`;
    hydratedFonts.push(font);
  }
  data.fonts = hydratedFonts;
  return data;
}

async function readProjectManifest(storagePath) {
  const metaFile = path.join(storagePath, ".iris", "project.json");
  return JSON.parse(await fs.readFile(metaFile, "utf8"));
}

async function writeProjectManifest(storagePath, data) {
  const irisDir = path.join(storagePath, ".iris");
  await fs.mkdir(irisDir, { recursive: true });
  const file = path.join(irisDir, "project.json");
  const tmp = path.join(irisDir, `.project.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(stripFilePayloads(data), null, 2), "utf8");
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// Moves the bytes of renamed or relocated files on disk before the tree is
// written, so a rename preserves the file instead of deleting and recreating it.
async function preflightProjectRenames(storagePath, renames) {
  const sources = new Set(renames.map((move) => move.from.toLowerCase()));
  const destinations = new Set();
  for (const move of renames) {
    const destination = move.to.toLowerCase();
    if (sources.has(destination) || destinations.has(destination)) throw requestError("PROJECT_PATH_INVALID", 400);
    destinations.add(destination);
    const src = await fs.lstat(path.join(storagePath, move.from));
    if (!src.isFile()) throw requestError("PROJECT_PATH_INVALID", 400);
    const occupied = await fs.lstat(path.join(storagePath, move.to)).catch((err) => { if (err.code !== "ENOENT") throw err; return null; });
    if (occupied) throw requestError("PROJECT_PATH_INVALID", 400);
    let parent = path.posix.dirname(move.to);
    while (parent !== ".") {
      const stat = await fs.lstat(path.join(storagePath, parent)).catch((err) => { if (err.code !== "ENOENT") throw err; return null; });
      if (stat && !stat.isDirectory()) throw requestError("PROJECT_PATH_INVALID", 400);
      parent = path.posix.dirname(parent);
    }
  }
}

async function applyProjectRenames(storagePath, renames) {
  const moves = (renames || []).filter((move) => move.from !== move.to);
  await preflightProjectRenames(storagePath, moves);
  for (const move of moves) {
    const src = path.join(storagePath, move.from);
    const dest = path.join(storagePath, move.to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
  }
}

async function writeProjectFile(storagePath, data, renames = []) {
  validateProjectSourceTree(data);
  await fs.mkdir(storagePath, { recursive: true });
  reconcileProjectFonts(data);
  await ensureProjectDirs(storagePath, data);
  await applyProjectRenames(storagePath, renames);
  const expectedFiles = await writeProjectNodes(storagePath, data);
  await writeProjectFonts(storagePath, data, expectedFiles);
  await pruneProjectFiles(storagePath, expectedFiles);
  await writeProjectManifest(storagePath, data);
}

async function collectProjectArchiveEntries(storagePath, projectName, limits = {}) {
  const entries = [];
  const maxBytes = Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 0 ? limits.maxBytes : Infinity;
  const maxEntries = Number.isSafeInteger(limits.maxEntries) && limits.maxEntries >= 0 ? limits.maxEntries : Infinity;
  let totalBytes = 0;
  let totalEntries = 0;
  const reserve = (size = 0) => {
    totalEntries += 1;
    totalBytes += size;
    if (totalEntries > maxEntries || totalBytes > maxBytes) {
      const error = new Error("Project archive exceeds configured limits");
      error.code = "PROJECT_ARCHIVE_TOO_LARGE";
      throw error;
    }
  };
  const walk = async (directory, relBase = "") => {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredProjectFsEntry(child.name)) continue;
      const rel = relBase ? path.posix.join(relBase, child.name) : child.name;
      const absolute = path.join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        reserve();
        entries.push({ name: rel, directory: true });
        await walk(absolute, rel);
      } else if (child.isFile()) {
        const stat = await fs.stat(absolute);
        reserve(stat.size);
        entries.push({ name: rel, data: await fs.readFile(absolute) });
      }
    }
  };
  await walk(storagePath);

  const manifest = stripFilePayloads(await readProjectManifest(storagePath));
  manifest.project = manifest.project && typeof manifest.project === "object" ? manifest.project : { nodes: [] };
  manifest.project.name = projectName;
  manifest.irisArchive = {
    format: "iris-project",
    version: 1,
    exportedAt: new Date().toISOString(),
  };
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  reserve();
  reserve(manifestData.length);
  entries.push({ name: ".iris", directory: true });
  entries.push({ name: ".iris/project.json", data: manifestData });
  return entries;
}

async function buildProjectArchive(storagePath, projectName, limits = {}) {
  return createZip(await collectProjectArchiveEntries(storagePath, projectName, limits));
}

// storage_path is relative to DATA_DIR; every caller works with the absolute
// directory, so it is resolved once here.
function withStorageDir(row) {
  return { ...row, storageDir: resolveProjectStorageDir(DATA_DIR, row.storage_path) };
}

// The retention columns as the policy module expects them. A null column means
// "follow the instance default", and clamping happens on every read rather than
// on write, so lowering the operator's ceiling takes effect immediately on
// projects that had been allowed a higher value under the previous one.
function projectRetentionSettings(row) {
  return {
    buildKeep: row.build_keep,
    buildDays: row.build_days,
    versionKeep: row.version_keep,
    versionDays: row.version_days,
  };
}

function projectRetention(row) {
  return clampRetention(projectRetentionSettings(row), RETENTION_CAPS);
}

// The single authorization chokepoint for a project. Membership is the authority:
// a non-member cannot tell the project apart from one that does not exist (404),
// while a member who lacks the capability for this action is told plainly (403).
// The caller receives the project row, its resolved storage directory and the
// requester's role. A permission change takes effect at once because this runs on
// every request, exactly like the per-request account check in requireUser.
async function authorizeProject(id, user, capability, queryable = db) {
  const { rows } = await queryable.query(
    `SELECT p.id, p.name, p.storage_path, p.created_at, p.updated_at, p.revision,
            p.build_keep, p.build_days, p.version_keep, p.version_days, m.role
     FROM projects p JOIN project_members m ON m.project_id = p.id
     WHERE p.id = $1 AND m.user_id = $2`,
    [id, user.sub]
  );
  if (!rows.length) throw requestError("PROJECT_NOT_FOUND", 404);
  const row = rows[0];
  if (!roleHasCapability(row.role, capability)) throw requestError("PROJECT_FORBIDDEN", 403);
  return { ...withStorageDir(row), role: row.role };
}

function authorizedProjectGate(id, user, capability, action) {
  return projectMutations.gate(id, action, () => authorizeProject(id, user, capability));
}

async function listProjects(req, res, user) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.storage_path, p.created_at, p.updated_at, p.revision, m.role
     FROM projects p JOIN project_members m ON m.project_id = p.id
     WHERE m.user_id = $1 ORDER BY p.updated_at DESC`,
    [user.sub]
  );
  const projects = await Promise.all(rows.map((listed) => authorizedProjectGate(listed.id, user, "read", async (row) => {
    let fileCount = 0;
    let projectType = "latex";
    try {
      const manifest = await readProjectManifest(resolveProjectStorageDir(DATA_DIR, row.storage_path));
      fileCount = countFiles(manifest);
      projectType = inferProjectType(manifest);
    } catch {}
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      revision: row.revision,
      createdAt: toMillis(row.created_at),
      updatedAt: toMillis(row.updated_at),
      fileCount,
      projectType,
    };
  }).catch((err) => { if (err.status === 404) return null; throw err; })));
  json(res, 200, { projects: projects.filter(Boolean) });
}

async function listProjectTemplates(req, res) {
  json(res, 200, { templates: await discoverProjectTemplates(TEMPLATE_DIR) }, { "cache-control": "private, no-store" });
}

async function getProjectTemplate(req, res, type, encodedFileName) {
  let fileName;
  try {
    fileName = decodeURIComponent(encodedFileName);
  } catch {
    throw requestError("PROJECT_TEMPLATE_NOT_FOUND", 404);
  }
  const content = await readProjectTemplate(TEMPLATE_DIR, type, fileName);
  text(res, 200, content, {
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'none'",
    "x-content-type-options": "nosniff",
  });
}

// Serializes owner-invariant changes per project, so concurrent role changes on
// the same project cannot race past the last-owner check.
const PROJECT_OWNER_LOCK = 4952;

// Account conversion locks users before owned projects. Sharing must use the
// same order, including INSERT's target and invited_by foreign-key references.
// SHARE protects requester authority; compatible SHARE locks let that requester
// work on independent projects. Deduplicate before locking to avoid upgrades.
async function lockSharingUsers(client, requesterId, targetId = null) {
  const ids = [...new Set(targetId ? [requesterId, targetId] : [requesterId])].sort();
  for (const id of ids) {
    await client.query(id === requesterId
      ? "SELECT id FROM users WHERE id = $1 FOR SHARE"
      : "SELECT id FROM users WHERE id = $1 FOR KEY SHARE", [id]);
  }
}

// Call after the project and target-membership lock waits, on the writing
// client. A separate statement gets a fresh READ COMMITTED authorization view.
async function authorizeSharingRequester(req, user, projectId, capability, client) {
  const current = await requireUser(req, client);
  if (current.sub !== user.sub || current.sessionVersion !== user.sessionVersion) {
    throw requestError("NOT_AUTHENTICATED", 401);
  }
  if (current.passwordChangeRequired) throw requestError("PASSWORD_CHANGE_REQUIRED", 403);
  if (capability === "admin") {
    requireAdmin(current);
    await adminProjectRow(projectId, client);
  } else {
    await authorizeProject(projectId, current, capability, client);
  }
}

function requireSharingSessionUnexpired(user) {
  // Even after the final authorization, DML can wait on a foreign-key row.
  if (user.exp <= Math.floor(Date.now() / 1000)) throw requestError("NOT_AUTHENTICATED", 401);
}

// Sharing targets accounts that already exist. The UI resolves a partial search
// to an immutable user id; exact username/email remains available to admin flows.
// Pending invitations for strangers are a later evolution.
async function resolveMemberUser(identifier, userId = null, activeOnly = false, queryable = db) {
  const value = String(identifier || "").trim();
  if (!userId && !value) throw requestError("MEMBER_IDENTIFIER_REQUIRED", 400);
  if (userId && !isUuid(userId)) throw requestError("MEMBER_USER_NOT_FOUND", 404);
  const where = userId
    ? `id = $1${activeOnly ? " AND status = 'active'" : ""}`
    : `(LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))${activeOnly ? " AND status = 'active'" : ""}`;
  const { rows } = await queryable.query(
    `SELECT id, username, email, display_name, system_role FROM users WHERE ${where} LIMIT 1`,
    [userId || value]
  );
  if (!rows.length) throw requestError("MEMBER_USER_NOT_FOUND", 404);
  return rows[0];
}

// Ownership answers for a project's existence, so it stays with the organisation:
// an external account may be given any project role but that one. Enforced on
// every path that grants a role — the sharing console and the admin console
// alike, because a rule an administrator can step around is not an invariant.
function requireGrantableRole(systemRole, projectRole) {
  if (!canHoldProjectRole(systemRole, projectRole)) throw requestError("MEMBER_EXTERNAL_NOT_OWNER", 409);
}

async function insertProjectMembership(req, user, projectId, { identifier, userId = null, role }, viaAdmin = false) {
  let target, targetError;
  try {
    target = await resolveMemberUser(identifier, userId, !viaAdmin);
  } catch (err) {
    // Only expected lookup errors wait for the requester gate. SQL failures
    // propagate here, outside a transaction; no aborted client is reauthorized.
    if (err.errorCode !== "MEMBER_USER_NOT_FOUND" && err.errorCode !== "MEMBER_IDENTIFIER_REQUIRED") throw err;
    targetError = err;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockSharingUsers(client, user.sub, target?.id);
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    await authorizeSharingRequester(req, user, projectId, viaAdmin ? "admin" : "share", client);
    if (targetError) throw targetError;
    // Resolve once to identity, then reread eligibility after the lock waits.
    target = await resolveMemberUser(null, target.id, !viaAdmin, client);
    requireGrantableRole(target.system_role, role);
    await client.query(
      "INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)",
      [projectId, target.id, role, user.sub]
    );
    requireSharingSessionUnexpired(user);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") {
      // A conflicting insert can also wait past expiry before reporting 23505.
      requireSharingSessionUnexpired(user);
      throw requestError("MEMBER_ALREADY", 409);
    }
    throw err;
  } finally {
    client.release();
  }
  return target;
}

async function searchProjectMembers(req, res, user, projectId, url) {
  await authorizeProject(projectId, user, "share");
  const query = normalizeMemberSearch(url.searchParams.get("q"));
  if (!query) return json(res, 200, { users: [] });
  const pattern = `%${escapeLikePattern(query.toLowerCase())}%`;
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.username, u.email, u.display_name, u.system_role
     FROM users u
     WHERE u.status = 'active'
       AND (LOWER(u.username) LIKE $2 ESCAPE '\\' OR LOWER(u.email) LIKE $2 ESCAPE '\\')
       AND NOT EXISTS (
         SELECT 1 FROM project_members m WHERE m.project_id = $1 AND m.user_id = u.id
       )
     ORDER BY LOWER(COALESCE(u.display_name, u.username)), LOWER(u.username)
     LIMIT 20`,
    [projectId, pattern]
  );
  json(res, 200, {
    users: rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      name: row.display_name,
      email: row.email,
      external: row.system_role === "external",
    })),
  });
}

// `external` travels with every member so the console can label them and leave
// owner out of their role menu. It is a hint for the interface — the server
// refuses the promotion regardless of what the client offers.
function memberView(row) {
  return {
    userId: row.user_id,
    username: row.username,
    name: row.display_name,
    email: row.email,
    role: row.role,
    external: row.system_role === "external",
    invitedBy: row.invited_by || null,
    createdAt: toMillis(row.created_at),
  };
}

async function listProjectMembers(req, res, user, projectId) {
  await authorizeProject(projectId, user, "share");
  const { rows } = await db.query(
    `SELECT m.user_id, m.role, m.invited_by, m.created_at, u.username, u.email, u.display_name, u.system_role
     FROM project_members m JOIN users u ON u.id = m.user_id
     WHERE m.project_id = $1 ORDER BY (m.role <> 'owner'), u.username`,
    [projectId]
  );
  json(res, 200, { members: rows.map(memberView) });
}

async function addProjectMember(req, res, user, projectId) {
  await authorizeProject(projectId, user, "share");
  const body = await readBody(req);
  const role = String((body && body.role) || "");
  if (!isProjectRole(role)) throw requestError("MEMBER_ROLE_INVALID", 400);
  const target = await insertProjectMembership(req, user, projectId, {
    identifier: body && body.identifier, userId: body && body.userId, role,
  });
  await audit({
    ...sessionActor(req, user),
    action: "project.shared",
    targetType: "membership",
    targetId: projectId,
    metadata: { userId: target.id, username: target.username, role },
  });
  await collabRecheckProject(projectId);
  json(res, 201, {
    member: memberView({ user_id: target.id, username: target.username, email: target.email, display_name: target.display_name, system_role: target.system_role, role, invited_by: user.sub, created_at: new Date() }),
  });
}

async function updateProjectMember(req, res, user, projectId, memberId) {
  await authorizeProject(projectId, user, "share");
  const body = await readBody(req);
  const nextRole = String(body.role || "");
  if (!isProjectRole(nextRole)) throw requestError("MEMBER_ROLE_INVALID", 400);
  let previousRole;
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockSharingUsers(client, user.sub);
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    // Only the membership row is locked: the join reads the member's server role,
    // which decides whether the new project role may be granted at all.
    const current = await client.query(
      `SELECT m.role, u.system_role
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
      [projectId, memberId]
    );
    await authorizeSharingRequester(req, user, projectId, "share", client);
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
    requireGrantableRole(current.rows[0].system_role, nextRole);
    previousRole = current.rows[0].role;
    const others = await client.query(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner' AND user_id <> $2",
      [projectId, memberId]
    );
    if (leavesNoOwner(previousRole, nextRole, Number(others.rows[0].n))) throw requestError("PROJECT_LAST_OWNER", 409);
    await client.query(
      "UPDATE project_members SET role = $3, updated_at = CURRENT_TIMESTAMP WHERE project_id = $1 AND user_id = $2",
      [projectId, memberId, nextRole]
    );
    requireSharingSessionUnexpired(user);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (nextRole !== previousRole) {
    await audit({
      ...sessionActor(req, user),
      action: "project.member_role_changed",
      targetType: "membership",
      targetId: projectId,
      metadata: { userId: memberId, from: previousRole, to: nextRole },
    });
  }
  // A role change reaches sessions already open: losing write turns the
  // workspace read-only in place, losing membership closes the connection.
  await collabRecheckProject(projectId);
  json(res, 200, { ok: true });
}

async function removeProjectMember(req, res, user, projectId, memberId) {
  // Owners remove anyone; any member may remove themselves (leave the project).
  const selfLeave = memberId === user.sub;
  await authorizeProject(projectId, user, selfLeave ? "read" : "share");
  const client = await db.connect();
  let removed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockSharingUsers(client, user.sub);
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    const current = await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE",
      [projectId, memberId]
    );
    await authorizeSharingRequester(req, user, projectId, selfLeave ? "read" : "share", client);
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
    const others = await client.query(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner' AND user_id <> $2",
      [projectId, memberId]
    );
    if (leavesNoOwner(current.rows[0].role, null, Number(others.rows[0].n))) throw requestError("PROJECT_LAST_OWNER", 409);
    await client.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, memberId]);
    removed = true;
    requireSharingSessionUnexpired(user);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (removed) {
    await audit({
      ...sessionActor(req, user),
      action: selfLeave ? "project.left" : "project.unshared",
      targetType: "membership",
      targetId: projectId,
      metadata: { userId: memberId },
    });
  }
  await collabRecheckProject(projectId);
  json(res, 200, { ok: true });
}

async function getProject(req, res, user, id) {
  return authorizedProjectGate(id, user, "read", async (row) => {
    const data = await readProjectFile(row.storageDir);
    if (!data.project) data.project = { name: row.name, nodes: [] };
    data.project.name = row.name;
    data.createdAt = toMillis(row.created_at);
    data.updatedAt = toMillis(row.updated_at);
    // Every reader sees the retention policy and the server's setting bounds.
    json(res, 200, {
      id: row.id,
      ...data,
      revision: row.revision,
      role: row.role,
      retention: retentionView(projectRetentionSettings(row), RETENTION_CAPS),
    });
  });
}

// Reconciles the file-identity ledger against the tree about to be written and
// stamps each source file node with its canonical UUIDv7 id, so the persisted
// manifest carries the stable identity. Runs before the manifest is written; it
// tracks identity only and never moves files on disk.
async function syncProjectFiles(projectId, data, client, storageDir, protect, user) {
  const nodes = data && data.project && Array.isArray(data.project.nodes) ? data.project.nodes : [];
  const entries = collectProjectFiles(nodes);
  const incoming = entries.map((entry) => ({ nodeId: entry.nodeId, path: entry.path, kind: entry.kind }));
  const paths = new Set(incoming.map((file) => file.path.toLowerCase()));
  if (paths.size !== incoming.length) throw requestError("PROJECT_PATH_INVALID", 400);
  for (const file of incoming) {
    let parent = path.posix.dirname(file.path.toLowerCase());
    while (parent !== ".") {
      if (paths.has(parent)) throw requestError("PROJECT_PATH_INVALID", 400);
      parent = path.posix.dirname(parent);
    }
  }
  const { rows } = await client.query(
    "SELECT id, client_ref, path, kind FROM project_files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at, id FOR UPDATE",
    [projectId]
  );
  const plan = reconcileProjectFiles(rows, incoming, { generateId: uuidv7 });
  const renames = plan.updates.filter((u) => u.fromPath !== u.path).map((u) => ({ from: u.fromPath, to: u.path }));
  await preflightProjectRenames(storageDir, renames);
  if (plan.softDeletes.length) {
    await captureProjectCheckpoint({
      projectId, storageDir, user, reason: "manual", authoritative: true,
      files: rows.filter((file) => plan.softDeletes.includes(file.id)),
    }, client);
  }
  await protect();
  // Free paths before they are reused: soft-deletes and renames run before
  // inserts so the live-path unique index never sees a transient collision.
  for (const id of plan.softDeletes) {
    await client.query(
      "UPDATE project_files SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );
  }
  for (const update of plan.updates) {
    await client.query(
      "UPDATE project_files SET path = $2, kind = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [update.id, update.path, update.kind]
    );
  }
  for (const insert of plan.inserts) {
    await client.query(
      "INSERT INTO project_files (id, project_id, client_ref, path, kind) VALUES ($1, $2, $3, $4, $5)",
      [insert.id, projectId, insert.client_ref, insert.path, insert.kind]
    );
  }
  entries.forEach((entry, index) => { entry.node.id = plan.resolved[index].canonicalId; });
  return { renames };
}

function requireProjectRevision(body, row) {
  if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0 || body.baseRevision > 2147483647) {
    throw requestError("PROJECT_REVISION_REQUIRED", 428);
  }
  if (body.baseRevision !== row.revision) throw requestError("PROJECT_REVISION_CONFLICT", 409, { currentRevision: row.revision });
}

// The caller holds the project gate and transaction, including any follow-up
// checkpoint. Name-only saves change the current manifest without reconciling it.
async function saveProjectTree(id, row, body, data, client, protect, { manifestOnly = false, user } = {}) {
  data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
  data.project.name = body.name == null ? row.name : cleanName(body.name);
  data.projectType = inferProjectType(data);
  data.lilypondArgs = data.projectType === "lilypond" ? sanitizeLilypondArgsForStorage(data.lilypondArgs) : "";
  data.lilypondFormat = data.projectType === "lilypond" ? normalizeLilypondFormat(data.lilypondFormat) : "pdf";
  data.mainPath = sanitizeMainPathForStorage(data.mainPath);
  if (body.compileProfile && typeof body.compileProfile === "object") data.compileProfile = sanitizeCompileProfileForStorage(body.compileProfile, data.projectType);
  data.customCommands = sanitizeCustomCommandsForStorage(data.customCommands);
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = Date.now();
  data.revision = row.revision + 1;
  validateProjectSourceTree(data);
  if (manifestOnly) {
    await protect();
    await writeProjectManifest(row.storageDir, data);
  } else {
    const { renames } = await syncProjectFiles(id, data, client, row.storageDir, protect, user);
    applyCollabAuthority(id, data);
    await writeProjectFile(row.storageDir, data, renames);
  }
  const result = await client.query(
    "UPDATE projects SET name = $1, updated_at = CURRENT_TIMESTAMP, revision = revision + 1 WHERE id = $2 AND revision = $3 RETURNING revision",
    [data.project.name, id, row.revision]
  );
  if (!result.rows.length) throw requestError("PROJECT_REVISION_CONFLICT", 409, { currentRevision: row.revision });
  return data;
}

function versionAuthorLabel(user) {
  return user.username || user.email || `user:${user.sub}`;
}

async function latestVersion(fileId, queryable = db) {
  const { rows } = await queryable.query(
    "SELECT id, content_hash FROM document_versions WHERE file_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
    [fileId]
  );
  return rows[0] || null;
}

async function insertVersion({ fileId, parentId, user, reason, content }, queryable = db) {
  const id = uuidv7();
  await queryable.query(
    `INSERT INTO document_versions (id, file_id, parent_version_id, author_id, author_label, reason, content_hash, content, size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, fileId, parentId, user.sub, versionAuthorLabel(user), reason, hashContent(content), content, Buffer.byteLength(content, "utf8")]
  );
  return id;
}

// Destructive snapshots run under the project gate: use accepted room text and
// fail on unreadable disk fallbacks. Ordinary checkpoints can target build staging.
// Unversionable content has no revision and is represented by null. Each file may
// name its own author so a grouped realtime checkpoint preserves attribution.
async function snapshotFileIfChanged({ storageDir, file, user, reason, authoritative = false, strictRead = false }, queryable = db) {
  const room = authoritative && collabRooms.get(file.id);
  const buffer = room ? Buffer.from(room.text(), "utf8") : await fs.readFile(path.join(storageDir, file.path)).catch((err) => {
    if (strictRead || (authoritative && err.code !== "ENOENT")) throw err;
    return null;
  });
  const versionable = isVersionableText(buffer, file.kind);
  if (!buffer || (!versionable && !fileIsTextPath(file.path))) return null;
  const content = decodeProjectText(buffer, file.path);
  if (!versionable) return null;
  // A compile revision must reproduce the input bytes, not replacement text.
  if (strictRead && !Buffer.from(content, "utf8").equals(buffer)) return null;
  const previous = await latestVersion(file.id, queryable);
  if (!contentChanged(previous ? previous.content_hash : null, hashContent(content))) {
    return { id: previous.id, created: false };
  }
  const id = await insertVersion(
    { fileId: file.id, parentId: previous ? previous.id : null, user: file.author || user, reason, content },
    queryable
  );
  return { id, created: true };
}

// A project checkpoint is serialized so concurrent compilations cannot fork a
// file's revision chain. It also returns the exact revision used for each file.
async function captureProjectCheckpoint({ projectId, storageDir, user, reason, files: checkpointFiles = null, authoritative = false, strictRead = false }, queryable = null) {
  const client = queryable || await db.connect();
  try {
    if (!queryable) await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4953, hashtext($1))", [projectId]);
    let files = checkpointFiles;
    if (!files) {
      const result = await client.query(
        "SELECT id, path, kind FROM project_files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY path",
        [projectId]
      );
      files = result.rows;
    }
    let created = 0;
    const versions = new Map();
    for (const file of files) {
      const version = await snapshotFileIfChanged({ storageDir, file, user, reason, authoritative, strictRead }, client);
      if (version && version.created) created += 1;
      versions.set(file.id, version ? version.id : null);
    }
    if (!queryable) await client.query("COMMIT");
    return { created, versions };
  } catch (err) {
    if (!queryable) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (!queryable) client.release();
  }
}

async function sourceRevisionForBuild(storageDir, mainPath, sourceFileId, sourceRevisionId) {
  const content = await fs.readFile(path.join(storageDir, mainPath));
  return {
    sourceFileId,
    sourceContentHash: hashContent(content),
    sourceRevisionId,
  };
}

async function fileForProject(projectId, fileId, queryable = db) {
  const { rows } = await queryable.query(
    "SELECT id, path, kind, deleted_at FROM project_files WHERE id = $1 AND project_id = $2",
    [fileId, projectId]
  );
  if (!rows.length) throw requestError("FILE_NOT_FOUND", 404);
  return rows[0];
}

async function checkpointProject(req, res, user, id) {
  const body = await readBody(req);
  const { created, data } = await authorizedProjectGate(id, user, "write", async (project) => {
    if (!body.data || typeof body.data !== "object") {
      return captureProjectCheckpoint({ projectId: id, storageDir: project.storageDir, user, reason: "manual" });
    }
    const result = await projectMutations.transaction({ id, storageDir: project.storageDir }, async (client, protect) => {
      const row = await authorizeProject(id, user, "write", client);
      requireProjectRevision(body, row);
      const data = await saveProjectTree(id, row, { ...body, name: row.name }, body.data, client, protect, { user });
      const checkpoint = await captureProjectCheckpoint({ projectId: id, storageDir: row.storageDir, user, reason: "manual" }, client);
      return { ...checkpoint, data };
    });
    collabReconcileProject(id, result.data);
    return result;
  });
  await audit({
    ...sessionActor(req, user),
    action: "revision.checkpoint",
    targetType: "project",
    targetId: id,
    metadata: { reason: "manual", created },
  });
  json(res, 200, { ok: true, created, ...(data ? { revision: data.revision, data: { id, ...data } } : {}) });
}

async function listFileVersions(req, res, user, projectId, fileId) {
  await authorizeProject(projectId, user, "read");
  await fileForProject(projectId, fileId);
  const { rows } = await db.query(
    `SELECT id, parent_version_id, author_id, author_label, created_at, reason, content_hash, size
     FROM document_versions WHERE file_id = $1 ORDER BY created_at DESC, id DESC`,
    [fileId]
  );
  json(res, 200, {
    versions: rows.map((row) => ({
      id: row.id,
      parentId: row.parent_version_id,
      authorId: row.author_id,
      author: row.author_label,
      createdAt: toMillis(row.created_at),
      reason: row.reason,
      contentHash: row.content_hash,
      size: row.size,
    })),
  });
}

async function getFileVersion(req, res, user, projectId, fileId, versionId) {
  await authorizeProject(projectId, user, "read");
  await fileForProject(projectId, fileId);
  const { rows } = await db.query(
    "SELECT id, created_at, reason, author_label, content_hash, size, content FROM document_versions WHERE id = $1 AND file_id = $2",
    [versionId, fileId]
  );
  if (!rows.length) throw requestError("VERSION_NOT_FOUND", 404);
  const version = rows[0];
  json(res, 200, {
    id: version.id,
    createdAt: toMillis(version.created_at),
    reason: version.reason,
    author: version.author_label,
    contentHash: version.content_hash,
    size: version.size,
    content: version.content,
  });
}

async function restoreFileVersion(req, res, user, projectId, fileId, versionId) {
  return authorizedProjectGate(projectId, user, "write", async (project) => {
    const { file, target, newVersionId } = await projectMutations.transaction({ id: projectId, storageDir: project.storageDir }, async (client, protect) => {
      await authorizeProject(projectId, user, "write", client);
      const file = await fileForProject(projectId, fileId, client);
      if (file.deleted_at) throw requestError("FILE_NOT_FOUND", 404);
      const { rows } = await client.query(
        "SELECT id, content, content_hash FROM document_versions WHERE id = $1 AND file_id = $2",
        [versionId, fileId]
      );
      if (!rows.length) throw requestError("VERSION_NOT_FOUND", 404);
      const target = rows[0];
      await protect();

      // Capture the current state before overwriting it, then append the rollback
      // revision. History is only added to, in the same transaction as the write.
      await client.query("SELECT pg_advisory_xact_lock(4953, hashtext($1))", [projectId]);
      await snapshotFileIfChanged({ storageDir: project.storageDir, file, user, reason: "manual", authoritative: true }, client);
      const abs = path.join(project.storageDir, file.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, target.content, "utf8");
      const previous = await latestVersion(fileId, client);
      const newVersionId = await insertVersion({
        fileId,
        parentId: previous ? previous.id : null,
        user,
        reason: "rollback",
        content: target.content,
      }, client);
      await client.query("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [projectId]);
      return { file, target, newVersionId };
    });
    // Only reset participants after the replacement is committed.
    collabResetFile(fileId, target.content);
    await audit({
      ...sessionActor(req, user),
      action: "revision.restored",
      targetType: "revision",
      targetId: newVersionId,
      metadata: { fileId, fromVersion: versionId, path: file.path },
    });
    json(res, 200, { ok: true, versionId: newVersionId, content: target.content });
  });
}

/* ---------------- realtime collaboration (OT sessions) ---------------- */
// Transport and storage for the OT engine in ./collab. One WebSocket carries all
// of a browser tab's rooms; one room per file, keyed by the file's canonical id.
//
// While a room is live it is the authority for that file's content: a save from
// another client cannot overwrite it (see collabContentForProject), and the room
// is what writes the file to disk.
const COLLAB_PATH = "/api/collab";
// Idle debounce before the authoritative text reaches disk, and the longest a
// continuously typing room may go unwritten.
const COLLAB_FLUSH_MS = positiveIntEnv("COLLAB_FLUSH_MS", 2000);
const COLLAB_FLUSH_MAX_MS = positiveIntEnv("COLLAB_FLUSH_MAX_MS", 15000);
// Realtime edits are consolidated into one revision after this much quiet, so
// history records meaningful checkpoints instead of one entry per keystroke.
const COLLAB_REVISION_IDLE_MS = positiveIntEnv("COLLAB_REVISION_IDLE_MS", 120000);
const COLLAB_MAX_MESSAGE_BYTES = positiveIntEnv("COLLAB_MAX_MESSAGE_BYTES", 4 * 1024 * 1024);
const COLLAB_HEARTBEAT_MS = positiveIntEnv("COLLAB_HEARTBEAT_MS", 30000);
// Client-side pacing, served through /api/config. Local editing stays instant
// whatever these are: they only decide how often a browser talks to the server.
// Keystrokes are batched for COLLAB_PUSH_DEBOUNCE_MS before being sent, which
// cuts the message rate during fast typing by an order of magnitude while
// keeping the round trip far below the one second that reads as immediate.
const COLLAB_PUSH_DEBOUNCE_MS = positiveIntEnv("COLLAB_PUSH_DEBOUNCE_MS", 300);
// Cursor and selection moves are ephemeral, so they are paced separately.
const COLLAB_PRESENCE_DEBOUNCE_MS = positiveIntEnv("COLLAB_PRESENCE_DEBOUNCE_MS", 200);
// Server-side coalescing, which is what makes a crowded room affordable.
//
// Broadcasting the participant list on receipt of each presence report is
// quadratic: every one of n participants sends a report, and each report is
// answered with a message to each of the other n-1. At fifteen or twenty people
// that is thousands of sends per second, and it is the ceiling this process hits
// first — well before PostgreSQL notices anything. Answering on a tick instead
// makes it linear per tick, and at this interval no one can perceive the
// difference: the client already debounces its own reports by a comparable
// amount before sending them.
const COLLAB_PEERS_TICK_MS = positiveIntEnv("COLLAB_PEERS_TICK_MS", 200);
// The file tree only answers "is somebody else in this file", which changes on
// a join or a leave and never while anyone types. It can be paced far more
// slowly than a cursor without losing anything a user would notice.
const COLLAB_FILE_PRESENCE_TICK_MS = positiveIntEnv("COLLAB_FILE_PRESENCE_TICK_MS", 5000);
// `projects.updated_at` feeds the "last modified" column of the dashboard.
// Writing it on every flush of every room means many rooms of one project
// contending for a single row, each in its own transaction, to keep a timestamp
// nobody reads in realtime accurate to the second. Once per project per interval
// is the same information at a fraction of the write traffic.
const COLLAB_TOUCH_MS = positiveIntEnv("COLLAB_TOUCH_MS", 30000);

const collabRooms = new CollabRooms();
const collabSessions = new Set();
let collabHeartbeat = null;
// Invalidates auth/membership snapshots held across an await, including joins
// and upgrades which are not yet visible in the live session/room sets.
let collabAccessGeneration = 0;

function collabActive(session) {
  if (session.closed) return false;
  if (session.socket.readyState !== session.socket.OPEN) {
    collabCloseSession(session);
    return false;
  }
  if (Date.now() >= session.user.exp * 1000) {
    collabCloseSession(session, 4401, "session expired");
    return false;
  }
  return true;
}

async function collabAuthenticate(session) {
  while (collabActive(session)) {
    const generation = collabAccessGeneration;
    let user;
    try {
      user = await requireUser(session.request);
    } catch {
      collabCloseSession(session, 4401, "not authenticated");
      return false;
    }
    if (!collabActive(session)) return false;
    if (generation !== collabAccessGeneration) continue;
    if (user.passwordChangeRequired) {
      collabCloseSession(session, 4403, "password change required");
      return false;
    }
    session.user = user;
    return true;
  }
  return false;
}

function collabRevokeUser(userId) {
  collabAccessGeneration++;
  collabSessions.forEach((session) => {
    if (session.user.sub === String(userId)) collabCloseSession(session, 4401, "session revoked");
  });
}

// Per-project coalescing timers, keyed by project id. Three kinds of work used
// to be done once per room per event, which is the wrong unit for all three:
// the project row is one row however many of its files are open, the file tree
// is one view however many rooms changed, and a revision checkpoint takes one
// advisory lock per project regardless of how many files it covers. Keeping the
// timers here lets the work be done once per project per interval instead.
const collabProjects = new Map();

function collabProjectState(projectId) {
  let state = collabProjects.get(projectId);
  if (!state) {
    state = { touchTimer: null, revisionTimer: null, presenceTimer: null, touchPending: false };
    collabProjects.set(projectId, state);
  }
  return state;
}

// Drops the bookkeeping for a project with nothing scheduled and no live room,
// so the map does not accumulate an entry for every project ever opened.
function collabReleaseProject(projectId) {
  const state = collabProjects.get(projectId);
  if (!state) return;
  if (state.touchTimer || state.revisionTimer || state.presenceTimer || state.touchPending || state.touching) return;
  if (collabRooms.forProject(projectId).length) return;
  collabProjects.delete(projectId);
}

function collabSend(socket, message) {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

// Membership is re-read from the database for every join and every re-check, so a
// permission change lands on an open session exactly as it lands on a request.
async function collabMembership(projectId, userId) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.storage_path, m.role
     FROM projects p JOIN project_members m ON m.project_id = p.id
     WHERE p.id = $1 AND m.user_id = $2`,
    [projectId, userId]
  );
  if (!rows.length) return null;
  return { ...withStorageDir(rows[0]), role: rows[0].role };
}

async function collabJoin(session, fileId) {
  if (!collabActive(session)) return null;
  if (!isUuid(fileId)) throw new CollabError("COLLAB_BAD_FILE");
  if (session.rooms.has(fileId)) return session.rooms.get(fileId);
  // A room holds its whole document in memory for as long as anyone is in it,
  // so the number of rooms one connection may open is the number of documents
  // one client can pin in the server's heap. The cap is far above what an editor
  // opens — a tab edits one file and watches one project — and exists so a
  // scripted client cannot walk a project and hold all of it resident.
  if (session.rooms.size >= COLLAB_MAX_ROOMS_PER_SESSION) throw new CollabError("COLLAB_TOO_MANY_ROOMS");
  const { rows } = await db.query(
    "SELECT id, project_id, path, kind, deleted_at FROM project_files WHERE id = $1",
    [fileId]
  );
  const file = rows[0];
  // A non-member must not be able to tell an existing file from a missing one.
  if (!file || file.deleted_at) throw new CollabError("COLLAB_FILE_NOT_FOUND");
  let project = await collabMembership(file.project_id, session.user.sub);
  if (!collabActive(session)) return null;
  if (!project) throw new CollabError("COLLAB_FILE_NOT_FOUND");
  if (file.kind === "img" || file.kind === "font") throw new CollabError("COLLAB_NOT_TEXT");

  const readSource = async (filePath) => {
    const bytes = await fs.readFile(path.join(project.storageDir, filePath));
    try { return decodeProjectText(bytes, filePath); }
    catch (err) {
      if (err.errorCode === "BIBLIOGRAPHY_INVALID_ENCODING") throw new CollabError(err.errorCode);
      throw err;
    }
  };
  let existing;
  let content;
  let roomGeneration;
  const currentFileSql = `SELECT f.path, f.kind, p.revision FROM project_files f JOIN projects p ON p.id = f.project_id
    WHERE f.id = $1 AND f.project_id = $2 AND f.deleted_at IS NULL`;
  while (collabActive(session)) {
    const snapshot = await projectMutations.gate(file.project_id, async () => {
      const current = (await db.query(currentFileSql, [fileId, file.project_id])).rows[0];
      if (!current) throw new CollabError("COLLAB_FILE_NOT_FOUND");
      roomGeneration = collabRooms.generation;
      existing = collabRooms.get(fileId);
      content = existing ? null : await readSource(current.path);
      return current;
    });
    let generation;
    do {
      if (!collabActive(session)) return null;
      generation = collabAccessGeneration;
      project = await collabMembership(file.project_id, session.user.sub);
    } while (generation !== collabAccessGeneration);
    if (!collabActive(session)) return null;
    if (!project) throw new CollabError("COLLAB_FILE_NOT_FOUND");
    // Permission I/O must not hold up a retiring room's flush. Recheck the
    // namespace and room lifetime under the gate before installing the snapshot.
    const joined = await projectMutations.gate(file.project_id, async () => {
      const current = (await db.query(currentFileSql, [fileId, file.project_id])).rows[0];
      if (!current) throw new CollabError("COLLAB_FILE_NOT_FOUND");
      if (!collabActive(session) || generation !== collabAccessGeneration || roomGeneration !== collabRooms.generation ||
          current.revision !== snapshot.revision || current.path !== snapshot.path) return null;
      // Content-only restores do not advance the browser tree revision.
      if (!existing) content = await readSource(current.path);
      if (!collabActive(session) || generation !== collabAccessGeneration || roomGeneration !== collabRooms.generation) return null;
      const room = collabRooms.open({ fileId, projectId: file.project_id, path: current.path, content: existing ? existing.text() : content });
      room.storageDir = project.storageDir;
      room.kind = current.kind || null;
      room.clients.add(session);
      session.rooms.set(fileId, { room, role: project.role, projectId: file.project_id });
      return session.rooms.get(fileId);
    });
    if (joined) return joined;
  }
  return null;
}

function collabLeave(session, fileId) {
  const entry = session.rooms.get(fileId);
  if (!entry) return;
  session.rooms.delete(fileId);
  const room = entry.room;
  room.clients.delete(session);
  // The file loses a participant, so every tree watching the project changes.
  collabScheduleFilePresence(entry.projectId);
  if (room.clients.size) return void collabSchedulePeers(room, true);
  clearTimeout(room.flushTimer);
  clearTimeout(room.peersTimer);
  room.peersTimer = null;
  // Last one out persists the document and records the consolidated revision
  // before the room — and with it the authoritative text — is released. The room
  // is only dropped when empty and clean: a rejoining peer may have edited it
  // again before this earlier flush's retirement gets the project gate.
  collabTrack(collabPersist(room, { revision: true }).then(() => projectMutations.gate(room.projectId, () => {
    if (collabRooms.get(room.fileId) === room && !room.clients.size && !room.needsPersist() && !room.needsRevision()) {
      collabRooms.close(room.fileId);
      collabReleaseProject(room.projectId);
    }
  })));
}

// Tracks in-flight persistence so shutdown can wait for it.
const collabPending = new Set();
const collabStarted = new Set();
let collabDrainPromise = null;

function collabRoomDirty(room) {
  return !!room.storageDir && (room.needsPersist() || (!!room.lastAuthor && room.needsRevision()));
}

// A conservative count of obligations and started work, not a count of SQL calls.
function collabPendingWrites() {
  return collabPending.size + collabStarted.size
    + collabRooms.all().filter(collabRoomDirty).length
    + Array.from(collabProjects.values()).filter((state) => state.touchPending).length;
}
function collabTrack(promise) {
  const tracked = promise
    .catch((err) => console.error("Realtime persistence failed", err))
    .finally(() => collabPending.delete(tracked));
  collabPending.add(tracked);
  return tracked;
}

// Writes the room's authoritative text to disk, and optionally consolidates the
// burst of realtime edits into a single revision. Serialized per room so two
// flushes cannot interleave and write stale text.
function collabPersist(room, { revision = false } = {}) {
  const pending = (room.persisting || Promise.resolve()).catch(() => {})
    .then(() => collabPersistNow(room, revision)).finally(() => {
      collabStarted.delete(pending);
      if (room.persisting === pending) room.persisting = null;
    });
  room.persisting = pending;
  collabStarted.add(pending);
  return pending;
}

async function collabPersistNow(room, revision) {
  if (!room.storageDir) return;
  return projectMutations.gate(room.projectId, async () => {
    if (collabRooms.get(room.fileId) !== room) return;
    const { rows } = await db.query(
      "SELECT f.path, f.kind, p.storage_path FROM project_files f JOIN projects p ON p.id = f.project_id WHERE f.id = $1 AND f.project_id = $2 AND f.deleted_at IS NULL",
      [room.fileId, room.projectId]
    );
    if (!rows.length) return;
    room.path = rows[0].path;
    room.kind = rows[0].kind;
    room.storageDir = resolveProjectStorageDir(DATA_DIR, rows[0].storage_path);
    if (room.needsPersist()) {
      const version = room.version;
      const text = room.text();
      const abs = path.join(room.storageDir, room.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, text, "utf8");
      room.markPersisted(version);
      room.flushDeadline = 0;
      // File identity is rechecked above; timestamp writes alone are coalesced.
      collabScheduleTouch(room.projectId);
    }
    if (revision) await collabCaptureRevisions(room.projectId, [room]);
  });
}

// Marks the project modified at most once per COLLAB_TOUCH_MS, however many of
// its rooms flushed in between.
function collabScheduleTouch(projectId) {
  const state = collabProjectState(projectId);
  state.touchPending = true;
  if (state.touchTimer || maintenance || shuttingDown) return;
  state.touchTimer = setTimeout(() => {
    state.touchTimer = null;
    collabTrack(collabTouchProject(projectId));
  }, COLLAB_TOUCH_MS);
}

function collabTouchProject(projectId) {
  const state = collabProjects.get(projectId);
  if (!state) return Promise.resolve();
  if (state.touching) return state.touching;
  if (!state.touchPending) return Promise.resolve();
  state.touchPending = false;
  const pending = db.query("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [projectId])
    .catch((err) => { state.touchPending = true; throw err; })
    .finally(() => {
      state.touching = null;
      collabStarted.delete(pending);
      if (state.touchPending) collabScheduleTouch(projectId);
      collabReleaseProject(projectId);
    });
  state.touching = pending;
  collabStarted.add(pending);
  return pending;
}

// Consolidates the realtime edits of one project into a single checkpoint.
//
// One checkpoint, not one per file: captureProjectCheckpoint takes a per-project
// advisory lock, so a project with twenty open documents used to queue twenty
// transactions on the same lock, each inserting one file's contents. Passing
// every dirty room to one call takes the lock once and writes the same rows.
// Attribution survives the grouping because each file carries its own author.
// The caller holds the project gate through capture and marking the versions.
async function collabCaptureRevisions(projectId, rooms) {
  const dirty = rooms.filter((room) => collabRooms.get(room.fileId) === room && room.needsRevision() && room.lastAuthor && room.storageDir);
  if (!dirty.length) return;
  // The version is read before the write and applied after it, so edits that
  // arrive while the checkpoint is in flight still mark the room dirty and are
  // caught by the next one instead of being silently considered recorded.
  const captured = dirty.map((room) => ({ room, version: room.version }));
  const storageDir = dirty[0].storageDir;
  await captureProjectCheckpoint({
    projectId,
    storageDir,
    user: dirty[0].lastAuthor,
    reason: "realtime",
    authoritative: true,
    files: dirty.map((room) => ({
      id: room.fileId,
      path: room.path,
      kind: room.kind || null,
      author: room.lastAuthor,
    })),
  });
  for (const entry of captured) entry.room.markRevisioned(entry.version);
}

// Debounced persistence: writes after a quiet moment, and at least every
// COLLAB_FLUSH_MAX_MS while editing never stops. The disk write stays per room,
// because it is the room's own bytes; the revision checkpoint is scheduled per
// project, because that is the unit the database serializes it at.
function collabSchedulePersist(room) {
  if (maintenance || shuttingDown) return;
  const now = Date.now();
  if (!room.flushDeadline) room.flushDeadline = now + COLLAB_FLUSH_MAX_MS;
  clearTimeout(room.flushTimer);
  const delay = Math.max(0, Math.min(COLLAB_FLUSH_MS, room.flushDeadline - now));
  room.flushTimer = setTimeout(() => {
    if (collabRooms.get(room.fileId) === room) collabTrack(collabPersist(room));
  }, delay);
  collabScheduleRevision(room.projectId);
}

// One revision timer per project, restarted by activity in any of its rooms, so
// a burst of collaborative editing across many files produces one checkpoint
// once the burst subsides rather than one per file.
function collabScheduleRevision(projectId) {
  if (maintenance || shuttingDown) return;
  const state = collabProjectState(projectId);
  clearTimeout(state.revisionTimer);
  state.revisionTimer = setTimeout(() => {
    state.revisionTimer = null;
    const rooms = collabRooms.forProject(projectId);
    // Flush first, then capture current authority under the gate: edits or
    // removals between those steps must not mark an older disk snapshot current.
    collabTrack(Promise.all(rooms.map((room) => collabPersist(room)))
      .then(() => projectMutations.gate(projectId, () => collabCaptureRevisions(projectId, rooms)))
      .then(() => collabReleaseProject(projectId)));
  }, COLLAB_REVISION_IDLE_MS);
}

function collabBroadcast(room, message, except = null) {
  room.clients.forEach((client) => {
    if (client === except) return;
    if (!collabActive(client)) return;
    collabSend(client.socket, message);
  });
}

/* ---- presence: who else is in this document, and where ---- */
// Presence is ephemeral and deliberately kept out of the durable update stream:
// it is never persisted, never versioned and never replayed. Each participant is
// told about the others only, so a client needs no identity of its own to filter
// itself out. Being in the room already required membership, so presence cannot
// leak to anyone who could not read the file anyway.
// The room's participants, built once. Each entry carries the connection id it
// describes so a recipient can be filtered out of the list without the list
// having to be rebuilt for them: constructing these objects — and hashing a
// colour for each — is the expensive part, and it does not depend on who is
// being told.
function collabRoomPeers(room) {
  const peers = [];
  room.clients.forEach((client) => {
    if (!collabActive(client)) return;
    const entry = client.rooms.get(room.fileId);
    if (!entry) return;
    peers.push({
      id: client.id,
      userId: client.user.sub,
      name: client.user.name || client.user.username || "",
      username: client.user.username || "",
      color: peerColor(client.user.sub),
      role: entry.role,
      anchor: entry.presence ? entry.presence.anchor : null,
      head: entry.presence ? entry.presence.head : null,
      version: entry.presence ? entry.presence.version : 0,
    });
  });
  return peers;
}

function collabBroadcastPeers(room) {
  const all = collabRoomPeers(room);
  room.clients.forEach((client) => {
    if (!collabActive(client)) return;
    collabSend(client.socket, {
      t: "peers",
      fileId: room.fileId,
      peers: all.filter((peer) => peer.id !== client.id),
    });
  });
}

// Presence reports arrive continuously and from everyone at once, so answering
// each one individually is what makes the fan-out quadratic. Coalescing on a
// tick collapses a burst into a single broadcast carrying the same final state.
//
// `immediate` is for the events a user is waiting to see confirmed — somebody
// joined, somebody left, a role changed — which are rare enough to cost nothing
// and jarring to delay.
function collabSchedulePeers(room, immediate = false) {
  if (immediate) {
    clearTimeout(room.peersTimer);
    room.peersTimer = null;
    return collabBroadcastPeers(room);
  }
  if (room.peersTimer) return;
  room.peersTimer = setTimeout(() => {
    room.peersTimer = null;
    if (collabRooms.get(room.fileId) === room) collabBroadcastPeers(room);
  }, COLLAB_PEERS_TICK_MS);
}

/* ---- presence: which of the project's files somebody else is in ---- */
// The same information one level up, for the file tree. It answers only "is
// somebody else in there" and deliberately carries no positions: a caret moving
// changes nothing here, so this is broadcast on joins and leaves alone and stays
// silent during typing. It travels on the project channel, so it keeps arriving
// while the editor sits on a file nobody else has open.
//
// Membership is inherited from the project, so a member who may read the tree
// may already read every file in it: this discloses nothing new.
function collabFilePresenceFor(projectId, recipient) {
  const files = [];
  collabRooms.forProject(projectId).forEach((room) => {
    // One entry per person, not per connection: the tree asks who is in the
    // file, and someone's second tab is not a second person.
    const people = new Map();
    room.clients.forEach((client) => {
      if (client === recipient || people.has(client.user.sub)) return;
      if (!collabActive(client)) return;
      people.set(client.user.sub, {
        userId: client.user.sub,
        name: client.user.name || client.user.username || "",
        color: peerColor(client.user.sub),
      });
    });
    if (people.size) files.push({ fileId: room.fileId, peers: Array.from(people.values()) });
  });
  return files;
}

function collabSendFilePresence(session, projectId) {
  if (!collabActive(session)) return;
  collabSend(session.socket, { t: "filepeers", projectId, files: collabFilePresenceFor(projectId, session) });
}

function collabBroadcastFilePresence(projectId) {
  if (!projectId) return;
  collabSessions.forEach((session) => {
    if (session.projectId !== projectId) return;
    collabSendFilePresence(session, projectId);
  });
}

// Rebuilding this view walks every room of the project and every client in each
// of them, once per watching session — so a project being opened by a class of
// students would recompute it for everybody on each arrival. Nothing here is
// time-critical: it answers "is somebody else in that file", which stays true
// for as long as they are in it. A slow tick is the whole optimisation.
function collabScheduleFilePresence(projectId) {
  if (!projectId) return;
  const state = collabProjectState(projectId);
  if (state.presenceTimer) return;
  state.presenceTimer = setTimeout(() => {
    state.presenceTimer = null;
    collabBroadcastFilePresence(projectId);
    collabReleaseProject(projectId);
  }, COLLAB_FILE_PRESENCE_TICK_MS);
}

// Tells everyone watching the project that a compilation finished, so a member
// looking at an older output learns there is a newer one instead of discovering
// it by chance. The message carries no output, only the fact and who caused it;
// the client asks for the build itself through the ordinary authorized route.
// It goes to every watcher, including the author's own other tabs: each client
// decides whether it is already showing that build.
function collabNotifyBuild({ projectId, buildId, status, user }) {
  const message = {
    t: "build",
    projectId,
    buildId,
    status,
    by: (user && (user.name || user.username)) || "",
  };
  collabSessions.forEach((session) => {
    if (session.projectId !== projectId) return;
    if (!collabActive(session)) return;
    collabSend(session.socket, message);
  });
}

async function collabHandleMessage(session, raw) {
  if (!await collabAuthenticate(session) || !collabActive(session)) return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new CollabError("COLLAB_BAD_MESSAGE");
  }
  const fileId = message && message.fileId;

  if (message.t === "open") {
    const entry = await collabJoin(session, fileId);
    if (!entry || !collabActive(session) || session.rooms.get(fileId) !== entry) return;
    collabSend(session.socket, {
      t: "opened",
      fileId,
      version: entry.room.version,
      doc: entry.room.text(),
      role: entry.role,
    });
    // Everyone learns about the newcomer, and the newcomer about everyone.
    collabSchedulePeers(entry.room, true);
    return collabScheduleFilePresence(entry.room.projectId);
  }

  // A tab watches the project it has open, independently of which file it is
  // editing: build notifications concern the whole project, and a member may be
  // looking at the preview with no document in a room at all.
  if (message.t === "project") {
    const projectId = String(message.projectId || "");
    if (!isUuid(projectId)) throw new CollabError("COLLAB_BAD_PROJECT");
    let project;
    let generation;
    do {
      if (!collabActive(session)) return;
      generation = collabAccessGeneration;
      project = await collabMembership(projectId, session.user.sub);
    } while (generation !== collabAccessGeneration);
    if (!collabActive(session)) return;
    if (!project) throw new CollabError("COLLAB_PROJECT_NOT_FOUND");
    session.projectId = projectId;
    // The tree needs the state as it is now, not only the changes from here on.
    return collabSendFilePresence(session, projectId);
  }

  if (message.t === "unwatch") {
    session.projectId = null;
    return;
  }

  if (message.t === "close") return collabLeave(session, fileId);

  if (message.t === "presence") {
    const entry = session.rooms.get(fileId);
    if (!entry) throw new CollabError("COLLAB_NOT_JOINED");
    const presence = normalizePresence(message, entry.room.doc.length);
    if (!presence) return;
    entry.presence = presence;
    // Recorded now, broadcast on the next tick with everyone else's.
    return collabSchedulePeers(entry.room);
  }

  if (message.t === "pull") {
    const entry = session.rooms.get(fileId);
    if (!entry) throw new CollabError("COLLAB_NOT_JOINED");
    const updates = entry.room.since(Number(message.version));
    if (updates === null) {
      // The client is older than the retained log: only a full resync converges.
      return collabSend(session.socket, { t: "resync", fileId, version: entry.room.version, doc: entry.room.text() });
    }
    return collabSend(session.socket, { t: "updates", fileId, version: entry.room.version, updates });
  }

  if (message.t === "push") {
    const entry = session.rooms.get(fileId);
    if (!entry) throw new CollabError("COLLAB_NOT_JOINED");
    return projectMutations.gate(entry.projectId, () => {
      if (!collabActive(session)) return;
      if (session.rooms.get(fileId) !== entry || collabRooms.get(fileId) !== entry.room) throw new CollabError("COLLAB_NOT_JOINED");
      if (!roleHasCapability(entry.role, "write")) throw new CollabError("COLLAB_READ_ONLY");
      if (shuttingDown) throw new CollabError("SERVER_SHUTTING_DOWN");
      if (maintenanceActive()) throw new CollabError("MAINTENANCE_MODE");
      const result = entry.room.receive(Number(message.version), message.updates, { userId: session.user.sub });
      // Every replica, including the sender, sees the same accepted stream before
      // the ack can release another push or a peer can send dependent changes.
      if (result.accepted) {
        entry.room.lastAuthor = session.user;
        collabBroadcast(entry.room, { t: "updates", fileId, version: result.version, updates: result.updates });
      }
      collabSend(session.socket, { t: "pushed", fileId, accepted: result.accepted, version: result.version });
      if (!result.accepted) return;
      return collabSchedulePersist(entry.room);
    });
  }

  if (message.t === "ping") return collabSend(session.socket, { t: "pong" });
  throw new CollabError("COLLAB_BAD_MESSAGE");
}

function collabCloseSession(session, code = 1000, reason = "") {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.expiryTimer);
  session.projectId = null;
  Array.from(session.rooms.keys()).forEach((fileId) => collabLeave(session, fileId));
  collabSessions.delete(session);
  try {
    session.socket.close(code, reason);
  } catch {}
}

// Re-authorizes every open session on a project. Losing membership closes the
// session at once; losing write keeps it open as a read-only observer. Called
// after any membership or project mutation, so a permission change reaches
// sessions already in progress.
async function collabRecheckProject(projectId) {
  collabAccessGeneration++;
  const sessions = Array.from(collabSessions).filter((session) =>
    session.projectId === projectId
    || Array.from(session.rooms.values()).some((entry) => entry.projectId === projectId));
  for (const session of sessions) {
    if (!collabActive(session)) continue;
    let project;
    let generation;
    do {
      generation = collabAccessGeneration;
      project = await collabMembership(projectId, session.user.sub).catch(() => null);
    } while (!session.closed && generation !== collabAccessGeneration);
    if (!collabActive(session)) continue;
    if (!project) {
      // Losing membership also stops the build notifications for the project.
      if (session.projectId === projectId) session.projectId = null;
      Array.from(session.rooms.entries()).forEach(([fileId, entry]) => {
        if (entry.projectId !== projectId) return;
        collabSend(session.socket, { t: "revoked", fileId });
        collabLeave(session, fileId);
      });
      if (!session.rooms.size) collabCloseSession(session, 4403, "permission revoked");
      continue;
    }
    session.rooms.forEach((entry, fileId) => {
      if (entry.projectId !== projectId || entry.role === project.role) return;
      entry.role = project.role;
      collabSend(session.socket, { t: "role", fileId, role: project.role });
      // The others see the new role on the participant list too. Immediate: a
      // permission change is exactly the kind of thing that must not sit in a
      // queue behind a tick.
      collabSchedulePeers(entry.room, true);
    });
  }
}

// Stamps the authoritative text of every live room onto the tree about to be
// written, so a whole-project save can never overwrite a document currently
// being edited in realtime. Runs after syncProjectFiles, which is what gives the
// nodes the canonical ids the rooms are keyed by.
function applyCollabAuthority(projectId, data) {
  const rooms = collabRooms.forProject(projectId);
  if (!rooms.length) return;
  const authoritative = new Map(rooms.map((room) => [room.fileId, room.text()]));
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node) continue;
      if (node.type === "folder") { walk(node.children); continue; }
      const text = node.id == null ? undefined : authoritative.get(String(node.id));
      if (text !== undefined) node.content = text;
    }
  };
  walk(data && data.project && data.project.nodes);
}

// Called synchronously after confirmed commit, still inside the project gate.
// Renames keep the OT stream; removed files already have their final snapshot.
// A null tree means project deletion, which revokes membership rather than files.
function collabReconcileProject(projectId, data = null) {
  const files = new Map((data ? collectProjectFiles(data.project.nodes) : []).map((file) => [file.nodeId, file]));
  const revoked = new Set();
  let removedRoom = false;
  if (!data) {
    collabAccessGeneration++;
    collabSessions.forEach((session) => {
      if (session.projectId !== projectId) return;
      session.projectId = null;
      revoked.add(session);
    });
  }
  for (const room of collabRooms.forProject(projectId)) {
    const file = files.get(room.fileId);
    if (file) {
      room.path = file.path;
      room.kind = file.kind;
      continue;
    }
    clearTimeout(room.flushTimer);
    clearTimeout(room.peersTimer);
    room.clients.forEach((session) => {
      if (session.rooms.get(room.fileId)?.room !== room) return;
      session.rooms.delete(room.fileId);
      collabSend(session.socket, { t: data ? "file-closed" : "revoked", fileId: room.fileId });
      if (!data) revoked.add(session);
    });
    room.clients.clear();
    collabRooms.close(room.fileId);
    removedRoom = true;
  }
  revoked.forEach((session) => {
    if (!session.rooms.size) collabCloseSession(session, 4403, "permission revoked");
  });
  if (!data) {
    const state = collabProjects.get(projectId);
    if (state) {
      clearTimeout(state.touchTimer);
      clearTimeout(state.revisionTimer);
      clearTimeout(state.presenceTimer);
      collabProjects.delete(projectId);
    }
  } else if (removedRoom) {
    collabScheduleFilePresence(projectId);
  }
}

// A file replaced outside the update stream (a rollback, or a refresh from disk)
// invalidates every client's version, so the room is reset and clients resync.
function collabResetFile(fileId, content) {
  const room = collabRooms.get(fileId);
  if (!room) return;
  const version = room.reset(content);
  room.markPersisted(version);
  room.markRevisioned(version);
  collabBroadcast(room, { t: "resync", fileId, version, doc: room.text() });
}

async function collabUpgrade(req, socket, head, wss) {
  const finish = (status, body) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    socket.destroy();
  };
  if (shuttingDown || maintenanceActive()) return finish("503 Service Unavailable", "Iris is unavailable");
  if (!isRequestOriginAllowed(req, { appBaseUrl: APP_BASE_URL, trustProxy: TRUST_PROXY })) {
    return finish("403 Forbidden", "Request origin forbidden");
  }
  let user;
  let generation;
  try {
    do {
      if (socket.destroyed) return;
      generation = collabAccessGeneration;
      user = await requireUser(req);
    } while (generation !== collabAccessGeneration);
  } catch {
    return finish("401 Unauthorized", "Not authenticated");
  }
  if (socket.destroyed) return;
  if (shuttingDown || maintenanceActive()) return finish("503 Service Unavailable", "Iris is unavailable");
  if (Date.now() >= user.exp * 1000) return finish("401 Unauthorized", "Session expired");
  if (user.passwordChangeRequired) return finish("403 Forbidden", "Password change required");
  // Counted per account rather than per address, so it holds for someone behind
  // a shared address and cannot be evaded by reconnecting from another network.
  // A person legitimately has several tabs open; nobody has twelve.
  let sessionsForUser = 0;
  collabSessions.forEach((existing) => {
    if (existing.user && existing.user.sub === user.sub) sessionsForUser += 1;
  });
  if (sessionsForUser >= COLLAB_MAX_SESSIONS_PER_USER) {
    return finish("429 Too Many Requests", "Too many realtime connections");
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // One id per connection, not per user: the same person in two tabs is two
    // participants with two cursors, which is what the others should see.
    const session = { id: uuidv7(), socket: ws, user, request: req, rooms: new Map(), alive: true, closed: false, messages: Promise.resolve() };
    collabSessions.add(session);
    const expire = () => {
      if (!collabActive(session)) return;
      session.expiryTimer = setTimeout(expire, Math.min(user.exp * 1000 - Date.now(), 2147483647));
      session.expiryTimer.unref();
    };
    expire();
    ws.on("pong", () => { session.alive = true; });
    ws.on("message", (data) => {
      // Authentication and joins await I/O; keep the OT stream in wire order.
      session.messages = session.messages.then(() => collabHandleMessage(session, data.toString("utf8"))).catch((err) => {
        if (!collabActive(session)) return;
        const code = err instanceof CollabError ? err.code : "COLLAB_ERROR";
        if (!(err instanceof CollabError)) console.error("Realtime session error", err);
        const response = { t: "error", code };
        try {
          const message = JSON.parse(data.toString("utf8"));
          if (message?.t === "open" || message?.t === "push") {
            response.request = message.t;
            response.fileId = message.fileId;
          }
        } catch {}
        collabSend(ws, response);
      });
    });
    ws.on("close", () => collabCloseSession(session));
    ws.on("error", () => {});
    collabSend(ws, { t: "ready", sessionId: session.id, color: peerColor(user.sub) });
    collabSend(ws, { t: "maintenance", active: false });
  });
}

function collabAttach(server) {
  maintenancePoll = setInterval(() => {
    if (maintenanceActive() && !shuttingDown) requestCollabDrain();
  }, 1000);
  maintenancePoll.unref();
  const wss = new WebSocketServer({ noServer: true, maxPayload: COLLAB_MAX_MESSAGE_BYTES });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = parseRequestUrl(req);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (url.pathname !== COLLAB_PATH) {
      socket.destroy();
      return;
    }
    collabUpgrade(req, socket, head, wss).catch(() => socket.destroy());
  });
  // Drops sockets whose peer vanished without a close frame, so rooms do not
  // keep phantom participants and stay the authority forever.
  collabHeartbeat = setInterval(() => {
    collabSessions.forEach((session) => {
      if (!collabActive(session)) return;
      if (!session.alive) return collabCloseSession(session, 1001, "unresponsive");
      session.alive = false;
      try { session.socket.ping(); } catch {}
      void collabAuthenticate(session);
    });
  }, COLLAB_HEARTBEAT_MS);
  if (typeof collabHeartbeat.unref === "function") collabHeartbeat.unref();
  return wss;
}

function requestCollabDrain() {
  drainCollabWrites({ untilIdle: false }).catch((err) => console.error("Realtime drain failed", err));
}

function drainCollabWrites({ untilIdle = true } = {}) {
  if (collabDrainPromise) {
    // A shared maintenance pass can stop on reopening. Explicit shutdown must
    // also drain obligations left behind by that earlier pass.
    return untilIdle ? collabDrainPromise.then(() => drainCollabWrites()) : collabDrainPromise;
  }
  if (!collabPendingWrites()) return Promise.resolve();
  collabDrainPromise = drainCollabWritesNow(untilIdle).finally(() => { collabDrainPromise = null; });
  return collabDrainPromise;
}

async function drainCollabWritesNow(untilIdle) {
  // Reopening rearms ordinary timers. A maintenance drain must leave those
  // timers alone after every wait, including a queued checkpoint's project gate.
  const shouldDrain = () => untilIdle || maintenance || shuttingDown;
  do {
    if (!shouldDrain()) return;
    for (const state of collabProjects.values()) {
      clearTimeout(state.touchTimer);
      clearTimeout(state.revisionTimer);
      state.touchTimer = null;
      state.revisionTimer = null;
    }
    for (const room of collabRooms.all()) {
      clearTimeout(room.flushTimer);
      room.flushTimer = null;
    }
    // Never wait on room.persisting while holding the non-reentrant project gate.
    const results = await Promise.allSettled([...collabPending, ...collabStarted]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    if (shutdownForced) throw new Error("Shutdown deadline exceeded");
    if (!shouldDrain()) return;
    const projects = new Set(collabRooms.all().filter(collabRoomDirty).map((room) => room.projectId));
    for (const projectId of projects) {
      if (!shouldDrain()) return;
      const rooms = collabRooms.forProject(projectId);
      await Promise.all(rooms.filter((room) => room.storageDir && room.needsPersist()).map((room) => collabPersist(room)));
      if (!shouldDrain()) return;
      await projectMutations.gate(projectId, () => {
        if (shouldDrain()) return collabCaptureRevisions(projectId, rooms);
      });
    }
    // Room flushes above can create touches, including after the first timer pass.
    for (const [projectId, state] of collabProjects) {
      if (!shouldDrain()) return;
      clearTimeout(state.touchTimer);
      state.touchTimer = null;
      if (state.touchPending || state.touching) await collabTouchProject(projectId);
    }
  } while (shouldDrain() && collabPendingWrites());
}

// Maintenance uses the same durable drain while retaining sessions and presence.
async function collabShutdown() {
  clearInterval(maintenancePoll);
  clearInterval(collabHeartbeat);
  Array.from(collabSessions).forEach((session) => collabCloseSession(session, 1001, "server shutting down"));
  for (const state of collabProjects.values()) {
    clearTimeout(state.presenceTimer);
    state.presenceTimer = null;
  }
  for (const room of collabRooms.all()) clearTimeout(room.peersTimer);
  await drainCollabWrites();
}

// The two ways a project comes into existence, and the only two places the
// no-new-projects rule has to hold. Import counts because downloading an archive
// is a `read` capability: without this an external member could package a project
// it was invited to and import it back as one it owns.
function requireProjectCreation(user) {
  if (!canCreateProjects(user.role)) throw requestError("PROJECT_CREATE_FORBIDDEN", 403);
}

async function createProject(req, res, user) {
  requireProjectCreation(user);
  const body = await readBody(req);
  const name = cleanName(body.name);
  const id = uuidv7();
  const storageKey = projectStorageKey(id);
  const storagePath = resolveProjectStorageDir(DATA_DIR, storageKey);
  const now = Date.now();
  const data = body.data && typeof body.data === "object" ? body.data : {};
  data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
  data.project.name = name;
  data.projectType = inferProjectType(data);
  data.lilypondArgs = data.projectType === "lilypond" ? sanitizeLilypondArgsForStorage(data.lilypondArgs) : "";
  data.lilypondFormat = data.projectType === "lilypond" ? normalizeLilypondFormat(data.lilypondFormat) : "pdf";
  data.mainPath = sanitizeMainPathForStorage(data.mainPath);
  data.createdAt = now;
  data.customCommands = sanitizeCustomCommandsForStorage(data.customCommands);
  data.updatedAt = now;
  data.revision = 0;
  validateProjectSourceTree(data);
  // The project row must exist before the ledger references it, and the manifest
  // must be written after ids are stamped. On any failure the whole project is
  // rolled back so a half-created project never lingers. The creator becomes the
  // project's first owner through a membership row, the authority for access.
  await projectMutations.gate(id, () => projectMutations.transaction({ id, storageDir: storagePath, create: true }, async (client, protect) => {
    await protect();
    await client.query(
      "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
      [id, user.sub, name, storageKey]
    );
    await client.query(
      "INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)",
      [id, user.sub]
    );
    await syncProjectFiles(id, data, client, storagePath, protect);
    await writeProjectFile(storagePath, data);
  }));
  await audit({
    ...sessionActor(req, user),
    action: "project.created",
    targetType: "project",
    targetId: id,
    metadata: { name, projectType: data.projectType },
  });
  json(res, 201, {
    project: { id, name, revision: 0, projectType: data.projectType, createdAt: now, updatedAt: now, fileCount: countFiles(data) },
    data: { id, ...data },
  });
}

async function updateProject(req, res, user, id) {
  const body = await readBody(req);
  const manifestOnly = !body.data || typeof body.data !== "object";
  const { data, row, retentionChanged } = await authorizedProjectGate(id, user, "write", async (project) => {
    const saved = await projectMutations.transaction({ id, storageDir: project.storageDir }, async (client, protect) => {
      const row = await authorizeProject(id, user, "write", client);
      requireProjectRevision(body, row);
      // Retention is an owner decision. Ignore an editor's settings without
      // refusing their document save, and commit the policy with that save.
      const retention = row.role === "owner"
        ? normalizeRetentionInput(body.retention, RETENTION_CAPS)
        : {};
      const data = manifestOnly ? await readProjectManifest(row.storageDir) : body.data;
      data.mainPath = sanitizeMainPathForStorage(body.mainPath ?? data.mainPath);
      await saveProjectTree(id, row, body, data, client, protect, { manifestOnly, user });
      const retentionColumns = {
        buildKeep: "build_keep",
        buildDays: "build_days",
        versionKeep: "version_keep",
        versionDays: "version_days",
      };
      const assignments = [];
      const values = [];
      for (const [field, column] of Object.entries(retentionColumns)) {
        if (!Object.prototype.hasOwnProperty.call(retention, field)) continue;
        values.push(retention[field]);
        assignments.push(`${column} = $${values.length}`);
        row[column] = retention[field];
      }
      if (assignments.length) {
        values.push(id);
        await client.query(`UPDATE projects SET ${assignments.join(", ")} WHERE id = $${values.length}`, values);
      }
      return {
        data: manifestOnly ? { ...await readProjectFile(row.storageDir), revision: data.revision } : data,
        row,
        retentionChanged: assignments.length > 0,
      };
    });
    if (!manifestOnly) collabReconcileProject(id, saved.data);
    return saved;
  });
  if (retentionChanged) {
    await audit({
      ...sessionActor(req, user),
      action: "project.retention_changed",
      targetType: "project",
      targetId: id,
      metadata: projectRetention(row),
    });
  }
  json(res, 200, {
    project: { id, name: data.project.name, revision: data.revision, projectType: data.projectType, createdAt: data.createdAt, updatedAt: data.updatedAt, fileCount: countFiles(data) },
    data: { id, ...data },
    retention: retentionView(projectRetentionSettings(row), RETENTION_CAPS),
  });
}

async function deleteProject(req, res, user, id) {
  const row = await authorizedProjectGate(id, user, "delete", async (row) => {
    await projectMutations.transaction({ id, storageDir: row.storageDir, deleting: true }, async (client, protect) => {
      await authorizeProject(id, user, "delete", client);
      await protect();
      await client.query("DELETE FROM projects WHERE id = $1", [id]);
    });
    collabReconcileProject(id);
    return row;
  });
  await audit({
    ...sessionActor(req, user),
    action: "project.deleted",
    targetType: "project",
    targetId: id,
    metadata: { name: row.name },
  });
  json(res, 200, { ok: true });
}

async function downloadProjectFile(req, res, user, id, url) {
  if (res.destroyed || req.aborted) return;
  return authorizedProjectGate(id, user, "read", async (row) => {
    if (res.destroyed || req.aborted) return;
    const file = await resolveProjectFile(row.storageDir, url.searchParams.get("path"));
    if (res.destroyed || req.aborted) return;
    const fallbackName = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "download";
    res.writeHead(200, {
      "content-type": file.mimeType,
      "content-length": file.size,
      "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeDispositionValue(file.name)}`,
      "cache-control": "private, no-store",
    });
    await new Promise((resolve) => {
      const stream = fsSync.createReadStream(file.path);
      const complete = () => {
        if (!stream.closed || (!res.writableFinished && !res.destroyed)) return;
        clearTimeout(timer);
        res.removeListener("close", terminate);
        res.removeListener("finish", complete);
        resolve();
      };
      const terminate = () => {
        stream.destroy();
        res.destroy();
        complete();
      };
      // Backpressure must not let a paused receiver retain the project gate.
      // After headers, terminate on errors instead of attempting a JSON response.
      const timer = setTimeout(terminate, PROJECT_DOWNLOAD_TIMEOUT_MS);
      stream.once("error", terminate);
      stream.once("close", complete);
      res.once("close", terminate);
      res.once("finish", complete);
      if (res.destroyed || req.aborted) terminate();
      else stream.pipe(res);
    });
  });
}

async function downloadProjectArchive(req, res, user, id) {
  const { row, archive } = await authorizedProjectGate(id, user, "read", async (row) => {
    try {
      const archive = await buildProjectArchive(row.storageDir, row.name, {
        maxBytes: PROJECT_ARCHIVE_MAX_BYTES,
        maxEntries: PROJECT_ARCHIVE_MAX_ENTRIES,
      });
      return { row, archive };
    } catch (error) {
      if (["PROJECT_ARCHIVE_TOO_LARGE", "ZIP_TOO_MANY_ENTRIES", "ZIP_ENTRY_TOO_LARGE"].includes(error && error.code)) {
        throw requestError("PROJECT_ARCHIVE_TOO_LARGE", 413);
      }
      throw error;
    }
  });
  const fileName = `${slugify(row.name)}.zip`;
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": archive.length,
    "content-disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeDispositionValue(`${row.name}.zip`)}`,
    "cache-control": "private, no-store",
  });
  res.end(archive);
}

function invalidProjectArchive() {
  return requestError("PROJECT_ARCHIVE_INVALID", 400);
}

function validateArchiveReservedPath(name, manifest = false) {
  const normalized = String(name || "").replace(/\/$/, "");
  const rootName = normalized.split("/", 1)[0];
  const lowerRoot = rootName.toLowerCase();
  if (lowerRoot === ".iris" && !(manifest && normalized === ".iris/project.json") && normalized !== ".iris") {
    throw invalidProjectArchive();
  }
  if ((lowerRoot === ".iris" || lowerRoot === "output") && rootName !== lowerRoot) {
    throw invalidProjectArchive();
  }
}

function parseProjectArchive(body) {
  let archive;
  try {
    archive = extractZip(body, { maxEntries: 10000, maxUncompressedSize: MAX_BODY });
  } catch (err) {
    if (err && (err.code === "ZIP_TOO_LARGE" || err.code === "ZIP_TOO_MANY_ENTRIES")) {
      throw requestError("REQUEST_TOO_LARGE", 413);
    }
    throw invalidProjectArchive();
  }

  const manifestBuffer = archive.files.get(".iris/project.json");
  if (!manifestBuffer) throw invalidProjectArchive();
  for (const name of archive.files.keys()) {
    validateArchiveReservedPath(name, true);
    if ((name === ".iris" || name.startsWith(".iris/")) && name !== ".iris/project.json") {
      throw invalidProjectArchive();
    }
  }
  for (const name of archive.directories) {
    validateArchiveReservedPath(name);
    if (name.startsWith(".iris/") && name !== ".iris/") throw invalidProjectArchive();
  }

  let data;
  try {
    data = JSON.parse(manifestBuffer.toString("utf8"));
  } catch {
    throw invalidProjectArchive();
  }
  if (!data || !data.irisArchive || data.irisArchive.format !== "iris-project") throw invalidProjectArchive();
  if (data.irisArchive.version !== 1) throw requestError("PROJECT_ARCHIVE_VERSION_UNSUPPORTED", 400);
  return { archive, data };
}

function normalizeImportedProject(data, name, now) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidProjectArchive();
  delete data.irisArchive;
  delete data.id;
  data.project = data.project && typeof data.project === "object" && Array.isArray(data.project.nodes)
    ? data.project
    : { nodes: [] };
  data.project.name = name;
  data.projectType = inferProjectType(data);
  data.engine = data.projectType === "lilypond"
    ? "lilypond"
    : (LATEX_ENGINES.has(data.engine) ? data.engine : "pdflatex");
  data.compileProfile = sanitizeCompileProfileForStorage(data.compileProfile, data.projectType);
  data.customCommands = sanitizeCustomCommandsForStorage(data.customCommands);
  data.lilypondArgs = data.projectType === "lilypond" ? sanitizeLilypondArgsForStorage(data.lilypondArgs) : "";
  data.lilypondFormat = data.projectType === "lilypond" ? normalizeLilypondFormat(data.lilypondFormat) : "pdf";
  data.mainPath = sanitizeMainPathForStorage(data.mainPath);
  data.createdAt = now;
  data.updatedAt = now;
  data.revision = 0;
  validateProjectSourceTree(data);
  return data;
}

async function importProjectArchive(req, res, user, url) {
  requireProjectCreation(user);
  const body = await readRequestBuffer(req);
  let { archive, data } = parseProjectArchive(body);

  const uploadedName = path.basename(String(url.searchParams.get("filename") || ""), path.extname(String(url.searchParams.get("filename") || "")));
  const name = cleanName((data.project && data.project.name) || uploadedName || "Imported project");
  const id = uuidv7();
  const storageKey = projectStorageKey(id);
  const storagePath = resolveProjectStorageDir(DATA_DIR, storageKey);
  const now = Date.now();
  try {
    normalizeImportedProject(data, name, now);
  } catch {
    throw invalidProjectArchive();
  }

  await projectMutations.gate(id, () => projectMutations.transaction({ id, storageDir: storagePath, create: true }, async (client, protect) => {
    await protect();
    await fs.mkdir(storagePath, { recursive: true });
    for (const directory of archive.directories) {
      if (directory === ".iris/") continue;
      await fs.mkdir(path.join(storagePath, directory), { recursive: true });
    }
    for (const [fileName, contents] of archive.files) {
      if (fileName === ".iris/project.json") continue;
      const absolute = path.join(storagePath, fileName);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, contents);
    }
    await writeProjectManifest(storagePath, data);
    try {
      data = normalizeImportedProject(await readProjectFile(storagePath), name, now);
      remapImportedFileIds(data);
    } catch {
      throw invalidProjectArchive();
    }
    // The project row precedes the ledger it is referenced by; the ledger sync
    // stamps canonical ids into the tree, then the manifest is persisted with them.
    // The importer becomes the first owner.
    await client.query(
      "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
      [id, user.sub, name, storageKey]
    );
    await client.query(
      "INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)",
      [id, user.sub]
    );
    await syncProjectFiles(id, data, client, storagePath, protect);
    await writeProjectManifest(storagePath, data);
  }));

  await audit({
    ...sessionActor(req, user),
    action: "project.imported",
    targetType: "project",
    targetId: id,
    metadata: { name, projectType: data.projectType, fileCount: countFiles(data) },
  });
  json(res, 201, {
    project: { id, name, revision: 0, projectType: data.projectType, createdAt: now, updatedAt: now, fileCount: countFiles(data) },
    data: { id, ...data },
  });
}

function walkProjectFiles(nodes, fn) {
  if (!Array.isArray(nodes)) return;
  nodes.forEach((node) => {
    if (node.type === "folder") walkProjectFiles(node.children, fn);
    else fn(node);
  });
}

function normalizedProjectType(value) {
  return value === "lilypond" ? "lilypond" : value === "latex" ? "latex" : null;
}

function inferProjectType(data) {
  const stored = normalizedProjectType(data && data.projectType);
  if (stored) return stored;
  let texFiles = 0;
  let lilypondFiles = 0;
  walkProjectFiles(data && data.project && data.project.nodes, (file) => {
    const kind = fileKindForPath(file.path || file.name || "");
    if (kind === "tex") texFiles += 1;
    if (kind === "ly") lilypondFiles += 1;
  });
  return lilypondFiles > 0 && texFiles === 0 ? "lilypond" : "latex";
}

function findCompileFile(data, requestedPath, projectType = inferProjectType(data)) {
  let requested = null;
  let firstSource = null;
  let main = null;
  const expectedKind = projectType === "lilypond" ? "ly" : "tex";
  walkProjectFiles(data.project && data.project.nodes, (file) => {
    const kind = fileKindForPath(file.path || file.name || "");
    if (file.path === requestedPath && kind === expectedKind) requested = file;
    if (!firstSource && kind === expectedKind) firstSource = file;
    if (!main && kind === "tex" && /\\documentclass/.test(file.content || "")) main = file;
    if (!main && kind === "ly" && /\\score\b/.test(file.content || "")) main = file;
  });
  const picked = requested || main || firstSource;
  if (!picked || fileKindForPath(picked.path || picked.name || "") !== expectedKind) {
    const ext = projectType === "lilypond" ? ".ly" : ".tex";
    throw requestError("COMPILE_NO_SOURCE", 400, { extension: ext });
  }
  return picked;
}

function resolveCompileTool(tool, engine, projectType = "latex") {
  const resolved = tool === "[engine]" ? engine : String(tool || "").trim();
  const allowedTools = projectType === "lilypond" ? LILYPOND_COMPILE_TOOLS : LATEX_COMPILE_TOOLS;
  if (!allowedTools.has(resolved)) {
    throw requestError("COMPILE_TOOL_UNSUPPORTED", 400);
  }
  return resolved;
}

function compileCommand(tool, binPath) {
  const base = String(binPath || "").trim();
  return base ? path.join(base, tool) : tool;
}

function refreshFontCache(fontDir) {
  return new Promise((resolve) => {
    if (!fontDir || !fsSync.existsSync(fontDir)) return resolve("");
    const startedAt = Date.now();
    let log = `$ fc-cache -f ${fontDir}\n`;
    const child = trackedSpawn("fc-cache", ["-f", fontDir], { shell: false });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
    child.stdout.on("data", (chunk) => { log += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { log += chunk.toString("utf8"); });
    child.on("error", (err) => { log += `Iris: fc-cache unavailable: ${err.message}\n`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      log += `Iris: font cache completed in ${Date.now() - startedAt}ms (exit ${code}).\n`;
      resolve(log);
    });
  });
}

function defaultCompileProfile(projectType = "latex") {
  return {
    mode: "quick",
    steps: [
      { tool: "[engine]", args: ["[main]"] },
    ],
  };
}

function presetCompileProfile(mode, projectType = "latex") {
  if (projectType === "lilypond") return defaultCompileProfile("lilypond");
  if (mode === "bibtex") {
    return {
      mode,
      steps: [
        { tool: "[engine]", args: ["[main]"] },
        { tool: "bibtex", args: ["output/[jobname]"] },
        { tool: "[engine]", args: ["[main]"] },
        { tool: "[engine]", args: ["[main]"] },
      ],
    };
  }
  if (mode === "biber") {
    return {
      mode,
      steps: [
        { tool: "[engine]", args: ["[main]"] },
        { tool: "biber", args: ["--input-directory=output", "--output-directory=output", "[jobname]"] },
        { tool: "[engine]", args: ["[main]"] },
        { tool: "[engine]", args: ["[main]"] },
      ],
    };
  }
  if (mode === "index") {
    return {
      mode,
      steps: [
        { tool: "[engine]", args: ["[main]"] },
        { tool: "makeindex", args: ["-o", "output/[jobname].ind", "output/[jobname].idx"] },
        { tool: "[engine]", args: ["[main]"] },
      ],
    };
  }
  return defaultCompileProfile("latex");
}

function compileVariables(mainPath) {
  const jobname = path.basename(mainPath).replace(/\.[^.]+$/, "");
  return {
    main: mainPath,
    jobname,
    pdf: `output/${jobname}.pdf`,
  };
}

function expandCompileArg(arg, vars, engine) {
  const out = String(arg || "")
    .replaceAll("[engine]", engine)
    .replaceAll("[main]", vars.main)
    .replaceAll("[jobname]", vars.jobname)
    .replaceAll("[pdf]", vars.pdf);
  if (!out || out.includes("\0") || out.length > 500) {
    throw requestError("COMPILE_ARGUMENT_INVALID", 400);
  }
  return out;
}

function parseCompileArguments(value) {
  const input = String(value || "").trim();
  if (!input) return [];
  if (input.length > 2000 || input.includes("\0")) {
    throw requestError("LILYPOND_ARGUMENTS_INVALID", 400);
  }
  const args = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let started = false;
  const push = () => {
    if (!started || !current || current.length > 500 || args.length >= 40) {
      throw requestError("LILYPOND_ARGUMENTS_INVALID", 400);
    }
    args.push(current);
    current = "";
    started = false;
  };
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) push();
      continue;
    }
    current += char;
    started = true;
  }
  if (quote || escaped) {
    throw requestError("LILYPOND_ARGUMENTS_UNTERMINATED", 400);
  }
  if (started) push();
  return args;
}

function sanitizeLilypondArgsForStorage(value) {
  const input = String(value || "").trim();
  if (input.length > 2000 || input.includes("\0")) {
    throw requestError("LILYPOND_ARGUMENTS_INVALID", 400);
  }
  return input;
}

function sanitizeCustomCommandsForStorage(value) {
  try { return normalizeCustomCommands(value); }
  catch (error) {
    throw requestError("CUSTOM_COMMANDS_INVALID", 400, { language: error.kind === "ly" ? "LilyPond" : "LaTeX", line: error.line || 1 });
  }
}

// The project's main source file, kept as a project-relative path. Empty means
// Iris picks the file itself, which is what every project did before the setting
// existed and stays the default for new ones.
function sanitizeMainPathForStorage(value) {
  const input = String(value == null ? "" : value).trim();
  if (!input) return "";
  return safeProjectSourcePath(input);
}

function normalizeLilypondFormat(value) {
  const format = String(value || "pdf").trim().toLowerCase();
  if (!LILYPOND_OUTPUT_FORMATS.has(format)) {
    throw requestError("LILYPOND_FORMAT_UNSUPPORTED", 400);
  }
  return format;
}

function lilypondArgs(args, vars, additionalArgs = [], outputFormat = "pdf") {
  const format = normalizeLilypondFormat(outputFormat);
  const stripOutputOptions = (requested) => {
    const clean = [];
    for (let i = 0; i < requested.length; i++) {
      const arg = requested[i];
      if (arg === "-o" || arg === "--output") { i += 1; continue; }
      if (arg.startsWith("--output=") || (/^-o.+/.test(arg) && arg !== "-o")) continue;
      if (arg === "-f" || arg === "--format") { i += 1; continue; }
      if (/^-f.+/.test(arg) || arg.startsWith("--format=")) continue;
      if (arg === "-E") continue;
      if (/^--(pdf|png|svg|ps|eps)$/.test(arg)) continue;
      clean.push(arg);
    }
    return clean;
  };
  const clean = [...stripOutputOptions(additionalArgs), ...stripOutputOptions(args)];
  return [`--${format}`, `--output=output/${vars.jobname}`, ...clean];
}

function normalizeCompileProfile(profile, engine, mainPath, projectType = "latex", additionalArgs = [], outputFormat = "pdf") {
  const requested = projectType === "lilypond"
    ? defaultCompileProfile("lilypond")
    : (profile && typeof profile === "object" ? profile : defaultCompileProfile(projectType));
  const source = requested.mode && requested.mode !== "custom" ? presetCompileProfile(requested.mode, projectType) : requested;
  const steps = Array.isArray(source.steps) ? source.steps : defaultCompileProfile(projectType).steps;
  const vars = compileVariables(mainPath);
  return {
    mode: source.mode || "quick",
    steps: steps.slice(0, 12).map((step) => {
      const tool = resolveCompileTool(step.tool, engine, projectType);
      const rawArgs = Array.isArray(step.args) ? step.args : [];
      let args = rawArgs.map((arg) => expandCompileArg(arg, vars, engine));
      if (LATEX_ENGINES.has(tool)) {
        // Validate expanded arguments at the execution boundary, including saved
        // and imported profiles. TeX accepts aliases and abbreviated switches,
        // so a denylist cannot reliably keep its execution mode constrained.
        const options = args.filter((arg) => arg.startsWith("-"));
        const inputs = args.filter((arg) => !arg.startsWith("-"));
        const allowedOption = /^--?(?:interaction=nonstopmode|halt-on-error|file-line-error|no-shell-escape|output-directory=output|synctex=-?\d+|recorder|draftmode|8bit)$/;
        if (args.some((arg) => /[\x00-\x1f\x7f]/.test(arg))
          || options.some((arg) => !allowedOption.test(arg))
          || inputs.length !== 1
          || /^[\s&/]/.test(inputs[0])
          || inputs[0].includes("^^") // TeX decodes these even inside filenames.
          || /[\\":|]/.test(inputs[0])) {
          throw requestError("COMPILE_ARGUMENT_INVALID", 400);
        }
        safeProjectSourcePath(inputs[0]);
        args = [
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-file-line-error",
          "-no-shell-escape",
          "-output-directory=output",
          ...options,
          // Anything after the source operand is interpreted as TeX input.
          inputs[0],
        ];
      }
      if (tool === "lilypond") args = lilypondArgs(args, vars, additionalArgs, outputFormat);
      return { tool, args };
    }),
  };
}

function sanitizeCompileProfileForStorage(profile, projectType = "latex") {
  if (projectType === "lilypond") return { mode: "quick" };
  if (!profile || typeof profile !== "object") return { mode: "quick" };
  const mode = String(profile.mode || "quick");
  if (mode !== "custom") {
    const modes = ["quick", "bibtex", "biber", "index"];
    return { mode: modes.includes(mode) ? mode : "quick" };
  }
  const steps = Array.isArray(profile.steps) ? profile.steps : [];
  return {
    mode: "custom",
    steps: steps.slice(0, 12).map((step) => {
      const fallbackEngine = "pdflatex";
      const tool = step.tool === "[engine]" ? "[engine]" : resolveCompileTool(step.tool, fallbackEngine, projectType);
      const args = Array.isArray(step.args) ? step.args : String(step.args || "").split(/\s+/).filter(Boolean);
      return {
        tool,
        args: args.slice(0, 20).map((arg) => {
          const out = String(arg || "");
          if (!out || out.includes("\0") || out.length > 500) {
            throw requestError("COMPILE_ARGUMENT_INVALID", 400);
          }
          return out;
        }),
      };
    }).filter((step) => step.args.length),
  };
}

function kpathseaSearchPath(...dirs) {
  const cleanDirs = dirs
    .filter(Boolean)
    .map((dir) => String(dir).replace(/[\/\\]+$/, "") + path.sep + path.sep);
  return cleanDirs.join(path.delimiter) + path.delimiter;
}

function runCompileStep({ step, binPath, cwd, fontDir, texmfVar }) {
  return new Promise((resolve) => {
    const command = compileCommand(step.tool, binPath);
    const args = step.args;
    const envPath = binPath ? `${binPath}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH || "";
    const outputDir = path.join(cwd, "output");
    const projectSearchPath = kpathseaSearchPath(cwd, outputDir);
    const startedAt = Date.now();
    let log = "";
    let timedOut = false;
    let truncated = false;
    let done = false;
    const child = trackedSpawn(command, args, {
      cwd,
      env: {
        PATH: envPath,
        HOME: "/tmp",
        TMPDIR: "/tmp",
        ...(step.tool === "lilypond" ? { XDG_DATA_HOME: cwd } : {}),
        OSFONTDIR: fontDir || "",
        TEXMFVAR: texmfVar || "",
        TEXINPUTS: projectSearchPath,
        LUAINPUTS: projectSearchPath,
        BIBINPUTS: projectSearchPath,
        BSTINPUTS: projectSearchPath,
        max_print_line: "1000",
        openin_any: "p",
        openout_any: "p",
      },
      shell: false,
    });
    const append = (chunk) => {
      const text = chunk.toString("utf8");
      const remaining = Math.max(0, COMPILE_LOG_LIMIT - log.length);
      if (text.length > remaining) truncated = true;
      log += text.slice(0, remaining);
    };
    append(`$ ${command} ${args.join(" ")}\n`);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!done) child.kill("SIGKILL"); }, 1500);
    }, COMPILE_TIMEOUT_MS);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => append(`\nIris: unable to start ${command}: ${err.message}\n`));
    child.on("close", (code, signal) => {
      done = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (timedOut) append(`\nIris: compilation stopped after ${COMPILE_TIMEOUT_MS}ms.\n`);
      else if (signal) append(`\nIris: process terminated by signal ${signal}.\n`);
      const parsed = parseCompileLog(log, { cwd, bounded: false });
      resolve({ code, signal, timedOut, truncated, durationMs, log, ...parsed });
    });
  });
}

async function runCompilePipeline({ profile, binPath, cwd, fontDir, texmfVar, preLog }) {
  const startedAt = Date.now();
  let log = preLog || "";
  let exitCode = 0;
  let signal = null;
  let timedOut = false;
  const steps = [];
  for (let i = 0; i < profile.steps.length; i++) {
    const step = profile.steps[i];
    log += `\n===== Iris step ${i + 1}/${profile.steps.length}: ${step.tool} =====\n`;
    const res = await runCompileStep({ step, binPath, cwd, fontDir, texmfVar });
    // Arguments are the complete normalized execution profile, including source
    // and options. Do not infer comparability from only the main file or tool.
    const comparisonKey = LATEX_ENGINES.has(step.tool) ? JSON.stringify([step.tool, step.args]) : null;
    steps.push({ ...step, comparisonKey, ...res });
    log += res.log;
    exitCode = res.code;
    signal = res.signal;
    timedOut = res.timedOut;
    if (res.code !== 0 || res.signal || res.timedOut) break;
  }
  const parsed = selectCompileDiagnostics(steps, { cwd, preLog });
  return {
    code: exitCode,
    signal,
    timedOut,
    durationMs: Date.now() - startedAt,
    log,
    ...parsed,
  };
}

function artifactMimeType(format) {
  if (format === "pdf") return "application/pdf";
  if (format === "png") return "image/png";
  if (format === "svg") return "image/svg+xml";
  return "application/postscript";
}

function compileArtifactNameMatches(fileName, jobname, format) {
  if (!fileName.startsWith(jobname) || !fileName.toLowerCase().endsWith(`.${format}`)) return false;
  const boundary = fileName[jobname.length];
  return boundary === "." || boundary === "-";
}

async function readCompileArtifacts(outputDir, jobname, format) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isFile() && compileArtifactNameMatches(entry.name, jobname, format))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const exact = `${jobname}.${format}`;
      if (a === exact) return -1;
      if (b === exact) return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  const artifacts = [];
  for (const name of names) {
    const content = await fs.readFile(path.join(outputDir, name));
    artifacts.push({
      name: `output/${name}`,
      base64: content.toString("base64"),
      size: content.length,
      mimeType: artifactMimeType(format),
    });
  }
  return artifacts;
}

const BUILD_OUTPUT_FIELDS = `
  id, project_id, source_file_id, source_revision_id, source_content_hash, created_by, created_by_label,
  created_at, completed_at, status, project_type, compiler, format, main_path,
  display_name, storage_path, size, content_hash, artifact_count, duration_ms,
  exit_code, signal, timed_out`;

function buildOutputView(row, diagnostics = false) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    sourceContentHash: row.source_content_hash,
    createdBy: row.created_by,
    author: row.created_by_label,
    createdAt: toMillis(row.created_at),
    completedAt: row.completed_at ? toMillis(row.completed_at) : null,
    status: row.status,
    projectType: row.project_type,
    compiler: row.compiler,
    format: row.format,
    mainPath: row.main_path,
    displayName: row.display_name,
    storagePath: row.storage_path,
    size: Number(row.size),
    contentHash: row.content_hash,
    artifactCount: Number(row.artifact_count),
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    signal: row.signal,
    timedOut: row.timed_out,
    ...(diagnostics ? {
      log: row.log || "",
      ...compileDiagnosticsView(row),
    } : {}),
  };
}

function buildArtifactView(row, projectId, buildId) {
  const url = `/api/projects/${projectId}/builds/${buildId}/artifacts/${row.id}`;
  return {
    id: row.id,
    name: row.name,
    path: row.storage_path,
    mimeType: row.mime_type,
    size: Number(row.size),
    contentHash: row.content_hash,
    url,
    downloadUrl: `${url}?download=1`,
  };
}

function buildFileView(file, projectId, buildId) {
  return {
    name: file.name,
    path: file.path,
    mimeType: mimeForProjectFile(file.path),
    size: Number(file.size),
    downloadUrl: `/api/projects/${projectId}/builds/${buildId}/files/download?path=${encodeURIComponent(file.path)}`,
  };
}

function buildArchiveFileName(row) {
  const displayName = String(row.display_name || "build-output");
  const stem = path.basename(displayName, path.extname(displayName));
  return `${slugify(stem || "build-output")}-${String(row.id).slice(0, 8)}.zip`;
}

async function createBuildOutput({
  id, projectId, sourceFileId, sourceRevisionId, sourceContentHash, user, projectType, compiler, format, mainPath, displayName,
}) {
  const { rows } = await db.query(
    `INSERT INTO build_outputs (
       id, project_id, source_file_id, source_revision_id, source_content_hash, created_by,
       created_by_label, project_type, compiler, format, main_path, display_name
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING created_at`,
    [
      id, projectId, sourceFileId, sourceRevisionId, sourceContentHash, user.sub,
      versionAuthorLabel(user), projectType, compiler, format, mainPath, displayName,
    ]
  );
  return rows[0].created_at;
}

async function finalizeBuildOutput({ id, status, storagePath, artifacts, result }) {
  const { diagnostics } = compileDiagnosticsView(result);
  const succeeded = status === "succeeded";
  const size = succeeded ? artifacts.reduce((total, artifact) => total + artifact.size, 0) : 0;
  const contentHash = succeeded ? hashBuildArtifacts(artifacts) : null;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (succeeded) {
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO build_artifacts (id, build_id, name, storage_path, mime_type, size, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [artifact.id, id, artifact.fileName, artifact.storagePath, artifact.mimeType, artifact.size, artifact.contentHash]
        );
      }
    }
    const update = await client.query(
      `UPDATE build_outputs SET
         completed_at = CURRENT_TIMESTAMP, status = $2, storage_path = $3, size = $4,
         content_hash = $5, artifact_count = $6, duration_ms = $7, exit_code = $8,
         signal = $9, timed_out = $10, log = $11, warnings = $12::jsonb, errors = $13::jsonb,
         diagnostics_version = 1
       WHERE id = $1 AND status = 'running'`,
      [
        id, status, succeeded ? storagePath : null, size, contentHash, succeeded ? artifacts.length : 0,
        result.durationMs ?? null, result.code ?? null, result.signal || null, result.timedOut === true,
        String(result.log || "").slice(0, COMPILE_LOG_LIMIT),
        JSON.stringify(diagnostics.filter((d) => d.severity === "warning")),
        JSON.stringify(diagnostics.filter((d) => d.severity === "error")),
      ]
    );
    if (update.rowCount !== 1) throw new Error(`Build ${id} is no longer running`);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { size, contentHash };
}

async function listBuildOutputs(req, res, user, projectId, url) {
  await authorizeProject(projectId, user, "read");
  const requestedLimit = Number(url.searchParams.get("limit"));
  const requestedOffset = Number(url.searchParams.get("offset"));
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 50;
  const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
    ? Math.min(requestedOffset, 1_000_000)
    : 0;
  const [{ rows }, latest] = await Promise.all([
    db.query(
      `SELECT ${BUILD_OUTPUT_FIELDS} FROM build_outputs
       WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [projectId, limit + 1, offset]
    ),
    db.query(
      `SELECT id FROM build_outputs
       WHERE project_id = $1 AND status = 'succeeded'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [projectId]
    ),
  ]);
  const hasMore = rows.length > limit;
  const builds = rows.slice(0, limit).map((row) => buildOutputView(row));
  json(res, 200, {
    builds,
    latestSuccessfulId: latest.rows[0] ? latest.rows[0].id : null,
    offset,
    nextOffset: hasMore ? offset + limit : null,
  });
}

async function getBuildOutput(req, res, user, projectId, buildId) {
  const project = await authorizeProject(projectId, user, "read");
  const { rows } = await db.query(
    `SELECT ${BUILD_OUTPUT_FIELDS}, log, warnings, errors, diagnostics_version FROM build_outputs
     WHERE id = $1 AND project_id = $2`,
    [buildId, projectId]
  );
  if (!rows.length) throw requestError("BUILD_NOT_FOUND", 404);
  const build = rows[0];
  const filesPromise = build.status === "succeeded" && build.storage_path
    ? listBuildFiles(project.storageDir, buildId, build.storage_path, {
      maxEntries: BUILD_ARCHIVE_MAX_ENTRIES,
      errorCode: "BUILD_FILE_LIST_TOO_LARGE",
    }).catch((error) => {
      if (error && error.code === "BUILD_FILE_LIST_TOO_LARGE") throw requestError("BUILD_FILE_LIST_TOO_LARGE", 413);
      throw error;
    })
    : Promise.resolve([]);
  const [{ rows: artifacts }, files] = await Promise.all([
    db.query(
      `SELECT id, name, storage_path, mime_type, size, content_hash
       FROM build_artifacts WHERE build_id = $1 ORDER BY name`,
      [buildId]
    ),
    filesPromise,
  ]);
  json(res, 200, {
    build: buildOutputView(build, true),
    artifacts: artifacts.map((artifact) => buildArtifactView(artifact, projectId, buildId)),
    files: files.map((file) => buildFileView(file, projectId, buildId)),
    directorySize: files.reduce((total, file) => total + Number(file.size), 0),
    archiveUrl: build.status === "succeeded" && files.length ? `/api/projects/${projectId}/builds/${buildId}/archive` : null,
    archiveName: build.status === "succeeded" && files.length ? buildArchiveFileName(build) : null,
  });
}

async function downloadBuildArtifact(req, res, user, projectId, buildId, artifactId, url) {
  const project = await authorizeProject(projectId, user, "read");
  const { rows } = await db.query(
    `SELECT a.name, a.storage_path, a.mime_type, a.size,
            b.storage_path AS build_storage_path
     FROM build_artifacts a JOIN build_outputs b ON b.id = a.build_id
     WHERE a.id = $1 AND a.build_id = $2 AND b.project_id = $3 AND b.status = 'succeeded'`,
    [artifactId, buildId, projectId]
  );
  if (!rows.length) throw requestError("BUILD_ARTIFACT_NOT_FOUND", 404);
  const artifact = rows[0];
  const file = await resolveBuildArtifact(
    project.storageDir, buildId, artifact.build_storage_path, artifact.storage_path
  );
  if (!file) throw requestError("BUILD_ARTIFACT_NOT_FOUND", 404);
  const fallbackName = artifact.name.replace(/[^A-Za-z0-9._-]/g, "_") || "download";
  const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
  res.writeHead(200, {
    "content-type": artifact.mime_type,
    "content-length": file.size,
    "content-disposition": `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodeDispositionValue(artifact.name)}`,
    "cache-control": "private, no-store",
  });
  await new Promise((resolve, reject) => {
    const stream = file.handle.createReadStream({ autoClose: true });
    stream.on("error", reject);
    res.on("finish", resolve);
    res.on("close", resolve);
    stream.pipe(res);
  });
}

async function downloadBuildFile(req, res, user, projectId, buildId, url) {
  const project = await authorizeProject(projectId, user, "read");
  const { rows } = await db.query(
    `SELECT id, storage_path FROM build_outputs
     WHERE id = $1 AND project_id = $2 AND status = 'succeeded'`,
    [buildId, projectId]
  );
  if (!rows.length) throw requestError("BUILD_FILE_NOT_FOUND", 404);
  let file;
  try {
    file = await resolveBuildFile(
      project.storageDir, buildId, rows[0].storage_path, url.searchParams.get("path")
    );
  } catch (error) {
    throw requestError("BUILD_FILE_NOT_FOUND", 404);
  }
  if (!file) throw requestError("BUILD_FILE_NOT_FOUND", 404);
  const fallbackName = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "download";
  res.writeHead(200, {
    "content-type": mimeForProjectFile(file.relativePath),
    "content-length": file.size,
    "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeDispositionValue(file.name)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  await new Promise((resolve, reject) => {
    const stream = file.handle.createReadStream({ autoClose: true });
    stream.on("error", reject);
    res.on("finish", resolve);
    res.on("close", resolve);
    stream.pipe(res);
  });
}

async function downloadBuildArchive(req, res, user, projectId, buildId) {
  const project = await authorizeProject(projectId, user, "read");
  const { rows } = await db.query(
    `SELECT id, display_name, storage_path FROM build_outputs
     WHERE id = $1 AND project_id = $2 AND status = 'succeeded'`,
    [buildId, projectId]
  );
  if (!rows.length) throw requestError("BUILD_ARCHIVE_UNAVAILABLE", 404);
  let archive;
  try {
    const entries = await collectBuildArchiveEntries(
      project.storageDir,
      buildId,
      rows[0].storage_path,
      { maxBytes: BUILD_ARCHIVE_MAX_BYTES, maxEntries: BUILD_ARCHIVE_MAX_ENTRIES }
    );
    if (!entries) throw requestError("BUILD_ARCHIVE_UNAVAILABLE", 404);
    archive = createZip(entries);
  } catch (error) {
    if (["BUILD_ARCHIVE_TOO_LARGE", "ZIP_TOO_MANY_ENTRIES", "ZIP_ENTRY_TOO_LARGE"].includes(error && error.code)) {
      throw requestError("BUILD_ARCHIVE_TOO_LARGE", 413);
    }
    throw error;
  }
  const fileName = buildArchiveFileName(rows[0]);
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-length": archive.length,
    "content-disposition": `attachment; filename="${fileName}"; filename*=UTF-8''${encodeDispositionValue(fileName)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(archive);
}

async function deleteBuildOutput(req, res, user, projectId, buildId) {
  const project = await authorizeProject(projectId, user, "deleteBuild");
  const client = await db.connect();
  let build;
  let originalDirectory = null;
  let quarantinedDirectory = null;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, status, format, storage_path FROM build_outputs
       WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [buildId, projectId]
    );
    if (!rows.length) throw requestError("BUILD_NOT_FOUND", 404);
    build = rows[0];
    if (build.status === "running" && activeBuilds.has(buildId)) throw requestError("BUILD_IN_PROGRESS", 409);
    originalDirectory = await resolveBuildDirectory(
      project.storageDir, buildId, build.storage_path || buildStoragePath(buildId)
    );
    if (originalDirectory) {
      quarantinedDirectory = `${originalDirectory}.deleting-${uuidv7()}`;
      await fs.rename(originalDirectory, quarantinedDirectory);
    }
    await client.query("DELETE FROM build_outputs WHERE id = $1", [buildId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (quarantinedDirectory && originalDirectory) {
      await fs.rename(quarantinedDirectory, originalDirectory).catch((restoreError) => {
        console.error(`Could not restore build ${buildId} after database rollback`, restoreError);
      });
    }
    throw err;
  } finally {
    client.release();
  }
  if (quarantinedDirectory) await fs.rm(quarantinedDirectory, { recursive: true, force: true });
  await fs.rm(path.join(DATA_DIR, ".build-staging", projectId, buildId), { recursive: true, force: true }).catch(() => {});
  await audit({
    ...sessionActor(req, user),
    action: "build.deleted",
    targetType: "build",
    targetId: buildId,
    metadata: { projectId, status: build.status, format: build.format },
  });
  json(res, 200, { ok: true });
}

async function compileProject(req, res, user, id) {
  const body = await readBody(req);
  await authorizeProject(id, user, "compile");
  // Charged after authorization, so an outsider probing the endpoint cannot
  // consume a member's allowance, and keyed on the pair so one member's loop
  // does not exhaust the budget of a project they merely have access to.
  enforceRateLimit(compileLimiter, `compile:${user.sub}:${id}`, "COMPILE_RATE_LIMITED");
  const buildId = uuidv7();
  const stagingDir = path.join(DATA_DIR, ".build-staging", id, buildId);
  let confirmedSetup = null;
  let source = null;
  let buildCreatedAt = null;
  let buildCreated = false;
  let result = {
    code: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    log: "",
    warnings: [],
    errors: [],
  };
  let publishedPath = null;
  let finalized = false;
  // The slot is taken before anything durable exists — before the staging tree,
  // before the build row — so a caller turned away by a full queue leaves
  // nothing behind to reconcile. It is released in the `finally` below, after
  // the compiler process has exited and its output has been published.
  let releaseCompileSlot;
  try {
    if (shuttingDown) throw new GateRejectedError("COMPILE_SERVER_BUSY");
    releaseCompileSlot = await compileGate.acquire();
  } catch (err) {
    if (err instanceof GateRejectedError) throw requestError("COMPILE_SERVER_BUSY", 503);
    throw err;
  }
  activeBuilds.add(buildId);
  try {
    const { row, data, projectType, engine, binPath, main, mainPath, storedLilypondArgs, outputFormat, compileProfile, buildFiles } = await authorizedProjectGate(id, user, "compile", async (project) => {
      const setup = await projectMutations.transaction({ id, storageDir: project.storageDir }, async (client, protect) => {
        const row = await authorizeProject(id, user, "compile", client);
        if (body.data && typeof body.data === "object") requireProjectRevision(body, row);
        const name = body.name == null ? row.name : cleanName(body.name);
        const data = body.data && typeof body.data === "object" ? body.data : await readProjectFile(row.storageDir, { strictRead: true });
        data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
        data.project.name = name;
        const projectType = inferProjectType(data);
        data.projectType = projectType;
        validateProjectSourceTree(data);
        const engine = projectType === "lilypond" ? "lilypond" : String(body.engine || data.engine || "pdflatex").trim();
        if (projectType === "latex" && !LATEX_ENGINES.has(engine)) {
          throw requestError("LATEX_ENGINE_UNSUPPORTED", 400);
        }
        const binPath = projectType === "lilypond"
          ? (LILYPOND_PATH_LOCKED ? LILYPOND_BIN_PATH : String(body.lilypondPath || LILYPOND_BIN_PATH || "").trim())
          : (TEX_PATH_LOCKED ? TEX_BIN_PATH : String(body.texPath || TEX_BIN_PATH || "").trim());
        const storedLilypondArgs = projectType === "lilypond"
          ? sanitizeLilypondArgsForStorage(body.lilypondArgs ?? data.lilypondArgs)
          : "";
        const outputFormat = projectType === "lilypond"
          ? normalizeLilypondFormat(body.lilypondFormat ?? data.lilypondFormat)
          : "pdf";
        const additionalArgs = projectType === "lilypond" ? parseCompileArguments(storedLilypondArgs) : [];
        const storedCompileProfile = sanitizeCompileProfileForStorage(body.compileProfile || data.compileProfile, projectType);
        data.compileProfile = storedCompileProfile;
        data.lilypondArgs = storedLilypondArgs;
        data.lilypondFormat = outputFormat;
        await saveProjectTree(id, row, body, data, client, protect, { user });
        const buildFiles = collectProjectFiles(data.project.nodes).map((entry) => ({
          id: entry.node.id,
          path: entry.path,
          kind: entry.kind,
        }));
        // Select from effective saved bytes after renames and room authority,
        // preserving candidate DFS order without hydrating the response payload.
        const candidates = [];
        for (const file of buildFiles) {
          if (fileKindForPath(file.path) !== (projectType === "lilypond" ? "ly" : "tex")) continue;
          candidates.push({ ...file, content: await fs.readFile(path.join(row.storageDir, file.path), "utf8") });
        }
        // One-off aliases only select among the effective source candidates;
        // they never become the stored setting or an unchecked filesystem path.
        const requestedPath = (typeof body.mainPath === "string" ? normalizeProjectPath(body.mainPath.trim()) : null) || data.mainPath;
        const main = findCompileFile({ project: { nodes: candidates } }, requestedPath, projectType);
        const mainPath = safeProjectSourcePath(main.path);
        const compileProfile = normalizeCompileProfile(storedCompileProfile, engine, mainPath, projectType, additionalArgs, outputFormat);
        return { row, data, projectType, engine, binPath, main, mainPath, storedLilypondArgs, outputFormat, compileProfile, buildFiles };
      });
      confirmedSetup = setup;
      collabReconcileProject(id, setup.data);
      // Keep the initial gate through the copy: sparse payloads are not file
      // snapshots, and no save/push/delete may change these bytes mid-copy.
      await fs.mkdir(path.dirname(stagingDir), { recursive: true });
      await ensureProjectDirs(stagingDir, setup.data);
      for (const file of setup.buildFiles) {
        const bytes = await fs.readFile(path.join(setup.row.storageDir, file.path));
        const dest = path.join(stagingDir, file.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, bytes);
      }
      return setup;
    });
    const jobname = path.basename(mainPath).replace(/\.[^.]+$/, "");
    const outputName = `${jobname}.${outputFormat}`;
    let sourceVersions;
    await authorizedProjectGate(id, user, "compile", async () => {
      const checkpoint = await captureProjectCheckpoint({
        projectId: id,
        storageDir: stagingDir,
        user,
        reason: "compile",
        files: buildFiles,
        strictRead: true,
      });
      sourceVersions = checkpoint.versions;
      source = await sourceRevisionForBuild(
        stagingDir, mainPath, main.id, checkpoint.versions.get(main.id) || null
      );
      buildCreatedAt = await createBuildOutput({
        id: buildId,
        projectId: id,
        sourceFileId: source.sourceFileId,
        sourceRevisionId: source.sourceRevisionId,
        sourceContentHash: source.sourceContentHash,
        user,
        projectType,
        compiler: engine,
        format: outputFormat,
        mainPath,
        displayName: outputName,
      });
      buildCreated = true;
    });
    const stagingOutputDir = path.join(stagingDir, "output");
    await fs.mkdir(stagingOutputDir, { recursive: true });
    const fontDir = path.join(stagingDir, "fonts");
    const texmfVar = path.join(stagingDir, ".iris", "texmf-var");
    await fs.mkdir(texmfVar, { recursive: true });
    const preLog = /^(xelatex|lualatex)$/i.test(engine) ? await refreshFontCache(fontDir) : "";
    result = await runCompilePipeline({ profile: compileProfile, binPath, cwd: stagingDir, fontDir, texmfVar, preLog });
    const sourcesByPath = new Map(buildFiles.map((file) => [file.path, file]));
    result.diagnostics = result.diagnostics.map((item) => {
      const file = sourcesByPath.get(item.file);
      const revision = file && sourceVersions.get(file.id);
      return revision ? { ...item, sourceFileId: file.id, sourceRevisionId: revision } : item;
    });
    const generatedArtifacts = await readCompileArtifacts(stagingOutputDir, jobname, outputFormat);
    const success = result.code === 0 && generatedArtifacts.length > 0;
    const artifacts = success ? versionCompileArtifacts(generatedArtifacts, buildId, uuidv7) : [];
    const status = success ? "succeeded" : "failed";
    await authorizedProjectGate(id, user, "compile", async () => {
      if (success) publishedPath = await publishCompileOutput(stagingOutputDir, row.storageDir, buildId);
      await finalizeBuildOutput({ id: buildId, status, storagePath: publishedPath, artifacts, result });
      finalized = true;
    });
    collabNotifyBuild({ projectId: id, buildId, status, user });
    await audit({
      ...sessionActor(req, user),
      action: "build.completed",
      outcome: success ? "success" : "failure",
      targetType: "build",
      targetId: buildId,
      metadata: { projectId: id, compiler: engine, format: outputFormat, artifactCount: artifacts.length },
    });

    const primaryArtifact = artifacts[0] || null;
    const pdfArtifact = outputFormat === "pdf" ? primaryArtifact : null;
    json(res, 200, {
      revision: data.revision,
      data: { id, ...data },
      buildId,
      buildStatus: status,
      buildCreatedAt: toMillis(buildCreatedAt),
      sourceFileId: source.sourceFileId,
      sourceRevisionId: source.sourceRevisionId,
      sourceContentHash: source.sourceContentHash,
      success,
      projectType,
      engine,
      mainPath,
      outputDir: publishedPath,
      outputFormat,
      outputName: primaryArtifact ? primaryArtifact.name : `${buildStoragePath(buildId)}/${outputName}`,
      artifacts,
      artifactCount: artifacts.length,
      pdfName: pdfArtifact ? pdfArtifact.name : null,
      pdfBase64: pdfArtifact ? pdfArtifact.base64 : null,
      pdfSize: pdfArtifact ? pdfArtifact.size : 0,
      compileProfile,
      lilypondArgs: storedLilypondArgs,
      durationMs: result.durationMs,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      log: result.log,
      warnings: result.warnings,
      errors: result.errors,
      diagnostics: result.diagnostics,
    });
  } catch (err) {
    if (confirmedSetup) err.params = { ...err.params, savedRevision: confirmedSetup.data.revision };
    if (buildCreated && !finalized) {
      const { row, engine, outputFormat } = confirmedSetup;
      if (publishedPath) {
        const publishedDir = await resolveBuildDirectory(row.storageDir, buildId, publishedPath).catch(() => null);
        if (publishedDir) await fs.rm(publishedDir, { recursive: true, force: true }).catch(() => {});
      }
      const message = `Iris: build setup or publication failed: ${err.message || err}`;
      const failedResult = {
        ...result,
        log: `${result.log || ""}\n${message}\n`,
        diagnostics: [
          // Keep the terminal cause even when compiler errors fill the cap.
          ...parseCompileLog(message).diagnostics,
          ...compileDiagnosticsView(result).diagnostics,
        ],
      };
      await finalizeBuildOutput({
        id: buildId,
        status: "failed",
        storagePath: null,
        artifacts: [],
        result: failedResult,
      }).catch(() => {});
      collabNotifyBuild({ projectId: id, buildId, status: "failed", user });
      await audit({
        ...sessionActor(req, user),
        action: "build.completed",
        outcome: "failure",
        targetType: "build",
        targetId: buildId,
        metadata: { projectId: id, compiler: engine, format: outputFormat, internalError: true },
      }).catch(() => {});
    }
    throw err;
  } finally {
    activeBuilds.delete(buildId);
    releaseCompileSlot();
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------- retention and garbage collection ---------------- */
// Nothing in this section is allowed to be the reason a request fails, so every
// entry point is driven from a timer and every error is logged rather than
// thrown. Deleting is also always the *last* step: a row goes first and its
// bytes follow, because a directory with no row is inert and reclaimable on the
// next pass, whereas a row with no directory is a build the interface offers and
// cannot deliver.

// A compilation whose process died leaves a row claiming to be running that
// nothing will ever complete. The grace period is what makes this safe to run
// against a live database: a build younger than several compile timeouts might
// simply be slow, and — more importantly — might belong to another instance
// sharing this database, which must never have its work declared dead.
const STALLED_BUILD_GRACE_MS = Math.max(COMPILE_TIMEOUT_MS * 4, 5 * 60 * 1000);

async function reconcileStalledBuilds() {
  return startBackgroundWrite(reconcileStalledBuildsNow);
}

async function reconcileStalledBuildsNow() {
  const cutoff = new Date(Date.now() - STALLED_BUILD_GRACE_MS);
  const { rows } = await db.query(
    `UPDATE build_outputs SET
       status = 'failed', completed_at = CURRENT_TIMESTAMP,
       log = CASE WHEN log = '' THEN $2 ELSE log || E'\\n' || $2 END,
       errors = errors || $3::jsonb
     WHERE status = 'running' AND created_at < $1
     RETURNING id, project_id`,
    [
      cutoff,
      "Iris: this build was interrupted and never completed.",
      JSON.stringify(["Iris: this build was interrupted and never completed."]),
    ]
  );
  if (rows.length) console.log(`Retention: closed ${rows.length} interrupted build(s)`);
  return rows.length;
}

// Both halves of the rule are in the one statement: `position > keep` is the
// count, `created_at < cutoff` is the age, and a row must satisfy both to be
// deleted. The newest revision of a file always has position 1 and the keep
// floor is well above 1, so the current state of a file is unreachable from here
// by construction rather than by a special case that could be forgotten.
//
// Two foreign keys absorb the consequences. document_versions.parent_version_id
// is ON DELETE SET NULL, so pruning the middle of a chain leaves the survivors
// linked to null instead of to a row that is gone; and build_outputs
// .source_revision_id is likewise nulled, with source_content_hash still
// recording which source the build came from.
async function pruneProjectVersions(projectId, policy, now) {
  const { rowCount } = await db.query(
    `WITH ranked AS (
       SELECT dv.id, dv.created_at,
              ROW_NUMBER() OVER (PARTITION BY dv.file_id ORDER BY dv.created_at DESC, dv.id DESC) AS position
       FROM document_versions dv
       JOIN project_files pf ON pf.id = dv.file_id
       WHERE pf.project_id = $1
     )
     DELETE FROM document_versions dv
     USING ranked
     WHERE dv.id = ranked.id AND ranked.position > $2 AND ranked.created_at < $3`,
    [projectId, policy.versionKeep, cutoffDate(policy.versionDays, now)]
  );
  return rowCount || 0;
}

// The same double condition for builds, with one addition: the most recent
// successful build is never pruned whatever its age. It is what the editor
// restores when the project is reopened, and a project whose last good output
// aged out would open showing nothing at all — which reads as data loss even
// though the sources are intact. Builds still running are excluded outright:
// their directory is being written to.
async function pruneProjectBuilds(projectId, storageDir, policy, now) {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT id, created_at,
              ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS position
       FROM build_outputs
       WHERE project_id = $1 AND status <> 'running'
     ),
     protected_build AS (
       SELECT id FROM build_outputs
       WHERE project_id = $1 AND status = 'succeeded'
       ORDER BY created_at DESC, id DESC LIMIT 1
     )
     DELETE FROM build_outputs b
     USING ranked
     WHERE b.id = ranked.id
       AND ranked.position > $2
       AND ranked.created_at < $3
       AND b.id NOT IN (SELECT id FROM protected_build)
     RETURNING b.id, b.storage_path`,
    [projectId, policy.buildKeep, cutoffDate(policy.buildDays, now)]
  );
  for (const build of rows) {
    // A path that fails to resolve is one the safety checks in resolveBuildDirectory
    // refused, so it is left alone rather than removed on a guess.
    const directory = await resolveBuildDirectory(
      storageDir, build.id, build.storage_path || buildStoragePath(build.id)
    ).catch(() => null);
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch((err) => {
      console.error(`Retention: could not remove build directory for ${build.id}`, err.message || err);
    });
  }
  return rows.length;
}

// Directories under output/ whose build row no longer exists. A build row is
// always created before its directory is published, so a directory without one
// can only be the residue of a delete that failed halfway — never a build about
// to be registered. The grace period covers the window between publication and
// the row's completion.
async function pruneOrphanedBuildDirectories(projectId, storageDir, now) {
  const output = path.join(storageDir, "output");
  const entries = await fs.readdir(output, { withFileTypes: true }).catch(() => null);
  if (!entries) return 0;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(output, entry.name);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat || stat.isSymbolicLink()) continue;
    if (now - stat.mtimeMs < RETENTION_ORPHAN_GRACE_MS) continue;
    // The quarantine directories deleteBuildOutput renames into place before
    // removing them: if the process died in between, nothing will ever come back
    // for them, and their name is not a build id to check against the database.
    if (entry.name.includes(".deleting-")) {
      await fs.rm(absolute, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (isUuid(entry.name)) candidates.push(entry.name);
  }
  if (!candidates.length) return 0;
  const { rows } = await db.query(
    "SELECT id FROM build_outputs WHERE project_id = $1 AND id = ANY($2::uuid[])",
    [projectId, candidates]
  );
  const known = new Set(rows.map((row) => row.id));
  let removed = 0;
  for (const name of candidates) {
    if (known.has(name)) continue;
    await fs.rm(path.join(output, name), { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

// Staging trees belong to a compilation in flight and are removed in its
// `finally`. One that outlives the grace period belonged to a process that died
// before reaching it.
async function pruneAbandonedStaging(now) {
  const root = path.join(DATA_DIR, ".build-staging");
  const projects = await fs.readdir(root, { withFileTypes: true }).catch(() => null);
  if (!projects) return 0;
  let removed = 0;
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    const builds = await fs.readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const build of builds) {
      if (!build.isDirectory() || activeBuilds.has(build.name)) continue;
      const absolute = path.join(projectDir, build.name);
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat || now - stat.mtimeMs < RETENTION_ORPHAN_GRACE_MS) continue;
      await fs.rm(absolute, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
    // Removes the per-project level once its last staging tree is gone; fails
    // harmlessly while any remain, since the directory is not empty.
    await fs.rmdir(projectDir).catch(() => {});
  }
  return removed;
}

// The audit trail is instance-wide and has no owner, so its retention is the
// operator's alone. Deleted in batches: this is the highest-volume table in the
// schema, and one unbounded DELETE on a busy instance would hold locks for far
// longer than a background sweep has any right to.
async function pruneAuditEvents(now, batch = 5000) {
  const cutoff = cutoffDate(AUDIT_RETENTION_DAYS, now);
  let removed = 0;
  for (;;) {
    const { rowCount } = await db.query(
      `DELETE FROM audit_events WHERE ctid IN (
         SELECT ctid FROM audit_events WHERE occurred_at < $1 LIMIT $2
       )`,
      [cutoff, batch]
    );
    removed += rowCount || 0;
    if (!rowCount || rowCount < batch) return removed;
  }
}

let retentionSweepTimer = null;
let retentionSweepRunning = false;

async function runRetentionSweep() {
  // One sweep at a time. An instance whose sweep takes longer than the interval
  // should fall behind rather than run two of them over the same rows.
  if (retentionSweepRunning || shuttingDown || maintenanceActive()) return null;
  retentionSweepRunning = true;
  return startBackgroundWrite(runRetentionSweepNow).finally(() => { retentionSweepRunning = false; });
}

async function runRetentionSweepNow() {
  const now = Date.now();
  const totals = { builds: 0, versions: 0, directories: 0, audit: 0, stalled: 0 };
  try {
    totals.stalled = await reconcileStalledBuildsNow();
    const { rows } = await db.query(
      `SELECT id, storage_path, build_keep, build_days, version_keep, version_days FROM projects`
    );
    for (const row of rows) {
      if (shuttingDown) break;
      // Per project rather than per statement: one project whose storage has
      // been moved or removed underneath the database must not stop the sweep
      // for every other project on the instance.
      try {
        await projectMutations.gate(row.id, async () => {
          // Retention must not race a restore, publication or compensated delete,
          // and recovery-blocked projects must retain their history untouched.
          const current = await db.query(
            "SELECT storage_path, build_keep, build_days, version_keep, version_days FROM projects WHERE id = $1",
            [row.id]
          );
          if (!current.rows.length || shuttingDown) return;
          const policy = projectRetention(current.rows[0]);
          const storageDir = resolveProjectStorageDir(DATA_DIR, current.rows[0].storage_path);
          totals.builds += await pruneProjectBuilds(row.id, storageDir, policy, now);
          totals.versions += await pruneProjectVersions(row.id, policy, now);
          totals.directories += await pruneOrphanedBuildDirectories(row.id, storageDir, now);
        });
      } catch (err) {
        console.error(`Retention: sweep failed for project ${row.id}`, err.message || err);
      }
    }
    totals.directories += await pruneAbandonedStaging(now);
    totals.audit = await pruneAuditEvents(now);
  } catch (err) {
    console.error("Retention sweep failed", err.message || err);
  }
  const reclaimed = totals.builds + totals.versions + totals.directories + totals.audit + totals.stalled;
  if (reclaimed) {
    console.log(
      `Retention: ${totals.builds} build(s), ${totals.versions} revision(s), `
      + `${totals.directories} directory(ies), ${totals.audit} audit event(s), ${totals.stalled} interrupted build(s)`
    );
  }
  return totals;
}

function startRetentionSweep() {
  if (!RETENTION_ENABLED) {
    console.log("Retention sweep disabled (RETENTION_ENABLED=false)");
    return null;
  }
  // The first pass is deferred rather than run at boot: startup is when the
  // process is busiest and least able to spare I/O, and nothing here is urgent.
  // Interrupted builds are the one exception, reconciled straight away, because
  // until they are the interface shows compilations that are still spinning.
  reconcileStalledBuilds().catch((err) => console.error("Retention: startup reconciliation failed", err.message || err));
  retentionSweepTimer = setInterval(() => {
    runRetentionSweep().catch((err) => console.error("Retention sweep failed", err.message || err));
    // The rate limiters keep an entry per active key; sweeping them here costs
    // nothing and keeps a long-running process from holding entries for callers
    // that stopped calling hours ago.
    for (const limiter of [authIpLimiter, authAccountLimiter, apiLimiter, compileLimiter]) limiter.sweep();
  }, RETENTION_SWEEP_MS);
  if (typeof retentionSweepTimer.unref === "function") retentionSweepTimer.unref();
  return retentionSweepTimer;
}

const PROJECT_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})$`);
const PROJECT_TEMPLATE_FILE_ROUTE = /^\/api\/project-templates\/(latex|lilypond)\/([^/]+)$/;
const PROJECT_COMPILE_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/compile$`);
const PROJECT_BUILDS_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/builds$`);
const PROJECT_BUILD_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/builds/(${UUID_PATTERN})$`);
const PROJECT_BUILD_ARTIFACT_ROUTE = new RegExp(
  `^/api/projects/(${UUID_PATTERN})/builds/(${UUID_PATTERN})/artifacts/(${UUID_PATTERN})$`
);
const PROJECT_BUILD_FILE_ROUTE = new RegExp(
  `^/api/projects/(${UUID_PATTERN})/builds/(${UUID_PATTERN})/files/download$`
);
const PROJECT_BUILD_ARCHIVE_ROUTE = new RegExp(
  `^/api/projects/(${UUID_PATTERN})/builds/(${UUID_PATTERN})/archive$`
);
const PROJECT_ARCHIVE_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/archive$`);
const PROJECT_FILE_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/files/download$`);
const ADMIN_USERS_ROUTE = "/api/admin/users";
const ADMIN_USER_ROUTE = new RegExp(`^/api/admin/users/(${UUID_PATTERN})$`);
const ADMIN_USER_RESET_ROUTE = new RegExp(`^/api/admin/users/(${UUID_PATTERN})/reset-password$`);
const ADMIN_USER_UNLINK_ROUTE = new RegExp(`^/api/admin/users/(${UUID_PATTERN})/unlink-sso$`);
const ADMIN_USER_DELETION_PREVIEW_ROUTE = new RegExp(`^/api/admin/users/(${UUID_PATTERN})/deletion-preview$`);
const ADMIN_PROJECTS_ROUTE = "/api/admin/projects";
const ADMIN_PROJECT_ROUTE = new RegExp(`^/api/admin/projects/(${UUID_PATTERN})$`);
const ADMIN_PROJECT_MEMBERS_ROUTE = new RegExp(`^/api/admin/projects/(${UUID_PATTERN})/members$`);
const ADMIN_PROJECT_MEMBER_ROUTE = new RegExp(`^/api/admin/projects/(${UUID_PATTERN})/members/(${UUID_PATTERN})$`);
const ADMIN_TEMPLATES_ROUTE = "/api/admin/templates";
const ADMIN_TEMPLATE_ROUTE = /^\/api\/admin\/templates\/([^/]+)\/([^/]+)$/;
const PROJECT_MEMBERS_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/members$`);
const PROJECT_MEMBER_SEARCH_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/members/search$`);
const PROJECT_MEMBER_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/members/(${UUID_PATTERN})$`);
const PROJECT_CHECKPOINT_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/checkpoint$`);
const FILE_VERSIONS_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/files/(${UUID_PATTERN})/versions$`);
const FILE_VERSION_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/files/(${UUID_PATTERN})/versions/(${UUID_PATTERN})$`);
const FILE_VERSION_RESTORE_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})/files/(${UUID_PATTERN})/versions/(${UUID_PATTERN})/restore$`);

// Serializes every operation that can affect the "at least one active admin"
// invariant, so two concurrent demotions cannot race past the count check.
const ADMIN_INVARIANT_LOCK = 49524954;

function validAdminUsername(value) {
  const username = cleanUsername(value);
  if (username.length < 3 || String(value || "").trim().toLowerCase() !== username) {
    throw requestError("ADMIN_USERNAME_INVALID", 400);
  }
  return username;
}

function validEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw requestError("ADMIN_EMAIL_INVALID", 400);
  return email;
}

function adminUserView(row) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    name: row.display_name,
    role: row.system_role,
    status: row.status,
    authSource: row.auth_source,
    oidcLinkPending: row.oidc_link_pending === true,
    createdAt: toMillis(row.created_at),
    lastLoginAt: row.last_login_at ? toMillis(row.last_login_at) : null,
    disabledAt: row.disabled_at ? toMillis(row.disabled_at) : null,
  };
}

const ADMIN_USER_FIELDS =
  "id, username, email, display_name, system_role, status, auth_source, oidc_link_pending, created_at, last_login_at, disabled_at";

async function adminListUsers(req, res, url) {
  const term = normalizeSearch(url.searchParams.get("q"));
  const clauses = [];
  const params = [];
  if (term) {
    params.push(`%${term}%`);
    clauses.push(`(LOWER(username) LIKE $${params.length} OR LOWER(email) LIKE $${params.length} OR LOWER(display_name) LIKE $${params.length})`);
  }
  const statusFilter = url.searchParams.get("status");
  if (isAccountStatus(statusFilter)) {
    params.push(statusFilter);
    clauses.push(`status = $${params.length}`);
  }
  const roleFilter = url.searchParams.get("role");
  if (isSystemRole(roleFilter)) {
    params.push(roleFilter);
    clauses.push(`system_role = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await db.query(
    `SELECT ${ADMIN_USER_FIELDS} FROM users ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  json(res, 200, { users: rows.map(adminUserView) });
}

async function adminCreateUser(req, res, actor) {
  const body = await readBody(req);
  const username = validAdminUsername(body.username);
  const email = validEmail(body.email);
  const displayName = String(body.name || "").trim().slice(0, 190) || username;
  const role = body.role == null ? "regular" : String(body.role);
  if (!isSystemRole(role)) throw requestError("ADMIN_ROLE_INVALID", 400);

  const id = uuidv7();
  const password = crypto.randomBytes(18).toString("base64url");
  try {
    await db.query(
      `INSERT INTO users (id, username, email, display_name, system_role, password_hash, auth_source, password_change_required)
       VALUES ($1, $2, $3, $4, $5, $6, 'local', TRUE)`,
      [id, username, email, displayName, role, await hashPassword(password)]
    );
  } catch (err) {
    if (err.code === "23505") throw requestError("ADMIN_USER_EXISTS", 409);
    throw err;
  }
  await audit({
    ...sessionActor(req, actor),
    action: "user.created",
    targetType: "user",
    targetId: id,
    metadata: { username, role, authSource: "local" },
  });
  const { rows } = await db.query(`SELECT ${ADMIN_USER_FIELDS} FROM users WHERE id = $1`, [id]);
  json(res, 201, { user: adminUserView(rows[0]), temporaryPassword: password });
}

async function adminUpdateUser(req, res, actor, targetId) {
  const body = await readBody(req);
  const wantsRole = body.role != null;
  const wantsStatus = body.status != null;
  const nextRole = wantsRole ? String(body.role) : null;
  const nextStatus = wantsStatus ? String(body.status) : null;
  if (wantsRole && !isSystemRole(nextRole)) throw requestError("ADMIN_ROLE_INVALID", 400);
  if (wantsStatus && !isUserStatus(nextStatus)) throw requestError("ADMIN_STATUS_INVALID", 400);
  const nextEmail = body.email != null ? validEmail(body.email) : null;
  const nextName = body.name != null ? (String(body.name).trim().slice(0, 190) || null) : null;
  const nextUsername = body.username != null ? validAdminUsername(body.username) : null;
  const nextLinkPending = typeof body.oidcLinkPending === "boolean" ? body.oidcLinkPending : null;

  const client = await db.connect();
  let before;
  let after;
  let demotedProjects = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_INVARIANT_LOCK]);
    const current = await client.query(
      "SELECT id, username, email, display_name, system_role, status, auth_source, oidc_link_pending FROM users WHERE id = $1 FOR UPDATE",
      [targetId]
    );
    if (!current.rows.length) throw requestError("ADMIN_USER_NOT_FOUND", 404);
    before = current.rows[0];

    // Protect the last active admin: any change that would drop the active-admin
    // count to zero is refused, whoever requests it.
    if (wantsRole || wantsStatus) {
      const others = await client.query(
        "SELECT COUNT(*) AS n FROM users WHERE system_role = 'admin' AND status = 'active' AND id <> $1",
        [targetId]
      );
      const wouldStrand = leavesNoActiveAdmin(
        before,
        { system_role: nextRole ?? undefined, status: nextStatus ?? undefined },
        Number(others.rows[0].n)
      );
      if (wouldStrand) throw requestError("ADMIN_LAST_ADMIN", 409);
    }

    // Turning an account external strips whatever it owns, because ownership is
    // the one project role an external may not hold. Where someone else owns the
    // project too the membership simply drops to editor — an owner remains, so the
    // invariant is untouched — but a project this user owns alone would be left
    // with none, and that is refused here and resolved in the projects console,
    // exactly like deleting such an account.
    if (wantsRole && nextRole === "external" && before.system_role !== "external") {
      const owned = await client.query(
        "SELECT project_id FROM project_members WHERE user_id = $1 AND role = 'owner' ORDER BY project_id",
        [targetId]
      );
      // Every affected project is locked, in a fixed order, so a concurrent
      // membership change cannot slip between the count and the demotion and two
      // of these can never deadlock against each other.
      for (const row of owned.rows) {
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, row.project_id]);
      }
      const stranded = await soleOwnerProjects(targetId, client);
      if (stranded.length) {
        throw requestError("ADMIN_EXTERNAL_SOLE_OWNER", 409, { projects: stranded.map((p) => p.name).join(", ") });
      }
      const stripped = await client.query(
        `UPDATE project_members SET role = 'editor', updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND role = 'owner' RETURNING project_id`,
        [targetId]
      );
      demotedProjects = stripped.rows.map((row) => String(row.project_id));
    }

    const sets = ["updated_at = CURRENT_TIMESTAMP"];
    const params = [];
    const add = (fragment, value) => { params.push(value); sets.push(fragment.replace("?", `$${params.length}`)); };
    if (nextUsername) add("username = ?", nextUsername);
    if (nextLinkPending !== null) add("oidc_link_pending = ?", nextLinkPending);
    if (nextName) add("display_name = ?", nextName);
    if (nextEmail) add("email = ?", nextEmail);
    if (wantsRole) add("system_role = ?", nextRole);
    if (wantsStatus) {
      add("status = ?", nextStatus);
      sets.push(nextStatus === "disabled" ? "disabled_at = CURRENT_TIMESTAMP" : "disabled_at = NULL");
    }
    // Profile/role changes keep sessions; disabling revokes them even if the
    // account is re-enabled in the same second.
    if (wantsStatus && nextStatus === "disabled") {
      sets.push("session_version = session_version + 1", "session_epoch = CURRENT_TIMESTAMP");
    }
    params.push(targetId);
    try {
      await client.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
    } catch (err) {
      if (err.code === "23505") throw requestError("ADMIN_USER_EXISTS", 409);
      throw err;
    }
    const updated = await client.query(`SELECT ${ADMIN_USER_FIELDS} FROM users WHERE id = $1`, [targetId]);
    after = updated.rows[0];
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (wantsStatus && nextStatus === "disabled") collabRevokeUser(targetId);
  if (nextUsername && nextUsername !== before.username) {
    await audit({ ...sessionActor(req, actor), action: "user.username_changed", targetType: "user", targetId, metadata: { from: before.username, to: nextUsername } });
  }
  if (nextLinkPending !== null && nextLinkPending !== before.oidc_link_pending) {
    await audit({ ...sessionActor(req, actor), action: "user.oidc_link_window", targetType: "user", targetId, metadata: { enabled: nextLinkPending } });
  }
  if (wantsRole && nextRole !== before.system_role) {
    await audit({ ...sessionActor(req, actor), action: "user.role_changed", targetType: "user", targetId, metadata: { from: before.system_role, to: nextRole } });
  }
  if (wantsStatus && nextStatus !== before.status) {
    // Approving an account the identity provider provisioned is not the same event
    // as lifting a suspension, and the audit trail should not have to guess which
    // one an active/disabled pair meant.
    const approved = before.status === "pending" && nextStatus === "active";
    await audit({
      ...sessionActor(req, actor),
      action: approved ? "user.approved" : "user.status_changed",
      targetType: "user",
      targetId,
      metadata: { from: before.status, to: nextStatus },
    });
  }
  // Ownership the role change stripped. Reported per project so the trail reads
  // the same as any other role change, and pushed to open sessions so a workspace
  // already open loses its owner tools at once.
  for (const projectId of demotedProjects) {
    await audit({
      ...sessionActor(req, actor),
      action: "project.member_role_changed",
      targetType: "membership",
      targetId: projectId,
      metadata: { userId: targetId, from: "owner", to: "editor", reason: "external" },
    });
    await collabRecheckProject(projectId);
  }
  json(res, 200, { user: adminUserView(after) });
}

async function adminResetPassword(req, res, actor, targetId) {
  const { rows } = await db.query("SELECT id, username, auth_source, session_version FROM users WHERE id = $1", [targetId]);
  if (!rows.length) throw requestError("ADMIN_USER_NOT_FOUND", 404);
  if (rows[0].auth_source !== "local") throw requestError("ADMIN_NOT_LOCAL_ACCOUNT", 400);
  const password = crypto.randomBytes(18).toString("base64url");
  // Bump the version so the account's existing sessions end at once, and require a
  // change on next login so the temporary password is genuinely one-time.
  const updated = await db.query(
    `UPDATE users SET password_hash = $1, password_change_required = TRUE,
       session_version = session_version + 1, session_epoch = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND auth_source = 'local' AND session_version = $3`,
    [await hashPassword(password), targetId, rows[0].session_version]
  );
  if (!updated.rowCount) throw requestError("ADMIN_NOT_LOCAL_ACCOUNT", 400);
  collabRevokeUser(targetId);
  await audit({ ...sessionActor(req, actor), action: "user.password_reset", targetType: "user", targetId });
  json(res, 200, { ok: true, temporaryPassword: password });
}

// Undo an SSO conversion (or linking): the account reverts to a local one with a
// fresh one-time password. It drops the durable identity so a re-link starts
// clean, and bumps the version so any live SSO session ends at once.
async function adminUnlinkSso(req, res, actor, targetId) {
  const { rows } = await db.query("SELECT id, username, oidc_subject, auth_source, session_version FROM users WHERE id = $1", [targetId]);
  if (!rows.length) throw requestError("ADMIN_USER_NOT_FOUND", 404);
  if (!rows[0].oidc_subject || rows[0].auth_source !== "oidc") throw requestError("ADMIN_NOT_LINKED", 400);
  const password = crypto.randomBytes(18).toString("base64url");
  const updated = await db.query(
    `UPDATE users SET auth_source = 'local', oidc_issuer = NULL, oidc_subject = NULL,
       oidc_linked_at = NULL, oidc_link_pending = FALSE, password_hash = $1,
       password_change_required = TRUE, session_version = session_version + 1,
       session_epoch = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND auth_source = 'oidc' AND session_version = $3 AND oidc_subject = $4`,
    [await hashPassword(password), targetId, rows[0].session_version, rows[0].oidc_subject]
  );
  if (!updated.rowCount) throw requestError("ADMIN_NOT_LINKED", 400);
  collabRevokeUser(targetId);
  await audit({ ...sessionActor(req, actor), action: "user.oidc_unlinked", targetType: "user", targetId });
  json(res, 200, { ok: true, temporaryPassword: password });
}

// ---------------------------------------------------------------------------
// Admin project console. Server admins manage project membership, roles and the
// existence of any project — an explicit, audited exceptional power — but gain
// no access to project *contents*: none of these handlers reads or serves source
// files. Content stays gated by project membership, keeping the two authorities
// (server role vs project role) separate.
// ---------------------------------------------------------------------------

async function adminProjectRow(projectId, queryable = db) {
  const { rows } = await queryable.query("SELECT id, name, storage_path FROM projects WHERE id = $1", [projectId]);
  if (!rows.length) throw requestError("PROJECT_NOT_FOUND", 404);
  return rows[0];
}

// Lists every project on the server with its members and roles, flagging any that
// have no owner (orphaned) so the admin can recover them. Optional `q` filters by
// name; `filter=orphaned` narrows to ownerless projects.
async function adminListProjects(req, res, url) {
  const term = normalizeSearch(url.searchParams.get("q"));
  const onlyOrphaned = url.searchParams.get("filter") === "orphaned";
  const params = [];
  let where = "";
  if (term) { params.push(`%${term}%`); where = "WHERE LOWER(p.name) LIKE $1"; }
  const { rows: projects } = await db.query(
    `SELECT p.id, p.name, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
            (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id AND m.role = 'owner') AS owner_count
     FROM projects p ${where} ORDER BY p.updated_at DESC, p.id`,
    params
  );
  const ids = projects.map((p) => p.id);
  const membersByProject = new Map();
  if (ids.length) {
    const { rows: members } = await db.query(
      `SELECT m.project_id, m.user_id, m.role, u.username, u.email, u.display_name, u.status, u.system_role
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ANY($1) ORDER BY (m.role <> 'owner'), u.username`,
      [ids]
    );
    for (const m of members) {
      if (!membersByProject.has(m.project_id)) membersByProject.set(m.project_id, []);
      membersByProject.get(m.project_id).push({
        userId: m.user_id, username: m.username, name: m.display_name, email: m.email, role: m.role, status: m.status,
        external: m.system_role === "external",
      });
    }
  }
  let list = projects.map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: toMillis(p.created_at),
    updatedAt: toMillis(p.updated_at),
    memberCount: Number(p.member_count),
    ownerCount: Number(p.owner_count),
    orphaned: Number(p.owner_count) === 0,
    members: membersByProject.get(p.id) || [],
  }));
  if (onlyOrphaned) list = list.filter((p) => p.orphaned);
  json(res, 200, { projects: list });
}

async function adminAddProjectMember(req, res, actor, projectId) {
  await adminProjectRow(projectId);
  const body = await readBody(req);
  const role = String(body.role || "");
  if (!isProjectRole(role)) throw requestError("MEMBER_ROLE_INVALID", 400);
  const target = await insertProjectMembership(req, actor, projectId, { identifier: body.identifier, role }, true);
  await audit({
    ...sessionActor(req, actor),
    action: "project.shared",
    targetType: "membership",
    targetId: projectId,
    metadata: { userId: target.id, username: target.username, role, via: "admin" },
  });
  await collabRecheckProject(projectId);
  json(res, 201, {
    member: memberView({ user_id: target.id, username: target.username, email: target.email, display_name: target.display_name, system_role: target.system_role, role, invited_by: actor.sub, created_at: new Date() }),
  });
}

async function adminUpdateProjectMember(req, res, actor, projectId, memberId) {
  await adminProjectRow(projectId);
  const body = await readBody(req);
  const nextRole = String(body.role || "");
  if (!isProjectRole(nextRole)) throw requestError("MEMBER_ROLE_INVALID", 400);
  let previousRole;
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockSharingUsers(client, actor.sub);
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    const current = await client.query(
      `SELECT m.role, u.system_role
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
      [projectId, memberId]
    );
    await authorizeSharingRequester(req, actor, projectId, "admin", client);
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
    requireGrantableRole(current.rows[0].system_role, nextRole);
    previousRole = current.rows[0].role;
    const others = await client.query(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner' AND user_id <> $2",
      [projectId, memberId]
    );
    if (leavesNoOwner(previousRole, nextRole, Number(others.rows[0].n))) throw requestError("PROJECT_LAST_OWNER", 409);
    await client.query(
      "UPDATE project_members SET role = $3, updated_at = CURRENT_TIMESTAMP WHERE project_id = $1 AND user_id = $2",
      [projectId, memberId, nextRole]
    );
    requireSharingSessionUnexpired(actor);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (nextRole !== previousRole) {
    await audit({
      ...sessionActor(req, actor),
      action: "project.member_role_changed",
      targetType: "membership",
      targetId: projectId,
      metadata: { userId: memberId, from: previousRole, to: nextRole, via: "admin" },
    });
  }
  await collabRecheckProject(projectId);
  json(res, 200, { ok: true });
}

async function adminRemoveProjectMember(req, res, actor, projectId, memberId) {
  await adminProjectRow(projectId);
  const client = await db.connect();
  let removed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockSharingUsers(client, actor.sub);
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    const current = await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE",
      [projectId, memberId]
    );
    await authorizeSharingRequester(req, actor, projectId, "admin", client);
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
    const others = await client.query(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner' AND user_id <> $2",
      [projectId, memberId]
    );
    if (leavesNoOwner(current.rows[0].role, null, Number(others.rows[0].n))) throw requestError("PROJECT_LAST_OWNER", 409);
    await client.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, memberId]);
    removed = true;
    requireSharingSessionUnexpired(actor);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (removed) {
    await audit({
      ...sessionActor(req, actor),
      action: "project.unshared",
      targetType: "membership",
      targetId: projectId,
      metadata: { userId: memberId, via: "admin" },
    });
  }
  await collabRecheckProject(projectId);
  json(res, 200, { ok: true });
}

async function adminDeleteProject(req, res, actor, projectId) {
  const row = await projectMutations.gate(projectId, async () => {
    const row = await adminProjectRow(projectId);
    const storageDir = resolveProjectStorageDir(DATA_DIR, row.storage_path);
    await projectMutations.transaction({ id: projectId, storageDir, deleting: true }, async (client, protect) => {
      await protect();
      await client.query("DELETE FROM projects WHERE id = $1", [projectId]);
    });
    collabReconcileProject(projectId);
    return row;
  });
  await audit({
    ...sessionActor(req, actor),
    action: "project.deleted",
    targetType: "project",
    targetId: projectId,
    metadata: { name: row.name, via: "admin" },
  });
  json(res, 200, { ok: true });
}

// The projects for which the user is the *only* owner. Deleting the user would
// strand these (membership cascades away), and so would turning them external
// (ownership is stripped), so both resolve them in the project console first.
// Other memberships and co-owned projects are unaffected. Takes a client so the
// external check can run inside the transaction that holds the project locks.
async function soleOwnerProjects(userId, client = null) {
  const { rows } = await (client || db).query(
    `SELECT p.id, p.name
     FROM projects p
     JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 AND m.role = 'owner'
     WHERE NOT EXISTS (
       SELECT 1 FROM project_members o WHERE o.project_id = p.id AND o.role = 'owner' AND o.user_id <> $1
     )
     ORDER BY p.name`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

async function adminUserDeletionPreview(req, res, actor, userId) {
  const { rows } = await db.query("SELECT id, username, status FROM users WHERE id = $1", [userId]);
  if (!rows.length) throw requestError("ADMIN_USER_NOT_FOUND", 404);
  json(res, 200, {
    user: { id: rows[0].id, username: rows[0].username, status: rows[0].status },
    isSelf: rows[0].id === actor.sub,
    soleOwnerProjects: await soleOwnerProjects(userId),
  });
}

// Physical, irreversible deletion — distinct from the reversible disable. Guarded
// against self-deletion, deleting a still-active account, and stranding a project
// whose only owner is this user (those are resolved in the project console). The
// row is then hard-deleted: the schema cascades memberships and sessions and nulls
// authorship, while denormalised labels keep revisions and the audit trail
// readable, so attribution outlives the account.
async function adminDeleteUser(req, res, actor, userId) {
  const { rows } = await db.query("SELECT id, username, system_role, status FROM users WHERE id = $1", [userId]);
  if (!rows.length) throw requestError("ADMIN_USER_NOT_FOUND", 404);
  const target = rows[0];
  const body = await readBody(req);
  const soleOwnerProjectCount = (await soleOwnerProjects(userId)).length;
  const block = userDeletionBlock({ isSelf: target.id === actor.sub, status: target.status, soleOwnerProjectCount });
  if (block === "self") throw requestError("ADMIN_CANNOT_DELETE_SELF", 409);
  if (block === "not_disabled") throw requestError("ADMIN_DELETE_REQUIRES_DISABLED", 409);
  if (block === "sole_owner") throw requestError("ADMIN_DELETE_SOLE_OWNER", 409);
  if (String(body.confirmation || "") !== target.username) throw requestError("ADMIN_DELETE_CONFIRMATION", 400);
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
  collabRevokeUser(userId);
  await audit({
    ...sessionActor(req, actor),
    action: "user.deleted",
    targetType: "user",
    targetId: userId,
    metadata: { username: target.username, role: target.system_role },
  });
  json(res, 200, { ok: true });
}

function decodeAdminTemplateId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw requestError("ADMIN_TEMPLATE_ID_INVALID", 400);
  }
}

async function adminListTemplates(req, res) {
  json(res, 200, { templates: await listAdminProjectTemplates(TEMPLATE_DIR) }, { "cache-control": "private, no-store" });
}

async function adminCreateTemplate(req, res, actor) {
  const template = await createProjectTemplate(TEMPLATE_DIR, await readBody(req));
  await audit({
    ...sessionActor(req, actor),
    action: "template.created",
    targetType: "system",
    targetId: `${template.type}:${template.id}`,
    metadata: { type: template.type, id: template.id, title: template.title, size: template.size, default: template.default },
  });
  json(res, 201, { template });
}

async function adminGetTemplate(req, res, type, encodedId) {
  const template = await getAdminProjectTemplate(TEMPLATE_DIR, type, decodeAdminTemplateId(encodedId));
  json(res, 200, { template }, { "cache-control": "private, no-store" });
}

async function adminUpdateTemplate(req, res, actor, type, encodedId) {
  const previousId = decodeAdminTemplateId(encodedId);
  const template = await updateProjectTemplate(TEMPLATE_DIR, type, previousId, await readBody(req));
  await audit({
    ...sessionActor(req, actor),
    action: "template.updated",
    targetType: "system",
    targetId: `${template.type}:${template.id}`,
    metadata: {
      type: template.type,
      id: template.id,
      title: template.title,
      size: template.size,
      default: template.default,
      previousType: type,
      previousId,
    },
  });
  json(res, 200, { template });
}

async function adminDeleteTemplate(req, res, actor, type, encodedId) {
  const id = decodeAdminTemplateId(encodedId);
  await deleteProjectTemplate(TEMPLATE_DIR, type, id);
  await audit({
    ...sessionActor(req, actor),
    action: "template.deleted",
    targetType: "system",
    targetId: `${type}:${id}`,
    metadata: { type, id },
  });
  json(res, 200, { ok: true });
}

async function handleAdminApi(req, res, url, actor) {
  requireAdmin(actor);
  if (url.pathname === ADMIN_TEMPLATES_ROUTE) {
    if (req.method === "GET") return adminListTemplates(req, res);
    if (req.method === "POST") return adminCreateTemplate(req, res, actor);
  }
  const adminTemplateMatch = url.pathname.match(ADMIN_TEMPLATE_ROUTE);
  if (adminTemplateMatch) {
    if (req.method === "GET") return adminGetTemplate(req, res, adminTemplateMatch[1], adminTemplateMatch[2]);
    if (req.method === "PUT") return adminUpdateTemplate(req, res, actor, adminTemplateMatch[1], adminTemplateMatch[2]);
    if (req.method === "DELETE") return adminDeleteTemplate(req, res, actor, adminTemplateMatch[1], adminTemplateMatch[2]);
  }
  if (url.pathname === ADMIN_PROJECTS_ROUTE && req.method === "GET") return adminListProjects(req, res, url);
  const adminProjectMemberMatch = url.pathname.match(ADMIN_PROJECT_MEMBER_ROUTE);
  if (adminProjectMemberMatch && req.method === "PATCH") return adminUpdateProjectMember(req, res, actor, adminProjectMemberMatch[1], adminProjectMemberMatch[2]);
  if (adminProjectMemberMatch && req.method === "DELETE") return adminRemoveProjectMember(req, res, actor, adminProjectMemberMatch[1], adminProjectMemberMatch[2]);
  const adminProjectMembersMatch = url.pathname.match(ADMIN_PROJECT_MEMBERS_ROUTE);
  if (adminProjectMembersMatch && req.method === "POST") return adminAddProjectMember(req, res, actor, adminProjectMembersMatch[1]);
  const adminProjectMatch = url.pathname.match(ADMIN_PROJECT_ROUTE);
  if (adminProjectMatch && req.method === "DELETE") return adminDeleteProject(req, res, actor, adminProjectMatch[1]);
  const deletionPreviewMatch = url.pathname.match(ADMIN_USER_DELETION_PREVIEW_ROUTE);
  if (deletionPreviewMatch && req.method === "GET") return adminUserDeletionPreview(req, res, actor, deletionPreviewMatch[1]);
  if (url.pathname === ADMIN_USERS_ROUTE) {
    if (req.method === "GET") return adminListUsers(req, res, url);
    if (req.method === "POST") return adminCreateUser(req, res, actor);
  }
  const resetMatch = url.pathname.match(ADMIN_USER_RESET_ROUTE);
  if (resetMatch && req.method === "POST") return adminResetPassword(req, res, actor, resetMatch[1]);
  const unlinkMatch = url.pathname.match(ADMIN_USER_UNLINK_ROUTE);
  if (unlinkMatch && req.method === "POST") return adminUnlinkSso(req, res, actor, unlinkMatch[1]);
  const userMatch = url.pathname.match(ADMIN_USER_ROUTE);
  if (userMatch && req.method === "PATCH") return adminUpdateUser(req, res, actor, userMatch[1]);
  if (userMatch && req.method === "DELETE") return adminDeleteUser(req, res, actor, userMatch[1]);
  errorJson(res, 404, "ENDPOINT_NOT_FOUND");
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      compile: {
        texPath: TEX_BIN_PATH,
        texPathLocked: TEX_PATH_LOCKED,
        lilypondPath: LILYPOND_BIN_PATH,
        lilypondPathLocked: LILYPOND_PATH_LOCKED,
      },
      auth: {
        ssoEnabled: oauthEnabled(),
        ssoAutoRegister: OAUTH_AUTO_REGISTER,
        ssoApprovalRequired: OAUTH_AUTO_REGISTER && OAUTH_APPROVAL_REQUIRED,
      },
      collab: {
        pushDebounceMs: COLLAB_PUSH_DEBOUNCE_MS,
        presenceDebounceMs: COLLAB_PRESENCE_DEBOUNCE_MS,
      },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/sso/start") {
    if (!oauthEnabled()) return text(res, 503, "SSO is not configured");
    try {
      const endpoints = await oauthEndpoints();
      const state = oauthStateToken();
      const authUrl = new URL(endpoints.authorizationEndpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", oauthRedirectUri(req));
      authUrl.searchParams.set("scope", OAUTH_SCOPE);
      authUrl.searchParams.set("state", state);
      return redirect(res, authUrl.toString(), {
        "set-cookie": cookie("iris_oauth_state", state, { maxAge: 10 * 60 }),
      });
    } catch (err) {
      return text(res, 503, err.message || "SSO unavailable");
    }
  }

  if (req.method === "GET" && url.pathname === "/api/auth/sso/callback") {
    const clearState = cookie("iris_oauth_state", "", { maxAge: 0 });
    try {
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const expectedState = parseCookies(req).iris_oauth_state;
      if (!code || !state || !expectedState || !timingSafeStringEqual(state, expectedState) || !verifySignedJson(state)) {
        throw new Error("Invalid OAuth state");
      }
      const token = await oauthTokenRequest(code, oauthRedirectUri(req));
      const profile = await oauthUserInfo(token.access_token);
      const user = await userFromOAuthProfile(profile, clientIp(req));
      await audit({
        action: "auth.login_succeeded",
        actorId: user.id,
        actorLabel: user.username,
        ip: clientIp(req),
        targetType: "user",
        targetId: user.id,
        metadata: { authMethod: "sso" },
      });
      return redirect(res, "/", {
        "set-cookie": [
          clearState,
          cookie("iris_session", makeToken(user, "sso"), { maxAge: 60 * 60 * 24 * 7 }),
        ],
      });
    } catch (err) {
      console.error("SSO callback failed", err.message || err);
      await audit({
        action: "auth.login_failed",
        outcome: "failure",
        actorLabel: "unknown",
        ip: clientIp(req),
        targetType: "user",
        metadata: { authMethod: "sso", reason: err.message || "sso_error" },
      });
      const authError = err.authError || "sso";
      return redirect(res, `/?auth_error=${authError}`, { "set-cookie": clearState });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    // Charged before the body is even read: reading up to MAX_BODY from a
    // caller that is already over its allowance is work done on behalf of
    // someone who has been refused. Everything after this point — parsing, the
    // user lookup, and above all Argon2 — is downstream of it.
    const ip = clientIp(req) || "unknown";
    enforceRateLimit(authIpLimiter, `login:${ip}`, "AUTH_RATE_LIMITED");
    const body = await readBody(req);
    const login = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!login || !password) return errorJson(res, 400, "AUTH_REQUIRED_FIELDS");
    // The per-account limit needs the submitted identifier, so it comes second.
    // The address limit stops one source; this one stops many sources
    // converging on a single account, which is the shape a distributed
    // credential-stuffing run has. Keying on what was submitted rather than on
    // a resolved user id is deliberate: an attacker must not be able to tell a
    // throttled unknown account from a throttled real one, and an unknown
    // account has no id to key on anyway.
    // Bound retained key size even when an invalid submitted identifier is long.
    const loginKey = `login:${crypto.createHash("sha256").update(login).digest("hex")}`;
    enforceRateLimit(authAccountLimiter, loginKey, "AUTH_RATE_LIMITED");
    const { rows } = await db.query(
      "SELECT id, username, email, display_name, system_role, status, auth_source, session_version, password_hash, password_change_required, oidc_linked_at FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) LIMIT 1",
      [login, login]
    );
    const user = rows[0];
    // Every refusal below is also a rate-limit event: an attempt that failed
    // costs the caller more of its allowance than one that succeeded, so a
    // guessing run runs out of budget while a person who mistyped does not.
    const failedLogin = async (reason) => {
      authIpLimiter.penalize(`login:${ip}`, Date.now(), AUTH_FAILURE_PENALTY - 1);
      authAccountLimiter.penalize(loginKey, Date.now(), AUTH_FAILURE_PENALTY - 1);
      return audit({
        action: "auth.login_failed",
        outcome: "failure",
        actorId: user ? user.id : null,
        actorLabel: user ? user.username : login,
        ip: clientIp(req),
        targetType: "user",
        targetId: user ? user.id : null,
        metadata: { authMethod: "local", reason },
      });
    };
    if (user && !user.password_hash) {
      // An account converted from local to SSO gets a specific message; one that
      // was always SSO gets the generic "use the SSO button" guidance.
      const converted = !!user.oidc_linked_at;
      await failedLogin(converted ? "converted_to_sso" : "sso_account");
      return errorJson(res, 401, converted ? "AUTH_CONVERTED_TO_SSO" : "AUTH_SSO_ACCOUNT");
    }
    const passwordCheck = user ? await verifyPassword(password, user.password_hash) : { valid: false, needsRehash: false };
    if (!user || !passwordCheck.valid) {
      await failedLogin(user ? "invalid_password" : "unknown_account");
      return errorJson(res, 401, "AUTH_INVALID_CREDENTIALS");
    }
    // A disabled account is refused only after the password is verified, so the
    // response does not reveal which accounts exist. An account still waiting for
    // approval is told so instead: it has never had access to lose.
    if (user.status !== "active") {
      const pending = user.status === "pending";
      await failedLogin(pending ? "account_pending" : "account_disabled");
      return errorJson(res, 403, pending ? "AUTH_ACCOUNT_PENDING" : "AUTH_ACCOUNT_DISABLED");
    }
    if (passwordCheck.needsRehash) {
      const passwordHash = await hashPassword(password);
      // Rehash only the credentials we verified, never a concurrent reset.
      await db.query(
        `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND session_version = $3 AND password_hash = $4 AND status = 'active' AND auth_source = 'local'`,
        [passwordHash, user.id, user.session_version, user.password_hash]
      );
    }
    // Proving the password clears the debt: someone who got in is not an
    // attacker, and leaving them throttled would punish the two typos that
    // preceded the correct attempt.
    authIpLimiter.reset(`login:${ip}`);
    authAccountLimiter.reset(loginKey);
    await db.query("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1", [user.id]);
    await audit({
      action: "auth.login_succeeded",
      actorId: user.id,
      actorLabel: user.username,
      ip: clientIp(req),
      targetType: "user",
      targetId: user.id,
      metadata: { authMethod: "local" },
    });
    return json(res, 200, { user: publicUser(user) }, {
      "set-cookie": cookie("iris_session", makeToken(user, "local"), { maxAge: 60 * 60 * 24 * 7 }),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/password") {
    const sessionUser = await requireUser(req);
    if (sessionUser.authMethod !== "local") {
      return errorJson(res, 403, "PASSWORD_LOCAL_LOGIN_REQUIRED");
    }
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!currentPassword || !newPassword) return errorJson(res, 400, "PASSWORD_REQUIRED_FIELDS");
    if (newPassword.length < 10) return errorJson(res, 400, "PASSWORD_TOO_SHORT");
    if (currentPassword === newPassword) return errorJson(res, 400, "PASSWORD_MUST_DIFFER");

    const { rows } = await db.query(
      "SELECT id, username, email, display_name, system_role, status, auth_source, session_version, password_hash FROM users WHERE id = $1 LIMIT 1",
      [sessionUser.sub]
    );
    const user = rows[0];
    if (!user || !user.password_hash || user.auth_source !== "local") {
      return errorJson(res, 403, "PASSWORD_SSO_ACCOUNT");
    }
    const passwordCheck = await verifyPassword(currentPassword, user.password_hash);
    if (!passwordCheck.valid) return errorJson(res, 401, "PASSWORD_CURRENT_INCORRECT");

    const passwordHash = await hashPassword(newPassword);
    const updated = await db.query(
      `UPDATE users SET password_hash = $1, password_change_required = FALSE,
         session_version = session_version + 1, session_epoch = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND session_version = $3 AND password_hash = $4 AND status = 'active' AND auth_source = 'local'
       RETURNING id, username, email, display_name, system_role, auth_source, session_version, password_change_required`,
      [passwordHash, user.id, sessionUser.sessionVersion, user.password_hash]
    );
    if (!updated.rows.length) return errorJson(res, 401, "NOT_AUTHENTICATED");
    collabRevokeUser(user.id);
    const replacement = updated.rows[0];
    await audit({
      ...sessionActor(req, sessionUser),
      action: "user.password_changed",
      targetType: "user",
      targetId: user.id,
    });
    return json(res, 200, { ok: true, user: publicUser({ ...replacement, authMethod: "local" }) }, {
      "set-cookie": cookie("iris_session", makeToken(replacement, "local"), { maxAge: 60 * 60 * 24 * 7 }),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    return json(res, 200, { ok: true }, { "set-cookie": cookie("iris_session", "", { maxAge: 0 }) });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/session") {
    const user = await requireUser(req);
    return json(res, 200, { user: publicUser(user) });
  }

  const user = await requireUser(req);

  // A ceiling on authenticated traffic, keyed on the account rather than the
  // address so it follows the caller across networks and cannot be shed by
  // reconnecting. It sits far above what the editor generates in normal use;
  // what it catches is a client stuck in a retry loop and a session token being
  // used as a battering ram against the database.
  enforceRateLimit(apiLimiter, `api:${user.sub}`, "API_RATE_LIMITED");

  // A pending forced password change blocks every other authed endpoint until the
  // temporary password is replaced. The login/password/logout/session routes are
  // handled above, before this gate, so the account can still complete the change.
  if (user.passwordChangeRequired) return errorJson(res, 403, "PASSWORD_CHANGE_REQUIRED");

  if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(req, res, url, user);

  if (req.method === "POST" && url.pathname === "/api/account/username") {
    const body = await readBody(req);
    const nextUsername = validAdminUsername(body.username);
    const { rows } = await db.query(
      "SELECT id, username, email, display_name, system_role, status, auth_source, session_version, password_hash FROM users WHERE id = $1 LIMIT 1",
      [user.sub]
    );
    const row = rows[0];
    if (!row || row.status !== "active" || row.session_version !== user.sessionVersion) return errorJson(res, 401, "NOT_AUTHENTICATED");
    if (nextUsername === row.username) return json(res, 200, { user: publicUser({ ...row, authMethod: user.authMethod }) });
    // Step-up: a local account must re-enter its password to change the username;
    // an SSO account has no local secret, so the live session is the proof.
    if (row.password_hash) {
      const currentPassword = String(body.currentPassword || "");
      if (!currentPassword) return errorJson(res, 400, "ACCOUNT_REAUTH_REQUIRED");
      const check = await verifyPassword(currentPassword, row.password_hash);
      if (!check.valid) return errorJson(res, 401, "PASSWORD_CURRENT_INCORRECT");
    }
    try {
      const updated = await db.query(
        "UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND session_version = $3 AND status = 'active'",
        [nextUsername, user.sub, user.sessionVersion]
      );
      if (!updated.rowCount) return errorJson(res, 401, "NOT_AUTHENTICATED");
    } catch (err) {
      if (err.code === "23505") return errorJson(res, 409, "ADMIN_USER_EXISTS");
      throw err;
    }
    await audit({ ...sessionActor(req, user), action: "user.username_changed", targetType: "user", targetId: user.sub, metadata: { from: row.username, to: nextUsername, self: true } });
    row.username = nextUsername;
    // Re-issue the session cookie so the token's username claim stays current.
    return json(res, 200, { user: publicUser({ ...row, authMethod: user.authMethod }) }, {
      "set-cookie": cookie("iris_session", makeToken(row, user.authMethod), { maxAge: 60 * 60 * 24 * 7 }),
    });
  }

  const projectTemplateMatch = url.pathname.match(PROJECT_TEMPLATE_FILE_ROUTE);
  if (projectTemplateMatch && req.method === "GET") return getProjectTemplate(req, res, projectTemplateMatch[1], projectTemplateMatch[2]);
  if (req.method === "GET" && url.pathname === "/api/project-templates") return listProjectTemplates(req, res);
  if (req.method === "GET" && url.pathname === "/api/projects") return listProjects(req, res, user);
  if (req.method === "POST" && url.pathname === "/api/projects/import") return importProjectArchive(req, res, user, url);
  if (req.method === "POST" && url.pathname === "/api/projects") return createProject(req, res, user);

  const compileMatch = url.pathname.match(PROJECT_COMPILE_ROUTE);
  if (compileMatch && req.method === "POST") return compileProject(req, res, user, compileMatch[1]);

  const buildArtifactMatch = url.pathname.match(PROJECT_BUILD_ARTIFACT_ROUTE);
  if (buildArtifactMatch && req.method === "GET") {
    return downloadBuildArtifact(
      req, res, user, buildArtifactMatch[1], buildArtifactMatch[2], buildArtifactMatch[3], url
    );
  }

  const buildFileMatch = url.pathname.match(PROJECT_BUILD_FILE_ROUTE);
  if (buildFileMatch && req.method === "GET") {
    return downloadBuildFile(req, res, user, buildFileMatch[1], buildFileMatch[2], url);
  }

  const buildArchiveMatch = url.pathname.match(PROJECT_BUILD_ARCHIVE_ROUTE);
  if (buildArchiveMatch && req.method === "GET") {
    return downloadBuildArchive(req, res, user, buildArchiveMatch[1], buildArchiveMatch[2]);
  }

  const buildMatch = url.pathname.match(PROJECT_BUILD_ROUTE);
  if (buildMatch) {
    if (req.method === "GET") return getBuildOutput(req, res, user, buildMatch[1], buildMatch[2]);
    if (req.method === "DELETE") return deleteBuildOutput(req, res, user, buildMatch[1], buildMatch[2]);
  }

  const buildsMatch = url.pathname.match(PROJECT_BUILDS_ROUTE);
  if (buildsMatch && req.method === "GET") return listBuildOutputs(req, res, user, buildsMatch[1], url);

  const archiveMatch = url.pathname.match(PROJECT_ARCHIVE_ROUTE);
  if (archiveMatch && req.method === "GET") return downloadProjectArchive(req, res, user, archiveMatch[1]);

  const fileDownloadMatch = url.pathname.match(PROJECT_FILE_ROUTE);
  if (fileDownloadMatch && req.method === "GET") return downloadProjectFile(req, res, user, fileDownloadMatch[1], url);

  const memberSearchMatch = url.pathname.match(PROJECT_MEMBER_SEARCH_ROUTE);
  if (memberSearchMatch && req.method === "GET") return searchProjectMembers(req, res, user, memberSearchMatch[1], url);

  const memberMatch = url.pathname.match(PROJECT_MEMBER_ROUTE);
  if (memberMatch) {
    if (req.method === "PATCH") return updateProjectMember(req, res, user, memberMatch[1], memberMatch[2]);
    if (req.method === "DELETE") return removeProjectMember(req, res, user, memberMatch[1], memberMatch[2]);
  }

  const membersMatch = url.pathname.match(PROJECT_MEMBERS_ROUTE);
  if (membersMatch) {
    if (req.method === "GET") return listProjectMembers(req, res, user, membersMatch[1]);
    if (req.method === "POST") return addProjectMember(req, res, user, membersMatch[1]);
  }

  const checkpointMatch = url.pathname.match(PROJECT_CHECKPOINT_ROUTE);
  if (checkpointMatch && req.method === "POST") return checkpointProject(req, res, user, checkpointMatch[1]);

  const versionRestoreMatch = url.pathname.match(FILE_VERSION_RESTORE_ROUTE);
  if (versionRestoreMatch && req.method === "POST") {
    return restoreFileVersion(req, res, user, versionRestoreMatch[1], versionRestoreMatch[2], versionRestoreMatch[3]);
  }

  const versionMatch = url.pathname.match(FILE_VERSION_ROUTE);
  if (versionMatch && req.method === "GET") {
    return getFileVersion(req, res, user, versionMatch[1], versionMatch[2], versionMatch[3]);
  }

  const versionsMatch = url.pathname.match(FILE_VERSIONS_ROUTE);
  if (versionsMatch && req.method === "GET") {
    return listFileVersions(req, res, user, versionsMatch[1], versionsMatch[2]);
  }

  const match = url.pathname.match(PROJECT_ROUTE);
  if (match) {
    if (req.method === "GET") return getProject(req, res, user, match[1]);
    if (req.method === "PUT") return updateProject(req, res, user, match[1]);
    if (req.method === "DELETE") return deleteProject(req, res, user, match[1]);
  }

  errorJson(res, 404, "ENDPOINT_NOT_FOUND");
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/Iris.html";
  if (pathname === "/templates" || pathname.startsWith("/templates/")) return text(res, 404, "Not found");
  const codemirrorFile = pathname.match(/^\/vendor\/codemirror\/([a-z0-9.-]+)$/);
  if (codemirrorFile && !CODEMIRROR_MODULES[codemirrorFile[1]]) return text(res, 404, "Not found");
  const pdfjsFile = pathname.match(/^\/vendor\/pdfjs\/(pdf(?:\.worker)?\.min\.mjs)$/);
  const root = pdfjsFile ? PDFJS_BUILD_DIR : PUBLIC_DIR;
  const relativePath = pdfjsFile ? pdfjsFile[1] : `.${pathname}`;
  const filePath = codemirrorFile
    ? CODEMIRROR_MODULES[codemirrorFile[1]]
    : path.resolve(root, relativePath);
  if (!codemirrorFile && !filePath.startsWith(root + path.sep)) return text(res, 403, "Forbidden");
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return text(res, 404, "Not found");
  const ext = path.extname(filePath).toLowerCase();
  const body = await fs.readFile(filePath);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": body.length,
  });
  res.end(body);
}

function healthPayload() {
  const active = maintenanceActive();
  return {
    status: healthStatus({ shuttingDown, maintenance: active }),
    maintenance: active,
    pendingWrites: inFlightMutations + backgroundPending.size + collabPendingWrites() + (collabDrainPromise ? 1 : 0),
  };
}

function parseRequestUrl(req) {
  // Validate Host separately so it cannot influence route resolution.
  requestAuthority(req);
  return new URL(req.url, "http://localhost");
}

async function handle(req, res) {
  let url;
  try {
    url = parseRequestUrl(req);
  } catch {
    return text(res, 400, "Bad request", { connection: "close" });
  }
  inFlight += 1;
  // Counted only once the request passes the gate, so refused mutations during a
  // maintenance window do not appear as pending writes the operator waits on.
  let countedWrite = false;
  try {
    if (url.pathname === HEALTH_PATH) return json(res, 200, healthPayload());

    const gate = lifecycleGate({
      method: req.method,
      pathname: url.pathname,
      shuttingDown,
      maintenance: maintenanceActive(),
    });
    if (gate) {
      if (url.pathname.startsWith("/api/")) return errorJson(res, gate.status, gate.code);
      return text(res, gate.status, gate.code === "MAINTENANCE_MODE" ? "Iris is in maintenance" : "Iris is shutting down");
    }

    if (url.pathname.startsWith("/api/") && isMutatingMethod(req.method)) {
      // Header refusals precede authentication, body reads and accepted-write
      // accounting. Connection:close finishes the response and closes even an
      // incomplete unread body; accepted requests retain normal keep-alive.
      if (!isRequestOriginAllowed(req, { appBaseUrl: APP_BASE_URL, trustProxy: TRUST_PROXY })) {
        return errorJson(res, 403, "REQUEST_ORIGIN_FORBIDDEN", {}, { connection: "close" });
      }
      const rawImport = req.method === "POST" && url.pathname === "/api/projects/import";
      if (!rawImport && !isJsonMediaAllowed(req)) {
        return errorJson(res, 415, "REQUEST_CONTENT_TYPE_UNSUPPORTED", {}, { connection: "close" });
      }
    }

    if (isWriteRequest(req.method, url.pathname)) {
      countedWrite = true;
      inFlightMutations += 1;
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method not allowed");
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    if (url.pathname.startsWith("/api/")) {
      return errorJson(res, status, err.errorCode || "SERVER_ERROR", err.params || {}, err.headers || {});
    }
    return text(res, status, err.message || "Server error", err.headers || {});
  } finally {
    // The operation owns its slot through body/queue waits, audit, compensation
    // and post-response cleanup. A disconnected client does not cancel its work.
    inFlight -= 1;
    if (countedWrite) inFlightMutations -= 1;
  }
}

function startGracefulShutdown(signal, server) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  console.log(`Received ${signal}; refusing new work and draining in-flight requests`);
  clearInterval(retentionSweepTimer);
  clearInterval(maintenancePoll);
  // Callers queued for a slot they will now never get are told so, rather than
  // being left holding a request open until the process exits under them.
  compileGate.drain("COMPILE_SERVER_BUSY");
  passwordHashGate.drain("AUTH_BUSY");
  server.close(() => {});
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();

  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Shutdown deadline exceeded")), SHUTDOWN_TIMEOUT_MS);
  });
  const drain = async () => {
    await collabShutdown();
    while (inFlight > 0 || backgroundPending.size || collabPendingWrites() || activeChildren.size) {
      if (shutdownForced) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
      await drainCollabWrites();
    }
    if (!shutdownForced) await db.end();
  };
  shutdownPromise = Promise.race([drain(), timeout]).then(() => {
    console.log("Shutdown complete");
    process.exit(0);
  }, (err) => {
    shutdownForced = true;
    console.error("Shutdown failed; durable state was not fully drained", err);
    for (const child of activeChildren) {
      try { child.kill("SIGKILL"); } catch {}
    }
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    collabSessions.forEach((session) => session.socket.terminate());
    process.exit(1);
  }).finally(() => clearTimeout(timer));
  return shutdownPromise;
}

if (require.main === module) initDb()
  .then(() => {
    const server = http.createServer(handle);
    collabAttach(server);
    startRetentionSweep();
    process.on("SIGTERM", () => startGracefulShutdown("SIGTERM", server));
    process.on("SIGINT", () => startGracefulShutdown("SIGINT", server));
    server.listen(...(BIND_ADDRESS ? [PORT, BIND_ADDRESS] : [PORT]), () => {
      console.log(`Iris listening on http://${BIND_ADDRESS || "localhost"}:${PORT}`);
      console.log(`Static files dir: ${PUBLIC_DIR}`);
      console.log(`Projects data dir: ${DATA_DIR}`);
      console.log(`Project templates dir: ${TEMPLATE_DIR}`);
      if (initialAdminCredentials) {
        console.log("");
        console.log("================================================================");
        console.log("Iris initial admin account created");
        console.log(`Username: ${initialAdminCredentials.username}`);
        console.log(`Password: ${initialAdminCredentials.password}`);
        console.log("Save this password now: it will not be shown again.");
        console.log("================================================================");
        console.log("");
      }
    });
  })
  .catch((err) => {
    console.error("Unable to start Iris backend");
    console.error(err);
    process.exit(1);
  });

module.exports = {
  handle,
  applyCollabAuthority,
  collabAttach,
  collabRooms,
  runRetentionSweep,
  reconcileStalledBuilds,
  pruneProjectBuilds,
  pruneProjectVersions,
  pruneAuditEvents,
  projectRetention,
  writeProjectFile,
  readProjectFile,
  hydrateProjectPayloads,
  buildProjectArchive,
  collectProjectArchiveEntries,
  parseProjectArchive,
  reconcileProjectFonts,
  fileKindForPath,
  inferProjectType,
  findCompileFile,
  normalizeCompileProfile,
  sanitizeCompileProfileForStorage,
  parseCompileArguments,
  sanitizeLilypondArgsForStorage,
  sanitizeMainPathForStorage,
  normalizeLilypondFormat,
  safeProjectSourcePath,
  validateProjectSourceTree,
  syncNodesWithFilesystem,
  resolveProjectFile,
  readCompileArtifacts,
  runCompilePipeline,
  parseCompileLog,
  buildOutputView,
};
