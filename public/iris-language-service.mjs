/** @typedef {'tex'|'ly'} Kind
 * @typedef {'exact'|'recovered'|'unknown'} Certainty
 * @typedef {{from:number,to:number}} Span
 * @typedef {{length:number,sliceString(from:number,to:number):string}} Source
 * @typedef {{initialNoteLanguage?:string,texProfile?:'standard'|'internal'|'expl3'}} ParseOptions
 * @typedef {{level:number,num:string,title:string,offset:number,to:number,certainty:Certainty,titleKey?:string,titleParams?:Object<string,string|number>}} OutlineItem
 * @typedef {{kind:string,name:string,label:string,from:number,to:number,certainty:Certainty,openEnded:boolean,labelKey?:string,labelParams?:Object<string,string|number>}} Region
 * @typedef {{kind:'command'|'environment'|'variable'|'label',name:string,from:number,to:number,certainty:Certainty}} SymbolRecord
 * @typedef {{kind:'command'|'variable'|'label'|'citation',name:string,from:number,to:number,certainty:Certainty}} ReferenceRecord
 * @typedef {{path:string,from:number,to:number,certainty:Certainty}} IncludeRecord
 * @typedef {{outline:OutlineItem[],regions:Region[],symbols:SymbolRecord[],references:ReferenceRecord[],includes:IncludeRecord[]}} SummaryData
 * @typedef {SummaryData & {kind:Kind,revision:number,generation:number,status:'ready'|'partial'|'unavailable',parsedTo:number,limitReason:'source-too-large'|null}} Snapshot
 * @typedef {Snapshot} SyntaxSnapshot
 * @typedef {{mode:'text'|'math'|'literal'|'comment'|'music'|'lyrics'|'markup'|'chords'|'drums'|'figures'|'scheme'|'string'|'unknown',argumentRole:string|null,from:number,to:number,certainty:Certainty,argumentFrom?:number,argumentTo?:number|null,commandFrom?:number,commandTo?:number|null}} CursorContext Optional completion spans exclude argument delimiters; a null end marks a partial-tree cutoff.
 * @typedef {{from:number,to:number,insert:string}} TextChange
 * @typedef {{close:string,closingFrom:number|null,needsClose:boolean}|null} BlockPlan Tree-based Enter plan; the editor owns its transaction.
 * @typedef {{kind:Kind,options:ParseOptions,language:import('@codemirror/language').Language,summarize(tree:import('@lezer/common').Tree,doc:Source):SummaryData,summarySteps(tree:import('@lezer/common').Tree,doc:Source):Generator<void,SummaryData>,contextAt(tree:import('@lezer/common').Tree,doc:Source,pos:number,bias?:number):CursorContext,blockAtEnter(tree:import('@lezer/common').Tree,doc:Source,pos:number):BlockPlan,formatChanges(tree:import('@lezer/common').Tree,doc:Source,range:Span|null):TextChange[]}} LanguageAdapter
 */

import { Tree } from "@lezer/common";
import { analysisPolicy, emptySummary } from "./iris-language-policy.mjs";
import { createTaskScheduler } from "./iris-language-tasks.mjs";
export { analysisPolicy, MAX_ANALYSIS_LENGTH } from "./iris-language-policy.mjs";

const cache = new Map();
function normalizeOptions(kind, options) {
  if (kind !== "tex" && kind !== "ly") throw new RangeError(`Unknown language kind: ${kind}`);
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Parse options must be an object");
  if (![null, Object.prototype].includes(Object.getPrototypeOf(options))) throw new TypeError("Parse options must be a plain serializable object");
  for (const key of Reflect.ownKeys(options)) if (!["initialNoteLanguage", "texProfile"].includes(key)) throw new RangeError(`Unknown parse option: ${String(key)}`);
  if (kind === "tex") {
    if (options.initialNoteLanguage !== undefined) throw new RangeError("initialNoteLanguage applies only to ly");
    const texProfile = options.texProfile === undefined ? "standard" : options.texProfile;
    if (!["standard", "internal", "expl3"].includes(texProfile)) throw new RangeError("Invalid texProfile");
    return Object.freeze({ texProfile });
  }
  if (options.texProfile !== undefined) throw new RangeError("texProfile applies only to tex");
  if (options.initialNoteLanguage !== undefined && typeof options.initialNoteLanguage !== "string") throw new TypeError("initialNoteLanguage must be a string");
  const name = options.initialNoteLanguage === undefined ? "nederlands" : options.initialNoteLanguage;
  // A finite cache: arbitrary unsupported spellings all mean unknown, never
  // allocate one parser/cache entry per untrusted source-language string.
  return Object.freeze({ initialNoteLanguage: ["nederlands", "italiano", "english", "deutsch"].includes(name) ? name : "unknown" });
}

/** @returns {Promise<LanguageAdapter>} */
export async function loadLanguage(kind, options = {}) {
  const normalized = normalizeOptions(kind, options), key = `${kind}:${JSON.stringify(normalized)}`;
  if (!cache.has(key)) {
    const pending = (kind === "tex" ? import("./languages/latex/index.mjs") : import("./languages/lilypond/index.mjs")).then(module => module.createAdapter(normalized));
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

function checkAbort(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError"); }
function yieldTask(tasks, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const abort = () => { tasks.cancel(id); signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const id = tasks.schedule(() => { signal?.removeEventListener("abort", abort); resolve(); }, 0);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Run the same summary visitor used by state, with abort checks between steps. */
export async function runCooperatively(steps, { signal } = {}) {
  const tasks = createTaskScheduler();
  try {
    for (;;) {
      checkAbort(signal);
      const end = performance.now() + 8;
      do {
        checkAbort(signal);
        const step = steps.next();
        if (step.done) return step.value;
      } while (performance.now() < end);
      await yieldTask(tasks, signal);
    }
  } finally { tasks.dispose(); steps.return?.(); }
}

/** Cooperative startParse/advance + tree visitor; never calls Parser.parse().
 * String inputs are wrapped without copying or line-ending normalization.
 * Above the shared size limit: Tree.empty + empty data, status unavailable,
 * parsedTo 0 and limitReason source-too-large. This is NOT an empty parsed file.
 * @returns {Promise<{tree:import('@lezer/common').Tree,doc:Source,data:SummaryData,status:'ready'|'unavailable',parsedTo:number,limitReason:'source-too-large'|null}>}
 */
export async function analyze(kind, text, options = {}, { signal } = {}) {
  checkAbort(signal);
  const doc = typeof text === "string" ? Object.freeze({ length: text.length, sliceString: (from, to) => text.slice(from, to) }) : text;
  if (!doc || !Number.isSafeInteger(doc.length) || doc.length < 0 || typeof doc.sliceString !== "function") throw new TypeError("Expected a string or Source");
  normalizeOptions(kind, options);
  const policy = analysisPolicy(doc.length);
  if (policy.mode === "limited") return Object.freeze({ tree: Tree.empty, doc, data: emptySummary, status: "unavailable", parsedTo: 0, limitReason: policy.reason });
  const adapter = await loadLanguage(kind, options);
  checkAbort(signal);
  const input = { length: doc.length, lineChunks: false, chunk: pos => doc.sliceString(pos, Math.min(doc.length, pos + 4096)), read: (from, to) => doc.sliceString(from, to) };
  function* work() {
    const partial = adapter.language.parser.startParse(input);
    let tree;
    while (!(tree = partial.advance())) yield;
    yield;
    const data = yield* adapter.summarySteps(tree, doc);
    return Object.freeze({ tree, doc, data, status: "ready", parsedTo: doc.length, limitReason: null });
  }
  return runCooperatively(work(), { signal });
}
