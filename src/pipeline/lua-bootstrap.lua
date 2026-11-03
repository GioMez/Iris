-- Only the worker loads this trusted bootstrap in the standard Lua environment.
-- Project modules receive the separate environment constructed below.
local arrays = setmetatable({}, {__mode = "k"})
local null = {}
local function array(value)
  assert(type(value) == "table" and getmetatable(value) == nil, "invalid array")
  arrays[value] = true
  return value
end
local function copy(source)
  local result = {}
  for key, value in pairs(source) do result[key] = value end
  return result
end

local function run(mode, script, loadSource, context, host, entrypoint, checkDescriptor)
  local env = {
    assert=assert, error=error, ipairs=ipairs, pairs=pairs, next=next, pcall=pcall,
    xpcall=xpcall, select=select, tonumber=tonumber, tostring=tostring, type=type,
    rawequal=rawequal, rawget=rawget, rawset=rawset, rawlen=rawlen,
    getmetatable=getmetatable, setmetatable=setmetatable,
    math=copy(math), string=copy(string), table=copy(table), utf8=copy(utf8),
    _VERSION=_VERSION, iris={array=array, null=null},
  }
  -- String method lookup also uses the standard string table.
  string.dump = nil
  env.string.dump = nil
  local seeded = false
  env.math.randomseed = function(seed, second)
    assert(math.type(seed) == "integer", "explicit random seed required")
    if second ~= nil then assert(math.type(second) == "integer", "invalid random seed") end
    seeded = true
    return math.randomseed(seed, second or 0)
  end
  env.math.random = function(...)
    assert(seeded, "explicit random seed required")
    return math.random(...)
  end
  env._G = env
  local loaded, loading = {}, {}
  local function module(path)
    if loaded[path] ~= nil then return loaded[path] end
    assert(not loading[path], "cyclic module dependency")
    local source = loadSource(path)
    assert(source ~= nil, "module not approved")
    loading[path] = true
    local chunk = assert(load(source, "@" .. path, "t", env))
    local value = chunk()
    loaded[path] = value == nil and true or value
    loading[path] = nil
    return loaded[path]
  end
  env.require = function(name)
    assert(type(name) == "string" and name:match("^[%w_][%w_.%-]*$")
      and not name:find("..", 1, true) and name:sub(-1) ~= ".", "invalid module name")
    return module((name:gsub("%.", "/")) .. ".lua")
  end
  local plugin = module(script)
  assert(type(plugin) == "table" and getmetatable(plugin) == nil, "invalid module exports")
  if mode == "inspect" or (mode == "plan" and checkDescriptor ~= nil) then
    assert(type(rawget(plugin, "plan")) == "function", "missing planner")
    local descriptor = {apiVersion=rawget(plugin,"apiVersion"), pluginId=rawget(plugin,"pluginId"),
      parameterSchema=rawget(plugin,"parameterSchema"), requiredCapabilities=rawget(plugin,"requiredCapabilities")}
    if mode == "inspect" then return descriptor end
    assert(checkDescriptor(descriptor), "plugin descriptor changed")
  end
  if mode == "transform" then
    for name, callback in pairs(host) do
      context[name] = function(...)
        local ok, value = callback(...)
        if not ok then error(value, 2) end
        return value
      end
    end
  end
  local action = rawget(plugin, mode == "plan" and "plan" or entrypoint)
  assert(type(action) == "function", "missing entrypoint")
  return action(context)
end

return run, arrays, null
