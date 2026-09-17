import { NodeType, Tree, TreeBuffer, TreeFragment } from "@lezer/common";
import { LRParser } from "@lezer/lr";
import * as terms from "./parser.terms.mjs";

// Cache only immutable trees, never documents. Effects are compositional and
// constant-size: no replay of leaves in ContextTracker.reuse. Definitions and
// language changes are deliberately not summarized as identity operations.
const views = new WeakMap();
const globalEffects = new Set(["Assignment", "Equals", "LanguageCommand", "IncludeCommand"]);
const scopes = new Set(["Group", "MusicGroup", "LyricsGroup", "MarkupGroup", "ChordsGroup", "DrumsGroup", "FiguresGroup", "ConfigGroup", "UnknownGroup", "Simultaneous", "Chord",
  "ModeExpression", "Block", "Context", "WithBlock", "Wrapper", "MarkupCall", "UnknownMarkup", "LongMarkupText", "MarkupNumberArgument", "NumericCommand"]);
const identity = Object.freeze({ name: null, nameValid: null, pending: null, defining: null, compound: null, modifier: null, language: null });
const clear = Object.freeze({ name: "", nameValid: false, pending: "clear", defining: false, compound: false, modifier: false, language: null });
const atom = Object.freeze({ name: "", nameValid: false, pending: "atom", defining: false, compound: null, modifier: null, language: "unknown" });
function effect(name, inner, length) {
  if (name === "SchemeExpression" || name === "MusicLiteral") return { ...clear, pending: "opaque" };
  if (["SchemeList", "SchemeTail", "SchemeVector", "SchemeQuote", "SchemeString", "SchemeComment", "SchemeLineComment", "SchemeBlockComment", "SchemeGuileComment", "SchemeDatumComment", "SchemeUnknown", "LongSchemeAtom", "LongSchemeNumber"].includes(name)) return identity;
  if (["SchemeAtom", "SchemeNumber", "SchemeDot", "SchemeSpace", "SchemeQuotedSpace", "SchemePart", "SchemeStringText", "SchemeStringEscape", "SchemeLineText", "SchemeBlockText", "SchemeGuileText", "SchemeUnknownText"].includes(name)) return identity;
  if (name === "TempoBeat") return { ...atom, pending: "tempo-equals" };
  if (name === "TempoSetting") return { ...clear, pending: "tempo-count" };
  if (scopes.has(name) || name === "LongWord" || name === "LongCommand") return clear;
  if (["LineComment", "BlockComment", "Articulation"].includes(name)) return identity;
  if (name === "Space") return { ...identity, modifier: false };
  if (["Pitch", "Rest", "Duration", "Number", "Command", "Variable", "Text", "MarkupText", "Lyric", "SchemeAtom", "SchemeNumber", "LongSchemeAtom", "LongSchemeNumber"].includes(name)) return atom;
  if (name === "Word") return { ...identity, name: { offset: 0 }, nameValid: true };
  if (["String", "LyricString", "PathString"].includes(name)) return { ...identity, pending: "clear", nameValid: true, name: { offset: 0, string: true, length: Math.max(0, length - 2) }, language: { offset: 0, string: true, length: Math.max(0, length - 2) } };
  // Leaf shifts remain bounded (<=256 units). They are never replayed for an
  // entire reused fragment: closed scopes and stable fields compose above.
  if (Object.hasOwn(terms, name)) return inner === undefined ? { ops: [{ name, offset: 0, length }] } : inner;
  return name === "Document" || !name ? inner : null;
}
function positioned(value, offset) {
  if (!value) return null;
  if (value.ops) return { ops: value.ops.map(op => ({ ...op, offset: op.offset + offset })) };
  const move = v => v && typeof v === "object" ? { ...v, offset: v.offset + offset } : v;
  return { ...value, name: move(value.name), language: move(value.language) };
}
function compose(a, b) {
  if (!a || !b) return null;
  if (a.ops || b.ops) {
    if (a === identity) return b;
    if (b === identity) return a;
    return a.ops && b.ops && a.ops.length + b.ops.length <= 16 ? { ops: [...a.ops, ...b.ops] } : null;
  }
  return { name: b.name ?? a.name, nameValid: b.nameValid ?? a.nameValid, defining: b.defining ?? a.defining, compound: b.compound ?? a.compound, modifier: b.modifier ?? a.modifier,
    pending: !b.pending ? a.pending : b.pending === "opaque" ? !a.pending || a.pending === "opaque" ? "opaque" : "clear" :
      b.pending === "atom" ? a.pending === "opaque" ? "clear" : a.pending || "atom" : b.pending,
    // The first directive-sensitive atom consumes that entry condition. A
    // clear disables later conditional string effects; no source replay needed.
    language: a.language || (a.pending && a.pending !== "atom" && a.pending !== "opaque" ? null : b.language) };
}
export function reuseEffect(tree) {
  const value = views.get(tree);
  if (!value?.effect || value.global || value.error) throw new Error(`Unprepared LilyPond fragment ${tree.type.name}/${tree.length}`);
  return value.effect;
}
function* fragmentView(root) {
  const make = tree => ({ tree, index: 0, children: [], error: false, global: false, changed: false, effect: identity });
  const stack = [make(root)];
  while (stack.length) {
    const f = stack.at(-1), tree = f.tree;
    if (!views.has(tree)) {
      if (tree instanceof TreeBuffer) {
        // Balanced buffers can contain several independent scopes. Postorder
        // aggregation accounts for global mutations even below a safe group.
        const frames = [];
        for (let i = 0; i < tree.buffer.length; i += 4) {
          while (frames.length && frames.at(-1).end <= i) {
            const child = frames.pop(), e = positioned(effect(child.name, child.child ? child.effect : undefined, child.length), child.from - (frames.at(-1)?.from || 0));
            if (frames.length) frames.at(-1).effect = compose(frames.at(-1).effect, e);
            else f.effect = compose(f.effect, e);
            yield;
          }
          const type = tree.set.types[tree.buffer[i]];
          f.error ||= type.isError; f.global ||= globalEffects.has(type.name);
          if (frames.length) frames.at(-1).child = true;
          frames.push({ name: type.name, end: tree.buffer[i + 3], from: tree.buffer[i + 1], length: tree.buffer[i + 2] - tree.buffer[i + 1], effect: identity, child: false });
          yield;
        }
        while (frames.length) {
          const child = frames.pop(), e = positioned(effect(child.name, child.child ? child.effect : undefined, child.length), child.from - (frames.at(-1)?.from || 0));
          if (frames.length) frames.at(-1).effect = compose(frames.at(-1).effect, e);
          else f.effect = compose(f.effect, e);
          yield;
        }
        views.set(tree, { tree, error: f.error, global: f.global, effect: f.effect });
      } else if (tree.type.isError) {
        views.set(tree, { tree: new Tree(NodeType.none, [], [], tree.length), error: true, global: false, effect: null });
      } else if (f.index < tree.children.length) {
        const child = tree.children[f.index], cached = views.get(child);
        if (!cached) stack.push(make(child));
        else {
          f.children.push(cached.tree); f.error ||= cached.error; f.global ||= cached.global; f.changed ||= child !== cached.tree;
          f.effect = compose(f.effect, positioned(cached.effect, tree.positions[f.index])); f.index++;
        }
        yield;
        continue;
      } else {
        const e = effect(tree.type.name, tree.children.length ? f.effect : undefined, tree.length), global = f.global || globalEffects.has(tree.type.name);
        const safe = !f.error && !f.changed && !global && !!e;
        const expose = !f.error || tree.type.isTop || tree.type.isAnonymous;
        views.set(tree, { tree: safe ? tree : new Tree(NodeType.none, expose ? f.children : [], expose ? tree.positions : [], tree.length), error: f.error, global, effect: e });
      }
    }
    stack.pop(); yield;
  }
  return views.get(root).tree;
}
function* prepare(fragments) {
  const result = [];
  for (const f of fragments) {
    const tree = yield* fragmentView(f.tree);
    result.push(tree === f.tree ? f : new TreeFragment(f.from, f.to, tree, f.offset, f.openStart, f.openEnd));
  }
  return result;
}
export function recoverySafeParser(parser) {
  const copy = parser.configure({});
  copy.createParse = function(input, fragments, ranges) {
    if (!fragments.length) return LRParser.prototype.createParse.call(this, input, fragments, ranges);
    const steps = prepare(fragments), owner = this;
    let parse = null, stoppedAt = null;
    return {
      get parsedPos() { return parse ? parse.parsedPos : ranges[0].from; },
      get stoppedAt() { return stoppedAt; },
      stopAt(pos) {
        if (stoppedAt !== null && pos > stoppedAt) throw new RangeError("Can't move stoppedAt forward");
        stoppedAt = pos; if (parse) parse.stopAt(pos);
      },
      advance() {
        if (parse) return parse.advance();
        for (let i = 0; i < 128; i++) {
          const step = steps.next();
          if (step.done) {
            parse = LRParser.prototype.createParse.call(owner, input, step.value, ranges);
            if (stoppedAt !== null) parse.stopAt(stoppedAt);
            break;
          }
        }
        return null;
      },
    };
  };
  return copy;
}
