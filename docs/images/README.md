# Documentation screenshots

These images show Iris with synthetic accounts and projects from
[`scripts/fixtures/docs-demo.cjs`](../../scripts/fixtures/docs-demo.cjs).
The music, garden observations and bibliography entries are invented examples.

| Image | Workflow |
| --- | --- |
| [Project dashboard](project-dashboard.png) | Choose or create a project. |
| [LilyPond workspace](lilypond-workspace.png) | Edit Morning study beside its compiled score in the dark theme. |
| [LaTeX workspace](latex-workspace.png) | Edit Garden field notes beside its PDF in the light theme. |
| [Compilation settings](compilation-settings.png) | Choose a main file and enable PDF/source mapping. |
| [Compilation workflow](compilation-workflow.png) | Choose a compiler preset and its steps. |
| [Lua pipeline](lua-pipeline.png) | Set a parameter, inspect targets and run an approved plugin. |
| [Lua run](lua-run.png) | Read the target result, step states and log. |
| [Compilation history](compilation-history.png) | Inspect retained builds and download output. |
| [Diagnostics](diagnostics.png) | Locate a compiler error in source. |
| [Sharing](project-sharing.png) | Manage project owners, editors and viewers. |
| [File history](file-history.png) | Read a saved revision and restore its text. |
| [Bibliography](bibliography.png) | Edit references in a table. |
| [Administration](administration.png) | Manage accounts and server roles. |

## Reproduce the captures

Install the [development prerequisites](../development.md#run-the-tests),
pdfLaTeX with `geometry` and `booktabs`, LilyPond 2.26.0, Lua 5.4 or 5.5, and
Chrome. From the source root:

```sh
npm ci
node scripts/capture-docs.cjs --output docs/images
```

Use `--pg-bin DIR` to select PostgreSQL tools or `--browser-executable PATH` for
another installed Chromium. Run `--help` to see the options.

To keep compiler/browser versions, font availability and image hashes, choose
a Git-ignored report destination whose parent directory exists:

```sh
mkdir -p docs/superpowers
node scripts/capture-docs.cjs --output docs/images \
  --report docs/superpowers/documentation-capture.json
```

The script starts a disposable PostgreSQL cluster and Iris server, creates demo
accounts and projects through the API, and drives the shipped controls. It
compiles native PDFs, runs the Lua plugin and captures a deliberate LaTeX error.
On completion or interruption, it closes the browser and removes its server,
cluster and temporary storage. The output directory receives only the named PNGs.

Captures use a 1600×1000 viewport at DPR 1, reduced motion and the shipped local
fonts. Dialog images crop to the dialog. The script uses the real API responses
and UI styling. Timestamps and browser/compiler rendering can change pixels
between runs.
