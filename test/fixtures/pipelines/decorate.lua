-- Synthetic layout-aware fixture. The uploaded layer.pdf stays an ordinary PDF.
local schema = {type="object",properties={
  family={type="string",enum={"latex","lilypond"},default="latex"},
  clearance={type="number",minimum=0,maximum=40,default=3},
  offsetX={type="number",minimum=-20,maximum=20,default=0},
  offsetY={type="number",minimum=-20,maximum=20,default=0},
  excludedPages={type="array",items={type="integer",minimum=1},maxItems=100,default=iris.array{}},
}}
local function ref(step, port) return {step=step,port=port} end
local function file(media, path) return {kind="file",mediaType=media,path=path} end
return {
  apiVersion=1,pluginId="layout-decorator",parameterSchema=schema,
  plan=function(ctx)
    local family = ctx.parameters.family
    return {apiVersion=1,pluginId="layout-decorator",parameterSchema=schema,steps={
      {id="compile",adapter={id="iris." .. family,version="1.0.0"},inputs={source={snapshot=true}},
        options={main=family == "latex" and "main.tex" or "main.ly",sourceMapping=true},
        requiredCapabilities={"layout.occupied.complete"},
        outputs={output=file("application/pdf","base.pdf"),
          layout={kind="layout",mediaType="application/vnd.iris.layout+json",path="layout.json"}}},
      {id="layer",adapter={id="iris.lua",version="1.0.0"},inputs={source={snapshot=true}},
        options={script="iris.lua",entrypoint="layer"},outputs={output=file("application/pdf","layer.pdf")}},
      {id="decorate",adapter={id="iris.lua",version="1.0.0"},
        inputs={base=ref("compile","output"),layout=ref("compile","layout"),layer=ref("layer","output")},
        options={script="iris.lua",entrypoint="decorate"},outputs={output=file("application/json","placements.json")}},
      {id="compose",adapter={id="iris.pdf-compose",version="1.0.0"},
        inputs={base=ref("compile","output"),layers=ref("layer","output"),placements=ref("decorate","output")},
        outputs={output=file("application/pdf","decorated.pdf")}},
    },targets={main={steps={"compose"},publish={ref("compile","output"),ref("compile","layout"),
      ref("decorate","output"),ref("compose","output")},primaryPreview=ref("compose","output")}}}
  end,
  layer=function(ctx) ctx.write("output","layer.pdf",ctx.read("source","layer.pdf")) end,
  decorate=function(ctx)
    local layout, base, layer = ctx.read_layout("layout"), ctx.list("base")[1], ctx.list("layer")[1]
    assert(layout.artifact.id == base.id and layout.artifact.contentHash == base.contentHash)
    assert(layout.coverage == "complete")
    local options, placements, excluded = ctx.options.parameters, {}, {}
    for _, page in ipairs(options.excludedPages) do excluded[page] = true end
    for _, page in ipairs(layout.pages) do
      if not excluded[page.page] then
        local chosen, size, clearance = nil, 10, options.clearance
        local function candidate(x, y)
          x, y = x + options.offsetX, y + options.offsetY
          if chosen or x < 0 or y < 0 or x + size > page.width or y + size > page.height then return end
          for _, region in ipairs(page.occupied) do
            local b = region.bounds
            if x < b[3] + clearance and x + size > b[1] - clearance
              and y < b[4] + clearance and y + size > b[2] - clearance then return end
          end
          chosen = {x=x,y=y}
        end
        -- Prefer the right edge of actual ink; search free space if it is crowded.
        for _, region in ipairs(page.occupied) do candidate(region.bounds[3] + clearance, region.bounds[2]) end
        if not chosen then
          for y=0,page.height-size,10 do
            for x=0,page.width-size,10 do candidate(x,y); if chosen then break end end
            if chosen then break end
          end
        end
        assert(chosen, "no free decoration region")
        placements[#placements+1] = string.format(
          '{"artifact":{"id":"%s","contentHash":"%s"},"sourcePage":1,"page":%d,"units":"pdf-point","x":%.17g,"y":%.17g,"width":10,"height":10,"position":"over"}',
          layer.id,layer.contentHash,page.page,chosen.x,chosen.y)
      end
    end
    -- IDs and hashes come from checked host metadata; coordinates are finite numbers.
    ctx.write("output","placements.json",string.format('{"version":1,"base":{"id":"%s","contentHash":"%s"},"layers":[%s]}',
      base.id,base.contentHash,table.concat(placements,",")))
  end,
}
