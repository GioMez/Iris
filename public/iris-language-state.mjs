import { StateEffect, StateField } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { Language, ParseContext, ensureSyntaxTree, syntaxTree, syntaxTreeAvailable, language } from "@codemirror/language";
import { Parser } from "@lezer/common";
import { analysisPolicy, emptySummary as empty, unknownContext as unknown } from "./iris-language-policy.mjs";
import { createTaskScheduler } from "./iris-language-tasks.mjs";

const keys = ["outline", "regions", "symbols", "references", "includes"];
const sameIdentity = (a, b) => a && b && a.revision === b.revision && a.generation === b.generation;

// Public CM coverage queries also account for skipped ranges; tree.length alone
// is not evidence of coverage. No private parse context or synthetic DOM needed.
function coverage(state, tree) {
  let low = 0, high = Math.min(tree.length, state.doc.length);
  if (syntaxTreeAvailable(state, high)) return high;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (syntaxTreeAvailable(state, mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

function captureSyntax(state) {
  // ensureSyntaxTree can publish a newer tree to CM's mutable parse context
  // before an immutable state's syntaxTree changes. When offset zero is already
  // covered, this public zero-budget read does no parsing and returns that exact
  // current tree. Capture its coverage/readiness together, never mix identities.
  const tree = syntaxTreeAvailable(state, 0) ? ensureSyntaxTree(state, 0, 0) : syntaxTree(state);
  const parsedTo = coverage(state, tree);
  return { tree, parsedTo, ready: parsedTo === state.doc.length && syntaxTreeAvailable(state, state.doc.length) };
}

/** Shared installation guard. Also usable for highlighting before HP07 installs
 * a summary owner. A Language has no disposable jobs, so setState may reuse it. */
export function createGuardedLanguage(adapter) {
  return new Language(adapter.language.data, new class extends Parser {
    createParse(input, fragments, ranges) {
      const parser = analysisPolicy(input.length).mode === "limited" ? ParseContext.getSkippingParser() : adapter.language.parser;
      return parser.startParse(input, fragments, ranges);
    }
  }, [], adapter.language.name);
}

/** One owner per document. StateField stores identity in transactions; ViewPlugin
 * observes committed states. Headless callers commit via update(state). Reads
 * may start an idle owner, but never adopt speculative document replacements.
 *
 * hooks: {schedule(fn,delay):handle,cancel(handle),now():number,generation?:number,revision?:number}
 * Default debounce=250ms and work budget=8ms. identityEffect.of({generation})
 * requires a strictly increasing nonnegative safe integer on file replacement.
 * Revision increases on docChanged OR identity replacement, never resets.
 * @param {import('./iris-language-service.mjs').LanguageAdapter} adapter
 * @param {(snapshot:import('./iris-language-service.mjs').Snapshot)=>void} onSyntax
 */
export function createLanguageState(adapter, onSyntax, hooks = {}) {
  const ownedTasks = hooks.schedule ? null : createTaskScheduler();
  const schedule = hooks.schedule || ownedTasks.schedule;
  const cancel = hooks.cancel || ownedTasks.cancel;
  const now = hooks.now || (() => performance.now());
  const generation = hooks.generation ?? 0;
  const revision = hooks.revision ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError("Invalid generation");
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError("Invalid revision");
  // Guard before LR.startParse constructs its input stream. CodeMirror's own
  // skipping parser records unparsed ranges, so syntaxTreeAvailable stays false.
  // This also guards initial creation, growth past the limit and filter:false
  // remote changes; observing a transaction afterwards would be too late.
  const boundedLanguage = createGuardedLanguage(adapter);
  const identityEffect = StateEffect.define();
  const identity = StateField.define({
    create: () => Object.freeze({ revision, generation }),
    update(value, transaction) {
      let nextGeneration = value.generation, replaced = false;
      for (const effect of transaction.effects) if (effect.is(identityEffect)) {
        const next = effect.value?.generation;
        if (!Number.isSafeInteger(next) || next <= nextGeneration) throw new RangeError("Generation must increase on replacement");
        nextGeneration = next; replaced = true;
      }
      return transaction.docChanged || replaced ? Object.freeze({ revision: value.revision + 1, generation: nextGeneration }) : value;
    },
  });
  let disposed = false, timer = null, active = null, published = null, sequence = 0, mounted = null;
  const snapshot = (id, status = "unavailable", parsedTo = 0, data = empty, limitReason = null) => Object.freeze({ ...data, kind: adapter.kind, ...id, status, parsedTo, limitReason });
  const stop = () => { sequence++; if (timer !== null) cancel(timer); timer = null; };

  function* summarize(job, previous) {
    const data = yield* adapter.summarySteps(job.tree, job.state.doc);
    if (job.ready) return snapshot(job.id, "ready", job.parsedTo, data);
    const merged = {};
    for (const key of keys) {
      const list = [];
      for (const item of data[key]) {
        const from = item.from ?? item.offset;
        if (from < job.parsedTo || job.ready) {
          list.push(item.to > job.parsedTo ? Object.freeze({ ...item, to: job.parsedTo, certainty: "recovered", ...(key === "regions" ? { openEnded: true } : {}) }) : item);
        }
        yield;
      }
      // Retain known entries beyond the covered prefix only within this exact
      // document identity. Never publish partial coverage as a complete list.
      if (!job.ready && previous) for (const item of previous[key]) {
        if ((item.from ?? item.offset) >= job.parsedTo) list.push(item);
        yield;
      }
      merged[key] = Object.freeze(list);
    }
    return snapshot(job.id, job.ready ? "ready" : "partial", job.parsedTo, merged);
  }

  function update(state) {
    if (mounted && mounted.state !== state) return;
    const id = state.field(identity, false);
    if (disposed || !id || state.facet(language) !== boundedLanguage) return;
    // Reading a historical state must not cancel current work or republish it.
    if (active && (id.generation < active.id.generation || id.revision < active.id.revision)) return;
    const policy = analysisPolicy(state.doc.length);
    if (policy.mode === "limited") {
      if (sameIdentity(id, active?.id) && active.limited) return;
      stop();
      active = { state, id, limited: true, parsedTo: 0 };
      published = snapshot(id, "unavailable", 0, empty, policy.reason);
      onSyntax(published);
      return;
    }
    const captured = captureSyntax(state), { tree, parsedTo } = captured;
    if (active && sameIdentity(id, active.id) && tree === active.tree && parsedTo === active.parsedTo) return;
    stop();
    const previous = sameIdentity(id, published) ? published : null;
    if (!previous) published = null;
    const job = active = { state, id, ...captured };
    const token = sequence;
    const steps = summarize(job, previous);
    function progress() {
      timer = null;
      if (disposed || token !== sequence) return;
      const current = mounted?.state || job.state;
      // Continue CM's existing mutable parse context. Do not dispatch a failed
      // ensure: that would force partial-tree finalization in a state update.
      const tree = ensureSyntaxTree(current, current.doc.length, 5);
      if (disposed || token !== sequence) return;
      if (tree && syntaxTreeAvailable(current, current.doc.length)) {
        if (mounted && syntaxTree(current) !== tree) mounted.dispatch({});
        else update(current);
      } else timer = schedule(progress, 0);
    }
    function chunk() {
      timer = null;
      if (disposed || token !== sequence) return;
      const until = now() + 8;
      do {
        const step = steps.next();
        if (step.done) {
          if (!disposed && token === sequence) {
            published = step.value; onSyntax(published);
            if (!job.ready && !disposed && token === sequence) timer = schedule(progress, 0);
          }
          return;
        }
      } while (now() < until);
      timer = schedule(chunk, 0);
    }
    timer = schedule(chunk, 250);
  }

  function read(state) {
    const id = state.field(identity, false) || { generation, revision };
    if (disposed || !state.field(identity, false) || state.facet(language) !== boundedLanguage) return snapshot(id);
    if (!active || mounted?.state === state || sameIdentity(id, active.id) && state.doc === active.state.doc) update(state);
    if (sameIdentity(id, published) && state.doc === active?.state.doc) return published;
    return snapshot(id, "partial", sameIdentity(id, active?.id) && state.doc === active.state.doc ? active.parsedTo : 0);
  }

  function contextAt(state, pos, bias = -1) {
    if (!Number.isInteger(pos) || pos < 0 || pos > state.doc.length) throw new RangeError("Cursor outside source");
    if (disposed || !state.field(identity, false) || state.facet(language) !== boundedLanguage) return unknown(pos);
    const canObserve = !active || mounted?.state === state || sameIdentity(state.field(identity), active.id) && state.doc === active.state.doc;
    if (analysisPolicy(state.doc.length).mode === "limited") { if (canObserve) update(state); return unknown(pos); }
    const tree = ensureSyntaxTree(state, pos, 5);
    if (canObserve) update(state);
    return tree && syntaxTreeAvailable(state, pos) ? adapter.contextAt(tree, state.doc, pos, bias) : unknown(pos);
  }

  function dispose() { if (!disposed) { disposed = true; stop(); ownedTasks?.dispose(); active = published = mounted = null; } }
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) { mounted = view; update(view.state); }
    update(transaction) { update(transaction.state); }
    destroy() {
      mounted = null;
      // CM redraws the view via setState when phrases change, even though this
      // document, parser and extension survive. A synchronous remount retains
      // ownership; an actual removal/destroy disposes before the next task.
      queueMicrotask(() => { if (!mounted) dispose(); });
    }
  });
  return Object.freeze({ extension: [boundedLanguage, identity, plugin], read, update, contextAt, dispose, identityEffect });
}
