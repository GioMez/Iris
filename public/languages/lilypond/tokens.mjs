import { ContextTracker, ExternalTokenizer } from "@lezer/lr";
import * as t from "./parser.terms.mjs";
import { noteNames, normalizeNoteLanguage } from "./pitches.mjs";
import { inputModes, blockModes, wrappers, markupSignatures, numericSignatures, propertyCommands, dynamics, commands, invocableName } from "./catalog.mjs";
import { addSymbol, hasSymbol } from "./symbols.mjs";
import { reuseEffect } from "./reuse.mjs";
import { schemeToken, schemeIntroduction } from "./scheme-tokens.mjs";

const limit = 256;
const space = c => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const digit = c => c >= 48 && c <= 57;
const markupChar = c => c >= 0 && !space(c) && ![37, 34, 92, 123, 125, 35, 36].includes(c);
const letter = c => c >= 0 && /\p{L}/u.test(String.fromCodePoint(c));
function point(input, offset = 0) {
  const a = input.peek(offset), b = input.peek(offset + 1);
  return a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff ? (a - 0xd800) * 1024 + b - 0xdc00 + 0x10000 : a;
}
function wordAt(input, offset = 0) {
  const c = point(input, offset);
  return letter(c) || [45, 95, 46].includes(c) && letter(point(input, offset + 1));
}
function readWord(input, offset = 0) {
  let text = "", size = offset;
  while (size - offset < limit && wordAt(input, size)) {
    const c = point(input, size), width = c > 65535 ? 2 : 1;
    if (size - offset + width > limit) break;
    text += String.fromCodePoint(c); size += width;
  }
  return { text, size: size - offset, complete: !wordAt(input, size) };
}
const textAt = (input, size) => { let text = ""; for (let i = 0; i < size; i++) text += String.fromCharCode(input.peek(i)); return text; };
const short = text => text.length <= 128 ? text : "";
function state(parent, fields = {}) {
  const value = { parent, scope: "root", from: -1, mode: parent?.mode || "music", language: parent?.language || "nederlands",
    symbols: parent?.symbols || null, pending: "", lastName: "", nameValid: parent?.nameValid || false, end: parent?.end || 0, defining: false, compound: false, chord: false, modifier: false,
    string: "", escaped: false, depth: 0, quoted: false, readerQuoted: parent?.readerQuoted || false, musicLiteral: parent?.musicLiteral || false, ...fields };
  value.hash = contextHash(value);
  return Object.freeze(value);
}
function contextHash(value) {
  let hash = value.parent?.hash || 0;
  const key = [value.scope, value.mode, value.language, value.symbols?.hash, value.pending, value.lastName, value.defining,
    value.nameValid, value.compound, value.chord, value.modifier, value.string, value.escaped, value.depth, value.quoted, value.readerQuoted, value.musicLiteral].join("|");
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  return hash;
}
function replace(value, fields) {
  let changed = false, rehash = false;
  for (const key in fields) if (fields[key] !== value[key]) {
    changed = true;
    // The consumed end guides recovery, but is deliberately not a reuse
    // dependency. Preserve the exact hash for continuity-only token shifts.
    if (key !== "end") rehash = true;
  }
  if (!changed) return value;
  const next = { ...value, ...fields };
  if (rehash) next.hash = contextHash(next);
  return Object.freeze(next);
}
const clear = value => replace(value, { pending: "", lastName: "", nameValid: false, defining: false, compound: false, modifier: false });
const pop = value => value.parent ? replace(value.parent, { language: value.language, symbols: value.symbols, end: value.end }) : value;
const restore = value => value.parent ? replace(value.parent, { end: value.end }) : value;
const groupTerms = () => new Map([[t.OpenBrace, null], [t.MusicOpen, "music"], [t.LyricsOpen, "lyrics"], [t.MarkupOpen, "markup"], [t.ChordsOpen, "chords"],
  [t.DrumsOpen, "drums"], [t.FiguresOpen, "figures"], [t.ConfigOpen, "config"], [t.UnknownOpen, null], [t.SimOpen, null], [t.ChordOpen, null]]);
const scopeRules = () => new Set([t.Group, t.MusicGroup, t.LyricsGroup, t.MarkupGroup, t.ChordsGroup, t.DrumsGroup, t.FiguresGroup, t.ConfigGroup, t.UnknownGroup,
  t.Simultaneous, t.Chord, t.ModeExpression, t.Block, t.Context, t.WithBlock, t.Wrapper, t.String, t.LyricString, t.PathString,
  t.LineComment, t.BlockComment, t.LongWord, t.LongCommand, t.LongSchemeAtom, t.LongSchemeNumber, t.MarkupCall, t.LongMarkupText, t.UnknownMarkup, t.NumericCommand]);
const readerRules = () => new Set([t.SchemeExpression, t.SchemeList, t.SchemeVector, t.SchemeQuote, t.SchemeString,
  t.SchemeLineComment, t.SchemeBlockComment, t.SchemeGuileComment, t.SchemeDatumComment, t.SchemeUnknown, t.MusicLiteral]);
export function createContext(initialNoteLanguage = "nederlands") {
  const base = state(null, { language: normalizeNoteLanguage(initialNoteLanguage) }), groups = groupTerms(), rules = scopeRules(), readers = readerRules();
  const transition = (value, term, stack, input) => {
      if ([t.SchemeIntro, t.SchemeAtomIntro, t.SchemeNumberIntro].includes(term)) return state(value, { scope: "scheme-expression", mode: "scheme", from: input.pos });
      if (term === t.SchemeFinish) return restore(value);
      if ([t.SchemeListOpen, t.SchemeQuotedOpen, t.SchemeVectorOpen, t.SchemeQuoteMark, t.SchemeDiscard].includes(term)) return state(value, {
        scope: term === t.SchemeVectorOpen ? "scheme-vector" : term === t.SchemeQuoteMark ? "scheme-quote" : term === t.SchemeDiscard ? "scheme-discard" : "scheme-list",
        mode: "scheme", from: input.pos, readerQuoted: value.readerQuoted || term === t.SchemeQuoteMark });
      if ([t.SchemeListClose, t.SchemeQuotedClose, t.SchemeStringClose, t.SchemeLineEnd, t.SchemeBlockEnd, t.SchemeGuileEnd, t.SchemeUnknownEnd, t.MusicLiteralClose].includes(term)) return restore(value);
      if (term === t.MusicLiteralOpen) return state(value, { scope: "music-literal", mode: "music", from: input.pos, readerQuoted: false, musicLiteral: true });
      if (term === t.SchemeStringOpen) return state(value, { scope: "scheme-string", mode: "scheme-string", from: input.pos });
      if ([t.SchemeLineStart, t.SchemeBlockStart, t.SchemeGuileStart].includes(term)) return state(value, { scope: term === t.SchemeLineStart ? "scheme-line" : term === t.SchemeBlockStart ? "scheme-block" : "scheme-guile", mode: "scheme-comment", from: input.pos, depth: 1 });
      if (term === t.SchemeBlockNest || term === t.SchemeBlockUnnest) return replace(value, { depth: value.depth + (term === t.SchemeBlockNest ? 1 : -1) });
      if (term === t.SchemeUnknownStart) return state(value, { scope: "scheme-unknown", mode: "scheme-unknown", from: input.pos });
      if (groups.has(term)) return state(clear(value), { scope: "group", from: input.pos, mode: groups.get(term) || value.mode,
        chord: term === t.ChordOpen, language: value.language });
      if ([t.CloseBrace, t.SimClose, t.ChordClose].includes(term)) return value.scope === "group" ? clear(pop(value)) : clear(value);
      if ([t.ModeCommand, t.MarkupCommand, t.BlockCommand, t.ContextCommand, t.WithCommand, t.RelativeCommand, t.FixedCommand, t.TransposeCommand, t.RepeatCommand, t.TupletCommand, t.WrapperCommand].includes(term)) {
        const name = readWord(input, 1).text;
        return state(clear(value), { scope: "expression", from: input.pos,
          mode: inputModes[name] || blockModes[name] || (name === "with" ? "config" : "music"),
          pending: term === t.ContextCommand ? "context" : [t.RepeatCommand, t.TupletCommand].includes(term) ? "wrapper-number" : "" });
      }
      if ([t.MarkupUnaryCommand, t.MarkupNumberCommand, t.MarkupListCommand, t.MarkupStringCommand, t.MarkupNullaryCommand].includes(term)) return state(clear(value), {
        scope: "markup-call", mode: "markup", from: input.pos, pending: term === t.MarkupNumberCommand ? "markup-number" : "" });
      if (term === t.MarkupTextStart) return state(value, { scope: "markup-word", mode: "markup-word", from: input.pos });
      if (term === t.MarkupEnd) return clear(pop(value));
      if (term === t.UnknownMarkupStart) return state(clear(value), { scope: "unknown-markup", mode: "unknown-markup", from: input.pos });
      if (term === t.UnknownMarkupEnd) return clear(pop(value));
      if (term === t.TimeCommand || term === t.TempoCommand) return state(clear(value), { scope: "numeric-command", from: input.pos,
        pending: term === t.TimeCommand ? "number" : "tempo-beat" });
      if (term === t.TempoEquals) return replace(value, { pending: "tempo-count" });
      if ([t.LanguageCommand, t.IncludeCommand, t.VersionCommand].includes(term)) return replace(clear(value), { pending: term === t.LanguageCommand ? "language" : term === t.IncludeCommand ? "include" : "version" });
      if ([t.PropertyCommand, t.PropertyEndCommand, t.TweakCommand].includes(term)) return replace(clear(value), { pending: "property" });
      if (term === t.ContextName) return replace(value, { pending: "context-id", lastName: "" });
      if (term === t.Property) return replace(value, { pending: "property-value", lastName: "" });
      if (term === t.Word) return replace(value, { lastName: short(readWord(input).text), nameValid: true });
      if (term === t.NameDot) return replace(value, { compound: true });
      if (term === t.Equals) {
        const symbols = value.nameValid && !value.pending && !value.compound && value.mode !== "config" && invocableName(value.lastName) ? addSymbol(value.symbols, value.lastName) : value.symbols;
        return replace(value, { lastName: "", nameValid: false, defining: false, symbols, pending: value.pending || "assignment-value" });
      }
      if ([t.StringOpen, t.LyricOpen, t.PathOpen].includes(term)) return state(value, { scope: "string", mode: "string", from: input.pos,
        pending: value.pending, string: "", quoted: term === t.LyricOpen });
      if (term === t.StringText || term === t.PathText || term === t.StringEscape) {
        let size = 0;
        if (term === t.StringEscape) size = input.peek(1) < 0 ? 1 : 2;
        else while (size < limit && input.peek(size) >= 0 && ![34, 92].includes(input.peek(size))) size++;
        const text = textAt(input, size);
        return replace(value, { string: value.string === null || value.string.length + text.length > 128 ? null : value.string + text,
          escaped: value.escaped || term === t.StringEscape });
      }
      if (term === t.StringClose) {
        const parent = pop(value);
        const language = value.pending === "include" ? "unknown" : value.pending === "language" ? normalizeNoteLanguage(value.escaped ? "unknown" : value.string) : value.language;
        return replace(parent, { language, lastName: value.string || "", nameValid: true, pending: "" });
      }
      if (term === t.LineStart || term === t.BlockStart) return state(value, { scope: term === t.LineStart ? "line-comment" : "block-comment", mode: "comment", from: input.pos });
      if (term === t.LineEnd || term === t.BlockEnd) return pop(value);
      if (term === t.WordStart || term === t.CommandStart) return state(value, { scope: "word", mode: term === t.CommandStart ? "command-word" : "word", from: input.pos });
      if (term === t.WordEnd || term === t.CommandEnd) return clear(pop(value));
      if (term === t.SchemeAtomStart || term === t.SchemeNumberStart) return state(value, { scope: "scalar", mode: "scheme-scalar", from: input.pos });
      if (term === t.SchemeScalarEnd) {
        return restore(value);
      }
      if (term === t.Operator && input.next === 58 && value.mode === "chords") return replace(value, { modifier: true });
      if (term === t.Space && value.modifier) return replace(value, { modifier: false });
      if ([t.Pitch, t.Rest, t.Duration, t.Command, t.Variable, t.Number, t.Text, t.MarkupText, t.Lyric].includes(term)) {
        if (value.pending === "include" || value.pending === "language") return replace(clear(value), { language: "unknown" });
        return replace(value, { lastName: "", nameValid: false, defining: false });
      }
      return value;
  };
  const zeroWidth = new Set([t.LineEnd, t.WordEnd, t.CommandEnd, t.MarkupEnd, t.UnknownMarkupEnd, t.SchemeScalarEnd, t.SchemeFinish, t.SchemeUnknownEnd, t.SchemeLineEnd]);
  const shift = (value, term, stack, input) => {
    // Lezer deletes recovery tokens without a context shift. A discontinuity
    // between actual shifted spans invalidates a pending declaration name.
    // Inserted (zero-width) name/delimiter tokens cannot certify it either.
    const inserted = stack.pos === input.pos && !zeroWidth.has(term);
    if (value.end !== input.pos || inserted) value = replace(value, { nameValid: false });
    const next = transition(value, term, stack, input);
    return replace(next, { end: stack.pos, nameValid: inserted ? false : next.nameValid });
  };
  return new ContextTracker({
    start: base, shift,
    reduce(value, term, stack, input) {
      if (readers.has(term)) {
        if (value.parent && value.from >= input.pos) value = restore(value);
        return term === t.SchemeExpression || term === t.MusicLiteral ? ["include", "language"].includes(value.pending) ? value : clear(value) : value;
      }
      if (term === t.TempoBeat) return replace(value, { pending: "tempo-equals" });
      if (term === t.Directive) return clear(["include", "language"].includes(value.pending) ? replace(value, { language: "unknown" }) : value);
      if (term === t.Assignment || term === t.PropertyChange || term === t.MarkupNumberArgument) return clear(value);
      if (rules.has(term)) {
        // One frame per syntactic reduction, including inserted closers at EOF.
        if (value.parent && value.from >= input.pos) value = pop(value);
        if ([t.ModeExpression, t.Block, t.Context, t.WithBlock, t.Wrapper, t.MarkupCall, t.NumericCommand].includes(term)) return clear(value);
      }
      return value;
    },
    reuse(value, tree, stack, input) {
      if (value.end !== input.pos) value = replace(value, { nameValid: false });
      const effect = reuseEffect(tree);
      const at = offset => ({ pos: input.pos + offset, get next() { return input.peek(offset); }, peek: n => input.peek(offset + n) });
      if (effect.ops) {
        for (const op of effect.ops) value = shift(value, t[op.name], { pos: input.pos + op.offset + op.length }, at(op.offset));
        return replace(value, { end: input.pos + tree.length });
      }
      const read = part => part === null ? value.lastName : typeof part === "string" ? part : part.string ? part.length <= 128 ? textAt(at(part.offset + 1), part.length) : "" : short(readWord(at(part.offset)).text);
      let language = value.language;
      if (effect.language && ["include", "language"].includes(value.pending)) {
        language = value.pending === "include" || effect.language === "unknown" ? "unknown" : normalizeNoteLanguage(read(effect.language));
      }
      return replace(value, { lastName: read(effect.name), language, end: input.pos + tree.length,
        nameValid: effect.nameValid === null ? value.nameValid : effect.nameValid,
        pending: effect.pending === "opaque" ? ["include", "language"].includes(value.pending) ? value.pending : "" :
          effect.pending === "clear" || effect.pending === "atom" && ["include", "language"].includes(value.pending) ? "" : effect.pending && effect.pending !== "atom" ? effect.pending : value.pending,
        defining: effect.defining === null ? value.defining : effect.defining,
        compound: effect.compound === null ? value.compound : effect.compound,
        modifier: effect.modifier === null ? value.modifier : typeof effect.modifier === "boolean" ? effect.modifier :
          (effect.modifier.base ?? value.modifier) || value.mode === "chords" && effect.modifier.at.some(offset => input.peek(offset) === 58) });
    },
    hash: value => value.hash,
  });
}
export const context = createContext();

const known = new Set(commands), dynamic = new Set(dynamics);
export const tokens = new ExternalTokenizer((input, stack) => {
  const value = stack.context;
  const emit = (term, size) => { input.advance(size); input.acceptToken(term); };
  const chunk = (term, predicate) => {
    let size = 0;
    while (size < limit && input.next >= 0 && predicate(input.next)) { input.advance(); size++; }
    if (size) input.acceptToken(term);
  };
  if (value.mode.startsWith("scheme")) return schemeToken(input, stack);
  if (value.mode === "unknown-markup") return input.next < 0 ? emit(t.UnknownMarkupEnd, 0) : chunk(t.UnknownMarkupText, () => true);
  if (value.mode === "markup-word") {
    let size = 0;
    while (size < limit && markupChar(input.peek(size))) size++;
    return emit(markupChar(input.peek(size)) ? t.MarkupPart : t.MarkupEnd, size);
  }
  if (value.mode === "comment") {
    if (value.scope === "line-comment") {
      if (input.next < 0 || input.next === 10 || input.next === 13) return emit(t.LineEnd, input.next < 0 ? 0 : input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      return chunk(t.LineText, c => c !== 10 && c !== 13);
    }
    if (input.next === 37 && input.peek(1) === 125) return emit(t.BlockEnd, 2);
    return chunk(t.BlockText, () => !(input.next === 37 && input.peek(1) === 125));
  }
  if (value.mode === "string") {
    if (input.next === 34) return emit(t.StringClose, 1);
    if (input.next === 92) return emit(t.StringEscape, input.peek(1) < 0 ? 1 : 2);
    return chunk(value.pending === "include" ? t.PathText : t.StringText, c => c !== 34 && c !== 92);
  }
  if (value.scope === "word") {
    const word = readWord(input), command = value.mode === "command-word";
    return emit(word.complete ? command ? t.CommandEnd : t.WordEnd : command ? t.CommandPart : t.WordPart, word.size);
  }
  if (input.next < 0) return;
  if (space(input.next)) return chunk(t.Space, space);
  if (input.next === 37) return emit(input.peek(1) === 123 ? t.BlockStart : t.LineStart, input.peek(1) === 123 ? 2 : 1);
  if (input.next === 34) return emit(value.pending === "include" ? t.PathOpen : value.mode === "lyrics" ? t.LyricOpen : t.StringOpen, 1);
  if (input.next === 123) {
    const modeTerm = { lyrics: t.LyricsOpen, markup: t.MarkupOpen, chords: t.ChordsOpen, drums: t.DrumsOpen, figures: t.FiguresOpen, config: t.ConfigOpen };
    // Specialized groups encode context for tree-only caret queries.
    const term = modeTerm[value.mode] || (value.language === "unknown" ? t.UnknownOpen : value.scope === "expression" ? t.MusicOpen : t.OpenBrace);
    return emit(stack.canShift(term) ? term : t.OpenBrace, 1);
  }
  if (input.next === 125) return emit(t.CloseBrace, 1);
  if (input.next === 60) return emit(input.peek(1) === 60 ? t.SimOpen : t.ChordOpen, input.peek(1) === 60 ? 2 : 1);
  if (input.next === 62) return emit(input.peek(1) === 62 ? t.SimClose : t.ChordClose, input.peek(1) === 62 ? 2 : 1);
  if (input.next === 61) return emit(value.pending === "tempo-equals" ? t.TempoEquals : t.Equals, 1);
  if (input.next === 46 && (input.peek(1) === 34 || letter(point(input, 1)) || stack.canShift(t.NameDot))) return emit(t.NameDot, 1);
  if (input.next === 35 || input.next === 36) {
    if (input.next === 35 && input.peek(1) === 123) return emit(t.MusicLiteralOpen, 2);
    if (input.next === 35 && input.peek(1) === 125 && value.musicLiteral) return emit(t.MusicLiteralClose, 2);
    return emit(...schemeIntroduction(input));
  }
  if (input.next === 92) {
    const word = readWord(input, 1), name = word.text;
    if (value.mode === "markup" && name !== "score" && name !== "markup" && name !== "markuplist") {
      const signature = word.complete && markupSignatures[name];
      const term = signature === "markup" ? t.MarkupUnaryCommand : signature === "number-markup" ? t.MarkupNumberCommand : signature === "list" ? t.MarkupListCommand :
        signature === "string" ? t.MarkupStringCommand : signature === "none" ? t.MarkupNullaryCommand : t.UnknownMarkupStart;
      return emit(term, word.complete && word.size < limit ? word.size + 1 : 1);
    }
    if (!word.size) return emit(input.peek(1) === 92 ? t.Operator : [60, 62, 33, 40, 41].includes(input.peek(1)) ? t.Articulation : t.Command, input.peek(1) < 0 ? 1 : 2);
    if (!word.complete || word.size >= limit) return emit(t.CommandStart, 1);
    if (["breve", "longa", "maxima"].includes(name) && value.mode !== "config") {
      let size = 1 + word.size;
      while (size < limit && ".*0123456789/".includes(String.fromCharCode(input.peek(size))) && input.peek(size) >= 0) size++;
      return emit(t.Duration, size);
    }
    const specific = { language: t.LanguageCommand, include: t.IncludeCommand, version: t.VersionCommand, new: t.ContextCommand, context: t.ContextCommand,
      with: t.WithCommand, relative: t.RelativeCommand, fixed: t.FixedCommand, transpose: t.TransposeCommand, repeat: t.RepeatCommand, tuplet: t.TupletCommand,
      markup: t.MarkupCommand, markuplist: t.MarkupCommand };
    const term = Object.hasOwn(specific, name) ? specific[name] : numericSignatures[name] === "number" ? t.TimeCommand : numericSignatures[name] === "tempo" ? t.TempoCommand : Object.hasOwn(inputModes, name) ? t.ModeCommand : Object.hasOwn(blockModes, name) ? t.BlockCommand : Object.hasOwn(wrappers, name) ? t.WrapperCommand :
      propertyCommands.includes(name) ? name === "tweak" ? t.TweakCommand : ["revert", "unset"].includes(name) ? t.PropertyEndCommand : t.PropertyCommand :
      dynamic.has(name) ? t.Articulation : !known.has(name) && hasSymbol(value.symbols, name) ? t.Variable : t.Command;
    return emit(term, word.size + 1);
  }
  if (value.mode === "lyrics") {
    if (input.next === 45 && input.peek(1) === 45 || input.next === 95 && input.peek(1) === 95) return emit(t.Operator, 2);
    return chunk(t.Lyric, c => ![37, 34, 92, 123, 125, 35, 36].includes(c) && !(input.next === 45 && input.peek(1) === 45 || input.next === 95 && input.peek(1) === 95));
  }
  if (value.mode === "markup") {
    if (value.pending === "markup-number" && (digit(input.next) || [43, 45].includes(input.next) && digit(input.peek(1)))) return chunk(t.Number, c => digit(c) || [43, 45, 46, 47].includes(c));
    let size = 0;
    while (size < limit && markupChar(input.peek(size))) size++;
    if (size) return emit(markupChar(input.peek(size)) ? t.MarkupTextStart : t.MarkupText, size);
  }
  if (letter(point(input))) {
    const word = readWord(input), name = word.text;
    if (!word.complete) return emit(t.WordStart, word.size);
    if (value.pending === "context") return emit(t.ContextName, word.size);
    if (value.pending === "property") return emit(t.Property, word.size);
    const musical = value.mode !== "config" && !value.pending && !value.modifier;
    const pitch = musical && value.mode !== "drums" && (noteNames(value.language)?.has(name) || name === "q"), rest = musical && ["r", "R", "s"].includes(name);
    let size = word.size;
    if (pitch) while (size < limit && [39, 44, 33, 63].includes(input.peek(size))) size++;
    return emit(pitch ? t.Pitch : rest ? t.Rest : t.Word, size);
  }
  const numeric = value.mode === "config" || value.pending && value.pending !== "tempo-beat" || value.modifier || value.mode === "figures" && value.chord;
  if (digit(input.next) || numeric && [43, 45].includes(input.next) && digit(input.peek(1))) return chunk(numeric ? t.Number : t.Duration,
    c => digit(c) || [46, 42, 47].includes(c) || numeric && [43, 45].includes(c));
  if (input.next === 42 && value.mode !== "config" && !value.pending) return emit(t.Duration, 1);
  if ([91, 93, 40, 41].includes(input.next)) return emit(t.Articulation, 1);
  if ([45, 94, 95].includes(input.next) && [62, 46, 45, 94, 95, 43, 33].includes(input.peek(1))) return emit(t.Articulation, 2);
  if ("|~^_-+*/:,.!?".includes(String.fromCharCode(input.next))) return emit(t.Operator, 1);
  return emit(t.Text, point(input) > 65535 ? 2 : 1);
}, { contextual: true });
