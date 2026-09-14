// Original synthetic material for documentation captures; no user projects.
const file = (name, content) => ({ id: name, type: "file", name, path: name, kind: name.split(".").pop(), content });
module.exports = [
  { name: "Morning study", type: "lilypond", nodes: [file("main.ly", String.raw`\version "2.26.0"
\header {
  title = "Morning study"
  subtitle = "A short duet in G major"
  composer = "Iris demo"
  tagline = ##f
}
\paper {
  #(set-paper-size "a5")
  indent = 12\mm
  ragged-last-bottom = ##f
}

melody = \relative c'' {
  \key g \major \time 3/4
  \tempo "Andante" 4 = 84
  g4\p( b d) | e2 d4 | b4( a g) | a2. |
  b4( d g) | fis2 e4 | d4( b a) | g2. \break
  e'4\mp( d b) | c2 b4 | a4( g fis) | g2. |
  b4\<( c d) | e2 d4\! | b4( a fis) | g2.\fermata
  \bar "|."
}

bass = \relative c {
  \key g \major \time 3/4 \clef bass
  g2\p d'4 | c2 b4 | g2 b4 | d2. |
  g,2 b4 | a2 c4 | b2 d4 | g,2. |
  c2\mp g4 | a2 g4 | d'2 c4 | b2. |
  g2 a4 | c2 b4 | d2 d,4 | g2.\fermata
}

\score {
  \new StaffGroup <<
    \new Staff \with { instrumentName = "Violin" } \melody
    \new Staff \with { instrumentName = "Cello" } \bass
  >>
  \layout { }
  \midi { }
}
`)] },
  { name: "Garden field notes", type: "latex", nodes: [file("main.tex", String.raw`\documentclass[11pt]{article}
\usepackage[a5paper,margin=16mm]{geometry}
\usepackage{booktabs}
\title{Garden field notes}
\author{Iris demo}
\date{September 2026}

\begin{document}
\maketitle

\section{The morning plot}
These invented observations form a small example
document. The north bed receives morning light;
the south bed stays shaded until noon.

\subsection{Measurements}
We record a height for each seedling and compare
the mean of the two beds:
\[
  \bar{x} = \frac{1}{n}\sum_{i=1}^{n} x_i
\]

\begin{center}
\begin{tabular}{lrr}
\toprule
Bed & Seedlings & Mean height \\
\midrule
North & 12 & 8.4 cm \\
South & 12 & 7.1 cm \\
\bottomrule
\end{tabular}
\end{center}

\section{Next visit}
\begin{itemize}
  \item Measure at the same time of day.
  \item Note rainfall before watering.
  \item Keep a separate record for each bed.
\end{itemize}
\end{document}
`), file("references.bib", `@book{north2026,
  author = {North, Alex},
  title = {A notebook for the garden},
  year = {2026},
  publisher = {Example Press},
  note = {Invented reference for the Iris demo}
}

@article{river2025,
  author = {River, Sam and Reed, Morgan},
  title = {Light and seedling growth},
  journal = {Example Field Studies},
  year = {2025},
  keywords = {shade, seedlings},
  note = {Invented reference for the Iris demo}
}

@misc{plot2026,
  author = {Plot Study Group},
  title = {Morning measurement protocol},
  year = {2026},
  howpublished = {Demonstration worksheet},
  note = {Invented reference for the Iris demo}
}
`)] },
];
