const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadEditorSupport() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/iris-latex.js"), "utf8"), context);
  context.IrisLatex = context.window.IrisLatex;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/iris-lilypond.js"), "utf8"), context);
  return context.window.IrisLilyPond;
}

test("highlights LilyPond commands and comments as text", () => {
  const lilypond = loadEditorSupport();
  const html = lilypond.highlight('\\relative c\' { c4 d } % theme');
  assert.match(html, /t-cmd/);
  assert.match(html, /t-comment/);
  assert.match(html, /\\relative/);
});

test("formats and outlines LilyPond source blocks", () => {
  const lilypond = loadEditorSupport();
  const source = '\\score {\n\\relative c\' {\nc1\n}\n\\layout { }\n}';
  const formatted = lilypond.format(source);
  assert.match(formatted, /\n  \\relative/);
  assert.match(formatted, /\n    c1/);
  const outline = lilypond.outline(formatted);
  assert.equal(outline[0].title, "Score 1");
  assert.ok(outline.some((item) => item.title === "\\layout"));
});

test("outlines LilyPond input modes, file structure, variables, and contexts", () => {
  const lilypond = loadEditorSupport();
  const source = String.raw`\version "2.26.0"
\include "orchestra.ily"

global = { c'1 }
harmony = \chordmode { c1 }
label = "Suite"

\paper { output-filename = "suite" }
\book {
  \bookpart {
    \header { title = "Not a \\score" }
    \score {
      <<
        \new StaffGroup <<
          \new Staff = "violin" { \global }
          \new ChordNames \chordmode { c1 }
          \new Lyrics \lyricmode { la1 }
        >>
      >>
      \layout { }
      \midi { }
    }
    \markup { "Intermezzo" }
  }
}
% \score { ignored }
%{ \book { ignored } %}`;

  const outline = lilypond.outline(source);
  const titles = Array.from(outline, (item) => item.title);

  assert.deepEqual(titles.slice(0, 7), [
    '\\version "2.26.0"',
    '\\include "orchestra.ily"',
    "global =",
    "harmony = \\chordmode",
    "label =",
    "\\paper",
    "\\book",
  ]);
  assert.ok(titles.includes("\\bookpart"));
  assert.ok(titles.includes("\\header"));
  assert.ok(titles.includes("Score 1"));
  assert.ok(titles.includes("\\new StaffGroup"));
  assert.ok(titles.includes('\\new Staff = "violin"'));
  assert.ok(titles.includes("\\new ChordNames"));
  assert.ok(titles.includes("\\chordmode"));
  assert.ok(titles.includes("\\new Lyrics"));
  assert.ok(titles.includes("\\lyricmode"));
  assert.ok(titles.includes("\\layout"));
  assert.ok(titles.includes("\\midi"));
  assert.ok(titles.includes("\\markup"));
  assert.equal(titles.filter((title) => title === "Score 1").length, 1);
  assert.equal(titles.filter((title) => title === "\\book").length, 1);

  const bookpart = outline.find((item) => item.title === "\\bookpart");
  const score = outline.find((item) => item.title === "Score 1");
  const staff = outline.find((item) => item.title === '\\new Staff = "violin"');
  assert.equal(bookpart.level, 2);
  assert.equal(score.level, 3);
  assert.equal(staff.level, 4);
});

test("outlines the documented LilyPond input mode forms", () => {
  const lilypond = loadEditorSupport();
  const source = String.raw`\chords { c1 }
\drummode { sn1 }
\drums { sn1 }
\figuremode { <6>1 }
\figures { <6>1 }
\lyricmode { sing1 }
\lyrics { sing1 }
\addlyrics { sing1 }
\notemode { c'1 }
\markuplist { \wordwrap-lines "Text" }`;
  const titles = Array.from(lilypond.outline(source), (item) => item.title);

  assert.deepEqual(titles, [
    "\\chords",
    "\\drummode",
    "\\drums",
    "\\figuremode",
    "\\figures",
    "\\lyricmode",
    "\\lyrics",
    "\\addlyrics",
    "\\notemode",
    "\\markuplist",
  ]);
});
