import { Tree, TreeBuffer, NodeType, NodeProp } from "@lezer/common";

export const WORKER_PROTOCOL = 1;
// Numeric NodeProp IDs are process-local. Only named, supported dynamic props
// travel on the wire. Styling/bracket/language props come from the local NodeSet.
const properties = { contextHash: NodeProp.contextHash, lookAhead: NodeProp.lookAhead };
const propertyNames = new Map(Object.entries(properties).map(([name, prop]) => [prop.id, name]));

export function* encodeTree(root, ids, retained = new Set()) {
  const idOf = tree => {
    let id = ids.get(tree);
    if (!id) { id = (ids.nextID || 0) + 1; ids.nextID = id; ids.set(tree, id); }
    return id;
  };
  const stack = [{ tree: root, child: 0 }], emitted = new Set();
  while (stack.length) {
    const frame = stack.at(-1), tree = frame.tree, id = idOf(tree);
    if (emitted.has(id)) { stack.pop(); continue; }
    if (retained.has(id)) {
      emitted.add(id); stack.pop(); yield { id, reuse: true }; continue;
    }
    if (tree instanceof TreeBuffer) {
      emitted.add(id); stack.pop();
      // Never detach an incremental/history tree's own buffer.
      yield { id, length: tree.length, buffer: tree.buffer.slice() };
    } else if (frame.child < tree.children.length) {
      stack.push({ tree: tree.children[frame.child++], child: 0 });
    } else {
      const props = tree.propValues.map(([key, value]) => {
        const name = propertyNames.get(key);
        if (!name) throw new Error(`Unsupported tree property ${key}`);
        return [name, value];
      });
      emitted.add(id); stack.pop();
      yield { id, type: tree.type === NodeType.none ? -1 : tree.type.id, length: tree.length,
        children: tree.children.map(idOf), positions: tree.positions, props };
    }
  }
}

const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
export function* decodeRecord(record, set, nodes, retained = new Map()) {
  if (!integer(record.id) || !record.id || nodes.has(record.id)) throw new Error("Invalid tree identity");
  if (record.reuse) {
    const tree = retained.get(record.id);
    if (!tree) throw new Error("Missing retained tree reference");
    nodes.set(record.id, tree); return;
  }
  if (!integer(record.length, 1048576)) throw new Error("Invalid tree length");
  if (record.buffer) {
    const buffer = record.buffer;
    if (!(buffer instanceof Uint16Array) || buffer.length % 4) throw new Error("Invalid compact buffer");
    for (let i = 0; i < buffer.length; i += 4) {
      if (!set.types[buffer[i]] || buffer[i + 1] > buffer[i + 2] || buffer[i + 2] > record.length ||
        buffer[i + 3] <= i || buffer[i + 3] > buffer.length || buffer[i + 3] % 4) throw new Error("Invalid compact node range");
      yield;
    }
    nodes.set(record.id, new TreeBuffer(buffer, record.length, set));
  } else {
    const type = record.type === -1 ? NodeType.none : set.types[record.type];
    if (!type || !Array.isArray(record.children) || record.children.length !== record.positions?.length) throw new Error("Invalid tree type/children");
    const children = [];
    for (let i = 0; i < record.children.length; i++) {
      const child = nodes.get(record.children[i]);
      if (!child || !integer(record.positions[i], record.length) || record.positions[i] + child.length > record.length) throw new Error("Invalid tree child reference/range");
      children.push(child); yield;
    }
    const props = record.props.map(([name, value]) => {
      if (!properties[name] || !Number.isFinite(value)) throw new Error("Invalid tree property");
      return [properties[name], value];
    });
    nodes.set(record.id, new Tree(type, children, record.positions, record.length, props));
  }
}
