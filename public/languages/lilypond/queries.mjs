import { analysisPolicy, requireAnalysisLength, unknownContext } from "../../iris-language-policy.mjs";
import { invocableName } from "./catalog.mjs";
import { normalizeNoteLanguage } from "./pitches.mjs";
export { emptySummary, unknownContext } from "../../iris-language-policy.mjs";

const groups = new Set(["Group", "MusicGroup", "LyricsGroup", "MarkupGroup", "ChordsGroup", "DrumsGroup", "FiguresGroup", "ConfigGroup", "UnknownGroup", "Simultaneous", "Chord"]);
const modeNames = Object.freeze(Object.assign(Object.create(null), { MusicGroup: "music", LyricsGroup: "lyrics", MarkupGroup: "markup", ChordsGroup: "chords", DrumsGroup: "drums", FiguresGroup: "figures", ConfigGroup: "text", UnknownGroup: "music" }));
const closers = Object.freeze(Object.assign(Object.create(null), { Simultaneous: "SimClose", Chord: "ChordClose", String: "StringClose", LyricString: "StringClose", PathString: "StringClose", LineComment: "LineEnd", BlockComment: "BlockEnd", SchemeOpaque: "SchemeEnd" }));
const isString = name => ["String", "LyricString", "PathString"].includes(name);
function boundary(node) {
  if (node.name === "UnknownMarkup") return { closed: true, openEnded: true };
  const closer = closers[node.name] || (groups.has(node.name) ? "CloseBrace" : null);
  if (!closer) return { closed: true, openEnded: false };
  const closed = node.lastChild?.name === closer;
  return { closed, openEnded: !closed || node.name === "LineComment" && node.lastChild.from === node.lastChild.to };
}
function* rawSteps(node, doc) {
  const parts = [];
  if (node) for (let from = node.from; from < node.to; from += 512) { parts.push(doc.sliceString(from, Math.min(from + 512, node.to))); yield; }
  return parts.join("");
}
function* stringSteps(node, doc) {
  if (!node || !isString(node.name)) return null;
  const parts = [], end = node.to - (boundary(node).closed ? 1 : 0);
  let escaped = false;
  for (let from = node.from + 1; from < end; from += 512) {
    const text = doc.sliceString(from, Math.min(from + 512, end));
    let part = "";
    for (const c of text) {
      if (escaped) { part += c === "n" ? "\n" : c === "t" ? "\t" : c === '"' || c === "'" || c === "\\" ? c : "\\" + c; escaped = false; }
      else if (c === "\\") escaped = true;
      else part += c;
    }
    parts.push(part); yield;
  }
  if (escaped) parts.push("\\");
  return parts.join("");
}
function* assignmentNameSteps(head, doc) {
  const parts = [];
  let first = null, last = null, single = null, names = 0;
  for (let child = head?.firstChild; child; child = child.nextSibling) {
    if (child.name === "Identifier" || child.name === "String") {
      first ||= child; last = child; names++;
      parts.push(yield* rawSteps(child, doc));
      single = child.name === "String" ? yield* stringSteps(child, doc) : parts.at(-1);
    } else if (child.name === "NameDot") parts.push(".");
    // Comments/trivia and recovery nodes are not pieces of a syntactic name.
    yield;
  }
  const label = parts.join(""), name = names === 1 && parts.length === 1 ? single : label;
  return { label, name: name || "", from: first?.from ?? head.from, to: last?.to ?? head.from };
}
const certificates = new WeakMap();
const languageTimelines = new WeakMap();
function cacheFor(tree) {
  let cache = certificates.get(tree);
  if (!cache) certificates.set(tree, cache = new Map());
  return cache;
}
const key = n => `${n.name}:${n.from}:${n.to}`;
function languageEvent(node, doc) {
  if (node.name !== "Directive") return null;
  const command = node.firstChild?.name, arg = node.lastChild;
  if (command !== "LanguageCommand" && command !== "IncludeCommand") return null;
  if (isString(arg?.name) && !boundary(arg).closed) return null;
  const text = command === "LanguageCommand" && arg?.name === "String" && arg.to - arg.from <= 130 ? doc.sliceString(arg.from + 1, arg.to - 1) : "";
  return { from: node.to, language: command === "IncludeCommand" ? "unknown" : normalizeNoteLanguage(text) };
}
function languageAt(tree, doc, pos, initial) {
  const events = languageTimelines.get(tree);
  let language = normalizeNoteLanguage(initial);
  if (events) {
    let lo = 0, hi = events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid].from <= pos) lo = mid + 1; else hi = mid; }
    return lo ? events[lo - 1].language : language;
  }
  // A cold caret never builds a whole-file summary. Small trees can be decided
  // directly; larger unknown histories remain conservative until a state job.
  const cursor = tree.cursor();
  for (let count = 0; count < 128; count++) {
    if (cursor.from > pos) return language;
    const event = languageEvent(cursor.node, doc);
    if (event && event.from <= pos) language = event.language;
    if (!cursor.next()) return language;
  }
  return "unknown";
}

/** Single tree visitor, shared by batch and cooperative analysis. Each step
 * handles <=128 scalar leaves or a structural node / <=512-unit text chunk. Headers are child nodes,
 * never a forward search for the next brace in source text. */
export function* summarySteps(tree, doc) {
  requireAnalysisLength(doc.length);
  const data = { outline: [], regions: [], symbols: [], references: [], includes: [] };
  const cursor = tree.cursor(), frames = [], cache = cacheFor(tree), languageEvents = [];
  let entering = true, score = 0, skipped = 0;
  for (;;) {
    if (entering) {
      const node = cursor.node, name = node.name, parent = frames.at(-1);
      if (!cursor.type.isTop && !cursor.type.isError && name !== "Variable" && !node.firstChild) {
        if (++skipped === 128) { skipped = 0; yield; }
        if (cursor.nextSibling()) continue;
        if (!cursor.parent()) break;
        entering = false;
        continue;
      }
      const event = languageEvent(node, doc);
      if (event) languageEvents.push(event);
      const f = { name, error: node.type.isError, config: parent?.config || name === "ConfigGroup", opaque: parent?.opaque || name === "SchemeOpaque",
        depth: (parent?.depth || 0) + (groups.has(name) ? 1 : 0), score: parent?.score || null, header: parent?.header || false,
        outline: null, region: null, title: null, symbol: null, unknown: name === "UnknownMarkup" || name === "SchemeOpaque" };
      const structural = ["Block", "Context", "ModeExpression", "Assignment", "Directive"].includes(name);
      if (structural && !f.opaque) {
        const command = node.firstChild;
        const commandText = command && command.to - command.from <= 128 ? doc.sliceString(command.from, command.to) : "";
        if (name === "Block" && commandText === "\\header") f.header = true;
        let title = "", titleKey = null, titleParams = null, num = "";
        if (name === "Assignment") {
          const head = node.firstChild, declared = yield* assignmentNameSteps(head, doc), rawName = declared.label, expression = node.lastChild;
          if (!f.config) {
            const wrapper = ["Wrapper", "ModeExpression", "Block"].includes(expression?.name) ? yield* rawSteps(expression.firstChild, doc) : "";
            title = `${rawName} =${wrapper ? " " + wrapper : ""}`;
            f.symbol = { kind: invocableName(declared.name) ? "command" : "variable", name: declared.name,
              from: declared.from, to: declared.to, certainty: "exact" };
            if (declared.name) data.symbols.push(f.symbol);
          } else if (f.header && rawName === "title" && expression?.name === "String") {
            const literal = yield* stringSteps(expression, doc);
            if (boundary(expression).closed && f.score) f.score.title = literal;
          }
        } else if (name === "Directive") {
          if (commandText === "\\include" || commandText === "\\version") {
            const arg = node.lastChild, literal = isString(arg?.name);
            title = commandText + (literal ? " " + (yield* rawSteps(arg, doc)) : "");
            if (commandText === "\\include" && literal) data.includes.push({ path: yield* stringSteps(arg, doc), from: arg.from + 1,
              to: arg.to - (boundary(arg).closed ? 1 : 0), certainty: boundary(arg).closed ? "exact" : "recovered" });
          }
        } else if (name === "Context") {
          const parts = [];
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (["WithBlock", ...groups, "Variable", "Command", "LongCommand", "Wrapper", "ModeExpression", "Context"].includes(child.name)) break;
            if (!["Space", "LineComment", "BlockComment"].includes(child.name)) parts.push(yield* rawSteps(child, doc));
            yield;
          }
          title = parts.join(" ");
        } else if (parent?.name !== "Assignment") {
          title = commandText;
          if (commandText === "\\score") {
            num = String(++score); title = `Score ${score}`; titleKey = "templates.scoreNumber"; titleParams = Object.freeze({ number: score });
          }
        }
        if (title) {
          f.outline = { level: Math.max(1, f.depth), num, title, offset: node.from, to: node.to, certainty: "exact",
            ...(titleKey ? { titleKey, titleParams } : {}) };
          // Source command names are already locale-independent. A generated
          // structural label has explicit translation metadata for HP07.
          if (name === "Block" && !titleKey) Object.assign(f.outline, { titleKey: "syntax.lilypondBlock", titleParams: Object.freeze({ command: title }) });
          data.outline.push(f.outline);
          f.region = { kind: name === "Assignment" ? "variable" : name === "Context" ? "context" : name === "Directive" ? "directive" : "block",
            name: commandText, label: title, from: node.from, to: node.to, certainty: "exact", openEnded: false,
            ...(f.outline.titleKey ? { labelKey: f.outline.titleKey, labelParams: f.outline.titleParams } : {}) };
          data.regions.push(f.region);
          if (commandText === "\\score") f.score = f;
        }
      }
      if (groups.has(name) && !f.opaque) {
        f.region = { kind: name === "Chord" ? "chord" : name === "Simultaneous" ? "simultaneous" : "group", name, label: name === "Chord" ? "Chord" : name === "Simultaneous" ? "Simultaneous music" : "Music group",
          labelKey: "syntax.lilypondGroup", labelParams: Object.freeze({ kind: name }), from: node.from, to: node.to, certainty: "exact", openEnded: false };
        data.regions.push(f.region);
      }
      if (name === "Variable" && !f.opaque) data.references.push({ kind: "variable", name: (yield* rawSteps(node, doc)).slice(1), from: node.from, to: node.to, certainty: "exact" });
      frames.push(f); yield;
      if (cursor.firstChild()) continue;
    }
    const f = frames.pop(), node = cursor.node, edge = boundary(node), recovered = f.error || !edge.closed;
    const certainty = recovered ? "recovered" : f.unknown ? "unknown" : "exact";
    if (node.name === "AssignmentHead" && frames.at(-1)?.symbol) {
      const symbol = frames.at(-1).symbol;
      symbol.certainty = certainty;
      if (certainty !== "exact") symbol.kind = "variable";
    }
    if (groups.has(node.name) || Object.hasOwn(closers, node.name) || ["ModeExpression", "MarkupCall"].includes(node.name)) cache.set(key(node), certainty);
    if (f.region) { f.region.certainty = certainty; f.region.openEnded = edge.openEnded || f.error && node.to === doc.length; }
    if (f.outline) {
      f.outline.certainty = certainty;
      if (f.title !== null) {
        f.outline.title = f.title; delete f.outline.titleKey; delete f.outline.titleParams;
        f.region.label = f.title; delete f.region.labelKey; delete f.region.labelParams;
      }
    }
    if (recovered && frames.length) frames.at(-1).error = true;
    if (f.unknown && frames.length) frames.at(-1).unknown = true;
    yield;
    if (cursor.nextSibling()) { entering = true; continue; }
    if (!cursor.parent()) break;
    entering = false;
  }
  for (const list of Object.values(data)) {
    for (const item of list) { Object.freeze(item); yield; }
    Object.freeze(list);
  }
  languageTimelines.set(tree, languageEvents);
  return Object.freeze(data);
}
export function summarize(tree, doc) {
  const steps = summarySteps(tree, doc);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
function certaintyAt(tree, node, budget) {
  const cached = cacheFor(tree).get(key(node));
  if (cached) return cached;
  const cursor = node.cursor();
  let depth = 0;
  for (;;) {
    if (--budget.remaining < 0) return "unknown";
    if (cursor.type.isError) return "recovered";
    if (cursor.name === "UnknownMarkup" || cursor.name === "SchemeOpaque") return "unknown";
    if (cursor.firstChild()) { depth++; continue; }
    while (depth > 0 && !cursor.nextSibling()) { cursor.parent(); depth--; }
    if (!depth) return boundary(node).closed ? "exact" : "recovered";
  }
}
export function contextAt(tree, doc, pos, bias = -1, initialNoteLanguage = "nederlands") {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.length) throw new RangeError("Cursor outside source");
  if (analysisPolicy(doc.length).mode === "limited" || tree.type.name !== "Document" || pos > tree.length) return unknownContext(pos);
  let node = tree.resolveInner(pos, pos === doc.length ? -1 : 1), depth = 0, semantic = null, group = null, uncertain = false, argumentRole = null;
  const leaf = node, budget = { remaining: 128 };
  for (; node && depth < 256; node = node.parent, depth++) {
    const edge = boundary(node);
    if (pos === node.to && (pos !== doc.length || !edge.openEnded)) continue;
    if (node.name === "SchemeOpaque") return Object.freeze({ mode: "scheme", argumentRole: null, from: node.from, to: node.to, certainty: "unknown" });
    if (node.name === "UnknownMarkup") return Object.freeze({ mode: "markup", argumentRole: null, from: node.from, to: node.to, certainty: "unknown" });
    if (["SchemeAtom", "SchemeNumber", "LongSchemeAtom", "LongSchemeNumber"].includes(node.name)) return Object.freeze({ mode: "scheme", argumentRole: null, from: node.from, to: node.to, certainty: "exact" });
    if (node.name === "Property") argumentRole = "property";
    if (node.name === "Word" || node.name === "LongWord") uncertain = true;
    if (groups.has(node.name) && !group) group = node;
    const mode = node.name === "LineComment" || node.name === "BlockComment" ? "comment" : isString(node.name) ? node.name === "LyricString" ? "lyrics" : "string" :
      node.name === "MarkupCall" || node.name === "ModeExpression" && node.firstChild?.name === "MarkupCommand" ? "markup" : modeNames[node.name];
    // One ancestor walk: generic groups inherit the first explicit mode. Chord
    // structure does not itself switch figuremode back to pitched music.
    if (mode && !semantic) {
      const owner = modeNames[node.name] ? group || node : node;
      semantic = { mode, argumentRole: node.name === "PathString" ? "path" : node.name === "ConfigGroup" ? "property" : null,
        from: owner.from, to: owner.to, certainty: certaintyAt(tree, owner, budget) };
    }
  }
  if (node) return unknownContext(pos);
  if (!semantic && group) semantic = { mode: "music", argumentRole: null, from: group.from, to: group.to, certainty: certaintyAt(tree, group, budget) };
  if (semantic) return Object.freeze({ ...semantic, argumentRole: argumentRole || semantic.argumentRole, certainty: ["music", "chords"].includes(semantic.mode) && (uncertain || languageAt(tree, doc, pos, initialNoteLanguage) === "unknown") ? "unknown" : semantic.certainty });
  const preferred = tree.resolveInner(pos, bias), text = !preferred.type.isTop && preferred.from <= pos && pos < preferred.to ? preferred : !leaf.type.isTop && pos < leaf.to ? leaf : null;
  return Object.freeze({ mode: ["SchemeAtom", "SchemeNumber"].includes(text?.name) ? "scheme" : "music", argumentRole: text?.name === "Property" ? "property" : null,
    from: text?.from ?? pos, to: text?.to ?? pos, certainty: uncertain || languageAt(tree, doc, pos, initialNoteLanguage) === "unknown" ? "unknown" : text?.type.isError ? "recovered" : "exact" });
}
