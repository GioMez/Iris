const table = entries => Object.freeze(Object.assign(Object.create(null), entries));
export const inputModes = table({ notemode: "music", notes: "music", lyricmode: "lyrics", lyrics: "lyrics", addlyrics: "lyrics",
  markup: "markup", markuplist: "markup", chordmode: "chords", chords: "chords", drummode: "drums", drums: "drums", figuremode: "figures", figures: "figures" });
export const blockModes = table({ book: "music", bookpart: "music", score: "music", header: "config", paper: "config", layout: "config", midi: "config" });
export const wrappers = table({ relative: "optional-pitch", absolute: "none", fixed: "pitch", transpose: "two-pitches", repeat: "repeat", alternative: "none", tuplet: "ratio", grace: "none" });
// Editorial subset of the 2.26 markup signatures. Unknown/dynamic commands do
// not inherit an assumed one-argument signature.
export const markupSignatures = table({ bold: "markup", italic: "markup", underline: "markup", tiny: "markup", small: "markup", large: "markup", huge: "markup",
  fontsize: "number-markup", concat: "list", line: "list", column: "list", "center-column": "list", "fill-line": "list", musicglyph: "string", null: "none" });
export const numericSignatures = table({ time: "number", tempo: "tempo" });
export const propertyCommands = Object.freeze(["override", "revert", "set", "unset", "tweak"]);
export const dynamics = Object.freeze("ppppp pppp ppp pp p mp mf f ff fff ffff fffff fp sf sff sfz rfz sp spp cresc decresc dim".split(" "));
export const commands = Object.freeze("bold italic underline tiny small large huge fontsize concat line column center-column fill-line null musicglyph tempo time key major minor clef bar break pageBreak noBreak partial acciaccatura appoggiatura afterGrace oneVoice voiceOne voiceTwo voiceThree voiceFour autoBeamOn autoBeamOff stemUp stemDown stemNeutral slurUp slurDown tieUp tieDown once language include version new context with".split(" "));
export const invocableName = name => typeof name === "string" && name.length <= 128 && /^\p{L}+(?:[-_]\p{L}+)*$/u.test(name);
