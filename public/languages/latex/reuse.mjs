import { NodeType, Tree, TreeBuffer, TreeFragment } from "@lezer/common";
import { LRParser } from "@lezer/lr";

// Recovery reductions can end a scope without shifting its closer. Such nodes
// carry an interior context hash, not a reusable entry context. Hide them and
// their ancestors from the fragment cursor, retaining healthy sibling identities.
// This cache is weak, contains no source, and is shared across parser configs.
const views = new WeakMap();
function* fragmentView(root) {
  const stack = [{ tree: root, index: 0, children: [], error: false }];
  while (stack.length) {
    const frame = stack.at(-1), tree = frame.tree;
    if (!views.has(tree)) {
      if (tree instanceof TreeBuffer) {
        for (let i = 0; i < tree.buffer.length; i += 4) {
          if (tree.set.types[tree.buffer[i]].isError) { frame.error = true; break; }
          yield;
        }
        views.set(tree, { tree, error: frame.error });
      } else if (tree.type.isError) {
        views.set(tree, { tree: new Tree(NodeType.none, [], [], tree.length), error: true });
      } else if (frame.index < tree.children.length) {
        const child = tree.children[frame.index], cached = views.get(child);
        if (!cached) stack.push({ tree: child, index: 0, children: [], error: false });
        else { frame.children.push(cached.tree); frame.error ||= cached.error; frame.index++; }
        yield;
        continue;
      } else {
        // An entire recovered rule is conservative territory, including children
        // parsed under inserted/abandoned scopes. Only top/repetition containers
        // remain transparent so unaffected sibling rules can still be reused.
        const transparent = tree.type.isTop || tree.type.isAnonymous;
        views.set(tree, { tree: frame.error ? new Tree(NodeType.none, transparent ? frame.children : [], transparent ? tree.positions : [], tree.length) : tree, error: frame.error });
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
