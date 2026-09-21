const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser, readySyntax } = require("./helpers/language-browser.cjs");
const { generateFixture } = require("./helpers/language-fixtures.cjs");
const { save } = require("./helpers/language-performance.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";

function heldWorkerSource(source, released) {
  // The real local bundle loads and runs normally. Only its full parse requests
  // wait for the test to release them; transport/cancellation still run.
  return source + `
    self.prefixProbeReleased ||= ${released};
    const prefixRunMessage = self.onmessage, prefixHeld = new Map();
    self.onmessage = event => {
      if (event.data.type === "cancel") prefixHeld.delete(event.data.request);
      if (!self.prefixProbeReleased && event.data.type === "parse") prefixHeld.set(event.data.request, event);
      else prefixRunMessage(event);
    };
    self.releasePrefixProbe = () => {
      self.prefixProbeReleased = true;
      for (const event of prefixHeld.values()) prefixRunMessage(event);
      prefixHeld.clear();
    };
    self.prefixProbePending = () => prefixHeld.size;
  `;
}

for (const charge of [10, 1]) test(`cold local-font prefix paints real pitch with full Worker held (initial charge ${charge})`, { skip: !enabled, timeout: 60000 }, async t => {
  let released = false, page; const fontResponses = [];
  const release = async () => {
    released = true;
    for (const worker of page?.workers() || []) if (worker.url().includes("/language-worker/"))
      await worker.evaluate(() => { self.prefixProbeReleased = true; self.releasePrefixProbe?.(); }).catch(() => {});
  };
  t.after(release);
  const pageFor = await languageBrowser(t, { beforeNavigate: async page => {
    page.on("response", response => { if (/\/fonts\/.*\.woff2?$/.test(new URL(response.url()).pathname)) fontResponses.push({ url: response.url(), status: response.status() }); });
    await page.addInitScript(() => { window.prefixProbe = { initial: false, clock: 0, charge: 0, completed: [], notifications: [] }; });
    await page.route("**/iris-language-state.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      const clock = "now: hooks.parseNow,", owner = "return Object.freeze({ extension: [boundedLanguage, identity, plugin], read, update, contextAt, dispose, identityEffect });";
      assert.ok(source.includes(clock) && source.includes(owner));
      // Only the initial owner slice uses the supplied controlled parse clock.
      // Async turns, DOM, fonts and the performance harness clock remain real.
      await route.fulfill({ response, body: source.replace(clock,
        "now: () => prefixProbe.initial ? prefixProbe.clock += prefixProbe.charge : performance.now(),")
        .replace("notify(doc) {", "notify(doc) { prefixProbe.notifications.push({ at: performance.now(), length: doc.length });")
        .replace(owner, owner.replace("return Object.freeze", "return window.prefixOwner = Object.freeze")) });
    });
    await page.route("**/vendor/language-worker/worker.mjs", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: heldWorkerSource(await response.text(), released) });
    });
  } });
  page = await pageFor(t, [{ id: "main", type: "file", kind: "ly", name: "main.ly", content: "" }]);
  const source = generateFixture("ly", 1048576).source;
  await page.evaluate(async ({ source, charge }) => {
    const { LRParser } = await import("@lezer/lr");
    const { EditorView } = await import("@codemirror/view");
    const { syntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
    const start = LRParser.prototype.createParse;
    LRParser.prototype.createParse = function (input, ...args) {
      const parse = start.call(this, input, ...args), advance = parse.advance;
      parse.advance = function () {
        const tree = advance.call(this);
        if (tree && input.length >= 32768) prefixProbe.completed.push({ at: performance.now(), length: tree.length, stoppedAt: this.stoppedAt, sourceLength: input.length });
        return tree;
      };
      return parse;
    };
    prefixProbe.source = source; prefixProbe.charge = charge;
    prefixProbe.view = () => EditorView.findFromDOM(document.querySelector(".cm-editor"));
    prefixProbe.sample = pos => {
      const view = prefixProbe.view(), tree = syntaxTree(view.state), dom = view.domAtPos(pos);
      const element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
      return { node: tree.resolveInner(pos, 1).name, roles: [...element.classList].filter(c => c.startsWith("t-")),
        covered: syntaxTreeAvailable(view.state, pos + 1), full: syntaxTreeAvailable(view.state), length: tree.length,
        viewport: view.viewport.to, viewportCovered: syntaxTreeAvailable(view.state, Math.min(3000, view.viewport.to)),
        font: getComputedStyle(view.contentDOM).fontFamily, text: view.state.doc.sliceString(pos, pos + 1) };
    };
  }, { source, charge });
  const results = [];
  try {
    for (const phase of ["cold", "reload-query-measure", "edit-before-viewport-growth"]) {
      const result = await page.evaluate(async phase => {
        const source = prefixProbe.source, pos = source.indexOf("c4");
        prefixProbe.initial = true; prefixProbe.clock = 0;
        if (phase.startsWith("edit")) IrisEditor.replaceRange(pos, pos + 1, "r");
        else IrisEditor.loadCollab(source, "ly", { version: 0, path: "main.ly" });
        prefixProbe.initial = false;
        const initial = prefixProbe.sample(pos);
        if (phase !== "cold") {
          IrisEditor.select(pos); prefixOwner.contextAt(prefixProbe.view().state, pos + 1);
          await document.fonts.ready; IrisEditor.requestMeasure();
        }
        const start = performance.now(), frames = [];
        while (performance.now() - start < 750 && !prefixProbe.sample(pos).viewportCovered) {
          frames.push({ at: performance.now(), ...prefixProbe.sample(pos) }); await new Promise(requestAnimationFrame);
        }
        return { phase, start, initial, after: prefixProbe.sample(pos), elapsed: performance.now() - start, completed: prefixProbe.completed.slice(), frames, notifications: prefixProbe.notifications.slice(),
          faces: [...document.fonts].filter(f => f.family.includes("IBM Plex Mono")).map(f => ({ family: f.family, status: f.status })) };
      }, phase);
      results.push(result);
      await save(`cold-prefix-${charge}`, { results, fontResponses });
      assert.equal(result.initial.covered, false, JSON.stringify(result.initial));
      assert.equal(result.after.node, phase.startsWith("edit") ? "Rest" : "Pitch", JSON.stringify(result));
      assert.ok(result.after.roles.includes(phase.startsWith("edit") ? "t-rest" : "t-pitch"), JSON.stringify(result));
      assert.equal(result.after.covered, true); assert.equal(result.after.viewportCovered, true);
      assert.equal(result.after.full, false); assert.ok(result.after.length < source.length);
      assert.ok(result.completed.every(p => p.stoppedAt !== null && p.length < p.sourceLength), "no full main-thread LR construction");
      assert.match(result.after.font, /IBM Plex Mono/);
      assert.ok(result.faces.some(f => f.status === "loaded"), "actual local editor face loaded");
    }
    const before = results.at(-1).after;
    // A 300px resize stays inside CM's existing overscan. Grow past it so the
    // public viewport actually requests another prefix while Worker is pending.
    await page.setViewportSize({ width: 1440, height: 1800 });
    const grown = await page.evaluate(async previousViewport => {
      IrisEditor.requestMeasure();
      const pos = prefixProbe.source.indexOf("c4"), start = performance.now();
      do { await new Promise(requestAnimationFrame); }
      while (performance.now() - start < 750 && (prefixProbe.sample(pos).viewport <= previousViewport || !prefixProbe.sample(pos).viewportCovered));
      return prefixProbe.sample(pos);
    }, before.viewport);
    await save(`cold-prefix-${charge}`, { results, beforeGrowth: before, grown, fontResponses });
    assert.ok(grown.viewport > before.viewport, `the real local-font viewport grew: ${JSON.stringify({ before, grown })}`);
    assert.equal(grown.viewportCovered, true, JSON.stringify({ before, grown }));
    assert.equal(grown.full, false); assert.ok(grown.roles.includes("t-rest"));
  } finally { await release(); }
  assert.equal((await readySyntax(page)).status, "ready");
  assert.ok(fontResponses.length && fontResponses.every(r => r.status === 200 && new URL(r.url).origin === new URL(page.url()).origin));
  t.diagnostic(JSON.stringify(results.map(({ faces, ...result }) => result)));
});

test("bounded prefix turns and full Worker retire on document replacement and disposal", { skip: !enabled, timeout: 60000 }, async t => {
  const pageFor = await languageBrowser(t, { beforeNavigate: async page => {
    await page.route("**/vendor/language-worker/worker.mjs", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: heldWorkerSource(await response.text(), false) });
    });
  } });
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "ly", name: "main.ly", content: "" }]);
  const first = await page.evaluate(async () => {
    const { EditorState } = await import("@codemirror/state");
    const { Language, ensureSyntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
    const { loadLanguage } = await import("./iris-language-service.mjs");
    const { createGuardedLanguage } = await import("./iris-language-state.mjs");
    const { createCooperativeParser } = await import("./iris-language-parser.mjs");
    const adapter = await loadLanguage("ly"), guarded = createGuardedLanguage(adapter), queue = new Map(), captured = [], calls = new Map(), completed = [];
    const startParse = guarded.parser.startParse;
    guarded.parser.startParse = function (input, ...args) {
      const partial = startParse.call(this, input, ...args), advance = partial.advance;
      partial.advance = function () {
        calls.set(input.length, (calls.get(input.length) || 0) + 1);
        const tree = advance.call(this);
        if (tree) completed.push({ length: tree.length, stoppedAt: this.stoppedAt, sourceLength: input.length });
        return tree;
      };
      return partial;
    };
    let next = 0, ticks = 0, state, notifications = 0, maximum = 0;
    const total = () => [...calls.values()].reduce((a, b) => a + b, 0);
    const cooperative = createCooperativeParser(guarded.parser, { adapter, requestFrame: null,
      now: () => ++ticks, schedule(fn) { const id = ++next; queue.set(id, fn); captured.push(fn); return id; }, cancel: id => queue.delete(id),
      notify(doc) { if (doc === state.doc) { notifications++; ensureSyntaxTree(state, state.doc.length, 0); } },
    });
    const extension = new Language(guarded.data, cooperative.parser);
    const run = () => { const [id, fn] = queue.entries().next().value; queue.delete(id); const before = total(); fn(); maximum = Math.max(maximum, total() - before); };
    const source = "{ c4 d8 r2 }\n".repeat(8000);
    state = EditorState.create({ doc: source, extensions: extension }); cooperative.commit(state.doc, 0, 0);
    run();
    const oldCalls = calls.get(source.length), oldCallbacks = captured.slice();
    state = state.update({ changes: { from: 0, insert: "% replacement\n" } }).state; cooperative.commit(state.doc, 1, 1);
    for (const fn of oldCallbacks) fn();
    const retired = calls.get(source.length) === oldCalls;
    let turns = 0;
    while (queue.size && turns++ < 10000) run();
    cooperative.viewport(state.doc, state.doc.length); // must not request a full main parse
    while (queue.size && turns++ < 10000) run();
    window.prefixLife = { dispose() {
      state = state.update({ changes: { from: 0, insert: "% pending\n" } }).state; cooperative.commit(state.doc, 2, 2);
      const beforeQuery = total(); cooperative.query(state.doc, 100, 5); const queryAdvances = total() - beforeQuery;
      cooperative.dispose();
      const before = total(), published = notifications;
      for (const fn of captured) fn();
      return { queryAdvances, retiredAdvances: total() - before, staleNotifications: notifications - published, pending: queue.size, completed };
    } };
    return { retired, turns, maximum, prefix: syntaxTreeAvailable(state, 100), full: syntaxTreeAvailable(state) };
  });
  assert.equal(first.retired, true); assert.ok(first.turns > 2 && first.turns < 10000);
  assert.ok(first.maximum <= 5, JSON.stringify(first)); assert.equal(first.prefix, true); assert.equal(first.full, false);
  if (!page.workers().length) await page.waitForEvent("worker");
  const worker = page.workers().find(w => w.url().includes("/language-worker/"));
  assert.ok(worker, "the full job uses the actual local Worker");
  let pending = 0;
  for (let tries = 0; !pending && tries < 100; tries++) {
    pending = await worker.evaluate(() => self.prefixProbePending?.() || 0);
    if (!pending) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(pending, 1);
  const closed = new Promise(resolve => worker.once("close", resolve));
  const result = await page.evaluate(() => prefixLife.dispose());
  await closed;
  assert.ok(result.queryAdvances <= 5, JSON.stringify(result));
  assert.equal(result.retiredAdvances, 0); assert.equal(result.staleNotifications, 0); assert.equal(result.pending, 0);
  assert.ok(result.completed.every(p => p.stoppedAt !== null && p.stoppedAt <= 3000 && p.length < p.sourceLength));
  await save("cold-prefix-lifecycle", { first, result });
  t.diagnostic(JSON.stringify({ first, result }));
});
