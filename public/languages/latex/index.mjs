import { LRLanguage } from "@codemirror/language";
import { NodeProp } from "@lezer/common";
import { styleTags } from "@lezer/highlight";
import { syntaxTags as tags } from "../../iris-syntax-style.mjs";
import { createParser } from "../parser-factory.mjs";
import { summarize, summarySteps, contextAt } from "./queries.mjs";
import { blockAtEnter, formatChanges } from "./editing.mjs";

const props = [styleTags({
  "ControlWord! ControlSymbol CatalogCommand ProfileCommand BeginCommand EndCommand LiteralEndCommand": tags.command,
  HeadingCommand: tags.structure,
  "OpenBrace CloseBrace MathOpen MathClose OptionalOpen ArgumentOpen DefaultOpen OptionalClose ParameterDelimiter HeadingOpen TextOpen LabelOpen ReferenceOpen ReferenceListOpen CitationOpen PathOpen PathListOpen DefinitionOpen BodyOpen SpecOpen EnvOpen EnvClose EndClose OrphanClose": tags.delimiter,
  "EnvironmentName!": tags.environment,
  "DefinitionWord! DefinitionSymbol DefinitionText": tags.definition,
  ReferenceText: tags.reference,
  CitationText: tags.citation,
  PathText: tags.path,
  MathText: tags.math,
  Number: tags.number,
  Operator: tags.operator,
  Parameter: tags.variable,
  "LineComment!": tags.comment,
  "Verb! RejectedEnd! LiteralText LiteralSpace LiteralNewline": tags.literal,
}), NodeProp.closedBy.add({
  "OpenBrace HeadingOpen TextOpen LabelOpen ReferenceOpen ReferenceListOpen CitationOpen PathOpen PathListOpen DefinitionOpen BodyOpen SpecOpen": ["CloseBrace"],
  "OptionalOpen ArgumentOpen DefaultOpen": ["OptionalClose"],
  EnvOpen: ["EnvClose", "EndClose", "OrphanClose"],
}), NodeProp.openedBy.add({
  CloseBrace: ["OpenBrace", "HeadingOpen", "TextOpen", "LabelOpen", "ReferenceOpen", "ReferenceListOpen", "CitationOpen", "PathOpen", "PathListOpen", "DefinitionOpen", "BodyOpen", "SpecOpen"],
  OptionalClose: ["OptionalOpen", "ArgumentOpen", "DefaultOpen"],
  "EnvClose EndClose OrphanClose": ["EnvOpen"],
})];

export function createAdapter(options) {
  const language = LRLanguage.define({ name: "iris-tex", parser: createParser("tex", options).configure({ props }), languageData: { commentTokens: { line: "%" } } });
  return Object.freeze({ kind: "tex", options, language, summarize, summarySteps, contextAt, blockAtEnter, formatChanges });
}
