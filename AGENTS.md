# Agent rules

Follow these repository rules. They take precedence over skill workflows when
instructions conflict, subject to higher-priority instructions and the user's
explicit directions.

## Priorities

- Develop **Iris**, the self-hosted LaTeX and LilyPond editor in this repository.
  Use Iris as the product name; retain existing repository and file names.
- Before starting work, read [README.md](README.md), the
  [documentation index](docs/README.md), and the relevant sections of the
  [development guide](docs/development.md). Read the affected subsystem's
  contract and any applicable approved specification or plan before editing.
- For editor-language work, use [editor-languages.md](docs/editor-languages.md)
  for delivery status and remaining qualification. Verify mounted latency,
  memory use, native compiler corpus behavior and full-UI acceptance before
  claiming those properties. Functional parser tests alone do not establish them.
- Treat [custom highlighting](docs/highlighting-customization.md) as a proposal
  requiring agreed scope. Do not infer a new assignment from a follow-up idea
  or an old planning record.

## Product direction

- Support both LaTeX documents and LilyPond scores. Preserve source fidelity,
  editing, compilation, preview, collaboration and recovery across changes.
- Treat concurrent clients as part of the design. Account for server authority,
  permissions, revisions, reconnects, cancellation and stale asynchronous work.
- Improve usability and performance within the agreed scope. Propose a place
  for additional improvements before implementing them.
- Preserve existing optimization gains. Measure relevant CPU time, heap use,
  allocations, copying, input latency, database work and filesystem I/O on
  representative workloads. Keep correctness, source precision and supported
  capacity intact; reducing coverage or limits is a behavior change.
- Breaking changes are permitted within the agreed scope. Remove obsolete
  internal paths instead of maintaining duplicate implementations. Iris has
  released versions: identify effects on stored projects, database schemas,
  archives, APIs and deployment configuration. Update code, tests, UI and
  contracts together, and specify migration or explicit incompatibility handling.
  Do not erase user data to make an upgrade succeed.

## Reuse before building

- Prefer existing repository components and proven libraries or tools. Inspect
  their contracts before adding another parser, persistence layer, scheduler,
  transport or UI abstraction.
- Build custom software when concrete requirements justify it. Record the
  alternatives evaluated, their limitations and the reason for the choice in
  the owning design document. Speculative future needs do not justify duplication.
- Use locked dependencies and review license compatibility. Keep `package.json`
  and `package-lock.json` consistent; update
  [third-party notices](THIRD_PARTY_NOTICES.md) when attribution changes.

## Method

1. Inspect the working tree and relevant code, documentation and tests. Preserve
   unrelated changes, local configuration and runtime data.
2. State the goal, affected files and verification before implementing. Keep
   small plans in the conversation; use a working plan for substantial work.
3. Ask for clarification when an unresolved requirement changes the result and
   the repository cannot answer it. For material design alternatives, explain
   the tradeoffs, recommend one with a reason and wait for the user's decision.
   Resolve routine implementation details through existing conventions.
4. Investigate defects before proposing fixes. Reproduce the failure, identify
   its cause and select a check that distinguishes the fix from the old behavior.
5. Implement the agreed scope with focused changes. Add abstractions, options
   and files only when the task needs them; keep dependent changes together.
6. Run the relevant verification and review the final diff for correctness,
   regressions, resource use and scope. Address review feedback against evidence.
7. Complete documentation cleanup and report the behavior delivered, commands
   run, observed results and remaining blockers. Do not equate test counts with
   product readiness.

### Skills and execution

- Load applicable skills before the work they govern. Use brainstorming for
  new behavior, systematic debugging for failures, planning and execution skills
  for substantial implementations, and review and verification skills before
  claiming completion. Scale the workflow to the task.
- Use test-driven development for behavior that needs regression coverage:
  observe a meaningful failure, implement the fix and verify it. Avoid tests
  that mirror implementation details or assert documentation wording. Reversible
  prose and low-impact cosmetic changes need proportionate checks.
- Delegate only when the user or applicable instructions request delegation.
  Give independent work clear ownership and verify the integrated result.
- Use an isolated worktree when the work requires isolation. Do not reset,
  discard or overwrite another task's changes. Create commits, tags and releases
  when the user requests them, rather than as a side effect of a skill.
- If a required skill or tool is unavailable, state the limitation and use the
  closest supported workflow. Do not claim to have used unavailable tooling.

## Architecture and programming practices

Use the [repository map](docs/development.md#repository-map) to locate owners.
Keep these boundaries unless the agreed design changes them:

- **Runtime:** Node.js 24+ and PostgreSQL 18+. Follow CommonJS conventions in
  the backend and scripts, and the surrounding browser module conventions in
  `public/`. Serve dependencies through the existing local import map and vendor
  allowlist. The application has no frontend bundling step.
- **Persistence:** follow the
  [persistence contract](docs/development.md#persistence-contract). Keep current
  source/assets in the filesystem and relational records/history in PostgreSQL.
  Use existing identity, authorization, revision and project-mutation helpers.
  Preserve transaction/compensation behavior and recovery evidence on failure.
  Coordinate schema changes through `src/database.js` and `db/schema.sql`.
- **Collaboration:** preserve the
  [server-authoritative stream](docs/development.md#collaboration-contract).
  Use live room text for saves, checkpoints and builds; reject stale work by
  document identity and revision. The current coordination model requires one
  Iris process per database/storage installation.
- **Compilation:** follow the
  [compiler contract](docs/development.md#compiler-contract). Compile isolated
  snapshots outside the project gate and publish complete build artifacts.
  Preserve argument validation, process/resource bounds, credential isolation
  and the documented native compiler trust boundary. Follow the
  [source-navigation contract](docs/source-navigation.md) for source/PDF mapping.
- **Editor languages:** for LaTeX and LilyPond, extend the shared CodeMirror/Lezer
  language service and its maintained trees. Keep highlighting, outline,
  completion, presence and editing on the shared contracts. Retain the separate
  BibTeX/RIS stream languages and bibliography policies. Preserve UTF-16
  coordinates, line endings, document generations, cancellation,
  partial/unavailable states and size guards.
  Edit grammar inputs and regenerate `parser.mjs` and `parser.terms.mjs` with
  `npm run build:languages`; do not patch generated parsers by hand.
- **UI:** reuse [color tokens](docs/ui-colors.md) and
  [measurement tokens](docs/ui-measurements.md). Preserve keyboard access, focus,
  read-only behavior, both themes and compact layouts. Route user-facing text
  through catalogs under `public/locales/`; follow [TRANSLATING.md](TRANSLATING.md).

Keep functions and modules focused on their existing responsibilities. Validate
external input at the boundary, use parameterized SQL and argument-array process
execution, and enforce permissions on the server. Preserve cancellation and
cleanup on error paths. Avoid swallowing errors or substituting empty content
for failed reads. Keep credentials, project contents and private paths out of
diagnostic output unless the task requires sanitized evidence.

## Verification

Use the [development runner](docs/development.md#run-the-tests). It creates an
isolated PostgreSQL cluster and storage; do not point tests at an existing Iris
installation. It requires an unprivileged POSIX user and PostgreSQL 18+ tools.

| Change or check | Command |
| --- | --- |
| Install locked dependencies | `npm ci` |
| Start a configured development instance | `npm run dev` |
| Default suite | `npm test` |
| Focused regression example | `node scripts/test.cjs test/project-mutations.test.js` |
| PostgreSQL integration | `npm run test:integration` |
| Browser behavior | `npm run test:browser` |
| Native source mapping | `npm run test:native` |
| Generated parser consistency | `npm run check:languages` |
| Native installation and recovery smoke | `node scripts/smoke.cjs --native --browser` |

- Select tests for the affected behavior, then run broader checks when the
  change crosses subsystem boundaries. After checks pass, repeat them only for
  new changes, failures or unresolved concerns.
- Use real PostgreSQL for database semantics. Check concurrency, stale revisions
  and compensation when changing persistence or collaboration.
- Test mounted controls for UI, focus, layout and editor interactions. Browser
  checks need an installed Chrome/Chromium; native checks need the tools listed
  in [browser and native gates](docs/development.md#browser-and-native-gates).
- Distinguish controlled fixtures from real compiler and browser evidence.
  Report skipped gates, missing tools, tested versions and platform limits.
  A disabled gate is not a passing test.
- Validate Markdown links, anchors, file paths, configuration names and command
  syntax for documentation changes. Exercise changed commands where applicable.
  Do not add application tests solely to check prose.

## Failure is an option

- State when the requested result cannot be implemented. Before concluding,
  examine plausible approaches and report each blocking constraint with evidence.
- Propose feasible alternatives, explain which requirements each delivers and
  ask the user to choose when the alternatives change scope or behavior.
- Label partial work and unresolved defects. Do not present a stub, hidden
  fallback, weakened test or reduced requirement as the requested implementation.

## Development language

- Use **English** for development: agent responses, documentation, plans,
  specifications, reports, reviews, comments, identifiers, diagnostic messages,
  commits and issue/PR titles and descriptions.
- Preserve technical identifiers, commands, payloads, hashes, measurements and
  evidence provenance when translating. Retain existing paths unless the user
  requests a rename. Product translations retain their target language.
- This section owns the development-language policy. Link here from other
  documents instead of defining another convention. Follow `TRANSLATING.md`
  for product localization mechanics.

## Writing and names

- Use the `stop-slop` skill for prose. Tell the user if you cannot load or use it.
- Make each sentence add information. Write facts, constraints, commands and
  examples; remove repetition and filler.
- Name the feature, subsystem, defect or decision. Use task and phase IDs as
  traceability references, not substitutes for meaningful names.
- Describe status through working capabilities, unfinished behavior, observed
  failures and remaining qualification. State each blocker's impact and cause;
  distinguish product defects from tooling failures and missing evidence.
- Name files, directories and symbols for their responsibility. Use
  `source-navigation-review.md`, not `phase8-review.md`. Dates may identify a
  design or plan; step identifiers must not replace its topic. Rename existing
  files only on request.

## Documentation ownership and cleanup

**Complete documentation cleanup before closing each task.** Apply it to the
documents created, used or superseded by the work, within the agreed scope.

- Keep one owner for each fact. Use [docs/README.md](docs/README.md) to find the
  appropriate user, installation, administration or subsystem guide. Link to
  that owner instead of copying its contract into plans and reports.
- Consolidate useful decisions, rationale, verification evidence, open issues
  and next actions into existing owner documents. Preserve evidence provenance.
- After preserving useful information, remove superseded working notes and
  redundant handoffs. Repair links and remove empty documentation directories.
  Investigate unfamiliar records before deleting them.
- Reuse existing files and directories. Create a document for a distinct
  responsibility, not for each task, restart, agent session or progress update.

## Normative documentation

Treat published guides and contracts under `docs/`, except `docs/superpowers/`,
as normative, together with `README.md`, `TRANSLATING.md` and
`public/templates/README.md`. A document labeled as a proposal does not authorize
implementation.

- Before creating, modifying or deleting normative documentation, state the
  change and reason and obtain user approval. An explicit request for that
  documentation change supplies approval for its stated scope.
- Use `docs/superpowers/` for working specifications, plans and reviews without
  separate approval. Follow the naming and cleanup rules above. This directory
  is Git-ignored; do not assume another checkout or source archive contains it,
  or force-add its contents without a user request.
- Do not change a normative requirement to conceal a failing implementation or
  test. Resolve the discrepancy with the user and update its owner document.
