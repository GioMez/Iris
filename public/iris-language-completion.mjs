import { analyze, runCooperatively, analysisPolicy } from "./iris-language-service.mjs";
import { closeCompletion, currentCompletions, insertCompletionText, pickedCompletion } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { completionCommands as texCommands, completionEnvironments } from "./languages/latex/catalog.mjs";
import { completionCommands as lyCommands, completionContexts } from "./languages/lilypond/catalog.mjs";

export const fileOptions = path => /\.(sty|cls)$/i.test(path || "") ? { texProfile: "internal" } : {};
const fileKind = path => /\.(tex|sty|cls|ltx)$/i.test(path) ? "tex" : /\.(ly|ily)$/i.test(path) ? "ly" : /\.bib$/i.test(path) ? "bib" : null;

// Bibliography remains a separate lexical path. Yield even inside a long value.
function* bibliographySteps(src) {
  const keys = [], re = /%[^\n]*|@([A-Za-z]+)\s*([{(])/g;
  let match;
  while ((match = re.exec(src))) {
    if (!match[1]) { yield; continue; }
    const type = match[1].toLowerCase(), braceEntry = match[2] === "{";
    let keyFrom = re.lastIndex;
    while (keyFrom < src.length && /\s/.test(src[keyFrom])) { if (keyFrom % 256 === 0) yield; keyFrom++; }
    let keyTo = keyFrom;
    while (keyTo < src.length && !/[\s,{}()"]/.test(src[keyTo])) { if (keyTo % 256 === 0) yield; keyTo++; }
    let comma = keyTo;
    while (comma < src.length && /\s/.test(src[comma])) { if (comma % 256 === 0) yield; comma++; }
    if (keyTo > keyFrom && src[comma] === "," && !["comment", "string", "preamble"].includes(type)) keys.push(src.slice(keyFrom, keyTo));
    let braces = braceEntry ? 1 : 0, quoted = false, i = re.lastIndex;
    for (; i < src.length; i++) {
      if (i % 256 === 0) yield;
      const ch = src[i];
      if (ch === "\\") { i++; continue; }
      if (ch === '"' && (quoted || braces === (braceEntry ? 1 : 0))) { quoted = !quoted; continue; }
      if (quoted) continue;
      if (ch === "%") { const end = src.indexOf("\n", i); i = end < 0 ? src.length : end; continue; }
      if (ch === "{") braces++;
      else if (ch === "}") { if (--braces === 0 && braceEntry) { i++; break; } }
      else if (ch === ")" && !braceEntry && !braces) { i++; break; }
    }
    re.lastIndex = i;
    yield;
  }
  return Object.freeze({ citations: Object.freeze(keys) });
}

/** One project lifetime, shared by both completion sources. Retains summaries,
 * never trees. Queued files start in a later task, one analysis at a time. */
export function createProjectCache({ analyzeFile = analyze, schedule = fn => setTimeout(fn, 0), cancel = clearTimeout } = {}) {
  let identity = null, epoch = 0, disposed = false, running = false, timer = null;
  const entries = new Map(), queue = [];
  function discard(entry) { entry.controller.abort(); entry.resolve(null); }
  function clear() {
    epoch++;
    for (const entry of entries.values()) discard(entry);
    entries.clear(); queue.length = 0;
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function start() {
    if (disposed || running || timer !== null || !queue.length) return;
    timer = schedule(async () => {
      timer = null;
      const entry = queue.shift();
      if (!entry || entry.controller.signal.aborted) { start(); return; }
      running = true;
      try {
        const result = entry.kind === "bib" ? { data: await runCooperatively(bibliographySteps(entry.content), { signal: entry.controller.signal }), status: "ready" }
          : await analyzeFile(entry.kind, entry.content, entry.options, { signal: entry.controller.signal });
        if (!disposed && !entry.controller.signal.aborted && entry.epoch === epoch && entries.get(entry.path) === entry) {
          entry.data = result.status === "ready" ? result.data : null;
          entry.resolve(entry.data);
        }
      } catch (error) {
        if (!entry.controller.signal.aborted) entry.resolve(null);
      } finally { running = false; start(); }
    });
  }
  function update(scope = {}) {
    if (disposed) return;
    const next = scope.projectId != null ? `${scope.projectId}:${scope.generation ?? 0}` : scope;
    if (identity !== next) { clear(); identity = next; }
    const paths = new Set(), pending = (scope.nodes || []).map(node => ({ node, parent: "" }));
    // Bound catalog size; the active document is always supplied separately.
    let visited = 0;
    while (pending.length && visited++ < 4096) {
      const { node, parent } = pending.pop();
      if (node.generated) continue;
      const path = node.path || `${parent}${node.name || ""}`;
      if (node.type === "folder") { for (const child of node.children || []) pending.push({ node: child, parent: path + "/" }); continue; }
      const kind = fileKind(path);
      if (!kind || path === scope.activePath || node.sourceError) continue;
      const content = String(node.content || ""), options = kind === "tex" ? fileOptions(path) : {};
      if (analysisPolicy(content.length).mode === "limited") continue;
      paths.add(path);
      const old = entries.get(path);
      if (old && old.content === content && old.kind === kind && old.fileId === node.id && old.revision === node.revision) continue;
      if (old) discard(old);
      let resolve;
      const entry = { path, kind, content, options, fileId: node.id, revision: node.revision, epoch,
        controller: new AbortController(), data: null, promise: new Promise(r => { resolve = r; }), resolve };
      entries.set(path, entry); queue.push(entry);
    }
    for (const [path, entry] of entries) if (!paths.has(path)) { discard(entry); entries.delete(path); }
    // Discarded pending entries should not retain old project source strings.
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].controller.signal.aborted) queue.splice(i, 1);
    if (!queue.length && timer !== null) { cancel(timer); timer = null; }
    start();
  }
  async function read(scope, signal, wait = Infinity) {
    update(scope);
    const started = epoch, captured = [...entries.values()];
    const work = Promise.all(captured.map(async entry => ({ path: entry.path, kind: entry.kind, data: await entry.promise })));
    let abort, timer;
    const cancelled = new Promise(resolve => { abort = () => resolve(null); signal?.addEventListener("abort", abort, { once: true }); });
    const available = new Promise(resolve => {
      if (Number.isFinite(wait)) timer = setTimeout(() => resolve(captured.map(entry => ({ path: entry.path, kind: entry.kind, data: entry.data }))), Math.max(0, wait));
    });
    try {
      const result = signal?.aborted ? null : await Promise.race([work, cancelled, available]);
      return disposed || started !== epoch || captured.some(e => entries.get(e.path) !== e) ? null : result;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  return Object.freeze({ update, read,
    isCurrent: snapshot => !disposed && snapshot.length === entries.size && snapshot.every(item => entries.get(item.path)?.data === item.data),
    dispose() { disposed = true; clear(); } });
}

const roles = { environment: "environments", reference: "labels", "reference-list": "labels", "citation-list": "citations", context: "contexts" };
const commandPrefix = /\\[\p{L}\p{N}@_:.-]*\*?$/u;
const opaque = new Set(["comment", "literal", "string", "unknown", "scheme"]);

export function canPairBrace(kind, state, pos, context) {
  if (!["tex", "ly"].includes(kind) || !context || context.certainty === "unknown" || context.argumentRole === "string" || opaque.has(context.mode)) return false;
  // Bounded parity: an unresolved very long escape run declines automatic edits.
  const prefix = state.sliceDoc(Math.max(0, pos - 256), pos), slashes = prefix.match(/\\+$/)?.[0].length || 0;
  return slashes < 256 && slashes % 2 === 0 && !(kind === "ly" && prefix.endsWith("#"));
}

export function createSource(kind, getProject, service) {
  return async context => {
    const { state, pos } = context;
    if (state.readOnly) return null;
    const syntax = service.contextAt(state, pos);
    if (!syntax || syntax.certainty === "unknown" || syntax.argumentRole === "string" || opaque.has(syntax.mode)) return null;
    const start = Math.max(0, pos - 1024), prefix = state.sliceDoc(start, pos);
    const category = roles[syntax.argumentRole] || "commands", used = new Set();
    let from, to = pos;
    if (category !== "commands") {
      const list = syntax.argumentRole === "reference-list" || syntax.argumentRole === "citation-list";
      const a = syntax.argumentFrom, b = syntax.argumentTo;
      if (!Number.isInteger(a) || !Number.isInteger(b) || b < a || b - a > 2048 || pos > b) return null;
      if (pos < a && (a - pos > 1024 || !/^\s*$/.test(state.sliceDoc(pos, a)))) return null;
      const text = state.sliceDoc(a, b), caret = Math.max(0, pos - a);
      const left = list && caret > 0 ? text.lastIndexOf(",", caret - 1) + 1 : 0;
      const comma = list ? text.indexOf(",", caret) : -1, right = comma < 0 ? text.length : comma;
      const item = text.slice(left, right);
      if (item.length > 1024) return null;
      from = Math.min(pos, a + left + item.length - item.trimStart().length);
      to = Math.max(pos, a + left + item.trimEnd().length);
      if (list) {
        for (const name of [...text.slice(0, left).split(","), ...text.slice(right).split(",")]) used.add(name.trim());
      }
    } else {
      const command = prefix.match(commandPrefix);
      if (Number.isInteger(syntax.commandFrom) && (!Number.isInteger(syntax.commandTo) || syntax.commandTo - syntax.commandFrom > 1024)) return null;
      if (Number.isInteger(syntax.commandFrom) && syntax.commandTo - syntax.commandFrom <= 1024 && (pos > syntax.commandFrom || context.explicit)
          && /^\\[\p{L}\p{N}@_:.-]*\*?$/u.test(state.sliceDoc(syntax.commandFrom, syntax.commandTo))) {
        from = syntax.commandFrom; to = syntax.commandTo;
      } else if (command) {
        from = pos - command[0].length;
      } else if (context.explicit && /^[\t ]*$/.test(state.sliceDoc(state.doc.lineAt(pos).from, pos))) from = pos;
      else return null;
      const before = state.sliceDoc(Math.max(0, from - 256), from).match(/\\+$/)?.[0].length || 0;
      if (before >= 256 || before % 2) return null;
    }
    const controller = new AbortController();
    context.addEventListener("abort", () => controller.abort(), { onDocChange: true });
    const scope = getProject() || {};
    const [active, project] = await Promise.all([service.snapshot(state, controller.signal), service.cache.read(scope, controller.signal, 250)]);
    if (controller.signal.aborted || context.aborted || !service.isCurrent(state) || !project) return null;
    const options = new Map(), type = category === "commands" ? "function" : ["environments", "contexts"].includes(category) ? "class" : "constant";
    const apply = (view, completion, matchFrom, matchTo) => {
      // CM filters [from,pos), but acceptance replaces the certified full token.
      // Decline captured callbacks after edits/profile/project/selection changes.
      if (view.state.readOnly || view.composing || view.compositionStarted || controller.signal.aborted || context.aborted
          || view.state.doc !== state.doc || !service.isCurrent(state) || !view.state.selection.eq(state.selection)
          || getProject() !== scope || matchFrom !== from || matchTo !== pos) {
        // CM treats a custom apply callback as handled even when it declines.
        // Retire this option's popup, without closing a newer query's result.
        if (currentCompletions(view.state).includes(completion)) closeCompletion(view);
        return;
      }
      view.dispatch({ ...insertCompletionText(view.state, completion.label, from, to),
        annotations: [pickedCompletion.of(completion), isolateHistory.of("full")] });
    };
    const add = (label, detail, optionType = type) => { if (label && !used.has(label)) options.set(label, { label, type: optionType, apply, ...(detail ? { detail } : {}) }); };
    if (category === "commands") for (const name of kind === "tex" ? texCommands : lyCommands) add("\\" + name);
    if (category === "environments") for (const name of completionEnvironments) add(name);
    if (category === "contexts") for (const name of completionContexts) add(name);
    function* addData(data, path, fileKind, current = false) {
      if (!data) return;
      if (fileKind === "bib" && category === "citations") { for (const key of data.citations || []) { add(key, path); yield; } return; }
      if (fileKind !== kind) return;
      const literals = [], scopes = [];
      if (fileKind === "ly") for (const region of data.regions) { if (region.name === "MusicLiteral") literals.push(region); yield; }
      let literal = 0;
      for (const symbol of data.symbols) {
        yield;
        if (symbol.certainty !== "exact" || current && symbol.to > data.parsedTo) continue;
        while (literal < literals.length && literals[literal].from <= symbol.from) {
          const region = literals[literal++];
          while (scopes.length && scopes.at(-1).to <= region.from) { scopes.pop(); yield; }
          scopes.push(region); yield;
        }
        while (scopes.length && scopes.at(-1).to <= symbol.from) { scopes.pop(); yield; }
        let hidden = false;
        for (const region of scopes) {
          if (!current || pos < region.from || pos > region.to || pos === region.to && !(region.openEnded && pos === state.doc.length)) hidden = true;
          yield;
        }
        if (hidden) continue;
        if (category === "commands" && symbol.kind === "command") add("\\" + symbol.name, path, fileKind === "ly" ? "variable" : type);
        if (category === "environments" && symbol.kind === "environment" || category === "labels" && symbol.kind === "label") add(symbol.name, path);
      }
    }
    function* collect() {
      for (const entry of project) yield* addData(entry.data, entry.path, entry.kind);
      if (active && active.status !== "unavailable") yield* addData(active, scope.activePath || "", kind, true);
      if (category === "commands") for (const name of scope.customCommands?.[kind] || []) { add(name, scope.customLabel); yield; }
    }
    try { await runCooperatively(collect(), { signal: controller.signal }); }
    catch (error) { if (controller.signal.aborted) return null; throw error; }
    if (!service.isCurrent(state) || context.aborted || getProject() !== scope || !service.cache.isCurrent(project)) return null;
    // No validFor: even a single character can change argument/mode ownership.
    return { from, to: pos, options: [...options.values()],
      // Captured source/target certificates cannot survive a document mapping,
      // including edits outside CM's narrower matching range.
      map: (result, changes) => changes.empty ? result : null };
  };
}
