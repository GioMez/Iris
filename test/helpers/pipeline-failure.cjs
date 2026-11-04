const { PDFDocument, PDFName } = require("pdf-lib");

// Real adapter failures without a compiler dependency or an execution fault hook.
async function failurePlugin(mode, main) {
  if (mode === "missing-tool") return `return {apiVersion=1,pluginId='failure',plan=function() return {
    apiVersion=1,pluginId='failure',steps={{id='compile',adapter={id='iris.lilypond',version='1.0.0'},
    inputs={source={snapshot=true}},options={main='${main}'},outputs={output={kind='file',mediaType='application/pdf',path='out.pdf'}}}},
    targets={main={steps={'compile'},publish={{step='compile',port='output'}}}}} end}`;
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  pdf.getForm().acroForm.dict.set(PDFName.of("XFA"), pdf.context.register(pdf.context.flateStream("<xfa/>")));
  const bytes = await pdf.save();
  return `local function ref(step) return {step=step,port='output'} end
    local function output(media,path) return {output={kind='file',mediaType=media,path=path}} end
    return {apiVersion=1,pluginId='failure',plan=function() return {
      apiVersion=1,pluginId='failure',steps={
      {id='seed',adapter={id='iris.lua',version='1.0.0'},options={script='iris.lua',entrypoint='seed'},outputs=output('application/pdf','input.pdf')},
      {id='place',adapter={id='iris.lua',version='1.0.0'},inputs={pdf=ref('seed')},options={script='iris.lua',entrypoint='place'},outputs=output('application/json','placements.json')},
      {id='compose',adapter={id='iris.pdf-compose',version='1.0.0'},inputs={base=ref('seed'),layers=ref('seed'),placements=ref('place')},outputs=output('application/pdf','output.pdf')}},
      targets={main={steps={'compose'},publish={ref('compose')}}}} end,
      seed=function(ctx) ctx.write('output','input.pdf',"${[...bytes].map(byte => `\\${String(byte).padStart(3, "0")}`).join("")}") end,
      place=function(ctx) local pdf=ctx.list('pdf')[1]; ctx.write('output','placements.json',string.format(
        '{"version":1,"base":{"id":"%s","contentHash":"%s"},"layers":[{"artifact":{"id":"%s","contentHash":"%s"},"sourcePage":1,"page":1,"units":"pdf-point","x":0,"y":0,"width":100,"height":100,"position":"over"}]}',
        pdf.id,pdf.contentHash,pdf.id,pdf.contentHash)) end}`;
}

module.exports = { failurePlugin };
