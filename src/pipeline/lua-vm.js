const fs = require("node:fs");
const path = require("node:path");
const { LuaFactory, LUA_REGISTRYINDEX } = require("wasmoon");
const { readPolicy, cloneValue, logicalPath, fail, LUA_DATA_POLICY, validateDescriptor, canonical } = require("./contracts");

const bootstrap = fs.readFileSync(path.join(__dirname, "lua-bootstrap.lua"), "utf8");
const invalid = () => fail("PIPELINE_LUA_VALUE_INVALID", "Lua value cannot cross the pipeline boundary");
const reserved = new Set(["__proto__", "constructor", "prototype"]);
const arity = Object.freeze({ read: 2, list: 1, write: 3, read_layout: 1, log: 2, diagnostic: 1 });

// This module runs inside the contained Node worker, never in the coordinator.
// Wasmoon's default string bridge is UTF-8/NUL-terminated; project bytes and
// boundary values use the raw C API instead. No JS objects/proxies enter Lua.
async function executeLua({ mode, script, modules, context = {}, entrypoint, host = {}, policy: overrides, expectedDescriptor,
  memoryBytes = 268435456, maxIoBytes = 134217728 }) {
  const policy = readPolicy(overrides);
  if (!["inspect", "plan", "transform"].includes(mode) || !Number.isSafeInteger(memoryBytes) || memoryBytes < 1
    || !Number.isSafeInteger(maxIoBytes) || maxIoBytes < 1) fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua worker request");
  logicalPath(script, "PIPELINE_LUA_REQUEST_INVALID");
  const safeContext = cloneValue(context, LUA_DATA_POLICY, "PIPELINE_LUA_VALUE_INVALID");
  if (expectedDescriptor !== undefined && mode !== "plan") fail("PIPELINE_LUA_REQUEST_INVALID", "Unexpected planner descriptor");
  const expected = expectedDescriptor === undefined ? null : canonical(validateDescriptor(expectedDescriptor, { policy }));
  for (const name of Object.keys(modules)) logicalPath(name, "PIPELINE_LUA_REQUEST_INVALID");
  if (mode === "transform") for (const [name, fn] of Object.entries(host)) {
    if (!Object.hasOwn(arity, name) || typeof fn !== "function") fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua host interface");
  }
  const engine = await new LuaFactory().createEngine({ injectObjects: false, enableProxy: false, traceAllocations: true });
  const global = engine.global, w = global.lua, L = global.address, m = w.module, callbacks = [];
  let callbackFailure, arrayRef, nullRef, result;
  global.setMemoryMax(memoryBytes);
  function checkStack() { if (!w.lua_checkstack(L, 8)) invalid(); }
  function pushBytes(bytes) {
    const pointer = m._malloc(Math.max(bytes.length, 1));
    if (!pointer) fail("PIPELINE_LUA_MEMORY_LIMIT", "Lua memory limit exceeded");
    try {
      m.HEAPU8.set(bytes, pointer);
      m.ccall("lua_pushlstring", "number", ["number", "number", "number"], [L, pointer, bytes.length]);
    } finally { m._free(pointer); }
  }
  function readBytes(index, limit) {
    if (w.lua_type(L, index) !== 4) invalid();
    const length = w.lua_rawlen(L, index);
    // This Wasmoon build returns size_t as BigInt despite its declaration file.
    if (length < 0 || length > limit) invalid();
    const size = Number(length);
    if (!Number.isSafeInteger(size)) invalid();
    const pointer = m.ccall("lua_tolstring", "number", ["number", "number", "number"], [L, index, 0]);
    return Buffer.from(m.HEAPU8.subarray(pointer, pointer + size));
  }
  function text(index) {
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readBytes(index, policy.maxStringBytes)); }
    catch { invalid(); }
  }
  function markArray(index) {
    w.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(arrayRef));
    w.lua_pushvalue(L, index); w.lua_pushboolean(L, 1); w.lua_rawset(L, -3); w.lua_pop(L, 1);
  }
  function isNull(index) {
    const absolute = w.lua_absindex(L, index);
    w.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(nullRef));
    const result = !!w.lua_rawequal(L, absolute, -1); w.lua_pop(L, 1);
    if (result) {
      if (w.lua_getmetatable(L, absolute)) invalid();
      w.lua_pushnil(L);
      if (w.lua_next(L, absolute)) invalid();
    }
    return result;
  }
  function push(value) {
    checkStack();
    if (value === null) w.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(nullRef));
    else if (typeof value === "string") pushBytes(Buffer.from(value));
    else if (typeof value === "boolean") w.lua_pushboolean(L, Number(value));
    else if (typeof value === "number") {
      if (Number.isSafeInteger(value)) w.lua_pushinteger(L, BigInt(value)); else w.lua_pushnumber(L, value);
    }
    else {
      const array = Array.isArray(value);
      w.lua_createtable(L, array ? value.length : 0, array ? 0 : Object.keys(value).length);
      const index = w.lua_absindex(L, -1);
      if (array) markArray(index);
      for (const [key, child] of Object.entries(value)) {
        if (array) w.lua_pushinteger(L, BigInt(Number(key) + 1)); else pushBytes(Buffer.from(key));
        push(child); w.lua_rawset(L, index);
      }
    }
  }
  function read(index) {
    let count = 0, bytes = 0;
    const seen = new Set();
    const add = n => { bytes += n; if (bytes > policy.maxPlanBytes) invalid(); };
    function copy(index, depth) {
      checkStack();
      if (++count > policy.maxValues || depth > policy.maxDepth) invalid();
      const type = w.lua_type(L, index);
      if (type === 0 || isNull(index)) { add(4); return null; }
      if (type === 1) { const value = !!w.lua_toboolean(L, index); add(value ? 4 : 5); return value; }
      if (type === 3) {
        const value = w.lua_tonumberx(L, index, 0);
        if (!Number.isFinite(value) || (w.lua_isinteger(L, index) && !Number.isSafeInteger(value))) invalid();
        add(String(value).length); return value;
      }
      if (type === 4) { const value = text(index); add(Buffer.byteLength(JSON.stringify(value))); return value; }
      if (type !== 5 || w.lua_getmetatable(L, index)) invalid();
      const pointer = w.lua_topointer(L, index);
      if (seen.has(pointer)) invalid();
      seen.add(pointer); add(2);
      const absolute = w.lua_absindex(L, index), values = [];
      let numeric = false, named = false;
      w.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(arrayRef));
      w.lua_pushvalue(L, absolute); w.lua_rawget(L, -2);
      const array = !!w.lua_toboolean(L, -1); w.lua_pop(L, 2);
      w.lua_pushnil(L);
      while (w.lua_next(L, absolute)) {
        const keyType = w.lua_type(L, -2);
        let key;
        if (keyType === 3 && w.lua_isinteger(L, -2)) {
          key = Number(w.lua_tointegerx(L, -2, 0));
          if (!Number.isSafeInteger(key) || key < 1 || key > policy.maxValues) invalid();
          numeric = true;
        } else if (keyType === 4) {
          key = text(-2);
          if (reserved.has(key)) invalid();
          named = true; add(Buffer.byteLength(JSON.stringify(key)) + 1);
        } else invalid();
        if ((numeric && named) || (array && named)) invalid();
        if (values.length) add(1);
        values.push([key, copy(-1, depth + 1)]); w.lua_pop(L, 1);
      }
      seen.delete(pointer);
      if (array || numeric) {
        const result = new Array(values.length);
        for (const [key, value] of values) { if (key > values.length) invalid(); result[key - 1] = value; }
        return result;
      }
      return Object.fromEntries(values);
    }
    return copy(index, 0);
  }
  function pushFunction(fn) {
    const pointer = m.addFunction(fn, "ii");
    callbacks.push(pointer); w.lua_pushcclosure(L, pointer, 0);
  }
  function pushCallback(name, fn) {
    pushFunction(() => {
      const top = w.lua_gettop(L);
      let value;
      try {
        if (top !== arity[name]) invalid();
        const args = [];
        for (let i = 1; i <= top; i++) args.push(name === "write" && i === 3 ? readBytes(i, maxIoBytes) : name === "diagnostic" ? read(i) : text(i));
        value = fn(...args);
        if (value?.then) fail("PIPELINE_LUA_IO_INVALID", "Worker I/O must complete synchronously");
        if (Buffer.isBuffer(value)) {
          if (value.length > maxIoBytes) invalid();
        } else value = value === undefined ? null : cloneValue(value, LUA_DATA_POLICY, "PIPELINE_LUA_VALUE_INVALID");
      } catch (error) {
        // Wasmoon's pinned Emscripten build represents Lua longjmp as Infinity.
        // Let the protected Lua caller handle it rather than treating it as I/O.
        if (error === Infinity) throw error;
        callbackFailure ||= error;
        w.lua_settop(L, top); w.lua_pushboolean(L, 0); pushBytes(Buffer.from("PIPELINE_LUA_IO_FAILED"));
        return 2;
      }
      w.lua_pushboolean(L, 1);
      if (Buffer.isBuffer(value)) pushBytes(value); else push(value);
      return 2;
    });
  }
  function check(status) {
    if (status === 4) fail("PIPELINE_LUA_MEMORY_LIMIT", "Lua memory limit exceeded");
    if (status) fail("PIPELINE_LUA_EXECUTION_FAILED", "Lua execution failed");
  }
  try {
    check(w.luaL_loadbufferx(L, bootstrap, Buffer.byteLength(bootstrap), "@iris-bootstrap", "t"));
    check(w.lua_pcallk(L, 0, 3, 0, 0, null));
    // Registry references remain valid in C callback frames, whose stack indices
    // start at the callback arguments rather than the bootstrap's return values.
    nullRef = w.luaL_ref(L, LUA_REGISTRYINDEX);
    arrayRef = w.luaL_ref(L, LUA_REGISTRYINDEX);
    const runRef = w.luaL_ref(L, LUA_REGISTRYINDEX);
    // Project-sized allocations need Lua's protected call, including context
    // conversion and source copies. Unused approved modules stay outside Lua.
    pushFunction(() => {
      w.lua_rawgeti(L, LUA_REGISTRYINDEX, BigInt(runRef));
      push(mode); push(script);
      pushFunction(() => {
        const name = text(1);
        if (Object.hasOwn(modules, name)) {
          const source = modules[name];
          if (typeof source !== "string" && !Buffer.isBuffer(source)) fail("PIPELINE_LUA_REQUEST_INVALID", "Invalid Lua module source");
          pushBytes(Buffer.isBuffer(source) ? source : Buffer.from(source));
        } else w.lua_pushnil(L);
        return 1;
      });
      push(safeContext);
      w.lua_createtable(L, 0, Object.keys(host).length);
      const io = w.lua_absindex(L, -1);
      if (mode === "transform") for (const [name, fn] of Object.entries(host)) {
        pushBytes(Buffer.from(name)); pushCallback(name, fn); w.lua_rawset(L, io);
      }
      push(entrypoint || "");
      if (expected === null) w.lua_pushnil(L);
      else pushFunction(() => {
        try {
          if (canonical(validateDescriptor(read(1), { policy })) !== expected) fail("PIPELINE_DESCRIPTOR_CHANGED", "Plugin descriptor changed");
        } catch (error) {
          if (error === Infinity) throw error;
          callbackFailure ||= error;
          w.lua_pushboolean(L, 0); return 1;
        }
        w.lua_pushboolean(L, 1); return 1;
      });
      w.lua_callk(L, 7, 1, 0, null);
      return 1;
    });
    const status = w.lua_pcallk(L, 0, 1, 0, 0, null);
    if (callbackFailure) throw callbackFailure;
    check(status);
    result = read(-1);
  } finally {
    try { global.close(); }
    finally { for (const pointer of callbacks) m.removeFunction(pointer); }
  }
  // Lua finalizers run during close and still obey the same I/O authority.
  if (callbackFailure) throw callbackFailure;
  return result;
}

module.exports = { executeLua };
