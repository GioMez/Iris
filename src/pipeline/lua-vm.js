const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { readPolicy, cloneValue, logicalPath, fail, LUA_DATA_POLICY, validateDescriptor, canonical, record } = require("./contracts");

const invalid = () => fail("PIPELINE_LUA_VALUE_INVALID", "Lua value cannot cross the pipeline boundary");
const error = code => Object.assign(new Error(code), { code });
const arity = Object.freeze({ read: 2, list: 1, write: 3, read_layout: 1, log: 2, diagnostic: 1 });

// A frame carries bounded JSON metadata and optional raw bytes. One synchronous
// Lua call waits for one reply, so the bridge never queues project-sized replies.
async function* frames(stream, maxJsonBytes, maxIoBytes) {
  const iterator = stream[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0), offset = 0;
  async function read(size, eof = false) {
    const bytes = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      if (offset === chunk.length) {
        const next = await iterator.next();
        if (next.done) {
          if (eof && written === 0) return null;
          throw error("PIPELINE_LUA_PROTOCOL_INVALID");
        }
        chunk = next.value; offset = 0;
      }
      const count = Math.min(size - written, chunk.length - offset);
      chunk.copy(bytes, written, offset, offset + count);
      written += count; offset += count;
    }
    return bytes;
  }
  for (;;) {
    const header = await read(8, true);
    if (!header) return;
    const jsonSize = header.readUInt32BE(0), byteSize = header.readUInt32BE(4);
    if (!jsonSize || jsonSize > maxJsonBytes || byteSize > maxIoBytes) throw error("PIPELINE_LUA_PROTOCOL_INVALID");
    const text = await read(jsonSize);
    let message;
    try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(text)); }
    catch { throw error("PIPELINE_LUA_PROTOCOL_INVALID"); }
    yield { message, bytes: await read(byteSize) };
  }
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, (key, item) => {
    if (!key.isWellFormed() || (typeof item === "string" && !item.isWellFormed())) invalid();
    return item;
  }));
}

// Like the native compilers, Lua runs as an installed executable with a reduced
// environment. Author API restrictions are not an operating-system sandbox.
async function executeLua({ mode, script, modules, context = {}, entrypoint, host = {}, policy: overrides, expectedDescriptor,
  binPath = process.env.LUA_BIN_PATH || "", timeoutMs = mode === "transform" ? 30000 : 5000, signal, maxIoBytes = 134217728 }) {
  const policy = readPolicy(overrides);
  if (!["inspect", "plan", "transform"].includes(mode) || typeof binPath !== "string" || binPath.includes("\0")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || !Number.isSafeInteger(maxIoBytes) || maxIoBytes < 1 || maxIoBytes > 0xffffffff) {
    fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua worker request");
  }
  logicalPath(script, "PIPELINE_LUA_REQUEST_INVALID");
  const safeContext = cloneValue(context, LUA_DATA_POLICY, "PIPELINE_LUA_VALUE_INVALID");
  if (expectedDescriptor !== undefined && mode !== "plan") fail("PIPELINE_LUA_REQUEST_INVALID", "Unexpected planner descriptor");
  const expected = expectedDescriptor === undefined ? null : canonical(validateDescriptor(expectedDescriptor, { policy }));
  record(modules, null, "PIPELINE_LUA_REQUEST_INVALID", "Lua modules");
  for (const name of Object.keys(modules)) logicalPath(name, "PIPELINE_LUA_REQUEST_INVALID");
  if (mode === "transform") for (const [name, fn] of Object.entries(host)) {
    if (!Object.hasOwn(arity, name) || typeof fn !== "function") fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua host interface");
  }
  // dkjson escapes some Unicode characters that JSON.stringify leaves literal.
  // Reserve wire expansion without reducing the author-facing JSON budget.
  const maxJsonBytes = Math.max(LUA_DATA_POLICY.maxPlanBytes, 6 * policy.maxPlanBytes) + 4096;
  const initial = jsonBytes({ mode, script, context: safeContext, entrypoint: entrypoint || "", policy, maxIoBytes,
    maxJsonBytes, checkDescriptor: expected !== null, host: mode === "transform" ? Object.keys(host) : [] });
  if (initial.length > maxJsonBytes) invalid();
  signal?.throwIfAborted();
  const command = binPath ? path.resolve(binPath, "lua") : "lua";
  const child = spawn(command, ["-E", path.join(__dirname, "lua-process.lua"), __dirname], {
    cwd: __dirname, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: binPath ? `${path.resolve(binPath)}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH || "",
      HOME: os.tmpdir(), TMPDIR: os.tmpdir(), LANG: "C.UTF-8" },
  });
  let failure, callbackFailure, resultError, result, received = false, closed = false;
  function stop(reason) {
    failure ||= reason;
    if (!closed) child.kill("SIGKILL");
  }
  const onAbort = () => stop(signal.reason);
  const timer = setTimeout(() => stop(error("PIPELINE_LUA_TIMEOUT")), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  const completion = new Promise(resolve => {
    child.once("error", () => stop(error("PIPELINE_LUA_UNAVAILABLE")));
    child.once("close", (code, exitSignal) => { closed = true; resolve({ code, signal: exitSignal }); });
  });
  // Never retain interpreter stderr: startup errors can contain private paths.
  child.stderr.resume();
  child.stdin.on("error", () => stop(error("PIPELINE_LUA_EXECUTION_FAILED")));
  async function send(message, bytes = Buffer.alloc(0)) {
    if (failure) throw failure;
    const json = Buffer.isBuffer(message) ? message : jsonBytes(message);
    if (json.length > maxJsonBytes || bytes.length > maxIoBytes) invalid();
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(json.length, 0); header.writeUInt32BE(bytes.length, 4);
    for (const part of [header, json, bytes]) if (part.length) {
      await new Promise((resolve, reject) => child.stdin.write(part, err => err ? reject(err) : resolve()));
    }
  }
  async function reply(message, bytes) {
    if (failure) throw failure;
    const code = "PIPELINE_LUA_PROTOCOL_INVALID";
    record(message, ["kind", "name", "args", "value"], code, "Lua frame");
    if (message.kind === "result" || message.kind === "error") {
      if (received || bytes.length) throw error(code);
      received = true;
      if (message.kind === "error") {
        if (!["PIPELINE_LUA_VALUE_INVALID", "PIPELINE_LUA_EXECUTION_FAILED", "PIPELINE_LUA_VERSION_UNSUPPORTED"].includes(message.value)) throw error(code);
        resultError = error(message.value);
      } else result = cloneValue(message.value, policy, "PIPELINE_LUA_VALUE_INVALID");
      return;
    }
    try {
      if (message.kind === "invalid") invalid();
      if (message.kind === "module") {
        if (bytes.length) throw error(code);
        logicalPath(message.name, "PIPELINE_LUA_REQUEST_INVALID");
        if (!Object.hasOwn(modules, message.name)) return await send({ ok: true, value: null });
        const source = modules[message.name];
        if (typeof source !== "string" && !Buffer.isBuffer(source)) throw error("PIPELINE_LUA_REQUEST_INVALID");
        return await send({ ok: true, binary: true }, Buffer.isBuffer(source) ? source : Buffer.from(source));
      }
      if (message.kind === "descriptor") {
        if (received || expected === null || bytes.length) throw error(code);
        if (canonical(validateDescriptor(message.value, { policy })) !== expected) throw error("PIPELINE_DESCRIPTOR_CHANGED");
        return await send({ ok: true, value: true });
      }
      if (message.kind !== "call" || mode !== "transform" || !Object.hasOwn(host, message.name)) throw error(code);
      const { name, args } = message;
      if (!Object.hasOwn(arity, name) || !Array.isArray(args) || args.length !== arity[name] - (name === "write" ? 1 : 0)) invalid();
      if (name !== "write" && bytes.length) throw error(code);
      for (const arg of args) {
        cloneValue(arg, policy, "PIPELINE_LUA_VALUE_INVALID");
        if (name !== "diagnostic" && typeof arg !== "string") invalid();
      }
      const value = host[name](...args, ...(name === "write" ? [bytes] : []));
      if (value?.then) throw error("PIPELINE_LUA_IO_INVALID");
      if (Buffer.isBuffer(value)) return await send({ ok: true, binary: true }, value);
      await send({ ok: true, value: value === undefined ? null : cloneValue(value, LUA_DATA_POLICY, "PIPELINE_LUA_VALUE_INVALID") });
    } catch (err) {
      if (failure) throw failure;
      callbackFailure ||= err;
      await send({ ok: false, value: "PIPELINE_LUA_IO_FAILED" });
    }
  }
  try {
    if (signal?.aborted) onAbort();
    if (!failure) {
      await send(initial);
      for await (const frame of frames(child.stdout, maxJsonBytes, maxIoBytes)) await reply(frame.message, frame.bytes);
    }
  } catch (err) { stop(failure || callbackFailure || (/^PIPELINE_/.test(err?.code) ? err : error("PIPELINE_LUA_EXECUTION_FAILED"))); }
  finally {
    const exit = await completion;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    child.stdin.destroy();
    if (!failure && (exit.code !== 0 || exit.signal || !received)) failure = error("PIPELINE_LUA_EXECUTION_FAILED");
  }
  // Finalizers may call the host after the result frame, during interpreter close.
  if (callbackFailure) throw callbackFailure;
  if (failure) throw failure;
  if (resultError) throw resultError;
  return result;
}

module.exports = { executeLua };
