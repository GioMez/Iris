import { LRLanguage } from "@codemirror/language";
import { styleTags } from "@lezer/highlight";
import { syntaxTags as tags } from "../../iris-syntax-style.mjs";
import { parser } from "./parser.mjs";
import { tokens, createTokens, createContext } from "./tokens.mjs";
import { recoverySafeParser } from "./reuse.mjs";
import { summarize, summarySteps, contextAt } from "./queries.mjs";

const styled = recoverySafeParser(parser.configure({ props: [styleTags({
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
})] }));

export function createAdapter(options) {
  const language = LRLanguage.define({ name: "iris-tex", parser: options.texProfile === "standard" ? styled : styled.configure({
    tokenizers: [{ from: tokens, to: createTokens(options.texProfile) }], contextTracker: createContext(options.texProfile),
  }) });
  return Object.freeze({ kind: "tex", options, language, summarize, summarySteps, contextAt,
    // Intentionally conservative until HP07. No automatic edits in HP03.
    blockAtEnter: () => null,
    formatChanges: () => Object.freeze([]),
  });
}
