import { contextAt } from "./queries.mjs";
import { enterPlan, indentationChanges } from "../../iris-language-editing.mjs";

function describe(node, doc) {
  if (node.name === "Environment" || node.name === "Verbatim") {
    const open = node.firstChild, end = open?.lastChild, name = end?.prevSibling;
    if (open?.name !== "Begin" || end?.name !== "EnvClose" || end.to === end.from || name?.name !== "EnvironmentName" || name.to - name.from > 64) return null;
    const literalOpen = node.name === "Verbatim";
    const closed = node.lastChild?.name === "EnvironmentClose", closer = literalOpen ? node.lastChild : closed ? node.lastChild.prevSibling : null;
    return { open, close: `\\end{${doc.sliceString(name.from, name.to)}}`, literalOpen,
      closingFrom: closer?.name === (literalOpen ? "LiteralEnd" : "End") ? closer.from : null };
  }
  return null;
}
const protectedNode = node => ["LineComment", "Verb", "Verbatim", "BodyGroup", "SpecGroup", "DefaultArgument"].includes(node.name);
export function blockAtEnter(tree, doc, pos) { return enterPlan(tree, doc, pos, describe, protectedNode, contextAt); }
export function formatChanges(tree, doc, range = null) {
  return indentationChanges(tree, doc, range, describe, protectedNode);
}
