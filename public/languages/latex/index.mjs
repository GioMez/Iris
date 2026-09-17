import { LRLanguage } from "@codemirror/language";
import { styleTags } from "@lezer/highlight";
import { syntaxTags as tags } from "../../iris-syntax-style.mjs";
import { parser } from "./parser.mjs";
import { tokens, createTokens, createContext } from "./tokens.mjs";
import { recoverySafeParser } from "./reuse.mjs";
import { summarize, summarySteps, contextAt } from "./queries.mjs";

const styled = recoverySafeParser(parser.configure({ props: [styleTags({
  "ControlWord! ControlSymbol": tags.command,
  HeadingCommand: tags.structure,
  "OpenBrace CloseBrace MathOpen MathClose": tags.delimiter,
  "Math/...": tags.math,
  "LineComment!": tags.comment,
  "Verb! Verbatim!": tags.literal,
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
