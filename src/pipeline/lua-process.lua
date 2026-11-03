-- Trusted process transport. Project modules receive only lua-bootstrap's API.
local root = assert(arg[1])
local json = assert(loadfile(root .. "/vendor/dkjson.lua", "t"))()
if _VERSION ~= "Lua 5.4" and _VERSION ~= "Lua 5.5" then
  local text = '{"kind":"error","value":"PIPELINE_LUA_VERSION_UNSUPPORTED"}'
  io.stdout:write(string.char(0, 0, 0, #text, 0, 0, 0, 0), text)
  io.stdout:flush()
  return
end
local run, arrays, null = assert(loadfile(root .. "/lua-bootstrap.lua", "t"))()
local input, output = io.stdin, io.stdout
local pack, unpack, format, gsub = string.pack, string.unpack, string.format, string.gsub
local utf8len, mathtype, huge = utf8.len, math.type, math.huge
local objectmeta, arraymeta = {__jsontype="object"}, {__jsontype="array"}
local invalid = {}
local function bad() error(invalid, 0) end
local function read(size)
  if size == 0 then return "" end
  local value = input:read(size)
  assert(value and #value == size, "incomplete frame")
  return value
end
local maxJsonBytes, maxIoBytes = 16781312, 134217728
local function restore(value)
  -- JavaScript numbers outside its safe-integer range entered the old bridge as
  -- doubles. Lua's JSON decoder may instead parse their decimal text as int64.
  if type(value) == "number" and mathtype(value) == "integer" and (value > 9007199254740991 or value < -9007199254740991) then
    return value + 0.0
  end
  if type(value) ~= "table" or value == null then return value end
  if getmetatable(value) == arraymeta then arrays[value] = true end
  setmetatable(value, nil)
  for key, child in pairs(value) do value[key] = restore(child) end
  return value
end
local function receive()
  local size, bytes = unpack(">I4I4", read(8))
  assert(size > 0 and size <= maxJsonBytes and bytes <= maxIoBytes, "oversized frame")
  local text = read(size)
  local value, pos, err = json.decode(text, 1, null, objectmeta, arraymeta)
  assert(not err and pos == #text + 1, "invalid frame")
  return restore(value), read(bytes)
end
local function send(value, bytes)
  local text = assert(json.encode(value))
  bytes = bytes or ""
  assert(#text <= maxJsonBytes and #bytes <= maxIoBytes, "oversized frame")
  assert(output:write(pack(">I4I4", #text, #bytes), text, bytes))
  assert(output:flush())
end
local function rpc(value, bytes)
  send(value, bytes)
  local reply, data = receive()
  return reply.ok, reply.binary and data or reply.value
end
local request = receive()
maxJsonBytes, maxIoBytes = request.maxJsonBytes, request.maxIoBytes
local policy = request.policy
local reserved = {__proto__=true, constructor=true, prototype=true}

-- Validate before invoking dkjson. Metatables, sparse/mixed tables and cycles
-- never reach its custom serializer hooks. Empty author tables remain objects.
local function boundary(value)
  local count, bytes, seen = 0, 0, {}
  local function add(n)
    bytes = bytes + n
    if bytes > policy.maxPlanBytes then bad() end
  end
  local function text(value)
    if type(value) ~= "string" or #value > policy.maxStringBytes or not utf8len(value) then bad() end
    local size = #value + 2
    gsub(value, '[%z\1-\31"\\]', function(c)
      size = size + ((c == '"' or c == '\\' or c == '\b' or c == '\f' or c == '\n' or c == '\r' or c == '\t') and 1 or 5)
    end)
    add(size)
    return value
  end
  local function copy(item, depth)
    count = count + 1
    if count > policy.maxValues or depth > policy.maxDepth then bad() end
    if item == null then
      if getmetatable(item) ~= nil or next(item) ~= nil then bad() end
      add(4); return json.null
    end
    local kind = type(item)
    if kind == "nil" then add(4); return json.null end
    if kind == "boolean" then add(item and 4 or 5); return item end
    if kind == "number" then
      if item ~= item or item == huge or item == -huge or (mathtype(item) == "integer" and (item > 9007199254740991 or item < -9007199254740991)) then bad() end
      local encoded = mathtype(item) == "integer" and tostring(item) or format("%.17g", item)
      -- Lua and JavaScript format doubles differently. Charge a lower bound
      -- here; Node checks exact JSON bytes before accepting the value.
      add(1)
      -- dkjson uses tostring for numbers; %.17g preserves double precision.
      return setmetatable({}, {__tojson=function() return encoded end})
    end
    if kind == "string" then return text(item) end
    if kind ~= "table" or getmetatable(item) ~= nil or seen[item] then bad() end
    seen[item] = true; add(2)
    local result, numeric, named, length, highest = {}, false, false, 0, 0
    for key, child in next, item do
      if type(key) == "number" and mathtype(key) == "integer" then
        if key < 1 or key > policy.maxValues then bad() end
        numeric = true
        if key > highest then highest = key end
      elseif type(key) == "string" then
        if reserved[key] then bad() end
        text(key); add(1); named = true
      else bad() end
      if (numeric and named) or (arrays[item] and named) then bad() end
      if length > 0 then add(1) end
      length = length + 1
      result[key] = copy(child, depth + 1)
    end
    seen[item] = nil
    if numeric and highest ~= length then bad() end
    return setmetatable(result, (arrays[item] or numeric) and arraymeta or objectmeta)
  end
  return copy(value, 0)
end
local arity = {read=2, list=1, write=3, read_layout=1, log=2, diagnostic=1}
local host = {}
for _, name in ipairs(request.host) do
  host[name] = function(...)
    local args, n = {...}, select("#", ...)
    local ok, message, bytes = pcall(function()
      if n ~= arity[name] then bad() end
      local data
      if name == "write" then
        data = args[3]
        if type(data) ~= "string" or #data > maxIoBytes then bad() end
        args[3] = nil; n = n - 1
      end
      for i = 1, n do
        if name ~= "diagnostic" and type(args[i]) ~= "string" then bad() end
        args[i] = boundary(args[i])
      end
      return {kind="call", name=name, args=setmetatable(args, arraymeta)}, data
    end)
    if not ok then return rpc({kind="invalid"}) end
    return rpc(message, bytes)
  end
end
local function loadSource(name)
  local ok, source = rpc({kind="module", name=name})
  assert(ok, "module read failed")
  return source ~= null and source or nil
end
local checkDescriptor
if request.checkDescriptor then
  checkDescriptor = function(value)
    local ok = rpc({kind="descriptor", value=boundary(value)})
    return ok
  end
end
local ok, value = pcall(function()
  return boundary(run(request.mode, request.script, loadSource, request.context, host, request.entrypoint, checkDescriptor))
end)
if ok then send({kind="result", value=value})
else send({kind="error", value=value == invalid and "PIPELINE_LUA_VALUE_INVALID" or "PIPELINE_LUA_EXECUTION_FAILED"}) end
