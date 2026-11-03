\version "2.26.0"
\paper {
  oddHeaderMarkup = \markup "Iris score header"
  oddFooterMarkup = \markup "Iris score footer"
}
\book {
  \bookOutputSuffix "first"
  \header { title = "Final music layout" subtitle = "Lyrics and custom drawing" }
  \score {
    << \new Staff \new Voice = "melody" { \relative c' { c4 d e f g1 } }
       \new Lyrics \lyricsto "melody" { Lay -- out in the score } >>
  }
  \markup \rotate #20 "Rotated markup"
  \markup \epsfile #X #12 "layout-image.eps"
  \markup \with-dimensions #'(0 . 10) #'(0 . 10)
    \postscript #"0 0 moveto 20 10 lineto 10 30 lineto closepath fill"
  \pageBreak
  \score { \new Staff { c'1 d'1 } }
}
\book {
  \bookOutputSuffix "second"
  \header { title = "Another book" }
  \score { \new Staff { e'1 f'1 } }
}
