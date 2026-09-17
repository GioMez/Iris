// Exact, incremental name identities. A name is a canonical binary forest of
// <=256-unit chunks, not an ever-growing string that must be hashed/flattened
// on each token. Append/equality visit O(log(chunks)) nodes. Weak interning lets
// live opening names share identities with matching closing names without
// retaining source from closed documents.
const leaves = new Map(), branches = new WeakMap();
const retired = new FinalizationRegistry(({ text, ref }) => {
  if (leaves.get(text) === ref) leaves.delete(text);
});
function leaf(text) {
  let value = leaves.get(text)?.deref();
  if (!value) {
    value = Object.freeze({ text });
    const ref = new WeakRef(value);
    leaves.set(text, ref); retired.register(value, { text, ref });
  }
  return value;
}
function branch(left, right) {
  let rights = branches.get(left);
  if (!rights) branches.set(left, rights = new WeakMap());
  let value = rights.get(right);
  if (!value) rights.set(right, value = Object.freeze({ left, right }));
  return value;
}
export const emptyName = Object.freeze({ length: 0, hash: 0, short: "", forest: Object.freeze([]) });
export function appendName(name, text) {
  const forest = name.forest.slice();
  let node = leaf(text), level = 0, hash = name.hash;
  while (forest[level]) { node = branch(forest[level], node); forest[level++] = null; }
  forest[level] = node;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return Object.freeze({ length: name.length + text.length, hash,
    short: name.length + text.length <= 64 ? name.short + text : null, forest: Object.freeze(forest) });
}
export function sameName(a, b) {
  if (!a || !b || a.length !== b.length || a.hash !== b.hash || a.forest.length !== b.forest.length) return false;
  return a.forest.every((node, i) => node === b.forest[i]);
}
