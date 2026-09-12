const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const argon2 = require("argon2");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");

const options = { skip: !connectionString, timeout: 30000 };
const password = "admission-test-password";
const hashOptions = { type: argon2.argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 };
const generousAuth = { AUTH_RATE_LIMIT: "100", AUTH_ACCOUNT_RATE_LIMIT: "100", TRUST_PROXY: "true" };

async function until(predicate, label, ms = 4000) {
  const deadline = performance.now() + ms;
  while (!await predicate()) {
    assert.ok(performance.now() < deadline, `Timed out: ${label}`);
    await delay(5);
  }
}

async function within(promise, label, ms = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function pause(f, name, matches = () => true) {
  const entered = deferred(), released = deferred();
  const hook = async (...args) => {
    if (!matches(...args)) return;
    delete f.hooks[name];
    entered.resolve();
    await released.promise;
  };
  f.hooks[name] = hook;
  return {
    wait: (pending) => within(pending ? Promise.race([entered.promise, pending.then((r) => {
      throw new Error(`HTTP ${r.status} before ${name}`);
    })]) : entered.promise, name),
    release() { if (f.hooks[name] === hook) delete f.hooks[name]; released.resolve(); },
  };
}

async function user(f, username, role = "regular") {
  return (await f.pool.query(`INSERT INTO users (id, username, email, display_name, system_role, password_hash)
    VALUES ($1, $2, $3, $2, $4, $5) RETURNING *`,
  [uuidv7(), username, `${username}@example.test`, role, await argon2.hash(password, hashOptions)])).rows[0];
}

const login = (f, username, { ip = "192.0.2.1", secret = "wrong-password", raw } = {}) => fetch(`${f.baseUrl}/api/auth/login`, {
  method: "POST", signal: AbortSignal.timeout(15000),
  headers: { "content-type": "application/json", "x-forwarded-for": ip },
  body: raw ?? JSON.stringify({ username, password: secret }),
});
const reset = (f, admin, target) => f.request(`/api/admin/users/${target.id}/reset-password`, {
  method: "POST", cookie: f.cookieFor(admin),
});
async function refused(response, status, code, retryAfter) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.errorCode, code);
  assert.equal(response.headers.get("set-cookie"), null);
  if (status === 429) {
    assert.match(response.headers.get("retry-after"), /^[1-9]\d*$/);
    assert.equal(body.params.retryAfter, Number(response.headers.get("retry-after")));
    if (retryAfter !== undefined) assert.equal(body.params.retryAfter, retryAfter);
  }
  return body;
}
function clock(t) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return (ms) => { now += ms; };
}
function observeAuth(f) {
  const observed = { queries: 0, verifies: 0, hashes: 0 };
  f.hooks.beforeQuery = () => { observed.queries++; };
  f.hooks.beforeVerify = () => { observed.verifies++; };
  f.hooks.beforeHash = () => { observed.hashes++; };
  return observed;
}
async function authState(f) {
  return {
    users: (await f.pool.query("SELECT id, password_hash, session_version, last_login_at FROM users ORDER BY id")).rows,
    audits: (await f.pool.query("SELECT * FROM audit_events ORDER BY id")).rows,
  };
}

// Catches moving the IP gate below body parsing or charging more/less than one
// initial token. Invalid required fields never reach identifier/native work.
test("login IP burst refuses before parsing an exhausted caller's malformed body", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, AUTH_RATE_LIMIT: "3" });
  clock(t);
  const observed = observeAuth(f);
  for (let i = 0; i < 3; i++) await refused(await login(f, ""), 400, "AUTH_REQUIRED_FIELDS");
  await refused(await login(f, "", { raw: "{" }), 429, "AUTH_RATE_LIMITED", 20);
  assert.deepEqual(observed, { queries: 0, verifies: 0, hashes: 0 });
  assert.deepEqual((await authState(f)).audits, []);
});

test("login IP failure penalty, exact refill boundary and positive rounded Retry-After", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, AUTH_RATE_LIMIT: "4", AUTH_RATE_WINDOW_MS: "10000", AUTH_FAILURE_PENALTY: "2" });
  await user(f, "alice");
  const advance = clock(t), observed = observeAuth(f);
  for (let i = 0; i < 2; i++) await refused(await login(f, "alice"), 401, "AUTH_INVALID_CREDENTIALS");
  const before = await authState(f), calls = { ...observed };
  await refused(await login(f, "alice"), 429, "AUTH_RATE_LIMITED", 3);
  advance(2499);
  await refused(await login(f, "alice"), 429, "AUTH_RATE_LIMITED", 1);
  assert.deepEqual(observed, calls);
  assert.deepEqual(await authState(f), before);
  advance(1);
  await refused(await login(f, "alice"), 401, "AUTH_INVALID_CREDENTIALS");
  assert.equal(observed.verifies, 3);
  assert.equal((await authState(f)).audits.length, 3);
});

test("normalized submitted identifier shares debt across IPs; username/email and other identifiers stay independent", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, AUTH_ACCOUNT_RATE_LIMIT: "4", AUTH_ACCOUNT_RATE_WINDOW_MS: "10000", AUTH_FAILURE_PENALTY: "2" });
  await user(f, "alice"); await user(f, "bob");
  const advance = clock(t), observed = observeAuth(f);
  await refused(await login(f, " Alice "), 401, "AUTH_INVALID_CREDENTIALS");
  await refused(await login(f, "\tALICE\n", { ip: "192.0.2.2" }), 401, "AUTH_INVALID_CREDENTIALS");
  const before = await authState(f), calls = { ...observed };
  await refused(await login(f, "alice", { ip: "192.0.2.3" }), 429, "AUTH_RATE_LIMITED", 3);
  assert.deepEqual(observed, calls);
  assert.deepEqual(await authState(f), before);
  await refused(await login(f, "bob"), 401, "AUTH_INVALID_CREDENTIALS");
  await refused(await login(f, " ALICE@EXAMPLE.TEST "), 401, "AUTH_INVALID_CREDENTIALS");
  advance(2500);
  await refused(await login(f, "Alice", { ip: "192.0.2.4" }), 401, "AUTH_INVALID_CREDENTIALS");
  assert.equal(observed.verifies, 5);
});

for (const trust of [false, true]) {
  test(`spoofed Forwarded-For is ${trust ? "used only with explicit trust" : "ignored by default"}`, options, async (t) => {
    const f = await serverFixture(t, { AUTH_RATE_LIMIT: "2", AUTH_ACCOUNT_RATE_LIMIT: "100", AUTH_FAILURE_PENALTY: "2", ...(trust ? { TRUST_PROXY: "true" } : {}) });
    await user(f, "alice");
    clock(t);
    await refused(await login(f, "alice"), 401, "AUTH_INVALID_CREDENTIALS");
    const observed = observeAuth(f), before = await authState(f);
    await refused(await login(f, "alice", { ip: "192.0.2.2, 198.51.100.1" }), trust ? 401 : 429,
      trust ? "AUTH_INVALID_CREDENTIALS" : "AUTH_RATE_LIMITED");
    assert.equal(observed.verifies, trust ? 1 : 0);
    if (!trust) assert.deepEqual(await authState(f), before);
    await refused(await login(f, "alice", { ip: "192.0.2.2, 203.0.113.9" }), 429, "AUTH_RATE_LIMITED");
  });
}

for (const dimension of ["IP", "identifier"]) {
  test(`successful real login resets the relevant ${dimension} debt`, options, async (t) => {
    const f = await serverFixture(t, { ...generousAuth, AUTH_FAILURE_PENALTY: "2",
      [dimension === "IP" ? "AUTH_RATE_LIMIT" : "AUTH_ACCOUNT_RATE_LIMIT"]: "5" });
    await user(f, "alice");
    clock(t);
    await refused(await login(f, "alice"), 401, "AUTH_INVALID_CREDENTIALS");
    const success = await login(f, " ALICE ", { secret: password });
    assert.equal(success.status, 200);
    const cookie = success.headers.get("set-cookie").split(";")[0];
    await success.json();
    assert.equal((await f.request("/api/auth/session", { cookie })).status, 200);
    for (let i = 0; i < 3; i++) await refused(await login(f, "alice", {
      ip: dimension === "IP" ? "192.0.2.1" : `192.0.2.${i + 2}`,
    }), 401, "AUTH_INVALID_CREDENTIALS");
    await refused(await login(f, "alice", { ip: dimension === "IP" ? "192.0.2.1" : "192.0.2.9" }), 429, "AUTH_RATE_LIMITED");
    assert.equal((await authState(f)).audits.filter((row) => row.action === "auth.login_succeeded").length, 1);
  });
}

test("retained login identifier keys have a bounded byte footprint for kilobyte invalid inputs", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, AUTH_ACCOUNT_RATE_LIMIT: "1", AUTH_FAILURE_PENALTY: "1" });
  clock(t);
  const observations = [];
  for (const length of [2048, 4096, 8192]) {
    const identifier = "x".repeat(length);
    await refused(await login(f, identifier), 401, "AUTH_INVALID_CREDENTIALS");
    const observed = observeAuth(f), before = await authState(f);
    await refused(await login(f, ` ${identifier.toUpperCase()} `, { ip: "192.0.2.2" }), 429, "AUTH_RATE_LIMITED");
    assert.deepEqual(observed, { queries: 0, verifies: 0, hashes: 0 });
    assert.deepEqual(await authState(f), before);
    const sizes = [...f.app.authAccountLimiter.buckets.keys()].map((key) => Buffer.byteLength(key));
    observations.push({ submittedBytes: length, keys: sizes.length, largestKeyBytes: Math.max(...sizes), totalKeyBytes: sizes.reduce((a, b) => a + b, 0) });
  }
  t.diagnostic(`Retained identifier footprint: ${JSON.stringify(observations)}`);
  assert.ok(observations.every((row) => row.largestKeyBytes <= 1024),
    `retained login keys must be <=1024 bytes independent of invalid input length; observed ${JSON.stringify(observations)}`);
});

test("password capacity is shared by HTTP login and admin hashing; overflow never starts native work", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, PASSWORD_HASH_CONCURRENCY: "2", PASSWORD_HASH_QUEUE: "2" });
  const alice = await user(f, "alice"), bob = await user(f, "bob"), admin = await user(f, "admin", "admin");
  const target = await user(f, "target"), overflowTarget = await user(f, "overflow");
  const releases = new Map(["held-a", "held-b"].map((key) => [key, deferred()]));
  const entered = [], completed = [], order = [];
  let native = 0, maxNative = 0;
  f.hooks.beforeVerify = (_hash, secret) => { entered.push(secret); order.push("verify:" + secret); maxNative = Math.max(maxNative, ++native); };
  f.hooks.afterVerify = async (_hash, secret) => {
    native--; completed.push(secret);
    if (releases.has(secret)) await releases.get(secret).promise;
  };
  f.hooks.beforeHash = () => { order.push("hash"); maxNative = Math.max(maxNative, ++native); };
  const hashHold = pause(f, "afterHash");
  const pending = [];
  try {
    pending.push(login(f, alice.username, { secret: "held-a" }), login(f, bob.username, { secret: "held-b" }));
    await until(() => completed.length === 2, "two real verifications completed inside held slots");
    assert.equal(native, 0, "occupied slots at afterVerify are not still-running native hashes");
    pending.push(reset(f, admin, target));
    await until(() => f.app.passwordHashGate.queued === 1, "admin hash queued first");
    pending.push(login(f, alice.username, { secret: "queued" }));
    await until(() => f.app.passwordHashGate.queued === 2, "login queued second");
    const before = await authState(f);
    await refused(await within(login(f, bob.username), "password overflow", 1000), 503, "AUTH_BUSY");
    await refused(await within(reset(f, admin, overflowTarget), "hash overflow", 1000), 503, "AUTH_BUSY");
    assert.equal(entered.length, 2);
    assert.equal(order.includes("hash"), false);
    assert.deepEqual(await authState(f), before, "waiting/overflow work must not reset credentials, audit or issue sessions");
    releases.get("held-a").resolve();
    await hashHold.wait(pending[2]);
    native--; // afterHash pause is after the real native result.
    assert.equal(order[2], "hash", "FIFO admits the cross-path hash before queued login");
    assert.equal(entered.length, 2);
    assert.equal(f.app.passwordHashGate.queued, 1);
    hashHold.release();
    await until(() => entered.includes("queued"), "queued native verification starts after hash release");
  } finally {
    releases.forEach((wait) => wait.resolve()); hashHold.release();
    await within(Promise.all(pending), "password requests settle");
  }
  await refused(await pending[0], 401, "AUTH_INVALID_CREDENTIALS");
  await refused(await pending[1], 401, "AUTH_INVALID_CREDENTIALS");
  assert.equal((await pending[2]).status, 200);
  const resetBody = await (await pending[2]).json();
  await refused(await pending[3], 401, "AUTH_INVALID_CREDENTIALS");
  const stored = (await f.pool.query("SELECT password_hash, session_version FROM users WHERE id = $1", [target.id])).rows[0];
  assert.equal(stored.session_version, 1);
  assert.equal(await argon2.verify(stored.password_hash, resetBody.temporaryPassword), true);
  await until(() => f.app.runtimeSettled(), "password runtime cleanup");
  assert.equal(f.app.passwordHashGate.active, 0);
  assert.equal(f.app.passwordHashGate.queued, 0);
  assert.ok(maxNative <= 2);
  assert.equal((await authState(f)).audits.length, 4);
  t.diagnostic(`Password starts ${JSON.stringify(order)}; observed native max ${maxNative}; two occupied post-verify slots had zero native work running`);
});

test("malformed Argon2 encoding releases its real verification slot to queued hashing", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, PASSWORD_HASH_CONCURRENCY: "1", PASSWORD_HASH_QUEUE: "1" });
  const alice = await user(f, "alice"), admin = await user(f, "admin", "admin"), target = await user(f, "target");
  await f.pool.query("UPDATE users SET password_hash = '$argon2id$broken' WHERE id = $1", [alice.id]);
  const hold = pause(f, "beforeVerify");
  const pending = [login(f, "alice")];
  let hashes = 0;
  f.hooks.beforeHash = () => { hashes++; };
  try {
    await hold.wait(pending[0]);
    pending.push(reset(f, admin, target));
    await until(() => f.app.passwordHashGate.queued === 1, "hash waits for invalid native encoding");
    assert.equal(hashes, 0);
  } finally { hold.release(); await within(Promise.all(pending), "invalid hash recovery"); }
  await refused(await pending[0], 401, "AUTH_INVALID_CREDENTIALS");
  assert.equal((await pending[1]).status, 200);
  const temporary = (await (await pending[1]).json()).temporaryPassword;
  assert.equal((await login(f, "target", { secret: temporary })).status, 200);
  await until(() => f.app.runtimeSettled(), "invalid hash runtime cleanup");
  assert.equal(hashes, 1);
  assert.equal(f.app.passwordHashGate.active, 0);
});

test("a deliberate native hash resource-boundary failure releases capacity to an already queued login", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, PASSWORD_HASH_CONCURRENCY: "1", PASSWORD_HASH_QUEUE: "1" });
  const admin = await user(f, "admin", "admin"), target = await user(f, "target");
  await user(f, "alice");
  const entered = deferred(), released = deferred();
  f.hooks.beforeHash = async () => {
    delete f.hooks.beforeHash; entered.resolve(); await released.promise;
    throw Object.assign(new Error("synthetic Argon2 allocation boundary failure"), { code: "ENOMEM" });
  };
  const before = (await authState(f)).users;
  const pending = [reset(f, admin, target)];
  try {
    await within(entered.promise, "fault boundary");
    pending.push(login(f, "alice", { secret: password }));
    await until(() => f.app.passwordHashGate.queued === 1, "login behind failing hash");
  } finally { released.resolve(); await within(Promise.all(pending), "native fault recovery"); }
  await refused(await pending[0], 500, "SERVER_ERROR");
  assert.equal((await pending[1]).status, 200);
  const after = (await authState(f)).users;
  assert.deepEqual(after.find((u) => u.id === target.id), before.find((u) => u.id === target.id));
  assert.equal((await reset(f, admin, target)).status, 200, "a later real hash also succeeds");
  await until(() => f.app.runtimeSettled(), "hash fault cleanup");
  assert.equal(f.app.passwordHashGate.active, 0);
});

async function project(f, owner, name) {
  const response = await f.request("/api/projects", { method: "POST", cookie: f.cookieFor(owner), body: {
    name, data: { project: { nodes: [{ id: uuidv7(), type: "file", name: "main.tex", content: "\\documentclass{article}\n\\begin{document}Admission\\end{document}" }] } },
  } });
  assert.equal(response.status, 201);
  return (await response.json()).project.id;
}
const compile = (f, who, id, body = {}) => f.request(`/api/projects/${id}/compile`, {
  method: "POST", cookie: f.cookieFor(who), body,
});
async function entries(dir) {
  try { return await fs.readdir(dir); }
  catch (err) { if (err.code === "ENOENT") return []; throw err; }
}
async function tree(dir) {
  const result = {};
  for (const name of (await entries(dir)).sort()) {
    const full = path.join(dir, name);
    result[name] = (await fs.stat(full)).isDirectory() ? await tree(full) : (await fs.readFile(full)).toString("base64");
  }
  return result;
}
async function projectState(f, id) {
  return {
    project: (await f.pool.query("SELECT * FROM projects WHERE id = $1", [id])).rows,
    files: (await f.pool.query("SELECT * FROM project_files WHERE project_id = $1 ORDER BY id", [id])).rows,
    versions: (await f.pool.query("SELECT v.* FROM document_versions v JOIN project_files f ON f.id = v.file_id WHERE f.project_id = $1 ORDER BY v.id", [id])).rows,
    builds: (await f.pool.query("SELECT * FROM build_outputs WHERE project_id = $1 ORDER BY id", [id])).rows,
    artifacts: (await f.pool.query("SELECT a.* FROM build_artifacts a JOIN build_outputs b ON b.id = a.build_id WHERE b.project_id = $1 ORDER BY a.id", [id])).rows,
    live: await tree(path.join(f.dataDir, "projects", id)),
    staging: await tree(path.join(f.dataDir, ".build-staging", id)),
  };
}
async function cleanCompile(f, ids) {
  await until(async () => f.app.runtimeSettled() && f.children.size === 0 &&
    (await Promise.all(ids.map((id) => entries(path.join(f.dataDir, ".build-staging", id))))).every((list) => list.length === 0), "compile runtime and staging cleanup");
  assert.equal(f.app.compileGate.active, 0);
  assert.equal(f.app.compileGate.queued, 0);
}

// A complete small PDF with a page tree and correct cross-reference offsets.
// The external compiler replacement writes this exact artifact; publication,
// artifact storage, provenance and HTTP handling remain production code.
function pdfBytes() {
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
  ].entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
const pdf = pdfBytes();
const writePdf = `require("node:fs").writeFileSync("output/main.pdf", Buffer.from(${JSON.stringify(pdf.toString("base64"))}, "base64"));`;

function compiler(f, { hold = false, mode = "success" } = {}) {
  const records = [];
  let live = 0, maxLive = 0, releasing = false;
  f.hooks.spawn = () => ({ command: process.execPath, args: ["-e", mode === "timeout"
    ? 'console.log("READY"); setInterval(() => {}, 1000);'
    : `${hold ? 'console.log("READY"); process.stdin.once("data", () => {' : ""}
       ${mode === "nonzero" ? 'console.error("main.tex:1: error: controlled compiler failure"); process.exitCode = 7;' : writePdf}
       ${hold ? 'process.stdin.destroy(); });' : ""}`] });
  f.hooks.afterSpawn = (child, command, _args, spawnOptions) => {
    const record = { child, command, projectId: path.basename(path.dirname(spawnOptions.cwd)), ready: !hold, closed: false, output: "" };
    records.push(record); maxLive = Math.max(maxLive, ++live);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => { record.output += chunk; if (record.output.includes("READY")) record.ready = true; });
    child.once("close", () => { record.closed = true; live--; });
    if (releasing && hold) child.stdin.end("release\n");
  };
  return {
    records, get live() { return live; }, get maxLive() { return maxLive; },
    release(record) { if (!record.closed) record.child.stdin.end("release\n"); },
    releaseAll() { releasing = true; records.forEach((record) => { if (!record.closed && !record.child.stdin.writableEnded) record.child.stdin.end("release\n"); }); },
  };
}

async function succeeded(f, response, id) {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.buildStatus, "succeeded");
  assert.deepEqual(Buffer.from(body.pdfBase64, "base64"), pdf);
  const stored = (await f.pool.query("SELECT status, source_revision_id, storage_path FROM build_outputs WHERE id = $1 AND project_id = $2", [body.buildId, id])).rows[0];
  assert.equal(stored.status, "succeeded");
  assert.ok(stored.source_revision_id);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, "projects", id, body.pdfName)), pdf);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM build_artifacts WHERE build_id = $1", [body.buildId])).rows[0].n, 1);
  return body;
}

test("compile rate is per user/project, authorizes before charging, and refuses without durable side effects", options, async (t) => {
  const f = await serverFixture(t, { COMPILE_RATE_LIMIT: "2", COMPILE_RATE_WINDOW_MS: "5000" });
  const alice = await user(f, "alice"), bob = await user(f, "bob"), outsider = await user(f, "outsider");
  const a = await project(f, alice, "A"), b = await project(f, alice, "B");
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [a, bob.id]);
  const native = compiler(f), advance = clock(t);
  const initial = await projectState(f, a);
  for (let i = 0; i < 3; i++) await refused(await compile(f, outsider, a), 404, "PROJECT_NOT_FOUND");
  assert.deepEqual(await projectState(f, a), initial);
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [a, outsider.id]);
  await succeeded(f, await compile(f, outsider, a), a);
  await succeeded(f, await compile(f, outsider, a), a);
  await succeeded(f, await compile(f, alice, a), a);
  await succeeded(f, await compile(f, alice, a), a);
  await cleanCompile(f, [a, b]);
  const before = await projectState(f, a), calls = native.records.length;
  await refused(await compile(f, alice, a, { name: "Must not save" }), 429, "COMPILE_RATE_LIMITED", 3);
  advance(2499);
  await refused(await compile(f, alice, a), 429, "COMPILE_RATE_LIMITED", 1);
  assert.deepEqual(await projectState(f, a), before);
  assert.equal(native.records.length, calls);
  await succeeded(f, await compile(f, alice, b), b);
  await succeeded(f, await compile(f, bob, a), a);
  advance(1);
  await succeeded(f, await compile(f, alice, a), a);
  await cleanCompile(f, [a, b]);
  assert.equal(native.records.length, 7);
});

test("real compiler population is capped; FIFO waiters have no setup and slots cover publication and audit", options, async (t) => {
  const f = await serverFixture(t, { COMPILE_CONCURRENCY: "2", COMPILE_QUEUE: "2", COMPILE_RATE_LIMIT: "1" });
  const alice = await user(f, "alice"), bob = await user(f, "bob");
  const owners = [alice, bob, bob, alice, bob], ids = [];
  for (const [i, owner] of owners.entries()) ids.push(await project(f, owner, `FIFO ${i}`));
  const before = await Promise.all(ids.slice(2).map((id) => projectState(f, id)));
  const native = compiler(f, { hold: true }), pending = [];
  const publication = pause(f, "beforeClientQuery", (sql) => sql.includes("INSERT INTO build_artifacts"));
  let auditHold;
  try {
    for (let i = 0; i < 2; i++) {
      pending.push(compile(f, owners[i], ids[i]));
      await until(() => native.records.length === i + 1 && native.records[i].ready, `active child ${i}`);
    }
    for (let i = 2; i < 4; i++) {
      pending.push(compile(f, owners[i], ids[i], { name: "Admitted later" }));
      await until(() => f.app.compileGate.queued === i - 1, `FIFO waiter ${i}`);
    }
    await refused(await within(compile(f, owners[4], ids[4], { name: "Refused" }), "compile overflow", 1000), 503, "COMPILE_SERVER_BUSY");
    await refused(await compile(f, owners[4], ids[4]), 429, "COMPILE_RATE_LIMITED");
    assert.equal(native.live, 2);
    assert.equal(native.records.length, 2);
    assert.equal(f.app.healthPayload().pendingWrites, 4, "accepted HTTP queue waits count as pending writes, not native children");
    assert.deepEqual(await Promise.all(ids.slice(2).map((id) => projectState(f, id))), before);
    native.release(native.records[0]);
    await publication.wait(pending[0]);
    assert.equal(native.live, 1);
    assert.equal(f.app.compileGate.active, 2, "publication retains the slot after its child exits");
    assert.equal(f.app.compileGate.queued, 2);
    assert.equal(native.records.length, 2);
    assert.deepEqual(await Promise.all(ids.slice(2).map((id) => projectState(f, id))), before);
    auditHold = pause(f, "beforeQuery", (sql, params) => sql.includes("INSERT INTO audit_events") && params.includes("build.completed"));
    publication.release();
    await auditHold.wait(pending[0]);
    assert.equal((await f.pool.query("SELECT status FROM build_outputs WHERE project_id = $1", [ids[0]])).rows[0].status, "succeeded");
    assert.equal(native.records.length, 2, "the success audit still owns admission capacity");
    assert.equal(f.app.compileGate.queued, 2);
    auditHold.release();
    await until(() => native.records.length === 3 && native.records[2].ready, "first FIFO child starts");
    assert.equal(native.records[2].projectId, ids[2]);
    assert.deepEqual(await projectState(f, ids[3]), before[1]);
    native.release(native.records[1]);
    await until(() => native.records.length === 4 && native.records[3].ready, "second FIFO child starts");
    assert.deepEqual(native.records.map((record) => record.projectId), ids.slice(0, 4));
    assert.equal(native.live, 2);
  } finally {
    publication.release(); auditHold?.release(); native.releaseAll();
    await within(Promise.all(pending), "FIFO jobs settle");
  }
  for (const [i, response] of pending.entries()) await succeeded(f, await response, ids[i]);
  await cleanCompile(f, ids);
  assert.equal(native.maxLive, 2);
  assert.deepEqual(await projectState(f, ids[4]), before[2]);
  assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'build.completed'")).rows[0].n, 4);
  t.diagnostic("Compile observations: 2 actual active children, 2 FIFO HTTP waiters, overflow 503; publication/audit retained capacity with only 1 child alive; 4 persisted successes");
});

test("compile rechecks membership after the actual global queue and before saving or starting a child", options, async (t) => {
  const f = await serverFixture(t, { COMPILE_CONCURRENCY: "1", COMPILE_QUEUE: "1" });
  const alice = await user(f, "alice"), bob = await user(f, "bob");
  const a = await project(f, alice, "Active"), b = await project(f, alice, "Queued");
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [b, bob.id]);
  const before = await projectState(f, b), native = compiler(f, { hold: true });
  const pending = [compile(f, alice, a)];
  try {
    await until(() => native.records[0]?.ready, "real active child");
    pending.push(compile(f, bob, b, { name: "No longer authorized" }));
    await until(() => f.app.compileGate.queued === 1, "authorized preflight queued");
    await f.pool.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [b, bob.id]);
  } finally { native.releaseAll(); await within(Promise.all(pending), "revoked queued compile settles"); }
  await succeeded(f, await pending[0], a);
  await refused(await pending[1], 404, "PROJECT_NOT_FOUND");
  await cleanCompile(f, [a, b]);
  assert.equal(native.records.length, 1);
  assert.deepEqual(await projectState(f, b), before);
  await succeeded(f, await compile(f, alice, b), b);
  await cleanCompile(f, [a, b]);
});

for (const fault of ["setup", "nonzero", "spawn", "timeout", "publication"]) {
  test(`compile ${fault} failure releases capacity and cleans staging before later success`, options, async (t) => {
    const f = await serverFixture(t, { COMPILE_CONCURRENCY: "1", COMPILE_QUEUE: "1", COMPILE_TIMEOUT_MS: fault === "timeout" ? "500" : "10000" });
    const alice = await user(f, "alice"), id = await project(f, alice, "Recovery");
    const native = compiler(f, { mode: fault === "nonzero" || fault === "timeout" ? fault : "success" });
    let injected = 0;
    if (fault === "setup") f.hooks.beforeMkdir = (dir) => {
      if (String(dir).endsWith("texmf-var")) { injected++; throw new Error("controlled setup boundary failure"); }
    };
    if (fault === "publication") f.hooks.beforeClientQuery = (sql) => {
      if (sql.includes("INSERT INTO build_artifacts")) { injected++; throw new Error("controlled publication boundary failure"); }
    };
    if (fault === "spawn") f.hooks.spawn = () => ({ command: path.join(f.dataDir, "nonexistent-compiler"), args: [] });
    let response;
    try { response = await compile(f, alice, id); }
    finally { delete f.hooks.beforeMkdir; delete f.hooks.beforeClientQuery; }
    if (fault === "setup" || fault === "publication") {
      await refused(response, 500, "SERVER_ERROR");
      assert.equal(injected, 1, "the intended resource boundary was reached");
    } else {
      assert.equal(response.status, 200, "ordinary compiler failure is a completed HTTP operation");
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.buildStatus, "failed");
      if (fault === "nonzero") assert.equal(body.exitCode, 7);
      if (fault === "spawn") assert.match(body.log, /ENOENT/);
      if (fault === "timeout") {
        assert.equal(body.timedOut, true);
        assert.equal(body.signal, "SIGTERM");
        assert.match(body.log, /compilation stopped after 500ms/);
        assert.ok(body.durationMs >= 450 && body.durationMs < 4000);
      }
    }
    await cleanCompile(f, [id]);
    const failed = (await f.pool.query("SELECT status, storage_path FROM build_outputs WHERE project_id = $1", [id])).rows;
    assert.deepEqual(failed, [{ status: "failed", storage_path: null }]);
    assert.equal((await f.pool.query("SELECT count(*)::int AS n FROM build_artifacts")).rows[0].n, 0);
    const recovery = compiler(f);
    await succeeded(f, await compile(f, alice, id), id);
    await cleanCompile(f, [id]);
    assert.equal(native.records.length, fault === "setup" ? 0 : 1);
    assert.equal(recovery.records.length, 1);
    assert.deepEqual((await f.pool.query("SELECT status FROM build_outputs WHERE project_id = $1 ORDER BY created_at, id", [id])).rows,
      [{ status: "failed" }, { status: "succeeded" }]);
  });
}

test("shutdown drains real queued HTTP work while admitted compiler and Argon2 work remain counted through cleanup", options, async (t) => {
  const f = await serverFixture(t, { ...generousAuth, COMPILE_CONCURRENCY: "1", COMPILE_QUEUE: "1",
    PASSWORD_HASH_CONCURRENCY: "1", PASSWORD_HASH_QUEUE: "1", SHUTDOWN_TIMEOUT_MS: "10000" });
  const alice = await user(f, "alice"), admin = await user(f, "admin", "admin"), target = await user(f, "target");
  const a = await project(f, alice, "Active"), b = await project(f, alice, "Queued");
  const before = await projectState(f, b), native = compiler(f, { hold: true });
  const verifyHold = pause(f, "afterVerify"), cleanup = pause(f, "beforeRm", (dir) => String(dir).includes(".build-staging"));
  const pending = [compile(f, alice, a), login(f, "alice", { secret: password })];
  let shutdown, endSnapshot;
  f.hooks.beforeEnd = async () => {
    endSnapshot = { queuedProject: await projectState(f, b), users: (await authState(f)).users,
      builds: (await f.pool.query("SELECT status FROM build_outputs ORDER BY id")).rows,
      staging: await entries(path.join(f.dataDir, ".build-staging", a)), children: f.children.size,
      pendingWrites: f.app.healthPayload().pendingWrites };
  };
  try {
    await verifyHold.wait(pending[1]);
    await until(() => native.records[0]?.ready, "active compiler before shutdown");
    pending.push(compile(f, alice, b), reset(f, admin, target));
    await until(() => f.app.compileGate.queued === 1 && f.app.passwordHashGate.queued === 1, "both real HTTP queues");
    assert.equal(f.app.healthPayload().pendingWrites, 4);
    shutdown = f.app.startGracefulShutdown("admission-test", f.server);
    await refused(await within(pending[2], "compile shutdown refusal"), 503, "COMPILE_SERVER_BUSY");
    await refused(await within(pending[3], "password shutdown refusal"), 503, "AUTH_BUSY");
    assert.equal(f.app.healthPayload().pendingWrites, 2);
    assert.equal(endSnapshot, undefined);
    assert.deepEqual(f.exits, []);
    assert.deepEqual(await projectState(f, b), before);
    verifyHold.release(); native.releaseAll();
    // Response end may precede staging cleanup, so await the actual I/O barrier.
    await cleanup.wait();
    await succeeded(f, await pending[0], a);
    assert.equal((await pending[1]).status, 200);
    assert.equal(f.app.compileGate.active, 0, "capacity is released before staging cleanup");
    assert.equal(f.app.healthPayload().pendingWrites, 1, "the admitted HTTP owner still accounts for cleanup");
    assert.equal(endSnapshot, undefined);
  } finally {
    verifyHold.release(); native.releaseAll(); cleanup.release();
    await within(Promise.all(pending), "shutdown requests settle");
    if (shutdown) await within(shutdown, "shutdown completion");
  }
  assert.deepEqual(f.exits, [0]);
  assert.deepEqual(endSnapshot.queuedProject, before);
  assert.deepEqual(endSnapshot.builds, [{ status: "succeeded" }]);
  assert.equal(endSnapshot.users.find((u) => u.id === target.id).session_version, 0);
  assert.deepEqual(endSnapshot.staging, []);
  assert.equal(endSnapshot.children, 0);
  assert.equal(endSnapshot.pendingWrites, 0);
});
