import { ParseContext } from "@codemirror/language";
import { Parser, Tree, TreeFragment } from "@lezer/common";
import { analysisPolicy } from "./iris-language-policy.mjs";
import { createWorkerClient, canUseLanguageWorker, WORKER_MIN_LENGTH } from "./iris-language-worker-client.mjs";

// Match CM's initial viewport opportunity and the existing bounded query path.
// A scrolled/long-line viewport must never turn the UI prefix into a full parse.
const MAIN_PREFIX_LIMIT = 3000;
// LR.advance is nonpreemptible. Leave room for its last bounded step, stopped
// tree finalization and caller bookkeeping inside the actual 5ms ceiling.
const PARSE_WORK_MS = 3;
// Cold publication also pays for CM decoration comparison and DOM updates.
// Expose dense viewport syntax incrementally rather than one large repaint.
const PREFIX_PUBLICATION_STEP = 512;

/** Per-owner LR continuation. CM consumes real published trees and public
 * skipping ranges; it never drains the background LR parse in its idle worker.
 * Uncommitted/speculative documents get bounded initial work but own no tasks.
 * The supplied raw parser retains the shared size guard and bounded Input.
 */
export function createCooperativeParser(raw, { adapter, schedule, cancel, notify, now = () => performance.now(),
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis), cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) }) {
  const jobs = new WeakMap();
  let active = null, generation = null, disposed = false, worker = null;

  function wakeup(job) {
    job.promise = new Promise(resolve => { job.resolve = resolve; });
  }
  function stop(job) {
    if (!job || job.cancelled) return;
    job.cancelled = true;
    if (job.task !== null) cancel(job.task);
    if (job.notification !== null) cancel(job.notification);
    if (job.frame !== null) cancelFrame?.(job.frame);
    if (job.frameTimer !== null) cancel(job.frameTimer);
    job.task = job.notification = job.frame = job.frameTimer = null;
    if (job === active) worker?.cancel();
    job.resolve();
    job.input = job.partial = job.tree = null;
    job.fragments = [];
    jobs.delete(job.doc);
  }
  function changed(job) {
    job.resolve();
    if (!job.done && !job.failure) wakeup(job);
    if (job === active && job.notification === null) job.notification = schedule(() => {
      job.notification = null;
      if (!disposed && active === job && !job.cancelled) notify(job.doc);
    }, 0);
  }
  function work(job, budget, separateFinish = false) {
    if (job.cancelled || job.done) return;
    const until = now() + budget;
    let advanced = false;
    do {
      if (!job.partial) {
        job.partial = raw.startParse(job.input, job.fragments, job.ranges);
        if (job.useWorker) job.partial.stopAt(Math.min(job.prefixTarget, job.covered + PREFIX_PUBLICATION_STEP));
      }
      // A stopped LR tree return can cost several milliseconds by itself.
      // Once a scheduled turn reaches that known boundary, finalize next turn
      // instead of appending it to already-spent parsing work. Initial small
      // synchronous prefixes retain their separately reserved finish allowance.
      if (separateFinish && advanced && job.partial.stoppedAt !== null && job.partial.parsedPos >= job.partial.stoppedAt) return;
      advanced = true;
      const tree = job.partial.advance();
      if (tree) {
        const stoppedAt = job.partial.stoppedAt;
        job.tree = tree;
        job.covered = Math.min(tree.length, stoppedAt ?? job.input.length);
        job.done = stoppedAt === null || stoppedAt >= job.input.length;
        job.partial = null;
        // A stopped parse can reuse an entire large old node past the stop.
        // Replacing its original complete fragment with an open-ended prefix
        // would cut that same node out of the full pass. Prefer the original
        // edit-mapped fragments when present; seed cold work with the prefix.
        if (job.done || !job.fragments.length) job.fragments = TreeFragment.addTree(tree, job.fragments, !job.done);
        changed(job);
        // Separate prefix finalization/publication from the full continuation.
        return;
      }
    } while (now() < until);
  }
  function enqueue(job) {
    if (disposed || job.cancelled || job.done || job.failure || job !== active || job.task !== null || job.frame !== null) return;
    if (job.useWorker && job.workerStarted && job.covered >= job.prefixTarget) return;
    if (requestFrame && !job.paintWaited && job.tree !== Tree.empty && (!job.useWorker || job.covered >= job.prefixTarget)) {
      job.paintWaited = true;
      const resume = () => {
        if (job.frame !== null) cancelFrame?.(job.frame);
        if (job.frameTimer !== null) cancel(job.frameTimer);
        job.frame = job.frameTimer = null;
        enqueue(job);
      };
      job.frame = requestFrame(resume);
      // Background/non-rendering hosts can suspend rAF indefinitely. The owned
      // deadline keeps EOF analysis live without any global scheduling patch.
      job.frameTimer = schedule(resume, 50);
      return;
    }
    job.task = schedule(function parseChunk() {
      job.task = null;
      if (disposed || active !== job || job.cancelled || job.done) return;
      if (job.useWorker && !job.partial && job.covered >= job.prefixTarget) {
        if (job.workerStarted) return;
        job.workerStarted = true;
        worker ||= createWorkerClient(adapter);
        worker.parse({ length: job.input.length, sliceString: (from, to) => job.input.read(from, to) }, job.id).then(result => {
          if (disposed || job.cancelled || active !== job) return;
          if (result.status === "ready") {
            // A measured viewport/query may have requested another prefix turn
            // while this full result was in flight. EOF supersedes that work.
            if (job.task !== null) cancel(job.task);
            if (job.frame !== null) cancelFrame?.(job.frame);
            if (job.frameTimer !== null) cancel(job.frameTimer);
            job.task = job.frame = job.frameTimer = null;
            job.partial = null;
            job.tree = result.tree; job.covered = result.tree.length; job.done = true;
            job.fragments = []; job.metrics = result.metrics;
          } else job.failure = result.reason;
          changed(job);
        });
        return;
      }
      work(job, PARSE_WORK_MS, true);
      enqueue(job);
    }, 0);
  }
  function create(input, fragments, ranges, doc, viewport) {
    const useWorker = !!adapter && canUseLanguageWorker() && input.length >= WORKER_MIN_LENGTH;
    // Returned Worker trees have no main-thread recovery cache. A fresh bounded
    // viewport prefix avoids scanning their document-sized fragment metadata.
    if (useWorker) fragments = [];
    const job = { doc, input, fragments, ranges, tree: Tree.empty, covered: 0, done: false,
      useWorker, prefixTarget: useWorker ? Math.min(MAIN_PREFIX_LIMIT, Math.max(128, viewport)) : viewport,
      cancelled: false, partial: raw.startParse(input, fragments, ranges), task: null, notification: null, frame: null, frameTimer: null, paintWaited: false };
    wakeup(job);
    // CM supplies the actual viewport on edits (and its 3000-unit initial
    // viewport on creation). Do not force extra offscreen prefix work into the
    // synchronous edit slice; the full continuation still covers every unit.
    const prefix = Math.min(input.length, job.prefixTarget);
    if (prefix < input.length) job.partial.stopAt(prefix);
    jobs.set(doc, job);
    work(job, PARSE_WORK_MS);
    if (job.tree === Tree.empty && job.partial) {
      // Publish what the initial slice actually consumed, instead of replacing
      // known head syntax with an empty tree until the whole viewport finishes.
      // Start at most one more millisecond of finalization work. The initial
      // allowance leaves another millisecond for a last nonpreemptible advance
      // (real small-prefix returns can take 1.3ms) and publication bookkeeping.
      job.partial.stopAt(Math.min(prefix, job.partial.parsedPos));
      work(job, 1);
    }
    return job;
  }
  const parser = new class extends Parser {
    createParse(input, fragments, ranges) {
      const context = ParseContext.get(), doc = context?.state.doc;
      if (disposed) return ParseContext.getSkippingParser().startParse(input, fragments, ranges);
      // Direct raw/headless Parser callers still control their own continuation.
      if (!doc || analysisPolicy(input.length).mode === "limited" || ranges.length !== 1 || ranges[0].from !== 0 || ranges[0].to !== input.length)
        return raw.startParse(input, fragments, ranges);
      let job = jobs.get(doc) || create(input, fragments, ranges, doc, context.viewport.to);
      let stoppedAt = null;
      return {
        get parsedPos() { return job.covered; },
        get stoppedAt() { return stoppedAt; },
        stopAt(pos) {
          if (stoppedAt !== null && pos > stoppedAt) throw new RangeError("Can't move stoppedAt forward");
          stoppedAt = pos;
        },
        advance() {
          if (disposed) return ParseContext.getSkippingParser().startParse(input, fragments, ranges).advance();
          if (job.cancelled) job = jobs.get(doc) || create(input, fragments, ranges, doc, context.viewport.to);
          if (!job.done && job.covered < input.length) {
            // Only the uncovered suffix is skipped. Returning the actual prefix
            // preserves known highlighting and cannot certify full coverage.
            ParseContext.getSkippingParser(job.failure ? undefined : job.promise).startParse(input, [], [{ from: job.covered, to: input.length }]).advance();
          }
          return job.tree;
        },
      };
    }
  };
  function commit(doc, nextGeneration, revision = 0) {
    if (disposed) return false;
    if (active?.doc === doc && generation === nextGeneration) { enqueue(active); return active.done; }
    const previous = active;
    let job = jobs.get(doc);
    // A new generation must retire the previous task even if its Text is shared.
    if (job === previous && job) {
      const { input, fragments, ranges } = job;
      stop(job);
      job = create(input, fragments, ranges, doc, MAIN_PREFIX_LIMIT);
    } else stop(previous);
    active = job || null;
    generation = nextGeneration;
    if (active) active.id = { generation, revision };
    if (active) enqueue(active);
    return !!active?.done;
  }
  function query(doc, upto, budget = 5) {
    const job = jobs.get(doc);
    // Offscreen context stays explicitly unknown until the Worker publishes.
    // Queries can finish a small real prefix, never initiate a full UI parse.
    if (job?.useWorker && (job.done || job.failure || upto > MAIN_PREFIX_LIMIT)) return;
    const shortPrefix = upto <= 128;
    // CM removes fragments shorter than its128-unit skipped-range gap. A tiny
    // raw prefix can contain the queried token but still be unavailable to CM.
    if (job && job.input) upto = Math.min(job.input.length, Math.max(128, upto));
    if (!disposed && job && !job.cancelled && job.covered < upto) {
      const until = now() + Math.min(budget, PARSE_WORK_MS);
      // A stopped initial prefix may finish before this query's target. Use
      // only the remaining query budget for the real full continuation.
      while (!job.done && job.covered < upto && now() < until) {
        if (!job.partial) {
          job.partial = raw.startParse(job.input, job.useWorker ? [] : job.fragments, job.ranges);
          if (job.useWorker) job.partial.stopAt(Math.min(MAIN_PREFIX_LIMIT, Math.max(128, upto)));
        }
        const stop = Math.max(upto, job.partial.parsedPos);
        if (shortPrefix && stop < job.input.length && (job.partial.stoppedAt === null || stop < job.partial.stoppedAt)) job.partial.stopAt(stop);
        work(job, Math.max(0, until - now()));
      }
    }
  }
  function viewport(doc, to) {
    const job = jobs.get(doc);
    if (disposed || job !== active || !job?.useWorker || job.cancelled || job.done || job.failure) return;
    job.prefixTarget = Math.max(job.prefixTarget, Math.min(MAIN_PREFIX_LIMIT, Math.max(128, to)));
    enqueue(job);
  }
  function dispose() { if (!disposed) { disposed = true; stop(active); worker?.dispose(); worker = null; active = null; } }
  return { parser, commit, query, viewport, dispose, failure: doc => jobs.get(doc)?.failure || null };
}
