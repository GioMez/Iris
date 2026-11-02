import { LRLanguage } from "@codemirror/language";
import { NodeProp } from "@lezer/common";
import { styleTags } from "@lezer/highlight";
import { syntaxTags as t } from "../../iris-syntax-style.mjs";
import { createParser } from "../parser-factory.mjs";
import { summarize, summarySteps, contextAt } from "./queries.mjs";
import { blockAtEnter, formatChanges } from "./editing.mjs";

const props = [styleTags({
  "Command LongCommand! LanguageCommand IncludeCommand VersionCommand RelativeCommand FixedCommand TransposeCommand RepeatCommand TupletCommand WrapperCommand PropertyCommand PropertyEndCommand TweakCommand ModeCommand": t.command,
  "MarkupCommand MarkupUnaryCommand MarkupNumberCommand MarkupListCommand MarkupStringCommand MarkupNullaryCommand UnknownMarkupStart": t.command,
  "TimeCommand TempoCommand": t.command,
  "BlockCommand ContextCommand WithCommand": t.structure,
  "AssignmentHead/Identifier! AssignmentHead/String!": t.definition,
  "ConfigGroup/Assignment/AssignmentHead/Identifier! ConfigGroup/Assignment/AssignmentHead/String! Property": t.property,
  ContextName: t.context,
  Variable: t.variable,
  Pitch: t.pitch,
  Rest: t.rest,
  Duration: t.duration,
  "Number SchemeNumber LongSchemeNumber!": t.number,
  "Lyric LyricString!": t.lyric,
  "String! PathOpen StringClose": t.string,
  PathText: t.path,
  "LineComment! BlockComment!": t.comment,
  "OpenBrace MusicOpen CloseBrace SimOpen SimClose ChordOpen ChordClose LyricsOpen MarkupOpen ChordsOpen DrumsOpen FiguresOpen ConfigOpen UnknownOpen": t.delimiter,
  "Equals TempoEquals NameDot Operator": t.operator,
  Articulation: t.articulation,
  "SchemeAtom SchemeAtomIntro LongSchemeAtom! SchemeQuoteMark SchemeQuotedSpace SchemeQuotedOpen SchemeQuotedClose SchemeDot SchemeUnknown!": t.scheme,
  SchemeNumberIntro: t.number,
  "SchemeIntro SchemeListOpen SchemeListClose SchemeVectorOpen MusicLiteralOpen MusicLiteralClose": t.delimiter,
  "SchemeString!": t.string,
  "SchemeComment! SchemeDatumComment!": t.comment,
}), NodeProp.closedBy.add({
  "OpenBrace MusicOpen LyricsOpen MarkupOpen ChordsOpen DrumsOpen FiguresOpen ConfigOpen UnknownOpen": ["CloseBrace"],
  SimOpen: ["SimClose"], ChordOpen: ["ChordClose"], MusicLiteralOpen: ["MusicLiteralClose"],
  "SchemeListOpen SchemeQuotedOpen SchemeVectorOpen": ["SchemeListClose", "SchemeQuotedClose"],
}), NodeProp.openedBy.add({
  CloseBrace: ["OpenBrace", "MusicOpen", "LyricsOpen", "MarkupOpen", "ChordsOpen", "DrumsOpen", "FiguresOpen", "ConfigOpen", "UnknownOpen"],
  SimClose: ["SimOpen"], ChordClose: ["ChordOpen"], MusicLiteralClose: ["MusicLiteralOpen"],
  "SchemeListClose SchemeQuotedClose": ["SchemeListOpen", "SchemeQuotedOpen", "SchemeVectorOpen"],
})];
export function createAdapter(options = Object.freeze({ initialNoteLanguage: "nederlands" })) {
  const language = LRLanguage.define({ name: "iris-ly", parser: createParser("ly", options).configure({ props }), languageData: { commentTokens: { line: "%", block: { open: "%{", close: "%}" } } } });
  return Object.freeze({ kind: "ly", options, language, summarize, summarySteps,
    contextAt: (tree, doc, pos, bias) => contextAt(tree, doc, pos, bias, options.initialNoteLanguage),
    blockAtEnter, formatChanges });
}
