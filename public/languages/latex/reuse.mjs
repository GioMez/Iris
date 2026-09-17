import { NodeType, Tree, TreeBuffer, TreeFragment } from "@lezer/common";
import { LRParser } from "@lezer/lr";

// Recovery reductions can end a scope without shifting its closer. Such nodes
// carry an interior context hash, not a reusable entry context. Hide them and
// their ancestors from the fragment cursor, retaining healthy sibling identities.
// This cache is weak, contains no source, and is shared across parser configs.
const views = new WeakMap();
// Preparation computes small compositional effects while it checks recovery.
// Unsupported effects hide only that candidate, leaving healthy descendants
// eligible. Recovery still hides the entire damaged named scope (HP03).
const contextual = new Set(["MissingEnd", "OrphanClose", "RejectedEnd"]);
const unsafe = type => type.isError || contextual.has(type.name);
const identity = Object.freeze({ pending: [], profile: true, line: [0, 1, 2], toggle: null });
const effect = (pending = [], line = [0, 1, 2], profile = true, toggle = null) => ({ pending, profile, line, toggle });
const clear = effect(["clear"]), cancel = effect(["cancel"]), unsupported = effect(null, [0, 1, 2], false);
function ownEffect(name) {
  if (["Group", "OptionalGroup", "HeadingGroup", "TextGroup", "LabelGroup", "ReferenceGroup", "ReferenceListGroup", "CitationGroup", "PathGroup", "PathListGroup"].includes(name)) return effect(["clear"], [2, 2, 2]);
  if (["Environment", "Verbatim", "Math", "Verb"].includes(name)) return clear;
  if (["DefinitionGroup", "BodyGroup", "SpecGroup"].includes(name)) return effect(["required"], [2, 2, 2]);
  if (["DefinitionWord", "DefinitionSymbol"].includes(name)) return effect(["required"]);
  if (["OptionalArgument", "DefaultArgument"].includes(name)) return effect(["optional"], [2, 2, 2]);
  if (name === "LineComment") return null;
  if (name === "Space" || name === "Parameter") return identity;
  if (name === "LiteralText") return effect([], [2, 2, 2]);
  if (name === "LiteralSpace" || name === "LiteralHeaderSpace") return effect([], [1, 1, 2]);
  if (name === "LiteralNewline" || name === "LiteralHeaderNewline" || name === "HeaderCommentEnd") return effect([], [0, 0, 0]);
  if (["CatalogCommand", "HeadingCommand"].includes(name)) return effect([{ signature: 0 }]);
  if (name === "ProfileCommand") return effect(["clear"], [0, 1, 2], true, 0);
  if (["ControlWord", "ControlSymbol", "Text", "MathText", "Number", "Operator", "ReferenceText", "CitationText", "PathText", "DefinitionText", "ParameterDelimiter"].includes(name)) return cancel;
  if (["Begin", "End", "EnvironmentName", "NameChunk", "LiteralEndHeader", "LiteralEnd", "RejectedEnd"].includes(name)) return unsupported;
  return name === "Document" || !name ? null : identity;
}
function positioned(value, offset) {
  return effect(value.pending?.map(op => typeof op === "object" ? { signature: op.signature + offset } : op) ?? null,
    value.line, value.profile, value.toggle === null ? null : value.toggle + offset);
}
function compose(a, b) {
  let pending = a.pending;
  if (!b.pending) pending = null;
  else for (const op of b.pending) {
    if (op === "clear" || typeof op === "object") pending = [op];
    else if (pending && pending.at(-1) !== "clear" && !(op === "cancel" && pending.at(-1) === op)) {
      pending = pending.length < 16 ? [...pending, op] : null;
    }
  }
  return effect(pending, a.line.map(value => b.line[value]), a.profile && b.profile, b.toggle ?? a.toggle);
}
export function reuseEffect(tree) {
  const value = views.get(tree)?.effect;
  if (!value?.profile || !value.pending) throw new Error(`Unprepared contextual fragment ${tree.type.name}/${tree.length}: ${JSON.stringify(value)}`);
  return value;
}
function* fragmentView(root) {
  const make = tree => ({ tree, index: 0, children: [], error: false, changed: false, effect: identity });
  const stack = [make(root)];
  while (stack.length) {
    const frame = stack.at(-1), tree = frame.tree;
    if (!views.has(tree)) {
      if (tree instanceof TreeBuffer) {
        let skipTo = 0;
        for (let i = 0; i < tree.buffer.length; i += 4) {
          const type = tree.set.types[tree.buffer[i]];
          if (unsafe(type)) frame.error = true;
          if (i >= skipTo) {
            const own = ownEffect(type.name);
            if (own) { frame.effect = compose(frame.effect, positioned(own, tree.buffer[i + 1])); skipTo = tree.buffer[i + 3]; }
          }
          yield;
        }
        views.set(tree, { tree, error: frame.error, effect: frame.effect });
      } else if (unsafe(tree.type)) {
        views.set(tree, { tree: new Tree(NodeType.none, [], [], tree.length), error: true, effect: unsupported });
      } else if (frame.index < tree.children.length) {
        const child = tree.children[frame.index], cached = views.get(child);
        if (!cached) stack.push(make(child));
        else {
          frame.children.push(cached.tree); frame.error ||= cached.error; frame.changed ||= cached.tree !== child;
          frame.effect = compose(frame.effect, positioned(cached.effect, tree.positions[frame.index])); frame.index++;
        }
        yield;
        continue;
      } else {
        // An entire recovered rule is conservative territory, including children
        // parsed under inserted/abandoned scopes. Only top/repetition containers
        // remain transparent so unaffected sibling rules can still be reused.
        const transparent = tree.type.isTop || tree.type.isAnonymous;
        const effect = ownEffect(tree.type.name) || frame.effect;
        const reusable = !frame.error && !frame.changed && effect.profile && effect.pending;
        const expose = !frame.error || transparent;
        views.set(tree, { tree: reusable ? tree : new Tree(NodeType.none, expose ? frame.children : [], expose ? tree.positions : [], tree.length), error: frame.error, effect });
      }
    }
    stack.pop();
    yield;
  }
  return views.get(root).tree;
}

function* safeFragments(fragments) {
  const result = [];
  for (const fragment of fragments) {
    const tree = yield* fragmentView(fragment.tree);
    result.push(tree === fragment.tree ? fragment : new TreeFragment(fragment.from, fragment.to, tree, fragment.offset, fragment.openStart, fragment.openEnd));
  }
  return result;
}

/** A per-instance public createParse hook, preserved by pinned LRParser.configure.
 * Use the current receiver (not a captured parser), so later props/tokenizers/
 * dialects and CodeMirror language data still apply. No library/global changes.
 */
export function recoverySafeParser(parser) {
  const copy = parser.configure({});
  copy.createParse = function(input, fragments, ranges) {
    if (!fragments.length) return LRParser.prototype.createParse.call(this, input, fragments, ranges);
    const prepare = safeFragments(fragments), owner = this;
    let parse = null, stoppedAt = null;
    return {
      get parsedPos() { return parse ? parse.parsedPos : ranges[0].from; },
      get stoppedAt() { return stoppedAt; },
      stopAt(pos) {
        if (stoppedAt !== null && pos > stoppedAt) throw new RangeError("Can't move stoppedAt forward");
        stoppedAt = pos;
        if (parse) parse.stopAt(pos);
      },
      advance() {
        if (parse) return parse.advance();
        // Bound preflight work too; do not synchronously scan a whole old tree
        // when startParse/ensureSyntaxTree is called after an edit.
        for (let i = 0; i < 128; i++) {
          const step = prepare.next();
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
