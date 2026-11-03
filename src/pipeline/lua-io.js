const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { logicalPath, name, record, fail, readPolicy, validateLuaDiagnostic } = require("./contracts");
const { readWorkspaceLimits } = require("./workspaces");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pathError = () => fail("PIPELINE_PATH_INVALID", "Invalid Lua workspace path");

function readLuaFile(root, relative, expected, limit) {
  logicalPath(relative, "PIPELINE_INPUT_INVALID");
  const file = path.join(root, relative);
  if (fs.realpathSync(file) !== file) pathError();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) pathError();
    if (expected && info.size !== expected.size) fail("PIPELINE_INPUT_CHANGED", "Lua input identity changed");
    if (info.size > limit) fail("PIPELINE_INPUT_LIMIT", "Lua input exceeds its read limit");
    const value = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < value.length) {
      const count = fs.readSync(fd, value, offset, value.length - offset, offset);
      if (!count) fail("PIPELINE_INPUT_CHANGED", "Lua input identity changed");
      offset += count;
    }
    if (fs.fstatSync(fd).size !== info.size || (expected && hash(value) !== expected.contentHash)) fail("PIPELINE_INPUT_CHANGED", "Lua input identity changed");
    return value;
  } finally { fs.closeSync(fd); }
}

// Worker-private synchronous I/O. The engine supplies an immutable input mount;
// only these callbacks write the separate output tree. Lua never receives paths
// into either tree or an operating-system file handle.
function createLuaIO({ inputRoot, outputRoot, inputs, outputs, limits = {}, eventLimits = {}, emit = () => {} }) {
  const budget = readWorkspaceLimits(limits), declaredInputs = new Map(), declaredOutputs = new Map();
  const events = { maxLogBytes: 1048576, maxDiagnosticBytes: 1048576, maxEvents: 1000 };
  for (const [key, value] of Object.entries(eventLimits)) {
    if (!Object.hasOwn(events, key) || !Number.isSafeInteger(value) || value < 1) fail("PIPELINE_POLICY_INVALID", "Invalid Lua event limit");
    events[key] = value;
  }
  const diagnostics = [], valuePolicy = readPolicy();
  let logBytes = 0, diagnosticBytes = 2, logCount = 0, logsTruncated = false;
  const inputBase = path.resolve(inputRoot), outputBase = path.resolve(outputRoot);
  for (const root of [inputBase, outputBase]) {
    if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) pathError();
  }
  record(inputs, null, "PIPELINE_INPUT_INVALID", "Lua inputs");
  record(outputs, null, "PIPELINE_OUTPUT_UNDECLARED", "Lua outputs");
  for (const [key, input] of Object.entries(inputs)) {
    name(key, "PIPELINE_INPUT_INVALID");
    if (!input || !Array.isArray(input.files) || input.files.length > 20000) fail("PIPELINE_INPUT_INVALID", "Invalid Lua input members");
    const members = new Map();
    for (const file of input.files) {
      const relative = logicalPath(file.path, "PIPELINE_INPUT_INVALID");
      if (members.has(relative) || !Number.isSafeInteger(file.size) || file.size < 0
        || typeof file.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(file.contentHash)) {
        fail("PIPELINE_INPUT_INVALID", "Invalid Lua input member");
      }
      members.set(relative, { path: relative, size: file.size, contentHash: file.contentHash });
    }
    declaredInputs.set(key, members);
  }
  for (const [key, output] of Object.entries(outputs)) {
    name(key, "PIPELINE_OUTPUT_UNDECLARED");
    if (!output || !["file", "collection"].includes(output.kind)) fail("PIPELINE_OUTPUT_UNDECLARED", "Invalid Lua output port");
    declaredOutputs.set(key, { kind: output.kind, path: logicalPath(output.path, "PIPELINE_OUTPUT_UNDECLARED") });
  }

  let bytes = 0, entries = 0;
  const written = new Map(), directories = new Set();
  function parentDirectories(relative) {
    const parts = relative.split("/"), missing = [];
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"), full = path.join(outputBase, prefix);
      try {
        if (!fs.lstatSync(full).isDirectory() || fs.realpathSync(full) !== full) pathError();
        if (!directories.has(prefix)) pathError();
      } catch (error) { if (error.code !== "ENOENT") throw error; missing.push(prefix); }
    }
    return missing;
  }
  function mkdir(relative) {
    fs.mkdirSync(path.join(outputBase, relative), { mode: 0o700 }); directories.add(relative); entries++;
  }
  // Empty declared collections are valid products and still consume inodes.
  for (const output of declaredOutputs.values()) if (output.kind === "collection") {
    const needed = parentDirectories(`${output.path}/member`);
    if (entries + needed.length > budget.maxOutputEntries) fail("PIPELINE_OUTPUT_LIMIT", "Lua output exceeds its entry limit");
    for (const relative of needed) mkdir(relative);
  }
  function members(key) {
    const value = declaredInputs.get(key);
    if (!value) fail("PIPELINE_INPUT_INVALID", "Unknown Lua input port");
    return value;
  }
  return Object.freeze({
    log(level, message) {
      if (!["debug", "info", "warning", "error"].includes(level) || typeof message !== "string" || Buffer.byteLength(message) > valuePolicy.maxStringBytes) {
        fail("PIPELINE_LOG_INVALID", "Invalid Lua log record");
      }
      const event = { level, message }, size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (logsTruncated || logBytes + size > events.maxLogBytes || logCount >= events.maxEvents) { logsTruncated = true; return; }
      logBytes += size; logCount++; emit(event);
    },
    diagnostic(value) {
      const item = validateLuaDiagnostic(value, { policy: valuePolicy, hasMember: (input, file) => declaredInputs.get(input)?.has(file) });
      const size = Buffer.byteLength(JSON.stringify(item)) + (diagnostics.length ? 1 : 0);
      if (diagnosticBytes + size > events.maxDiagnosticBytes || diagnostics.length >= events.maxEvents) fail("PIPELINE_DIAGNOSTICS_LIMIT", "Lua diagnostics exceed their limit");
      diagnosticBytes += size; diagnostics.push(item);
      emit({ diagnostic: item });
    },
    result() { return { diagnostics: diagnostics.map(item => ({ ...item })), logsTruncated }; },
    list(key) { return [...members(key).values()].map(file => ({ ...file })); },
    read(key, relative) {
      logicalPath(relative, "PIPELINE_INPUT_INVALID");
      const member = members(key).get(relative);
      if (!member) fail("PIPELINE_INPUT_INVALID", "Undeclared Lua input member");
      if (member.size > budget.maxArtifactBytes) fail("PIPELINE_INPUT_LIMIT", "Lua input exceeds its read limit");
      return readLuaFile(inputBase, `inputs/${key}/${relative}`, member, budget.maxArtifactBytes);
    },
    write(key, relative, value) {
      logicalPath(relative, "PIPELINE_OUTPUT_UNDECLARED");
      const output = declaredOutputs.get(key);
      if (!output || (output.kind === "file" ? relative !== output.path : !relative.startsWith(`${output.path}/`))) {
        fail("PIPELINE_OUTPUT_UNDECLARED", "Undeclared Lua output member");
      }
      if (!Buffer.isBuffer(value)) fail("PIPELINE_LUA_VALUE_INVALID", "Lua output requires bytes");
      const previous = written.get(relative), size = previous ?? 0, needed = parentDirectories(relative);
      if (value.length > budget.maxArtifactBytes || bytes - size + value.length > budget.maxOutputBytes
        || entries + needed.length + (previous === undefined ? 1 : 0) > budget.maxOutputEntries) {
        fail("PIPELINE_OUTPUT_LIMIT", "Lua output exceeds its workspace limit");
      }
      const full = path.join(outputBase, relative);
      // Check existing links before opening or truncating any inode.
      try {
        const info = fs.lstatSync(full);
        if (!info.isFile() || info.nlink !== 1 || previous === undefined || info.size !== previous) pathError();
      } catch (error) { if (error.code !== "ENOENT" || previous !== undefined) throw error; }
      for (const directory of needed) mkdir(directory);
      const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        | (previous === undefined ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
      const fd = fs.openSync(full, flags, 0o600);
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.nlink !== 1 || info.size !== size) pathError();
        let offset = 0;
        while (offset < value.length) {
          const count = fs.writeSync(fd, value, offset, value.length - offset, offset);
          if (!count) fail("PIPELINE_OUTPUT_FAILED", "Lua output write failed");
          offset += count;
        }
        fs.ftruncateSync(fd, value.length);
      } finally { fs.closeSync(fd); }
      bytes += value.length - size;
      if (previous === undefined) entries++;
      written.set(relative, value.length);
    },
  });
}

module.exports = { createLuaIO, readLuaFile };
