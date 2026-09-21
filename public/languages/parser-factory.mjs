import { parser as tex } from "./latex/parser.mjs";
import { tokens, createTokens, createContext as texContext } from "./latex/tokens.mjs";
import { recoverySafeParser as texRecovery } from "./latex/reuse.mjs";
import { parser as ly } from "./lilypond/parser.mjs";
import { createContext as lyContext } from "./lilypond/tokens.mjs";
import { recoverySafeParser as lyRecovery } from "./lilypond/reuse.mjs";

// Pure grammar/token/context/recovery factory shared with the bundled Worker.
// Styling and CM Language data are added only by the main-thread adapters.
export function createParser(kind, options) {
  if (kind === "tex") return texRecovery(tex.configure(options.texProfile === "standard" ? {} : {
    tokenizers: [{ from: tokens, to: createTokens(options.texProfile) }], contextTracker: texContext(options.texProfile),
  }));
  if (kind === "ly") return lyRecovery(ly.configure({ contextTracker: lyContext(options.initialNoteLanguage) }));
  throw new RangeError("Unknown language kind");
}
