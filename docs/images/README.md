# Demonstration images

These screenshots show Iris 1.0.0 running with synthetic accounts and projects.
The music, document text and bibliography entries come from
[`scripts/fixtures/docs-demo.cjs`](../../scripts/fixtures/docs-demo.cjs).
The references and observations are invented demonstration material.

- [LilyPond workspace](lilypond-workspace.png): Morning study, a two-staff duet,
  compiled to PDF and displayed beside the source in the dark theme.
- [LaTeX workspace](latex-workspace.png): Garden field notes, with an equation
  and table, compiled to PDF in the light theme.
- [Bibliography](bibliography.png): the same project's reference table.
- [Administration](administration.png): synthetic local users and server roles.

## Reproduce the captures

Install the [development prerequisites](../development.md#run-the-tests),
pdfLaTeX with the `geometry` and `booktabs` packages, LilyPond 2.26.0, and Chrome.
From the source root:

```sh
npm ci
node scripts/capture-docs.cjs --output docs/images
```

Use `--pg-bin DIR` for PostgreSQL tools outside the discoverable bindir, or
`--browser-executable PATH` for another installed Chromium. `--help` lists these
options without starting services.

The script creates a disposable loopback PostgreSQL cluster, restricted database
role, random credentials and empty application storage. It creates demo projects
through the real API, opens the shipped UI and clicks Compile for native builds.
It uses the real bibliography and administration controllers. It removes the
browser, server, cluster and storage on completion, leaving only the four named
PNGs and [capture metadata](capture.json) in the output directory.

The disposable runtime handles SIGINT, SIGTERM and SIGHUP. It closes the browser
to interrupt pending page work and confirms the Chrome process group has exited
before removing storage. A cancelled launch cannot enter browser work. The
runtime also cleans the app and PostgreSQL. Playwright launch has a ten-second
timeout; its browser-close path has a thirty-second force-kill fallback. Browser
profiles and driver artifacts stay inside the owned temporary root, including
on launch failure. The runtime tracks Chrome during startup too, so cancellation
can terminate it even before Playwright returns a browser handle.

The images use a 1600×1000 viewport at DPR 1 and reduced motion. The script
does not replace API responses, alter the DOM or restyle the application.
Font requests use the page's normal external stylesheets; metadata records
font availability and failed external requests. Browser/font versions, current
timestamps and native rendering can change pixels across runs. Capture metadata
records versions and SHA-256 hashes rather than promising byte-identical images.
