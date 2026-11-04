-- Synthetic source-generation fixture for both independent compiler families.
local schema = {type="object", properties={
  family={type="string", enum={"latex", "lilypond"}, default="latex"},
  count={type="integer", minimum=1, maximum=8, default=2},
  broken={type="boolean", default=false},
}}
local function include(family)
  return family == "latex" and "generated/include.tex" or "generated/include.ily"
end
return {
  apiVersion=1, pluginId="generate-source", parameterSchema=schema,
  plan=function(ctx)
    local family = ctx.parameters.family
    local main = family == "latex" and "main.tex" or "main.ly"
    return {apiVersion=1, pluginId="generate-source", parameterSchema=schema, steps={
      {id="generate", adapter={id="iris.lua", version="1.0.0"},
        options={script="iris.lua", entrypoint="generate"},
        outputs={include={kind="file", mediaType="text/plain", path=include(family)}}},
      {id="compile", adapter={id="iris." .. family, version="1.0.0"},
        inputs={source={snapshot=true}, generated={step="generate", port="include"}},
        options={main=main, sourceMapping=false},
        outputs={output={kind="file", mediaType="application/pdf", path="result.pdf"}}},
    }, targets={main={steps={"compile"},
      publish={{step="generate", port="include"}, {step="compile", port="output"}},
      primaryPreview={step="compile", port="output"}}}}
  end,
  generate=function(ctx)
    local options = ctx.options.parameters
    local bytes
    if options.family == "latex" then
      bytes = options.broken and "\\irisUndefinedGeneratedCommand\n" or string.rep("Generated Iris text. ", options.count) .. "\n"
    else
      bytes = "generatedMusic = { " .. (options.broken and "\\irisUndefinedGeneratedCommand" or string.rep("c'4 ", options.count)) .. "}\n"
    end
    ctx.write("include", include(options.family), bytes)
  end,
}
