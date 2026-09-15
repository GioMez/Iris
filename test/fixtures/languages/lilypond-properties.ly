\new Staff \with {
  instrumentName = "Iris"
  shortInstrumentName = "Synthetic header deliberately longer than two hundred and forty UTF-16 code units: this text exercises context body discovery after a long with configuration, including a quoted brace } and music-like c4 words that remain string data throughout this header."
} {
  \override NoteHead.color = #red
  \set Staff.instrumentName = "Solo"
  \context Voice = "lead" { c4 }
}
