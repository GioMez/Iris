import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { Language, ParseContext, ensureSyntaxTree, syntaxTree, syntaxTreeAvailable, language } from "@codemirror/language";
import { Parser } from "@lezer/common";
import { analysisPolicy, emptySummary as empty, unknownContext as unknown } from "./iris-language-policy.mjs";
import { createTaskScheduler } from "./iris-language-tasks.mjs";
import { createCooperativeParser } from "./iris-language-parser.mjs";
import { highlightTree } from "@lezer/highlight";
import { cssHighlighter } from "./iris-syntax-style.mjs";

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
      if (analysisPolicy(input.length).mode === "limited") return ParseContext.getSkippingParser().startParse(input, fragments, ranges);
      // Context reductions revisit distant scope openers. CM's line cursor
      // walks backwards/forwards for each chunk seek, becoming quadratic inside
      // a large environment/group. Its public read() is random-access. Use
      // bounded UTF-16 windows, never flattening/caching the whole document.
      const windows = new Map(), width = 4096;
      const boundedInput = { length: input.length, lineChunks: false,
        chunk(pos) {
          const from = Math.floor(pos / width) * width;
          let text = windows.get(from);
          if (text === undefined) {
            text = input.read(from, Math.min(input.length, from + width));
            if (windows.size === 4) windows.delete(windows.keys().next().value);
            windows.set(from, text);
          }
          return text.slice(pos - from);
        },
        read: (from, to) => input.read(from, to),
      };
      return adapter.language.parser.startParse(boundedInput, fragments, ranges);
    }
  }, [], adapter.language.name);
}

/** One owner per document. StateField stores identity in transactions; ViewPlugin
 * observes committed states. Headless callers commit via update(state). Reads
 * may start an idle owner, but never adopt speculative document replacements.
 * The extension includes source highlighting for real published prefixes. Do
 * not also install syntaxExtension's whole-viewport highlighter for this owner.
 *
 * hooks: {schedule(fn,delay):handle,cancel(handle),now():number,parseNow?():number,generation?:number,revision?:number}
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
  const guarded = createGuardedLanguage(adapter);
  const cooperative = createCooperativeParser(guarded.parser, { adapter, schedule, cancel, now: hooks.parseNow,
    notify(doc) {
      const current = mounted?.state || active?.state;
      if (disposed || !current || current.doc !== doc || !sameIdentity(current.field(identity, false), active?.id)) return;
      // Called in an owned task, never from a parser/transaction callback. This
      // cheap public request installs the real prefix/full publication now.
      ensureSyntaxTree(current, current.doc.length, 0);
      const captured = captureSyntax(current);
      if (mounted && syntaxTree(current) !== captured.tree) mounted.dispatch({});
      else update(current);
    },
  });
  const boundedLanguage = new Language(guarded.data, cooperative.parser, [], guarded.name);
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
      cooperative.commit(null, id.generation);
      stop();
      active = { state, id, limited: true, parsedTo: 0 };
      published = snapshot(id, "unavailable", 0, empty, policy.reason);
      onSyntax(published);
      return;
    }
    // A query can finish raw work before this first commit, while CM records
    // only the query's shorter stop. Install the already-complete cached tree
    // without waiting for a notification that preceded ownership.
    if (cooperative.commit(state.doc, id.generation, id.revision) && !syntaxTreeAvailable(state, state.doc.length))
      ensureSyntaxTree(state, state.doc.length, 0);
    const captured = captureSyntax(state), { tree, parsedTo } = captured;
    if (cooperative.failure(state.doc)) {
      if (active?.failed && sameIdentity(id, active.id)) return;
      stop(); active = { state, id, ...captured, failed: true };
      published = snapshot(id, "unavailable", parsedTo, empty, "worker-unavailable");
      onSyntax(published); return;
    }
    if (active && sameIdentity(id, active.id) && tree === active.tree && parsedTo === active.parsedTo) return;
    // The debounce belongs to the document revision. Parse-only progress must
    // not restart it (especially after the EOF progress job has just finished).
    const debounceAt = sameIdentity(id, active?.id) ? active.debounceAt : now() + 250;
    stop();
    const previous = sameIdentity(id, published) ? published : null;
    if (!previous) published = null;
    const job = active = { state, id, debounceAt, ...captured };
    const token = sequence;
    const steps = summarize(job, previous);
    function chunk() {
      timer = null;
      if (disposed || token !== sequence) return;
      // The last visitor step is nonpreemptible. Reserve room for that step,
      // bookkeeping and small observed GC pauses inside the 8ms callback budget.
      const until = now() + 5;
      do {
        const step = steps.next();
        if (step.done) {
            // Consumers (outline/regions/completion) also do real application
            // work. Do not append it to an already-spent summary visitor slice.
            timer = schedule(function publishSyntax() {
              timer = null;
              if (!disposed && token === sequence) { published = step.value; onSyntax(published); }
            }, 0);
          return;
        }
      } while (now() < until);
      timer = schedule(chunk, 0);
    }
    timer = schedule(chunk, Math.max(0, debounceAt - now()));
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
    cooperative.query(state.doc, pos, 5);
    const tree = ensureSyntaxTree(state, pos, 0);
    if (canObserve) update(state);
    return tree && syntaxTreeAvailable(state, pos) ? adapter.contextAt(tree, state.doc, pos, bias) : unknown(pos);
  }

  function dispose() { if (!disposed) { disposed = true; stop(); cooperative.dispose(); ownedTasks?.dispose(); active = published = mounted = null; } }
  const marks = new Map();
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      mounted = view;
      this.decorations = Decoration.none;
      update(view.state); cooperative.viewport(view.state.doc, view.viewport.to); this.paint(view);
    }
    update(transaction) {
      update(transaction.state);
      cooperative.viewport(transaction.state.doc, transaction.view.viewport.to);
      const captured = captureSyntax(transaction.state);
      if (transaction.docChanged || transaction.viewportChanged || captured.tree !== this.tree || captured.parsedTo !== this.parsedTo)
        this.paint(transaction.view, transaction.changes, captured);
    }
    paint(view, changes, captured = captureSyntax(view.state)) {
      this.tree = captured.tree; this.parsedTo = captured.parsedTo;
      if (analysisPolicy(view.state.doc.length).mode === "limited") { this.decorations = Decoration.none; return; }
      const previous = changes ? this.decorations.map(changes) : this.decorations;
      const builder = new RangeSetBuilder();
      for (const { from, to } of view.visibleRanges) {
        const end = Math.min(to, captured.parsedTo);
        if (from < end) highlightTree(captured.tree, cssHighlighter, (start, finish, style) => {
          let mark = marks.get(style);
          if (!mark) marks.set(style, mark = Decoration.mark({ class: style }));
          builder.add(start, finish, mark);
        }, from, end);
        // CM's built-in highlighter retains ALL old classes until the whole
        // viewport is parsed. Update the verified prefix now and retain mapped
        // known decoration only outside that coverage until real work arrives.
        const retainFrom = Math.max(from, captured.parsedTo);
        if (retainFrom < to) previous.between(retainFrom, to, (start, finish, mark) => {
          start = Math.max(start, retainFrom); finish = Math.min(finish, to);
          if (start < finish) builder.add(start, finish, mark);
        });
      }
      this.decorations = builder.finish();
    }
    destroy() {
      mounted = null;
      // CM redraws the view via setState when phrases change, even though this
      // document, parser and extension survive. A synchronous remount retains
      // ownership; an actual removal/destroy disposes before the next task.
      queueMicrotask(() => { if (!mounted) dispose(); });
    }
  }, { decorations: value => value.decorations });
  return Object.freeze({ extension: [boundedLanguage, identity, plugin], read, update, contextAt, dispose, identityEffect });
}
