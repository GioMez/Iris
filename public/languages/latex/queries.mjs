import { headings } from "./catalog.mjs";
import { analysisPolicy, requireAnalysisLength, unknownContext } from "../../iris-language-policy.mjs";
export { emptySummary, unknownContext } from "../../iris-language-policy.mjs";

const regionKinds = Object.freeze({ Group: "group", Math: "math", Verb: "literal", Verbatim: "literal" });
const closers = Object.freeze({ Group: "CloseBrace", Math: "MathClose", Verb: "VerbClose", Verbatim: "VerbatimClose" });
const scalarNodes = new Set(["OpenBrace", "CloseBrace", "MathOpen", "MathClose", "CommentStart", "CommentText", "CommentEnd",
  "VerbOpen", "VerbClose", "VerbBreak", "VerbatimOpen", "VerbatimClose", "LiteralText", "CommandStart", "CommandPart", "CommandEnd",
  "HeadingCommand", "ControlSymbol", "Text", "Space"]);

function boundary(node) {
  const last = node.lastChild;
  const closed = last?.name === (node.name === "LineComment" ? "CommentEnd" : closers[node.name]);
  return { closed, ended: closed || node.name === "Verb" && last?.name === "VerbBreak",
    eofComment: node.name === "LineComment" && closed && last.from === last.to };
}

/** Same bounded visitor for synchronous tests and cooperative service/state jobs.
 * HP03: top-level unstarred headings, groups/math/literals. No macro expansion,
 * definitions, references or include interpretation. Titles are raw source
 * previews capped at 4096 units (longer titles have recovered certainty).
 */
export function* summarySteps(tree, doc) {
  requireAnalysisLength(doc.length);
  const data = { outline: [], regions: [], symbols: [], references: [], includes: [] };
  const cursor = tree.cursor(), frames = [];
  let entering = true, pendingHeading = null, skipped = 0;
  for (;;) {
    if (entering) {
      const parent = frames.at(-1);
      const name = cursor.name;
      let heading = null;
      if (parent?.name === "Document") {
        if (cursor.name === "HeadingCommand") {
          const command = doc.sliceString(cursor.from + 1, cursor.to);
          pendingHeading = { level: headings[command], offset: cursor.from };
        } else if (cursor.name === "Group" && pendingHeading) {
          heading = pendingHeading;
          pendingHeading = null;
        } else if (cursor.name !== "Space" && cursor.name !== "LineComment") pendingHeading = null;
      }
      // Prune scalar visitor frames/exit events. Cursor hops still find every
      // structural/error node; yield after a bounded run of irrelevant leaves.
      // Do not skip whole command/comment subtrees: they can contain recovery.
      if (scalarNodes.has(name) || cursor.type.isError && !cursor.node.firstChild) {
        if (cursor.type.isError && parent) parent.error = true;
        if (++skipped === 128) { skipped = 0; yield; }
        if (cursor.nextSibling()) continue;
        if (!cursor.parent()) break;
        entering = false;
        continue;
      }
      const current = { name, from: cursor.from, to: cursor.to, error: cursor.type.isError, region: null, heading };
      if (regionKinds[cursor.name]) {
        current.region = { kind: regionKinds[cursor.name], name: cursor.name === "Verbatim" ? "verbatim" : "", label: regionKinds[cursor.name], from: cursor.from, to: cursor.to, certainty: "exact", openEnded: false };
        data.regions.push(current.region);
      }
      frames.push(current);
      yield;
      if (cursor.firstChild()) continue;
    }
    const current = frames.pop();
    // Cursor is back at this node on exit, so checking its final child is O(1).
    if (current.region) {
      const { closed, ended } = boundary(cursor.node);
      current.region.openEnded = !ended;
      current.region.certainty = current.error || !closed ? "recovered" : "exact";
      Object.freeze(current.region);
    }
    if (current.heading) {
      const end = current.to - (current.region.openEnded ? 0 : 1);
      const titleEnd = Math.min(end, current.from + 1 + 4096);
      data.outline.push(Object.freeze({ ...current.heading, num: "", title: doc.sliceString(current.from + 1, titleEnd), to: current.to,
        certainty: titleEnd < end ? "recovered" : current.region.certainty }));
    }
    if (current.error && frames.length) frames.at(-1).error = true;
    yield;
    if (cursor.nextSibling()) { entering = true; continue; }
    if (!cursor.parent()) break;
    entering = false;
  }
  for (const list of Object.values(data)) Object.freeze(list);
  return Object.freeze(data);
}

export function summarize(tree, doc) {
  const steps = summarySteps(tree, doc);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Half-open semantic regions own their starts, regardless of bias. At EOF an
 * open region (or EOF line comment) still owns the caret. bias, default -1,
 * refines the fallback text-leaf lookup; it cannot cross a known region endpoint.
 * No document scan: inspect at most 256 ancestors of the owning syntax node.
 */
export function contextAt(tree, doc, pos, bias = -1) {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.length) throw new RangeError("Cursor outside source");
  if (analysisPolicy(doc.length).mode === "limited") return unknownContext(pos);
  if (tree.type.name !== "Document" || pos > tree.length) return unknownContext(pos);
  let node = tree.resolveInner(pos, pos === doc.length ? -1 : 1), depth = 0;
  const leaf = node;
  for (; node && depth < 256; node = node.parent, depth++) {
    const mode = node.name === "LineComment" ? "comment" : node.name === "Math" ? "math" : node.name === "Verb" || node.name === "Verbatim" ? "literal" : null;
    if (!mode) continue;
    const { closed, ended, eofComment } = boundary(node);
    if (pos === node.to && (pos !== doc.length || ended && !eofComment)) continue;
    return Object.freeze({ mode, argumentRole: null, from: node.from, to: node.to, certainty: closed ? "exact" : "recovered" });
  }
  if (node) return unknownContext(pos);
  const preferred = tree.resolveInner(pos, bias);
  const contains = node => !node.type.isTop && node.from <= pos && pos < node.to;
  const text = contains(preferred) ? preferred : contains(leaf) ? leaf : null;
  return Object.freeze({ mode: "text", argumentRole: null, from: text?.from ?? pos, to: text?.to ?? pos, certainty: text?.type.isError ? "recovered" : "exact" });
}
