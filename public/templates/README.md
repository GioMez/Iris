# Project templates

The files here seed a fresh Iris instance. Administrators manage the mutable
catalog under `TEMPLATE_DIR` (default `DATA_DIR/templates`) from **Admin →
Templates** on the project dashboard. Existing projects retain their copied
source when you change a template.

## Edit the catalog

The console lets you set a template's title, description, ID, project type,
default status and source. You can rename a template or move it between LaTeX
and LilyPond. Changes appear the next time a user opens the new-project dialog;
no application-code change or restart is needed.

Template IDs omit the `.tex` or `.ly` extension and accept up to 80 Unicode
characters. They cannot start/end with a dot, contain path separators/control
characters or reserved filename punctuation, or use reserved device names.
The title accepts up to 120 characters. Use the console to maintain the catalog
metadata and defaults together with its source files.

Regular files placed under `TEMPLATE_DIR/latex/` or `TEMPLATE_DIR/lilypond/`
are also discoverable when their IDs are valid. Files without catalog metadata
use a title derived from the filename. Iris selects the configured default
first, then `article.tex` for LaTeX or `default.ly` for LilyPond, then the first
available template in sorted ID order.

Templates must be UTF-8 text without NUL bytes and no larger than 1 MiB. Iris
exposes at most 200 per type through authenticated endpoints, refuses traversal
and does not follow symlinks. It does not serve template directories as static
files.

## Localized placeholders

LaTeX templates can use:

- `@@TITLE@@`
- `@@INTRODUCTION@@`
- `@@RECIPIENT@@`
- `@@LETTER_OPENING@@`
- `@@LETTER_BODY@@`
- `@@LETTER_CLOSING@@`

LilyPond templates support `@@TITLE@@`. The frontend substitutes starter text
from its language catalog when creating the project; see
[Translating Iris](../../TRANSLATING.md).

Iris copies the template as source text. A compiler interprets it if a user
compiles the project, under the same execution rules as other sources. Treat
template authors as trusted source authors.

## Storage and backup

Both Docker and Podman Compose persist the catalog in the `project-data` volume
at `/app/data/templates`. A separate host-backed catalog needs a writable mount
with ownership suitable for Iris UID 1000, and SELinux labeling where applicable.
Include that separate directory in the coordinated backup.

See [Administration](../../docs/administration.md#templates),
[Configuration](../../docs/configuration.md) and
[backup/restore](../../docs/administration.md#backup-and-restore) for instance
settings and the two-layer procedure.
