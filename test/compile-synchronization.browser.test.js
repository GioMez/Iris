const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { uuidv7 } = require("../src/ids");
const { serverFixture, deferred } = require("./helpers/server-fixture.cjs");
const { until } = require("../scripts/lib/disposable.cjs");

const enabled = process.env.IRIS_TEST_BROWSER === "1" && process.env.IRIS_TEST_COMPILERS === "1" && process.env.IRIS_TEST_LUA === "1";
const options = { skip: !enabled, timeout: 45000 };
const before = "\\documentclass{article}\n\\begin{document}\nBefore edit.\n\\end{document}\n";
const after = before.replace("edit.", "edit!.");
const plugin = `return {apiVersion=1,pluginId='sync-test',plan=function()
return {apiVersion=1,pluginId='sync-test',steps={{id='copy',adapter={id='iris.lua',version='1.0.0'},
inputs={source={snapshot=true}},options={script='iris.lua',entrypoint='copy'},
outputs={text={kind='file',mediaType='text/plain',path='copied.txt'}}}},
targets={main={steps={'copy'},publish={{step='copy',port='text'}}}}}
end,copy=function(ctx) ctx.write('text','copied.txt',ctx.read('source','main.tex')) end}`;
let server, browser;
test.before(async t => {
  if (!enabled) return;
  server = await serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public"), PATH: process.env.PATH,
    RETENTION_ENABLED: "false", LUA_BIN_PATH: process.env.LUA_BIN_PATH || "" });
  browser = await chromium.launch({ headless: true, timeout: 10000,
    ...(process.env.IRIS_BROWSER_EXECUTABLE ? { executablePath: process.env.IRIS_BROWSER_EXECUTABLE } : { channel: "chrome" }) });
  t.after(() => browser.close());
});

async function fixture(t, { hold = false, lua = false, transport = false, image = false } = {}) {
  const user = (await server.pool.query("INSERT INTO users (id,username,email,display_name) VALUES ($1,$2,$3,'Synchronization test') RETURNING *",
    [uuidv7(), `sync-${uuidv7()}`, `${uuidv7()}@example.test`])).rows[0];
  const cookie = server.cookieFor(user);
  const request = (url, options = {}) => server.request(url, { cookie, ...options });
  const created = await request("/api/projects", { method: "POST", body: { name: "Synchronization", data: {
    projectType: "latex", language: "en", autoSave: false, sourceMapping: false,
    project: { nodes: [{ id: "main", type: "file", name: "main.tex", path: "main.tex", kind: "tex", content: before },
      { id: "other", type: "file", name: "other.tex", path: "other.tex", kind: "tex", content: "Other file." },
      ...(image ? [{ id: "image", type: "file", name: "image.png", path: "image.png", kind: "img",
        data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" }] : []),
      ...(lua ? [{ id: "plugin", type: "file", name: "iris.lua", path: "iris.lua", content: plugin }] : [])] },
  } } });
  assert.equal(created.status, 201);
  const id = (await created.json()).project.id, base = `/api/projects/${id}`;
  const data = await (await request(base)).json(), fileId = data.project.nodes.find(n => n.name === "main.tex").id;
  const otherId = data.project.nodes.find(n => n.name === "other.tex").id;
  await request(`${base}/checkpoint`, { method: "POST", body: {} });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, reducedMotion: "reduce" });
  await context.addCookies([{ name: "iris_session", value: cookie.slice("iris_session=".length), url: server.baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  let holding = hold, remote, local;
  const buffered = [], errors = [], uploads = [];
  if (hold || transport) await page.routeWebSocket("**/api/collab", socket => {
    local = socket;
    remote = socket.connectToServer();
    socket.onMessage(raw => {
      if (holding && JSON.parse(String(raw)).t === "push") buffered.push(raw);
      else remote.send(raw);
    });
  });
  const release = () => { holding = false; for (const raw of buffered.splice(0)) remote.send(raw); };
  t.after(async () => {
    release();
    for (const tab of context.pages()) await tab.evaluate(() => IrisCollab.disconnect()).catch(() => {});
    await context.close();
    assert.deepEqual(errors, [], "uncaught browser errors");
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().startsWith(server.baseUrl + base) && ["POST", "PUT"].includes(request.method())) uploads.push(request);
  });
  async function open(tab = page) {
    await tab.goto(server.baseUrl, { waitUntil: "networkidle" });
    await tab.evaluate(async id => { await IrisEditor.ready; await IrisProjects.openProject(id); }, id);
    await tab.waitForFunction(id => IrisCollab.fileId() === id && IrisCollab.status() === "live", fileId);
  }
  await open();
  if (lua) {
    await page.locator("#btnSettings").click(); await page.locator("#settingsTabCompile").click();
    await page.locator("#pipelineApprove").click(); await page.locator("#pipelineInspect").click();
    await page.locator("#pipelineTargetsInspect").click(); await page.locator("#pipelineTarget").selectOption("main");
    await page.locator("#settingsModal [data-close]").click();
  }
  uploads.length = 0;
  async function edit() {
    await page.locator(".cm-content").click();
    await page.evaluate(position => IrisEditor.select(position, position), before.indexOf("edit.") + 4);
    await page.keyboard.type("!");
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), after);
    assert.equal(await page.evaluate(() => IrisCollab.pending()), true);
  }
  const held = () => until(() => buffered.length > 0, "outgoing edit held");
  const disk = () => fs.readFile(path.join(server.dataDir, "projects", id, "main.tex"), "utf8");
  return { page, context, id, base, fileId, otherId, request, release, uploads, open, edit, held, disk,
    holdEdits() { holding = true; },
    drop() { remote.close({ code: 1012 }); local.close({ code: 1012 }); } };
}

for (const variant of [
  { action: "compile", hold: false },
  ...["compile", "save", "snapshot", "lua"].map(action => ({ action, hold: true })),
  { action: "save", hold: true, peer: true },
]) test(`${variant.action} includes a typed character${variant.hold ? " after delayed delivery" : " with normal transport"}${variant.peer ? " and a concurrent edit" : ""}`, options, async t => {
  const f = await fixture(t, { ...variant, lua: variant.action === "lua" }), { page, base } = f;
  let peer;
  if (variant.peer) { peer = await f.context.newPage(); await f.open(peer); }
  const suffix = { compile: "/compile", save: "", snapshot: "/checkpoint", lua: "/runs" }[variant.action];
  const response = page.waitForResponse(r => r.url() === server.baseUrl + base + suffix && r.request().method() === (variant.action === "save" ? "PUT" : "POST"));
  await f.edit();
  await page.locator({ compile: "#btnCompile", save: "#btnSave", snapshot: "#btnSnapshot", lua: "#btnCompile" }[variant.action]).click();
  if (variant.hold) {
    await f.held();
    assert.equal(f.uploads.length, 0, "HTTP action must wait for its local edit");
    assert.equal(await f.disk(), before);
    if (peer) {
      await peer.locator(".cm-content").click();
      await peer.evaluate(position => IrisEditor.select(position, position), before.indexOf("Before"));
      await peer.keyboard.type("Other ");
      await peer.waitForFunction(() => !IrisCollab.pending());
      await page.waitForFunction(() => IrisEditor.getValue().includes("Other Before"));
    }
    f.release();
  }
  const http = await response, result = await http.json();
  assert.equal(http.ok(), true, JSON.stringify(result));
  const expected = variant.peer ? after.replace("Before", "Other Before") : after;
  if (variant.action === "compile") {
    assert.equal(result.success, true, result.log);
    const row = (await server.pool.query("SELECT v.content FROM build_outputs b JOIN document_versions v ON v.id=b.source_revision_id WHERE b.id=$1", [result.buildId])).rows[0];
    assert.equal(row.content, expected);
  } else if (variant.action === "snapshot") {
    const row = (await server.pool.query("SELECT content FROM document_versions WHERE file_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [f.fileId])).rows[0];
    assert.equal(row.content, expected);
  } else if (variant.action === "lua") {
    let run;
    await until(async () => { run = (await (await f.request(`${base}/runs/${result.run.id}`)).json()).run; return ["succeeded", "failed", "cancelled"].includes(run.state); }, "Lua completion", 15000);
    assert.equal(run.state, "succeeded", JSON.stringify(run));
    const detail = await (await f.request(`${base}/builds/${run.id}`)).json();
    const artifact = detail.artifacts.find(item => item.path.endsWith("copied.txt"));
    assert.ok(artifact); assert.equal(await (await f.request(artifact.url)).text(), expected);
  } else assert.equal(await f.disk(), expected);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), expected);
});

for (const departure of ["project", "file", "tab"]) test(`${departure} departure waits for delayed edit confirmation`, options, async t => {
  const f = await fixture(t, { hold: true }), { page } = f;
  await f.edit();
  if (departure === "project") await page.locator("#btnCloseProject").click();
  else if (departure === "tab") await page.locator('#ftabs [role="tab"]').first().locator(".x").click();
  else await page.locator(`#tree .node[data-id="${f.otherId}"] .nm`).click();
  await f.held();
  assert.equal(await page.evaluate(() => IrisProjects.currentProjectId()), f.id);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), after);
  assert.equal(await page.locator("#projUnsavedModal").evaluate(node => node.classList.contains("on")), false);
  f.release();
  if (departure === "project") {
    await page.waitForFunction(() => IrisProjects.currentProjectId() === null);
    await page.evaluate(id => IrisProjects.openProject(id), f.id);
  } else {
    await page.waitForFunction(id => IrisCollab.fileId() !== id, f.fileId);
    await page.locator(`#tree .node[data-id="${f.fileId}"] .nm`).click();
  }
  await page.waitForFunction(id => IrisCollab.fileId() === id && IrisCollab.status() === "live", f.fileId);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), after);
  assert.equal(await f.disk(), after);
});

test("rapid Save then project close preserves a single keystroke with normal transport", options, async t => {
  const f = await fixture(t), { page } = f;
  await f.edit(); await page.locator("#btnSave").click(); await page.locator("#btnCloseProject").click();
  await page.waitForFunction(() => IrisProjects.currentProjectId() === null);
  await page.evaluate(id => IrisProjects.openProject(id), f.id);
  await page.waitForFunction(id => IrisCollab.fileId() === id && IrisCollab.status() === "live", f.fileId);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), after);
  assert.equal(await f.disk(), after);
});

test("reselecting the current tab cancels a delayed file switch", options, async t => {
  const f = await fixture(t, { hold: true }), { page } = f;
  await f.edit();
  await page.locator(`#tree .node[data-id="${f.otherId}"] .nm`).click(); await f.held();
  await page.locator('#ftabs [role="tab"]').first().click();
  f.release(); await page.waitForFunction(() => !IrisCollab.pending());
  assert.equal(await page.evaluate(() => IrisCollab.fileId()), f.fileId);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), after);
  assert.equal(await page.locator('#ftabs [aria-selected="true"]').textContent().then(text => text.includes("main.tex")), true);
});

test("late Save response preserves offline edits while a peer holds the authoritative room", options, async t => {
  const f = await fixture(t, { transport: true }), { page } = f;
  const peer = await f.context.newPage(); await f.open(peer);
  const captured = deferred(), releaseResponse = deferred();
  let holdResponse = true;
  t.after(() => releaseResponse.resolve());
  await page.route(server.baseUrl + f.base, async route => {
    if (!holdResponse || route.request().method() !== "PUT") return route.continue();
    holdResponse = false;
    const response = await route.fetch(); captured.resolve();
    await releaseResponse.promise; await route.fulfill({ response });
  });
  await f.edit(); await page.locator("#btnSave").click(); await captured.promise;
  f.holdEdits(); f.drop();
  await page.waitForFunction(() => IrisCollab.status() === "offline");
  await page.locator(".cm-content").click();
  await page.evaluate(position => IrisEditor.select(position, position), after.indexOf("!.") + 1);
  await page.keyboard.type("?");
  const expected = after.replace("!.", "!?.");
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), expected);
  const response = page.waitForResponse(r => r.url() === server.baseUrl + f.base && r.request().method() === "PUT");
  releaseResponse.resolve(); await response;
  await page.waitForFunction(() => !document.querySelector("#btnSave").disabled);
  assert.equal(await page.evaluate(() => IrisCollab.pending()), true);
  const count = f.uploads.length;
  await page.locator("#btnSave").click(); await f.held();
  assert.equal(f.uploads.length, count, "the next Save must wait for the offline edit");
  const saved = page.waitForResponse(r => r.url() === server.baseUrl + f.base && r.request().method() === "PUT");
  f.release(); assert.equal((await saved).ok(), true);
  assert.equal(await f.disk(), expected);
  await peer.waitForFunction(expected => IrisEditor.getValue() === expected, expected);
});

test("logout prevents typing during its final Save and delayed session response", options, async t => {
  const f = await fixture(t), { page } = f;
  const saved = deferred(), releaseSave = deferred(), loggingOut = deferred(), releaseLogout = deferred();
  t.after(() => { releaseSave.resolve(); releaseLogout.resolve(); });
  await page.route(server.baseUrl + f.base, async route => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch(); saved.resolve();
    await releaseSave.promise; await route.fulfill({ response });
  });
  await page.route("**/api/auth/logout", async route => {
    loggingOut.resolve(); await releaseLogout.promise; await route.continue();
  });
  await f.edit();
  await page.locator("#userChip").click(); await page.locator("#miLogout").click();
  await page.locator("#logoutConfirm").click(); await saved.promise;
  for (const gate of [releaseSave, releaseLogout]) {
    await page.locator(".cm-content").click(); await page.keyboard.type("not accepted");
    await page.keyboard.press("Backspace");
    assert.equal(await page.evaluate(() => IrisEditor.getValue()), after);
    gate.resolve();
    if (gate === releaseSave) await loggingOut.promise;
  }
  await page.waitForFunction(() => IrisProjects.currentProjectId() === null);
  assert.equal(await f.disk(), after);
});

test("compact source reselection exits image preview and keeps collaboration", options, async t => {
  const f = await fixture(t, { image: true }), { page } = f;
  await page.setViewportSize({ width: 600, height: 900 });
  await page.locator("#btnSidebar").click();
  await page.locator("#tree .node .nm").filter({ hasText: /^image\.png$/ }).click();
  assert.equal(await page.locator(".body").evaluate(node => node.classList.contains("workspace-preview")), true);
  await page.locator("#btnSidebar").click();
  await page.locator("#tree .node .nm").filter({ hasText: /^main\.tex$/ }).click();
  assert.equal(await page.locator(".body").evaluate(node => node.classList.contains("workspace-preview")), false);
  assert.equal(await page.locator(".cm-content").evaluate(node => node.contains(document.activeElement)), true);
  await f.edit(); await page.waitForFunction(() => !IrisCollab.pending());
  assert.equal(await page.evaluate(() => IrisCollab.fileId()), f.fileId);
});

test("synchronization timeout keeps the editor and prevents a false successful Save", options, async t => {
  const f = await fixture(t, { hold: true }), { page } = f;
  await page.evaluate(() => {
    window.syncFailures = [];
    document.addEventListener("iris:projecterror", event => syncFailures.push(event.detail.code));
  });
  await f.edit(); await page.locator("#btnSave").click(); await f.held();
  await page.waitForFunction(() => syncFailures.includes("COLLAB_SYNC_TIMEOUT"));
  assert.equal(f.uploads.length, 0);
  assert.equal(await page.evaluate(() => IrisEditor.getValue()), after);
  assert.equal(await page.evaluate(() => IrisApp.hasUnsavedChanges()), true);
  f.release(); await page.waitForFunction(() => !IrisCollab.pending());
  const saved = page.waitForResponse(r => r.url() === server.baseUrl + f.base && r.request().method() === "PUT");
  await page.locator("#btnSave").click(); assert.equal((await saved).ok(), true);
  assert.equal(await f.disk(), after);
});
