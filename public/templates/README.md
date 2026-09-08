# Project templates

These files seed a new Iris instance. The mutable catalog is stored in `TEMPLATE_DIR` (default `DATA_DIR/templates`) and managed from the **Templates** section of the Admin dashboard. Existing projects are not affected by later template changes.

Administrators can set the display title, description, ID/file name, type, default status and source from the GUI. Files manually placed below `TEMPLATE_DIR/latex/` or `TEMPLATE_DIR/lilypond/` are also discovered when their ID is valid; metadata then falls back to the file name.

Templates must be regular UTF-8 text files without NUL bytes and no larger than 1 MiB. At most 200 templates per type are exposed. They are read through an authenticated endpoint that refuses path traversal and does not follow symlinks; the template directories are not served directly as static files.

`article.tex` is the preferred LaTeX default and `default.ly` is the preferred LilyPond default. If either file is absent, the first template in that directory is selected by default.

LaTeX templates support these localized placeholders:

- `@@TITLE@@`
- `@@INTRODUCTION@@`
- `@@RECIPIENT@@`
- `@@LETTER_OPENING@@`
- `@@LETTER_BODY@@`
- `@@LETTER_CLOSING@@`

LilyPond templates support `@@TITLE@@`.

Adding or editing a template requires no application-code change or server restart.

Template source is copied as text into the new project and is not evaluated while the project is created. It is interpreted only if a user later compiles the project, under the same compiler restrictions as any source entered directly in the editor. Treat template authors as trusted source authors.

Docker Compose persists the catalog in the existing `/app/data` volume. To keep it in a separate host directory, mount the mutable root read-write:

```yaml
volumes:
  - ./templates:/app/data/templates
```
