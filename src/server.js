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
const { lifecycleGate, healthStatus, isMutatingMethod, HEALTH_PATH } = require("./lifecycle");
const { recordAuditEvent } = require("./audit");
const { collectProjectFiles, reconcileProjectFiles } = require("./project-files");
const { hashContent, isVersionableText, contentChanged } = require("./versions");
const { CollabRooms, CollabError, peerColor, normalizePresence } = require("./collab");
const { isSystemRole, isUserStatus, leavesNoActiveAdmin, normalizeSearch, userDeletionBlock } = require("./admin");
const {
  isProjectRole,
  roleHasCapability,
  leavesNoOwner,
  normalizeMemberSearch,
  escapeLikePattern,
} = require("./project-access");
const { projectStorageKey, resolveProjectStorageDir, relocateProjectStorage } = require("./project-storage");
const { createZip, extractZip } = require("./zip");
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
// How long a graceful shutdown waits for in-flight requests before forcing the
// remaining connections closed.
const SHUTDOWN_TIMEOUT_MS = positiveIntEnv("SHUTDOWN_TIMEOUT_MS", 15000);
const MAX_BODY = Number(process.env.MAX_BODY_MB || 25) * 1024 * 1024;
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 30000);
const COMPILE_LOG_LIMIT = Number(process.env.COMPILE_LOG_LIMIT || 1024 * 1024);
const BUILD_ARCHIVE_MAX_BYTES = positiveIntEnv("BUILD_ARCHIVE_MAX_MB", 128) * 1024 * 1024;
const BUILD_ARCHIVE_MAX_ENTRIES = positiveIntEnv("BUILD_ARCHIVE_MAX_ENTRIES", 10000);
const PROJECT_ARCHIVE_MAX_BYTES = positiveIntEnv("PROJECT_ARCHIVE_MAX_MB", 256) * 1024 * 1024;
const PROJECT_ARCHIVE_MAX_ENTRIES = positiveIntEnv("PROJECT_ARCHIVE_MAX_ENTRIES", 20000);
const ARGON2_MEMORY_COST = positiveIntEnv("ARGON2_MEMORY_COST", 65536);
const ARGON2_TIME_COST = positiveIntEnv("ARGON2_TIME_COST", 3);
const ARGON2_PARALLELISM = positiveIntEnv("ARGON2_PARALLELISM", 1);
const APP_BASE_URL = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
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
  "lezer-common.js": path.join(path.dirname(require.resolve("@lezer/common")), "index.js"),
  "lezer-highlight.js": path.join(path.dirname(require.resolve("@lezer/highlight")), "index.js"),
  "style-mod.js": path.join(path.dirname(require.resolve("style-mod")), "..", "src", "style-mod.js"),
  "w3c-keyname.js": path.join(path.dirname(require.resolve("w3c-keyname")), "index.js"),
  "crelt.js": path.join(path.dirname(require.resolve("crelt")), "..", "index.js"),
  "find-cluster-break.js": path.join(path.dirname(require.resolve("@marijn/find-cluster-break")), "..", "src", "index.js"),
};

let db;
let oauthDiscoveryCache = null;
let initialAdminCredentials = null;
let shuttingDown = false;
let inFlight = 0;
let inFlightMutations = 0;
const activeBuilds = new Set();

// Cheap, synchronous check on the mutation path, which is far rarer than reads.
function maintenanceActive() {
  return fsSync.existsSync(MAINTENANCE_FILE);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function requestError(errorCode, status, params = {}) {
  const err = new Error(errorCode);
  err.errorCode = errorCode;
  err.status = status;
  err.params = params;
  return err;
}

function errorJson(res, status, errorCode, params = {}) {
  return json(res, status, { errorCode, ...(Object.keys(params).length ? { params } : {}) });
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
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function makeToken(user, authMethod = "local") {
  const payload = {
    sub: String(user.id),
    username: user.username,
    name: user.display_name,
    email: user.email,
    role: user.system_role || user.role || "regular",
    authMethod,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  return signedJson(payload);
}

function verifyToken(token) {
  const payload = verifySignedJson(token);
  if (!payload || !payload.exp) return null;
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

async function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

async function verifyPassword(password, stored) {
  const hash = String(stored || "");
  if (!hash.startsWith("$argon2")) return { valid: false, needsRehash: false };
  try {
    const valid = await argon2.verify(hash, password);
    return {
      valid,
      needsRehash: valid && argon2.needsRehash(hash, ARGON2_OPTIONS),
    };
  } catch {
    return { valid: false, needsRehash: false };
  }
}

function oauthEnabled() {
  return !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && (OAUTH_ISSUER_URL || (OAUTH_AUTHORIZATION_URL && OAUTH_TOKEN_URL && OAUTH_USERINFO_URL)));
}

function requestBaseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
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
  "id, username, email, display_name, system_role, status, auth_source, oidc_issuer, oidc_subject, oidc_link_pending, session_epoch, password_hash";

function disabledAccountError() {
  const err = new Error("Account disabled");
  err.status = 403;
  err.errorCode = "AUTH_ACCOUNT_DISABLED";
  return err;
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

async function userFromOAuthProfile(profile, ip = null) {
  const issuer = OAUTH_ISSUER_URL || null;
  const subject = profile.subject || null;
  // SSO cannot be enabled without an issuer, and oauthUserInfo already rejects an
  // empty subject; the pair is the only identity used to match an account.
  if (!issuer || !subject) throw new Error("SSO profile is missing a durable identity");

  const byOidc = await db.query(
    `SELECT ${OAUTH_USER_COLUMNS} FROM users WHERE oidc_issuer = $1 AND oidc_subject = $2 LIMIT 1`,
    [issuer, subject]
  );
  const existing = byOidc.rows[0] || null;

  if (existing) {
    if (existing.status !== "active") throw disabledAccountError();
    const nextName = profile.name || existing.display_name;
    if (nextName && nextName !== existing.display_name) {
      await db.query("UPDATE users SET display_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [nextName, existing.id]);
      existing.display_name = nextName;
    }
    return existing;
  }

  // No durable-identity match. Email is never used to silently adopt an account:
  // if it belongs to an existing one, the identity is bound only through an
  // admin-opened one-time linking window, after which the account is SSO-only.
  const byEmail = await db.query(
    `SELECT ${OAUTH_USER_COLUMNS} FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [profile.email]
  );
  const emailMatch = byEmail.rows[0] || null;
  if (emailMatch) {
    if (emailMatch.status !== "active") throw disabledAccountError();
    // Email already bound to a different SSO identity → refuse (email reuse).
    if (emailMatch.oidc_issuer && emailMatch.oidc_subject) {
      throw new Error("This email is already linked to a different SSO identity");
    }
    if (!emailMatch.oidc_link_pending) throw ssoLinkRequiredError();
    await db.query(
      `UPDATE users SET oidc_issuer = $1, oidc_subject = $2, auth_source = 'oidc',
         password_hash = NULL, oidc_link_pending = FALSE, oidc_linked_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [issuer, subject, emailMatch.id]
    );
    await audit({
      action: "user.oidc_linked",
      actorId: emailMatch.id,
      actorLabel: emailMatch.username,
      ip,
      targetType: "user",
      targetId: emailMatch.id,
      metadata: { issuer },
    });
    emailMatch.oidc_issuer = issuer;
    emailMatch.oidc_subject = subject;
    emailMatch.auth_source = "oidc";
    emailMatch.password_hash = null;
    return emailMatch;
  }

  if (!OAUTH_AUTO_REGISTER) {
    const err = new Error("Unauthorized SSO user");
    err.status = 403;
    throw err;
  }

  const username = await availableUsername(profile.preferredUsername || profile.email);
  const displayName = profile.name || profile.email;
  try {
    const result = await db.query(
      `INSERT INTO users (id, username, email, display_name, system_role, password_hash, auth_source, oidc_issuer, oidc_subject)
       VALUES ($1, $2, $3, $4, 'regular', NULL, 'oidc', $5, $6) RETURNING id`,
      [uuidv7(), username, profile.email, displayName, issuer, subject]
    );
    const id = String(result.rows[0].id);
    await audit({
      action: "user.created",
      actorId: id,
      actorLabel: username,
      ip,
      targetType: "user",
      targetId: id,
      metadata: { authSource: "oidc", autoRegistered: true, email: profile.email },
    });
    return { id, username, email: profile.email, display_name: displayName, system_role: "regular", status: "active", auth_source: "oidc", password_hash: null };
  } catch (err) {
    if (err.code !== "23505") throw err;
    const retry = await db.query(
      `SELECT ${OAUTH_USER_COLUMNS} FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [profile.email]
    );
    if (retry.rows[0]) {
      if (retry.rows[0].status !== "active") throw disabledAccountError();
      return retry.rows[0];
    }
    throw err;
  }
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
// disabled account, a bumped session epoch (a forced sign-out or password reset)
// or a role change is honoured on the very next request rather than lingering
// until the token expires.
async function requireUser(req) {
  const token = parseCookies(req).iris_session;
  const payload = verifyToken(token);
  if (!payload) throw requestError("NOT_AUTHENTICATED", 401);

  const { rows } = await db.query(
    "SELECT id, username, email, display_name, system_role, status, auth_source, session_epoch, password_change_required FROM users WHERE id = $1 LIMIT 1",
    [payload.sub]
  );
  const row = rows[0];
  if (!row || row.status !== "active") throw requestError("NOT_AUTHENTICATED", 401);
  const epochSeconds = Math.floor(new Date(row.session_epoch).getTime() / 1000);
  if (typeof payload.iat === "number" && payload.iat < epochSeconds) throw requestError("NOT_AUTHENTICATED", 401);

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

function dataUrlMime(value) {
  const match = String(value || "").match(/^data:([^;,]+)?[;,]/);
  return match && match[1] ? match[1] : "application/octet-stream";
}

function mimeForProjectFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".tex", ".ly", ".ily", ".bib", ".bst", ".bbx", ".cbx", ".lbx", ".txt", ".sty", ".cls", ".md", ".log", ".aux", ".bbl", ".blg", ".idx", ".ilg", ".ind", ".out", ".toc", ".bcf", ".fls", ".fdb_latexmk"].includes(ext)) return "text/plain; charset=utf-8";
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
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(filePath)) return "img";
  if (/\.(pdf|ps|eps|aux|bbl|bcf|blg|idx|ilg|ind|log|out|toc|run\.xml|fls|fdb_latexmk)$/i.test(filePath)) return "artifact";
  return "file";
}

// Bibliography styles (bst for BibTeX, bbx/cbx/lbx for biblatex) are plain text
// like any other source: a project that carries its own style keeps it editable
// and versioned instead of stored as an opaque payload.
function fileIsTextPath(filePath) {
  return /\.(tex|ly|ily|bib|bst|bbx|cbx|lbx|txt|sty|cls|md|csv|dat|scm|lua|json|ya?ml|log|aux|bbl|blg|idx|ilg|ind|out|toc|xml|bcf|fls|fdb_latexmk)$/i.test(filePath || "");
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
      } else if (!await fs.stat(abs).then(() => true, () => false)) {
        // A source node without content means the client is not writing this
        // file: it never edited it in this session. The bytes on disk stay, so a
        // save can no longer overwrite a collaborator's newer text with the copy
        // this client happened to load. A file that does not exist yet is still
        // created, from the upload payload when the client sent one, so a text
        // file attached as a data URL lands as its decoded text.
        const dataUrl = node.data || assets[rel] || assets[node.path];
        await fs.writeFile(abs, dataUrl == null ? "" : dataUrlToBuffer(dataUrl));
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
        const content = await fs.readFile(path.join(storagePath, rel), "utf8").catch(() => null);
        if (content != null) node.content = content;
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
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.toLowerCase() === ".iris") continue;
      if (!relBase && entry.name.toLowerCase() === "output") continue;
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkDir(abs, rel);
        const rest = await fs.readdir(abs).catch(() => []);
        if (!rest.length) await fs.rmdir(abs).catch(() => {});
      } else if (!expectedFiles.has(rel)) {
        await fs.unlink(abs).catch(() => {});
      }
    }
  }
  await walkDir(storagePath);
}

async function buildFsNode(storagePath, relPath, entry, generated, textHint = false) {
  const abs = path.join(storagePath, relPath);
  if (entry.isDirectory()) {
    const children = await scanFsTree(storagePath, relPath, generated);
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
      node.content = await fs.readFile(abs, "utf8").catch(() => "");
    }
    else {
      const buf = await fs.readFile(abs).catch(() => null);
      if (buf) {
        node.binary = true;
        node.encoding = "base64";
        node.data = `data:${mimeForProjectFile(relPath)};base64,${buf.toString("base64")}`;
      }
    }
  }
  return node;
}

async function scanFsTree(storagePath, relBase = "", generated = false) {
  const absBase = path.join(storagePath, relBase);
  const entries = await fs.readdir(absBase, { withFileTypes: true }).catch(() => []);
  const nodes = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isIgnoredProjectFsEntry(entry.name)) continue;
    if (!relBase && entry.name.toLowerCase() === "output") continue;
    const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
    nodes.push(await buildFsNode(storagePath, rel, entry, generated));
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

async function syncNodesWithFilesystem(storagePath, data) {
  if (!data.project) data.project = { nodes: [] };
  data.project.nodes = stripGeneratedNodes(data.project.nodes);

  const merge = async (nodes, relBase = "") => {
    const absBase = path.join(storagePath, relBase);
    const entries = await fs.readdir(absBase, { withFileTypes: true }).catch(() => []);
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
          synced.push(await buildFsNode(storagePath, rel, entry, false));
        }
      } else if (node.type === "folder") {
        synced.push(await buildFsNode(storagePath, rel, entry, false));
      } else {
        const textHint = node.encoding === "utf8" || (node.content != null && !fileIsBinaryNode(node));
        const hydrated = await buildFsNode(storagePath, rel, entry, false, textHint);
        synced.push({
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
        });
      }
    }

    const known = new Set(synced.map((node) => node.name));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredProjectFsEntry(entry.name)) continue;
      if (!relBase && entry.name.toLowerCase() === "output") continue;
      if (known.has(entry.name)) continue;
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      synced.push(await buildFsNode(storagePath, rel, entry, false));
    }
    return synced;
  };

  data.project.nodes = await merge(data.project.nodes, "");
}

async function readProjectFile(storagePath) {
  const metaFile = path.join(storagePath, ".iris", "project.json");
  const legacyFile = path.join(storagePath, "project.json");
  let data;
  let legacy = false;
  try {
    data = JSON.parse(await fs.readFile(metaFile, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    legacy = true;
    data = JSON.parse(await fs.readFile(legacyFile, "utf8"));
  }
  data = data || {};
  if (!data.project) data.project = { nodes: [] };
  data.assets = data.assets || {};
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
      if (fileIsBinaryNode(node)) {
        const buf = await fs.readFile(abs).catch(() => null);
        if (buf) {
          const mime = legacy && node.data ? dataUrlMime(node.data) : mimeForProjectFile(rel);
          const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
          node.data = dataUrl;
          data.assets[rel] = dataUrl;
        } else if (legacy && node.data) {
          data.assets[rel] = node.data;
        }
      } else {
        const content = await fs.readFile(abs, "utf8").catch(() => null);
        if (content != null) node.content = content;
        else if (!legacy) node.content = "";
      }
    }
  };
  await hydrate(data.project.nodes);
  await syncNodesWithFilesystem(storagePath, data);
  data.projectType = inferProjectType(data);
  reconcileProjectFonts(data);
  const hydratedFonts = [];
  for (const font of data.fonts) {
    const buf = await fs.readFile(path.join(storagePath, font.path)).catch(() => null);
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
  await fs.writeFile(tmp, JSON.stringify(stripFilePayloads(data), null, 2), "utf8");
  await fs.rename(tmp, file);
}

// Moves the bytes of renamed or relocated files on disk before the tree is
// written, so a rename preserves the file instead of deleting and recreating it.
// A pure optimization over the delete-plus-create path: on any obstacle it does
// nothing and lets writeProjectNodes/pruneProjectFiles produce the same result
// they did before, so it can never lose data the old path would have kept.
async function applyProjectRenames(storagePath, renames) {
  const moves = (renames || []).filter((move) => move.from !== move.to);
  if (!moves.length) return;
  const sources = new Set(moves.map((move) => move.from));
  for (const move of moves) {
    // Skip the pathological chain or swap where the destination is itself a file
    // still waiting to move; delete-plus-create handles those exactly as before.
    if (sources.has(move.to)) continue;
    const src = path.join(storagePath, move.from);
    const dest = path.join(storagePath, move.to);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
    } catch (err) {
      // Source not on disk yet, or any other obstacle: fall back silently to the
      // normal write path. ENOENT is the common, expected case for a new file.
      if (err.code !== "ENOENT") {
        console.error(`Could not relocate ${move.from} -> ${move.to} in ${storagePath}`, err.message || err);
      }
    }
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
  await fs.rm(path.join(storagePath, "project.json"), { force: true }).catch(() => {});
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

// The single authorization chokepoint for a project. Membership is the authority:
// a non-member cannot tell the project apart from one that does not exist (404),
// while a member who lacks the capability for this action is told plainly (403).
// The caller receives the project row, its resolved storage directory and the
// requester's role. A permission change takes effect at once because this runs on
// every request, exactly like the per-request account check in requireUser.
async function authorizeProject(id, user, capability) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.storage_path, p.created_at, p.updated_at, m.role
     FROM projects p JOIN project_members m ON m.project_id = p.id
     WHERE p.id = $1 AND m.user_id = $2`,
    [id, user.sub]
  );
  if (!rows.length) throw requestError("PROJECT_NOT_FOUND", 404);
  const row = rows[0];
  if (!roleHasCapability(row.role, capability)) throw requestError("PROJECT_FORBIDDEN", 403);
  return { ...withStorageDir(row), role: row.role };
}

async function listProjects(req, res, user) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.storage_path, p.created_at, p.updated_at, m.role
     FROM projects p JOIN project_members m ON m.project_id = p.id
     WHERE m.user_id = $1 ORDER BY p.updated_at DESC`,
    [user.sub]
  );
  const projects = await Promise.all(rows.map(async (row) => {
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
      createdAt: toMillis(row.created_at),
      updatedAt: toMillis(row.updated_at),
      fileCount,
      projectType,
    };
  }));
  json(res, 200, { projects });
}

// Serializes owner-invariant changes per project, so concurrent role changes on
// the same project cannot race past the last-owner check.
const PROJECT_OWNER_LOCK = 4952;

// Sharing targets accounts that already exist. The UI resolves a partial search
// to an immutable user id; exact username/email remains available to admin flows.
// Pending invitations for strangers are a later evolution.
async function resolveMemberUser(identifier, userId = null, activeOnly = false) {
  const value = String(identifier || "").trim();
  if (!userId && !value) throw requestError("MEMBER_IDENTIFIER_REQUIRED", 400);
  if (userId && !isUuid(userId)) throw requestError("MEMBER_USER_NOT_FOUND", 404);
  const where = userId
    ? `id = $1${activeOnly ? " AND status = 'active'" : ""}`
    : `(LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))${activeOnly ? " AND status = 'active'" : ""}`;
  const { rows } = await db.query(
    `SELECT id, username, email, display_name FROM users WHERE ${where} LIMIT 1`,
    [userId || value]
  );
  if (!rows.length) throw requestError("MEMBER_USER_NOT_FOUND", 404);
  return rows[0];
}

async function searchProjectMembers(req, res, user, projectId, url) {
  await authorizeProject(projectId, user, "share");
  const query = normalizeMemberSearch(url.searchParams.get("q"));
  if (!query) return json(res, 200, { users: [] });
  const pattern = `%${escapeLikePattern(query.toLowerCase())}%`;
  const { rows } = await db.query(
    `SELECT u.id AS user_id, u.username, u.email, u.display_name
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
    })),
  });
}

function memberView(row) {
  return {
    userId: row.user_id,
    username: row.username,
    name: row.display_name,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by || null,
    createdAt: toMillis(row.created_at),
  };
}

async function listProjectMembers(req, res, user, projectId) {
  await authorizeProject(projectId, user, "share");
  const { rows } = await db.query(
    `SELECT m.user_id, m.role, m.invited_by, m.created_at, u.username, u.email, u.display_name
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
  const target = await resolveMemberUser(body && body.identifier, body && body.userId, true);
  try {
    await db.query(
      "INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)",
      [projectId, target.id, role, user.sub]
    );
  } catch (err) {
    if (err.code === "23505") throw requestError("MEMBER_ALREADY", 409);
    throw err;
  }
  await audit({
    ...sessionActor(req, user),
    action: "project.shared",
    targetType: "membership",
    targetId: projectId,
    metadata: { userId: target.id, username: target.username, role },
  });
  await collabRecheckProject(projectId);
  json(res, 201, {
    member: memberView({ user_id: target.id, username: target.username, email: target.email, display_name: target.display_name, role, invited_by: user.sub, created_at: new Date() }),
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
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    const current = await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE",
      [projectId, memberId]
    );
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
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
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    const current = await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE",
      [projectId, memberId]
    );
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
    const others = await client.query(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner' AND user_id <> $2",
      [projectId, memberId]
    );
    if (leavesNoOwner(current.rows[0].role, null, Number(others.rows[0].n))) throw requestError("PROJECT_LAST_OWNER", 409);
    await client.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, memberId]);
    removed = true;
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
  const row = await authorizeProject(id, user, "read");
  const data = await readProjectFile(row.storageDir);
  if (!data.project) data.project = { name: row.name, nodes: [] };
  data.project.name = row.name;
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = toMillis(row.updated_at);
  json(res, 200, { id: row.id, ...data, role: row.role });
}

// Reconciles the file-identity ledger against the tree about to be written and
// stamps each source file node with its canonical UUIDv7 id, so the persisted
// manifest carries the stable identity. Runs before the manifest is written; it
// tracks identity only and never moves files on disk.
async function syncProjectFiles(projectId, data) {
  const nodes = data && data.project && Array.isArray(data.project.nodes) ? data.project.nodes : [];
  const entries = collectProjectFiles(nodes);
  const incoming = entries.map((entry) => ({ nodeId: entry.nodeId, path: entry.path, kind: entry.kind }));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT id, client_ref, path, kind FROM project_files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at, id FOR UPDATE",
      [projectId]
    );
    const plan = reconcileProjectFiles(rows, incoming, { generateId: uuidv7 });
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
    await client.query("COMMIT");
    entries.forEach((entry, index) => { entry.node.id = plan.resolved[index].canonicalId; });
    // Renames the disk layer can carry out as a move instead of delete+create.
    return { renames: plan.updates.filter((u) => u.fromPath !== u.path).map((u) => ({ from: u.fromPath, to: u.path })) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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

// Resolves the exact revision for the on-disk content, inserting it when changed.
// Unversionable content has no revision and is represented by null.
async function snapshotFileIfChanged({ storageDir, file, user, reason }, queryable = db) {
  const buffer = await fs.readFile(path.join(storageDir, file.path)).catch(() => null);
  if (!isVersionableText(buffer, file.kind)) return null;
  const content = buffer.toString("utf8");
  const previous = await latestVersion(file.id, queryable);
  if (!contentChanged(previous ? previous.content_hash : null, hashContent(content))) {
    return { id: previous.id, created: false };
  }
  const id = await insertVersion(
    { fileId: file.id, parentId: previous ? previous.id : null, user, reason, content },
    queryable
  );
  return { id, created: true };
}

// A project checkpoint is serialized so concurrent compilations cannot fork a
// file's revision chain. It also returns the exact revision used for each file.
async function captureProjectCheckpoint({ projectId, storageDir, user, reason, files: checkpointFiles = null }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
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
      const version = await snapshotFileIfChanged({ storageDir, file, user, reason }, client);
      if (version && version.created) created += 1;
      versions.set(file.id, version ? version.id : null);
    }
    await client.query("COMMIT");
    return { created, versions };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
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

async function fileForProject(projectId, fileId) {
  const { rows } = await db.query(
    "SELECT id, path, kind, deleted_at FROM project_files WHERE id = $1 AND project_id = $2",
    [fileId, projectId]
  );
  if (!rows.length) throw requestError("FILE_NOT_FOUND", 404);
  return rows[0];
}

async function checkpointProject(req, res, user, id) {
  const row = await authorizeProject(id, user, "write");
  const body = await readBody(req);
  // Persist the editor state first when provided, so the checkpoint reflects it.
  if (body.data && typeof body.data === "object") {
    const data = body.data;
    data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
    data.project.name = row.name;
    data.projectType = inferProjectType(data);
    validateProjectSourceTree(data);
    const { renames } = await syncProjectFiles(id, data);
    applyCollabAuthority(id, data);
    await writeProjectFile(row.storageDir, data, renames);
    await db.query("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
  }
  const { created } = await captureProjectCheckpoint({ projectId: id, storageDir: row.storageDir, user, reason: "manual" });
  await audit({
    ...sessionActor(req, user),
    action: "revision.checkpoint",
    targetType: "project",
    targetId: id,
    metadata: { reason: "manual", created },
  });
  json(res, 200, { ok: true, created });
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
  const project = await authorizeProject(projectId, user, "write");
  const file = await fileForProject(projectId, fileId);
  if (file.deleted_at) throw requestError("FILE_NOT_FOUND", 404);
  const { rows } = await db.query(
    "SELECT id, content, content_hash FROM document_versions WHERE id = $1 AND file_id = $2",
    [versionId, fileId]
  );
  if (!rows.length) throw requestError("VERSION_NOT_FOUND", 404);
  const target = rows[0];

  // Capture the current state before overwriting it, so a rollback never loses
  // uncommitted work, then append the rollback revision. History is only added to.
  await snapshotFileIfChanged({ storageDir: project.storageDir, file, user, reason: "manual" });
  const abs = path.join(project.storageDir, file.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, target.content, "utf8");
  // A rollback replaces the text outside the update stream, so anyone editing
  // this file in realtime is moved onto the restored content instead of carrying
  // on from a version that no longer exists.
  collabResetFile(fileId, target.content);
  const previous = await latestVersion(fileId);
  const newVersionId = await insertVersion({
    fileId,
    parentId: previous ? previous.id : null,
    user,
    reason: "rollback",
    content: target.content,
  });
  await db.query("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [projectId]);
  await audit({
    ...sessionActor(req, user),
    action: "revision.restored",
    targetType: "revision",
    targetId: newVersionId,
    metadata: { fileId, fromVersion: versionId, path: file.path },
  });
  json(res, 200, { ok: true, versionId: newVersionId, content: target.content });
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

const collabRooms = new CollabRooms();
const collabSessions = new Set();
let collabHeartbeat = null;

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
  if (!isUuid(fileId)) throw new CollabError("COLLAB_BAD_FILE");
  if (session.rooms.has(fileId)) return session.rooms.get(fileId);
  const { rows } = await db.query(
    "SELECT id, project_id, path, kind, deleted_at FROM project_files WHERE id = $1",
    [fileId]
  );
  const file = rows[0];
  // A non-member must not be able to tell an existing file from a missing one.
  if (!file || file.deleted_at) throw new CollabError("COLLAB_FILE_NOT_FOUND");
  const project = await collabMembership(file.project_id, session.user.sub);
  if (!project) throw new CollabError("COLLAB_FILE_NOT_FOUND");
  if (file.kind === "img" || file.kind === "font") throw new CollabError("COLLAB_NOT_TEXT");

  const existing = collabRooms.get(fileId);
  // Only the first participant reads from disk; later joins take the in-memory
  // text, which is newer than anything on disk.
  const content = existing ? existing.text() : await fs.readFile(path.join(project.storageDir, file.path), "utf8").catch(() => "");
  const room = collabRooms.open({ fileId, projectId: file.project_id, path: file.path, content });
  room.storageDir = project.storageDir;
  room.kind = file.kind || null;
  room.clients.add(session);
  session.rooms.set(fileId, { room, role: project.role, projectId: file.project_id });
  return session.rooms.get(fileId);
}

function collabLeave(session, fileId) {
  const entry = session.rooms.get(fileId);
  if (!entry) return;
  session.rooms.delete(fileId);
  const room = entry.room;
  room.clients.delete(session);
  if (room.clients.size) return void collabBroadcastPeers(room);
  clearTimeout(room.flushTimer);
  clearTimeout(room.revisionTimer);
  // Last one out persists the document and records the consolidated revision
  // before the room — and with it the authoritative text — is released. The room
  // is only dropped if nobody rejoined while the write was in flight.
  collabTrack(collabPersist(room, { revision: true }).then(() => {
    if (!room.clients.size) collabRooms.close(room.fileId);
  }));
}

// Tracks in-flight persistence so shutdown can wait for it.
const collabPending = new Set();
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
async function collabPersist(room, { revision = false } = {}) {
  if (room.persisting) {
    room.persisting = room.persisting.then(() => collabPersistNow(room, revision));
    return room.persisting;
  }
  room.persisting = collabPersistNow(room, revision).finally(() => { room.persisting = null; });
  return room.persisting;
}

async function collabPersistNow(room, revision) {
  if (!room.storageDir) return;
  if (room.needsPersist()) {
    const version = room.version;
    const text = room.text();
    const abs = path.join(room.storageDir, room.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, "utf8");
    room.markPersisted(version);
    room.flushDeadline = 0;
    await db.query("UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = $1", [room.projectId]);
  }
  if (!revision || !room.needsRevision()) return;
  const version = room.version;
  // The revision is attributed to whoever made the most recent accepted edit.
  const author = room.lastAuthor || null;
  if (!author) return;
  await captureProjectCheckpoint({
    projectId: room.projectId,
    storageDir: room.storageDir,
    user: author,
    reason: "realtime",
    files: [{ id: room.fileId, path: room.path, kind: room.kind || null }],
  }).catch((err) => console.error("Realtime revision failed", err));
  room.markRevisioned(version);
}

// Debounced persistence: writes after a quiet moment, and at least every
// COLLAB_FLUSH_MAX_MS while editing never stops.
function collabSchedulePersist(room) {
  const now = Date.now();
  if (!room.flushDeadline) room.flushDeadline = now + COLLAB_FLUSH_MAX_MS;
  clearTimeout(room.flushTimer);
  clearTimeout(room.revisionTimer);
  const delay = Math.max(0, Math.min(COLLAB_FLUSH_MS, room.flushDeadline - now));
  room.flushTimer = setTimeout(() => {
    if (collabRooms.get(room.fileId) === room) collabTrack(collabPersist(room));
  }, delay);
  room.revisionTimer = setTimeout(() => {
    if (collabRooms.get(room.fileId) === room) collabTrack(collabPersist(room, { revision: true }));
  }, COLLAB_REVISION_IDLE_MS);
}

function collabBroadcast(room, message, except = null) {
  room.clients.forEach((client) => {
    if (client === except) return;
    collabSend(client.socket, message);
  });
}

/* ---- presence: who else is in this document, and where ---- */
// Presence is ephemeral and deliberately kept out of the durable update stream:
// it is never persisted, never versioned and never replayed. Each participant is
// told about the others only, so a client needs no identity of its own to filter
// itself out. Being in the room already required membership, so presence cannot
// leak to anyone who could not read the file anyway.
function collabPeersFor(room, recipient) {
  const peers = [];
  room.clients.forEach((client) => {
    if (client === recipient) return;
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
  room.clients.forEach((client) => {
    collabSend(client.socket, { t: "peers", fileId: room.fileId, peers: collabPeersFor(room, client) });
  });
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
    collabSend(session.socket, message);
  });
}

async function collabHandleMessage(session, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new CollabError("COLLAB_BAD_MESSAGE");
  }
  const fileId = message && message.fileId;

  if (message.t === "open") {
    const entry = await collabJoin(session, fileId);
    collabSend(session.socket, {
      t: "opened",
      fileId,
      version: entry.room.version,
      doc: entry.room.text(),
      role: entry.role,
    });
    // Everyone learns about the newcomer, and the newcomer about everyone.
    return collabBroadcastPeers(entry.room);
  }

  // A tab watches the project it has open, independently of which file it is
  // editing: build notifications concern the whole project, and a member may be
  // looking at the preview with no document in a room at all.
  if (message.t === "project") {
    const projectId = String(message.projectId || "");
    if (!isUuid(projectId)) throw new CollabError("COLLAB_BAD_PROJECT");
    const project = await collabMembership(projectId, session.user.sub);
    if (!project) throw new CollabError("COLLAB_PROJECT_NOT_FOUND");
    session.projectId = projectId;
    return;
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
    return collabBroadcastPeers(entry.room);
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
    if (!roleHasCapability(entry.role, "write")) throw new CollabError("COLLAB_READ_ONLY");
    const result = entry.room.receive(Number(message.version), message.updates, { userId: session.user.sub });
    collabSend(session.socket, { t: "pushed", fileId, accepted: result.accepted, version: result.version });
    if (!result.accepted) return;
    entry.room.lastAuthor = session.user;
    collabBroadcast(entry.room, { t: "updates", fileId, version: result.version, updates: result.updates }, session);
    return collabSchedulePersist(entry.room);
  }

  if (message.t === "ping") return collabSend(session.socket, { t: "pong" });
  throw new CollabError("COLLAB_BAD_MESSAGE");
}

function collabCloseSession(session, code = 1000, reason = "") {
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
  const sessions = Array.from(collabSessions).filter((session) =>
    session.projectId === projectId
    || Array.from(session.rooms.values()).some((entry) => entry.projectId === projectId));
  for (const session of sessions) {
    const project = await collabMembership(projectId, session.user.sub).catch(() => null);
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
      // The others see the new role on the participant list too.
      collabBroadcastPeers(entry.room);
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
  let user;
  try {
    user = await requireUser(req);
  } catch {
    return finish("401 Unauthorized", "Not authenticated");
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // One id per connection, not per user: the same person in two tabs is two
    // participants with two cursors, which is what the others should see.
    const session = { id: uuidv7(), socket: ws, user, rooms: new Map(), alive: true };
    collabSessions.add(session);
    ws.on("pong", () => { session.alive = true; });
    ws.on("message", (data) => {
      collabHandleMessage(session, data.toString("utf8")).catch((err) => {
        const code = err instanceof CollabError ? err.code : "COLLAB_ERROR";
        if (!(err instanceof CollabError)) console.error("Realtime session error", err);
        collabSend(ws, { t: "error", code });
      });
    });
    ws.on("close", () => {
      Array.from(session.rooms.keys()).forEach((fileId) => collabLeave(session, fileId));
      collabSessions.delete(session);
    });
    ws.on("error", () => {});
    collabSend(ws, { t: "ready", sessionId: session.id, color: peerColor(user.sub) });
  });
}

function collabAttach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: COLLAB_MAX_MESSAGE_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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
      if (!session.alive) return collabCloseSession(session, 1001, "unresponsive");
      session.alive = false;
      try { session.socket.ping(); } catch {}
    });
  }, COLLAB_HEARTBEAT_MS);
  if (typeof collabHeartbeat.unref === "function") collabHeartbeat.unref();
  return wss;
}

// Flushes every room and closes every session, so a restart never loses realtime
// work that had not yet reached its debounce.
async function collabShutdown() {
  clearInterval(collabHeartbeat);
  Array.from(collabSessions).forEach((session) => collabCloseSession(session, 1001, "server shutting down"));
  for (const room of collabRooms.all()) {
    clearTimeout(room.flushTimer);
    clearTimeout(room.revisionTimer);
    collabTrack(collabPersist(room, { revision: true }));
  }
  await Promise.allSettled(Array.from(collabPending));
}

async function createProject(req, res, user) {
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
  data.updatedAt = now;
  validateProjectSourceTree(data);
  // The project row must exist before the ledger references it, and the manifest
  // must be written after ids are stamped. On any failure the whole project is
  // rolled back so a half-created project never lingers. The creator becomes the
  // project's first owner through a membership row, the authority for access.
  await db.query(
    "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
    [id, user.sub, name, storageKey]
  );
  await db.query(
    "INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)",
    [id, user.sub]
  );
  try {
    await syncProjectFiles(id, data);
    await writeProjectFile(storagePath, data);
  } catch (err) {
    await db.query("DELETE FROM projects WHERE id = $1", [id]).catch(() => {});
    await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await audit({
    ...sessionActor(req, user),
    action: "project.created",
    targetType: "project",
    targetId: id,
    metadata: { name, projectType: data.projectType },
  });
  json(res, 201, {
    project: { id, name, projectType: data.projectType, createdAt: now, updatedAt: now, fileCount: countFiles(data) },
    data: { id, ...data },
  });
}

async function updateProject(req, res, user, id) {
  const body = await readBody(req);
  const row = await authorizeProject(id, user, "write");
  const name = body.name == null ? row.name : cleanName(body.name);
  let data;
  if (body.data && typeof body.data === "object") data = body.data;
  else data = await readProjectFile(row.storageDir);
  data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
  data.project.name = name;
  data.projectType = inferProjectType(data);
  data.lilypondArgs = data.projectType === "lilypond" ? sanitizeLilypondArgsForStorage(data.lilypondArgs) : "";
  data.lilypondFormat = data.projectType === "lilypond" ? normalizeLilypondFormat(data.lilypondFormat) : "pdf";
  data.mainPath = sanitizeMainPathForStorage(body.mainPath ?? data.mainPath);
  if (body.compileProfile && typeof body.compileProfile === "object") {
    data.compileProfile = sanitizeCompileProfileForStorage(body.compileProfile, data.projectType);
  }
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = Date.now();
  validateProjectSourceTree(data);
  const { renames } = await syncProjectFiles(id, data);
  applyCollabAuthority(id, data);
  await writeProjectFile(row.storageDir, data, renames);
  await db.query("UPDATE projects SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [name, id]);
  json(res, 200, {
    project: { id, name, projectType: data.projectType, createdAt: data.createdAt, updatedAt: data.updatedAt, fileCount: countFiles(data) },
    data: { id, ...data },
  });
}

async function deleteProject(req, res, user, id) {
  const row = await authorizeProject(id, user, "delete");
  await db.query("DELETE FROM projects WHERE id = $1", [id]);
  await fs.rm(row.storageDir, { recursive: true, force: true });
  await audit({
    ...sessionActor(req, user),
    action: "project.deleted",
    targetType: "project",
    targetId: id,
    metadata: { name: row.name },
  });
  // The project is gone, so every open realtime session on it loses membership.
  await collabRecheckProject(id);
  json(res, 200, { ok: true });
}

async function downloadProjectFile(req, res, user, id, url) {
  const row = await authorizeProject(id, user, "read");
  const file = await resolveProjectFile(row.storageDir, url.searchParams.get("path"));
  const fallbackName = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "download";
  res.writeHead(200, {
    "content-type": file.mimeType,
    "content-length": file.size,
    "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeDispositionValue(file.name)}`,
    "cache-control": "private, no-store",
  });
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(file.path);
    stream.on("error", reject);
    res.on("finish", resolve);
    res.on("close", resolve);
    stream.pipe(res);
  });
}

async function downloadProjectArchive(req, res, user, id) {
  const row = await authorizeProject(id, user, "read");
  let archive;
  try {
    archive = await buildProjectArchive(row.storageDir, row.name, {
      maxBytes: PROJECT_ARCHIVE_MAX_BYTES,
      maxEntries: PROJECT_ARCHIVE_MAX_ENTRIES,
    });
  } catch (error) {
    if (["PROJECT_ARCHIVE_TOO_LARGE", "ZIP_TOO_MANY_ENTRIES", "ZIP_ENTRY_TOO_LARGE"].includes(error && error.code)) {
      throw requestError("PROJECT_ARCHIVE_TOO_LARGE", 413);
    }
    throw error;
  }
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
  data.project = data.project && typeof data.project === "object" && Array.isArray(data.project.nodes)
    ? data.project
    : { nodes: [] };
  data.project.name = name;
  data.projectType = inferProjectType(data);
  data.engine = data.projectType === "lilypond"
    ? "lilypond"
    : (LATEX_ENGINES.has(data.engine) ? data.engine : "pdflatex");
  data.compileProfile = sanitizeCompileProfileForStorage(data.compileProfile, data.projectType);
  data.lilypondArgs = data.projectType === "lilypond" ? sanitizeLilypondArgsForStorage(data.lilypondArgs) : "";
  data.lilypondFormat = data.projectType === "lilypond" ? normalizeLilypondFormat(data.lilypondFormat) : "pdf";
  data.mainPath = sanitizeMainPathForStorage(data.mainPath);
  data.createdAt = now;
  data.updatedAt = now;
  validateProjectSourceTree(data);
  return data;
}

async function importProjectArchive(req, res, user, url) {
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

  try {
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
    } catch {
      throw invalidProjectArchive();
    }
    // The project row precedes the ledger it is referenced by; the ledger sync
    // stamps canonical ids into the tree, then the manifest is persisted with them.
    // The importer becomes the first owner.
    await db.query(
      "INSERT INTO projects (id, created_by, name, storage_path) VALUES ($1, $2, $3, $4)",
      [id, user.sub, name, storageKey]
    );
    await db.query(
      "INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)",
      [id, user.sub]
    );
    await syncProjectFiles(id, data);
    await writeProjectManifest(storagePath, data);
  } catch (err) {
    await db.query("DELETE FROM projects WHERE id = $1", [id]).catch(() => {});
    await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  await audit({
    ...sessionActor(req, user),
    action: "project.imported",
    targetType: "project",
    targetId: id,
    metadata: { name, projectType: data.projectType, fileCount: countFiles(data) },
  });
  json(res, 201, {
    project: { id, name, projectType: data.projectType, createdAt: now, updatedAt: now, fileCount: countFiles(data) },
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

function parseCompileLog(log) {
  const warnings = [];
  const errors = [];
  const lines = String(log || "").split(/\r?\n/);
  lines.forEach((line) => {
    if (/warning/i.test(line)) warnings.push(line.trim());
    if (/^! /.test(line) || /:[0-9]+:/.test(line) || /Emergency stop|unable to start|not found|ENOENT/i.test(line)) errors.push(line.trim());
  });
  return {
    warnings: warnings.slice(0, 80),
    errors: errors.slice(0, 80),
  };
}

function refreshFontCache(fontDir) {
  return new Promise((resolve) => {
    if (!fontDir || !fsSync.existsSync(fontDir)) return resolve("");
    const startedAt = Date.now();
    let log = `$ fc-cache -f ${fontDir}\n`;
    const child = spawn("fc-cache", ["-f", fontDir], { shell: false });
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
        args = [
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-file-line-error",
          "-no-shell-escape",
          "-output-directory=output",
          ...args.filter((arg) => !arg.startsWith("-output-directory")),
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
    let log = `$ ${command} ${args.join(" ")}\n`;
    let timedOut = false;
    let done = false;
    const child = spawn(command, args, {
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
      if (log.length >= COMPILE_LOG_LIMIT) return;
      log += chunk.toString("utf8").slice(0, COMPILE_LOG_LIMIT - log.length);
    };
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
      const parsed = parseCompileLog(log);
      resolve({ code, signal, timedOut, durationMs, log, ...parsed });
    });
  });
}

async function runCompilePipeline({ profile, binPath, cwd, fontDir, texmfVar, preLog }) {
  const startedAt = Date.now();
  let log = preLog || "";
  let warnings = [];
  let errors = [];
  let exitCode = 0;
  let signal = null;
  let timedOut = false;
  for (let i = 0; i < profile.steps.length; i++) {
    const step = profile.steps[i];
    log += `\n===== Iris step ${i + 1}/${profile.steps.length}: ${step.tool} =====\n`;
    const res = await runCompileStep({ step, binPath, cwd, fontDir, texmfVar });
    log += res.log;
    warnings = warnings.concat(res.warnings || []);
    errors = errors.concat(res.errors || []);
    exitCode = res.code;
    signal = res.signal;
    timedOut = res.timedOut;
    if (res.code !== 0 || res.signal || res.timedOut) break;
  }
  const parsed = parseCompileLog(log);
  return {
    code: exitCode,
    signal,
    timedOut,
    durationMs: Date.now() - startedAt,
    log,
    warnings: Array.from(new Set(warnings.concat(parsed.warnings))).slice(0, 80),
    errors: Array.from(new Set(errors.concat(parsed.errors))).slice(0, 80),
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
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      errors: Array.isArray(row.errors) ? row.errors : [],
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
         signal = $9, timed_out = $10, log = $11, warnings = $12::jsonb, errors = $13::jsonb
       WHERE id = $1 AND status = 'running'`,
      [
        id, status, succeeded ? storagePath : null, size, contentHash, succeeded ? artifacts.length : 0,
        result.durationMs ?? null, result.code ?? null, result.signal || null, result.timedOut === true,
        String(result.log || "").slice(0, COMPILE_LOG_LIMIT), JSON.stringify(result.warnings || []), JSON.stringify(result.errors || []),
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
    `SELECT ${BUILD_OUTPUT_FIELDS}, log, warnings, errors FROM build_outputs
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
  const row = await authorizeProject(id, user, "compile");
  const name = body.name == null ? row.name : cleanName(body.name);
  const data = body.data && typeof body.data === "object" ? body.data : await readProjectFile(row.storageDir);
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
  // The stored setting names the project's main file; body.mainPath is a
  // one-off override for this compilation and deliberately does not become the
  // setting, so compiling a chapter on its own never redefines the project.
  const storedMainPath = sanitizeMainPathForStorage(data.mainPath);
  const main = findCompileFile(data, sanitizeMainPathForStorage(body.mainPath) || storedMainPath, projectType);
  const mainPath = safeProjectSourcePath(main.path);
  const storedLilypondArgs = projectType === "lilypond"
    ? sanitizeLilypondArgsForStorage(body.lilypondArgs ?? data.lilypondArgs)
    : "";
  const outputFormat = projectType === "lilypond"
    ? normalizeLilypondFormat(body.lilypondFormat ?? data.lilypondFormat)
    : "pdf";
  const additionalArgs = projectType === "lilypond" ? parseCompileArguments(storedLilypondArgs) : [];
  const storedCompileProfile = sanitizeCompileProfileForStorage(body.compileProfile || data.compileProfile, projectType);
  const compileProfile = normalizeCompileProfile(storedCompileProfile, engine, mainPath, projectType, additionalArgs, outputFormat);
  data.compileProfile = storedCompileProfile;
  data.lilypondArgs = storedLilypondArgs;
  data.lilypondFormat = outputFormat;
  data.mainPath = storedMainPath;
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = Date.now();
  const { renames } = await syncProjectFiles(id, data);
  const buildFiles = collectProjectFiles(data.project.nodes).map((entry) => ({
    id: entry.node.id,
    path: entry.path,
    kind: entry.kind,
  }));
  await writeProjectFile(row.storageDir, data, renames);
  // The project directory now holds this build's sources: what the request sent,
  // and the bytes already on disk for every file it did not send. The snapshot is
  // completed from there before the build tree is materialized from it, so a
  // bibliography, a chapter or a style the author did not edit in this session is
  // compiled from its contents instead of from an empty file.
  await hydrateProjectPayloads(row.storageDir, data);
  await db.query("UPDATE projects SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [name, id]);
  const jobname = path.basename(mainPath).replace(/\.[^.]+$/, "");
  const outputName = `${jobname}.${outputFormat}`;
  const buildId = uuidv7();
  const stagingDir = path.join(DATA_DIR, ".build-staging", id, buildId);
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
  activeBuilds.add(buildId);
  try {
    await fs.mkdir(path.dirname(stagingDir), { recursive: true });
    // Materialize from the exact request snapshot rather than copying the live
    // project, which another save could change while this build is starting.
    await writeProjectFile(stagingDir, data);
    const checkpoint = await captureProjectCheckpoint({
      projectId: id,
      storageDir: stagingDir,
      user,
      reason: "compile",
      files: buildFiles,
    });
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
    const stagingOutputDir = path.join(stagingDir, "output");
    await fs.mkdir(stagingOutputDir, { recursive: true });
    const fontDir = path.join(stagingDir, "fonts");
    const texmfVar = path.join(stagingDir, ".iris", "texmf-var");
    await fs.mkdir(texmfVar, { recursive: true });
    const preLog = /^(xelatex|lualatex)$/i.test(engine) ? await refreshFontCache(fontDir) : "";
    result = await runCompilePipeline({ profile: compileProfile, binPath, cwd: stagingDir, fontDir, texmfVar, preLog });
    const generatedArtifacts = await readCompileArtifacts(stagingOutputDir, jobname, outputFormat);
    const success = result.code === 0 && generatedArtifacts.length > 0;
    const artifacts = success ? versionCompileArtifacts(generatedArtifacts, buildId, uuidv7) : [];
    if (success) publishedPath = await publishCompileOutput(stagingOutputDir, row.storageDir, buildId);
    const status = success ? "succeeded" : "failed";
    await finalizeBuildOutput({ id: buildId, status, storagePath: publishedPath, artifacts, result });
    finalized = true;
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
    });
  } catch (err) {
    if (buildCreated && !finalized) {
      if (publishedPath) {
        const publishedDir = await resolveBuildDirectory(row.storageDir, buildId, publishedPath).catch(() => null);
        if (publishedDir) await fs.rm(publishedDir, { recursive: true, force: true }).catch(() => {});
      }
      const message = `Iris: build setup or publication failed: ${err.message || err}`;
      const failedResult = {
        ...result,
        log: `${result.log || ""}\n${message}\n`,
        errors: Array.from(new Set([...(result.errors || []), message])).slice(0, 80),
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
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

const PROJECT_ROUTE = new RegExp(`^/api/projects/(${UUID_PATTERN})$`);
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
  if (isUserStatus(statusFilter)) {
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
    // Role and status changes are honoured immediately without a forced logout:
    // requireUser reads the fresh role on every request, and a disabled account is
    // refused by the status check. Disabling still bumps the epoch so any parallel
    // in-flight session is cut at once rather than lingering for one request.
    if (wantsStatus && nextStatus === "disabled") {
      sets.push("session_epoch = CURRENT_TIMESTAMP");
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
    await audit({ ...sessionActor(req, actor), action: "user.status_changed", targetType: "user", targetId, metadata: { from: before.status, to: nextStatus } });
  }
  json(res, 200, { user: adminUserView(after) });
}

async function adminResetPassword(req, res, actor, targetId) {
  const { rows } = await db.query("SELECT id, username, auth_source FROM users WHERE id = $1", [targetId]);
  if (!rows.length) throw requestError("ADMIN_USER_NOT_FOUND", 404);
  if (rows[0].auth_source !== "local") throw requestError("ADMIN_NOT_LOCAL_ACCOUNT", 400);
  const password = crypto.randomBytes(18).toString("base64url");
  // Bump the epoch so the account's existing sessions end at once, and require a
  // change on next login so the temporary password is genuinely one-time.
  await db.query(
    "UPDATE users SET password_hash = $1, password_change_required = TRUE, session_epoch = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
    [await hashPassword(password), targetId]
  );
  await audit({ ...sessionActor(req, actor), action: "user.password_reset", targetType: "user", targetId });
  json(res, 200, { ok: true, temporaryPassword: password });
}

// Undo an SSO conversion (or linking): the account reverts to a local one with a
// fresh one-time password. It drops the durable identity so a re-link starts
// clean, and bumps the epoch so any live SSO session ends at once.
async function adminUnlinkSso(req, res, actor, targetId) {
  const { rows } = await db.query("SELECT id, username, oidc_subject FROM users WHERE id = $1", [targetId]);
  if (!rows.length) throw requestError("ADMIN_USER_NOT_FOUND", 404);
  if (!rows[0].oidc_subject) throw requestError("ADMIN_NOT_LINKED", 400);
  const password = crypto.randomBytes(18).toString("base64url");
  await db.query(
    `UPDATE users SET auth_source = 'local', oidc_issuer = NULL, oidc_subject = NULL,
       oidc_linked_at = NULL, oidc_link_pending = FALSE, password_hash = $1,
       password_change_required = TRUE, session_epoch = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [await hashPassword(password), targetId]
  );
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

async function adminProjectRow(projectId) {
  const { rows } = await db.query("SELECT id, name, storage_path FROM projects WHERE id = $1", [projectId]);
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
      `SELECT m.project_id, m.user_id, m.role, u.username, u.email, u.display_name, u.status
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ANY($1) ORDER BY (m.role <> 'owner'), u.username`,
      [ids]
    );
    for (const m of members) {
      if (!membersByProject.has(m.project_id)) membersByProject.set(m.project_id, []);
      membersByProject.get(m.project_id).push({
        userId: m.user_id, username: m.username, name: m.display_name, email: m.email, role: m.role, status: m.status,
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
  const target = await resolveMemberUser(body.identifier);
  try {
    await db.query(
      "INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)",
      [projectId, target.id, role, actor.sub]
    );
  } catch (err) {
    if (err.code === "23505") throw requestError("MEMBER_ALREADY", 409);
    throw err;
  }
  await audit({
    ...sessionActor(req, actor),
    action: "project.shared",
    targetType: "membership",
    targetId: projectId,
    metadata: { userId: target.id, username: target.username, role, via: "admin" },
  });
  await collabRecheckProject(projectId);
  json(res, 201, {
    member: memberView({ user_id: target.id, username: target.username, email: target.email, display_name: target.display_name, role, invited_by: actor.sub, created_at: new Date() }),
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
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    const current = await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE",
      [projectId, memberId]
    );
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
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
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
    const current = await client.query(
      "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE",
      [projectId, memberId]
    );
    if (!current.rows.length) throw requestError("MEMBER_NOT_FOUND", 404);
    const others = await client.query(
      "SELECT COUNT(*) AS n FROM project_members WHERE project_id = $1 AND role = 'owner' AND user_id <> $2",
      [projectId, memberId]
    );
    if (leavesNoOwner(current.rows[0].role, null, Number(others.rows[0].n))) throw requestError("PROJECT_LAST_OWNER", 409);
    await client.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, memberId]);
    removed = true;
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
  const row = await adminProjectRow(projectId);
  const storageDir = resolveProjectStorageDir(DATA_DIR, row.storage_path);
  await db.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await fs.rm(storageDir, { recursive: true, force: true });
  await audit({
    ...sessionActor(req, actor),
    action: "project.deleted",
    targetType: "project",
    targetId: projectId,
    metadata: { name: row.name, via: "admin" },
  });
  await collabRecheckProject(projectId);
  json(res, 200, { ok: true });
}

// The projects for which the user is the *only* owner. Deleting the user would
// strand these (membership cascades away), so they must be resolved in the
// project console first. Other memberships and co-owned projects are unaffected.
async function soleOwnerProjects(userId) {
  const { rows } = await db.query(
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
  await audit({
    ...sessionActor(req, actor),
    action: "user.deleted",
    targetType: "user",
    targetId: userId,
    metadata: { username: target.username, role: target.system_role },
  });
  json(res, 200, { ok: true });
}

async function handleAdminApi(req, res, url, actor) {
  requireAdmin(actor);
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
    const body = await readBody(req);
    const login = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!login || !password) return errorJson(res, 400, "AUTH_REQUIRED_FIELDS");
    const { rows } = await db.query(
      "SELECT id, username, email, display_name, system_role, status, auth_source, session_epoch, password_hash, password_change_required, oidc_linked_at FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) LIMIT 1",
      [login, login]
    );
    const user = rows[0];
    const failedLogin = async (reason) => audit({
      action: "auth.login_failed",
      outcome: "failure",
      actorId: user ? user.id : null,
      actorLabel: user ? user.username : login,
      ip: clientIp(req),
      targetType: "user",
      targetId: user ? user.id : null,
      metadata: { authMethod: "local", reason },
    });
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
    // response does not reveal which accounts exist.
    if (user.status !== "active") {
      await failedLogin("account_disabled");
      return errorJson(res, 403, "AUTH_ACCOUNT_DISABLED");
    }
    if (passwordCheck.needsRehash) {
      const passwordHash = await hashPassword(password);
      await db.query("UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [passwordHash, user.id]);
      user.password_hash = passwordHash;
    }
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
      "SELECT id, username, email, display_name, system_role, status, auth_source, session_epoch, password_hash FROM users WHERE id = $1 LIMIT 1",
      [sessionUser.sub]
    );
    const user = rows[0];
    if (!user || !user.password_hash) {
      return errorJson(res, 403, "PASSWORD_SSO_ACCOUNT");
    }
    const passwordCheck = await verifyPassword(currentPassword, user.password_hash);
    if (!passwordCheck.valid) return errorJson(res, 401, "PASSWORD_CURRENT_INCORRECT");

    const passwordHash = await hashPassword(newPassword);
    await db.query("UPDATE users SET password_hash = $1, password_change_required = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [passwordHash, user.id]);
    user.password_hash = passwordHash;
    user.password_change_required = false;
    await audit({
      ...sessionActor(req, sessionUser),
      action: "user.password_changed",
      targetType: "user",
      targetId: user.id,
    });
    return json(res, 200, { ok: true, user: publicUser({ ...user, authMethod: "local" }) }, {
      "set-cookie": cookie("iris_session", makeToken(user, "local"), { maxAge: 60 * 60 * 24 * 7 }),
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

  // A pending forced password change blocks every other authed endpoint until the
  // temporary password is replaced. The login/password/logout/session routes are
  // handled above, before this gate, so the account can still complete the change.
  if (user.passwordChangeRequired) return errorJson(res, 403, "PASSWORD_CHANGE_REQUIRED");

  if (url.pathname.startsWith("/api/admin/")) return handleAdminApi(req, res, url, user);

  if (req.method === "POST" && url.pathname === "/api/account/username") {
    const body = await readBody(req);
    const nextUsername = validAdminUsername(body.username);
    const { rows } = await db.query(
      "SELECT id, username, email, display_name, system_role, status, auth_source, session_epoch, password_hash FROM users WHERE id = $1 LIMIT 1",
      [user.sub]
    );
    const row = rows[0];
    if (!row) return errorJson(res, 401, "NOT_AUTHENTICATED");
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
      await db.query("UPDATE users SET username = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [nextUsername, user.sub]);
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
  return {
    status: healthStatus({ shuttingDown, maintenance: maintenanceActive() }),
    maintenance: maintenanceActive(),
    pendingWrites: inFlightMutations,
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  inFlight += 1;
  // Counted only once the request passes the gate, so refused mutations during a
  // maintenance window do not appear as pending writes the operator waits on.
  let countedWrite = false;
  res.on("close", () => {
    inFlight -= 1;
    if (countedWrite) inFlightMutations -= 1;
  });
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

    if (isMutatingMethod(req.method) && url.pathname.startsWith("/api/")) {
      countedWrite = true;
      inFlightMutations += 1;
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method not allowed");
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (url.pathname.startsWith("/api/")) {
      return errorJson(res, status, err.errorCode || "SERVER_ERROR", err.params || {});
    }
    return text(res, status, err.message || "Server error");
  }
}

function startGracefulShutdown(signal, server) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; refusing new work and draining in-flight requests`);
  server.close(() => {});
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  const finish = async () => {
    if (inFlight > 0 && typeof server.closeAllConnections === "function") server.closeAllConnections();
    // Realtime documents live in memory between debounced writes, so they are
    // flushed before the process exits.
    await collabShutdown().catch((err) => console.error("Realtime shutdown failed", err));
    await db.end().catch(() => {});
    console.log("Shutdown complete");
    process.exit(0);
  };
  const tick = () => {
    if (inFlight <= 0 || Date.now() >= deadline) return void finish();
    setTimeout(tick, 100);
  };
  tick();
}

if (require.main === module) initDb()
  .then(() => {
    const server = http.createServer(handle);
    collabAttach(server);
    process.on("SIGTERM", () => startGracefulShutdown("SIGTERM", server));
    process.on("SIGINT", () => startGracefulShutdown("SIGINT", server));
    server.listen(...(BIND_ADDRESS ? [PORT, BIND_ADDRESS] : [PORT]), () => {
      console.log(`Iris listening on http://${BIND_ADDRESS || "localhost"}:${PORT}`);
      console.log(`Static files dir: ${PUBLIC_DIR}`);
      console.log(`Projects data dir: ${DATA_DIR}`);
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
  applyCollabAuthority,
  collabAttach,
  collabRooms,
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
};
