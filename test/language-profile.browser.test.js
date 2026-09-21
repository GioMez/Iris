// Opt-in diagnostic: CPU sampling perturbs timing; never mix with gate samples.
const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser } = require("./helpers/language-browser.cjs");
const { workload, save, installProbe } = require("./helpers/language-performance.cjs");
const { evaluateFeatureBudgets } = require("./helpers/language-budget.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1" && process.env.IRIS_LANGUAGE_QUALIFY === "1";
for (const [kind, warm] of [["tex", false], ["ly", false], ["tex", true]]) test(`HP08 diagnostic ${warm ? "warm " : ""}CPU profile ${kind}`, { skip: !enabled, timeout: 120000 }, async t => {
  const pageFor = await languageBrowser(t, { beforeNavigate: async page => {
    await page.addInitScript(() => {
      window.hp08Tasks = []; window.hp08RawAdvances = 0; window.hp08Finalizations = []; window.hp08Queries = []; window.hp08InitialPrefixes = []; window.hp08Components = []; window.hp08TaskID = 0; window.hp08ActiveTask = null;
      window.hp08Measure = (name, run) => { const start = performance.now(); try { return run(); }
        finally { hp08Components.push({ name, taskID: hp08ActiveTask, start, ms: performance.now() - start }); } };
    });
    await page.route("**/languages/*/reuse.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      if (!source.includes("tree = parse.advance();")) throw new Error("Diagnostic finalization hook changed");
      await route.fulfill({ response, body: source.replace("tree = parse.advance();",
        "const atStop = parse.parsedPos >= (stoppedAt ?? input.length), began = atStop ? performance.now() : 0; tree = parse.advance(); if (atStop) hp08Finalizations.push({ start: began, ms: performance.now() - began, done: !!tree, length: tree?.length ?? 0, stoppedAt });") });
    });
    await page.route("**/iris-language-parser.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      if (!source.includes("const tree = job.partial.advance();")) throw new Error("Diagnostic raw LR hook changed");
      const create = "function create(input, fragments, ranges, doc, viewport) {", parser = "const parser = new class extends Parser {";
      assert.ok(source.includes(create) && source.includes(parser) && source.includes("notify(job.doc)"));
      await route.fulfill({ response, body: source.replace("const tree = job.partial.advance();", "hp08RawAdvances++; const tree = job.partial.advance();")
        .replace("notify(job.doc)", 'hp08Measure("notify", () => notify(job.doc))')
        .replace(create, "function measuredCreate(input, fragments, ranges, doc, viewport) {")
        .replace(parser, `function create(...args) { const started = performance.now(); try { return measuredCreate(...args); }
          finally { hp08InitialPrefixes.push({ start: started, ms: performance.now() - started, length: args[0].length }); } }
          ${parser}`) });
    });
    await page.route("**/iris-language-state.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      const context = "function contextAt(state, pos, bias = -1) {", dispose = "function dispose() {";
      assert.ok(source.includes(context) && source.includes(dispose));
      const summary = "timer = schedule(chunk, Math.max(0, debounceAt - now()));";
      assert.ok(source.includes(summary));
      const ensure = "ensureSyntaxTree(current, current.doc.length, 0)", capture = "captureSyntax(current)", dispatch = "mounted.dispatch({})";
      assert.ok([ensure, capture, dispatch].every(text => source.includes(text)));
      await route.fulfill({ response, body: source.replace(context, "function measuredContextAt(state, pos, bias = -1) {")
        .replace(ensure, `hp08Measure("notify-ensure", () => ${ensure})`)
        .replace(capture, `hp08Measure("notify-capture", () => ${capture})`)
        .replace(dispatch, `hp08Measure("notify-dispatch", () => ${dispatch})`)
        .replace(dispose, `function contextAt(...args) { const started = performance.now(); try { return measuredContextAt(...args); }
          finally { hp08Queries.push({ start: started, ms: performance.now() - started, pos: args[1], length: args[0].doc.length }); } }
          ${dispose}`)
        .replace(summary, `const originalChunk = chunk; chunk = function chunk() { const start = performance.now(); try { return originalChunk(); }
          finally { hp08Components.push({ name: "summary", taskID: hp08ActiveTask, start, ms: performance.now() - start }); } }; ${summary}`) });
    });
    await page.route("**/iris-language-worker-client.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      const schedule = "      }\n      j.task = tasks.schedule(chunk, 0);";
      assert.ok(source.includes(schedule));
      await route.fulfill({ response, body: source.replace(schedule, `      }
      const originalChunk = chunk; chunk = function chunk() { const start = performance.now(); try { return originalChunk(); }
        finally { hp08Components.push({ name: "decode", taskID: hp08ActiveTask, start, ms: performance.now() - start }); } };
      j.task = tasks.schedule(chunk, 0);`) });
    });
    await page.route("**/iris-language-tasks.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      if (!source.includes("try { task.fn(); }")) throw new Error("Diagnostic scheduler hook changed");
      await route.fulfill({ response, body: source.replace("try { task.fn(); }", 'try { const id = "hp08-task-" + ++hp08TaskID; hp08ActiveTask = id; performance.mark(id + ":start"); const started = performance.now(); try { task.fn(); } finally { const ms = performance.now() - started; performance.mark(id + ":end"); hp08Tasks.push({ id, name: task.fn.name, start: started, ms }); hp08ActiveTask = null; } }') });
    });
  } });
  const page = await pageFor(t, [{ id: "main", type: "file", kind, name: `main.${kind}`, content: "" }]);
  await installProbe(page);
  const w = workload(kind, 1048576), cdp = await page.context().newCDPSession(page);
  await page.evaluate(w => { window.hp08Workload = w; }, w);
  // Include cold load/notification work in attribution too. A late-started
  // trace cannot explain an overrun already recorded during the initial load.
  await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
  await cdp.send("Tracing.start", { categories: "devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.gc", transferMode: "ReturnAsStream" });
  await cdp.send("Profiler.start");
  const load = await page.evaluate(() => hp08.load(hp08Workload));
  const warmups = [];
  if (warm) for (let i = 0; i < 25; i++) warmups.push(await page.evaluate(async i => {
    const before = hp08RawAdvances;
    return { ...await hp08.edit(hp08Workload, "local", i), rawAdvances: hp08RawAdvances - before };
  }, i));
  const repeatedLoad = warm ? await page.evaluate(async () => {
    const before = hp08RawAdvances;
    return { ...await hp08.load(hp08Workload), rawAdvances: hp08RawAdvances - before };
  }) : null;
  const samples = [];
  for (const [mode, i] of [["local", 0], ["local", 1], ["context", 0], ["context", 1]]) samples.push(await page.evaluate(async ({mode, i}) => {
    const { syntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
    const completion = await import("@codemirror/autocomplete");
    const before = hp08RawAdvances, taskStart = hp08Tasks.length;
    const start = performance.now(), work = hp08.edit(hp08Workload, mode, i);
    const pos = hp08Workload.token + (mode === "context" && i % 2 === 0 ? (hp08Workload.kind === "tex" ? "\\begin{verbatim}\n" : "%{\n").length : 0);
    // Exercise the real completion consumer's context query while this edited
    // revision is pending. No clock override or test-only production API.
    IrisEditor.select(pos + 1); completion.startCompletion(hp08.view());
    const publications = [];
    let parserCoverageMs = null;
    while (parserCoverageMs === null || publications.length < 4) {
      const state = hp08.view().state, tree = syntaxTree(state);
      publications.push({ ms: performance.now() - start, treeLength: tree.length,
        headCovered: syntaxTreeAvailable(state, pos + 1), node: tree.resolveInner(pos, 1).name, roles: hp08.roleAt(pos) });
      if (parserCoverageMs === null && syntaxTreeAvailable(hp08.view().state, hp08.view().state.doc.length)) parserCoverageMs = performance.now() - start;
      await new Promise(requestAnimationFrame);
      if (performance.now() - start > 30000) break;
    }
    const result = { ...await work, parserCoverageMs, publications, rawAdvances: hp08RawAdvances - before, taskStart, taskEnd: hp08Tasks.length };
    completion.closeCompletion(hp08.view());
    return result;
  }, {mode, i}));
  const { profile } = await cdp.send("Profiler.stop");
  const traceDone = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  const { stream } = await traceDone; let traceText = "";
  while (true) {
    const piece = await cdp.send("IO.read", { handle: stream });
    traceText += piece.base64Encoded ? Buffer.from(piece.data, "base64").toString() : piece.data;
    if (piece.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  const { tasks, finalizations, queries, initialPrefixes, components } = await page.evaluate(() => ({ tasks: hp08Tasks, finalizations: hp08Finalizations,
    queries: hp08Queries, initialPrefixes: hp08InitialPrefixes, components: hp08Components }));
  const name = `${warm ? "warm-" : ""}${kind}-profile`;
  const featureBudgets = evaluateFeatureBudgets({ tasks, queries, initialPrefixes });
  await save(`${name}-trace`, JSON.parse(traceText));
  await save(name, { load, warmups, repeatedLoad, samples, profile, tasks, finalizations, queries, initialPrefixes, components, featureBudgets });
  const times = new Map();
  profile.samples.forEach((id, i) => times.set(id, (times.get(id) || 0) + profile.timeDeltas[i]));
  const top = profile.nodes.map(n => ({ name: n.callFrame.functionName, url: n.callFrame.url, line: n.callFrame.lineNumber + 1, ms: (times.get(n.id) || 0) / 1000 })).sort((a,b) => b.ms - a.ms).slice(0, 25);
  const taskSummary = Object.fromEntries([...new Set(tasks.map(t => t.name))].map(name => { const values = tasks.filter(t => t.name === name).map(t => t.ms).sort((a,b) => a-b); return [name, { count: values.length, p95: values[Math.ceil(values.length * .95)-1], max: values.at(-1) }]; }));
  const finalizationSummary = { count: finalizations.length, maxMs: Math.max(0, ...finalizations.map(f => f.ms)), completed: finalizations.filter(f => f.done) };
  await save(`${name}-summary`, { load, warmups, repeatedLoad, samples, top, taskSummary, finalizationSummary, featureBudgets });
  t.diagnostic(JSON.stringify({ kind, warm, repeatedLoad, samples, top, taskSummary, finalizationSummary, featureBudgets }));
  await cdp.detach();
  assert.equal(featureBudgets.complete, true, "actual parser/query/application measurements are required");
  assert.deepEqual(featureBudgets.failures, [], "strict 5ms parser/query and 8ms application slice diagnostic (raw overruns retained)");
});
