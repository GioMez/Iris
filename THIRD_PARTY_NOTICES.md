# Third-party notices

## Tabler Icons

Iris includes a curated subset of Tabler Icons 3.45.0.

Copyright (c) 2020-2026 Paweł Kuna

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/tabler/tabler-icons

## CodeMirror

Iris serves CodeMirror 6 (`@codemirror/state`, `@codemirror/view`,
`@codemirror/language`, `@codemirror/commands`, `@codemirror/collab`,
`@codemirror/autocomplete`) and its
runtime dependencies (`@lezer/common`, `@lezer/highlight`, `@lezer/lr`, `style-mod`,
`w3c-keyname`, `crelt`, `@marijn/find-cluster-break`) to the browser as
unmodified ES modules from `node_modules` via `/vendor/codemirror/`. The backend
also uses `@codemirror/state` and `@codemirror/collab` directly, as the
operational-transformation authority for realtime editing.

Copyright (C) 2018-2026 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/codemirror/dev

### Lezer language foundations

Iris directly depends on `@lezer/common` **1.5.2**, `@lezer/highlight` **1.2.3**
and `@lezer/lr` **1.4.10**, and uses `@lezer/generator` **1.8.0** only during
development to generate the committed native-ESM parser and term table. These
packages are MIT licensed under the Marijn Haverbeke and contributors notice
and permission text above; their installed distributions retain their `LICENSE`
files. The generator is not served to the browser and is not required to start
a production installation.

Sources: https://github.com/lezer-parser/common,
https://github.com/lezer-parser/highlight, https://github.com/lezer-parser/lr,
https://github.com/lezer-parser/generator.

The HP03 TeX grammar/catalog and LilyPond boundary probe are original Iris
sources, not copied third-party language catalogs. Regenerate the parser with
`npm run build:languages`; see [the development workflow](docs/development.md#generated-language-sources-hp03).

### LilyPond note-name data (HP05)

`public/languages/lilypond/pitches.mjs` adapts the spelling membership of the
`nederlands`, `italiano`, `english`, and `deutsch` catalogs from **LilyPond 2.26.0**:
https://github.com/lilypond/lilypond/blob/v2.26.0/scm/define-note-names.scm.
It expresses the regular spellings as root/suffix products, retains the explicit
exceptions and aliases, and omits pitch values and other language catalogs.

Upstream credits for these data:

- Copyright (C) 1996–2026 Han-Wen Nienhuys (Nederlands, English).
- Copyright (C) 1997–2026 Roland Meier and Bjoern Jacke (Deutsch).
- Copyright (C) 1998–2026 Paolo Zuliani and Eric Wurbel (Italiano).
- Copyright (C) 2010–2026 Valentin Villenave et al. (common catalog).

LilyPond is free software, redistributable and modifiable under the GNU General
Public License, version 3 or (at your option) any later version. It is distributed
without any warranty, including implied warranties of merchantability or fitness
for a particular purpose. The full GPL version 3 is included in Iris's `LICENSE`;
see also https://www.gnu.org/licenses/gpl-3.0.html.

The HP05 grammar, tokenizer and query implementation are original Iris code.
Comment semantics were checked against the versioned reference lexer:
https://github.com/lilypond/lilypond/blob/v2.26.0/lily/lexer.ll.
The `<longcomment>` rules close at the first `%}` and do not nest on `%{`.

Catalog coverage, update procedure and the current Scheme boundary are documented
in [Editor language support](docs/editor-languages.md).

## ws

Iris uses `ws` on the server for the WebSocket transport that carries realtime
collaboration. It is a backend dependency and is never sent to the browser, which
uses its native WebSocket implementation.

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Source: https://github.com/websockets/ws

## Playwright Core

Iris uses `playwright-core` 1.63.0 as a development-only dependency for real-browser
tests against installed Chrome. It is not a runtime dependency or a browser asset.

Playwright
Copyright (c) Microsoft Corporation

This software contains code derived from the Puppeteer project
(https://github.com/puppeteer/puppeteer), available under the Apache 2.0 license
(https://github.com/puppeteer/puppeteer/blob/master/LICENSE).

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

The installed package includes its full `LICENSE`, `NOTICE`, and bundled
dependency notices in `ThirdPartyNotices.txt`.

Source: https://github.com/microsoft/playwright

## pdf-lib

Iris serves the unmodified `pdf-lib` 1.17.1 ES-module bundle from `node_modules`
at `/vendor/pdf-lib/pdf-lib.esm.min.js`. A dedicated worker uses it to read
original PDF page geometry for source navigation. The bundle includes its
TypeScript runtime notice; the installed package and locked dependencies include
their license files.

Copyright (c) 2019 Andrew Dillon

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/Hopding/pdf-lib
