const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { journey, openSource, sourceClick, pdfClick, snapshot, accelerator, croppedPdf } = require("./helpers/source-navigation-browser.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";
const options = { skip: !enabled, timeout: 30000 };
let server, browser;
test.before(async (t) => {
  if (!enabled) return;
  assert.ok(process.env.TEST_DATABASE_URL, "requires isolated PostgreSQL");
  server = await require("./helpers/server-fixture.cjs").serverFixture(t, { PUBLIC_DIR: path.resolve(__dirname, "../public"), PATH: process.env.PATH });
  browser = await chromium.launch({ headless: true, channel: "chrome", timeout: 10000 });
  t.after(() => browser.close());
  t.diagnostic(`Browser ${browser.version()}; native routes at ${server.baseUrl}`);
});

test("mapping checkbox defaults on, saves/reopens false and gates viewer permissions", options, async (t) => {
  const f = await journey(t, server, browser);
  await f.page.locator("#btnSettings").click();
  await f.page.locator('.set-nav [data-set="compile"]').click();
  const checkbox = f.page.getByRole("checkbox", { name: "Enable PDF–source mapping" });
  assert.equal(await checkbox.isChecked(), true);
  await checkbox.uncheck();
  assert.equal(await f.page.evaluate(() => IrisApp.serialize().sourceMapping), false);
  await f.page.evaluate(() => IrisApp.waitForPersistence());
  assert.equal((await (await f.request(`/api/projects/${f.projectId}`)).json()).sourceMapping, false);
  await f.page.evaluate(async (id) => { await IrisProjects.openProject(id); }, f.projectId);
  await f.page.waitForFunction(() => IrisCollab.status() === "live");
  assert.equal(await f.page.evaluate(() => IrisApp.serialize().sourceMapping), false);
  await f.page.evaluate(() => IrisApp.setRole("viewer"));
  assert.equal(await checkbox.isDisabled(), true);
});

for (const backend of ["latex", "lilypond"]) test(`native ${backend}: clicked UTF-16 source → real route → rendered PDF → authoritative included source`, options, async (t) => {
  const f = await journey(t, server, browser, backend, backend === "latex" ? { platform: "Linux x86_64" } : {});
  await openSource(f);
  await f.page.evaluate(() => IrisEditor.select(0, 0));
  await sourceClick(f.page, f.source.column);
  const forward = await f.received(1);
  assert.deepEqual(forward.query, { direction: "forward", sourceFileId: f.partId, line: 1, column: f.source.column, artifactId: f.build.artifacts[0].id, page: 1 });
  assert.equal(forward.result.status, "ready");
  const match = forward.result.matches[0];
  await f.page.locator(".source-navigation-highlight").waitFor();
  const contrast = await f.page.locator(".source-navigation-highlight").evaluate((node) => {
    const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = (color) => rgb(color).map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const ink = luminance(getComputedStyle(node).borderTopColor), paper = luminance(getComputedStyle(node.parentElement).backgroundColor);
    return (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05);
  });
  assert.ok(contrast >= 3, `navigation marker against document paper: ${contrast}`);
  assert.equal((await snapshot(f.page)).selection.from, 0, "modified click does not move the old selection");
  await openSource(f, f.mainId);
  await pdfClick(f, match);
  const inverse = await f.received(2);
  assert.equal(inverse.query.direction, "inverse");
  assert.deepEqual(Object.keys(inverse.query).sort(), ["artifactId", "direction", "page", "x", "y"]);
  assert.equal(inverse.result.matches[0].sourceFileId, f.partId);
  await f.page.waitForFunction((id) => IrisApp.serialize().activeId === id && IrisEditor.selection().from > 0 ||
    IrisApp.serialize().activeId === id && IrisEditor.selection().to > 0, f.partId);
  const after = await snapshot(f.page);
  assert.equal(after.text, f.source.part);
  assert.equal(after.selection.from, backend === "latex" ? 0 : f.source.column);
  assert.equal(after.selection.to, backend === "latex" ? f.source.part.trimEnd().length : f.source.column);
  assert.equal(await f.page.locator(".cm-content").evaluate((node) => node === document.activeElement), true);
  t.diagnostic(JSON.stringify({ backend, artifacts: f.build.artifacts.map(({ id, name, size }) => ({ id, name, size })), forward: match, inverse: inverse.result.matches[0] }));
});

async function nativeMatch(f) {
  const response = await f.request(`/api/projects/${f.projectId}/builds/${f.build.buildId}/navigation`, { method: "POST",
    body: { direction: "forward", sourceFileId: f.partId, line: 1, column: f.source.column } });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.status, "ready"); return result.matches[0];
}
async function settle(page) { await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150))); }

for (const direction of ["forward", "inverse"]) test(`native cropped PDF ${direction} uses original page geometry and preserves compiler bytes`, options, async (t) => {
  const source = { main: "\\documentclass[a4paper]{article}\n\\pdfpageattr{/CropBox [50 50 550 780]}\n\\begin{document}\nFirst target line.\\par\n\\vspace{60pt}\nSecond target line.\\par\n\\end{document}\n",
    part: "Unused include.\n", name: "part.tex", column: 0 };
  const f = await journey(t, server, browser, "latex", { source, scale: 2 });
  const artifact = f.build.artifacts[0];
  const url = `/api/projects/${f.projectId}/builds/${f.build.buildId}/artifacts/${artifact.id}`;
  const original = Buffer.from(await (await f.request(url)).arrayBuffer());
  assert.ok(original.length > 10000);
  assert.deepEqual(original, Buffer.from(artifact.base64, "base64"), "retained bytes equal the compile response");
  // Qualify real first-line ink independently of navigation coordinates. The
  // second paragraph and page number lie below this 100-point cropped band.
  const ink = await f.page.locator(".pdf-page").evaluate((node) => {
    const canvas = node.querySelector("canvas"), rect = node.getBoundingClientRect();
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    const points = [];
    for (let y = 0; y < canvas.height * 100 / 730; y++) for (let x = 0; x < canvas.width; x++) {
      const i = 4 * (y * canvas.width + x);
      if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) points.push([x / canvas.width, y / canvas.height]);
    }
    return { points, width: rect.width, height: rect.height };
  });
  assert.ok(ink.points.length > 100, "real first-line raster ink");
  if (direction === "forward") {
    const offset = source.main.indexOf("First target") + 3;
    await sourceClick(f.page, offset);
    const record = await f.received(1);
    assert.equal(record.query.line, 4); assert.equal(record.result.status, "ready");
    await f.page.locator(".source-navigation-highlight").waitFor();
    const rect = await f.page.locator(".pdf-page").boundingBox();
    const mark = await f.page.locator(".source-navigation-highlight").boundingBox();
    const uncovered = ink.points.filter(([x, y]) => {
      const px = rect.x + x * rect.width, py = rect.y + y * rect.height;
      const tolerance = rect.width / 500;
      return px < mark.x - tolerance || px > mark.x + mark.width + tolerance || py < mark.y - tolerance || py > mark.y + mark.height + tolerance;
    });
    t.diagnostic(JSON.stringify({ direction, ink: ink.points.length, uncovered: uncovered.length, match: record.result.matches[0] }));
    assert.equal(uncovered.length, 0, "native marker must cover all first-line ink");
  } else {
    // Inverse is the first navigation: no forward result can seed its geometry.
    const [x, y] = ink.points[Math.floor(ink.points.length / 2)];
    const rect = await f.page.locator(".pdf-page").boundingBox(), modifier = await accelerator(f.page);
    await f.page.keyboard.down(modifier);
    try { await f.page.mouse.click(rect.x + x * rect.width, rect.y + y * rect.height); }
    finally { await f.page.keyboard.up(modifier); }
    const record = await f.received(1);
    assert.equal(record.result.status, "ready");
    t.diagnostic(JSON.stringify({ direction, ink: ink.points.length, query: record.query, match: record.result.matches[0] }));
    assert.equal(record.result.matches[0].line, 4, "clicked first paragraph must resolve its source row");
    await f.page.waitForFunction((offset) => IrisEditor.selection().from === offset, source.main.indexOf("First target"));
  }
  assert.deepEqual(Buffer.from(await (await f.request(url)).arrayBuffer()), original);
  const downloaded = f.page.waitForEvent("download");
  await f.page.locator("#dlBtn").click();
  const download = await downloaded;
  try {
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), original, "viewer downloads the original compiler bytes after navigation");
  } finally { await download.delete(); }
});

for (const backend of ["latex", "lilypond"]) test(`${backend}: dirty source and delayed edited response preserve editor selection and PDF anchor`, options, async (t) => {
  const f = await journey(t, server, browser, backend);
  await openSource(f); await f.page.evaluate(() => IrisEditor.select(2, 4));
  await f.page.evaluate(() => IrisEditor.replaceRange(IrisEditor.getValue().length, IrisEditor.getValue().length, "% dirty\n"));
  const before = await snapshot(f.page);
  await sourceClick(f.page, f.source.column); await f.received(1);
  await f.page.getByText("The source has changed since this build. Recompile before navigating.", { exact: true }).waitFor();
  assert.deepEqual(await snapshot(f.page), before);
  await f.page.evaluate((text) => IrisEditor.applyText(text), f.source.part);
  await f.page.waitForFunction(() => !IrisCollab.pending());
  const hold = f.hold(); await sourceClick(f.page, f.source.column); await f.received(2);
  await f.page.evaluate(() => { IrisEditor.replaceRange(0, 0, "% newer\n"); IrisEditor.select(1, 3); });
  const edited = await snapshot(f.page); hold.resolve(); await settle(f.page);
  assert.deepEqual(await snapshot(f.page), edited);
  assert.equal(await f.page.locator(".source-navigation-highlight").count(), 0);
});

test("original geometry work is lazy, cancellable, cached per artifact and absent while mapping is off", options, async (t) => {
  const f = await journey(t, server, browser, "latex"), match = await nativeMatch(f);
  await f.page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.geometryWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (url === "/iris-pdf-geometry-worker.js") { this.live = true; window.geometryWorkers.push(this); }
      }
      terminate() { this.live = false; return super.terminate(); }
    };
  });
  const workers = () => f.page.evaluate(() => geometryWorkers.map((worker) => worker.live));
  const toggle = async (enabled) => {
    await f.page.locator("#btnSettings").click(); await f.page.locator('.set-nav [data-set="compile"]').click();
    await f.page.locator("#compileSourceMapping").setChecked(enabled);
    await f.page.evaluate(() => IrisMotion.closeDialog("settingsModal"));
    await f.page.evaluate(() => IrisApp.waitForPersistence());
  };
  await toggle(false);
  await pdfClick(f, match); await settle(f.page);
  assert.deepEqual(await workers(), []); assert.equal(f.records.length, 0);
  await toggle(true);
  const { deferred } = require("./helpers/server-fixture.cjs"), gate = deferred(), entered = deferred();
  t.after(() => gate.resolve());
  await f.page.route("**/iris-pdf-geometry-worker.js", async (route) => {
    entered.resolve(); await gate.promise;
    await route.continue().catch(() => {});
  });
  await pdfClick(f, match); await entered.promise;
  assert.deepEqual(await workers(), [true]);
  await toggle(false);
  assert.deepEqual(await workers(), [false]);
  gate.resolve(); await settle(f.page); assert.equal(f.records.length, 0);
  await f.page.unroute("**/iris-pdf-geometry-worker.js");
  await toggle(true); await pdfClick(f, match); await f.received(1);
  await f.page.waitForFunction((id) => IrisApp.serialize().activeId === id, f.partId);
  assert.deepEqual(await workers(), [false, false]);
  await sourceClick(f.page, 5); await f.received(2);
  await f.page.locator(".source-navigation-highlight").waitFor();
  assert.deepEqual(await workers(), [false, false], "forward reuses this artifact's acquired MediaBoxes");
  // Exercise both the worker's parser-error response and its hard time limit.
  const failure = await f.page.evaluate(async () => {
    try { await IrisSourceNavigation.loadPdfGeometry(new TextEncoder().encode("%PDF-broken")); }
    catch (error) { return error.message; }
  });
  assert.equal(failure, "PDF geometry unavailable");
  assert.deepEqual(await workers(), [false, false, false]);
  await f.page.route("**/iris-pdf-geometry-worker.js", (route) => route.fulfill({ contentType: "text/javascript", body: "self.onmessage = () => {};" }));
  const timeout = await f.page.evaluate(async () => {
    try { await IrisSourceNavigation.loadPdfGeometry(new Uint8Array([1])); }
    catch (error) { return error.message; }
  });
  assert.equal(timeout, "PDF geometry timeout");
  assert.deepEqual(await workers(), [false, false, false, false]);
});

test("inverse checks the inactive room authority before changing either pane, including a deleted source", options, async (t) => {
  const f = await journey(t, server, browser, "latex"), match = await nativeMatch(f);
  // A real peer holds newer text in the authority while this tab keeps its old
  // inactive tree cache. No source GET or cached-content hash may authorize it.
  const peer = await f.context.newPage();
  await peer.goto(server.baseUrl, { waitUntil: "networkidle" });
  await peer.evaluate(async (id) => { await IrisEditor.ready; await IrisProjects.openProject(id); }, f.projectId);
  await openSource({ ...f, page: peer });
  await peer.evaluate(() => IrisEditor.applyText("A newer authoritative paragraph.\n"));
  await peer.waitForFunction(() => !IrisCollab.pending());
  f.override({ status: "ready", matches: [match] });
  const before = await snapshot(f.page); await pdfClick(f, match); await f.received(1);
  await f.page.getByText("The source has changed since this build. Recompile before navigating.", { exact: true }).waitFor();
  assert.deepEqual(await snapshot(f.page), before);
  await peer.evaluate(() => IrisCollab.disconnect()); await peer.close();
  const data = await (await f.request(`/api/projects/${f.projectId}`)).json();
  data.project.nodes[1].children = [];
  const removed = await f.request(`/api/projects/${f.projectId}`, { method: "PUT", body: { baseRevision: data.revision, data } });
  assert.equal(removed.status, 200);
  await pdfClick(f, match); await f.received(2);
  await f.page.getByText("This build or source has no available map. Compile again with PDF–source mapping enabled.", { exact: true }).waitFor();
  assert.deepEqual(await snapshot(f.page), before);
});

test("old responses cannot override a newer request, file, build, PDF resize or preview close", options, async (t) => {
  const f = await journey(t, server, browser, "lilypond"), match = await nativeMatch(f);
  await openSource(f);
  for (const change of ["request", "file", "resize", "preview", "build"]) {
    f.override({ status: "ready", matches: [{ ...match, page: 2 }] });
    const gate = f.hold(), count = f.records.length + 1;
    await sourceClick(f.page, f.source.column); await f.received(count);
    if (change === "request") {
      f.override({ status: "ready", matches: [match] });
      await sourceClick(f.page, f.source.column); await f.received(count + 1);
      await f.page.locator('.pdf-page[data-page="1"] .source-navigation-highlight').waitFor();
    } else if (change === "file") await openSource(f, f.mainId);
    else if (change === "resize") { await f.page.locator("#zIn").click(); await settle(f.page); }
    else if (change === "preview") await f.page.locator("#btnPreview").click();
    else await f.page.evaluate(() => IrisApp.clearBuildOutput());
    const before = await snapshot(f.page); gate.resolve(); await settle(f.page);
    assert.deepEqual(await snapshot(f.page), before, change);
    if (change === "preview") {
      assert.equal(await f.page.locator("#previewPane").isVisible(), false, "late mapping must not reopen a closed preview");
      await f.page.locator("#btnPreview").click();
    }
    if (change === "file") await openSource(f);
  }
});

test("ordinary clicks, Alt/Shift gestures and repeated file loads do not duplicate navigation", options, async (t) => {
  const f = await journey(t, server, browser), match = await nativeMatch(f);
  await openSource(f);
  for (const modifiers of [[], ["Alt"], ["Shift"], ["Control", "Shift"], ["Meta", "Alt"]]) await sourceClick(f.page, 5, modifiers);
  for (const modifiers of [[], ["Alt"], ["Shift"]]) await pdfClick(f, match, { modifiers });
  await settle(f.page); assert.equal(f.records.length, 0);
  for (let i = 0; i < 3; i++) { await openSource(f, f.mainId); await openSource(f); }
  await sourceClick(f.page, 5); await f.received(1);
  await f.page.locator(".source-navigation-highlight").waitFor();
});

test("keyboard preview toggle retains canvases and source navigation follows renamed IDs", options, async (t) => {
  const f = await journey(t, server, browser);
  const data = await (await f.request(`/api/projects/${f.projectId}`)).json();
  data.project.nodes[1].children[0].name = "renamed.tex"; data.project.nodes[1].children[0].path = "parts/renamed.tex";
  assert.equal((await f.request(`/api/projects/${f.projectId}`, { method: "PUT", body: { baseRevision: data.revision, data } })).status, 200);
  await f.page.locator("#refreshTreeBtn").click();
  await f.page.locator(`#tree .node[data-id="${f.partId}"] .nm`).filter({ hasText: "renamed.tex" }).waitFor();
  await openSource(f);
  await f.page.evaluate(() => { IrisEditor.select(7, 7); window.navigationCanvas = document.querySelector(".pdf-page canvas"); });
  await f.page.locator("#btnPreview").click();
  await f.page.locator("#btnPreview").focus(); await f.page.keyboard.press("Enter");
  assert.equal(await f.page.locator("#previewPane").isVisible(), true);
  assert.equal(f.records.length, 0, "opening the panel is independent of source navigation");
  await sourceClick(f.page, 7);
  assert.equal((await f.received(1)).query.column, 7);
  await f.page.locator(".source-navigation-highlight").waitFor();
  assert.equal(await f.page.locator("#previewPane").isVisible(), true);
  assert.equal(await f.page.evaluate(() => window.navigationCanvas === document.querySelector(".pdf-page canvas")), true);
  assert.equal((await snapshot(f.page)).text, f.source.part);
  assert.equal((await snapshot(f.page)).selection.from, 7);
});

test("multiple PDFs preserve bytes, prefer the current physical page and switch to a mapped artifact", options, async (t) => {
  const f = await journey(t, server, browser, "lilypond");
  assert.equal(await f.page.locator("#pdfArtifactControl").isVisible(), true);
  await f.page.locator("#pdfArtifact").selectOption(f.build.artifacts[1].id);
  await f.page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 1);
  await openSource(f); await sourceClick(f.page, f.source.column);
  let record = await f.received(1);
  assert.equal(record.query.artifactId, f.build.artifacts[1].id);
  await f.page.locator(".source-navigation-highlight").waitFor();
  await f.page.locator("#pdfArtifact").selectOption(f.build.artifacts[0].id);
  await f.page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 2);
  await f.page.locator("#pgNext").click(); await settle(f.page);
  await sourceClick(f.page, f.source.column); record = await f.received(2);
  assert.equal(record.query.page, 2); assert.equal(record.result.matches[0].page, 2);
  await f.page.locator('.pdf-page[data-page="2"] .source-navigation-highlight').waitFor();
  const other = record.result.matches.find((match) => match.artifactId === f.build.artifacts[1].id);
  assert.ok(other); f.override({ status: "ready", matches: [other] });
  await sourceClick(f.page, f.source.column); await f.received(3);
  await f.page.waitForFunction((id) => document.querySelector("#pdfArtifact").value === id && !!document.querySelector(".source-navigation-highlight"), other.artifactId);
  assert.equal(await f.page.locator(".pdf-page").count(), 1);
});

test("mapping statuses and current off are localized, preserve anchors and issue no disabled queries", options, async (t) => {
  const f = await journey(t, server, browser, "latex", { language: "it", theme: "light" });
  await openSource(f);
  let requests = 0;
  for (const status of ["disabled", "missing", "unsupported", "no-match", "unavailable"]) {
    const before = await snapshot(f.page);
    f.override({ status, matches: [] }); await sourceClick(f.page, 5); await f.received(++requests);
    const message = await f.page.evaluate((status) => IrisI18n.t(`navigation.${status}`), status);
    assert.ok(!message.startsWith("navigation.")); await f.page.getByText(message, { exact: true }).waitFor();
    assert.deepEqual(await snapshot(f.page), before);
  }
  await f.page.locator("#btnSettings").click(); await f.page.locator('.set-nav [data-set="compile"]').click();
  await f.page.getByRole("checkbox", { name: "Abilita mappatura PDF–sorgente" }).uncheck();
  await f.page.evaluate(() => IrisMotion.closeDialog("settingsModal"));
  const count = f.records.length; await sourceClick(f.page, 5); await settle(f.page);
  assert.equal(f.records.length, count);
});

for (const scale of [1, 2]) test(`cropped/rotated PDF hit testing and highlight follow actual PDF.js transforms at DPR ${scale} and zoom`, options, async (t) => {
  const f = await journey(t, server, browser, "latex", { scale });
  const match = { ...await nativeMatch(f), x: 70, y: 130, width: 10, height: 8, column: 5 };
  f.override({ status: "ready", matches: [match] });
  await openSource(f);
  let requests = 0;
  for (const [rotation, point] of [[0, [.275, 64 / 300]], [90, [236 / 300, .275]], [180, [.725, 236 / 300]], [270, [64 / 300, .725]]]) {
    const payload = { build: { id: f.build.buildId, status: "succeeded", format: "pdf", mainPath: "main.tex" },
      artifacts: [{ id: match.artifactId, name: "crop.pdf", mimeType: "application/pdf", base64: croppedPdf(rotation) }] };
    await f.page.evaluate((payload) => IrisApp.showBuildOutput(payload), payload);
    assert.equal(await f.page.locator("#pdfArtifactControl").isVisible(), false);
    await f.page.locator("#zIn").click(); await settle(f.page);
    await sourceClick(f.page, 5); await f.received(++requests);
    await f.page.locator(".source-navigation-highlight").waitFor();
    const pixels = await f.page.locator(".pdf-page").evaluate((node) => {
      const canvas = node.querySelector("canvas"), mark = node.querySelector(".source-navigation-highlight");
      const bounds = node.getBoundingClientRect(), box = mark.getBoundingClientRect();
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0, uncovered = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = 4 * (y * canvas.width + x);
        if (data[i] > 150 && data[i + 1] < 80 && data[i + 2] < 80) {
          red++;
          const px = bounds.left + x * bounds.width / canvas.width, py = bounds.top + y * bounds.height / canvas.height;
          if (px < box.left - 1 || px > box.right + 1 || py < box.top - 1 || py > box.bottom + 1) uncovered++;
        }
      }
      return { red, uncovered, width: canvas.width, cssWidth: bounds.width, markWidth: box.width };
    });
    assert.ok(pixels.red > 30, JSON.stringify(pixels)); assert.equal(pixels.uncovered, 0);
    assert.ok(Math.abs(pixels.width / pixels.cssWidth - scale) < .02);
    assert.ok(pixels.markWidth < pixels.cssWidth / 8);
    await f.page.evaluate(() => IrisEditor.select(0, 0));
    const box = await f.page.locator(".pdf-page").boundingBox(), modifier = await accelerator(f.page);
    await f.page.keyboard.down(modifier);
    await f.page.mouse.click(box.x + point[0] * box.width, box.y + point[1] * box.height);
    await f.page.keyboard.up(modifier);
    const record = await f.received(++requests);
    assert.equal(record.query.direction, "inverse");
    assert.ok(Math.abs(record.query.x - 75) < 1 && Math.abs(record.query.y - 134) < 1, JSON.stringify(record.query));
    await f.page.waitForFunction(() => IrisEditor.selection().from === 5);
    t.diagnostic(JSON.stringify({ scale, rotation, pixels, query: record.query }));
  }
});

for (const backend of ["latex", "lilypond"]) test(`compact Italian light/DPR2 native ${backend} navigation switches panes and keeps role colors`, options, async (t) => {
  const f = await journey(t, server, browser, backend, { viewport: { width: 390, height: 844 }, language: "it", theme: "light", scale: 2 });
  await openSource(f);
  await f.page.evaluate((column) => IrisEditor.select(column, column), f.source.column);
  await sourceClick(f.page, f.source.column);
  const record = await f.received(1); assert.equal(record.result.status, "ready");
  await f.page.locator(".source-navigation-highlight").waitFor();
  assert.equal(await f.page.locator(".body").evaluate((node) => node.classList.contains("workspace-preview")), true);
  assert.equal(await f.page.locator(".source-navigation-highlight").evaluate((node) => {
    document.documentElement.style.setProperty("--document-ink", "rgb(11, 22, 33)");
    return getComputedStyle(node).borderTopColor;
  }), "rgb(11, 22, 33)");
  await f.page.evaluate(() => document.documentElement.style.removeProperty("--document-ink"));
  await pdfClick(f, record.result.matches[0]); await f.received(2);
  await f.page.waitForFunction(() => !document.querySelector(".body").classList.contains("workspace-preview"));
  assert.equal((await snapshot(f.page)).text, f.source.part);
  assert.equal(await f.page.locator(".cm-content").evaluate((node) => node === document.activeElement), true);
});

test("read-only project members can navigate both ways while the mapping checkbox stays locked", options, async (t) => {
  const f = await journey(t, server, browser, "lilypond");
  await server.pool.query("UPDATE project_members SET role='viewer' WHERE project_id=$1", [f.projectId]);
  await f.page.evaluate(async (id) => IrisProjects.openProject(id), f.projectId);
  await f.page.evaluate(async (id) => IrisApp.showBuildOutput(await IrisProjects.loadBuildOutput(id)), f.build.buildId);
  await openSource(f);
  assert.equal(await f.page.locator("#compileSourceMapping").isDisabled(), true);
  await sourceClick(f.page, f.source.column); const record = await f.received(1);
  await f.page.locator(".source-navigation-highlight").waitFor();
  await openSource(f, f.mainId); await pdfClick(f, record.result.matches[0]); await f.received(2);
  await f.page.waitForFunction((id) => IrisApp.serialize().activeId === id && IrisEditor.selection().from === 92, f.partId);
  assert.equal(await f.page.evaluate(() => IrisCollab.role()), "viewer");
  assert.equal((await snapshot(f.page)).text, f.source.part);
});

test("a source switch during slow PDF painting cannot apply an old navigation reading anchor", options, async (t) => {
  const f = await journey(t, server, browser, "lilypond", { pausePaint: true });
  const match = { ...await nativeMatch(f), page: 2 };
  f.override({ status: "ready", matches: [match] });
  await openSource(f);
  await f.page.locator("#btnPreview").click();
  await f.page.setViewportSize({ width: 1200, height: 900 });
  await f.page.evaluate(() => { window.navigationPaintGate = new Promise((resolve) => { window.finishNavigationPaint = resolve; }); });
  await sourceClick(f.page, f.source.column); await f.received(1);
  await f.page.locator('.pdf-page[data-page="2"] .source-navigation-highlight').waitFor({ state: "attached" });
  await openSource(f, f.mainId);
  const before = await snapshot(f.page);
  await f.page.evaluate(() => { window.finishNavigationPaint(); window.navigationPaintGate = null; });
  await settle(f.page);
  assert.deepEqual(await snapshot(f.page), before);
});

async function crossArtifactTarget(t, pausePaint = false) {
  const f = await journey(t, server, browser, "lilypond", { pausePaint });
  const result = await (await f.request(`/api/projects/${f.projectId}/builds/${f.build.buildId}/navigation`, {
    method: "POST", body: { direction: "forward", sourceFileId: f.partId, line: 1, column: f.source.column,
      artifactId: f.build.artifacts[0].id, page: 2 },
  })).json();
  const match = result.matches[0];
  assert.equal(match.page, 2); assert.equal(match.artifactId, f.build.artifacts[0].id);
  f.override({ status: "ready", matches: [match] });
  await f.page.locator("#pdfArtifact").selectOption(f.build.artifacts[1].id);
  await f.page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 1);
  await openSource(f);
  return f;
}

for (const change of ["source file switch", "source edit", "build replacement", "artifact selection", "preview collapse", "newer request"]) {
test(`review I1: cross-artifact manual-zoom painting cannot reveal after ${change}`, options, async (t) => {
  const f = await crossArtifactTarget(t, true);
  await f.page.locator("#zIn").click(); await settle(f.page);
  await f.page.evaluate(() => { window.navigationPaintGate = new Promise((resolve) => { window.finishNavigationPaint = resolve; }); });
  await sourceClick(f.page, f.source.column); await f.received(1);
  await f.page.locator('.pdf-page[data-page="2"] .source-navigation-highlight').waitFor({ state: "attached" });
  if (change === "source file switch") await openSource(f, f.mainId);
  else if (change === "source edit") await f.page.evaluate(() => IrisEditor.applyText("% newer source\n" + IrisEditor.getValue()));
  else if (change === "build replacement") await f.page.evaluate(() => IrisApp.clearBuildOutput());
  else if (change === "artifact selection") {
    await f.page.locator("#pdfArtifact").selectOption(f.build.artifacts[1].id);
    await f.page.waitForFunction(() => document.querySelectorAll(".pdf-page").length === 1);
  } else if (change === "preview collapse") await f.page.locator("#btnPreview").click();
  else {
    f.override({ status: "no-match", matches: [] });
    await sourceClick(f.page, f.source.column); await f.received(2);
    await f.page.getByText("No source match at this position.", { exact: true }).waitFor();
  }
  const before = await snapshot(f.page);
  await f.page.evaluate(() => { window.finishNavigationPaint(); window.navigationPaintGate = null; });
  await settle(f.page);
  const after = await snapshot(f.page);
  t.diagnostic(JSON.stringify({ before, after }));
  assert.deepEqual(after, before, "finishing superseded painting must not change either view");
});
}

test("review I2: collapsed cross-artifact jump reveals physical page 2 once, then retains the reading anchor", options, async (t) => {
  const f = await crossArtifactTarget(t);
  await f.page.locator("#btnPreview").click();
  await sourceClick(f.page, f.source.column); await f.received(1);
  await f.page.locator('.pdf-page[data-page="2"] .source-navigation-highlight').waitFor({ state: "attached" });
  await settle(f.page);
  const geometry = await f.page.locator(".source-navigation-highlight").evaluate((mark) => {
    const box = mark.getBoundingClientRect(), stage = document.querySelector("#pvStage").getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, stageTop: stage.top, stageBottom: stage.bottom, page: document.querySelector("#pgCur").textContent };
  });
  t.diagnostic(JSON.stringify(geometry));
  assert.ok(geometry.top >= geometry.stageTop && geometry.bottom <= geometry.stageBottom, "the explicit target must be visible after the reveal settles");
  assert.equal(geometry.page, "2");
  await f.page.locator("#pgPrev").click(); await settle(f.page);
  const anchor = await snapshot(f.page);
  await f.page.locator("#btnPreview").click(); await f.page.locator("#btnPreview").click(); await settle(f.page);
  assert.deepEqual(await snapshot(f.page), anchor, "ordinary reopening must not replay the consumed target");
  await f.page.locator("#zIn").click(); await settle(f.page);
  assert.equal((await snapshot(f.page)).page, "1", "ordinary zoom must not replay a page-2 target");
});

test("review I3: a build-equal inactive dirty buffer cannot bypass a differing authoritative peer", options, async (t) => {
  const f = await journey(t, server, browser, "latex"), match = await nativeMatch(f);
  await openSource(f);
  await f.page.evaluate((text) => {
    IrisCollab.disconnect(); IrisEditor.applyText(text + "% local\n"); IrisEditor.applyText(text);
  }, f.source.part);
  await openSource(f, f.mainId);
  const peer = await f.context.newPage();
  await peer.goto(server.baseUrl, { waitUntil: "networkidle" });
  await peer.evaluate(async (id) => { await IrisEditor.ready; await IrisProjects.openProject(id); }, f.projectId);
  await openSource({ ...f, page: peer });
  await peer.evaluate(() => IrisEditor.applyText("Different authoritative source.\n"));
  await peer.waitForFunction(() => !IrisCollab.pending());
  const before = await snapshot(f.page);
  await pdfClick(f, match); const record = await f.received(1);
  assert.equal(record.result.status, "ready", "exercise the real unchanged HTTP response");
  await settle(f.page);
  const after = await snapshot(f.page);
  t.diagnostic(JSON.stringify({ before, after }));
  assert.deepEqual(after, before, "room mismatch must reject before opening the dirty cache");
  const retained = await f.page.evaluate((id) => IrisApp.serialize().project.nodes.flatMap((node) => node.children || [node]).find((node) => node.id === id).content, f.partId);
  assert.equal(retained, f.source.part, "the unsaved buffer remains available to save");
  await peer.evaluate(() => IrisCollab.disconnect()); await peer.close();
});
