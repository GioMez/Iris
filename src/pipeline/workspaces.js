const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { cloneValue, readPolicy, logicalPath, name, canonical, freeze, fail, SNAPSHOT_TYPE } = require("./contracts");

const owned = new WeakMap(), products = new WeakMap(), contexts = new WeakMap();
const DEFAULT_LIMITS = Object.freeze({ maxArtifactBytes: 134217728, maxOutputBytes: 536870912, maxOutputEntries: 20000 });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pathError = () => fail("PIPELINE_PATH_INVALID", "Invalid pipeline workspace path");

function relative(value) { return logicalPath(value, "PIPELINE_PATH_INVALID"); }
function state(workspace) {
  const value = owned.get(workspace);
  if (!value || value.disposed) fail("PIPELINE_WORKSPACE_INVALID", "Pipeline workspace is not active");
  return value;
}
function limits(policy) {
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(policy)) {
    if (key === "root") continue;
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < 1) fail("PIPELINE_POLICY_INVALID", "Invalid workspace limit");
    result[key] = value;
  }
  return Object.freeze(result);
}

// The caller holds the source gate; workers cannot mutate this host tree. Check
// each component as well as the opened inode, so links never become inputs.
async function checkedPath(root, rel, directory = false) {
  const parts = relative(rel).split("/");
  let current = root, info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) pathError();
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    info = await fs.lstat(current);
    if (index < parts.length - 1 || directory) {
      if (!info.isDirectory() || info.isSymbolicLink()) pathError();
    } else if (!info.isFile() || info.nlink !== 1) pathError();
  }
  return { file: current, info };
}

async function openCheckedFile(root, rel) {
  const { file, info } = await checkedPath(root, rel);
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.nlink !== 1 || before.dev !== info.dev || before.ino !== info.ino) pathError();
    return { input, before };
  } catch (error) { await input.close(); throw error; }
}

// Hash and copy in one bounded-buffer pass, including binary and large sources.
async function copyFile(root, rel, destination, maxBytes = Infinity, expected = null, signal = null) {
  signal?.throwIfAborted();
  const { input, before } = await openCheckedFile(root, rel);
  let output;
  try {
    if (before.size > maxBytes) fail("PIPELINE_OUTPUT_LIMIT", "Pipeline output exceeds its byte limit");
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    output = await fs.open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(65536), digest = createHash("sha256");
    let size = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) fail("PIPELINE_OUTPUT_LIMIT", "Pipeline output exceeds its byte limit");
      digest.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, null);
        if (!result.bytesWritten) fail("PIPELINE_COPY_FAILED", "Pipeline file copy made no progress");
        written += result.bytesWritten;
      }
    }
    const after = await input.stat(), contentHash = digest.digest("hex");
    if (before.size !== size || after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1) {
      fail("PIPELINE_INPUT_CHANGED", "Pipeline file changed during copying");
    }
    if (expected && (size !== expected.size || contentHash !== expected.contentHash)) fail("PIPELINE_INPUT_CHANGED", "Pipeline input no longer matches its manifest");
    await output.chmod(0o400);
    return { path: rel, size, contentHash };
  } finally {
    try { await output?.close(); } finally { await input.close(); }
  }
}

async function createRunWorkspace(snapshot, policy, { signal } = {}) {
  signal?.throwIfAborted();
  const budget = limits(policy);
  const settings = freeze(cloneValue(snapshot.settings, readPolicy()));
  const files = snapshot.files.map(file => ({ id: file.id, path: relative(file.path) })).sort((a, b) => compare(a.path, b.path));
  const directories = [...new Set(snapshot.directories.map(relative))].sort(compare);
  const paths = new Set();
  for (const file of files) {
    if (typeof file.id !== "string" || !file.id || paths.has(file.path)) pathError();
    paths.add(file.path);
  }
  for (const rel of [...paths, ...directories]) {
    if ([".iris", "output"].includes(rel.split("/", 1)[0].toLowerCase())) pathError();
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) pathError();
  }
  if (directories.some(rel => paths.has(rel))) pathError();
  const source = path.resolve(snapshot.root);
  await fs.mkdir(policy.root, { recursive: true, mode: 0o700 });
  const parent = await fs.realpath(policy.root), root = await fs.mkdtemp(path.join(parent, "run-"));
  try {
    await fs.chmod(root, 0o700);
    const snapshotRoot = path.join(root, "snapshot");
    await fs.mkdir(snapshotRoot, { mode: 0o700 });
    for (const rel of directories) {
      signal?.throwIfAborted();
      await checkedPath(source, rel, true);
      await fs.mkdir(path.join(snapshotRoot, rel), { recursive: true, mode: 0o700 });
    }
    const manifest = [], digest = createHash("sha256").update("iris-snapshot-v1\0").update(canonical(settings)).update("\0");
    for (const rel of directories) digest.update(JSON.stringify(["directory", rel])).update("\0");
    for (const file of files) {
      const copied = await copyFile(source, file.path, path.join(snapshotRoot, file.path), Infinity, null, signal);
      manifest.push({ id: file.id, ...copied });
      digest.update(JSON.stringify(["file", file.id, file.path, copied.size, copied.contentHash])).update("\0");
    }
    const workspace = freeze({ root, snapshotHash: digest.digest("hex"),
      snapshot: { root: snapshotRoot, kind: "collection", mediaType: SNAPSHOT_TYPE, files: manifest, directories, settings } });
    owned.set(workspace, { steps: new Map(), budget, bytes: 0, entries: 0, disposed: false });
    products.set(workspace.snapshot, workspace);
    return workspace;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function materializeInputs(workspace, value, artifacts, { signal, policy } = {}) {
  signal?.throwIfAborted();
  const current = state(workspace), step = freeze(cloneValue(value, readPolicy(policy)));
  name(step.id);
  if (current.steps.has(step.id)) fail("PIPELINE_STEP_REUSED", "Pipeline step workspace already exists");
  const root = path.join(workspace.root, "steps", step.id), outputDir = path.join(root, "output"), workDir = path.join(root, "work");
  const entry = { step, context: null, products: null };
  current.steps.set(step.id, entry);
  try {
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(workDir, { mode: 0o700 });
    const inputs = {};
    for (const [key, ref] of Object.entries(step.inputs || {})) {
      signal?.throwIfAborted();
      name(key);
      const input = ref.snapshot === true ? workspace.snapshot : artifacts.get(`${ref.step}:${ref.port}`);
      if (!input || products.get(input) !== workspace) fail("PIPELINE_INPUT_INVALID", "Pipeline input has no validated producer");
      if (ref.snapshot !== true && (input.producerStep !== ref.step || input.outputPort !== ref.port)) fail("PIPELINE_INPUT_INVALID", "Pipeline input producer does not match its reference");
      const inputRoot = path.join(root, "inputs", key);
      await fs.mkdir(inputRoot, { recursive: true, mode: 0o700 });
      for (const rel of input.directories) await fs.mkdir(path.join(inputRoot, rel), { recursive: true, mode: 0o700 });
      for (const file of input.files) await copyFile(input.root, file.path, path.join(inputRoot, file.path), file.size, file, signal);
      inputs[key] = freeze({ ...input, root: inputRoot });
    }
    // AbortSignal retains mutable internal state; freeze only our metadata.
    entry.context = Object.freeze({ ...freeze({ root, outputDir, workDir, inputs, step, options: step.options || {} }), signal });
    contexts.set(entry.context, workspace);
    return entry.context;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function materializeOverlay(context, inputNames, { signal } = {}) {
  const workspace = contexts.get(context);
  state(workspace);
  signal?.throwIfAborted();
  if (!Array.isArray(inputNames) || !inputNames.length || new Set(inputNames).size !== inputNames.length) fail("PIPELINE_INPUT_INVALID", "Invalid overlay input selection");
  const files = new Map(), directories = new Set();
  for (const key of inputNames) {
    if (!Object.hasOwn(context.inputs, key)) fail("PIPELINE_INPUT_INVALID", "Unknown overlay input");
    const input = context.inputs[key];
    for (const rel of input.directories) directories.add(rel);
    for (const file of input.files) {
      if (files.has(file.path)) fail("PIPELINE_INPUT_COLLISION", "Overlay inputs have conflicting paths");
      files.set(file.path, { input, file });
      const parts = file.path.split("/");
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
    }
  }
  for (const rel of directories) {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      if (files.has(parts.slice(0, i).join("/"))) fail("PIPELINE_INPUT_COLLISION", "Overlay inputs have conflicting paths");
    }
  }
  const root = path.join(context.root, "overlay");
  await fs.mkdir(root, { mode: 0o700 });
  try {
    for (const rel of directories) {
      signal?.throwIfAborted();
      await fs.mkdir(path.join(root, rel), { recursive: true, mode: 0o700 });
    }
    const manifest = [];
    for (const [rel, { input, file }] of [...files].sort(([a], [b]) => compare(a, b))) {
      const copied = await copyFile(input.root, rel, path.join(root, rel), file.size, file, signal);
      manifest.push({ ...file, ...copied });
    }
    return freeze({ root, files: manifest, directories: [...directories].sort(compare) });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function validateOutputs(workspace, step, { signal } = {}) {
  signal?.throwIfAborted();
  const current = state(workspace), entry = current.steps.get(step.id);
  if (!entry?.context || !isDeepStrictEqual(entry.step, step)) fail("PIPELINE_STEP_INVALID", "Pipeline outputs require their original step");
  if (entry.products) return entry.products;
  const declarations = Object.entries(step.outputs || {}), files = [], directories = [];
  let bytes = 0, entries = 0;
  async function walk(dir, prefix = "") {
    const handle = await fs.opendir(dir);
    for await (const item of handle) {
      signal?.throwIfAborted();
      const rel = relative(prefix ? `${prefix}/${item.name}` : item.name), full = path.join(dir, item.name), info = await fs.lstat(full);
      if (++entries + current.entries > current.budget.maxOutputEntries) fail("PIPELINE_OUTPUT_LIMIT", "Pipeline output exceeds its entry limit");
      if (info.isDirectory()) {
        if (!declarations.some(([, out]) => out.path.startsWith(`${rel}/`) || (out.kind === "collection" && (rel === out.path || rel.startsWith(`${out.path}/`))))) {
          fail("PIPELINE_OUTPUT_UNDECLARED", "Pipeline produced an undeclared directory");
        }
        directories.push(rel); await walk(full, rel);
      } else {
        if (!info.isFile() || info.nlink !== 1) pathError();
        if (!declarations.some(([, out]) => out.kind === "collection" ? rel.startsWith(`${out.path}/`) : rel === out.path)) {
          fail("PIPELINE_OUTPUT_UNDECLARED", "Pipeline produced an undeclared file");
        }
        bytes += info.size;
        if (info.size > current.budget.maxArtifactBytes || bytes + current.bytes > current.budget.maxOutputBytes) fail("PIPELINE_OUTPUT_LIMIT", "Pipeline output exceeds its byte limit");
        files.push({ path: rel, size: info.size });
      }
    }
  }
  const source = entry.context.outputDir;
  if (!(await fs.lstat(source)).isDirectory()) pathError();
  await walk(source);
  files.sort((a, b) => compare(a.path, b.path)); directories.sort(compare);
  for (const [, out] of declarations) {
    relative(out.path);
    if (out.kind === "collection" ? !directories.includes(out.path) : !files.some(file => file.path === out.path)) {
      fail("PIPELINE_OUTPUT_MISSING", "Pipeline did not produce a declared output");
    }
  }
  const root = path.join(workspace.root, "artifacts", step.id);
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const manifest = [];
    for (const rel of directories) await fs.mkdir(path.join(root, rel), { recursive: true, mode: 0o700 });
    for (const file of files) manifest.push(await copyFile(source, file.path, path.join(root, file.path), file.size, null, signal));
    const result = declarations.map(([outputPort, out]) => freeze({ ...out, root, producerStep: step.id, outputPort,
      files: manifest.filter(file => out.kind === "collection" ? file.path.startsWith(`${out.path}/`) : file.path === out.path),
      directories: directories.filter(rel => out.kind === "collection" && (rel === out.path || rel.startsWith(`${out.path}/`))) }));
    for (const product of result) products.set(product, workspace);
    current.bytes += bytes; current.entries += entries;
    entry.products = Object.freeze(result);
    return entry.products;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function disposeRunWorkspace(workspace) {
  const current = owned.get(workspace);
  if (!current) fail("PIPELINE_WORKSPACE_INVALID", "Cannot dispose an unowned workspace");
  await fs.rm(workspace.root, { recursive: true, force: true });
  current.disposed = true;
}

module.exports = { createRunWorkspace, materializeInputs, materializeOverlay, validateOutputs, disposeRunWorkspace,
  checkedPath, openCheckedFile, readWorkspaceLimits: limits };
