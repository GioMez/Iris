const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { PDFDocument, rgb } = require("pdf-lib");
const { uuidv7 } = require("../src/ids");
const { serverFixture } = require("./helpers/server-fixture.cjs");
const { until } = require("../scripts/lib/disposable.cjs");

const enabled = process.env.IRIS_TEST_BROWSER === "1" && process.env.IRIS_TEST_LUA === "1";
const options = { skip: !enabled, timeout: 30000 };
let server, browser;
const plugin = `local schema={type='object',properties={fail={type='boolean',default=false},loop={type='boolean',default=false}}}
local function ref(port) return {step='generate',port=port} end
return {apiVersion=1,pluginId='browser-fixture',parameterSchema=schema,
plan=function() return {apiVersion=1,pluginId='browser-fixture',parameterSchema=schema,steps={
 {id='generate',adapter={id='iris.lua',version='1.0.0'},inputs={source={snapshot=true}},
 options={script='iris.lua',entrypoint='generate'},outputs={
 red={kind='file',mediaType='application/pdf',path='a.pdf'},blue={kind='file',mediaType='application/pdf',path='z.pdf'},
 unsafe={kind='file',mediaType='text/html',path='b.pdf'}}},
 {id='check',adapter={id='iris.lua',version='1.0.0'},options={script='iris.lua',entrypoint='check'},outputs={}}},
 targets={main={steps={'generate'},publish={ref('red'),ref('blue'),ref('unsafe')},primaryPreview=ref('blue')},
 alternate={steps={'generate'},publish={ref('red'),ref('blue')},primaryPreview=ref('red')},check={steps={'check'},publish=iris.array{}}}} end,
generate=function(ctx)
 ctx.log('info','generation started')
 if ctx.options.parameters.loop then while true do end end
 if ctx.options.parameters.fail then ctx.diagnostic({severity='error',message='Fixture failure'}); error('fixture failed') end
 ctx.write('red','a.pdf',ctx.read('source','red.pdf'))
 ctx.write('blue','z.pdf',ctx.read('source','blue.pdf'))
 ctx.write('unsafe','b.pdf','<script>throw new Error("must not preview")</script>')
end,check=function() end}`;

test.before(async t => {
  if (!enabled) return;
  server = await serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public"), LUA_BIN_PATH: process.env.LUA_BIN_PATH || "", RETENTION_ENABLED: "false" });
  browser = await chromium.launch({ headless: true, timeout: 10000,
    ...(process.env.IRIS_BROWSER_EXECUTABLE ? { executablePath: process.env.IRIS_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
  t.after(() => browser.close());
  t.diagnostic(`Chromium ${browser.version()}; installed Lua; real HTTP/PostgreSQL; synthetic PDF fixtures`);
});

async function fixture(t, variant = {}) {
  const user = (await server.pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,$2,$3,'Pipeline author') RETURNING *",
    [uuidv7(), `pipeline-${uuidv7()}`, `${uuidv7()}@example.test`])).rows[0];
  const cookie = server.cookieFor(user), request = (url, options = {}) => server.request(url, { cookie, ...options });
  const nodes = [{ id: "script", type: "file", name: "iris.lua", path: "iris.lua", content: variant.script || plugin },
    { id: "main", type: "file", name: "main.tex", path: "main.tex", content: "\\documentclass{article}\n\\begin{document}Browser fixture.\\end{document}\n" }];
  for (const [name, color] of [["red", rgb(1, 0, 0)], ["blue", rgb(0, 0, 1)]]) {
    const pdf = await PDFDocument.create(); pdf.addPage([200, 200]).drawRectangle({ x: 0, y: 0, width: 200, height: 200, color });
    nodes.push({ id: name, type: "file", name: `${name}.pdf`, path: `${name}.pdf`, binary: true,
      data: `data:application/pdf;base64,${(name === "blue" && variant.blueBytes ? variant.blueBytes : Buffer.from(await pdf.save())).toString("base64")}` });
  }
  const created = await request("/api/projects", { method: "POST", body: { name: "Pipeline browser", data: { projectType: "latex", language: variant.language || "en", autoSave: false, project: { nodes } } } });
  assert.equal(created.status, 201);
  const id = (await created.json()).project.id, base = `/api/projects/${id}`;
  let descriptor;
  const approve = async () => {
    const candidate = (await (await request(`${base}/pipeline`)).json()).pipeline.candidate;
    assert.equal((await request(`${base}/pipeline/approval`, { method: "POST", body: { identity: candidate } })).status, 201);
    const response = await request(`${base}/pipeline/inspect`, { method: "POST", body: {} });
    assert.equal(response.status, 200); descriptor = (await response.json()).descriptor;
  };
  const run = async (target = "main", parameters = {}) => {
    const response = await request(`${base}/runs`, { method: "POST", body: { target, parameters, descriptorHash: descriptor.descriptorHash } });
    assert.equal(response.status, 202, await response.clone().text());
    const runId = (await response.json()).run.id;
    let result;
    await until(async () => {
      result = (await (await request(`${base}/runs/${runId}`)).json()).run;
      return !["queued", "planning", "running"].includes(result.state);
    }, "browser fixture run", 10000);
    return result;
  };
  const context = await browser.newContext({ viewport: variant.viewport || { width: 1440, height: 900 }, reducedMotion: "reduce", colorScheme: variant.theme || "dark" });
  await context.addCookies([{ name: "iris_session", value: cookie.slice("iris_session=".length), url: server.baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const errors = [], downloads = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/artifacts\//.test(request.url())) downloads.push(request.url()); });
  t.after(async () => {
    try { if (!page.isClosed()) await page.evaluate(() => window.IrisCollab?.disconnect()); }
    finally { await context.close(); }
    assert.deepEqual(errors, []);
  });
  const open = async () => {
    await page.goto(server.baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(async id => { await IrisEditor.ready; await IrisProjects.openProject(id); }, id);
    await page.waitForFunction(() => IrisCollab.status() === "live");
  };
  const painted = runId => page.waitForFunction(id => {
    const canvas = document.querySelector(".pdf-page canvas");
    if (IrisApp.currentBuildId() !== id || !canvas || canvas.width < 40 || canvas.height < 40) return false;
    return [[20, 20], [canvas.width - 20, canvas.height - 20]].every(([x, y]) => {
      const [r, g, b, a] = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
      return r === 0 && g === 0 && b === 255 && a === 255;
    });
  }, runId, { timeout: 6000 });
  return { page, request, id, base, approve, run, open, painted, downloads };
}

test("pipeline preview selects the declared PDF and does not fetch attachment-only artifacts", options, async t => {
  const f = await fixture(t); await f.approve(); const run = await f.run();
  assert.equal(run.state, "succeeded");
  const detail = await (await f.request(`${f.base}/builds/${run.id}`)).json();
  await f.open();
  await f.painted(run.id);
  assert.equal(await f.page.locator("#pdfArtifact").inputValue(), detail.primaryPreviewArtifactId);
  const pixel = await f.page.locator(".pdf-page canvas").first().evaluate(canvas => [...canvas.getContext("2d").getImageData(20, 20, 1, 1).data]);
  assert.deepEqual(pixel, [0, 0, 255, 255]);
  const unsafe = detail.artifacts.find(a => a.mimeType === "text/html");
  assert.equal(f.downloads.some(url => url.endsWith(unsafe.url)), false);
});

test("pipeline raster primary uses its media type even when named with a PDF suffix", options, async t => {
  const f = await fixture(t, {
    script: plugin.replace("mediaType='application/pdf',path='z.pdf'", "mediaType='image/png',path='z.pdf'"),
    blueBytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jc1sAAAAASUVORK5CYII=", "base64"),
  });
  await f.approve(); const run = await f.run(); assert.equal(run.state, "succeeded"); await f.open();
  await f.page.waitForFunction(id => IrisApp.currentBuildId() === id && document.querySelector(".image-preview img")?.naturalWidth === 1, run.id, { timeout: 6000 });
  assert.equal(await f.page.locator(".image-preview img").count(), 1);
  assert.equal(await f.page.locator(".pdf-page").count(), 0);
});

for (const status of ["failed", "cancelled", "succeeded"]) test(`${status} run without artifacts preserves the painted preview and its navigation identity`, options, async t => {
  const f = await fixture(t); await f.approve(); const run = await f.run(); await f.open();
  await f.painted(run.id);
  const before = await f.page.locator(".pdf-page canvas").first().evaluate(canvas => canvas.toDataURL());
  await f.page.evaluate(status => IrisApp.showBuildOutput({ build: { id: "later-run", kind: "pipeline", target: "main", status,
    createdAt: Date.now(), diagnostics: status === "succeeded" ? [] : [{ severity: "error", message: "Later run failed" }] }, artifacts: [] }), status);
  assert.equal(await f.page.evaluate(() => IrisApp.currentBuildId()), run.id);
  assert.equal(await f.page.locator(".pdf-page canvas").first().evaluate(canvas => canvas.toDataURL()), before);
  if (status !== "succeeded") assert.match(await f.page.locator("#diagnosticsList").textContent(), /Later run failed/);
});

test("opening a project selects the latest accepted success instead of a newer failure", options, async t => {
  const f = await fixture(t); await f.approve(); const success = await f.run();
  const failure = await f.run("main", { fail: true }); assert.equal(failure.state, "failed");
  await f.open();
  await f.painted(success.id);
});

test("showing a successful PDF after failure diagnostics reveals the painted pages", options, async t => {
  const f = await fixture(t); await f.approve(); const run = await f.run(); await f.open(); await f.painted(run.id);
  await f.page.evaluate(async id => {
    await IrisApp.showBuildOutput({ build: { id: "later-failure", status: "failed", diagnostics: [{ severity: "error", message: "Failure" }] }, artifacts: [] });
    await IrisApp.showBuildOutput(await IrisProjects.loadBuildOutput(id));
  }, run.id);
  assert.equal(await f.page.locator("#pvStage").evaluate(node => node.classList.contains("hide-pages")), false);
  await f.painted(run.id);
});

for (const response of ["failed", "unavailable"]) test(`compiler ${response} response retains an existing painted pipeline PDF`, options, async t => {
  const f = await fixture(t); await f.approve(); const success = await f.run(); await f.open();
  await f.painted(success.id);
  const before = await f.page.locator(".pdf-page canvas").first().evaluate(canvas => canvas.toDataURL());
  await f.page.route(`**${f.base}/compile`, route => {
    const submitted = route.request().postDataJSON();
    return route.fulfill({ status: response === "failed" ? 200 : 503,
      contentType: "application/json", body: JSON.stringify(response === "failed"
        ? { success: false, buildId: "failed-compiler", artifacts: [], errors: ["Compiler fixture failure"], log: "Compiler fixture failure",
          revision: submitted.baseRevision + 1, data: submitted.data }
        : { errorCode: "COMPILE_BUSY" }) });
  });
  await f.page.locator("#btnCompile").click();
  await f.page.waitForFunction(() => !document.getElementById("btnCompile").disabled && document.getElementById("diagnosticsView").hidden === false);
  assert.equal(await f.page.evaluate(() => IrisApp.currentBuildId()), success.id);
  assert.equal(await f.page.locator(".pdf-page canvas").first().evaluate(canvas => canvas.toDataURL()), before);
});

for (const bulk of [false, true]) for (const later of ["failed", "check"]) test(`${bulk ? "bulk" : "single"} preview deletion ${later === "failed" ? "loads the remaining successful build" : "clears identity when the replacement has no output"}`, options, async t => {
  const f = await fixture(t); await f.approve(); const first = await f.run(), current = await f.run(); await f.open();
  await f.painted(current.id);
  await f.run(later === "check" ? "check" : "main", later === "failed" ? { fail: true } : {});
  await f.page.locator("#btnBuilds").click();
  if (bulk) {
    await f.page.locator(`[data-build-select="${current.id}"]`).check();
    await f.page.locator('[data-build-bulk-act="delete"]').click();
    await f.page.locator('[data-build-bulk-act="confirm"]').click();
  } else {
    await f.page.locator(`[data-build-open="${current.id}"]`).click();
    await f.page.locator('[data-build-act="delete"]').click();
    await f.page.locator('[data-build-act="confirm-delete"]').click();
  }
  await f.page.waitForFunction(id => IrisApp.currentBuildId() === id, later === "failed" ? first.id : null, { timeout: 6000 });
  if (later === "check") assert.equal(await f.page.locator(".pdf-page canvas").count(), 0);
});
