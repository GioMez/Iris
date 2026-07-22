const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const argon2 = require("argon2");
const mariadb = require("mariadb");

loadDotEnv(path.resolve(".env"));

const PORT = Number(process.env.PORT || 3000);
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || "iris";
const DB_PASSWORD = process.env.DB_PASSWORD || "iris";
const DB_NAME = process.env.DB_NAME || "iris";
const DB_CONNECT_TIMEOUT = Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data/projects");
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || "./public");
const TEX_BIN_PATH = process.env.TEX_BIN_PATH || "";
const TEX_PATH_LOCKED = String(process.env.TEX_PATH_LOCKED || "false") === "true";
const LILYPOND_BIN_PATH = process.env.LILYPOND_BIN_PATH || "";
const LILYPOND_PATH_LOCKED = String(process.env.LILYPOND_PATH_LOCKED || "false") === "true";
const SECRET = sessionSecret(process.env.IRIS_SECRET);
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false") === "true";
const MAX_BODY = Number(process.env.MAX_BODY_MB || 25) * 1024 * 1024;
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 30000);
const COMPILE_LOG_LIMIT = Number(process.env.COMPILE_LOG_LIMIT || 1024 * 1024);
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

let pool;
let oauthDiscoveryCache = null;
let initialAdminCredentials = null;

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

function loadDotEnv(file) {
  if (!fsSync.existsSync(file)) return;
  const lines = fsSync.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sessionSecret(value) {
  const secret = String(value || "").trim();
  const insecure = new Set([
    "iris-dev-secret-change-me",
    "change-this-secret-in-production",
  ]);
  if (!secret || insecure.has(secret)) {
    throw new Error("IRIS_SECRET must be set to a secure, non-default value");
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
    role: user.role || "user",
    authMethod,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  return signedJson(payload);
}

function verifyToken(token) {
  const payload = verifySignedJson(token);
  if (!payload || !payload.exp) return null;
  return payload;
}

function publicUser(rowOrToken) {
  return {
    id: String(rowOrToken.id || rowOrToken.sub),
    username: rowOrToken.username,
    name: rowOrToken.display_name || rowOrToken.name,
    email: rowOrToken.email,
    role: rowOrToken.role || "user",
    authMethod: rowOrToken.authMethod || rowOrToken.auth_method || "local",
    canChangePassword: (rowOrToken.authMethod || rowOrToken.auth_method || "local") === "local",
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
  return {
    email,
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
    const rows = await pool.query("SELECT id FROM users WHERE username = ? LIMIT 1", [candidate]);
    if (!rows.length) return candidate;
  }
  return `${clean.slice(0, 48)}-${crypto.randomBytes(4).toString("hex")}`;
}

async function userFromOAuthProfile(profile) {
  const rows = await pool.query(
    "SELECT id, username, email, display_name, role, password_hash FROM users WHERE LOWER(email) = ? LIMIT 1",
    [profile.email]
  );
  if (rows[0]) {
    const nextName = profile.name || rows[0].display_name;
    if (nextName && nextName !== rows[0].display_name) {
      await pool.query("UPDATE users SET display_name = ? WHERE id = ?", [nextName, rows[0].id]);
      rows[0].display_name = nextName;
    }
    return rows[0];
  }
  if (!OAUTH_AUTO_REGISTER) {
    const err = new Error("Unauthorized SSO user");
    err.status = 403;
    throw err;
  }

  const username = await availableUsername(profile.preferredUsername || profile.email);
  const displayName = profile.name || profile.email;
  try {
    const result = await pool.query(
      "INSERT INTO users (username, email, display_name, role, password_hash) VALUES (?, ?, ?, 'user', NULL)",
      [username, profile.email, displayName]
    );
    const id = String(result.insertId);
    return { id, username, email: profile.email, display_name: displayName, role: "user", password_hash: null };
  } catch (err) {
    if (err.code !== "ER_DUP_ENTRY") throw err;
    const retry = await pool.query(
      "SELECT id, username, email, display_name, role, password_hash FROM users WHERE LOWER(email) = ? LIMIT 1",
      [profile.email]
    );
    if (retry[0]) return retry[0];
    throw err;
  }
}

function safeDbName(name) {
  if (!/^[a-zA-Z0-9_$]+$/.test(name)) throw new Error("DB_NAME must contain only letters, numbers, _ or $");
  return `\`${name}\``;
}

async function initDb() {
  const poolOptions = (database) => ({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    ...(database ? { database } : {}),
    connectionLimit: database ? 8 : 1,
    connectTimeout: DB_CONNECT_TIMEOUT,
    acquireTimeout: DB_CONNECT_TIMEOUT,
  });

  pool = mariadb.createPool(poolOptions(DB_NAME));
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    if (err.errno !== 1049 && err.code !== "ER_BAD_DB_ERROR") throw err;
    const admin = mariadb.createPool(poolOptions(null));
    await admin.query(`CREATE DATABASE IF NOT EXISTS ${safeDbName(DB_NAME)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.end();
    pool = mariadb.createPool(poolOptions(DB_NAME));
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(80) NOT NULL,
      email VARCHAR(190) NOT NULL,
      display_name VARCHAR(190) NOT NULL,
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      password_hash VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_username (username),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role ENUM('admin','user') NOT NULL DEFAULT 'user' AFTER display_name");
  await pool.query("ALTER TABLE users MODIFY password_hash VARCHAR(255) NULL");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id CHAR(32) NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(160) NOT NULL,
      storage_path VARCHAR(512) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_projects_user_updated (user_id, updated_at),
      CONSTRAINT fk_projects_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await seedUsers();
}

async function seedUsers() {
  const rows = await pool.query("SELECT COUNT(*) AS n FROM users");
  if (Number(rows[0].n) > 0) return;
  const password = crypto.randomBytes(18).toString("base64url");
  await pool.query(
    "INSERT INTO users (username, email, display_name, role, password_hash) VALUES (?, ?, ?, 'admin', ?)",
    ["admin", "admin@iris.local", "Iris Admin", await hashPassword(password)]
  );
  initialAdminCredentials = { username: "admin", password };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw requestError("REQUEST_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw requestError("INVALID_JSON", 400);
  }
}

function requireUser(req) {
  const token = parseCookies(req).iris_session;
  const payload = verifyToken(token);
  if (!payload) {
    throw requestError("NOT_AUTHENTICATED", 401);
  }
  return payload;
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

function nodeRelPath(node, fallbackName, parentPath = "") {
  const rel = node.path || path.posix.join(parentPath, node.name || fallbackName || "");
  return safeRelPath(rel);
}

function dataUrlToBuffer(value) {
  const textValue = String(value || "");
  const match = textValue.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return Buffer.from(textValue, "utf8");
  const payload = match[3] || "";
  return match[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
}

function dataUrlMime(value) {
  const match = String(value || "").match(/^data:([^;,]+)?[;,]/);
  return match && match[1] ? match[1] : "application/octet-stream";
}

function mimeForProjectFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if ([".tex", ".ly", ".ily", ".bib", ".txt", ".sty", ".cls", ".md", ".log"].includes(ext)) return "text/plain; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".ps" || ext === ".eps") return "application/postscript";
  if (ext === ".ttf") return "font/ttf";
  if (ext === ".otf") return "font/otf";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function fileIsBinaryNode(node) {
  return node.kind === "img" || node.data || /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(node.name || node.path || "");
}

function fileIsFontPath(filePath) {
  return /\.(ttf|otf|woff2?)$/i.test(filePath || "");
}

function fileKindForPath(filePath) {
  if (/\.tex$/i.test(filePath)) return "tex";
  if (/\.ly$/i.test(filePath)) return "ly";
  if (/\.bib$/i.test(filePath)) return "bib";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(filePath)) return "img";
  if (/\.(pdf|ps|eps|aux|bbl|bcf|blg|idx|ilg|ind|log|out|toc|run\.xml|fls|fdb_latexmk)$/i.test(filePath)) return "artifact";
  return "file";
}

function fileIsTextPath(filePath) {
  return /\.(tex|ly|ily|bib|txt|sty|cls|md|log|aux|bbl|blg|idx|ilg|ind|out|toc|xml|bcf|fls|fdb_latexmk)$/i.test(filePath || "");
}

function generatedIdFor(relPath) {
  return "gen_" + crypto.createHash("sha1").update(relPath).digest("hex").slice(0, 12);
}

function isIgnoredProjectFsEntry(name) {
  return name === ".iris" || name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini";
}

function stripGeneratedNodes(nodes, isRoot = true) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((node) => !node.generated && !node.readOnly && !(isRoot && node.name === "output"))
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
        const rel = safeRelPath(path.posix.join(parentPath, node.name || ""));
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
        const rel = safeRelPath(path.posix.join(parentPath, node.name || ""));
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
      } else {
        await fs.writeFile(abs, String(node.content || ""), "utf8");
      }
    }
  };
  if (data.project) await walk(data.project.nodes);
  return expectedFiles;
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
      if (entry.name === ".iris") continue;
      if (!relBase && entry.name === "output") continue;
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

async function buildFsNode(storagePath, relPath, entry, generated) {
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
    if (fileIsTextPath(relPath)) node.content = await fs.readFile(abs, "utf8").catch(() => "");
    else if (fileIsBinaryNode(node)) {
      const buf = await fs.readFile(abs).catch(() => null);
      if (buf) node.data = `data:${mimeForProjectFile(relPath)};base64,${buf.toString("base64")}`;
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
    if (!relBase && entry.name === "output") {
      nodes.push(await buildFsNode(storagePath, "output", entry, true));
      continue;
    }
    const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
    nodes.push(await buildFsNode(storagePath, rel, entry, generated));
  }
  return nodes;
}

async function generatedOutputTree(storagePath) {
  const outputPath = path.join(storagePath, "output");
  const stat = await fs.stat(outputPath).catch(() => null);
  if (!stat || !stat.isDirectory()) return null;
  return buildFsNode(storagePath, "output", { name: "output", isDirectory: () => true }, true);
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
    const visibleEntries = entries.filter((entry) => !isIgnoredProjectFsEntry(entry.name) && (relBase || entry.name !== "output"));
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
        const hydrated = await buildFsNode(storagePath, rel, entry, false);
        synced.push({
          ...hydrated,
          ...node,
          kind: hydrated.kind,
          path: hydrated.path,
          content: hydrated.content,
          data: hydrated.data,
        });
      }
    }

    const known = new Set(synced.map((node) => node.name));
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (isIgnoredProjectFsEntry(entry.name)) continue;
      if (!relBase && entry.name === "output") continue;
      if (known.has(entry.name)) continue;
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      synced.push(await buildFsNode(storagePath, rel, entry, false));
    }
    return synced;
  };

  data.project.nodes = await merge(data.project.nodes, "");
  const outputStat = await fs.stat(path.join(storagePath, "output")).catch(() => null);
  if (outputStat && outputStat.isDirectory()) {
    const fakeEntry = { name: "output", isDirectory: () => true };
    data.project.nodes.push(await buildFsNode(storagePath, "output", fakeEntry, true));
  }
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
        const rel = safeRelPath(path.posix.join(parentPath, node.name || ""));
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
  if (Array.isArray(data.fonts)) {
    for (const font of data.fonts) {
      if (!font || !font.path) continue;
      const rel = safeRelPath(font.path);
      if (!fileIsFontPath(rel)) continue;
      const buf = await fs.readFile(path.join(storagePath, rel)).catch(() => null);
      if (buf) font.data = `data:${mimeForProjectFile(rel)};base64,${buf.toString("base64")}`;
    }
  }
  return data;
}

async function readProjectManifest(storagePath) {
  const metaFile = path.join(storagePath, ".iris", "project.json");
  return JSON.parse(await fs.readFile(metaFile, "utf8"));
}

async function writeProjectFile(storagePath, data) {
  await fs.mkdir(storagePath, { recursive: true });
  await ensureProjectDirs(storagePath, data);
  const expectedFiles = await writeProjectNodes(storagePath, data);
  await writeProjectFonts(storagePath, data, expectedFiles);
  await pruneProjectFiles(storagePath, expectedFiles);
  const irisDir = path.join(storagePath, ".iris");
  await fs.mkdir(irisDir, { recursive: true });
  const file = path.join(irisDir, "project.json");
  const tmp = path.join(irisDir, `.project.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(stripFilePayloads(data), null, 2), "utf8");
  await fs.rename(tmp, file);
  await fs.rm(path.join(storagePath, "project.json"), { force: true }).catch(() => {});
}

async function projectForUser(id, userId) {
  const rows = await pool.query(
    "SELECT id, name, storage_path, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?",
    [id, userId]
  );
  if (!rows.length) {
    throw requestError("PROJECT_NOT_FOUND", 404);
  }
  return rows[0];
}

async function listProjects(req, res, user) {
  const rows = await pool.query(
    "SELECT id, name, storage_path, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC",
    [user.sub]
  );
  const projects = await Promise.all(rows.map(async (row) => {
    let fileCount = 0;
    let projectType = "latex";
    try {
      const manifest = await readProjectManifest(row.storage_path);
      fileCount = countFiles(manifest);
      projectType = inferProjectType(manifest);
    } catch {}
    return {
      id: row.id,
      name: row.name,
      createdAt: toMillis(row.created_at),
      updatedAt: toMillis(row.updated_at),
      fileCount,
      projectType,
    };
  }));
  json(res, 200, { projects });
}

async function getProject(req, res, user, id) {
  const row = await projectForUser(id, user.sub);
  const data = await readProjectFile(row.storage_path);
  if (!data.project) data.project = { name: row.name, nodes: [] };
  data.project.name = row.name;
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = toMillis(row.updated_at);
  json(res, 200, { id: row.id, ...data });
}

async function createProject(req, res, user) {
  const body = await readBody(req);
  const name = cleanName(body.name);
  const id = crypto.randomBytes(16).toString("hex");
  const storagePath = path.join(DATA_DIR, String(user.sub), `${id}-${slugify(name)}`);
  const now = Date.now();
  const data = body.data && typeof body.data === "object" ? body.data : {};
  data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
  data.project.name = name;
  data.projectType = inferProjectType(data);
  data.lilypondArgs = data.projectType === "lilypond" ? sanitizeLilypondArgsForStorage(data.lilypondArgs) : "";
  data.lilypondFormat = data.projectType === "lilypond" ? normalizeLilypondFormat(data.lilypondFormat) : "pdf";
  data.createdAt = now;
  data.updatedAt = now;
  await writeProjectFile(storagePath, data);
  await pool.query(
    "INSERT INTO projects (id, user_id, name, storage_path) VALUES (?, ?, ?, ?)",
    [id, user.sub, name, storagePath]
  );
  json(res, 201, {
    project: { id, name, projectType: data.projectType, createdAt: now, updatedAt: now, fileCount: countFiles(data) },
    data: { id, ...data },
  });
}

async function updateProject(req, res, user, id) {
  const body = await readBody(req);
  const row = await projectForUser(id, user.sub);
  const name = body.name == null ? row.name : cleanName(body.name);
  let data;
  if (body.data && typeof body.data === "object") data = body.data;
  else data = await readProjectFile(row.storage_path);
  data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
  data.project.name = name;
  data.projectType = inferProjectType(data);
  data.lilypondArgs = data.projectType === "lilypond" ? sanitizeLilypondArgsForStorage(data.lilypondArgs) : "";
  data.lilypondFormat = data.projectType === "lilypond" ? normalizeLilypondFormat(data.lilypondFormat) : "pdf";
  if (body.compileProfile && typeof body.compileProfile === "object") {
    data.compileProfile = sanitizeCompileProfileForStorage(body.compileProfile, data.projectType);
  }
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = Date.now();
  await writeProjectFile(row.storage_path, data);
  await pool.query("UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND user_id = ?", [name, id, user.sub]);
  json(res, 200, {
    project: { id, name, projectType: data.projectType, createdAt: data.createdAt, updatedAt: data.updatedAt, fileCount: countFiles(data) },
    data: { id, ...data },
  });
}

async function deleteProject(req, res, user, id) {
  const row = await projectForUser(id, user.sub);
  await pool.query("DELETE FROM projects WHERE id = ? AND user_id = ?", [id, user.sub]);
  await fs.rm(row.storage_path, { recursive: true, force: true });
  json(res, 200, { ok: true });
}

async function downloadProjectFile(req, res, user, id, url) {
  const row = await projectForUser(id, user.sub);
  const file = await resolveProjectFile(row.storage_path, url.searchParams.get("path"));
  const fallbackName = file.name.replace(/[^A-Za-z0-9._-]/g, "_") || "download";
  res.writeHead(200, {
    "content-type": file.mimeType,
    "content-length": file.size,
    "content-disposition": `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
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
  const requested = profile && typeof profile === "object" ? profile : defaultCompileProfile(projectType);
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
  if (!profile || typeof profile !== "object") return { mode: "quick" };
  const mode = String(profile.mode || "quick");
  if (mode !== "custom") {
    const modes = projectType === "lilypond" ? ["quick"] : ["quick", "bibtex", "biber", "index"];
    return { mode: modes.includes(mode) ? mode : "quick" };
  }
  const steps = Array.isArray(profile.steps) ? profile.steps : [];
  return {
    mode: "custom",
    steps: steps.slice(0, 12).map((step) => {
      const fallbackEngine = projectType === "lilypond" ? "lilypond" : "pdflatex";
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

async function removePriorCompileArtifacts(outputDir, jobname, format) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && compileArtifactNameMatches(entry.name, jobname, format))
    .map((entry) => fs.rm(path.join(outputDir, entry.name), { force: true })));
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

async function compileProject(req, res, user, id) {
  const body = await readBody(req);
  const row = await projectForUser(id, user.sub);
  const name = body.name == null ? row.name : cleanName(body.name);
  const data = body.data && typeof body.data === "object" ? body.data : await readProjectFile(row.storage_path);
  data.project = data.project && Array.isArray(data.project.nodes) ? data.project : { nodes: [] };
  data.project.name = name;
  const projectType = inferProjectType(data);
  data.projectType = projectType;
  const engine = projectType === "lilypond" ? "lilypond" : String(body.engine || data.engine || "pdflatex").trim();
  if (projectType === "latex" && !LATEX_ENGINES.has(engine)) {
    throw requestError("LATEX_ENGINE_UNSUPPORTED", 400);
  }
  const binPath = projectType === "lilypond"
    ? (LILYPOND_PATH_LOCKED ? LILYPOND_BIN_PATH : String(body.lilypondPath || LILYPOND_BIN_PATH || "").trim())
    : (TEX_PATH_LOCKED ? TEX_BIN_PATH : String(body.texPath || TEX_BIN_PATH || "").trim());
  const main = findCompileFile(data, body.mainPath, projectType);
  const mainPath = safeRelPath(main.path);
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
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = Date.now();
  await writeProjectFile(row.storage_path, data);
  await pool.query("UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND user_id = ?", [name, id, user.sub]);

  const jobname = path.basename(mainPath).replace(/\.[^.]+$/, "");
  const outputName = `${jobname}.${outputFormat}`;
  const outputDir = path.join(row.storage_path, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const formatsToClean = projectType === "lilypond" ? Array.from(LILYPOND_OUTPUT_FORMATS) : ["pdf"];
  await Promise.all(formatsToClean.map((format) => removePriorCompileArtifacts(outputDir, jobname, format)));
  const fontDir = path.join(row.storage_path, "fonts");
  const texmfVar = path.join(row.storage_path, ".iris", "texmf-var");
  await fs.mkdir(texmfVar, { recursive: true });
  const preLog = /^(xelatex|lualatex)$/i.test(engine) ? await refreshFontCache(fontDir) : "";
  const result = await runCompilePipeline({ profile: compileProfile, binPath, cwd: row.storage_path, fontDir, texmfVar, preLog });
  const artifacts = await readCompileArtifacts(outputDir, jobname, outputFormat);
  const outputTree = await generatedOutputTree(row.storage_path);
  const primaryArtifact = artifacts[0] || null;
  const pdfArtifact = outputFormat === "pdf" ? primaryArtifact : null;
  const success = result.code === 0 && artifacts.length > 0;
  json(res, 200, {
    success,
    projectType,
    engine,
    mainPath,
    outputDir: "output",
    outputFormat,
    outputName: primaryArtifact ? primaryArtifact.name : `output/${outputName}`,
    artifacts,
    outputTree,
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
      const user = await userFromOAuthProfile(profile);
      return redirect(res, "/", {
        "set-cookie": [
          clearState,
          cookie("iris_session", makeToken(user, "sso"), { maxAge: 60 * 60 * 24 * 7 }),
        ],
      });
    } catch (err) {
      console.error("SSO callback failed", err.message || err);
      return redirect(res, "/?auth_error=sso", { "set-cookie": clearState });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const login = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!login || !password) return errorJson(res, 400, "AUTH_REQUIRED_FIELDS");
    const rows = await pool.query(
      "SELECT id, username, email, display_name, role, password_hash FROM users WHERE LOWER(username) = ? OR LOWER(email) = ? LIMIT 1",
      [login, login]
    );
    const user = rows[0];
    if (user && !user.password_hash) {
      return errorJson(res, 401, "AUTH_SSO_ACCOUNT");
    }
    const passwordCheck = user ? await verifyPassword(password, user.password_hash) : { valid: false, needsRehash: false };
    if (!user || !passwordCheck.valid) {
      return errorJson(res, 401, "AUTH_INVALID_CREDENTIALS");
    }
    if (passwordCheck.needsRehash) {
      const passwordHash = await hashPassword(password);
      await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);
      user.password_hash = passwordHash;
    }
    return json(res, 200, { user: publicUser(user) }, {
      "set-cookie": cookie("iris_session", makeToken(user, "local"), { maxAge: 60 * 60 * 24 * 7 }),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/password") {
    const sessionUser = requireUser(req);
    if (sessionUser.authMethod !== "local") {
      return errorJson(res, 403, "PASSWORD_LOCAL_LOGIN_REQUIRED");
    }
    const body = await readBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (!currentPassword || !newPassword) return errorJson(res, 400, "PASSWORD_REQUIRED_FIELDS");
    if (newPassword.length < 10) return errorJson(res, 400, "PASSWORD_TOO_SHORT");
    if (currentPassword === newPassword) return errorJson(res, 400, "PASSWORD_MUST_DIFFER");

    const rows = await pool.query(
      "SELECT id, username, email, display_name, role, password_hash FROM users WHERE id = ? LIMIT 1",
      [sessionUser.sub]
    );
    const user = rows[0];
    if (!user || !user.password_hash) {
      return errorJson(res, 403, "PASSWORD_SSO_ACCOUNT");
    }
    const passwordCheck = await verifyPassword(currentPassword, user.password_hash);
    if (!passwordCheck.valid) return errorJson(res, 401, "PASSWORD_CURRENT_INCORRECT");

    const passwordHash = await hashPassword(newPassword);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);
    user.password_hash = passwordHash;
    return json(res, 200, { ok: true, user: publicUser({ ...user, authMethod: "local" }) }, {
      "set-cookie": cookie("iris_session", makeToken(user, "local"), { maxAge: 60 * 60 * 24 * 7 }),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    return json(res, 200, { ok: true }, { "set-cookie": cookie("iris_session", "", { maxAge: 0 }) });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/session") {
    const user = requireUser(req);
    return json(res, 200, { user: publicUser(user) });
  }

  const user = requireUser(req);

  if (req.method === "GET" && url.pathname === "/api/projects") return listProjects(req, res, user);
  if (req.method === "POST" && url.pathname === "/api/projects") return createProject(req, res, user);

  const compileMatch = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/compile$/);
  if (compileMatch && req.method === "POST") return compileProject(req, res, user, compileMatch[1]);

  const fileDownloadMatch = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})\/files\/download$/);
  if (fileDownloadMatch && req.method === "GET") return downloadProjectFile(req, res, user, fileDownloadMatch[1], url);

  const match = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})$/);
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
  const pdfjsFile = pathname.match(/^\/vendor\/pdfjs\/(pdf(?:\.worker)?\.min\.mjs)$/);
  const root = pdfjsFile ? PDFJS_BUILD_DIR : PUBLIC_DIR;
  const relativePath = pdfjsFile ? pdfjsFile[1] : `.${pathname}`;
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(root + path.sep)) return text(res, 403, "Forbidden");
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

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
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

if (require.main === module) initDb()
  .then(() => {
    http.createServer(handle).listen(PORT, () => {
      console.log(`Iris listening on http://localhost:${PORT}`);
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
  fileKindForPath,
  inferProjectType,
  findCompileFile,
  normalizeCompileProfile,
  sanitizeCompileProfileForStorage,
  parseCompileArguments,
  sanitizeLilypondArgsForStorage,
  normalizeLilypondFormat,
  generatedOutputTree,
  resolveProjectFile,
  readCompileArtifacts,
  runCompilePipeline,
};
