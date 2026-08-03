const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const MAX_PROJECT_TEMPLATE_BYTES = 1024 * 1024;
const MAX_PROJECT_TEMPLATES_PER_TYPE = 200;

const TEMPLATE_TYPES = {
  latex: { directory: "latex", extension: ".tex", defaultId: "article" },
  lilypond: { directory: "lilypond", extension: ".ly", defaultId: "default" },
};

function templateLabel(id) {
  const words = String(id || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(id || "");
}

function templateError(errorCode, status) {
  const error = new Error(errorCode);
  error.errorCode = errorCode;
  error.status = status;
  return error;
}

function templatePath(publicDir, type, fileName) {
  const config = TEMPLATE_TYPES[type];
  const name = String(fileName || "");
  if (!config || !name || name.startsWith(".") || name.includes("\0") || path.basename(name) !== name
      || path.extname(name).toLowerCase() !== config.extension) {
    throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
  }
  return path.join(publicDir, "templates", config.directory, name);
}

async function discoverType(publicDir, type, config) {
  const directory = path.join(publicDir, "templates", config.directory);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const eligibleEntries = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && path.extname(entry.name).toLowerCase() === config.extension)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }))
    .slice(0, MAX_PROJECT_TEMPLATES_PER_TYPE);
  const candidates = await Promise.all(eligibleEntries.map(async (entry) => {
    const stat = await fs.lstat(path.join(directory, entry.name)).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_PROJECT_TEMPLATE_BYTES) return null;
    return entry;
  }));
  const templates = candidates
    .filter(Boolean)
    .map((entry) => {
      const id = entry.name.slice(0, -path.extname(entry.name).length);
      return {
        id,
        label: templateLabel(id),
        url: `/api/project-templates/${type}/${encodeURIComponent(entry.name)}`,
        default: id === config.defaultId,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));

  if (templates.length && !templates.some((template) => template.default)) templates[0].default = true;
  return templates;
}

async function discoverProjectTemplates(publicDir) {
  const pairs = await Promise.all(Object.entries(TEMPLATE_TYPES).map(async ([type, config]) =>
    [type, await discoverType(publicDir, type, config)]));
  return Object.fromEntries(pairs);
}

async function readProjectTemplate(publicDir, type, fileName) {
  const filePath = templatePath(publicDir, type, fileName);
  const noFollow = fsSync.constants.O_NOFOLLOW || 0;
  let handle;
  try {
    handle = await fs.open(filePath, fsSync.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (["EACCES", "ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) {
      throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
    if (stat.size > MAX_PROJECT_TEMPLATE_BYTES) throw templateError("PROJECT_TEMPLATE_TOO_LARGE", 413);

    // Read at most one byte beyond the limit, so a file growing after fstat
    // cannot turn this endpoint into an unbounded allocation.
    const chunks = [];
    let length = 0;
    while (length <= MAX_PROJECT_TEMPLATE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_PROJECT_TEMPLATE_BYTES + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > MAX_PROJECT_TEMPLATE_BYTES) throw templateError("PROJECT_TEMPLATE_TOO_LARGE", 413);
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
      if (content.includes("\0")) throw new TypeError("NUL byte");
      return content;
    } catch {
      throw templateError("PROJECT_TEMPLATE_INVALID", 422);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

module.exports = {
  TEMPLATE_TYPES,
  MAX_PROJECT_TEMPLATE_BYTES,
  MAX_PROJECT_TEMPLATES_PER_TYPE,
  templateLabel,
  discoverProjectTemplates,
  readProjectTemplate,
};
