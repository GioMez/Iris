const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { checkedPath, openCheckedFile } = require("./workspaces");
const { validatePublication } = require("./runs");

const RECEIPT = ".iris-pipeline-publication.jsonl";

// One validated record per line preserves the accepted 20,000-artifact capacity
// without assembling another encoded copy of the complete manifest.
async function writePublicationReceipt(root, runId, manifest) {
  const handle = await fs.open(path.join(root, RECEIPT), "wx", 0o400);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, runId, hash: manifest.hash }) + "\n");
    for (const artifact of manifest.artifacts) await handle.writeFile(JSON.stringify(artifact) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
}

async function inspectPublication(projectRoot, row, store) {
  const relative = `output/${row.id}`;
  if (row.publication_path !== relative) return { state: "unavailable" };
  let root;
  try { root = (await checkedPath(projectRoot, relative, true)).file; }
  catch (error) { return { state: error.code === "ENOENT" ? "absent" : "unavailable" }; }
  try {
    const { input, before } = await openCheckedFile(root, RECEIPT);
    const records = [], decoder = new StringDecoder("utf8");
    let pending = "", size = 0, header;
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        size += chunk.length; pending += decoder.write(chunk);
        for (let end; (end = pending.indexOf("\n")) !== -1;) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (Buffer.byteLength(line) > 1048576) throw new Error("Publication record exceeds its limit");
          if (!header) header = JSON.parse(line);
          else {
            if (records.length >= 20000) throw new Error("Publication manifest exceeds its limit");
            records.push(JSON.parse(line));
          }
        }
        if (Buffer.byteLength(pending) > 1048576) throw new Error("Publication record exceeds its limit");
      }
      const after = await input.stat();
      if (pending + decoder.end() || size !== before.size || after.size !== size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Publication receipt changed");
    } finally { await input.close(); }
    if (header?.version !== 1 || header.runId !== row.id || header.hash !== row.publication_hash) return { state: "unavailable" };
    const manifest = validatePublication(store, row.id, records);
    if (manifest.hash !== row.publication_hash || manifest.path !== row.publication_path) return { state: "unavailable" };
    for (const artifact of manifest.artifacts) {
      const file = artifact.storagePath.slice(relative.length + 1), { input, before } = await openCheckedFile(root, file);
      try {
        if (before.size !== artifact.size) return { state: "unavailable" };
        const hash = createHash("sha256"); let size = 0;
        for await (const bytes of input.createReadStream({ autoClose: false })) { size += bytes.length; hash.update(bytes); }
        const after = await input.stat();
        if (size !== artifact.size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || hash.digest("hex") !== artifact.contentHash) return { state: "unavailable" };
      } finally { await input.close(); }
    }
    return { state: "matching" };
  } catch { return { state: "unavailable" }; }
}

module.exports = { RECEIPT, writePublicationReceipt, inspectPublication };
