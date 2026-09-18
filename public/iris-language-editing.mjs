const empty = Object.freeze([]);

/** Locate only an opener on the current bounded line. No source-wide scanner. */
export function enterPlan(tree, doc, pos, describe, protectedNode, contextAt) {
  if (tree.type.name !== "Document" || tree.length !== doc.length || pos < 0 || pos > doc.length) return null;
  const prefix = doc.sliceString(Math.max(0, pos - 1024), pos), newline = prefix.lastIndexOf("\n");
  if (newline < 0 && pos > 1024) return null;
  const lineFrom = pos - prefix.length + newline + 1;
  let node = tree.resolveInner(pos, -1), candidate = null, depth = 0, reserved = false, comment = null;
  for (; node && depth++ < 256; node = node.parent) {
    const block = describe(node, doc);
    if (node.name === "LineComment") comment = node;
    else if (protectedNode(node) && !(block?.literalOpen && pos === block.open.to)) return null;
    if (!block) continue;
    if (!candidate && block.open.from >= lineFrom && block.open.to <= pos
        && /^[\t ]*$/.test(doc.sliceString(block.open.to, comment && comment.from >= block.open.to ? comment.from : pos))) candidate = block;
    else if (candidate && block.close === candidate.close && block.closingFrom === null) reserved = true;
  }
  if (node || !candidate) return null;
  // Recovered EOF is useful: a missing close does not invalidate the opener.
  // Unknown readers, comments and strings still own their descendants.
  const context = contextAt(tree, doc, pos);
  if (["string", "unknown", "scheme"].includes(context.mode) || context.mode === "literal" && !candidate.literalOpen
      || context.mode === "comment" && !comment || context.certainty === "unknown") return null;
  return Object.freeze({ close: candidate.close, closingFrom: candidate.closingFrom,
    needsClose: reserved || candidate.closingFrom === null });
}

/** Small, bounded structural format. Insufficient/recovered syntax declines the
 * operation. Only leading indentation is changed; all other bytes are retained. */
export function indentationChanges(tree, doc, range, describe, protectedNode) {
  if (tree.type.name !== "Document" || tree.length !== doc.length || doc.length > 65536) return empty;
  const deadline = performance.now() + 8, events = [], protectedSpans = [];
  let nodes = 0, unsafe = false;
  tree.iterate({ enter(ref) {
    if (unsafe) return false;
    if (++nodes > 32768 || performance.now() > deadline || ref.type.isError || ref.name === "MissingEnd" || ref.name === "UnknownMarkup" || ref.name === "SchemeUnknown") { unsafe = true; return false; }
    const node = ref.node;
    if (protectedNode(node)) { protectedSpans.push({ from: node.from, to: node.to }); return false; }
    const block = describe(node, doc);
    if (block) {
      if (block.closingFrom === null) { unsafe = true; return false; }
      events.push({ pos: block.open.to, delta: 1 }, { pos: block.closingFrom, delta: -1 });
    }
  } });
  if (unsafe) return empty;
  events.sort((a, b) => a.pos - b.pos || a.delta - b.delta);
  const source = doc.sliceString(0, doc.length), changes = [];
  let from = 0, depth = 0, event = 0, protectedIndex = 0, lines = 0;
  while (from < source.length) {
    if (++lines > 4096 || performance.now() > deadline) return empty;
    const end = source.indexOf("\n", from), to = end < 0 ? source.length : end;
    const lead = source.slice(from, to).match(/^[\t ]*/)[0], content = from + lead.length;
    while (event < events.length && events[event].pos <= content) depth += events[event++].delta;
    while (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex].to <= from) protectedIndex++;
    const protectedSpan = protectedSpans[protectedIndex];
    const protectedLine = protectedSpan && protectedSpan.from <= content && protectedSpan.to > from;
    if (!protectedLine && content < to && source[content] !== "\r" && (!range || from >= range.from && to <= range.to)) {
      const insert = "  ".repeat(Math.min(64, Math.max(0, depth)));
      if (lead !== insert) changes.push(Object.freeze({ from, to: content, insert }));
    }
    from = to + 1;
  }
  return Object.freeze(changes);
}
