// Guards the hardening invariants: the places where an expensive operation has
// to be behind an admission control, and where a deletion has to be provably
// unable to remove the wrong thing. These are cheap to break by editing an
// unrelated handler and expensive to notice — an unthrottled password check
// looks exactly like a throttled one until somebody points a load generator at
// it, and a retention sweep that drops one row too many looks like nothing at
// all until the row is wanted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const server = read("src/server.js");
const schema = read("db/schema.sql");
const section = (from, to) => server.slice(server.indexOf(from), server.indexOf(to));

/* ---- admission control ---- */

test("every Argon2 call in the process is behind the concurrency gate", () => {
  // The ceiling is only a ceiling if nothing can reach Argon2 around it, so the
  // hashing functions are the only callers and both go through the gate.
  const calls = server.match(/argon2\.(hash|verify)\(/g) || [];
  assert.equal(calls.length, 2, `expected exactly one hash and one verify, found ${calls.length}`);
  const hash = section("async function hashPassword", "async function verifyPassword");
  assert.match(hash, /withPasswordHashSlot\(\(\) => argon2\.hash/);
  const verify = section("async function verifyPassword", "function oauthEnabled");
  assert.match(verify, /withPasswordHashSlot\(async \(\) => \{/);
  // A malformed stored hash costs nothing and must not be able to occupy a slot.
  assert.ok(
    verify.indexOf('if (!hash.startsWith("$argon2"))') < verify.indexOf("withPasswordHashSlot"),
    "the cheap rejection must happen before a slot is taken"
  );
});

test("login is throttled before it touches the database or the hasher", () => {
  const login = section('if (req.method === "POST" && url.pathname === "/api/auth/login")', 'if (req.method === "POST" && url.pathname === "/api/auth/password")');
  const ipLimit = login.indexOf("enforceRateLimit(authIpLimiter");
  const accountLimit = login.indexOf("enforceRateLimit(authAccountLimiter");
  const query = login.indexOf("db.query");
  assert.ok(ipLimit !== -1 && accountLimit !== -1, "both limiters must be charged");
  assert.ok(ipLimit < query && accountLimit < query, "refuse the work rather than doing it and complaining after");
  // The address limit precedes even reading the body: pulling up to MAX_BODY
  // from a caller already over its allowance is work done for someone refused.
  assert.ok(ipLimit < login.indexOf("await readBody(req)"), "the address limit must precede reading the body");
  // admission-control.test.js exercises submitted-identifier normalization,
  // bounded key retention and debt reset through real HTTP/PG/Argon2 behavior.
  // A failure costs more than a success, and a success clears the debt.
  assert.match(login, /authIpLimiter\.penalize\(`login:\$\{ip\}`, Date\.now\(\), AUTH_FAILURE_PENALTY - 1\)/);
  assert.match(login, /authIpLimiter\.reset\(`login:\$\{ip\}`\)/);
});

test("compilation is bounded in both rate and simultaneity", () => {
  const compile = section("async function compileProject", "/* ---------------- retention and garbage collection");
  // Rate limited after authorization, so an outsider probing the endpoint
  // cannot consume a member's allowance.
  const authorize = compile.indexOf('authorizeProject(id, user, "compile")');
  const rate = compile.indexOf("enforceRateLimit(compileLimiter");
  assert.ok(authorize !== -1 && rate > authorize, "the allowance belongs to members, not to callers");
  // The slot is taken before anything durable exists, so a refused caller leaves
  // nothing behind for the reconciler to clean up.
  const slot = compile.indexOf("await compileGate.acquire()");
  assert.ok(slot !== -1, "compilation must hold a concurrency slot");
  // Staging copies the effective saved bytes, not the sparse client snapshot.
  // Admission still precedes every durable setup step, including the save.
  for (const operation of [
    "projectMutations.transaction(", "await fs.mkdir(path.dirname(stagingDir)",
    "await ensureProjectDirs(stagingDir", "await fs.writeFile(dest, bytes)", "await createBuildOutput(",
  ]) {
    const position = compile.indexOf(operation);
    assert.notEqual(position, -1, `missing durable setup step: ${operation}`);
    assert.ok(slot < position, `${operation} must wait for a concurrency slot`);
  }
  // And it is always given back.
  assert.match(compile, /\} finally \{\s*\n\s*activeBuilds\.delete\(buildId\);\s*\n\s*releaseCompileSlot\(\);/);
});

test("authenticated traffic has a ceiling keyed on the account", () => {
  const api = section("  const user = await requireUser(req);\n\n  // A ceiling on authenticated traffic", "if (url.pathname.startsWith(\"/api/admin/\"))");
  assert.match(api, /enforceRateLimit\(apiLimiter, `api:\$\{user\.sub\}`, "API_RATE_LIMITED"\)/);
  assert.ok(api.indexOf("await requireUser(req)") < api.indexOf("enforceRateLimit(apiLimiter"));
});

test("a refusal tells the client when to come back", () => {
  const helper = section("function rateLimitError", "// Charges a limiter and refuses");
  assert.match(helper, /"retry-after": String\(seconds\)/);
  // Never zero: a client told to wait no time at all retries immediately, which
  // is a busy loop rather than a backoff.
  assert.match(helper, /Math\.max\(1, Math\.ceil\(retryAfterMs \/ 1000\)\)/);
  // The header actually reaches the response.
  assert.match(server, /errorJson\(res, status, err\.errorCode \|\| "SERVER_ERROR", err\.params \|\| \{\}, err\.headers \|\| \{\}\)/);
  for (const code of ["AUTH_RATE_LIMITED", "API_RATE_LIMITED", "COMPILE_RATE_LIMITED", "COMPILE_SERVER_BUSY", "AUTH_BUSY"]) {
    for (const locale of ["en", "it"]) {
      assert.match(read(`public/locales/${locale}/translation.json`), new RegExp(`"${code}"`), `${code} is missing from ${locale}`);
    }
  }
});

test("a realtime connection cannot pin unbounded memory", () => {
  const join = section("async function collabJoin", "function collabLeave");
  assert.match(join, /if \(session\.rooms\.size >= COLLAB_MAX_ROOMS_PER_SESSION\) throw new CollabError\("COLLAB_TOO_MANY_ROOMS"\)/);
  const upgrade = section("async function collabUpgrade", "function collabAttach");
  // Counted per account, so it holds for someone behind a shared address and
  // cannot be evaded by reconnecting from elsewhere.
  assert.match(upgrade, /existing\.user && existing\.user\.sub === user\.sub/);
  assert.match(upgrade, /if \(sessionsForUser >= COLLAB_MAX_SESSIONS_PER_USER\)/);
});

/* ---- realtime coalescing ---- */

test("presence fan-out is answered on a tick rather than per message", () => {
  // The quadratic version answered every report with a message to everyone
  // else; the tick makes a burst cost one broadcast.
  const scheduler = section("function collabSchedulePeers", "/* ---- presence: which of the project's files");
  assert.match(scheduler, /if \(room\.peersTimer\) return;/);
  assert.match(scheduler, /COLLAB_PEERS_TICK_MS/);
  // The peer objects are built once per broadcast, not once per recipient.
  const broadcast = section("function collabBroadcastPeers", "// Presence reports arrive continuously");
  assert.match(broadcast, /const all = collabRoomPeers\(room\)/);
  assert.equal((broadcast.match(/collabRoomPeers\(/g) || []).length, 1);
});

test("the project row is touched once per interval, not once per room per flush", () => {
  const persist = section("async function collabPersistNow", "// Marks the project modified");
  // Flushes must re-read canonical identity so a deleted or renamed room cannot
  // write its old path. Timestamp writes, not identity reads, are coalesced.
  assert.match(persist, /db\.query\(\s*"SELECT f\.path, f\.kind, p\.storage_path/);
  assert.doesNotMatch(persist, /\b(?:UPDATE|INSERT|DELETE)\b/i, "the flush path must not write to the database directly");
  assert.match(persist, /collabScheduleTouch\(room\.projectId\)/);
  const touch = section("function collabScheduleTouch", "// Consolidates the realtime edits");
  assert.match(touch, /if \(state\.touchTimer \|\| maintenance \|\| shuttingDown\) return;/);
  assert.match(touch, /COLLAB_TOUCH_MS/);
});

test("realtime revisions are consolidated per project, and attribution survives it", () => {
  const capture = section("async function collabCaptureRevisions", "// Debounced persistence");
  // One checkpoint for every dirty room of the project: captureProjectCheckpoint
  // takes a per-project advisory lock, so one call is one lock instead of one
  // lock per open document.
  assert.equal((capture.match(/captureProjectCheckpoint\(/g) || []).length, 1);
  assert.match(capture, /files: dirty\.map\(\(room\) => \(\{/);
  // Each file names its own author, so grouping cannot credit one person's work
  // to whoever happened to be first in the list.
  assert.match(capture, /author: room\.lastAuthor/);
  assert.match(server, /user: file\.author \|\| user/);
  // The version is read before the write and applied after it, so edits landing
  // mid-checkpoint are caught by the next one instead of being lost.
  assert.match(capture, /const captured = dirty\.map\(\(room\) => \(\{ room, version: room\.version \}\)\)/);
  assert.ok(
    capture.indexOf("const captured") < capture.indexOf("await captureProjectCheckpoint"),
    "the version must be sampled before the write, not after"
  );
});

test("shutdown flushes every coalesced timer instead of dropping its work", () => {
  const shutdown = section("async function drainCollabWritesNow", "// The two ways a project comes into existence");
  for (const timer of ["touchTimer", "revisionTimer", "presenceTimer"]) {
    assert.match(shutdown, new RegExp(`clearTimeout\\(state\\.${timer}\\)`), `${timer} must be cancelled`);
  }
  // A pending timestamp is written now: deferred work at shutdown is lost work.
  // The runtime tests cover stable draining, failed touches and late room work.
  assert.match(shutdown, /await collabTouchProject\(projectId\)/);
  assert.match(shutdown, /await drainCollabWrites\(\)/);
});

/* ---- retention ---- */

test("both halves of the rule are required before anything is deleted", () => {
  const versions = section("async function pruneProjectVersions", "// The same double condition for builds");
  assert.match(versions, /ranked\.position > \$2 AND ranked\.created_at < \$3/);
  assert.match(versions, /ROW_NUMBER\(\) OVER \(PARTITION BY dv\.file_id ORDER BY dv\.created_at DESC, dv\.id DESC\)/);
  const builds = section("async function pruneProjectBuilds", "// Directories under output/");
  assert.match(builds, /ranked\.position > \$2\s*\n\s*AND ranked\.created_at < \$3/);
});

test("the sweep can never delete a file's current content or a project's last output", () => {
  const versions = section("async function pruneProjectVersions", "// The same double condition for builds");
  // The newest revision has position 1 and the keep floor is well above it, so
  // the current state of a file is out of reach by construction.
  assert.match(versions, /position/);
  const { RETENTION_BOUNDS } = require("../src/retention");
  assert.ok(RETENTION_BOUNDS.versionKeep.min > 1, "the keep floor must exceed the newest row's rank");
  assert.ok(RETENTION_BOUNDS.buildKeep.min > 1);

  const builds = section("async function pruneProjectBuilds", "// Directories under output/");
  // The most recent successful build survives whatever its age: it is what the
  // editor restores when the project is reopened.
  assert.match(builds, /protected_build AS \(/);
  assert.match(builds, /b\.id NOT IN \(SELECT id FROM protected_build\)/);
  // A build still running owns its directory and is excluded outright.
  assert.match(builds, /WHERE project_id = \$1 AND status <> 'running'/);
});

test("rows go before bytes, so a failure leaves nothing the interface will offer", () => {
  const builds = section("async function pruneProjectBuilds", "// Directories under output/");
  assert.ok(
    builds.indexOf("DELETE FROM build_outputs") < builds.indexOf("fs.rm"),
    "the row must be gone before its directory is"
  );
  // A path the safety checks refuse is left alone rather than removed on a guess.
  assert.match(builds, /resolveBuildDirectory\(\s*\n?\s*storageDir, build\.id, build\.storage_path \|\| buildStoragePath\(build\.id\)\s*\n?\s*\)\.catch\(\(\) => null\)/);
});

test("interrupted builds are closed, but never another instance's live work", () => {
  const reconcile = section("async function reconcileStalledBuilds", "// Both halves of the rule");
  assert.match(reconcile, /WHERE status = 'running' AND created_at < \$1/);
  // The grace period is what makes this safe against a slow compilation and
  // against a second instance sharing the database.
  assert.match(server, /const STALLED_BUILD_GRACE_MS = Math\.max\(COMPILE_TIMEOUT_MS \* 4, 5 \* 60 \* 1000\)/);
});

test("abandoned directories are only removed once nothing can still claim them", () => {
  const orphans = section("async function pruneOrphanedBuildDirectories", "// Staging trees belong to a compilation");
  assert.match(orphans, /if \(now - stat\.mtimeMs < RETENTION_ORPHAN_GRACE_MS\) continue;/);
  assert.match(orphans, /if \(!stat \|\| stat\.isSymbolicLink\(\)\) continue;/);
  // A directory is only removed when the database confirms no build claims it.
  assert.match(orphans, /SELECT id FROM build_outputs WHERE project_id = \$1 AND id = ANY\(\$2::uuid\[\]\)/);
  assert.match(orphans, /if \(known\.has\(name\)\) continue;/);
  const staging = section("async function pruneAbandonedStaging", "// The audit trail is instance-wide");
  // A compilation in flight owns its staging tree, whatever its timestamp says.
  assert.match(staging, /activeBuilds\.has\(build\.name\)/);
  assert.match(staging, /RETENTION_ORPHAN_GRACE_MS/);
});

test("the sweep is resilient: one broken project cannot stop the rest", () => {
  const sweep = section("async function runRetentionSweep", "function startRetentionSweep");
  assert.match(sweep, /if \(retentionSweepRunning \|\| shuttingDown \|\| maintenanceActive\(\)\) return null/);
  assert.match(sweep, /catch \(err\) \{\s*\n\s*console\.error\(`Retention: sweep failed for project \$\{row\.id\}`/);
  assert.match(sweep, /if \(shuttingDown\) break/);
  // Nothing in the sweep is allowed to be the reason a request fails.
  assert.match(sweep, /\.finally\(\(\) => \{ retentionSweepRunning = false; \}\)/);
});

test("audit retention is the operator's alone, and deleted in batches", () => {
  const audit = section("async function pruneAuditEvents", "let retentionSweepTimer");
  assert.match(audit, /AUDIT_RETENTION_DAYS/);
  assert.match(audit, /LIMIT \$2/, "the highest-volume table must not be deleted in one unbounded statement");
  // The per-project settings deliberately do not include it.
  assert.doesNotMatch(section("async function updateProject", "async function deleteProject"), /audit_days/);
});

test("retention thresholds are an owner decision, recorded in the trail", () => {
  const update = section("async function updateProject", "async function deleteProject");
  assert.match(update, /row\.role === "owner"\s*\n\s*\? normalizeRetentionInput\(body\.retention, RETENTION_CAPS\)\s*\n\s*: \{\}/);
  assert.match(update, /action: "project\.retention_changed"/);
  // An editor saving the document is ignored rather than refused, so an
  // ordinary save never turns into a permission error.
  assert.doesNotMatch(update, /RETENTION_FORBIDDEN/);
});

test("the schema keeps null meaning 'follow the instance default'", () => {
  for (const column of ["build_keep", "build_days", "version_keep", "version_days"]) {
    assert.match(schema, new RegExp(`${column} INTEGER,`), `${column} must be nullable`);
    assert.match(schema, new RegExp(`${column} IS NULL OR`), `${column}'s check must admit null`);
  }
  // The floors in the schema mirror the module's, so a value written outside the
  // application still cannot express "keep nothing".
  const { RETENTION_BOUNDS } = require("../src/retention");
  assert.match(schema, new RegExp(`build_keep >= ${RETENTION_BOUNDS.buildKeep.min}`));
  assert.match(schema, new RegExp(`version_keep >= ${RETENTION_BOUNDS.versionKeep.min}`));
  // The partial indexes the sweep relies on.
  assert.match(schema, /CREATE INDEX idx_build_outputs_running ON build_outputs \(created_at\) WHERE status = 'running'/);
});

test("the sweep is scheduled, unref'd, and stopped on shutdown", () => {
  const start = section("function startRetentionSweep", "const PROJECT_ROUTE");
  assert.match(start, /if \(!RETENTION_ENABLED\)/);
  // Interrupted builds are reconciled at once; everything else waits, because
  // startup is when the process can least spare the I/O.
  assert.match(start, /reconcileStalledBuilds\(\)\.catch/);
  assert.match(start, /retentionSweepTimer = setInterval/);
  assert.match(start, /retentionSweepTimer\.unref === "function"/);
  assert.match(server, /startRetentionSweep\(\);/);
  const shutdown = section("function startGracefulShutdown", "if (require.main === module)");
  assert.match(shutdown, /clearInterval\(retentionSweepTimer\)/);
  assert.match(shutdown, /compileGate\.drain\("COMPILE_SERVER_BUSY"\)/);
  assert.match(shutdown, /passwordHashGate\.drain\("AUTH_BUSY"\)/);
});

/* ---- the settings panel ---- */

test("the retention panel takes its bounds from the server", () => {
  const app = read("public/iris-app.js");
  const render = app.slice(app.indexOf("function renderRetention"), app.indexOf("// A field left empty goes back"));
  // The client never hard-codes a limit only the server knows.
  assert.match(render, /input\.min = bounds\.min/);
  assert.match(render, /input\.max = bounds\.max/);
  assert.doesNotMatch(render, /\b(20|30|100|180|200|365|1000|1095)\b/, "no threshold may be written into the client");
  // Empty is a real choice, and it is the one that follows the server default.
  assert.match(render, /pending === null \|\| pending === undefined \? "" : String\(pending\)/);
  // Without a project there is nothing to describe, so the control stays inert
  // rather than showing invented numbers.
  assert.match(render, /input\.disabled = !bounds \|\| !owner/);
});

test("retention is an owner control, and losing the role closes it in place", () => {
  const app = read("public/iris-app.js");
  assert.match(app, /function applyRoleGate\(\)[\s\S]*?renderRetention\(\);/);
  const handler = app.slice(app.indexOf("function onRetentionInput"), app.indexOf("function openSettings"));
  assert.match(handler, /if \(!bounds \|\| state\.role !== "owner"\) return/);
  // A settings-only change must save even when autosave is disabled.
  assert.match(handler, /void persistWhenDocumentClean\(\)/);
  assert.doesNotMatch(handler, /schedulePersist\(\)/);
});

test("the panel shows what the server stored, not what was asked for", () => {
  const projects = read("public/iris-projects.js");
  const persist = projects.slice(projects.indexOf("function mutateCurrent"), projects.indexOf("async function persistCurrent"));
  // Snapshot and retention are captured together when the mutation owns the
  // queue, after previous acknowledgements have advanced the revision.
  const queue = persist.indexOf("return enqueueMutation(async () =>");
  const snapshot = persist.indexOf("window.IrisApp.capturePersistence()");
  const retention = persist.indexOf("window.IrisApp.pendingRetention()");
  const request = persist.indexOf("out = await api(");
  assert.ok(
    queue >= 0 && snapshot > queue && retention > snapshot && request > retention,
    "capture the current settings with their revision inside the queue, before sending"
  );
  assert.match(persist, /if \(retention\) body\.retention = retention/);
  assert.match(persist, /window\.IrisApp\.applyRetention\(out\.retention, retention\)/);
  // A save landing after the project was reopened must not write into the new one.
  assert.match(persist, /if \(!isCurrent\(\) \|\| snapshot\.generation !== window\.IrisApp\.capturePersistence\(\)\.generation\) throw staleSession\(\)/);
  assert.match(persist, /revision !== snapshot\.data\.revision \+ 1/);
  const acknowledge = persist.indexOf("if (snapshot) acknowledge(");
  assert.ok(acknowledge > request && acknowledge < persist.indexOf("window.IrisApp.applyRetention("));
});

test("opening a project replaces the retention state instead of inheriting it", () => {
  const app = read("public/iris-app.js");
  assert.match(app, /state\.retention = data\.retention && typeof data\.retention === "object" \? data\.retention : null;\s*\n\s*state\.retentionPending = null;/);
});

test("both locales carry every retention string the panel renders", () => {
  const html = read("public/Iris.html");
  const settings = html.slice(html.indexOf('id="settingsPanelStorage"'), html.indexOf('data-setpane="language"'));
  const keys = Array.from(settings.matchAll(/data-i18n="([^"]+)"/g), (match) => match[1]);
  assert.ok(keys.length >= 6, `expected the panel to be localized, found ${keys.length} keys`);
  for (const locale of ["en", "it"]) {
    const translation = JSON.parse(read(`public/locales/${locale}/translation.json`));
    for (const key of keys.concat(["settings.retentionHintCount", "settings.retentionHintDays"])) {
      const value = key.split(".").reduce((node, part) => (node == null ? node : node[part]), translation);
      assert.equal(typeof value, "string", `${key} is missing from ${locale}`);
    }
  }
});
