// Spelling membership, reference LilyPond v2.26.0 scm/define-note-names.scm.
// See THIRD_PARTY_NOTICES.md and docs/editor-languages.md for provenance.
// Adapted data: Copyright (C) 1996--2026 Han-Wen Nienhuys;
// 1997--2026 Roland Meier, Bjoern Jacke; 1998--2026 Paolo Zuliani,
// Eric Wurbel; 2010--2026 Valentin Villenave et al. GPL-3.0-or-later.
// Distributed without warranty; see the repository LICENSE.
export const pitchCatalogVersion = "2.26.0";
const regular = (roots, suffixes) => roots.split(" ").flatMap(root => suffixes.split(" ").map(suffix => root + suffix));
function readonly(names) {
  const set = new Set(names);
  const view = Object.freeze({
    size: set.size, has: name => set.has(name),
    values: () => set.values(), keys: () => set.keys(), entries: () => set.entries(),
    [Symbol.iterator]: () => set.values(),
    forEach: (callback, thisArg) => set.forEach(name => callback.call(thisArg, name, name, view)),
  });
  return view;
}
const dutch = regular("c d e f g a b", " eses eseh es eh ih is isih isis");
const german = regular("c d f g", " eses eseh es eh ih is isih isis").concat(
  "eses eseh es eh e eih eis eisih eisis asas asah as ah a aih ais aisih aisis heses heseh b heh h hih his hisih hisis ases aseh aeh eeh".split(" "));
const catalogs = Object.freeze(Object.assign(Object.create(null), {
  nederlands: readonly(dutch.concat("es eses as ases".split(" "))),
  italiano: readonly(regular("do re mi fa sol la si", " bb bsb b sb sd d dsd dd")),
  english: readonly(regular("c d e f g a b", " ff tqf f qf qs s tqs ss x -flatflat -flat -natural -sharp -sharpsharp")),
  deutsch: readonly(german),
}));
export const noteLanguages = Object.freeze(Object.keys(catalogs));
export function noteNames(language) { return typeof language === "string" && Object.hasOwn(catalogs, language) ? catalogs[language] : null; }
export const normalizeNoteLanguage = language => noteNames(language) ? language : "unknown";
