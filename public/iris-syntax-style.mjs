// Shared native-ESM tag identities. Foregrounds and weights live in iris.css.
import { Tag, tagHighlighter } from "@lezer/highlight";
import { syntaxHighlighting } from "@codemirror/language";

const roles = ["command", "structure", "environment", "context", "definition", "variable",
  "reference", "citation", "path", "string", "literal", "lyric", "math", "pitch", "number",
  "duration", "rest", "operator", "articulation", "comment", "delimiter", "property", "scheme"];
export const syntaxTags = Object.freeze(Object.fromEntries(roles.map(role => [role, Tag.define()])));
const compatibilityClasses = { command: "t-cmd", environment: "t-env", delimiter: "t-brace", operator: "t-special" };
export const syntaxClasses = Object.freeze(Object.fromEntries(roles.map(role =>
  [role, `t-${role}${compatibilityClasses[role] ? ` ${compatibilityClasses[role]}` : ""}`])));

// TeX/LilyPond stream names. Plain text inherits --syntax-text without a tag.
export const legacyTokenTable = Object.freeze({
  cmd: syntaxTags.command, env: syntaxTags.environment, brace: syntaxTags.delimiter,
  math: syntaxTags.math, comment: syntaxTags.comment, special: syntaxTags.operator, string: syntaxTags.string,
});

// Bibliography has its own meaning and historical paint, including shared names.
const bibliographyClasses = {
  entryType: "t-bib-entry-type t-cmd", key: "t-bib-key t-env", field: "t-bib-field t-special",
  value: "t-bib-value t-math", comment: "t-bib-comment t-comment",
  brace: "t-bib-delimiter t-brace", special: "t-bib-operator t-special",
};
export const bibliographyTokenTable = Object.freeze(Object.fromEntries(
  Object.keys(bibliographyClasses).map(name => [name, Tag.define()])));
// Semantic consumers receive bare source roles, independent of CSS aliases.
export const roleHighlighter = tagHighlighter(roles.map(role => ({ tag: syntaxTags[role], class: role })));

// Rendering uses a separate mapper, including bibliography compatibility paint.
export const cssHighlighter = tagHighlighter([
  ...roles.map(role => ({ tag: syntaxTags[role], class: syntaxClasses[role] })),
  ...Object.entries(bibliographyClasses).map(([name, className]) => ({ tag: bibliographyTokenTable[name], class: className })),
]);
export const syntaxExtension = syntaxHighlighting(cssHighlighter);
