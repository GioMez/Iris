const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { PassThrough, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const tar = require("tar-stream");
const { logicalPath, freeze, fail } = require("./contracts");
const { checkedPath, openCheckedFile, readWorkspaceLimits } = require("./workspaces");

const relative = value => logicalPath(value, "PIPELINE_PATH_INVALID");
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pathError = () => fail("PIPELINE_PATH_INVALID", "Invalid pipeline transfer path");
const limitError = () => fail("PIPELINE_OUTPUT_LIMIT", "Pipeline transfer exceeds its output budget");

function createTransferArchive(manifest, { signal } = {}) {
  const pack = tar.pack(), stream = new PassThrough();
  // Native streams retain early failures for consumers that attach after setup.
  // pipeline forwards the error and propagates consumer cancellation to the pack.
  pipeline(pack, stream, { signal }).catch(() => {});
  (async () => {
    signal?.throwIfAborted();
    if (!manifest || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) pathError();
    const files = manifest.files.map(file => ({ ...file, path: relative(file.path) })).sort((a, b) => compare(a.path, b.path));
    const directories = manifest.directories.map(relative).sort(compare), paths = new Set();
    for (const file of files) {
      if (paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.contentHash)) pathError();
      paths.add(file.path);
    }
    if (new Set(directories).size !== directories.length) pathError();
    for (const rel of [...paths, ...directories]) {
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) pathError();
    }
    for (const rel of directories) {
      signal?.throwIfAborted();
      if (paths.has(rel)) pathError();
      await checkedPath(manifest.root, rel, true);
      await new Promise((resolve, reject) => pack.entry({ name: rel, type: "directory", mode: 0o700, mtime: new Date(0) }, error => error ? reject(error) : resolve()));
    }
    for (const file of files) {
      signal?.throwIfAborted();
      // Only host transfer manifests can select a different checked source.
      // Archive names stay logical; private source paths never enter the tar.
      const { input, before } = await openCheckedFile(file.source?.root ?? manifest.root, file.source?.path ?? file.path);
      try {
        if (before.size !== file.size) fail("PIPELINE_INPUT_CHANGED", "Pipeline input no longer matches its manifest");
        const digest = createHash("sha256");
        let size = 0;
        const changed = () => Object.assign(new Error("Pipeline input changed during transfer"), { code: "PIPELINE_INPUT_CHANGED" });
        const hash = new Transform({
          transform(chunk, encoding, callback) {
            size += chunk.length;
            if (size > file.size) return callback(changed());
            digest.update(chunk); callback(null, chunk);
          },
          flush(callback) { callback(size === file.size ? null : changed()); },
        });
        const entry = pack.entry({ name: file.path, size: file.size, type: "file", mode: 0o400, mtime: new Date(0) });
        await pipeline(input.createReadStream({ autoClose: false, highWaterMark: 65536 }), hash, entry, { signal });
        const after = await input.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1
          || digest.digest("hex") !== file.contentHash) fail("PIPELINE_INPUT_CHANGED", "Pipeline input changed during transfer");
      } finally { await input.close(); }
    }
    pack.finalize();
  })().catch(error => pack.destroy(error));
  return stream;
}

async function extractTransferArchive(source, destination, policy = {}, { signal } = {}) {
  const budget = readWorkspaceLimits(policy), extract = tar.extract();
  const maxArchiveBytes = budget.maxOutputBytes + (budget.maxOutputEntries + 1) * 8192 + 4194304;
  if (!Number.isSafeInteger(maxArchiveBytes)) fail("PIPELINE_POLICY_INVALID", "Invalid pipeline transfer budget");
  let created = false, pumping, bytes = 0, archiveBytes = 0, rootSeen = false, bodyEnd = 0, zeroTail = 0;
  const declared = new Set(), directories = new Set(), files = new Map();
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    archiveBytes += chunk.length;
    try {
      if (archiveBytes > maxArchiveBytes) limitError();
      let end = chunk.length;
      while (end > Math.max(0, chunk.length - 1024) && chunk[end - 1] === 0) end--;
      zeroTail = end === 0 ? Math.min(1024, zeroTail + chunk.length) : chunk.length - end;
      callback(null, chunk);
    }
    catch (error) { callback(error); }
  } });
  function countEntry() { if (directories.size + files.size + 1 > budget.maxOutputEntries) limitError(); }
  async function directory(rel) {
    if (files.has(rel)) pathError();
    if (directories.has(rel)) return;
    countEntry();
    await fs.mkdir(path.join(destination, rel), { mode: 0o700 });
    directories.add(rel);
  }
  try {
    signal?.throwIfAborted();
    await fs.mkdir(destination, { mode: 0o700 }); created = true;
    pumping = pipeline(source, limiter, extract, { signal });
    pumping.catch(() => {});
    for await (const entry of extract) {
      signal?.throwIfAborted();
      const header = entry.header;
      if (!["file", "directory"].includes(header.type) || header.linkname || Object.keys(header.pax || {}).some(key => key.startsWith("GNU.sparse"))) pathError();
      if (!Number.isSafeInteger(header.size) || header.size < 0 || (header.type === "directory" && header.size !== 0)) pathError();
      if (header.pax && Object.hasOwn(header.pax, "size") && (!/^\d+$/.test(header.pax.size) || Number(header.pax.size) !== header.size)) pathError();
      bodyEnd = header.byteOffset + Math.ceil(header.size / 512) * 512;
      let rel = header.name;
      if (header.type === "directory" && [".", "./"].includes(rel)) {
        if (rootSeen) pathError();
        rootSeen = true; entry.resume(); continue;
      }
      if (rel.startsWith("./")) rel = rel.slice(2);
      if (header.type === "directory" && rel.endsWith("/")) rel = rel.slice(0, -1);
      relative(rel);
      if (declared.has(rel)) pathError();
      declared.add(rel);
      if (header.size > budget.maxArtifactBytes || bytes + header.size > budget.maxOutputBytes) limitError();
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) await directory(parts.slice(0, i).join("/"));
      if (header.type === "directory") { await directory(rel); entry.resume(); continue; }
      if (directories.has(rel) || files.has(rel)) pathError();
      countEntry();
      const output = await fs.open(path.join(destination, rel), "wx", 0o600), digest = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of entry) {
          signal?.throwIfAborted();
          size += chunk.length;
          if (size > header.size || bytes + size > budget.maxOutputBytes) limitError();
          digest.update(chunk);
          let written = 0;
          while (written < chunk.length) {
            const result = await output.write(chunk, written, chunk.length - written, null);
            if (!result.bytesWritten) fail("PIPELINE_COPY_FAILED", "Pipeline transfer made no progress");
            written += result.bytesWritten;
          }
        }
        if (size !== header.size) fail("PIPELINE_TRANSFER_INVALID", "Incomplete pipeline transfer entry");
        await output.chmod(0o400);
      } finally { await output.close(); }
      bytes += size; files.set(rel, { path: rel, size, contentHash: digest.digest("hex") });
    }
    await pumping;
    // tar-stream accepts EOF at a header boundary. Transfers require both end
    // blocks after the last body, including when that body's own bytes are zero.
    if (archiveBytes % 512 || archiveBytes < bodyEnd + 1024 || zeroTail < 1024) {
      fail("PIPELINE_TRANSFER_INVALID", "Incomplete pipeline transfer archive");
    }
    return freeze({ root: destination, files: [...files.values()].sort((a, b) => compare(a.path, b.path)), directories: [...directories].sort(compare) });
  } catch (error) {
    source.destroy(); extract.destroy(); limiter.destroy();
    await pumping?.catch(() => {});
    if (created) await fs.rm(destination, { recursive: true, force: true });
    if (!error.code || /^(?:ERR_)?STREAM_/.test(error.code)) {
      throw Object.assign(new Error("Invalid pipeline transfer stream"), { code: "PIPELINE_TRANSFER_INVALID", cause: error });
    }
    throw error;
  }
}

module.exports = { createTransferArchive, extractTransferArchive };
