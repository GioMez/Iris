const fsSync = require("node:fs");

// Minimal .env reader shared by the server and the maintenance scripts, so both
// resolve database and storage settings the same way. Existing environment
// variables always win.
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

function databaseSettings() {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "iris",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "iris",
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
  };
}

module.exports = { loadDotEnv, databaseSettings };
