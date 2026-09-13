const assert = require("node:assert/strict");
const { uuidv7 } = require("../../src/ids");
const { deferred } = require("./server-fixture.cjs");

const sources = {
  latex: { main: "\\documentclass{article}\n\\begin{document}\n\\setcounter{page}{7}\n\\input{parts/é section one.tex}\n\\newpage\nSecond page.\n\\end{document}\n",
    part: "A retained included source.\n", name: "é section one.tex", column: 5 },
  lilypond: { main: '\\version "2.26.0"\n\\include "parts/é air.ly"\n\\paper { first-page-number = 7 print-page-number = ##t }\n\\book { \\bookOutputSuffix "one" \\score { \\theme } \\pageBreak \\score { \\theme } }\n\\book { \\bookOutputSuffix "two" \\score { \\theme } }\n',
    part: 'theme = { \\override NoteHead.color = #red \\override Rest.color = #red c\'4^"é😀" <e\' g\'>4 r4 d\'4 }\n', name: "é air.ly", column: 92 },
};

async function journey(t, server, browser, backend = "latex", variant = {}) {
  const source = variant.source || sources[backend], extension = backend === "latex" ? "tex" : "ly";
  const user = (await server.pool.query("INSERT INTO users (id, username, email, display_name) VALUES ($1,$2,$3,$2) RETURNING *",
    [uuidv7(), `nav-${uuidv7()}`, `${uuidv7()}@example.test`])).rows[0];
  const cookie = server.cookieFor(user);
  const request = (url, options = {}) => server.request(url, { cookie, ...options });
  const created = await request("/api/projects", { method: "POST", body: { name: `Native ${backend}`, data: {
    projectType: backend, language: variant.language || "en", sourceMapping: variant.sourceMapping ?? true,
    project: { nodes: [{ type: "file", id: "main", name: `main.${extension}`, path: `main.${extension}`, kind: extension, content: source.main },
      { type: "folder", name: "parts", open: true, children: [{ type: "file", id: "part", name: source.name, path: `parts/${source.name}`, kind: extension, content: source.part }] }] },
  } } });
  assert.equal(created.status, 201); const data = await created.json(), projectId = data.project.id;
  const compiled = await request(`/api/projects/${projectId}/compile`, { method: "POST", body: {} });
  assert.equal(compiled.status, 200); const build = await compiled.json();
  assert.equal(build.success, true, build.log);
  const mainId = build.data.project.nodes[0].id, partId = build.data.project.nodes[1].children[0].id;
  const context = await browser.newContext({ viewport: variant.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: variant.scale || 1, reducedMotion: "reduce", colorScheme: variant.theme || "dark" });
  await context.addCookies([{ name: "iris_session", value: cookie.slice("iris_session=".length), url: server.baseUrl }]);
  if (variant.platform) await context.addInitScript((platform) => Object.defineProperty(navigator, "platform", { value: platform }), variant.platform);
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const errors = [], records = [], gates = new Set(); let responseOverride, hold, closing = false;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text()); });
  if (variant.pausePaint) await page.route("**/iris-app.js", async (route) => {
    const response = await route.fetch();
    // Delay only completion of real PDF painting, after the normal renderer has
    // produced its canvas. The navigation implementation and event paths run as shipped.
    const source = await response.text();
    assert.ok(source.includes("await task.promise;"));
    await route.fulfill({ response, body: source.replace("await task.promise;", "await task.promise; if (window.navigationPaintGate) await window.navigationPaintGate;") });
  });
  await page.route("**/navigation", async (route) => {
    try {
      const req = route.request();
      assert.equal(req.method(), "POST");
      assert.equal(new URL(req.url()).pathname, `/api/projects/${projectId}/builds/${build.buildId}/navigation`);
      const query = req.postDataJSON(), gate = hold; hold = null;
      const record = { query }; records.push(record);
      if (responseOverride) record.result = typeof responseOverride === "function" ? responseOverride(query) : responseOverride;
      else { const response = await route.fetch(); assert.equal(response.status(), 200); record.result = await response.json(); }
      if (gate) await gate.promise;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(record.result) });
    } catch (error) { if (!closing) errors.push(error.message); await route.abort().catch(() => {}); }
  });
  t.after(async () => {
    closing = true; gates.forEach((gate) => gate.resolve());
    try { if (!page.isClosed()) await page.evaluate(() => IrisCollab.disconnect()); }
    finally { await context.close(); }
    assert.deepEqual(errors, [], "browser runtime and route recorder errors");
  });
  await page.goto(server.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(async (id) => { await IrisEditor.ready; await IrisProjects.openProject(id); }, projectId);
  await page.waitForFunction(() => IrisCollab.status() === "live");
  await page.waitForFunction((id) => IrisApp.currentBuildId() === id && document.querySelector(".pdf-page canvas")?.width > 0, build.buildId);
  if (await page.locator("#workspaceSwitch").isVisible()) await page.locator('#workspaceSwitch [data-workspace="preview"]').click();
  await page.locator(".pdf-page canvas").first().waitFor();
  return { page, context, request, build, projectId, mainId, partId, source, records, errors,
    override(value) { responseOverride = value; },
    hold() { hold = deferred(); gates.add(hold); return hold; },
    async received(count) {
      const deadline = Date.now() + 6000;
      while (records.length < count || !records[count - 1]?.result) {
        if (Date.now() > deadline) assert.fail(`Expected ${count} navigation requests, got ${JSON.stringify(records)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(records.length, count, "one request per gesture"); return records[count - 1];
    },
  };
}

async function openSource(f, id = f.partId) {
  if (await f.page.locator("#btnSidebar").getAttribute("aria-expanded") === "false") await f.page.locator("#btnSidebar").click();
  await f.page.locator(`#tree .node[data-id="${id}"] .nm`).click();
  await f.page.waitForFunction((id) => IrisCollab.fileId() === id && ["live", "readonly"].includes(IrisCollab.status()), id);
}

async function sourceClick(page, column, modifiers) {
  const point = await page.evaluate(async (column) => {
    const { EditorView } = await import("@codemirror/view");
    const view = EditorView.findFromDOM(document.querySelector(".cm-content"));
    view.dispatch({ effects: EditorView.scrollIntoView(column, { x: "center" }) });
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const rect = view.coordsAtPos(column);
    return { x: rect.left + .1, y: (rect.top + rect.bottom) / 2 };
  }, column);
  const keys = modifiers || [await accelerator(page)];
  for (const key of keys) await page.keyboard.down(key);
  try { await page.mouse.click(point.x, point.y); }
  finally { for (const key of keys.reverse()) await page.keyboard.up(key); }
}
async function accelerator(page) { return page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"); }

async function pdfClick(f, match, { x = match.x + Math.min(3, match.width / 2), y = match.y + match.height / 2, modifiers } = {}) {
  const page = f.page.locator(".pdf-page").nth(match.page - 1);
  // Native fixtures have an unrotated A4 crop. The controlled crop/rotation
  // journey below supplies its hand-derived screen point separately.
  let box = await page.boundingBox();
  const stage = await f.page.locator("#pvStage").boundingBox();
  const targetY = box.y + y * box.height / 841.89;
  if (targetY < stage.y || targetY > stage.y + stage.height) { await page.scrollIntoViewIfNeeded(); box = await page.boundingBox(); }
  const keys = modifiers || [await accelerator(f.page)];
  for (const key of keys) await f.page.keyboard.down(key);
  try { await f.page.mouse.click(box.x + x * box.width / 595.276, box.y + y * box.height / 841.89); }
  finally { for (const key of keys.reverse()) await f.page.keyboard.up(key); }
}

async function snapshot(page) {
  return page.evaluate(() => ({ text: IrisEditor.getValue(), selection: IrisEditor.selection(), fileId: IrisApp.serialize().activeId,
    top: document.querySelector("#pvStage").scrollTop, left: document.querySelector("#pvStage").scrollLeft,
    page: document.querySelector("#pgCur").textContent, buildId: IrisApp.currentBuildId() }));
}

// New PDF fixture bytes, not a transformation of compiler output.
function croppedPdf(rotation) {
  const stream = "1 0 0 rg 70 262 10 8 re f\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /CropBox [20 30 220 330] /Rotate ${rotation} /Resources << >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 5\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  return Buffer.from(`${pdf}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`).toString("base64");
}

module.exports = { journey, openSource, sourceClick, pdfClick, snapshot, accelerator, sources, croppedPdf };
