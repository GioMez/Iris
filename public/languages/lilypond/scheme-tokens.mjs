import * as t from './parser.terms.mjs';

// Reader boundaries, never evaluation. Each invocation consumes <=256 UTF-16
// units; lists/quotes/discards are grammar productions, not a forward scan.
const limit = 256;
const space = c => [9, 10, 12, 13, 32].includes(c);
// Quote punctuation dispatches only at datum start. Guile retains ', ` and ,
// inside an existing atom (and a candidate character name/numeric dispatch).
const atomChar = c => c >= 0 && !space(c) && ![40, 41, 91, 93, 34, 59].includes(c);
function numeric(text) {
  let offset = 0, radix = '', exactness = '';
  while (text[offset] === '#' && offset < 4) {
    const prefix = text[offset + 1]?.toLowerCase();
    if (prefix === 'e' || prefix === 'i') { if (exactness) return false; exactness = prefix; }
    else if (['b', 'o', 'd', 'x'].includes(prefix)) { if (radix) return false; radix = prefix; }
    else return false;
    offset += 2;
  }
  const body = text.slice(offset);
  if (radix === 'b') return /^[+-]?[01]+(?:\/[01]+)?$/.test(body);
  if (radix === 'o') return /^[+-]?[0-7]+(?:\/[0-7]+)?$/.test(body);
  if (radix === 'x') return /^[+-]?[\da-f]+(?:\/[\da-f]+)?$/i.test(body);
  return /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eEsSfFdDlL][+-]?\d+)?|\d+\/\d+)$/.test(body);
}
function atom(input) {
  let text = '', size = 0;
  while (size < limit && atomChar(input.peek(size))) text += String.fromCharCode(input.peek(size++));
  return { text, size, more: atomChar(input.peek(size)) };
}
export function schemeIntroduction(input) {
  const offset = input.peek(1) === 64 ? 2 : 1, c = input.peek(offset);
  if (c === 40 || space(c) || c === 59 || c < 0) return [t.SchemeIntro, offset];
  const part = atom({ peek: n => input.peek(n + offset) });
  if ((!part.more || c !== 35) && numeric(part.text)) return [t.SchemeNumberIntro, offset];
  return [t.SchemeAtomIntro, offset];
}
export function schemeToken(input, stack) {
  const value = stack.context;
  const emit = (term, size) => { input.advance(size); input.acceptToken(term); };
  const chunk = (term, predicate) => {
    let size = 0;
    while (size < limit && input.next >= 0 && predicate()) { input.advance(); size++; }
    if (size) input.acceptToken(term);
  };
  if (value.mode === 'scheme-unknown') return input.next < 0 ? emit(t.SchemeUnknownEnd, 0) : chunk(t.SchemeUnknownText, () => true);
  if (value.mode === 'scheme-scalar') {
    const part = atom(input);
    return emit(part.more ? t.SchemePart : t.SchemeScalarEnd, part.size);
  }
  if (value.mode === 'scheme-string') {
    if (input.next === 34) return emit(t.SchemeStringClose, 1);
    if (input.next === 92) return emit(t.SchemeStringEscape, input.peek(1) < 0 ? 1 : 2);
    return chunk(t.SchemeStringText, () => ![34, 92].includes(input.next));
  }
  if (value.mode === 'scheme-comment') {
    if (value.scope === 'scheme-line') {
      if (input.next < 0 || input.next === 10 || input.next === 13) return emit(t.SchemeLineEnd, input.next < 0 ? 0 : input.next === 13 && input.peek(1) === 10 ? 2 : 1);
      return chunk(t.SchemeLineText, () => ![10, 13].includes(input.next));
    }
    if (value.scope === 'scheme-guile') {
      if (input.next === 33 && input.peek(1) === 35) return emit(t.SchemeGuileEnd, 2);
      return chunk(t.SchemeGuileText, () => !(input.next === 33 && input.peek(1) === 35));
    }
    if (input.next === 35 && input.peek(1) === 124) return emit(t.SchemeBlockNest, 2);
    if (input.next === 124 && input.peek(1) === 35) return emit(value.depth > 1 ? t.SchemeBlockUnnest : t.SchemeBlockEnd, 2);
    return chunk(t.SchemeBlockText, () => !(input.next === 35 && input.peek(1) === 124 || input.next === 124 && input.peek(1) === 35));
  }
  // Explicit zero-width handoff after exactly one datum, before reader trivia
  // can consume any part of the outer LilyPond expression.
  if (stack.canShift(t.SchemeFinish)) return emit(t.SchemeFinish, 0);
  if (input.next < 0) return;
  if (space(input.next)) return chunk(value.readerQuoted ? t.SchemeQuotedSpace : t.SchemeSpace, () => space(input.next));
  if (input.next === 59) return emit(t.SchemeLineStart, 1);
  if ([91, 93, 124].includes(input.next)) return emit(t.SchemeUnknownStart, 1);
  // A second value after a dotted tail has no reader boundary we can certify.
  // Accept the grammar's unknown fallback instead of letting LR recovery insert
  // a closer and reinterpret the same source characters as outer music.
  if (!stack.canShift(t.SchemeAtom) && ![41].includes(input.next) && !(input.next === 35 && [124, 33, 59].includes(input.peek(1)))) return emit(t.SchemeUnknownStart, 1);
  if (input.next === 34) return emit(t.SchemeStringOpen, 1);
  if (input.next === 40) return emit(value.readerQuoted ? t.SchemeQuotedOpen : t.SchemeListOpen, 1);
  if (input.next === 41) return emit(value.readerQuoted && value.scope !== 'scheme-vector' ? t.SchemeQuotedClose : t.SchemeListClose, 1);
  if ([39, 96, 44].includes(input.next)) return emit(t.SchemeQuoteMark, input.next === 44 && input.peek(1) === 64 ? 2 : 1);
  if (input.next === 46 && !atomChar(input.peek(1))) return emit(stack.canShift(t.SchemeDot) ? t.SchemeDot : t.SchemeUnknownStart, 1);
  if (input.next === 35) {
    const next = input.peek(1);
    if (next === 123) return emit(t.MusicLiteralOpen, 2);
    if (next === 40) return emit(t.SchemeVectorOpen, 2);
    if (next === 124) return emit(t.SchemeBlockStart, 2);
    if (next === 33) return emit(t.SchemeGuileStart, 2);
    if (next === 59) return emit(t.SchemeDiscard, 2);
    if (next === 92) {
      // A delimiter character is one character datum, not a structural closer.
      if (input.peek(2) < 0) return emit(t.SchemeUnknownStart, 2);
      const c = input.peek(2), width = c >= 0xd800 && c <= 0xdbff && input.peek(3) >= 0xdc00 && input.peek(3) <= 0xdfff ? 2 : 1;
      if (!atomChar(c) || width === 2 && !atomChar(input.peek(4))) return emit(t.SchemeAtom, 2 + width);
      const part = atom(input), name = part.text.slice(2);
      const code = /^x[\da-f]+$/i.test(name) ? parseInt(name.slice(1), 16) : -1;
      if (!part.more && (name.length === 1 || ['space', 'newline', 'tab', 'return', 'nul', 'alarm', 'backspace', 'delete', 'escape'].includes(name) || code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))) return emit(t.SchemeAtom, part.size);
      return emit(t.SchemeUnknownStart, 2);
    }
    if (![116, 102, 101, 105, 98, 111, 100, 120, 84, 70, 69, 73, 66, 79, 68, 88].includes(next)) return emit(t.SchemeUnknownStart, 1);
    const part = atom(input);
    if (!part.more && /^#[tf]$/i.test(part.text)) return emit(t.SchemeAtom, part.size);
    // Dispatch names are extensible. A numeric-looking prefix is not a
    // certificate for an arbitrarily long reader dispatch. Keep these unknown
    // from their start rather than release a suffix into the outer language.
    if (!part.more && numeric(part.text)) return emit(t.SchemeNumber, part.size);
    return emit(t.SchemeUnknownStart, 1);
  }
  const part = atom(input);
  if (part.size) return emit(part.more ? numeric(part.text) ? t.SchemeNumberStart : t.SchemeAtomStart : numeric(part.text) ? t.SchemeNumber : t.SchemeAtom, part.size);
}
