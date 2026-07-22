# Translating Iris

Iris keeps all user-facing translations in language catalogs. Translators do
not need to edit HTML, JavaScript, or backend source files.

## Translation files

- English source catalog: `public/locales/en/translation.json`
- Italian catalog: `public/locales/it/translation.json`
- Additional languages: `public/locales/<language-code>/translation.json`

The catalogs use the monolingual **i18next JSON v4** format. English is the
source and fallback language. Keys are stable identifiers and must not be
translated.

For a Weblate component, use:

```text
File mask: public/locales/*/translation.json
Monolingual base language file: public/locales/en/translation.json
File format: i18next JSON file v4
Language code style: POSIX or BCP 47 language code
```

Once the repository is connected to Weblate, contributors can translate and
review strings entirely in its browser interface. Configure Weblate to create a
translation branch or pull request so catalog changes pass the repository's
tests before merging.

## Translation rules

- Preserve named placeholders exactly, including braces: `{{name}}`,
  `{{count}}`, `{{time}}`, and similar values.
- Translate every plural form displayed by the translation platform. Iris uses
  CLDR suffixes such as `_one` and `_other`; other languages may require
  `_zero`, `_two`, `_few`, or `_many` as well.
- Do not add HTML to translations. Iris inserts catalog values as text and
  escapes values used in generated markup.
- Keep product and technology names such as Iris, LaTeX, LilyPond, BibTeX,
  Biber, PDF, and SSO unchanged unless the target language has an established
  convention.
- Keep keyboard shortcuts and file extensions intact.
- Values under `templates` are inserted into starter LaTeX or LilyPond files:
  keep them plain text and avoid unescaped syntax characters such as `\\`, `{`,
  `}`, `%`, `&`, `_`, `#`, `$`, `^`, and `~`.
- Prefer concise labels for buttons and tabs. Longer explanatory text belongs
  in descriptions and hints.

Run the checks before submitting a catalog change:

```sh
npm test
```

The localization tests verify key parity, non-empty values, placeholders,
plural forms, markup bindings, script loading order, and API error coverage.

## Adding a language to Iris

Adding a catalog in Weblate is not enough to expose a language in the product.
A maintainer must also add its metadata to `SUPPORTED` in
`public/iris-i18n.js` and add the corresponding option to the two language
selectors in `public/Iris.html`. This small reviewed change controls the label,
locale identifier, and text direction used by the application.
