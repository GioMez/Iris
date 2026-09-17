import { LRLanguage } from "@codemirror/language";
import { styleTags } from "@lezer/highlight";
import { syntaxTags as t } from "../../iris-syntax-style.mjs";
import { parser } from "./parser.mjs";
import { createContext } from "./tokens.mjs";
import { recoverySafeParser } from "./reuse.mjs";
import { summarize, summarySteps, contextAt } from "./queries.mjs";

const styled = recoverySafeParser(parser.configure({ props: [styleTags({
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
})] }));
export function createAdapter(options = Object.freeze({ initialNoteLanguage: "nederlands" })) {
  const language = LRLanguage.define({ name: "iris-ly", parser: styled.configure({ contextTracker: createContext(options.initialNoteLanguage) }), languageData: { commentTokens: { line: "%", block: { open: "%{", close: "%}" } } } });
  return Object.freeze({ kind: "ly", options, language, summarize, summarySteps,
    contextAt: (tree, doc, pos, bias) => contextAt(tree, doc, pos, bias, options.initialNoteLanguage),
    blockAtEnter: () => null, formatChanges: () => Object.freeze([]) });
}
