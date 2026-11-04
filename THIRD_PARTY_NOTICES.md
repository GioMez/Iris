# Third-party notices

## MuPDF

Iris uses **MuPDF.js 1.28.1** on the server to extract conservative occupied
regions from final compiler PDFs. The pinned npm package includes the JavaScript
binding and WebAssembly renderer from Artifex Software, Inc.

MuPDF is licensed under **AGPL-3.0-or-later**. Its complete license accompanies
the installed package at `node_modules/mupdf/LICENSE` and is available at
https://www.gnu.org/licenses/agpl-3.0.html. GPLv3 section 13 permits combination
with AGPLv3; the AGPL network-interaction requirements apply to the combination.
Operators distributing or offering a modified combined service must provide its
Corresponding Source as required by those licenses.

Sources: https://github.com/ArtifexSoftware/mupdf.js (binding),
https://github.com/ArtifexSoftware/mupdf (renderer),
https://github.com/GioMez/Iris (Iris integration).

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
`npm run build:languages`; see [the development workflow](docs/development.md#generated-language-sources-and-qualification).

### Bundled language Worker (HP08)

`public/vendor/language-worker/worker.mjs` bundles the original Iris language
runtime, the LilyPond note-name data described below, `@lezer/common` 1.5.2 and
`@lezer/lr` 1.4.10. Lezer's MIT copyright and permission text above apply to the
bundled copies too. Iris sources and adapted LilyPond data remain GPL-3.0-or-later.
The generated module has no runtime network or development-dependency imports.

`esbuild` **0.25.12** is a pinned development-only build tool (MIT, copyright
2020 Evan Wallace; https://github.com/evanw/esbuild). It is not bundled or served.
Regenerate with `npm run build:language-worker`; verify with
`npm run check:language-worker`. Generated Worker files use LF. The version
module fingerprints the source, locked bundled dependencies and build settings.

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

## Ajv and validation dependencies

Iris uses Ajv 8.20.0 to validate bounded plugin parameter and adapter option
schemas. Its locked runtime dependencies include fast-deep-equal,
json-schema-traverse, require-from-string and fast-uri.

The following components use the MIT License:

- Ajv: Copyright (c) 2015-2021 Evgeny Poberezkin.
- fast-deep-equal and json-schema-traverse: Copyright (c) 2017 Evgeny Poberezkin.
- require-from-string: Copyright (c) Vsevolod Strukchinsky
  <floatdrop@gmail.com> (github.com/floatdrop).

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

fast-uri uses the BSD-3-Clause License:

Copyright (c) 2011-2021, Gary Court until
https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae
Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
- The names of any contributors may not be used to endorse or promote
  products derived from this software without specific prior written
  permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The fast-uri license credits the complete contributor list at
https://github.com/garycourt/uri-js/graphs/contributors.

Sources: https://github.com/ajv-validator/ajv,
https://github.com/epoberezkin/fast-deep-equal,
https://github.com/epoberezkin/json-schema-traverse,
https://github.com/floatdrop/require-from-string and
https://github.com/fastify/fast-uri.

## Pipeline archive streams

Iris uses `tar-stream` **3.2.2** on the backend for bounded pipeline transfer
streams. The package and its dependencies remain unmodified npm distributions;
Iris does not serve them to the browser. Their installed distributions retain
their full license texts and notices.

MIT-licensed packages use the permission and warranty text in the Tabler Icons
section above, with these copyright holders:

| Package | Version | Copyright |
| --- | --- | --- |
| tar-stream | 3.2.2 | Copyright (c) 2014 Mathias Buus |
| fast-fifo | 1.3.2 | Copyright (c) 2019 Mathias Buus |
| streamx | 2.28.1 | Copyright (c) 2019 Mathias Buus |
| teex | 1.0.1 | Copyright (c) 2020 Mathias Buus |

The dependency closure also includes these Apache-2.0 packages:
`b4a` 1.9.0, `bare-events` 2.9.2, `bare-fs` 4.8.4, `bare-path` 3.1.2,
`bare-stream` 2.13.4, `bare-url` 2.5.5, `events-universal` 1.0.1 and
`text-decoder` 1.2.7. Their distributions include the full Apache License 2.0;
see https://www.apache.org/licenses/LICENSE-2.0. Apache-2.0 and MIT are compatible
with Iris's GPL-3.0-or-later license. Node uses the platform's native filesystem;
the Bare packages provide upstream cross-runtime support.

The `bare-path` NOTICE also states:

> Copyright 2023 Holepunch Inc
>
> Licensed under the Apache License, Version 2.0 (the "License");
> you may not use this file except in compliance with the License.
> You may obtain a copy of the License at
>
> http://www.apache.org/licenses/LICENSE-2.0
>
> Unless required by applicable law or agreed to in writing, software
> distributed under the License is distributed on an "AS IS" BASIS,
> WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
> See the License for the specific language governing permissions and
> limitations under the License.
>
> Copyright Joyent, Inc. and other Node contributors.
>
> Permission is hereby granted, free of charge, to any person obtaining a
> copy of this software and associated documentation files (the
> "Software"), to deal in the Software without restriction, including
> without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the
> following conditions:
>
> The above copyright notice and this permission notice shall be included
> in all copies or substantial portions of the Software.

Sources: https://github.com/mafintosh/tar-stream,
https://github.com/mafintosh/fast-fifo, https://github.com/mafintosh/streamx,
https://github.com/mafintosh/teex and https://github.com/holepunchto.

## Lua interpreter in the container image

The Dockerfile installs Alpine's `lua5.4` **5.4.8-r0** package and exposes its
interpreter as `/usr/local/bin/lua`. Native installations use the operator's Lua.

Copyright (C) 1994-2025 Lua.org, PUC-Rio.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Source and license: https://github.com/lua/lua/blob/v5.4.8/lua.h.
Alpine package: https://pkgs.alpinelinux.org/package/v3.23/main/aarch64/lua5.4.

## dkjson

Iris ships unmodified **dkjson 2.11** in `src/pipeline/vendor/dkjson.lua` for
metadata exchange with the installed Lua interpreter. The codec needs no
LuaRocks packages or native extensions. Binary file contents use separate frames.

Copyright (C) 2010-2026 David Heiko Kolf

The component uses the MIT License:

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

Source: [dkjson 2.11](https://dkolf.de/dkjson-lua/dkjson-2.11.lua).
Upstream [SHA-256 listing](https://dkolf.de/downloads):
`197cb50834c642f84b4cf99fe724932c50e6d9c92faec7ad89aa25e91df4d481`.
The source file retains the full license notice.

## Offline interface fonts (HP08)

Iris bundles unmodified IBM Plex Sans (Google Fonts webfont v23), IBM Plex Mono
(webfont v20) and CMU Serif (embedded version 0.7.0) webfont binaries. These fonts
remain under the **SIL Open Font License, Version 1.1**, not Iris's software
license. The full copyright notices and license texts are shipped at:

- [public/fonts/OFL-IBM-Plex.md](public/fonts/OFL-IBM-Plex.md): Copyright © 2017
  IBM Corp., reserved font name "Plex".
- [public/fonts/OFL-CMU.md](public/fonts/OFL-CMU.md): original Metafont authors
  and Copyright (C) 2003-2009 Andrey V. Panov, reserved font family name
  "Computer Modern Unicode fonts". Font metadata credits conversion by Panov
  and, for Roman/Italic/Bold, glyphs from Blue Sky fonts released by AMS.

Upstreams: https://github.com/IBM/plex and https://cm-unicode.sourceforge.io/.
The [font inventory](public/fonts/manifest.json) pins every binary's source URL,
size and SHA-256 and the full license sources/hashes. The
[font README](public/fonts/README.md) describes the declared faces, preserved
subsets, licensing verification and maintenance-time reproduction.
