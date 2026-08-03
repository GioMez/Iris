const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const MAX_PROJECT_TEMPLATE_BYTES = 1024 * 1024;
const MAX_PROJECT_TEMPLATES_PER_TYPE = 200;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MANIFEST_FILE = ".metadata.json";

const TEMPLATE_TYPES = {
  latex: { directory: "latex", extension: ".tex", defaultId: "article" },
  lilypond: { directory: "lilypond", extension: ".ly", defaultId: "default" },
};

let mutationQueue = Promise.resolve();

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

function stringLength(value) {
  return Array.from(value).length;
}

function isWellFormedString(value) {
  if (typeof value.isWellFormed === "function") return value.isWellFormed();
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateTemplateType(value) {
  if (typeof value !== "string" || !TEMPLATE_TYPES[value]) {
    throw templateError("ADMIN_TEMPLATE_TYPE_INVALID", 400);
  }
  return value;
}

function validateTemplateId(value) {
  if (typeof value !== "string") throw templateError("ADMIN_TEMPLATE_ID_INVALID", 400);
  const id = value.trim();
  if (!id || stringLength(id) > 80 || id.startsWith(".") || id.endsWith(".")
      || /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/u.test(id)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(id)
      || !isWellFormedString(id)) {
    throw templateError("ADMIN_TEMPLATE_ID_INVALID", 400);
  }
  return id;
}

function validateProjectTemplate(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const type = validateTemplateType(value.type);
  const id = validateTemplateId(value.id);
  if (typeof value.title !== "string" || !value.title.trim()) {
    throw templateError("ADMIN_TEMPLATE_TITLE_REQUIRED", 400);
  }
  const title = value.title.trim();
  if (stringLength(title) > 120) throw templateError("ADMIN_TEMPLATE_TITLE_TOO_LONG", 400);
  if (value.description != null && typeof value.description !== "string") {
    throw templateError("PROJECT_TEMPLATE_INVALID", 422);
  }
  const description = String(value.description || "").trim();
  if (stringLength(description) > 500) throw templateError("ADMIN_TEMPLATE_DESCRIPTION_TOO_LONG", 400);
  if (typeof value.content !== "string" || value.content.includes("\0") || !isWellFormedString(value.content)) {
    throw templateError("PROJECT_TEMPLATE_INVALID", 422);
  }
  const content = Buffer.from(value.content, "utf8");
  if (content.length > MAX_PROJECT_TEMPLATE_BYTES) {
    throw templateError("PROJECT_TEMPLATE_TOO_LARGE", 413);
  }
  return { id, title, description, type, default: value.default === true, content: value.content };
}

function collisionKey(id) {
  return String(id).normalize("NFC").toLocaleLowerCase("en-US");
}

function emptyManifest() {
  return { version: 1, defaults: {}, templates: [] };
}

function sanitizeManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyManifest();
  const manifest = emptyManifest();
  const defaults = value.defaults;
  if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
    for (const type of Object.keys(TEMPLATE_TYPES)) {
      try {
        if (typeof defaults[type] === "string") manifest.defaults[type] = validateTemplateId(defaults[type]);
      } catch {}
    }
  }
  if (!Array.isArray(value.templates)) return manifest;

  const seen = new Set();
  for (const record of value.templates.slice(0, MAX_PROJECT_TEMPLATES_PER_TYPE * Object.keys(TEMPLATE_TYPES).length)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    try {
      const type = validateTemplateType(record.type);
      const id = validateTemplateId(record.id);
      if (typeof record.title !== "string" || !record.title.trim() || stringLength(record.title.trim()) > 120) continue;
      if (record.description != null && typeof record.description !== "string") continue;
      const description = String(record.description || "").trim();
      if (stringLength(description) > 500) continue;
      const key = `${type}\0${collisionKey(id)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      manifest.templates.push({ type, id, title: record.title.trim(), description });
    } catch {}
  }
  return manifest;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function regularDirectoryOrNull(target) {
  const stat = await lstatOrNull(target);
  return stat && stat.isDirectory() && !stat.isSymbolicLink() ? stat : null;
}

async function readHandleBounded(handle, maximum, tooLargeCode) {
  const stat = await handle.stat();
  if (!stat.isFile()) throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
  if (stat.size > maximum) throw templateError(tooLargeCode, 413);

  const chunks = [];
  let length = 0;
  while (length <= maximum) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - length));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
    if (!bytesRead) break;
    chunks.push(chunk.subarray(0, bytesRead));
    length += bytesRead;
  }
  if (length > maximum) throw templateError(tooLargeCode, 413);
  return Buffer.concat(chunks, length);
}

async function readManifest(templateDir) {
  const manifestPath = path.join(templateDir, MANIFEST_FILE);
  const noFollow = fsSync.constants.O_NOFOLLOW || 0;
  let handle;
  try {
    handle = await fs.open(manifestPath, fsSync.constants.O_RDONLY | noFollow);
    const body = await readHandleBounded(handle, MAX_MANIFEST_BYTES, "PROJECT_TEMPLATE_INVALID");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return sanitizeManifest(JSON.parse(source));
  } catch {
    return emptyManifest();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function metadataFor(manifest, type, id) {
  const key = collisionKey(id);
  return manifest.templates.find((record) => record.type === type && collisionKey(record.id) === key) || null;
}

async function typeDirectory(templateDir, type) {
  if (!TEMPLATE_TYPES[type]) return null;
  const root = await regularDirectoryOrNull(templateDir);
  if (!root) return null;
  const directory = path.join(templateDir, TEMPLATE_TYPES[type].directory);
  return await regularDirectoryOrNull(directory) ? directory : null;
}

function templatePath(templateDir, type, fileName) {
  const config = TEMPLATE_TYPES[type];
  const name = String(fileName || "");
  if (!config || !name || name.startsWith(".") || name.includes("\0") || path.basename(name) !== name
      || path.extname(name).toLowerCase() !== config.extension) {
    throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
  }
  return path.join(templateDir, config.directory, name);
}

async function discoverType(templateDir, type, config, manifest) {
  const directory = await typeDirectory(templateDir, type);
  if (!directory) return [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }

  const eligibleEntries = entries
    .filter((entry) => {
      if (!entry.isFile() || entry.name.startsWith(".") || path.extname(entry.name).toLowerCase() !== config.extension) return false;
      const id = entry.name.slice(0, -path.extname(entry.name).length);
      try { validateTemplateId(id); return true; } catch { return false; }
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }))
    .slice(0, MAX_PROJECT_TEMPLATES_PER_TYPE);
  const candidates = await Promise.all(eligibleEntries.map(async (entry) => {
    const stat = await lstatOrNull(path.join(directory, entry.name));
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROJECT_TEMPLATE_BYTES) return null;
    return { entry, stat };
  }));
  const templates = candidates
    .filter(Boolean)
    .map(({ entry, stat }) => {
      const id = entry.name.slice(0, -path.extname(entry.name).length);
      const metadata = metadataFor(manifest, type, id);
      const title = metadata ? metadata.title : templateLabel(id);
      return {
        id,
        title,
        description: metadata ? metadata.description : "",
        type,
        default: false,
        size: stat.size,
        label: title,
        url: `/api/project-templates/${type}/${encodeURIComponent(entry.name)}`,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }));

  const configuredDefault = manifest.defaults[type];
  let selected = configuredDefault
    ? templates.find((template) => collisionKey(template.id) === collisionKey(configuredDefault))
    : null;
  if (!selected) selected = templates.find((template) => collisionKey(template.id) === collisionKey(config.defaultId));
  if (!selected) [selected] = templates;
  if (selected) selected.default = true;
  return templates;
}

async function discoverProjectTemplates(templateDir) {
  const manifest = await readManifest(templateDir);
  const pairs = await Promise.all(Object.entries(TEMPLATE_TYPES).map(async ([type, config]) =>
    [type, await discoverType(templateDir, type, config, manifest)]));
  return Object.fromEntries(pairs);
}

async function listAdminProjectTemplates(templateDir) {
  const catalog = await discoverProjectTemplates(templateDir);
  return Object.fromEntries(Object.entries(catalog).map(([type, templates]) => [
    type,
    templates.map(({ id, title, description, default: isDefault, size }) => ({
      id, title, description, type, default: isDefault, size,
    })),
  ]));
}

async function readProjectTemplate(templateDir, type, fileName) {
  const directory = await typeDirectory(templateDir, type);
  if (!directory) throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
  const filePath = templatePath(templateDir, type, fileName);
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
    const body = await readHandleBounded(handle, MAX_PROJECT_TEMPLATE_BYTES, "PROJECT_TEMPLATE_TOO_LARGE");
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (content.includes("\0")) throw new TypeError("NUL byte");
      return content;
    } catch (error) {
      if (error.errorCode) throw error;
      throw templateError("PROJECT_TEMPLATE_INVALID", 422);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeTemporaryFile(directory, body) {
  const temporary = path.join(directory, `.template-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  return temporary;
}

async function publishNoReplace(temporary, destination) {
  try {
    await fs.link(temporary, destination);
  } catch (error) {
    if (error.code === "EEXIST") throw templateError("ADMIN_TEMPLATE_EXISTS", 409);
    throw error;
  }
  await fs.unlink(temporary);
  return fs.lstat(destination);
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino && left.isFile() && right.isFile();
}

async function unlinkIfSameFile(target, expected) {
  const current = await lstatOrNull(target);
  if (!current) return;
  if (!sameFile(current, expected)) throw templateError("PROJECT_TEMPLATE_INVALID", 422);
  await fs.unlink(target);
}

async function writeManifest(templateDir, manifest) {
  const body = Buffer.from(`${JSON.stringify(sanitizeManifest(manifest), null, 2)}\n`, "utf8");
  if (body.length > MAX_MANIFEST_BYTES) throw templateError("PROJECT_TEMPLATE_INVALID", 422);
  const temporary = await writeTemporaryFile(templateDir, body);
  const destination = path.join(templateDir, MANIFEST_FILE);
  try {
    const current = await lstatOrNull(destination);
    if (current && (!current.isFile() || current.isSymbolicLink())) {
      throw templateError("PROJECT_TEMPLATE_INVALID", 422);
    }
    if (current) await fs.rename(temporary, destination);
    else await publishNoReplace(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function ensureTypeDirectories(templateDir) {
  const root = await regularDirectoryOrNull(templateDir);
  if (!root) throw templateError("PROJECT_TEMPLATE_INVALID", 422);
  for (const config of Object.values(TEMPLATE_TYPES)) {
    const directory = path.join(templateDir, config.directory);
    const current = await lstatOrNull(directory);
    if (!current) await fs.mkdir(directory);
    else if (!current.isDirectory() || current.isSymbolicLink()) throw templateError("PROJECT_TEMPLATE_INVALID", 422);
  }
}

async function isGenuinelyPristine(templateDir) {
  const entries = await fs.readdir(templateDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!Object.values(TEMPLATE_TYPES).some((config) => config.directory === entry.name) || !entry.isDirectory()) return false;
    const directory = path.join(templateDir, entry.name);
    if (!await regularDirectoryOrNull(directory) || (await fs.readdir(directory)).length) return false;
  }
  return true;
}

async function seedProjectTemplates(destination, seedDir) {
  if (!seedDir || !await regularDirectoryOrNull(seedDir)) return emptyManifest();
  const catalog = await discoverProjectTemplates(seedDir);
  for (const [type, templates] of Object.entries(catalog)) {
    const config = TEMPLATE_TYPES[type];
    const directory = path.join(destination, config.directory);
    for (const template of templates) {
      const fileName = `${template.id}${config.extension}`;
      const content = await readProjectTemplate(seedDir, type, fileName);
      const temporary = await writeTemporaryFile(directory, Buffer.from(content, "utf8"));
      try {
        await publishNoReplace(temporary, path.join(directory, fileName));
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    }
  }
  return readManifest(seedDir);
}

async function initializeProjectTemplatesUnlocked(templateDir, seedDir) {
  const root = path.resolve(templateDir);
  const current = await lstatOrNull(root);
  if (!current) {
    const parent = path.dirname(root);
    await fs.mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.${path.basename(root)}-${crypto.randomUUID()}.tmp`);
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      await Promise.all(Object.values(TEMPLATE_TYPES).map((config) => fs.mkdir(path.join(staging, config.directory))));
      const manifest = await seedProjectTemplates(staging, seedDir);
      await writeManifest(staging, manifest);
      try {
        await fs.rename(staging, root);
        return;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    return initializeProjectTemplatesUnlocked(root, seedDir);
  }
  if (!current.isDirectory() || current.isSymbolicLink()) throw templateError("PROJECT_TEMPLATE_INVALID", 422);

  const pristine = await isGenuinelyPristine(root);
  await ensureTypeDirectories(root);
  const manifestPath = path.join(root, MANIFEST_FILE);
  if (pristine) {
    const manifest = await seedProjectTemplates(root, seedDir);
    await writeManifest(root, manifest);
  } else if (!await lstatOrNull(manifestPath)) {
    // The directory already contains instance data. Mark it initialized without
    // reintroducing bundled files that an operator may have deliberately removed.
    await writeManifest(root, emptyManifest());
  }
}

function serializeMutation(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => {});
  return result;
}

async function initializeProjectTemplates(templateDir, seedDir) {
  return serializeMutation(() => initializeProjectTemplatesUnlocked(templateDir, seedDir));
}

async function storedEntries(templateDir, type) {
  const directory = await typeDirectory(templateDir, type);
  if (!directory) throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
  const config = TEMPLATE_TYPES[type];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return {
    directory,
    entries: entries.filter((entry) => !entry.name.startsWith(".")
      && path.extname(entry.name).toLowerCase() === config.extension),
  };
}

async function findStoredTemplate(templateDir, type, id) {
  const { directory, entries } = await storedEntries(templateDir, type);
  const key = collisionKey(id);
  const candidates = entries
    .filter((entry) => collisionKey(entry.name.slice(0, -path.extname(entry.name).length)) === key)
    .sort((a, b) => (a.name === `${id}${TEMPLATE_TYPES[type].extension}` ? -1 : b.name === `${id}${TEMPLATE_TYPES[type].extension}` ? 1 : a.name.localeCompare(b.name)));
  for (const entry of candidates) {
    const filePath = path.join(directory, entry.name);
    const stat = await lstatOrNull(filePath);
    if (entry.isFile() && stat && stat.isFile() && !stat.isSymbolicLink()) {
      return {
        id: entry.name.slice(0, -path.extname(entry.name).length),
        name: entry.name,
        path: filePath,
        directory,
        stat,
      };
    }
  }
  throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
}

async function assertAvailableTarget(templateDir, type, id, source = null) {
  const { directory, entries } = await storedEntries(templateDir, type);
  const key = collisionKey(id);
  const collision = entries.find((entry) => {
    if (source && source.type === type && source.name === entry.name) return false;
    return collisionKey(entry.name.slice(0, -path.extname(entry.name).length)) === key;
  });
  if (collision) throw templateError("ADMIN_TEMPLATE_EXISTS", 409);
  if (!source || source.type !== type) {
    const count = entries.filter((entry) => entry.isFile()).length;
    if (count >= MAX_PROJECT_TEMPLATES_PER_TYPE) throw templateError("PROJECT_TEMPLATE_INVALID", 422);
  }
  return { directory, path: path.join(directory, `${id}${TEMPLATE_TYPES[type].extension}`) };
}

function removeMetadata(manifest, type, id) {
  const key = collisionKey(id);
  manifest.templates = manifest.templates.filter((record) => !(record.type === type && collisionKey(record.id) === key));
  if (manifest.defaults[type] && collisionKey(manifest.defaults[type]) === key) delete manifest.defaults[type];
}

function setMetadata(manifest, template) {
  removeMetadata(manifest, template.type, template.id);
  manifest.templates.push({
    type: template.type,
    id: template.id,
    title: template.title,
    description: template.description,
  });
  if (template.default) manifest.defaults[template.type] = template.id;
}

async function getAdminProjectTemplate(templateDir, typeValue, idValue) {
  const type = validateTemplateType(typeValue);
  const id = validateTemplateId(idValue);
  const stored = await findStoredTemplate(templateDir, type, id);
  const catalog = await listAdminProjectTemplates(templateDir);
  const summary = catalog[type].find((template) => collisionKey(template.id) === collisionKey(stored.id));
  if (!summary) throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
  const content = await readProjectTemplate(templateDir, type, stored.name);
  return { ...summary, content };
}

async function createProjectTemplate(templateDir, input) {
  const template = validateProjectTemplate(input);
  return serializeMutation(async () => {
    await ensureTypeDirectories(templateDir);
    const target = await assertAvailableTarget(templateDir, template.type, template.id);
    const temporary = await writeTemporaryFile(target.directory, Buffer.from(template.content, "utf8"));
    let published;
    try {
      published = await publishNoReplace(temporary, target.path);
      const manifest = await readManifest(templateDir);
      setMetadata(manifest, template);
      await writeManifest(templateDir, manifest);
    } catch (error) {
      if (published) await unlinkIfSameFile(target.path, published).catch(() => {});
      throw error;
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return getAdminProjectTemplate(templateDir, template.type, template.id);
  });
}

async function updateProjectTemplate(templateDir, currentTypeValue, currentIdValue, input) {
  const currentType = validateTemplateType(currentTypeValue);
  const currentId = validateTemplateId(currentIdValue);
  const template = validateProjectTemplate(input);
  return serializeMutation(async () => {
    await ensureTypeDirectories(templateDir);
    const source = await findStoredTemplate(templateDir, currentType, currentId);
    const target = await assertAvailableTarget(templateDir, template.type, template.id, { type: currentType, name: source.name });
    const temporary = await writeTemporaryFile(target.directory, Buffer.from(template.content, "utf8"));
    const backup = path.join(source.directory, `.template-${crypto.randomUUID()}.bak`);
    let published;
    try {
      await fs.rename(source.path, backup);
      const moved = await lstatOrNull(backup);
      if (!sameFile(source.stat, moved)) {
        if (moved) await fs.rename(backup, source.path).catch(() => {});
        throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
      }
      published = await publishNoReplace(temporary, target.path);
      const manifest = await readManifest(templateDir);
      removeMetadata(manifest, currentType, source.id);
      setMetadata(manifest, template);
      await writeManifest(templateDir, manifest);
      await unlinkIfSameFile(backup, source.stat).catch(() => {});
    } catch (error) {
      if (published) await unlinkIfSameFile(target.path, published).catch(() => {});
      if (await lstatOrNull(backup)) await fs.rename(backup, source.path).catch(() => {});
      throw error;
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return getAdminProjectTemplate(templateDir, template.type, template.id);
  });
}

async function deleteProjectTemplate(templateDir, typeValue, idValue) {
  const type = validateTemplateType(typeValue);
  const id = validateTemplateId(idValue);
  return serializeMutation(async () => {
    await ensureTypeDirectories(templateDir);
    const source = await findStoredTemplate(templateDir, type, id);
    const backup = path.join(source.directory, `.template-${crypto.randomUUID()}.bak`);
    try {
      await fs.rename(source.path, backup);
      const moved = await lstatOrNull(backup);
      if (!sameFile(source.stat, moved)) {
        if (moved) await fs.rename(backup, source.path).catch(() => {});
        throw templateError("PROJECT_TEMPLATE_NOT_FOUND", 404);
      }
      const manifest = await readManifest(templateDir);
      removeMetadata(manifest, type, source.id);
      await writeManifest(templateDir, manifest);
      await unlinkIfSameFile(backup, source.stat).catch(() => {});
      return { ok: true };
    } catch (error) {
      if (await lstatOrNull(backup)) await fs.rename(backup, source.path).catch(() => {});
      throw error;
    }
  });
}

module.exports = {
  TEMPLATE_TYPES,
  MANIFEST_FILE,
  MAX_PROJECT_TEMPLATE_BYTES,
  MAX_PROJECT_TEMPLATES_PER_TYPE,
  templateLabel,
  templateError,
  validateTemplateType,
  validateTemplateId,
  validateProjectTemplate,
  sanitizeManifest,
  initializeProjectTemplates,
  discoverProjectTemplates,
  listAdminProjectTemplates,
  readProjectTemplate,
  getAdminProjectTemplate,
  createProjectTemplate,
  updateProjectTemplate,
  deleteProjectTemplate,
};
