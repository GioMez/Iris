/* ===================== Iris · document structure ===================== */
// Turns the flat region lists produced by the language modules into a tree, and
// answers the one question the collaboration layer asks of it: are two people
// inside the same thing, or merely near each other in the file?
//
// Line proximity is a proxy for shared intent and it is wrong in both
// directions — two carets a line apart across a section boundary have nothing
// to do with each other, and two carets thirty lines apart inside the same
// environment have everything to do with each other. Containment answers it
// directly.
//
// This runs entirely in the browser, against the replica this tab already
// holds. The server never parses LaTeX or LilyPond — it compiles them by
// invoking external binaries — and presence stays what it is on the wire:
// ephemeral positions, with no structure attached.
(function () {
  // A region deeper than this is a nesting mistake, not a document.
  const MAX_DEPTH = 24;

  // Builds the nesting from a list sorted by start ascending, end descending.
  // Input can be malformed — unbalanced markup is exactly when people collide —
  // so a region that overruns its parent is clamped rather than rejected.
  function build(regions, length) {
    const root = { kind: "root", label: "", from: 0, to: length, children: [] };
    const stack = [root];
    regions.forEach((region) => {
      while (stack.length > 1 && region.from >= stack[stack.length - 1].to) stack.pop();
      const parent = stack[stack.length - 1];
      const node = {
        kind: region.kind,
        label: region.label || "",
        name: region.name || "",
        from: region.from,
        to: Math.min(region.to, parent.to),
        children: [],
      };
      if (node.to <= node.from || stack.length > MAX_DEPTH) return;
      parent.children.push(node);
      stack.push(node);
    });
    return root;
  }

  function index(text, kind) {
    const source = String(text == null ? "" : text);
    const language = kind === "ly" ? window.IrisLilyPond : window.IrisLatex;
    let regions = [];
    // A parser failing must cost the warning its precision, never the editor.
    try {
      regions = (language && typeof language.regions === "function") ? language.regions(source) : [];
    } catch (err) {
      console.error("Structure parsing failed", err);
      regions = [];
    }
    return { kind: kind || null, length: source.length, root: build(regions, source.length) };
  }

  // The last child starting at or before `offset`; the list is ordered, so the
  // search is a bisection rather than a scan.
  function childContaining(node, offset) {
    const children = node.children;
    let low = 0;
    let high = children.length - 1;
    let candidate = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (children[mid].from <= offset) {
        candidate = children[mid];
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return candidate && offset <= candidate.to ? candidate : null;
  }

  // The regions containing `offset`, outermost first. Empty when the position
  // sits in no region at all — a preamble, or a file with no structure — which
  // is the signal to fall back to line proximity.
  function pathAt(tree, offset) {
    const path = [];
    if (!tree || !tree.root || !Number.isFinite(offset)) return path;
    let node = tree.root;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const child = childContaining(node, offset);
      if (!child) break;
      path.push(child);
      node = child;
    }
    return path;
  }

  // The innermost region both paths pass through, and whether one of them is
  // inside the other at all. `contained` is the question that matters: two
  // people in sibling regions share an ancestor without sharing any work.
  function shared(a, b) {
    let depth = 0;
    while (depth < a.length && depth < b.length && a[depth] === b[depth]) depth += 1;
    return {
      node: depth > 0 ? a[depth - 1] : null,
      contained: depth > 0 && (depth === a.length || depth === b.length),
    };
  }

  window.IrisStructure = { index, pathAt, shared };
})();
