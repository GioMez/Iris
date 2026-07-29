const crypto = require("node:crypto");
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

async function resolveBuildArtifact(projectStorageDir, buildId, buildPath, artifactPath) {
  const directory = await resolveBuildDirectory(projectStorageDir, buildId, buildPath);
  if (!directory) return null;
  const expectedPrefix = `${buildPath}/`;
  if (!artifactPath.startsWith(expectedPrefix)) throw new Error(`Invalid artifact path for build ${buildId}`);
  const relative = artifactPath.slice(expectedPrefix.length);
  if (!relative || path.posix.basename(relative) !== relative) throw new Error(`Invalid artifact path for build ${buildId}`);

  const directoryReal = await fs.realpath(directory).catch(() => null);
  const artifactReal = await fs.realpath(path.join(directory, relative)).catch(() => null);
  if (!directoryReal || !artifactReal || !artifactReal.startsWith(directoryReal + path.sep)) return null;
  const stat = await fs.stat(artifactReal).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  return { path: artifactReal, size: stat.size };
}

module.exports = {
  buildStoragePath,
  publishCompileOutput,
  versionCompileArtifacts,
  hashBuildArtifacts,
  resolveBuildDirectory,
  resolveBuildArtifact,
};
