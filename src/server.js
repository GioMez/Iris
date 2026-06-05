const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const mariadb = require("mariadb");

loadDotEnv(path.resolve(".env"));

const PORT = Number(process.env.PORT || 3000);
const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || "webtex";
const DB_PASSWORD = process.env.DB_PASSWORD || "webtex";
const DB_NAME = process.env.DB_NAME || "webtex";
const DB_CONNECT_TIMEOUT = Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data/projects");
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || "./public");
const SECRET = process.env.WEBTEX_SECRET || "webtex-dev-secret-change-me";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false") === "true";
const MAX_BODY = Number(process.env.MAX_BODY_MB || 25) * 1024 * 1024;

let pool;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
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

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function text(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
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

function makeToken(user) {
  const payload = {
    sub: String(user.id),
    username: user.username,
    name: user.display_name,
    email: user.email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = sign(body);
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function publicUser(rowOrToken) {
  return {
    id: String(rowOrToken.id || rowOrToken.sub),
    username: rowOrToken.username,
    name: rowOrToken.display_name || rowOrToken.name,
    email: rowOrToken.email,
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const key = crypto.scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, key] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const check = hashPassword(password, salt).split("$")[2];
  const a = Buffer.from(key);
  const b = Buffer.from(check);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_username (username),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
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
  const users = [
    ["rossi", "m.rossi@unibo.it", "Marco Rossi", "webtex"],
    ["demo", "demo@webtex.app", "Utente Demo", "demo"],
  ];
  for (const [username, email, name, password] of users) {
    await pool.query(
      "INSERT INTO users (username, email, display_name, password_hash) VALUES (?, ?, ?, ?)",
      [username, email, name, hashPassword(password)]
    );
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error("Payload troppo grande");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("JSON non valido");
    err.status = 400;
    throw err;
  }
}

function requireUser(req) {
  const token = parseCookies(req).webtex_session;
  const payload = verifyToken(token);
  if (!payload) {
    const err = new Error("Non autenticato");
    err.status = 401;
    throw err;
  }
  return payload;
}

function cleanName(name) {
  const out = String(name || "").trim().replace(/\s+/g, " ");
  if (!out) {
    const err = new Error("Nome progetto obbligatorio");
    err.status = 400;
    throw err;
  }
  if (out.length > 80) {
    const err = new Error("Nome progetto troppo lungo");
    err.status = 400;
    throw err;
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
      if (x.type === "folder") walk(x.children);
      else n += 1;
    });
  };
  if (data && data.project) walk(data.project.nodes);
  return n;
}

async function readProjectFile(storagePath) {
  const file = path.join(storagePath, "project.json");
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function writeProjectFile(storagePath, data) {
  await fs.mkdir(storagePath, { recursive: true });
  const file = path.join(storagePath, "project.json");
  const tmp = path.join(storagePath, `.project.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function projectForUser(id, userId) {
  const rows = await pool.query(
    "SELECT id, name, storage_path, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?",
    [id, userId]
  );
  if (!rows.length) {
    const err = new Error("Progetto non trovato");
    err.status = 404;
    throw err;
  }
  return rows[0];
}

async function listProjects(req, res, user) {
  const rows = await pool.query(
    "SELECT id, name, storage_path, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC",
    [user.sub]
  );
  const projects = [];
  for (const row of rows) {
    let fileCount = 0;
    try { fileCount = countFiles(await readProjectFile(row.storage_path)); } catch {}
    projects.push({
      id: row.id,
      name: row.name,
      createdAt: toMillis(row.created_at),
      updatedAt: toMillis(row.updated_at),
      fileCount,
    });
  }
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
  data.createdAt = now;
  data.updatedAt = now;
  await writeProjectFile(storagePath, data);
  await pool.query(
    "INSERT INTO projects (id, user_id, name, storage_path) VALUES (?, ?, ?, ?)",
    [id, user.sub, name, storagePath]
  );
  json(res, 201, {
    project: { id, name, createdAt: now, updatedAt: now, fileCount: countFiles(data) },
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
  data.createdAt = toMillis(row.created_at);
  data.updatedAt = Date.now();
  await writeProjectFile(row.storage_path, data);
  await pool.query("UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND user_id = ?", [name, id, user.sub]);
  json(res, 200, {
    project: { id, name, createdAt: data.createdAt, updatedAt: data.updatedAt, fileCount: countFiles(data) },
    data: { id, ...data },
  });
}

async function deleteProject(req, res, user, id) {
  const row = await projectForUser(id, user.sub);
  await pool.query("DELETE FROM projects WHERE id = ? AND user_id = ?", [id, user.sub]);
  await fs.rm(row.storage_path, { recursive: true, force: true });
  json(res, 200, { ok: true });
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const login = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!login || !password) return json(res, 400, { error: "Inserisci nome utente e password." });
    const rows = await pool.query(
      "SELECT id, username, email, display_name, password_hash FROM users WHERE LOWER(username) = ? OR LOWER(email) = ? LIMIT 1",
      [login, login]
    );
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return json(res, 401, { error: "Credenziali non valide. Riprova." });
    }
    return json(res, 200, { user: publicUser(user) }, {
      "set-cookie": cookie("webtex_session", makeToken(user), { maxAge: 60 * 60 * 24 * 7 }),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    return json(res, 200, { ok: true }, { "set-cookie": cookie("webtex_session", "", { maxAge: 0 }) });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/session") {
    const user = requireUser(req);
    return json(res, 200, { user: publicUser(user) });
  }

  const user = requireUser(req);

  if (req.method === "GET" && url.pathname === "/api/projects") return listProjects(req, res, user);
  if (req.method === "POST" && url.pathname === "/api/projects") return createProject(req, res, user);

  const match = url.pathname.match(/^\/api\/projects\/([a-f0-9]{32})$/);
  if (match) {
    if (req.method === "GET") return getProject(req, res, user, match[1]);
    if (req.method === "PUT") return updateProject(req, res, user, match[1]);
    if (req.method === "DELETE") return deleteProject(req, res, user, match[1]);
  }

  json(res, 404, { error: "Endpoint non trovato" });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/WebTeX.html";
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return text(res, 403, "Forbidden");
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
    if (url.pathname.startsWith("/api/")) return json(res, status, { error: err.message || "Errore server" });
    return text(res, status, err.message || "Errore server");
  }
}

initDb()
  .then(() => {
    http.createServer(handle).listen(PORT, () => {
      console.log(`WebTeX listening on http://localhost:${PORT}`);
      console.log(`Static files dir: ${PUBLIC_DIR}`);
      console.log(`Projects data dir: ${DATA_DIR}`);
    });
  })
  .catch((err) => {
    console.error("Unable to start WebTeX backend");
    console.error(err);
    process.exit(1);
  });
