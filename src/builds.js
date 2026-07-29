const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

function buildStoragePath(buildId) {
  return `output/${buildId}`;
}

async function secureOutputRoot(projectStorageDir, create = false) {
  const projectReal = await fs.realpath(projectStorageDir);
  const output = path.join(projectStorageDir, "output");
  if (create) await fs.mkdir(output, { recursive: true });
  const outputStat = await fs.lstat(output).catch(() => null);
  if (!outputStat) return null;
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error("Invalid project output directory");
  }
  const outputReal = await fs.realpath(output);
  if (!outputReal.startsWith(projectReal + path.sep)) throw new Error("Invalid project output directory");
  return outputReal;
}

// Both paths live below DATA_DIR, so rename publishes the complete directory in
// one filesystem operation. Readers can never observe a partially copied build.
async function publishCompileOutput(stagedOutputDir, projectStorageDir, buildId) {
  const relative = buildStoragePath(buildId);
  const output = await secureOutputRoot(projectStorageDir, true);
  const destination = path.join(output, buildId);
  if (await fs.lstat(destination).catch(() => null)) throw new Error(`Build ${buildId} is already published`);
  await fs.rename(stagedOutputDir, destination);
  return relative;
}

function versionCompileArtifacts(artifacts, buildId, generateId) {
  const storageDir = buildStoragePath(buildId);
  return artifacts.map((artifact) => {
    const name = path.posix.basename(String(artifact.name || ""));
    const content = Buffer.from(artifact.base64 || "", "base64");
    return {
      ...artifact,
      id: generateId(),
      fileName: name,
      name: `${storageDir}/${name}`,
      storagePath: `${storageDir}/${name}`,
      size: content.length,
      contentHash: crypto.createHash("sha256").update(content).digest("hex"),
    };
  });
}

// Hash the ordered artifact manifest rather than concatenated bytes so file
// boundaries and names are part of the build identity.
function hashBuildArtifacts(artifacts) {
  const hash = crypto.createHash("sha256");
  for (const artifact of [...artifacts].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    hash.update(artifact.fileName);
    hash.update("\0");
    hash.update(artifact.contentHash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function resolveBuildDirectory(projectStorageDir, buildId, storagePath) {
  const expected = buildStoragePath(buildId);
  if (storagePath !== expected) throw new Error(`Invalid storage path for build ${buildId}`);
  const output = await secureOutputRoot(projectStorageDir);
  if (!output) return null;
  const directory = path.join(output, buildId);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Invalid storage directory for build ${buildId}`);
  const real = await fs.realpath(directory);
  if (!real.startsWith(output + path.sep)) throw new Error(`Invalid storage directory for build ${buildId}`);
  return real;
}

function normalizeBuildRelativePath(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error("Invalid build file path");
  }
  const normalized = path.posix.normalize(raw);
  if (normalized !== raw || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Invalid build file path");
  }
  return normalized;
}

function buildLimitError(code = "BUILD_ARCHIVE_TOO_LARGE") {
  const error = new Error("Build directory exceeds configured limits");
  error.code = code;
  return error;
}

async function walkBuildDirectory(directory, includeContents = false, limits = {}) {
  const files = [];
  const directories = [];
  const maxBytes = Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 0 ? limits.maxBytes : Infinity;
  const maxEntries = Number.isSafeInteger(limits.maxEntries) && limits.maxEntries >= 0 ? limits.maxEntries : Infinity;
  const limitErrorCode = limits.errorCode || "BUILD_ARCHIVE_TOO_LARGE";
  let totalBytes = 0;
  let totalEntries = 0;
  const walk = async (absoluteBase, relativeBase = "") => {
    const entries = await fs.readdir(absoluteBase, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name || entry.name.includes("\0") || entry.name.includes("\\")) continue;
      const relative = relativeBase ? path.posix.join(relativeBase, entry.name) : entry.name;
      const absolute = path.join(absoluteBase, entry.name);
      const stat = await fs.lstat(absolute).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        totalEntries += 1;
        if (totalEntries > maxEntries) throw buildLimitError(limitErrorCode);
        directories.push({ path: relative, mtime: stat.mtime });
        await walk(absolute, relative);
      } else if (stat.isFile()) {
        totalEntries += 1;
        totalBytes += stat.size;
        if (totalEntries > maxEntries || totalBytes > maxBytes) throw buildLimitError(limitErrorCode);
        files.push({
          path: relative,
          name: path.posix.basename(relative),
          size: stat.size,
          mtime: stat.mtime,
          ...(includeContents ? { data: await fs.readFile(absolute) } : {}),
        });
      }
    }
  };
  await walk(directory);
  return { files, directories };
}

async function listBuildFiles(projectStorageDir, buildId, storagePath, limits = {}) {
  const directory = await resolveBuildDirectory(projectStorageDir, buildId, storagePath);
  if (!directory) return [];
  try {
    return (await walkBuildDirectory(directory, false, limits)).files;
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function collectBuildArchiveEntries(projectStorageDir, buildId, storagePath, limits = {}) {
  const directory = await resolveBuildDirectory(projectStorageDir, buildId, storagePath);
  if (!directory) return null;
  let contents;
  try {
    contents = await walkBuildDirectory(directory, true, limits);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  const { files, directories } = contents;
  return [
    ...directories.map((entry) => ({ name: entry.path, directory: true, mtime: entry.mtime })),
    ...files.map((entry) => ({ name: entry.path, data: entry.data, mtime: entry.mtime })),
  ];
}

async function resolveBuildFile(projectStorageDir, buildId, storagePath, requestedPath) {
  const relative = normalizeBuildRelativePath(requestedPath);
  const directory = await resolveBuildDirectory(projectStorageDir, buildId, storagePath);
  if (!directory) return null;
  let current = directory;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) return null;
    if (index < parts.length - 1 && !stat.isDirectory()) return null;
    if (index === parts.length - 1 && !stat.isFile()) return null;
  }
  const real = await fs.realpath(current).catch(() => null);
  if (!real || !real.startsWith(directory + path.sep)) return null;
  const noFollow = fsSync.constants.O_NOFOLLOW || 0;
  const handle = await fs.open(real, fsSync.constants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) return null;
  const stat = await handle.stat().catch(() => null);
  if (!stat || !stat.isFile()) {
    await handle.close().catch(() => {});
    return null;
  }
  return { handle, path: real, size: stat.size, name: path.posix.basename(relative), relativePath: relative };
}

async function resolveBuildArtifact(projectStorageDir, buildId, buildPath, artifactPath) {
  const expectedPrefix = `${buildPath}/`;
  if (!artifactPath.startsWith(expectedPrefix)) throw new Error(`Invalid artifact path for build ${buildId}`);
  const relative = artifactPath.slice(expectedPrefix.length);
  if (!relative || path.posix.basename(relative) !== relative) throw new Error(`Invalid artifact path for build ${buildId}`);
  return resolveBuildFile(projectStorageDir, buildId, buildPath, relative);
}

module.exports = {
  buildStoragePath,
  publishCompileOutput,
  versionCompileArtifacts,
  hashBuildArtifacts,
  resolveBuildDirectory,
  resolveBuildArtifact,
  normalizeBuildRelativePath,
  listBuildFiles,
  collectBuildArchiveEntries,
  resolveBuildFile,
};
