\version "2.26.0"
% c4 \score fake
%{ block "string" %}
name = "Iris \"😀\""
melody = \relative c' {
  cis'4. bes,8*3/2 r4 R1 s2 <c e g>4 q8 |
  << { c8[ d]( e)\f\< f\! } \\ { g2-> a-. } >>
}
\score { \new Staff \melody }
