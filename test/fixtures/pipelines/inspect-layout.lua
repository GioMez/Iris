local schema = {type="object",properties={family={type="string",enum={"latex","lilypond"},default="latex"}}}
return {
  apiVersion=1,pluginId="inspect-layout",parameterSchema=schema,
  plan=function(ctx)
    local family = ctx.parameters.family
    return {apiVersion=1,pluginId="inspect-layout",parameterSchema=schema,steps={
      {id="compile",adapter={id="iris." .. family,version="1.0.0"},inputs={source={snapshot=true}},
        options={main=family == "latex" and "main.tex" or "main.ly",sourceMapping=false},
        requiredCapabilities={"layout.occupied.complete"},
        outputs={output={kind="file",mediaType="application/pdf",path="result.pdf"},
          layout={kind="layout",mediaType="application/vnd.iris.layout+json",path="layout.json"}}},
      {id="inspect",adapter={id="iris.lua",version="1.0.0"},
        inputs={pdf={step="compile",port="output"},layout={step="compile",port="layout"}},
        options={script="iris.lua",entrypoint="inspect"},
        outputs={report={kind="file",mediaType="text/plain",path="layout-report.txt"}}},
    },targets={main={steps={"inspect"},publish={{step="inspect",port="report"}}}}}
  end,
  inspect=function(ctx)
    local layout = ctx.read_layout("layout")
    local pdf = ctx.list("pdf")[1]
    assert(layout.artifact.id == pdf.id)
    assert(layout.artifact.contentHash == pdf.contentHash)
    assert(layout.coverage == "complete")
    assert(layout.pageCount == 1 and #layout.pages[1].occupied > 0)
    ctx.write("report","layout-report.txt","inspected matching final PDF layout")
  end,
}
