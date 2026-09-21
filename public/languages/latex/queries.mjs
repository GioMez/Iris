import { headings, commandSignatures, mathEnvironments } from "./catalog.mjs";
import { analysisPolicy, requireAnalysisLength, unknownContext } from "../../iris-language-policy.mjs";
export { emptySummary, unknownContext } from "../../iris-language-policy.mjs";

const groups = new Set(["Group", "OptionalGroup", "OptionalArgument", "DefaultArgument", "HeadingGroup", "TextGroup", "LabelGroup", "ReferenceGroup", "ReferenceListGroup", "CitationGroup", "PathGroup", "PathListGroup", "DefinitionGroup", "BodyGroup", "SpecGroup"]);
const regionKinds = { Math: "math", Environment: "environment", Verb: "literal", Verbatim: "literal" };
const closers = { Math: "MathClose", Environment: "EnvironmentClose", Verb: "VerbClose", Verbatim: "LiteralEnd", LineComment: "CommentEnd", DefinitionWord: "CommandEnd" };
const commands = new Set(["HeadingCommand", "CatalogCommand", "ProfileCommand"]);
const transparent = new Set(["Space", "LineComment", "OptionalArgument", "DefaultArgument", "DefinitionGroup", "DefinitionWord", "DefinitionSymbol", "Parameter", "SpecGroup", "BodyGroup", "Text"]);
const raw = (node, doc) => doc.sliceString(node.from, node.to);
const commandName = (node, doc) => raw(node, doc).slice(1).replace(/\*$/, "");
function commandBefore(node) {
  for (let prev = node.prevSibling, count = 0; prev && count < 128; prev = prev.prevSibling, count++) {
    if (commands.has(prev.name)) return prev;
    if (!transparent.has(prev.name)) break;
  }
  return null;
}
function* commandBeforeSteps(node) {
  let count = 0;
  for (let prev = node.prevSibling; prev; prev = prev.prevSibling) {
    if (commands.has(prev.name)) return prev;
    if (!transparent.has(prev.name)) break;
    if (++count === 128) { count = 0; yield; }
  }
  return null;
}
function environmentNameNode(node) {
  // Both environment rules start with Begin, whose completed header ends with
  // EnvironmentName, EnvClose. Avoid searching a document-sized body/header.
  const header = node.name === "Environment" || node.name === "Verbatim" ? node.firstChild : node;
  const close = header?.lastChild, name = close?.prevSibling;
  return close?.name === "EnvClose" && name?.name === "EnvironmentName" ? name : null;
}
function environmentName(node, doc) {
  const name = environmentNameNode(node);
  return name && name.to - name.from <= 64 ? doc.sliceString(name.from, name.to) : "";
}
function* rawSteps(node, doc) {
  const parts = [];
  if (node) for (let from = node.from; from < node.to; from += 512) { parts.push(doc.sliceString(from, Math.min(from + 512, node.to))); yield; }
  return parts.join("");
}
function boundary(node) {
  if (node.name === "DefinitionSymbol") return { closed: true, ended: true, eofComment: false };
  const last = node.lastChild;
  const closer = groups.has(node.name) ? ["OptionalGroup", "OptionalArgument", "DefaultArgument"].includes(node.name) ? "OptionalClose" : "CloseBrace" : closers[node.name];
  const closed = last?.name === closer || node.name === "LineComment" && last?.name === "HeaderCommentEnd";
  return { closed, ended: closed || node.name === "Verb" && last?.name === "VerbBreak" || node.name === "Environment" && last?.name === "MissingEnd",
    eofComment: node.name === "LineComment" && closed && last.from === last.to };
}
function contents(node, doc) {
  return { from: node.from + 1, to: node.to - (boundary(node).closed ? 1 : 0) };
}
function argumentRole(node, doc) {
  if (node.name === "EnvironmentName") return "environment";
  if (node.name === "HeadingGroup") return "heading";
  if (node.name === "TextGroup" || node.name === "OptionalArgument") return "text";
  if (node.name === "BodyGroup") return "body";
  if (node.name === "DefaultArgument") return "default";
  if (node.name === "SpecGroup") return "spec";
  if (node.name === "LabelGroup") return "label";
  if (node.name === "ReferenceGroup") return "reference";
  if (node.name === "ReferenceListGroup") return "reference-list";
  if (node.name === "CitationGroup") return "citation-list";
  if (node.name === "PathGroup") return "path";
  if (node.name === "PathListGroup") return "path-list";
  if (node.name === "DefinitionWord" || node.name === "DefinitionSymbol") return "definition-command";
  if (node.name === "DefinitionGroup") {
    // These leaf types already encode the lexical declaration role. Looking at
    // a bounded number of children avoids depending on distant header trivia.
    for (let child = node.firstChild, count = 0; child && count < 8; child = child.nextSibling, count++) {
      if (child.name === "DefinitionText") return "definition-environment";
      if (child.name === "DefinitionWord" || child.name === "DefinitionSymbol") return "definition-command";
    }
    const command = commandBefore(node), signature = command && commandSignatures[commandName(command, doc)];
    return signature?.definition ? `definition-${signature.definition}` : "unknown";
  }
  return null;
}
// Certainty belongs to this exact immutable tree, never to source positions in
// another revision. Cold caret reads have a fixed 128-child inspection budget.
const literalCaches = new WeakMap();
const literalLeaves = new Set(["ReferenceText", "CitationText", "PathText", "DefinitionText", "Space"]);
const recordRoles = new Set(["label", "reference", "reference-list", "citation-list", "path", "path-list"]);
function literalCache(tree) {
  let cache = literalCaches.get(tree);
  if (!cache) literalCaches.set(tree, cache = new Map());
  return cache;
}
function* literalSteps(tree, node) {
  const key = `${node.from}:${node.to}:${node.name}`, cache = literalCache(tree);
  if (cache.has(key)) return cache.get(key);
  const cursor = node.cursor();
  let count = 0, literal = true;
  if (cursor.firstChild()) do {
    const delimiter = cursor.from === node.from && cursor.to === node.from + 1 || cursor.name === "CloseBrace" && cursor.to === node.to || cursor.type.isError && cursor.from === node.to && cursor.to === node.to;
    if (!delimiter && !literalLeaves.has(cursor.name)) { literal = false; break; }
    if (++count === 128) { count = 0; yield; }
  } while (cursor.nextSibling());
  cache.set(key, literal);
  return literal;
}
function literalAt(tree, node, budget) {
  const cache = literalCache(tree), key = `${node.from}:${node.to}:${node.name}`;
  if (cache.has(key)) return cache.get(key);
  if (budget.remaining === 0) return false;
  budget.remaining = 0;
  const steps = literalSteps(tree, node), step = steps.next();
  steps.return();
  return step.done ? step.value : false;
}
function* records(tree, node, doc, list, key, kind, split = false) {
  const span = contents(node, doc), dynamic = !(yield* literalSteps(tree, node));
  const certainty = dynamic ? "unknown" : boundary(node).closed ? "exact" : "recovered";
  let parts = [], start = span.from, length = 0;
  const emit = () => {
    const raw = parts.join(""), value = raw.trim(), from = start + raw.indexOf(value);
    if (value) list.push(Object.freeze({ ...(kind ? { kind } : {}), [key]: value, from, to: from + value.length, certainty }));
    parts = []; start += length + 1; length = 0;
  };
  for (let from = span.from; from < span.to; from += 512) {
    const text = doc.sliceString(from, Math.min(from + 512, span.to));
    let offset = 0;
    for (;;) {
      const comma = split && !dynamic ? text.indexOf(",", offset) : -1;
      const part = text.slice(offset, comma < 0 ? text.length : comma);
      parts.push(part); length += part.length;
      if (comma < 0) break;
      emit(); offset = comma + 1;
    }
    yield;
  }
  emit();
}
function* sortedRegions(regions) {
  // Most regions arrive in tree preorder. Check final endpoints cooperatively:
  // heading regions are appended on exit and recovery can change end positions.
  // Equal keys keep their original order; only inversions need the stable merge.
  let work = 0, ordered = true;
  for (let i = 1; i < regions.length; i++) {
    const previous = regions[i - 1], current = regions[i], from = previous.from, next = current.from;
    if (from > next || from === next && previous.to < current.to) { ordered = false; break; }
    if (++work === 128) { work = 0; yield; }
  }
  if (ordered) return regions;
  let src = regions, dest = new Array(regions.length);
  for (let width = 1; width < regions.length; width *= 2) {
    for (let start = 0; start < regions.length; start += width * 2) {
      const mid = Math.min(start + width, src.length), end = Math.min(mid + width, src.length);
      let a = start, b = mid;
      for (let i = start; i < end; i++) {
        dest[i] = a < mid && (b === end || src[a].from < src[b].from || src[a].from === src[b].from && src[a].to >= src[b].to) ? src[a++] : src[b++];
        if (++work === 128) { work = 0; yield; }
      }
    }
    [src, dest] = [dest, src];
  }
  return src;
}

/** Shared tree visitor for batch and cooperative state jobs. No second source
 * parser: names/titles/keys come only from the recognized node spans. */
export function* summarySteps(tree, doc) {
  requireAnalysisLength(doc.length);
  const data = { outline: [], regions: [], symbols: [], references: [], includes: [] };
  const cursor = tree.cursor(), frames = [], counters = Array(7).fill(0), headingRegions = [];
  let entering = true, skipped = 0;
  for (;;) {
    if (entering) {
      const parent = frames.at(-1), name = cursor.name;
      const deferred = parent?.deferred || name === "BodyGroup" || name === "SpecGroup" || name === "DefaultArgument";
      if (cursor.type.isError || name === "MissingEnd") { if (parent) parent.error = true; }
      const structural = groups.has(name) || regionKinds[name] || name === "Document" || name === "LineComment" || name === "Begin" || name === "End" || name === "LiteralEnd" || name === "LiteralEndHeader" || name === "DefinitionWord" || name === "DefinitionSymbol";
      if (!structural && !cursor.type.isError) {
        if (++skipped === 128) { skipped = 0; yield; }
        if (cursor.nextSibling()) continue;
        if (!cursor.parent()) break;
        entering = false;
        continue;
      }
      // Only closing/environment headers need a node on entry. Math/groups use
      // cursor coordinates here, and materialize once on exit for their closer.
      const end = name === "End" ? cursor.node : null;
      if (end?.getChild("OrphanClose")) { if (parent) parent.error = true; }
      const current = { name, deferred, error: cursor.type.isError, region: null,
        closingFrom: end?.lastChild?.name === "EndClose" ? cursor.from : null };
      if (!deferred && (groups.has(name) || regionKinds[name])) {
        const isEnvironment = name === "Environment" || name === "Verbatim";
        const node = isEnvironment ? cursor.node : null;
        const env = isEnvironment ? yield* rawSteps(environmentNameNode(node), doc) : "";
        const close = isEnvironment && node.firstChild?.lastChild;
        if (env !== "document" && (!isEnvironment || close?.name === "EnvClose" && close.to > close.from)) {
          current.region = { kind: regionKinds[name] || "group", name: env, label: env ? `\\begin{${env}}` : regionKinds[name] || "group",
            from: cursor.from, to: cursor.to, certainty: "exact", openEnded: false };
          data.regions.push(current.region);
        }
      }
      frames.push(current);
      yield;
      if (cursor.firstChild()) continue;
    }
    const current = frames.pop(), node = cursor.node;
    const edge = boundary(node), certainty = current.error || !edge.closed ? "recovered" : "exact";
    if (current.region) {
      if (current.name === "Environment" && node.lastChild?.name === "MissingEnd") current.region.to = current.closingFrom ?? node.to;
      current.region.openEnded = !edge.ended;
      current.region.certainty = certainty;
      Object.freeze(current.region);
    }
    if (!current.deferred) {
      if (current.name === "HeadingGroup") {
        const command = yield* commandBeforeSteps(node);
        if (command?.name === "HeadingCommand") {
          const level = headings[commandName(command, doc)], starred = raw(command, doc).endsWith("*");
          if (!starred) { counters[level]++; counters.fill(0, level + 1); }
          const first = counters.findIndex(n => n > 0), num = starred ? "" : counters.slice(first, level + 1).join(".");
          const span = contents(node, doc), title = yield* rawSteps(span, doc);
          data.outline.push(Object.freeze({ level, num, title, offset: command.from, to: node.to, certainty }));
          for (let i = headingRegions.length - 1; i >= 0 && headingRegions[i].level >= level; i--) {
            headingRegions.pop().region.to = command.from;
          }
          const region = { kind: "heading", name: commandName(command, doc), label: title, from: command.from, to: doc.length, certainty, openEnded: !edge.ended };
          data.regions.push(region); headingRegions.push({ level, region });
        }
      }
      if (current.name === "DefinitionGroup" || ["DefinitionWord", "DefinitionSymbol"].includes(current.name) && node.parent?.name !== "DefinitionGroup") {
        const command = yield* commandBeforeSteps(node), signature = command && commandSignatures[commandName(command, doc)];
        const role = signature?.definition === "environment" ? "definition-environment" : "definition-command";
        const nameNode = node.name !== "DefinitionGroup" ? node : node.getChild("DefinitionWord") || node.getChild("DefinitionSymbol");
        if (role === "definition-environment") yield* records(tree, node, doc, data.symbols, "name", "environment");
        else if (nameNode) data.symbols.push(Object.freeze({ kind: "command", name: yield* rawSteps({ from: nameNode.from + 1, to: nameNode.to }, doc), from: nameNode.from, to: nameNode.to,
          certainty: current.error || node.name === "DefinitionGroup" && !edge.closed ? "recovered" : "exact" }));
      }
      if (["LabelGroup", "ReferenceGroup", "ReferenceListGroup"].includes(current.name)) {
        const label = argumentRole(node, doc) === "label";
        yield* records(tree, node, doc, label ? data.symbols : data.references, "name", "label", argumentRole(node, doc) === "reference-list");
      }
      if (current.name === "CitationGroup") yield* records(tree, node, doc, data.references, "name", "citation", true);
      if (current.name === "PathGroup" || current.name === "PathListGroup") {
        const command = yield* commandBeforeSteps(node), signature = command && commandSignatures[commandName(command, doc)];
        if (signature?.include) yield* records(tree, node, doc, data.includes, "path", null, argumentRole(node, doc) === "path-list");
      }
    }
    if (current.error && frames.length) frames.at(-1).error = true;
    // A matched End is visited once. Carry its start through recovered inner
    // scopes one frame per existing yield, and consume it at its matched owner.
    // OrphanClose never supplies a boundary; normally closed children cannot
    // leak their earlier closing header into a later ancestor recovery.
    if (current.closingFrom !== null && frames.length && (current.name !== "Environment" || node.lastChild?.name === "MissingEnd")) {
      frames.at(-1).closingFrom = current.closingFrom;
    }
    yield;
    if (cursor.nextSibling()) { entering = true; continue; }
    if (!cursor.parent()) break;
    entering = false;
  }
  data.regions = yield* sortedRegions(data.regions);
  for (let i = 0; i < data.regions.length; i++) { Object.freeze(data.regions[i]); if (i % 128 === 127) yield; }
  for (const list of Object.values(data)) Object.freeze(list);
  return Object.freeze(data);
}
export function summarize(tree, doc) {
  const steps = summarySteps(tree, doc);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Half-open ownership, including open EOF and known VerbBreak endpoints. */
export function contextAt(tree, doc, pos, bias = -1) {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.length) throw new RangeError("Cursor outside source");
  if (analysisPolicy(doc.length).mode === "limited") return unknownContext(pos);
  if (tree.type.name !== "Document" || pos > tree.length) return unknownContext(pos);
  let node = tree.resolveInner(pos, pos === doc.length ? -1 : 1), depth = 0, argument = null, semantic = null, dynamic = false;
  const certaintyBudget = { remaining: 128 };
  const leaf = node, completion = {};
  for (; node && depth < 256; node = node.parent, depth++) {
    if (["ControlWord", "ControlSymbol"].includes(node.name) || node.name.endsWith("Command")) {
      completion.commandFrom = node.from;
      completion.commandTo = node.to === tree.length && tree.length < doc.length ? null : node.to;
    }
    if (node.name === "Begin" || node.name === "End") {
      const last = node.lastChild, tail = last?.type.isError || ["EnvClose", "EndClose", "OrphanClose"].includes(last?.name) ? last.prevSibling : last;
      const name = tail?.name === "EnvironmentName" ? tail : null, open = name ? name.prevSibling : tail;
      if (open?.name === "EnvOpen" && pos >= open.to && pos <= (name?.to ?? open.to)) {
        argument = { node: name || open, role: "environment" };
      }
    }
    const edge = boundary(node);
    if (pos === node.to && (pos !== doc.length || edge.ended && !edge.eofComment)) continue;
    const role = argumentRole(node, doc);
    if (role && !argument) argument = { node, role: role === "unknown" ? null : role };
    if (role === "unknown") dynamic = true;
    if (recordRoles.has(role) && !literalAt(tree, node, certaintyBudget)) dynamic = true;
    const mode = semantic ? null : node.name === "LineComment" ? "comment" : node.name === "Math" ? "math" : node.name === "Verb" ? "literal" : node.name === "Verbatim" ? (pos < (node.getChild("LiteralStart")?.from ?? node.to) ? "text" : "literal") :
      role ? "text" : node.name === "Environment" && mathEnvironments.has(environmentName(node, doc)) ? "math" : null;
    if (mode && !semantic) semantic = { mode, from: node.from, to: node.to, certainty: edge.closed ? "exact" : "recovered" };
  }
  if (node) return unknownContext(pos);
  if (argument && ["environment", "reference", "reference-list", "citation-list"].includes(argument.role)) {
    const arg = argument.node, span = arg.name === "EnvironmentName" ? arg : arg.name === "EnvOpen" ? { from: arg.to, to: arg.to } : contents(arg, doc);
    completion.argumentFrom = span.from;
    completion.argumentTo = arg.to === tree.length && tree.length < doc.length && !boundary(arg).closed ? null : span.to;
  }
  if (semantic) return Object.freeze({ ...semantic, ...completion, argumentRole: argument?.role || null, certainty: dynamic ? "unknown" : semantic.certainty });
  if (argument) {
    const { node: arg, role } = argument;
    return Object.freeze({ mode: "text", ...completion, argumentRole: role, from: arg.from, to: arg.to,
      certainty: dynamic ? "unknown" : boundary(arg).closed ? "exact" : "recovered" });
  }
  const preferred = tree.resolveInner(pos, bias);
  const contains = n => !n.type.isTop && n.from <= pos && pos < n.to;
  const text = contains(preferred) ? preferred : contains(leaf) ? leaf : null;
  return Object.freeze({ mode: "text", ...completion, argumentRole: null, from: text?.from ?? pos, to: text?.to ?? pos, certainty: text?.type.isError ? "recovered" : "exact" });
}
