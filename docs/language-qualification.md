# Language qualification: HP08

## Delivery assessment, 21 September 2026

**The reviewed implementation and latest technical gates pass within the approved
HP08 scope.** Independent task and final whole-branch reviews approve the technical
delivery and accept metric v2. The canonical plan records technical completion;
user-source and subjective visual acceptance remain explicit follow-ups.

The final whole-branch review then found F1: the LaTeX adapter had lost its line
comment metadata, disabling `Ctrl+/` / `Cmd+/`. The controller restored `%` in
`languageData`, added real-command regressions and passed the 93-case covering
gate and a fresh package smoke. Scoped re-review closes F1 and approves integration.
The matrix/profiles below retain their **pre-F1** source identity; the JSON's
`postQualificationCorrection` records the two changed runtime/test hashes.

The current implementation includes the real full-tree Worker, bounded incremental
prefix publication, text memo, local fonts, parser/summary headroom, POSIX browser
temp ownership, template focus correction and final TeX query optimization.

### Evidence and identities

- [Qualification data](language-qualification-data.json) contains the final 750
  edit samples/30 loads, publication identities, current profiles, Linux counts,
  candidate/source hashes, expanded delivery harness manifest and historical data.
- [Selected current strict traces](language-qualification-current-traces.json)
  bundles the actual cold TeX/LY and final warm-TeX trace inputs, with source paths
  and SHA-256s. Cold profiles precede the query-only change; the final warm profile
  exercises the changed query component.
- [Historical 19 September trace](language-qualification-trace.json) retains its
  events and now labels their historical scope. It is not the final profile.
- Generator/validator: `.drafts/hp08-delivery-evidence.cjs`; exact inputs and its
  SHA-256 are recorded in the data. It replays observations and checks identities,
  policies, TAP counts, source hashes and the unchanged index; it does not invent
  data or execute another matrix. Private raw logs remain in the retained worktree.

The final matrix is `.drafts/hp08-tex-summary-final-matrix/`, on uncommitted source
based on `2bdafe8b97f5c2f8f689e9bda142a0e0c7cd3e90`. Its **164-file tested
runtime/harness digest** is:

`cb4979bc09695867fb20eac4229b047ae52fb9e28aa27607928e7aa19d651f1d`

Before/after matrix manifests agree. The expanded **308-file delivery source and
test-harness manifest** includes the now-staged regression
`test/latex-summary.test.js`, SHA-256
`0b7dc13f873c5359c102fda93abc8d9b3e4e015991e69b3513c90a35c8cee649`.
At that delivery checkpoint, only `.gitattributes` metadata had changed among the
tested manifest entries. The later F1 delta is recorded above; the generated Worker
and fixture bytes remain unchanged. The pre-F1 expanded manifest digest is:

`fe7fcf7999f63db5387bac15dbb071ce01d4bbfe0c446205cebc9c7714a22419`

## Platforms and invocation scope

| Environment | Actual versions / configuration |
| --- | --- |
| Reference performance | Windows 11 Pro 10.0.22631; i7-1355U, 12 logical CPUs; RAM 33,974,161,408 bytes; Node 24.21.0; Chrome 153.0.8010.53; headless 1440×900, reduced motion; disposable PostgreSQL 18.4 |
| Linux functional/native | Linux 6.18.33.2-microsoft-standard-WSL2; 12 logical CPUs; RAM 16,578,646,016 bytes; nonroot uid/gid 1000; fresh extraction/dependencies, network none, 2 GiB shm |
| Linux toolchain | Node 24.21.0; npm 11.19.0; PostgreSQL 18.6 (`18.6-1.pgdg12+2`); Chromium 153.0.8010.52; LilyPond 2.26.0/Guile 3.0; pdfTeX 1.40.24/TeX Live 2022 Debian; Ghostscript 10.00.0 |

Linux image digest:
`sha256:cf02a51838e9633f404a73c7a1213728c45d10b87fd573d8c8b94706df09d90f`.
The image provides a `/opt/google/chrome/chrome` alias to installed Chromium for
legacy channel-based tests. Raw version outputs, tool provenance, commands,
candidate hashes and owned-resource cleanup evidence accompany each run.

**These are separate invocations on explicitly identified source versions. Do not
sum them as unique tests or describe them as one final-source full-suite run.**

| Gate | Pass | Fail | Disabled/platform skips | Source / evidence |
| --- | ---: | ---: | ---: | --- |
| Linux full Node | 1725 | 0 | 366 | `hp08-posix-20260921`, 2091 total tests |
| Linux later covering Node | 127 | 0 | 1 | `hp08-final-fixes-20260921`, 128 total; one Windows-only case |
| Linux final nine-file browser aggregate | 300 | 0 | 0 | `hp08-template-focus-20260921`, including UI 124/124 and 18/18 process-lifecycle cases |
| Linux native/source mapping | 12 | 0 | 0 | Later `hp08-final-fixes-20260921` run; two valid-subset and ten mapping cases |
| Linux source-navigation browser | 28 | 0 | 0 | `hp08-posix-20260921` |
| Windows final query covering | 208 | 0 | 0 | `hp08-tex-summary-covering-final`, includes the five `latex-summary` regressions |
| Windows final full performance matrix | 10 | 0 | 0 | `hp08-tex-summary-final-matrix`, 750 edits/600 measured/30 loads |
| Strict bounded feature profiles + policy tests | 5 | 0 | 0 | `hp08-final-feature-bounded`: three profiles plus two policy tests |
| Final changed-query warm-TeX strict profile | 1 | 0 | 0 | `hp08-tex-summary-profile-final` |
| Pre-F1 delivery package | 1 | 0 | 0 | `hp08-delivery-package`, including R1 regression |
| Final-review F1 covering | 93 | 0 | 0 | Editing commands, TeX corpus, state, transfer and summaries |
| Final-review package | 1 | 0 | 0 | `hp08-final-review-package`, includes F1 runtime and regression bytes |

The 366 full-Node skips comprise **353 disabled browser, 12 disabled native and one
package-qualification opt-in**. They are not passes. Windows filesystem/symlink
failures remain historical platform observations; their intended Linux cases ran.

### Exact relationship to the qualified matrix runtime

The Linux 300/300 archive has 336 files and SHA-256
`2103b41420a5a19f4eb33d4065f8362286242a991386e2db8dc6c1defc9b6589`.
Among its **162 common runtime/build/harness entries**, only
`public/languages/latex/queries.mjs` differs from the final matrix candidate.
That later allocation/ordering optimization has its own **208/208** coverage,
strict warm profile and full 10/10 matrix. The Linux 300/300 result is retained
with this caveat, not relabelled as a later-source rerun.

The initial full-Node/navigation candidate is
`45f9428b6c8099d15368264f4f8d3f23618a9a4181f937e4f7a671b49420d16a`;
the later covering/native candidate is
`59f31999022e7e66d4e623b1ce41aed1c6724a400636b0d1527cb645d54500a3`.
The recorded correction chain covers short private POSIX browser temp roots,
full-snapshot fixture synchronization, atomic peer-contrast sampling and immediate
template-create focus. Original assertions/deadlines and contrast targets remain.

The subsequent F1 correction changes only LaTeX language data for CodeMirror's
comment command. Grammar, query and Worker bytes are unchanged. Its regression
first failed in all three TeX profiles (7 pass / 3 fail, with LilyPond passing),
then passed within the **93/93** covering gate. It exercises the installed owner,
actual default-keymap command, comment/uncomment, undo/redo and readonly behavior.
The broad suites and performance matrix were not rerun for this metadata fix.

## Metric contract and final full matrix

Gate version remains **`hp08-v2-publication-edit-scope`**, accepted by the review.
Design §8 scopes >50 ms blocking to typing/feature-attributed work and states a
500 ms availability deadline. The unchanged checks are:

- Visible p95 ≤50 ms at 100 KiB, ≤100 ms at 1 MiB; first styled viewport ≤200 ms
  for each 1 MiB cold/warm load.
- **Every** normal 1 MiB edit, including warmups, must publish its current ready
  snapshot within 500 ms, including debounce. This is not just a p95 check.
- Any observed >50 ms task overlapping editing fails, including warmups, late
  observer delivery and a task originating during load. Load-only observations
  remain reported and feature work has separate strict 5/8 ms profiling.
- Actual `onSyntax` callback timestamps require matching kind/generation/revision,
  current snapshot identity and full coverage. Missing/stale publication fails.
  The later `summaryMs`/`summaryObservedMs` values, including extra animation frames,
  remain in the raw evidence. Unavailable 5 MiB results cannot supply a summary.

Tests mount real IrisApp/IrisEditor/CodeMirror. Local edits use the editor API;
remote edits use serialized ChangeSets through `collabReceive`. The unchanged
two-rAF paint definition follows the expected changed DOM role, with actual
source-character and remapped-offset checks. Network/transport and physical
keyboard/OS queue delay are outside these dispatch-to-visible measurements.

**Final outcome: 10/10, zero skips/cancellations; 750 edits, 600 measured, 30
loads.** Each workload/mode has five warmups plus twenty measured samples. All
600 normal edits produce actual ready events; 150 size-limited edits remain
unavailable. All **300 required 1 MiB publications** meet the deadline, maximum
**407.3 ms**. Every 1 MiB viewport meets 200 ms, maximum **58.5 ms**. There are no
observed edit-overlapping long tasks.

Milliseconds are **local / remote / head-context**. P95 uses the twenty measured
samples; the maximum includes all modes and warmups.

| Workload | Visible p95 | Actual ready-publication p95 | All-publication max |
| --- | --- | --- | ---: |
| TeX 100 KiB | 29.3 / 28.3 / 29.0 | 269.2 / 268.5 / 266.9 | 276.5 |
| LilyPond 100 KiB | 29.0 / 28.5 / 38.6 | 272.8 / 276.5 / 275.8 | 280.4 |
| TeX stress 1 MiB | 29.8 / 28.4 / 33.9 | 384.4 / 398.1 / 388.2 | 405.3 |
| LilyPond stress 1 MiB | 27.5 / 30.8 / 46.7 | 374.0 / 379.0 / 394.8 | 407.3 |
| TeX representative 1 MiB | 29.2 / 29.6 / 32.9 | 334.6 / 331.6 / 329.6 | 340.8 |
| LilyPond representative 1 MiB | 29.1 / 28.3 / 42.2 | 322.4 / 328.1 / 326.0 | 334.6 |
| TeX 100 KiB single line | 30.1 / 32.6 / 29.9 | 272.4 / 277.4 / 280.0 | 281.4 |
| LilyPond 100 KiB single line | 29.7 / 39.3 / 42.2 | 273.5 / 275.3 / 278.0 | 278.9 |
| TeX 5 MiB | 28.1 / 28.6 / 30.2 | unavailable | n/a |
| LilyPond 5 MiB | 29.1 / 29.1 / 29.6 | unavailable | n/a |

The simultaneous **legacy whole-window replay is 8/10**, retaining the **60 ms
TeX / 66 ms LilyPond neutral cold-load tasks**, both with zero LR starts. It is not
a claim that all startup tasks stay below 50 ms. Actual full load/reload readiness
still reaches **3742.1 ms**. The matrix waits for full readiness before its edits;
it does not establish arbitrary typing-during-cold-load or hard real-time behavior.

### Unchanged workloads

| Source | UTF-8 bytes | UTF-16 units | Lines |
| --- | ---: | ---: | ---: |
| TeX / LilyPond 100 KiB | 102400 | 94528 / 95798 | 3940 / 3306 |
| TeX stress 1 MiB | 1048576 | 967922 | 40331 |
| LilyPond stress 1 MiB | 1048576 | 980930 | 33828 |
| Representative 1 MiB, each | 1048576 | 1008582 | 20000 |
| TeX 5 MiB | 5242880 | 4839586 | 201651 |
| LilyPond 5 MiB | 5242880 | 4904634 | 169128 |
| TeX / LilyPond single line | 102400 | 94528 / 95798 | 1 |

HP01 stress sources and separately named representative sources are original
synthetic examples. The 1,048,576-unit guard, generators and source assertions
were not weakened. User projects remain separate acceptance material.

## Strict feature profiles

| Applicable profile | Initial prefix max, 5 ms | Scheduled parse max, 5 ms | Query max, 5 ms | Largest application task group, 8 ms | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Cold TeX, `hp08-final-feature-bounded` | 3.7 | 3.1 | 0.6 | 6.1 | Pass |
| Cold LilyPond, same run | 3.6 | 3.2 | 0.4 | 5.5 | Pass |
| Final changed-query warm TeX, `hp08-tex-summary-profile-final` | 3.8 | 3.1 | 0.5 | 5.5 | Pass |

These profiles include applicable load-phase work, actual context queries,
preparation, transfer/decode, summary and publication. All nonempty completed main
LR trees have real stopped-prefix coverage. The final warm query path records
305 summary turns with maximum 5.5 ms. The full tree still runs in the real Worker.

Cold profiles precede the final query-only optimization; the latest warm profile
and 208-test gate cover that changed component. Their finite instrumented results
support the reviewed technical verdict, not a universal elapsed-time guarantee.
Earlier failures remain failures: the unexplained 11.5 ms event, intermediate
source-preparation overruns and a later 13.5 ms turn containing a measured
12.412 ms MinorGC. GC attribution is not subtraction or a budget waiver. The final
passing run followed another demonstrated allocation correction, not an
unchanged-code retry with omitted samples.

## Lifecycle, fonts and native examples

- Linux 300/300 includes the real 100-project/200-file lifecycle. All 200 retired
  document/tree WeakRefs are collected; comparable active-language heap at 50/100
  switches is **12,877,812→13,174,660 bytes**, growth **296,848 bytes**. All **100/100
  Workers close**, peak one, zero after close. Peer/cursor/theme-only updates
  preserve tree/snapshot identity with zero LR starts and no stale publication.
- Actual cache deletion, same-path reuse, configuration/profile replacement,
  cancellation and popup checks pass. Worker transfer/corpus evidence includes
  107 signatures and 14 retained large Group identities. The separate modified
  restore proof performs 1170 real advances with `cacheHit=false`; its standalone
  136.6/194.6 ms tree/summary times exclude editor debounce and are not cold-throughput claims.
- Local fonts retain 30 pinned binaries (919,740 bytes), full OFL texts, 42 loaded
  faces and matching local HTTP MIME/hash checks. The 300-case Linux aggregate
  includes fonts and both-theme emitted-role/selection/peer/search/bracket tests.
  The contract remains 4.5:1 for text; retained Windows role minima are
  4.582:1 dark / 4.708:1 light. Palette values were not changed to fix the audit.
- Native 12/12 includes four original/formatted valid-subset PDF compilations,
  protected text/source-row checks and ten mapping cases. TeX uses explicit
  `article`/`amsmath` wrappers; LilyPond uses explicit score/staff wrappers.
  Invalid/dynamic/missing-asset fixtures are not presented as compilable. Compilers
  validate those examples, not the highlighting colors.

## Source package scope

The earlier successful `hp08-v2-package` proof had **334 files**, SHA-256
`efbc5ad20fce9503b8afa42e8188caebf1182aef9ff1d4cec80b04e1e167bf58`.
Its actual production server, Worker, fonts, zero-external-request checks and
identical generation passed. It is **historical**, not an exact final-runtime
archive: `iris-admin-templates.js`, `iris-language-parser.mjs`,
`iris-language-state.mjs`, `languages/latex/queries.mjs`, `scripts/lib/browser.cjs`
and `scripts/lib/disposable.cjs` subsequently changed with the coverage above.

The **pre-F1 `hp08-delivery-package` smoke passes 1/1**, zero failures/skips/cancellations,
on **338 source files** from that checkpoint, including the exact R1 regression.
Candidate SHA-256:
`410353fc9aa8f7296be9c36a9d540171f387401dc363880a05b6a4315558dacc`.
Its per-file inventory and actual production/browser/font evidence are in
`.drafts/hp08-delivery-package/package.json` and the published data. Production
installs require neither generator nor esbuild; fresh dev installs regenerate all
four parser and two Worker files identically. The real production server and
Workers start; 42 font faces and 30 local HTTP font responses load with matching
hashes/MIME, and external requests remain empty. No workspace `npm ci`, Git
metadata or ancestor dependencies supply the extracted runtime. The retained
archive is beside the manifest. Later report-only updates are outside its hash;
its runtime/harness bytes precede F1 and remain preserved in that artifact.

After F1, **`hp08-final-review-package` passes 1/1**, zero failures/skips/cancellations,
on **338 source files**, SHA-256
`752bf2e89fe7619c635586562d268a3a1f31fd426aeff4145352654250ccf76a`.
The same smoke verifies production startup, real Worker/local fonts, no external
requests and identical parser/Worker regeneration. The controller checked all
338 file hashes and the archive hash after the run. Relative to the pre-F1
archive, only `public/languages/latex/index.mjs` and `test/language-editing.test.js`
differ outside documentation. The published JSON records those before/after
hashes and the retained manifest/TAP hashes. Later report-only updates are outside
the archive identity. The driver confirmed removal of its cluster and storage.

## Historical evidence and delivery hygiene

The data's historical sections retain prior matrices, profiles and platform runs,
including September 19's 10/10 matrix with **463.5/116.5 ms** maxima, the older
314–537 ms visible delays, Worker 5/5 split, integrated 3/7 split and later 9/10
pre-query matrix. The latter had actual publication misses 522.1, 581.0, 544.8 and
500.9 ms. The failed Linux browser aggregates **284/295, 294/295 and 296/297** remain
recorded alongside their subsequent corrections and the final 300/300. None is
retroactively relabelled as a pass. Earlier Windows skips/failures remain platform
history, not a reason to call the now-executed Linux gates pending.

R3 preserves byte-identical generated output and significant native literal
spaces. `.gitattributes` disables only `blank-at-eol` for these **two exact paths**:

```gitattributes
public/vendor/language-worker/worker.mjs whitespace=-blank-at-eol
test/language-qualification.native.test.js whitespace=-blank-at-eol
```

Other whitespace checks remain enabled. The initial cached diff check exited 2
on three generated blank lines and one protected literal line. After the delivery
correction, the controller staged the exact-path attributes, the refreshed
evidence (including the current traces) and the R1 regression. Both working-tree
and cached diff checks pass. The generated Worker and literal fixture were not
edited.

## Reproduction and follow-up

Raw inputs: `.drafts/hp08-tex-summary-final-matrix/`,
`.drafts/hp08-tex-summary-profile-final/`, `.drafts/hp08-final-feature-bounded/`,
`.drafts/hp08-posix-20260921/`, `.drafts/hp08-final-fixes-20260921/` and
`.drafts/hp08-template-focus-20260921/`. Exact commands and image/source versions
are in the published data and session reports. The delivery generator records
input hashes and publishes credential-safe evidence; private raw logs are retained.

The retained `hp08-delivery-evidence.cjs --final` command validates the delivery
agent's sealed, **pre-staging** index as well as its raw inputs. Its `indexSnapshot`
and `whitespace` metadata record that checkpoint. After the controller's index
refresh, use that seal as historical evidence; rerunning the command against the
new index would reject the intentional staging changes. Current source generation,
font and diff checks are:

```text
npm run check:languages
npm run check:language-worker
node scripts/vendor-fonts.cjs
git diff --check
git diff --cached --check
```

The reference performance matrix and broad suites were not gratuitously rerun for
this documentation/attribute correction. Final review approves the technical
delivery. Three representative TeX and three LilyPond user projects and
subjective visual acceptance are still follow-ups. HP09 customization remains an
assessment: palette changes are CSS-only; custom names need a context-aware layer.
