-- A declared two-pass graph: measured ink drives an include for the final pass.
local decorator = require("decorate")
local schema = decorator.parameterSchema
schema.properties.broken = {type="boolean",default=false}
local function include(family) return family == "latex" and "generated/adjust.tex" or "generated/adjust.ily" end
return {
  apiVersion=1,pluginId="two-pass-layout",parameterSchema=schema,
  layer=decorator.layer,decorate=decorator.decorate,
  plan=function(ctx)
    local family, plan = ctx.parameters.family, decorator.plan(ctx)
    plan.pluginId = "two-pass-layout"
    local compile = plan.steps[1]
    compile.options.main = family == "latex" and "final.tex" or "final.ly"
    compile.inputs.generated = {step="adjust",port="include"}
    table.insert(plan.steps,1,{id="adjust",adapter={id="iris.lua",version="1.0.0"},
      inputs={layout={step="measure",port="layout"},base={step="measure",port="output"}},
      options={script="iris.lua",entrypoint="adjust"},
      outputs={include={kind="file",mediaType="text/plain",path=include(family)}}})
    table.insert(plan.steps,1,{id="measure",adapter={id="iris." .. family,version="1.0.0"},
      inputs={source={snapshot=true}},options={main=family == "latex" and "main.tex" or "main.ly",sourceMapping=false},
      requiredCapabilities={"layout.occupied.complete"},
      outputs={output={kind="file",mediaType="application/pdf",path="initial.pdf"},
        layout={kind="layout",mediaType="application/vnd.iris.layout+json",path="initial-layout.json"}}})
    for _, item in ipairs({{step="measure",port="output"},{step="measure",port="layout"},{step="adjust",port="include"}}) do
      table.insert(plan.targets.main.publish,item)
    end
    return plan
  end,
  adjust=function(ctx)
    local layout, base, options = ctx.read_layout("layout"), ctx.list("base")[1], ctx.options.parameters
    assert(layout.artifact.id == base.id and layout.artifact.contentHash == base.contentHash)
    local bounds = assert(layout.pages[1].occupied[1]).bounds
    local offset = math.min(12,math.max(1,math.ceil((bounds[3]-bounds[1])/10)))
    local text
    if options.broken then text = "\\irisUndefinedLayoutAdjustment\n"
    elseif options.family == "latex" then text = string.format("\\def\\irisAdjustment{\\hspace*{%dbp}}\n",offset)
    else text = string.format("#(define iris-layout-offset %d)\n",offset) end
    ctx.write("include",include(options.family),text)
  end,
}
