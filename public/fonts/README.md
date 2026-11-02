# Offline interface fonts

Iris serves these fonts from `public/fonts/` through `iris-fonts.css`. The
browser needs only the Iris server, including on a cold cache. Font files are
checked in and shipped in source archives; application startup does not fetch
them or install fonts on the host.

## Inventory and provenance

[`manifest.json`](manifest.json) records every original download URL, byte size,
SHA-256, family, style, weight, subset and license. Retrieved 2026-09-19 from the
two stylesheets previously declared by `Iris.html` (URLs also in the manifest).

| Family | Declared faces | Distribution |
| --- | --- | --- |
| IBM Plex Sans | normal 400, 500, 600 | Google Fonts webfont **v23**, six WOFF2 subsets shared across those weights |
| IBM Plex Mono | normal 400, 500, 600; italic 400 | Google Fonts webfont **v20**, five WOFF2 subsets for each face |
| CMU Serif | normal/italic 500; normal/italic 700 | CDN Fonts `/s/19926/`, embedded font version **0.7.0**, four WOFF files |

The IBM version numbers above identify Google's webfont distributions, not IBM
release tags. Their upstream is [IBM Plex](https://github.com/IBM/plex). CMU's
upstream is [Computer Modern Unicode](https://cm-unicode.sourceforge.io/).
All 30 binaries are byte-for-byte downloads: no conversion, subsetting, glyph
editing or renaming of embedded families. The descriptive IBM filenames are
local aliases for the exact versioned URLs. SHA-256 pins also protect the CMU
URLs, whose paths do not encode their version.

The Google Latin, Latin Extended, Cyrillic, Cyrillic Extended and Vietnamese
subsets are retained; Sans also retains Greek. Original Unicode ranges permit
lazy loading. Sans's six variable binaries are reused at the three originally
declared weights rather than converted into static fonts. CMU regular/italic
remain at the source stylesheet's **500**, even though the embedded regular
face is named Roman. IBM retains `font-display: swap`; CMU retains its default
display behavior. The existing application font tokens/fallbacks are used.

## Licenses

Both families are redistributed under **SIL Open Font License 1.1**, separately
from Iris's software license. Full copyright notices and license texts ship in:

- [`OFL-IBM-Plex.md`](OFL-IBM-Plex.md): IBM's notice, reserved name **Plex**;
  pinned Google Fonts source in the manifest (the Sans and Mono notices agree).
- [`OFL-CMU.md`](OFL-CMU.md): original Metafont authors and Andrey V. Panov's
  notice, reserved family name **Computer Modern Unicode fonts**. Full text
  from the pinned CMU webfont distribution mirror in the manifest. The upstream
  project explicitly identifies 0.7.0 as OFL, and all four downloaded WOFF
  name tables independently identify version 0.7.0 and OFL 1.1. Earlier CMU
  releases had different licenses; those are not the binaries shipped here.

The license copies retain the complete wording; line endings/trailing
whitespace are normalized for this repository and `.md` preserves them under
the release filter. Manifest license hashes describe these shipped copies.
OFL permits bundling with software with its copyright and license notices;
the fonts remain OFL and are not sold on their own. See also
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

## Reproduction and verification

`node scripts/vendor-fonts.cjs` verifies the local bytes without network access.
For an explicit maintenance-time re-download, use
`node scripts/vendor-fonts.cjs --download`: it requests only the pinned binary
URLs and rejects wrong sizes, containers or hashes before writing. No npm font
package, global font installation or startup download is involved. License
updates require review against the recorded sources; the downloader does not
rewrite text or update pins.

Run `node --test test/fonts.test.js test/packaging.test.js` for inventory,
license and real archive extraction checks. `test/fonts.browser.test.js` uses
the normal disposable-database/browser test environment. It loads every actual
`FontFace`, checks selected family/style/weight/subset faces, and validates the
browser's local HTTP responses, MIME, sizes and hashes with external requests
blocked. The fresh-install package gate repeats that browser check using the
extracted production server.
