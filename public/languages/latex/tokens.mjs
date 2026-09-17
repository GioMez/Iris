import { ContextTracker, ExternalTokenizer } from "@lezer/lr";
import * as t from "./parser.terms.mjs";
import { headings } from "./catalog.mjs";

// Every consuming token is <=256 UTF-16 units, including pathological long words.
const limit = 256;
const letter = code => code >= 65 && code <= 90 || code >= 97 && code <= 122;
const space = code => code === 32 || code === 9 || code === 10 || code === 13;
function matches(input, text) {
  for (let i = 0; i < text.length; i++) if (input.peek(i) !== text.charCodeAt(i)) return false;
  return true;
}
function frame(parent, mode, end = "", from = -1, scope = mode) {
  let hash = parent ? parent.hash : 0;
  for (const char of scope + mode + end) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  // Absolute starts locate forced reductions, but do not belong in a reuse hash:
  // an unchanged subtree can move. Scope (including groups) DOES affect reuse.
  return Object.freeze({ parent, mode, end, from, scope, hash });
}
export function createContext(profile = "standard") {
  const base = frame(null, "text", profile);
  return new ContextTracker({
    start: base,
    shift(value, term, stack, input) {
      if (term === t.OpenBrace) return frame(value, value.mode, value.end, input.pos, "group");
      if (term === t.MathOpen) return frame(value, "math", input.next === 36 ? (input.peek(1) === 36 ? "$$" : "$") : (input.peek(1) === 40 ? "\\)" : "\\]"), input.pos);
      if (term === t.CommentStart) return frame(value, "comment", "", input.pos);
      if (term === t.VerbOpen) return frame(value, "verb", String.fromCharCode(input.peek(input.peek(5) === 42 ? 6 : 5)), input.pos);
      if (term === t.VerbatimOpen) return frame(value, "verbatim", "\\end{verbatim}", input.pos);
      if (term === t.CommandStart) return frame(value, "command", "", input.pos);
      const closed = term === t.CloseBrace ? "group" : term === t.MathClose ? "math" : term === t.CommentEnd ? "comment" : term === t.VerbClose || term === t.VerbBreak ? "verb" : term === t.VerbatimClose ? "verbatim" : term === t.CommandEnd ? "command" : null;
      if (closed === value.scope) return value.parent || base;
      return value;
    },
    reduce(value, term, stack, input) {
      // Recovery may complete a rule without shifting its closer, or abandon
      // nested scopes. Restore the lexical entry context before item repetitions
      // reduce/balance, so their siblings don't inherit a later damaged context.
      if ([t.Group, t.Math, t.LineComment, t.Verb, t.Verbatim, t.ControlWord].includes(term)) {
        while (value.parent && value.from >= input.pos) value = value.parent;
      }
      return value;
    },
    // Healthy complete rules and repetition chunks have no net context change.
    // reuse.mjs excludes recovered rules/ancestors, whose stored reduction hash
    // may be an interior context. Strict hashes guard the remaining candidates.
    hash: value => value.hash,
  });
}
export const context = createContext();

export function createTokens(profile = "standard") {
  const word = code => letter(code) || profile !== "standard" && code === 64 || profile === "expl3" && (code === 95 || code === 58);
  return new ExternalTokenizer((input, stack) => {
    const value = stack.context;
    const emit = (term, size) => { input.advance(size); input.acceptToken(term); };
    const chunk = (term, predicate) => {
      let size = 0;
      while (size < limit && input.next >= 0 && predicate(input.next)) { input.advance(); size++; }
      if (size) input.acceptToken(term);
    };
    // A comment ending at EOF is valid. This sole zero-width token changes
    // context and cannot repeat; all other tokens consume bounded input.
    if (input.next < 0) {
      if (value.mode === "comment" && stack.canShift(t.CommentEnd)) input.acceptToken(t.CommentEnd);
      return;
    }
    if (value.mode === "command") {
      let size = 0;
      while (size < limit && word(input.next)) { input.advance(); size++; }
      if (size) input.acceptToken(word(input.next) ? t.CommandPart : t.CommandEnd);
      return;
    }
    if (value.mode === "comment") {
      if (input.next === 10 || input.next === 13) return emit(t.CommentEnd, input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      return chunk(t.CommentText, code => code !== 10 && code !== 13);
    }
    if (value.mode === "verb" || value.mode === "verbatim") {
      if (matches(input, value.end)) return emit(value.mode === "verb" ? t.VerbClose : t.VerbatimClose, value.end.length);
      if (value.mode === "verb" && (input.next === 10 || input.next === 13)) return emit(t.VerbBreak, input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      return chunk(t.LiteralText, code => !matches(input, value.end) && !(value.mode === "verb" && (code === 10 || code === 13)));
    }
    if (value.mode === "math" && matches(input, value.end)) return emit(t.MathClose, value.end.length);
    if (input.next === 37) return emit(t.CommentStart, 1);
    if (input.next === 123) return emit(t.OpenBrace, 1);
    if (input.next === 125) return emit(t.CloseBrace, 1);
    if (space(input.next)) return chunk(t.Space, space);
    if (input.next === 36 && value.mode !== "math") return emit(t.MathOpen, input.peek(1) === 36 ? 2 : 1);
    if (input.next === 92) {
      if (matches(input, "\\begin{verbatim}")) return emit(t.VerbatimOpen, 16);
      if (matches(input, "\\verb") && !word(input.peek(5))) {
        const size = input.peek(5) === 42 ? 7 : 6, delimiter = input.peek(size - 1);
        if (delimiter >= 0 && !space(delimiter)) return emit(t.VerbOpen, size);
      }
      if (value.mode !== "math" && (input.peek(1) === 40 || input.peek(1) === 91)) return emit(t.MathOpen, 2);
      if (word(input.peek(1))) {
        for (const name of Object.keys(headings)) if (matches(input, `\\${name}`) && !word(input.peek(name.length + 1))) return emit(t.HeadingCommand, name.length + 1);
        return emit(t.CommandStart, 1);
      }
      return emit(t.ControlSymbol, input.peek(1) < 0 ? 1 : 2);
    }
    // A dollar belonging to another math pair is ordinary math content here.
    if (input.next === 36) return emit(t.Text, 1);
    return chunk(t.Text, code => !space(code) && ![36, 37, 92, 123, 125].includes(code));
  }, { contextual: true });
}
export const tokens = createTokens();
