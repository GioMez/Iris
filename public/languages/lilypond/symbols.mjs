// Persistent radix trie. At most 128 UTF-16 units per invocable name, four
// 4-bit steps per unit; copying a branch copies at most sixteen entries.
// Longer/compound names remain outline-only, with no guessed invocation.
const hashNode = (children, end) => {
  let hash = end ? 1 : 0;
  for (let i = 0; i < 16; i++) hash = (Math.imul(hash, 31) + (children[i]?.hash || 0)) | 0;
  return hash;
};
export function hasSymbol(root, name) {
  if (!name || name.length > 128) return false;
  for (let i = 0; root && i < name.length * 4; i++) root = root.children[(name.charCodeAt(i >> 2) >> ((3 - (i & 3)) * 4)) & 15];
  return !!root?.end;
}
export function addSymbol(root, name) {
  if (!name || name.length > 128 || hasSymbol(root, name)) return root;
  const path = [];
  let node = root;
  for (let i = 0; i < name.length * 4; i++) {
    const key = (name.charCodeAt(i >> 2) >> ((3 - (i & 3)) * 4)) & 15;
    path.push([node, key]); node = node?.children[key];
  }
  const make = (children, end) => Object.freeze({ children: Object.freeze(children), end, hash: hashNode(children, end) });
  node = make(node?.children || [], true);
  for (let i = path.length - 1; i >= 0; i--) {
    const [parent, key] = path[i], children = parent ? parent.children.slice() : [];
    children[key] = node; node = make(children, !!parent?.end);
  }
  return node;
}
