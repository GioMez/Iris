# Project templates

These files are discovered whenever the new-project dialog opens and are loaded when a project is created. Existing projects are not affected by later template changes.

Add `.tex` files below `latex/` and `.ly` files below `lilypond/`. The file name without its extension is the template ID shown in the selector; hyphens and underscores become spaces in its label. Hidden files, symlinks, and files with other extensions are ignored.

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

For Docker deployments, mount host directories over the two template directories. Include any bundled templates that the instance should retain:

```yaml
volumes:
  - ./templates/latex:/app/public/templates/latex:ro
  - ./templates/lilypond:/app/public/templates/lilypond:ro
```
