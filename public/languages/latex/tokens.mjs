import { ContextTracker, ExternalTokenizer } from "@lezer/lr";
import * as t from "./parser.terms.mjs";
import { commandSignatures, profileCommands, mathEnvironments, literalEnvironments } from "./catalog.mjs";
import { emptyName, appendName, sameName } from "./names.mjs";
import { reuseEffect } from "./reuse.mjs";

const limit = 256;
const space = code => code === 32 || code === 9 || code === 10 || code === 13;
const digit = code => code >= 48 && code <= 57;
const letter = code => code >= 0 && /\p{L}/u.test(String.fromCodePoint(code));
const word = (code, profile) => letter(code) || profile !== "standard" && code === 64 || profile === "expl3" && (code === 95 || code === 58);
function point(input, offset = 0) {
  const first = input.peek(offset), second = input.peek(offset + 1);
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? (first - 0xd800) * 1024 + second - 0xdc00 + 0x10000 : first;
}
const wordAt = (input, offset, profile) => word(point(input, offset), profile);
function matches(input, text, offset = 0) {
  for (let i = 0; i < text.length; i++) if (input.peek(offset + i) !== text.charCodeAt(i)) return false;
  return true;
}
const nameChar = code => code >= 0 && ![123, 125, 92, 37, 10, 13].includes(code);
const commandPrefixes = { children: new Map(), name: null };
for (const name of Object.keys(commandSignatures)) {
  let node = commandPrefixes;
  for (const character of name) {
    const code = character.charCodeAt(0);
    if (!node.children.has(code)) node.children.set(code, { children: new Map(), name: null });
    node = node.children.get(code);
  }
  node.name = name;
}
function commandAt(input, profile) {
  // Catalog lookup follows only the candidate prefix. Unknown words still use
  // the ordinary unbounded/chunked control-word grammar, with no name cutoff.
  if (input.peek(0) !== 92) return null;
  let node = commandPrefixes;
  for (let offset = 1; (node = node.children.get(input.peek(offset))); offset++) {
    if (node.name && !wordAt(input, offset + 1, profile)) return node.name;
  }
  return null;
}
const contextKeys = new Map();
function state(parent, fields) {
  const value = { parent, mode: parent?.mode || "text", end: "", from: -1, scope: "root", profile: parent?.profile || "standard", role: parent?.role || null,
    deferred: parent?.deferred || false, pending: null, env: null, literal: false, direction: null, linePrefix: 2,
    name: emptyName, awaitingBody: false, closing: null, ...fields };
  value.hash = contextHash(value);
  return Object.freeze(value);
}
function contextHash(value) {
  const key = [value.scope, value.mode, value.end, value.profile, value.role, value.deferred, value.env?.hash, value.env?.length, value.literal, value.direction,
    value.pending?.name, value.pending?.index, value.linePrefix, value.name.hash, value.name.length, value.awaitingBody, value.closing?.name.hash, value.closing?.name.length].join("|");
  let part = contextKeys.get(key);
  if (!part) {
    let hash = 0, factor = 1;
    for (let i = 0; i < key.length; i++) { hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0; factor = Math.imul(factor, 31); }
    part = { hash, factor };
    // Bounded scalar keys, not contexts, trees, source text or long names.
    if (contextKeys.size === 128) contextKeys.delete(contextKeys.keys().next().value);
    contextKeys.set(key, part);
  }
  // Exactly the original polynomial hash, including the parent's hash seed.
  return (Math.imul(value.parent?.hash || 0, part.factor) + part.hash) | 0;
}
function replace(value, fields) {
  let changed = false;
  for (const key in fields) if (fields[key] !== value[key]) { changed = true; break; }
  if (!changed) return value;
  const next = { ...value, ...fields };
  next.hash = contextHash(next);
  return Object.freeze(next);
}
function argument(value, optional) {
  const pending = value.pending;
  if (!pending) return null;
  const signature = commandSignatures[pending.name] || literalEnvironments[pending.name];
  let index = pending.index;
  if (!optional) while (signature.args[index]?.startsWith("?")) index++;
  const role = signature.args[index];
  if (!role || optional !== role.startsWith("?")) return null;
  return { role: role.replace(/^\?/, ""), pending: index + 1 < signature.args.length ? { name: pending.name, index: index + 1 } : null };
}
const parameterText = value => commandSignatures[value.pending?.name]?.parameters && argument(value, false)?.role === "body";
function parentContext(value, base) {
  const parent = value.parent || base;
  return value.closing ? replace(parent, { closing: value.closing }) : parent;
}
function matchingEnvironment(value, name) {
  for (let current = value; current; current = current.parent) if (current.scope === "environment" && sameName(current.env, name)) return current;
  return null;
}
const opens = () => new Map([[t.OpenBrace, null], [t.OptionalOpen, "optional"], [t.ArgumentOpen, "optional"], [t.DefaultOpen, "optional"], [t.HeadingOpen, "heading"], [t.TextOpen, "text"], [t.ReferenceOpen, "reference"],
  [t.LabelOpen, "label"], [t.ReferenceListOpen, "reference-list"], [t.PathListOpen, "path-list"], [t.CitationOpen, "citation-list"], [t.PathOpen, "path"], [t.DefinitionOpen, "definition"], [t.BodyOpen, "body"], [t.SpecOpen, "spec"]]);
export function createContext(profile = "standard") {
  const base = state(null, { profile }), groupOpen = opens();
  const spec = {
    start: base,
    shift(value, term, stack, input) {
      if (groupOpen.has(term)) {
        const optional = [t.OptionalOpen, t.ArgumentOpen, t.DefaultOpen].includes(term);
        const arg = argument(value, optional), role = arg?.role || value.role;
        const parent = replace(value, { pending: arg?.pending || null });
        return state(parent, { mode: arg ? "text" : value.mode, scope: optional ? "optional" : "group", from: input.pos,
          role, deferred: value.deferred || role === "body" || role === "spec" || role === "default", end: value.end });
      }
      if ([t.HeadingCommand, t.CatalogCommand, t.ProfileCommand].includes(term)) {
        const name = commandAt(input, value.profile), signature = commandSignatures[name];
        return replace(value, { pending: signature?.args.length ? { name, index: 0 } : null,
          profile: !value.deferred && profileCommands[name] || value.profile });
      }
      if (term === t.BeginCommand) {
        const env = state(replace(value, { pending: null }), { scope: "environment", from: input.pos, env: emptyName, role: null });
        return state(env, { scope: "header", mode: "header", from: input.pos, direction: "begin" });
      }
      if (term === t.EndCommand || term === t.LiteralEndCommand) return state(value, { scope: "header", mode: "header", from: input.pos, direction: term === t.EndCommand ? "end" : "literal-end" });
      if (term === t.EnvOpen) return replace(value, { mode: "header-name" });
      if (term === t.NameChunk) {
        let text = "";
        for (let i = 0; i < limit && nameChar(input.peek(i)); i++) text += String.fromCharCode(input.peek(i));
        return replace(value, { name: appendName(value.name, text) });
      }
      if (term === t.EnvClose) {
        const parent = value.parent || base;
        if (value.direction === "literal-end") return replace(parent, { mode: "literal-tail" });
        const literal = !!literalEnvironments[value.name.short];
        return replace(parent, { env: value.name, literal, awaitingBody: true,
          mode: literal ? "text" : mathEnvironments.has(value.name.short) ? "math" : parent.mode,
          pending: literal && literalEnvironments[value.name.short].args.length ? { name: value.name.short, index: 0 } : null });
      }
      if (term === t.EndClose || term === t.OrphanClose) {
        const parent = value.parent || base;
        return term === t.EndClose ? replace(parent, { closing: { name: value.name, from: value.from } }) : parent;
      }
      if (term === t.BodyStart || term === t.LiteralHeaderStart) return replace(value, { awaitingBody: false });
      if (term === t.MissingEnd) {
        while (value.parent && value.scope !== "environment") value = value.parent;
        return parentContext(value, base);
      }
      if (term === t.EnvironmentClose) {
        while (value.parent && value.scope !== "environment") value = value.parent;
        return value.parent || base;
      }
      if (term === t.LiteralEndLine) return value.parent || base;
      if (term === t.LiteralRejected) return replace(value, { mode: "literal", linePrefix: 2 });
      if (term === t.LiteralStart) return replace(value, { mode: "literal", pending: null });
      if (term === t.LiteralHeaderNewline) return replace(value, { linePrefix: 0 });
      if (term === t.LiteralHeaderSpace) return replace(value, { linePrefix: value.linePrefix === 2 ? 2 : 1 });
      if (value.mode === "literal") {
        if (term === t.LiteralNewline) return replace(value, { linePrefix: 0 });
        if (term === t.LiteralSpace) return replace(value, { linePrefix: value.linePrefix === 2 ? 2 : 1 });
        if (term === t.LiteralText) return replace(value, { linePrefix: 2 });
      }
      if (term === t.MathOpen) return state(replace(value, { pending: null }), { mode: "math", scope: "math", role: null,
        end: input.next === 36 ? (input.peek(1) === 36 ? "$$" : "$") : (input.peek(1) === 40 ? "\\)" : "\\]"), from: input.pos });
      if (term === t.CommentStart) return state(value, { mode: "comment", scope: "comment", from: input.pos });
      if (term === t.VerbOpen) return state(replace(value, { pending: null }), { mode: "verb", scope: "verb", end: String.fromCharCode(input.peek(input.peek(5) === 42 ? 6 : 5)), from: input.pos });
      if (term === t.CommandStart || term === t.DefinitionStart) {
        const arg = term === t.DefinitionStart && argument(value, false);
        return state(replace(value, { pending: arg?.pending || (parameterText(value) ? value.pending : null) }), { mode: "command", scope: "command", from: input.pos });
      }
      if (term === t.DefinitionSymbol) return replace(value, { pending: argument(value, false)?.pending || null });
      const closed = term === t.CloseBrace ? "group" : term === t.OptionalClose ? "optional" : term === t.MathClose ? "math" : term === t.CommentEnd || term === t.HeaderCommentEnd ? "comment" : term === t.VerbClose || term === t.VerbBreak ? "verb" : term === t.CommandEnd ? "command" : null;
      if (closed === value.scope) {
        const parent = parentContext(value, base);
        if (term === t.HeaderCommentEnd) return replace(parent, { linePrefix: 0 });
        return (term === t.CloseBrace || term === t.OptionalClose) && parent.literal && parent.scope === "environment" ? replace(parent, { linePrefix: 2 }) : parent;
      }
      // Spaces/comments preserve an argument signature. TeX def's parameter text
      // also precedes its body; unrelated ordinary content cancels other arities.
      if (value.pending && ![t.Space, t.Parameter].includes(term) && !commandSignatures[value.pending.name]?.parameters) return replace(value, { pending: null });
      return value;
    },
    reduce(value, term, stack, input) {
      // Preserve HP03's restoration at forced reductions (including recovery).
      if ([t.Group, t.OptionalGroup, t.OptionalArgument, t.DefaultArgument, t.HeadingGroup, t.TextGroup, t.LabelGroup, t.ReferenceGroup, t.ReferenceListGroup, t.CitationGroup, t.PathGroup, t.PathListGroup, t.DefinitionGroup, t.BodyGroup, t.SpecGroup,
        t.Math, t.Environment, t.LineComment, t.Verb, t.Verbatim, t.ControlWord, t.DefinitionWord, t.End, t.MatchedEnd].includes(term)) {
        while (value.parent && value.from >= input.pos) value = parentContext(value, base);
      }
      return value;
    },
    reuse(value, tree, stack, input) {
      // Prepared cooperatively by reuse.mjs. At most 16 scalar operations, even
      // for the first reuse of a document-sized group. Never replay tree leaves.
      const effect = reuseEffect(tree);
      for (const operation of effect.pending) {
        if (typeof operation === "object") {
          const name = commandAt({ peek: offset => input.peek(operation.signature + offset) }, value.profile);
          value = replace(value, { pending: commandSignatures[name]?.args.length ? { name, index: 0 } : null });
        } else if (operation === "clear" || operation === "cancel" && !parameterText(value)) value = replace(value, { pending: null });
        else if (operation === "required" || operation === "optional") value = replace(value, { pending: argument(value, operation === "optional")?.pending || null });
      }
      if (effect.toggle !== null && !value.deferred) {
        const name = commandAt({ peek: offset => input.peek(effect.toggle + offset) }, value.profile);
        value = replace(value, { profile: profileCommands[name] || value.profile });
      }
      return replace(value, { linePrefix: effect.line[value.linePrefix] });
    },
    hash: value => value.hash,
  };
  return new ContextTracker(spec);
}
export const context = createContext();

function literalClose(input, value) {
  const closer = "\\end{" + value.env.short + "}";
  if (!matches(input, closer)) return false;
  const line = literalEnvironments[value.env.short].line;
  return !line || (line === "exact" ? value.linePrefix === 0 : value.linePrefix !== 2);
}
export function createTokens() {
  return new ExternalTokenizer((input, stack) => {
    const value = stack.context;
    const emit = (term, size) => { input.advance(size); input.acceptToken(term); };
    const chunk = (term, predicate) => {
      let size = 0;
      while (size < limit && input.next >= 0 && predicate(input.next)) { input.advance(); size++; }
      if (size) input.acceptToken(term);
    };
    if (value.closing) {
      let nearest = value;
      while (nearest.parent && nearest.scope !== "environment") nearest = nearest.parent;
      return emit(sameName(nearest.env, value.closing.name) ? t.EnvironmentClose : t.MissingEnd, 0);
    }
    if (value.awaitingBody) return emit(value.literal ? t.LiteralHeaderStart : t.BodyStart, 0);
    if (value.mode === "literal-tail") {
      const line = literalEnvironments[value.env.short].line;
      if (!line || input.next < 0 || input.next === 10 || input.next === 13) return emit(t.LiteralEndLine, 0);
      if (line !== "exact" && (input.next === 32 || input.next === 9)) return chunk(t.LiteralEndSpace, code => code === 32 || code === 9);
      return emit(t.LiteralRejected, 0);
    }
    // Zero-width transitions always change context/rule, so cannot loop.
    if (input.next < 0) {
      if (value.mode === "comment" && stack.canShift(t.CommentEnd)) input.acceptToken(t.CommentEnd);
      if (value.literal && value.mode !== "literal" && stack.canShift(t.LiteralStart)) input.acceptToken(t.LiteralStart);
      return;
    }
    if (value.mode === "header") {
      if (space(input.next)) return chunk(t.HeaderSpace, space);
      if (input.next === 37 && value.direction !== "literal-end") return emit(t.CommentStart, 1);
      if (input.next === 123) return emit(t.EnvOpen, 1);
      return;
    }
    if (value.mode === "header-name") {
      if (input.next === 125) return emit(value.direction === "end" ? matchingEnvironment(value.parent, value.name) ? t.EndClose : t.OrphanClose : t.EnvClose, 1);
      return chunk(t.NameChunk, nameChar);
    }
    if (value.mode === "command") {
      let size = 0;
      while (size < limit && wordAt(input, 0, value.profile)) {
        const width = point(input) > 0xffff ? 2 : 1;
        if (size + width > limit) break;
        input.advance(width); size += width;
      }
      if (size) input.acceptToken(wordAt(input, 0, value.profile) ? t.CommandPart : t.CommandEnd);
      return;
    }
    if (value.mode === "comment") {
      if (input.next === 10 || input.next === 13) return emit(value.parent?.literal && value.parent.scope === "environment" ? t.HeaderCommentEnd : t.CommentEnd, input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      return chunk(t.CommentText, code => code !== 10 && code !== 13);
    }
    if (value.mode === "verb") {
      if (matches(input, value.end)) return emit(t.VerbClose, value.end.length);
      if (input.next === 10 || input.next === 13) return emit(t.VerbBreak, input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      return chunk(t.LiteralText, code => !matches(input, value.end) && code !== 10 && code !== 13);
    }
    if (value.mode === "literal") {
      if (literalClose(input, value)) return emit(t.LiteralEndCommand, 4);
      // Kernel verbatim has no closing-line restriction. Its whitespace is
      // literal content too, not a line-prefix transition. Keep chunks bounded
      // while checking the exact own closer even across a chunk boundary.
      if (!literalEnvironments[value.env.short].line) {
        const closer = "\\end{" + value.env.short + "}";
        return chunk(t.LiteralText, code => code !== 92 || !matches(input, closer));
      }
      if (input.next === 10 || input.next === 13) return emit(t.LiteralNewline, input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      if (input.next === 32 || input.next === 9) return chunk(t.LiteralSpace, code => code === 32 || code === 9);
      return chunk(t.LiteralText, code => !space(code) && !literalClose(input, value));
    }
    if (value.literal && value.scope === "environment") {
      if (value.pending && (input.next === 10 || input.next === 13)) return emit(t.LiteralHeaderNewline, input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      if (value.pending && (input.next === 32 || input.next === 9)) return chunk(t.LiteralHeaderSpace, code => code === 32 || code === 9);
      if (!(value.pending && (space(input.next) || input.next === 37 || input.next === 91 && argument(value, true) || input.next === 123 && argument(value, false)))) return emit(t.LiteralStart, 0);
    }
    if (value.mode === "math" && value.end && matches(input, value.end)) return emit(t.MathClose, value.end.length);
    if (input.next === 37) return emit(t.CommentStart, 1);
    if (input.next === 123) {
      const role = argument(value, false)?.role;
      const term = role === "heading" ? t.HeadingOpen : role === "text" ? t.TextOpen : role === "body" ? t.BodyOpen : role === "spec" ? t.SpecOpen : role?.startsWith("definition") ? t.DefinitionOpen : role === "label" ? t.LabelOpen : role === "reference-list" ? t.ReferenceListOpen : role === "reference" ? t.ReferenceOpen : role?.startsWith("citation") ? t.CitationOpen : role === "path-list" ? t.PathListOpen : role === "path" ? t.PathOpen : t.OpenBrace;
      return emit(term, 1);
    }
    if (input.next === 125) return emit(t.CloseBrace, 1);
    if (input.next === 91) return emit(parameterText(value) ? t.ParameterDelimiter : argument(value, true)?.role === "default" ? t.DefaultOpen : argument(value, true) ? t.ArgumentOpen : t.OptionalOpen, 1);
    if (input.next === 93) return emit(parameterText(value) ? t.ParameterDelimiter : t.OptionalClose, 1);
    if (space(input.next)) return chunk(t.Space, space);
    if (input.next === 36 && parameterText(value)) return emit(t.ParameterDelimiter, 1);
    if (input.next === 36 && value.mode !== "math") return emit(t.MathOpen, input.peek(1) === 36 ? 2 : 1);
    if (input.next === 92) {
      if (parameterText(value)) return emit(wordAt(input, 1, value.profile) ? t.CommandStart : t.ControlSymbol, wordAt(input, 1, value.profile) ? 1 : input.peek(1) < 0 ? 1 : point(input, 1) > 0xffff ? 3 : 2);
      const declaring = value.role === "definition-command" || argument(value, false)?.role === "definition-command";
      if (!declaring) {
        if (matches(input, "\\begin") && !wordAt(input, 6, value.profile)) return emit(t.BeginCommand, 6);
        if (matches(input, "\\end") && !wordAt(input, 4, value.profile)) return emit(t.EndCommand, 4);
        if (matches(input, "\\verb") && !wordAt(input, 5, value.profile)) {
          const size = input.peek(5) === 42 ? 7 : 6, delimiter = input.peek(size - 1);
          if (delimiter >= 0 && !space(delimiter)) return emit(t.VerbOpen, size);
        }
        if (value.mode !== "math" && (input.peek(1) === 40 || input.peek(1) === 91)) return emit(t.MathOpen, 2);
      }
      if (wordAt(input, 1, value.profile)) {
        if (declaring) return emit(t.DefinitionStart, 1);
        const name = commandAt(input, value.profile), signature = commandSignatures[name];
        if (signature) return emit(signature.profile ? t.ProfileCommand : signature.rank !== undefined ? t.HeadingCommand : t.CatalogCommand,
          name.length + 1 + (signature.star && input.peek(name.length + 1) === 42 ? 1 : 0));
        return emit(t.CommandStart, 1);
      }
      return emit(declaring ? t.DefinitionSymbol : t.ControlSymbol, input.peek(1) < 0 ? 1 : point(input, 1) > 0xffff ? 3 : 2);
    }
    if (input.next === 35 && digit(input.peek(1))) return emit(t.Parameter, 2);
    if (value.mode === "math" && digit(input.next)) return chunk(t.Number, digit);
    const operator = code => value.mode === "math" ? "^_+-=*/<>!|:&,;~".includes(String.fromCharCode(code)) : value.role !== "text" && "~&".includes(String.fromCharCode(code));
    if (operator(input.next)) return chunk(t.Operator, operator);
    const term = value.role === "definition-environment" ? t.DefinitionText : value.role === "label" || value.role?.startsWith("reference") ? t.ReferenceText : value.role?.startsWith("citation") ? t.CitationText : value.role?.startsWith("path") ? t.PathText : value.mode === "math" ? t.MathText : t.Text;
    if (input.next === 36) return emit(term, 1);
    return chunk(term, code => !space(code) && ![36, 37, 92, 123, 125, 91, 93].includes(code) && !operator(code) && !(code === 35 && digit(input.peek(1))) && !(value.mode === "math" && digit(code)));
  }, { contextual: true });
}
export const tokens = createTokens();
