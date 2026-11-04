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
  const service = variant.server || server;
  const user = (await service.pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,$2,$3,'Pipeline author') RETURNING *",
    [uuidv7(), `pipeline-${uuidv7()}`, `${uuidv7()}@example.test`])).rows[0];
  const cookie = service.cookieFor(user), request = (url, options = {}) => service.request(url, { cookie, ...options });
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
  let browserCookie = cookie;
  if (variant.role) {
    const member = (await service.pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,$2,$3,'Pipeline member') RETURNING *",
      [uuidv7(), `member-${uuidv7()}`, `${uuidv7()}@example.test`])).rows[0];
    await service.pool.query("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)", [id, member.id, variant.role]);
    browserCookie = service.cookieFor(member);
  }
  let descriptor;
  const approve = async () => {
    const candidate = (await (await request(`${base}/pipeline`)).json()).pipeline.candidate;
    assert.equal((await request(`${base}/pipeline/approval`, { method: "POST", body: { identity: candidate } })).status, 201);
    const response = await request(`${base}/pipeline/inspect`, { method: "POST", body: {} });
    assert.equal(response.status, 200, await response.clone().text()); descriptor = (await response.json()).descriptor;
  };
  const submit = async (target = "main", parameters = {}) => {
    const response = await request(`${base}/runs`, { method: "POST", body: { target, parameters, descriptorHash: descriptor.descriptorHash } });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()).run;
  };
  const completed = async runId => {
    let result;
    await until(async () => {
      result = (await (await request(`${base}/runs/${runId}`)).json()).run;
      return !["queued", "planning", "running"].includes(result.state);
    }, "browser fixture run", 10000);
    return result;
  };
  const run = async (target = "main", parameters = {}) => completed((await submit(target, parameters)).id);
  const context = await browser.newContext({ viewport: variant.viewport || { width: 1440, height: 900 }, reducedMotion: "reduce", colorScheme: variant.theme || "dark" });
  await context.addCookies([{ name: "iris_session", value: browserCookie.slice("iris_session=".length), url: service.baseUrl }]);
  if (variant.theme) await context.addInitScript(theme => localStorage.setItem("iris_theme", theme), variant.theme);
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const notices = []; let deliverRun;
  if (!variant.holdRunNotices) page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    const message = JSON.parse(String(payload)); if (message.t === "run") notices.push(message);
  }));
  if (variant.holdRunNotices) await page.routeWebSocket("**/api/collab", socket => {
    const remote = socket.connectToServer();
    remote.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.t === "run") notices.push(message);
      else socket.send(raw);
    });
    deliverRun = message => socket.send(JSON.stringify(message));
  });
  const errors = [], downloads = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (/\/artifacts\//.test(request.url())) downloads.push(request.url()); });
  t.after(async () => {
    try { if (!page.isClosed()) await page.evaluate(() => window.IrisCollab?.disconnect()); }
    finally { await context.close(); }
    assert.deepEqual(errors, []);
  });
  const open = async () => {
    await page.goto(service.baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(async id => { await IrisEditor.ready; await IrisProjects.openProject(id); }, id);
    await page.waitForFunction(() => ["live", "readonly"].includes(IrisCollab.status()));
  };
  const painted = runId => page.waitForFunction(id => {
    const canvas = document.querySelector(".pdf-page canvas");
    if (IrisApp.currentBuildId() !== id || !canvas || canvas.width < 40 || canvas.height < 40) return false;
    return [[20, 20], [canvas.width - 20, canvas.height - 20]].every(([x, y]) => {
      const [r, g, b, a] = canvas.getContext("2d").getImageData(x, y, 1, 1).data;
      return r === 0 && g === 0 && b === 255 && a === 255;
    });
  }, runId, { timeout: 6000 });
  return { page, context, request, id, base, approve, run, submit, completed, open, painted, downloads, notices, deliverRun: message => deliverRun(message) };
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
  const metadata = (await (await f.request(`${f.base}/pipeline`)).json()).pipeline;
  await f.request(`${f.base}/pipeline/approval/${metadata.approval.id}`, { method: "DELETE" });
  await f.page.evaluate(() => IrisPipelines.refresh());
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

async function controls(f) {
  await f.page.locator("#btnSettings").click();
  const tab = f.page.locator('#settingsTabCompile');
  if (await tab.isVisible()) await tab.click();
  else await f.page.locator('.set-accordion-trigger[data-set="compile"]').click();
}

async function runState(f, wanted) {
  try { await f.page.waitForFunction(state => document.getElementById("pipelineRunState").dataset.state === state, wanted, { timeout: 10000 }); }
  catch (error) {
    const ui = await f.page.evaluate(() => ({ state: document.getElementById("pipelineRunState").textContent, notice: document.getElementById("pipelineNotice").textContent }));
    const builds = (await (await f.request(`${f.base}/builds`)).json()).builds.map(({ id, status, target }) => ({ id, status, target }));
    throw new Error(`${error.message}; ${JSON.stringify({ ui, builds, notices: f.notices.slice(-8) })}`);
  }
}

for (const [mode, message] of [["missing-tool", /not installed|cannot start/], ["unsupported-pdf", /cannot preserve/]]) {
  test(`mounted pipeline controls explain the ${mode} adapter failure`, options, async t => {
    const { failurePlugin } = require("./helpers/pipeline-failure.cjs");
    const service = await serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public"), LUA_BIN_PATH: process.env.LUA_BIN_PATH || "", LILYPOND_BIN_PATH: "/iris-missing-compiler" });
    const f = await fixture(t, { server: service, script: await failurePlugin(mode, "main.tex") });
    await f.approve(); await f.open(); await controls(f);
    await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineRun").click(); await runState(f, "failed");
    assert.match(await f.page.locator("#pipelineSteps").textContent(), message);
    await f.page.waitForFunction(() => document.querySelector("#diagnosticsList .diagnostic-message"));
    assert.match(await f.page.locator("#diagnosticsList").textContent(), message);
  });
}

test("Compile refreshes approval from another client instead of starting an ordinary compiler", options, async t => {
  const f = await fixture(t); await f.open(); await f.approve();
  const ordinary = [];
  f.page.on("request", request => { if (request.url().endsWith(`${f.base}/compile`)) ordinary.push(request.url()); });
  await f.page.locator("#btnCompile").click();
  await until(async () => ordinary.length || (await f.page.locator("#pipelineNotice").textContent()).length, "current Compile routing", 5000);
  assert.deepEqual(ordinary, []);
  assert.match(await f.page.locator("#pipelineNotice").textContent(), /Inspect/);
  assert.equal((await (await f.request(`${f.base}/builds`)).json()).builds.length, 0);
});

test("owners approve source, inspect parameters and targets, then run from mounted controls", options, async t => {
  const f = await fixture(t); await f.open(); await controls(f);
  assert.equal((await (await f.request(`${f.base}/pipeline`)).json()).pipeline.descriptor, null);
  await f.page.locator("#pipelineApprove").click();
  await f.page.locator("#pipelineInspect").click();
  await f.page.waitForFunction(() => document.querySelector('[data-pipeline-param="fail"]'));
  assert.equal((await (await f.request(`${f.base}/builds`)).json()).builds.length, 0);
  await f.page.locator("#pipelineTargetsInspect").click();
  await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.locator("#pipelineRun").click();
  await runState(f, "succeeded");
  const builds = (await (await f.request(`${f.base}/builds`)).json()).builds;
  assert.equal(builds.length, 1); assert.equal(builds[0].target, "main");
  await f.painted(builds[0].id);
  assert.match(await f.page.locator("#pipelineSteps").textContent(), /generate/);
});

test("parameter changes require target reinspection and a cancelled run retains its successful PDF", options, async t => {
  const f = await fixture(t); await f.approve(); const success = await f.run(); await f.open(); await f.painted(success.id); await controls(f);
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.locator('[data-pipeline-param="loop"]').check();
  assert.equal(await f.page.locator("#pipelineRun").isDisabled(), true);
  await f.page.locator("#pipelineTargetsInspect").click();
  await f.page.locator("#pipelineRun").click();
  await runState(f, "running");
  await f.page.locator("#pipelineCancel").click();
  await runState(f, "cancelled");
  assert.equal(await f.page.evaluate(() => IrisApp.currentBuildId()), success.id);
  await f.painted(success.id);
});

for (const [language, theme, width] of [["en", "dark", 1440], ["it", "light", 1440], ["en", "light", 390], ["it", "dark", 390]]) test(`pipeline controls stay reachable with keyboard focus: ${language}/${theme}/${width}`, options, async t => {
  const f = await fixture(t, { language, theme, viewport: { width, height: 850 } });
  const changedAt = Date.UTC(2026, 10, 4, 14, 35, 22);
  await server.pool.query("UPDATE projects SET lua_sources_changed_at=$2 WHERE id=$1", [f.id, new Date(changedAt)]);
  await f.approve(); await f.open(); await controls(f);
  assert.equal(await f.page.locator("#pipelineSource").textContent(), `${language === "it" ? "Sorgente" : "Source"}: iris.lua`);
  const formatted = await f.page.evaluate(at => IrisI18n.formatDate(at, { dateStyle: "medium", timeStyle: "medium" }), changedAt);
  assert.equal(await f.page.locator("#pipelineSourceChanged").textContent(), `${language === "it" ? "Ultima modifica dei sorgenti Lua" : "Lua sources last changed"}: ${formatted}`);
  assert.equal(await f.page.locator("#pipelineIdentity").isVisible(), false);
  const details = f.page.locator("#pipelineTechnicalDetails summary");
  await details.focus(); await details.press("Enter");
  assert.equal(await f.page.locator("#pipelineIdentity").isVisible(), true);
  assert.match(await f.page.locator("#pipelineIdentity").textContent(), /^[a-f0-9]{64}$/);
  await f.page.locator("#pipelineAutoApprove").focus(); await f.page.locator("#pipelineAutoApprove").press("Space");
  await f.page.waitForFunction(() => !document.getElementById("pipelineAutoApprove").disabled);
  assert.equal((await (await f.request(`${f.base}/pipeline`)).json()).pipeline.autoApproval.enabled, true);
  const inspector = f.page.locator("#pipelineTargetsInspect"); await inspector.focus(); await inspector.press("Enter");
  await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.locator("#pipelineRun").focus();
  assert.equal(await f.page.evaluate(() => document.activeElement.id), "pipelineRun");
  const panel = await f.page.locator("#pipelineControls").evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth, text: node.textContent }));
  assert.ok(panel.content <= panel.width + 1, JSON.stringify(panel));
  assert.equal(panel.text.includes("pipelines."), false);
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.theme), theme);
});

test("Lua source controls show unknown legacy history without inventing a date", options, async t => {
  const f = await fixture(t);
  await server.pool.query("UPDATE projects SET lua_sources_changed_at=NULL,lua_sources_hash=NULL WHERE id=$1", [f.id]);
  await f.open(); await controls(f);
  assert.equal(await f.page.locator("#pipelineSourceChanged").textContent(), "Lua sources last changed: Not recorded");
});

test("owner checkbox approves own saved Lua edits and leaves collaborator changes for manual approval", options, async t => {
  const f = await fixture(t); await f.approve(); await f.open(); await controls(f);
  await f.page.locator("#pipelineAutoApprove").check();
  await f.page.waitForFunction(() => !document.getElementById("pipelineAutoApprove").disabled);
  const edit = async (comment, cookie) => {
    const data = await (await f.request(f.base)).json();
    data.project.nodes.find(node => node.path === "iris.lua").content += `\n-- ${comment}`;
    const response = cookie ? await server.request(f.base, { cookie, method: "PUT", body: { data, baseRevision: data.revision } })
      : await f.request(f.base, { method: "PUT", body: { data, baseRevision: data.revision } });
    assert.equal(response.status, 200);
  };
  await edit("own edit");
  await f.page.locator("#pipelineRefresh").click();
  await f.page.waitForFunction(() => document.getElementById("pipelineStatus").textContent.startsWith("This source is approved"));
  await until(async () => {
    const m = (await (await f.request(`${f.base}/pipeline`)).json()).pipeline;
    return m.approval.bundleHash === m.candidate.bundleHash;
  }, "automatic source approval");
  const collaborator = (await server.pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,$2,$3,'Collaborator') RETURNING *",
    [uuidv7(), `collaborator-${uuidv7()}`, `${uuidv7()}@example.test`])).rows[0];
  await server.pool.query("INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'editor')", [f.id, collaborator.id]);
  await edit("collaborator edit", server.cookieFor(collaborator));
  await f.page.evaluate(() => IrisPipelines.refresh());
  assert.equal(await f.page.locator("#pipelineApprove").isEnabled(), true);
  const m = (await (await f.request(`${f.base}/pipeline`)).json()).pipeline;
  assert.notEqual(m.approval.bundleHash, m.candidate.bundleHash);
  await f.page.locator("#pipelineAutoApprove").uncheck();
  await f.page.waitForFunction(() => !document.getElementById("pipelineAutoApprove").disabled);
  assert.equal((await (await f.request(`${f.base}/pipeline`)).json()).pipeline.autoApproval.enabled, false);
});

test("viewers inspect retained run details but cannot approve, inspect Lua, run or cancel", options, async t => {
  const f = await fixture(t, { role: "viewer" }); await f.approve(); const run = await f.run(); await f.open(); await f.painted(run.id); await controls(f);
  assert.equal(await f.page.locator("#pipelineApprove").isVisible(), false);
  assert.equal(await f.page.locator("#pipelineRevoke").isVisible(), false);
  assert.equal(await f.page.locator("#pipelineAutoApprove").isVisible(), false);
  for (const id of ["pipelineInspect", "pipelineTargetsInspect", "pipelineRun", "pipelineCancel"]) assert.equal(await f.page.locator(`#${id}`).isDisabled(), true);
  await runState(f, "succeeded");
  assert.match(await f.page.locator("#pipelineSteps").textContent(), /generate/);
});

test("toolbar compilation runs the selected pipeline and failed-step diagnostics retain preview identity", options, async t => {
  const f = await fixture(t); await f.approve(); const success = await f.run(); await f.open(); await f.painted(success.id); await controls(f);
  await f.page.locator('[data-pipeline-param="fail"]').check();
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  await f.page.locator('#settingsModal [data-close]').first().click();
  await f.page.locator("#btnCompile").click(); await runState(f, "failed");
  await f.page.waitForFunction(() => document.getElementById("diagnosticsList").textContent.includes("Fixture failure"));
  assert.equal(await f.page.evaluate(() => IrisApp.currentBuildId()), success.id);
  assert.match(await f.page.locator("#diagnosticsList").textContent(), /Fixture failure/);
  assert.equal((await (await f.request(`${f.base}/builds`)).json()).builds[0].kind, "pipeline");
});

test("reconnecting after a manual history preview preserves the author's selected output", options, async t => {
  const f = await fixture(t); await f.approve(); const first = await f.run(); await f.run(); await f.open(); await controls(f);
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  await f.page.locator('#settingsModal [data-close]').first().click();
  await f.page.locator("#btnBuilds").click(); await f.page.locator(`[data-build-open="${first.id}"]`).click();
  await f.page.locator('[data-build-act="preview"]').click(); await f.painted(first.id);
  const resynced = f.page.waitForResponse(response => response.url().includes(`${f.base}/runs/`));
  await f.page.evaluate(id => { IrisCollab.disconnect(); IrisCollab.watchProject(id); }, f.id);
  await (await resynced).finished();
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.evaluate(() => IrisApp.currentBuildId()), first.id);
});

test("a delayed target detail cannot replace the current target's run controls", options, async t => {
  const f = await fixture(t); await f.approve(); const main = await f.run(), alternate = await f.run("alternate");
  await f.open(); await controls(f); await f.page.locator("#pipelineTargetsInspect").click();
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  let release, reached;
  const requested = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await f.page.route(`**${f.base}/runs/${main.id}`, async route => { reached(); await gate; await route.continue(); });
  t.after(() => release());
  await f.page.locator("#pipelineTarget").selectOption("main"); await requested;
  const current = f.page.waitForResponse(response => response.url().endsWith(`/runs/${alternate.id}`));
  await f.page.locator("#pipelineTarget").selectOption("alternate");
  await (await current).finished();
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await f.page.waitForFunction(id => IrisApp.currentBuildId() === id, alternate.id);
  const late = f.page.waitForResponse(response => response.url().endsWith(`/runs/${main.id}`));
  release(); await (await late).finished();
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await f.page.locator('[data-pipeline-param="fail"]').check();
  assert.match(await f.page.locator("#pipelineRunState").textContent(), /^alternate:/);
});

test("schema fields reject invalid values and preserve typed compound and enum parameters", options, async t => {
  const schema = `local schema={type='object',required={'count','config','mode','pages'},properties={
    count={type='integer',minimum=1,maximum=4,default=2},mode={type='string',enum={'draft','final'},default='draft'},
    config={type='object',required={'label'},properties={label={type='string',minLength=1}},default={label='demo'}},
    pages={type='array',items={type='integer'},default=iris.array{1,2}}}}`;
  const f = await fixture(t, { script: plugin.replace(/^local schema=.*\n/, `${schema}\n`) });
  await f.approve(); await f.open(); await controls(f);
  const count = f.page.locator('[data-pipeline-param="count"]'), config = f.page.locator('[data-pipeline-param="config"]');
  await count.fill("9"); await f.page.locator("#pipelineTargetsInspect").click();
  assert.equal(await count.evaluate(input => input.validity.rangeOverflow), true);
  assert.equal(await f.page.locator("#pipelineRun").isDisabled(), true);
  await count.fill("3"); await config.fill("{broken"); await f.page.locator("#pipelineTargetsInspect").click();
  assert.match(await f.page.locator("#pipelineNotice").textContent(), /valid JSON/);
  await config.fill('{"label":"typed"}'); await f.page.locator('[data-pipeline-param="mode"]').selectOption("1");
  await f.page.locator("#pipelineTargetsInspect").click();
  await f.page.locator("#pipelineTarget").selectOption("main"); await f.page.locator("#pipelineRun").click();
  await runState(f, "succeeded");
  const build = (await (await f.request(`${f.base}/builds`)).json()).builds[0];
  const { run } = await (await f.request(`${f.base}/runs/${build.id}`)).json();
  assert.deepEqual(run.parameters, { count: 3, mode: "final", config: { label: "typed" }, pages: [1, 2] });
});

for (const target of ["main", "alternate"]) test(`two clients retain accepted-order previews when ${target} finishes before an older main run`, options, async t => {
  const f = await fixture(t, { script: plugin.replace("if ctx.options.parameters.loop then while true do end end",
    "if ctx.options.parameters.loop then local n=0 for i=1,500000000 do n=n+1 end end") });
  await f.approve(); await f.open(); await controls(f);
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  const second = await f.context.newPage(); second.setDefaultTimeout(6000);
  await second.goto(server.baseUrl, { waitUntil: "networkidle" });
  await second.evaluate(async id => { await IrisEditor.ready; await IrisProjects.openProject(id); }, f.id);
  await controls({ page: second }); await second.locator("#pipelineTargetsInspect").click();
  await second.locator("#pipelineTarget").selectOption(target);
  await second.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  const older = await f.submit("main", { loop: true }); await runState(f, "running");
  await second.locator("#pipelineRun").click(); await runState({ ...f, page: second }, "succeeded");
  const listed = (await (await f.request(`${f.base}/builds`)).json()).builds;
  const newer = listed.find(build => build.id !== older.id); assert.ok(newer);
  const finalOlder = await f.completed(older.id);
  assert.equal(finalOlder.state, "succeeded");
  assert.ok(new Date(newer.completedAt) < new Date(finalOlder.completedAt), "the fixture must finish the newer run first");
  await second.waitForFunction(id => IrisApp.currentBuildId() === id, newer.id);
  const expected = target === "main" ? newer.id : older.id;
  await f.page.waitForFunction(id => IrisApp.currentBuildId() === id, expected);
  // Re-fetch after both completions so a delayed terminal notice cannot hide a
  // stale accepted-order selection in either client.
  await second.evaluate(id => { IrisCollab.disconnect(); IrisCollab.watchProject(id); }, f.id);
  await second.waitForFunction(() => document.getElementById("pipelineRunState").dataset.state === "succeeded");
  assert.equal(await second.evaluate(() => IrisApp.currentBuildId()), newer.id);
});

test("editors can run and cancel their own work while owner revocation disables further execution", options, async t => {
  const f = await fixture(t, { role: "editor" }); await f.approve(); await f.open(); await controls(f);
  assert.equal(await f.page.locator("#pipelineApprove").isVisible(), false);
  assert.equal(await f.page.locator("#pipelineAutoApprove").isVisible(), false);
  await f.page.locator('[data-pipeline-param="loop"]').check();
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.locator("#pipelineRun").click(); await runState(f, "running");
  assert.equal(await f.page.locator("#pipelineCancel").isEnabled(), true);
  await f.page.locator("#pipelineCancel").click(); await runState(f, "cancelled");
  const foreign = await f.submit("main", { loop: true });
  await runState(f, "running"); assert.equal(await f.page.locator("#pipelineCancel").isDisabled(), true);
  const metadata = (await (await f.request(`${f.base}/pipeline`)).json()).pipeline;
  assert.equal((await f.request(`${f.base}/pipeline/approval/${metadata.approval.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await f.completed(foreign.id)).state, "cancelled");
  await f.page.locator("#pipelineRefresh").click();
  await f.page.waitForFunction(() => document.getElementById("pipelineInspect").disabled);
  assert.equal(await f.page.locator("#pipelineRun").isDisabled(), true);
});

test("selecting a validation-only target clears another target's preview identity", options, async t => {
  const f = await fixture(t); await f.approve(); await f.run("check"); const main = await f.run();
  await f.open(); await f.painted(main.id); await controls(f);
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  await f.page.locator("#pipelineTarget").selectOption("check");
  await f.page.waitForFunction(() => IrisApp.currentBuildId() === null);
  assert.equal(await f.page.locator(".pdf-page canvas").count(), 0);
});

test("live edits during a pipeline run preserve the accepted source snapshot and later editor text", options, async t => {
  const f = await fixture(t, { script: plugin.replace("if ctx.options.parameters.loop then while true do end end",
    "if ctx.options.parameters.loop then local n=0 for i=1,500000000 do n=n+1 end end")
    .replace(`'<script>throw new Error("must not preview")</script>'`, "ctx.read('source','main.tex')") });
  await f.approve(); await f.open(); await controls(f);
  const original = await f.page.evaluate(() => IrisEditor.getValue());
  await f.page.locator('[data-pipeline-param="loop"]').check(); await f.page.locator("#pipelineTargetsInspect").click();
  await f.page.locator("#pipelineTarget").selectOption("main"); await f.page.locator("#pipelineRun").click(); await runState(f, "running");
  await f.page.evaluate(() => IrisEditor.replaceRange(0, 0, "% newer live edit\n"));
  await f.page.waitForFunction(() => !IrisCollab.pending());
  await runState(f, "succeeded");
  const build = (await (await f.request(`${f.base}/builds`)).json()).builds[0];
  const detail = await (await f.request(`${f.base}/builds/${build.id}`)).json();
  assert.equal(await (await f.request(detail.artifacts.find(a => a.outputPort === "unsafe").url)).text(), original);
  assert.equal(await f.page.evaluate(() => IrisEditor.getValue()), `% newer live edit\n${original}`);
});

test("replacing a project ignores the previous project's eventual pipeline completion", options, async t => {
  const f = await fixture(t, { script: plugin.replace("if ctx.options.parameters.loop then while true do end end",
    "if ctx.options.parameters.loop then local n=0 for i=1,500000000 do n=n+1 end end") });
  await f.approve(); await f.open(); await controls(f);
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  const run = await f.submit("main", { loop: true }); await runState(f, "running");
  const created = await f.request("/api/projects", { method: "POST", body: { name: "Replacement", data: { project: { nodes: [
    { type: "file", id: "replacement", name: "main.tex", path: "main.tex", content: "Replacement source" }] } } } });
  assert.equal(created.status, 201); const id = (await created.json()).project.id;
  await f.page.evaluate(id => IrisProjects.openProject(id), id);
  assert.equal((await f.completed(run.id)).state, "succeeded");
  assert.equal(await f.page.evaluate(() => IrisProjects.currentProjectId()), id);
  assert.equal(await f.page.evaluate(() => IrisApp.currentBuildId()), null);
  assert.equal(await f.page.locator("#pipelineRunState").textContent(), "");
  assert.equal(await f.page.evaluate(() => IrisEditor.getValue()), "Replacement source");
});

test("a notification gap and interleaved older progress cannot drop the newest run resync", options, async t => {
  const f = await fixture(t, { holdRunNotices: true }); await f.approve(); await f.run(); await f.open(); await controls(f);
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  const older = await f.run(), newer = await f.run();
  await until(() => f.notices.some(event => event.runId === newer.id && event.state === "succeeded"), "terminal socket notice", 3000);
  const oldNotices = f.notices.filter(event => event.runId === older.id);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { reached = resolve; });
  t.after(() => release());
  await f.page.route(`**${f.base}/runs/${older.id}`, async route => { reached(); await gate; await route.continue(); });
  f.deliverRun(oldNotices[0]); await requested;
  f.deliverRun(f.notices.find(event => event.runId === newer.id && event.state === "succeeded"));
  f.deliverRun(oldNotices.at(-1)); release();
  await f.painted(newer.id);
  assert.equal(await f.page.locator("#pipelineRunState").getAttribute("data-state"), "succeeded");
});

for (const update of ["new-run", "new-sequence"]) test(`delayed target history cannot replace live ${update} state after reconnect`, options, async t => {
  const f = await fixture(t, { holdRunNotices: true }); await f.approve(); const success = await f.run();
  await f.open(); await f.painted(success.id); await controls(f);
  await f.page.locator("#pipelineTargetsInspect").click(); await f.page.locator("#pipelineTarget").selectOption("main");
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  const old = update === "new-run" ? success : await f.submit("main", { loop: true });
  if (update === "new-sequence") await until(() => f.notices.some(event => event.runId === old.id && event.state === "running"), "old running notice", 5000);
  let release, reached, held = false;
  const gate = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { reached = resolve; });
  t.after(() => release());
  await f.page.route(`**${f.base}/runs/${old.id}`, async route => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch(); reached(); await gate;
    await route.fulfill({ response, headers: { ...response.headers(), "x-delayed-history": "1" } });
  });
  await f.page.evaluate(id => { IrisCollab.disconnect(); IrisCollab.watchProject(id); }, f.id);
  await requested;
  const newer = update === "new-run" ? await f.submit("main", { loop: true }) : old;
  t.after(() => f.request(`${f.base}/runs/${newer.id}/cancel`, { method: "POST", body: {} }));
  if (update === "new-sequence") await f.request(`${f.base}/runs/${old.id}/cancel`, { method: "POST", body: {} });
  const state = update === "new-run" ? "running" : "cancelled";
  await until(() => f.notices.some(event => event.runId === newer.id && event.state === state), "new run notice", 5000);
  f.deliverRun(f.notices.findLast(event => event.runId === newer.id && event.state === state));
  await runState(f, state);
  const response = f.page.waitForResponse(r => r.headers()["x-delayed-history"] === "1");
  release(); await (await response).finished();
  await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await f.page.locator("#pipelineRunState").getAttribute("data-state"), state);
  assert.equal(await f.page.locator("#pipelineCancel").isEnabled(), update === "new-run");
  assert.equal(await f.page.evaluate(() => IrisApp.currentBuildId()), success.id);
});

test("open-ended JSON parameters preserve a property named parameters after target inspection", options, async t => {
  const f = await fixture(t, { script: plugin.replace(/^local schema=.*\n/, "local schema={type='object',additionalProperties=true}\n") });
  await f.approve(); await f.open(); await controls(f);
  const parameters = f.page.locator('[data-pipeline-param="parameters"]');
  await parameters.fill('{"parameters":{"nested":true},"count":2}'); await f.page.locator("#pipelineTargetsInspect").click();
  await f.page.waitForFunction(() => !document.getElementById("pipelineRun").disabled);
  assert.deepEqual(JSON.parse(await parameters.inputValue()), { parameters: { nested: true }, count: 2 });
});
