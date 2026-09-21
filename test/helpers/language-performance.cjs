const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { generateFixture } = require("./language-fixtures.cjs");
const { installMetrics } = require("./language-metrics.cjs");

const p95 = samples => samples.slice().sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
function workload(kind, bytes, singleLine = false) {
  const generated = generateFixture(kind, bytes, { singleLine });
  // Keep HP01's exact source/size. Both probes change semantic class, not just text.
  const token = kind === "tex" ? generated.source.indexOf("a_1") : generated.source.indexOf("c4");
  return { kind, ...generated, token, singleLine };
}
function representative(kind) {
  const head = kind === "tex" ? "\\documentclass{article}\n\\begin{document}\n" : '\\version "2.26.0"\n{\n';
  const tail = kind === "tex" ? "\\end{document}" : "}";
  const body = kind === "tex" ? "Text 😀 $a_1+\\alpha$. " : "c4 d8 e8 f2 | %{ phrase 😀 %} ";
  const line = body + " ".repeat(51 - Buffer.byteLength(body)) + "\n";
  let source = head + line.repeat(19997);
  source += " ".repeat(1048576 - Buffer.byteLength(source + tail)) + tail;
  return { kind, source, token: source.indexOf(kind === "tex" ? "a_1" : "c4"), singleLine: false,
    metrics: { bytes: Buffer.byteLength(source), codeUnits: source.length, lines: source.split("\n").length } };
}
async function save(name, result) {
  const directory = process.env.IRIS_LANGUAGE_RESULTS;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(result, null, 2) + "\n");
}
function machine() {
  return { node: process.version, platform: process.platform, os: os.version(), release: os.release(),
    cpu: os.cpus()[0].model, logicalCPUs: os.cpus().length, ramBytes: os.totalmem() };
}

async function installProbe(page) {
  await page.evaluate(installMetrics);
  await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view");
    const { ChangeSet } = await import("@codemirror/state");
    const { syntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
    const { LRParser } = await import("@lezer/lr");
    let lrStarts = 0;
    const originalStart = LRParser.prototype.createParse;
    LRParser.prototype.createParse = function (...args) { lrStarts++; return originalStart.apply(this, args); };
    const frame = () => new Promise(requestAnimationFrame);
    const view = () => EditorView.findFromDOM(document.querySelector(".cm-editor"));
    const tasks = [];
    const recordTasks = entries => tasks.push(...entries.map(e => ({ start: e.startTime, duration: e.duration,
      attribution: e.attribution.map(a => ({ name: a.name, containerType: a.containerType, containerSrc: a.containerSrc })) })));
    const taskObserver = new PerformanceObserver(list => recordTasks(list.getEntries()));
    taskObserver.observe({ type: "longtask", buffered: true });
    const observedLongTasks = () => { recordTasks(taskObserver.takeRecords()); return tasks.slice(); };
    const publications = hp08Metrics.createPublicationRecorder();
    // Attach before any measured load/edit. Record callback entry time, then
    // certify it against the actual current publication without flattening Text.
    IrisEditor.onSyntax(snapshot => {
      const at = performance.now();
      publications.observe(snapshot, IrisEditor.syntaxSnapshot(), at);
    });
    const roleAt = pos => {
      const dom = view().domAtPos(pos);
      const element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
      return [...element.classList].filter(c => c.startsWith("t-"));
    };
    async function until(check, deadline = 30000) {
      const start = performance.now();
      while (!check()) {
        if (performance.now() - start > deadline) return false;
        await frame();
      }
      // A later animation frame than the observed updated DOM. This includes at
      // least one paint opportunity, not just the synchronous dispatch duration.
      await frame();
      await frame();
      return true;
    }
    let targetRevision, targetGeneration;
    const ready = () => { const s = IrisEditor.syntaxSnapshot(); return s?.revision === targetRevision && s?.generation === targetGeneration
      && (s.status === "unavailable" || s.status === "ready"); };
    window.hp08 = {
      roleAt, tasks, view, syntaxTree, publications, observedLongTasks,
      async load(w) {
        const start = performance.now();
        publications.begin(start);
        const startsBefore = lrStarts;
        IrisEditor.loadCollab(w.source, w.kind, { version: 0, path: `bench.${w.kind}` });
        const target = IrisEditor.syntaxSnapshot();
        targetRevision = target.revision; targetGeneration = target.generation;
        publications.bind(target, view().state.doc.length);
        IrisEditor.select(w.token); IrisEditor.focus();
        const dispatchMs = performance.now() - start;
        const limited = w.source.length > 1048576;
        const ok = await until(() => limited ? view().state.doc.length === w.source.length && roleAt(w.token).length === 0
          : roleAt(w.token).includes(w.kind === "tex" ? "t-math" : "t-pitch"));
        const firstViewportMs = performance.now() - start;
        const syntaxReady = await until(ready);
        const endTime = performance.now(), publication = publications.finish(IrisEditor.syntaxSnapshot(), endTime);
        return { startTime: start, endTime, dispatchMs, firstViewportMs, syntaxReadyMs: endTime - start, ok, syntaxReady,
          publication, readyPublicationMs: publication.readyPublicationMs, unavailablePublicationMs: publication.unavailablePublicationMs,
          status: IrisEditor.syntaxSnapshot()?.status, treeLength: syntaxTree(view().state).length, lrStarts: lrStarts - startsBefore,
          covered: syntaxTreeAvailable(view().state, view().state.doc.length), longTasks: observedLongTasks().filter(t => hp08Metrics.overlaps(t, {startTime:start, endTime})) };
      },
      async edit(w, mode, index) {
        const limited = w.source.length > 1048576;
        const opening = index % 2 === 0;
        const prefix = w.kind === "tex" ? "\\begin{verbatim}\n" : "%{\n";
        let from = w.token, to = from + 1, insert = opening ? (w.kind === "tex" ? "1" : "r") : (w.kind === "tex" ? "a" : "c");
        let pos = from, expected = opening ? (w.kind === "tex" ? "t-number" : "t-rest") : (w.kind === "tex" ? "t-math" : "t-pitch");
        if (mode === "context") {
          from = 0; to = opening ? 0 : prefix.length; insert = opening ? prefix : "";
          pos = w.token + (opening ? prefix.length : 0);
          expected = opening ? (w.kind === "tex" ? "t-literal" : "t-comment") : (w.kind === "tex" ? "t-math" : "t-pitch");
        }
        const start = performance.now();
        publications.begin(start);
        if (mode === "remote") IrisEditor.collabReceive([{ clientID: "hp08-peer", changes: ChangeSet.of({ from, to, insert }, view().state.doc.length).toJSON() }]);
        else IrisEditor.replaceRange(from, to, insert);
        const target = IrisEditor.syntaxSnapshot();
        targetRevision = target.revision; targetGeneration = target.generation;
        publications.bind(target, view().state.doc.length);
        const dispatchMs = performance.now() - start;
        const visible = await until(() => limited ? roleAt(pos).length === 0 : roleAt(pos).includes(expected));
        const visibleMs = performance.now() - start;
        const syntaxReady = await until(ready);
        const actualText = view().state.doc.sliceString(pos, pos + 1);
        const expectedText = mode === "context" ? (w.kind === "tex" ? "a" : "c") : insert;
        if (actualText !== expectedText) throw new Error(`Edit did not reach the mounted source: ${actualText} !== ${expectedText}`);
        const endTime = performance.now(), publication = publications.finish(IrisEditor.syntaxSnapshot(), endTime);
        return { mode, index, warmup: index < 5, startTime: start, endTime, dispatchMs, visibleMs, summaryMs: endTime - start, summaryObservedMs: endTime - start,
          publication, readyPublicationMs: publication.readyPublicationMs, unavailablePublicationMs: publication.unavailablePublicationMs,
          visible, syntaxReady, expected: limited ? "neutral" : expected, actual: roleAt(pos), pos, actualText,
          generation: targetGeneration, revision: targetRevision, status: IrisEditor.syntaxSnapshot()?.status,
          longTasks: observedLongTasks().filter(t => hp08Metrics.overlaps(t, {startTime:start, endTime})) };
      },
    };
  });
}
module.exports = { workload, representative, machine, save, p95, installProbe };
