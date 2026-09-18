import { contextAt } from "./queries.mjs";
import { enterPlan, indentationChanges } from "../../iris-language-editing.mjs";

const braces = new Set(["Group", "MusicGroup", "LyricsGroup", "MarkupGroup", "ChordsGroup", "DrumsGroup", "FiguresGroup", "ConfigGroup"]);
function describe(node) {
  const close = braces.has(node.name) ? "}" : node.name === "Simultaneous" ? ">>" : node.name === "MusicLiteral" ? "#}" : null;
  if (!close || !node.firstChild || node.firstChild.type.isError) return null;
  const expected = close === "}" ? "CloseBrace" : close === ">>" ? "SimClose" : "MusicLiteralClose", last = node.lastChild;
  return { open: node.firstChild, close, closingFrom: last?.name === expected && last.to > last.from ? last.from : null };
}
const protectedNode = node => ["String", "LyricString", "PathString", "LineComment", "BlockComment", "SchemeComment", "SchemeString", "SchemeDatumComment", "SchemeUnknown", "UnknownMarkup", "UnknownGroup"].includes(node.name);
export function blockAtEnter(tree, doc, pos) { return enterPlan(tree, doc, pos, describe, protectedNode, contextAt); }
export function formatChanges(tree, doc, range = null) {
  return indentationChanges(tree, doc, range, describe, node => protectedNode(node) || node.name === "SchemeExpression");
}
