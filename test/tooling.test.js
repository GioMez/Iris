const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function waitFor(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await delay(10);
  }
}

test("portable runner provisions its own PG18+, ignores ambient configuration and cleans a failing suite", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-runner-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scripts = path.resolve(__dirname, "../scripts");
  await fs.cp(scripts, path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "test"));
  await fs.mkdir(path.join(root, "public"));
  await fs.mkdir(path.join(root, "temporary"));
  await fs.writeFile(path.join(root, ".env"), "IRIS_SECRET=ambient-secret\nDB_HOST=must-not-contact\n");
  await fs.writeFile(path.join(root, "test/probe.test.js"), `
    const test = require('node:test'), assert = require('node:assert/strict');
    const { spawnSync } = require('node:child_process');
    test('isolated configuration', () => {
      assert.notEqual(process.cwd(), ${JSON.stringify(root)});
      assert.notEqual(process.env.IRIS_SECRET, 'ambient-secret');
      assert.notEqual(process.env.DB_PASSWORD, 'ambient-password');
      assert.equal(process.env.DB_HOST, '127.0.0.1');
      assert.equal(process.env.IRIS_TEST_BASE_URL, undefined);
      assert.equal(process.env.IRIS_TEST_BROWSER, '0');
      assert.equal(process.env.IRIS_TEST_COMPILERS, '0');
      assert.ok(process.env.TEST_DATABASE_URL.includes('127.0.0.1'));
      const result = spawnSync('psql', [process.env.TEST_DATABASE_URL, '-Atc', 'SHOW server_version_num'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(Number(result.stdout.trim()) >= 180000, result.stdout);
    });
    test('deliberate failure', () => assert.fail('sentinel-suite-failure'));
  `);
  const result = spawnSync(process.execPath, [path.join(root, "scripts/test.cjs")], {
    cwd: root, encoding: "utf8", timeout: 45000,
    env: { ...process.env, TMPDIR: path.join(root, "temporary"), IRIS_SECRET: "ambient-secret", DB_PASSWORD: "ambient-password", DB_HOST: "must-not-contact", TEST_DATABASE_URL: "postgresql://must-not-contact/no", IRIS_TEST_BASE_URL: "http://must-not-contact", IRIS_TEST_BROWSER: "1", IRIS_TEST_COMPILERS: "1" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /ok 1 - isolated configuration/);
  assert.match(result.stdout, /sentinel-suite-failure/);
  assert.match(result.stdout, /Cleanup confirmed/);
  assert.deepEqual(await fs.readdir(path.join(root, "temporary")), []);
});

test("bounded command timeout terminates an owned process group, including grandchildren", async () => {
  const { run } = require("../scripts/lib/disposable.cjs");
  const start = Date.now();
  await assert.rejects(run(process.execPath, ["-e", `
    require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `], { timeout: 200, quiet: true }), /timed out/i);
  assert.ok(Date.now() - start < 5000);
});

for (const trigger of ["parent-exit", "timeout", "interrupt"]) test(`process-group closure survives ${trigger} with a resistant independent-stdio grandchild`, { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-group-closure-"));
  const pidFile = path.join(root, "grandchild.pid");
  const parent = path.join(root, "parent.cjs"), driver = path.join(root, "driver.cjs");
  const utility = path.resolve(__dirname, "../scripts/lib/disposable.cjs");
  await fs.writeFile(parent, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', \
      "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.send('ready');setInterval(()=>{},1000)", ${JSON.stringify(pidFile)}], { stdio: ['ignore','ignore','ignore','ipc'] });
    child.once('message', () => { child.disconnect(); child.unref(); process.stdout.write('group-ready\\n', () => {
      if (${JSON.stringify(trigger)} === 'parent-exit') process.exit(0);
      else setInterval(()=>{},1000);
    }); });
  `);
  await fs.writeFile(driver, `
    const { workspace, launch } = require(${JSON.stringify(utility)});
    (async () => {
      const work = await workspace('iris-group-work-');
      try {
        const command = launch(process.execPath, [${JSON.stringify(parent)}], { timeout: ${trigger === "timeout" ? 1500 : 10000} });
        await command.done;
      } finally { await work.close(); }
    })().catch(e => { console.error(e.message); process.exitCode=1; });
  `);
  const child = spawn(process.execPath, [driver], { env: { ...process.env, TMPDIR: root } });
  let output = "";
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    child.kill("SIGKILL");
    const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
    if (pid && alive(pid)) { process.kill(pid, "SIGKILL"); await waitFor(() => !alive(pid), "owned grandchild disposal"); }
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("group-ready"), "grandchild handler and PID ready");
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  if (trigger === "interrupt") child.kill("SIGINT");
  const code = await done;
  assert.equal(code, trigger === "parent-exit" ? 0 : 1, output);
  assert.equal(alive(pid), false, "command completion must await the whole owned process group, not just its leader");
  assert.match(output, /Cleanup confirmed/);
  assert.equal((await fs.readdir(root)).some((name) => name.startsWith("iris-group-work-")), false);
});

test("command deadline remains bounded when a detached daemon inherits stdout", async (t) => {
  const { run } = require("../scripts/lib/disposable.cjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-runner-daemon-"));
  const pidFile = path.join(root, "owned-pid");
  t.after(async () => {
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const start = Date.now();
  await assert.rejects(run(process.execPath, ["-e", `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { detached: true, stdio: 'inherit' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref();
  `], { timeout: 200, quiet: true }), /timed out/i);
  assert.ok(Date.now() - start < 1800, "inherited pipe cannot extend command deadline");
});

test("interrupt terminates signal-resistant owned work and shuts down its disposable PostgreSQL", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-runner-interrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(path.resolve(__dirname, "../scripts"), path.join(root, "scripts"), { recursive: true });
  for (const dir of ["test", "public", "temporary"]) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, "scripts/hang.cjs"), `
    const { workspace, postgres, run } = require('./lib/disposable.cjs');
    (async () => {
      const work = await workspace();
      try {
        await postgres(work);
        await run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('runner-probe-ready'); setInterval(() => {}, 1000)"], { timeout: 4000 });
      } finally { await work.close(); }
    })().catch(e => { console.error(e.message); process.exitCode = 1; });
  `);
  const child = spawn(process.execPath, [path.join(root, "scripts/hang.cjs")], { cwd: root, env: { ...process.env, TMPDIR: path.join(root, "temporary") } });
  let output = "";
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
  t.after(() => child.kill("SIGKILL"));
  const ready = new Promise((resolve) => child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("runner-probe-ready")) resolve(); }));
  child.stderr.on("data", (chunk) => { output += chunk; });
  await ready;
  const start = Date.now(); child.kill("SIGINT");
  // The fallback prevents a RED run from leaving a deliberately stubborn child.
  const fallback = setTimeout(() => child.kill("SIGTERM"), 7000);
  try {
    const result = await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("interrupt cleanup exceeded 8 seconds")), 8000).unref())]);
    assert.notEqual(result, 0);
    assert.ok(Date.now() - start < 2500, output);
    assert.match(output, /Cleanup confirmed/);
    assert.deepEqual(await fs.readdir(path.join(root, "temporary")), []);
  } finally { clearTimeout(fallback); }
});

test("portable runner SIGTERM closes a resistant test descendant before deleting its PostgreSQL workspace", { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-runner-sigterm-"));
  const pidFile = path.join(root, "grandchild.pid"), tmp = path.join(root, "temporary");
  await fs.cp(path.resolve(__dirname, "../scripts"), path.join(root, "scripts"), { recursive: true });
  for (const dir of ["test", "public", "temporary"]) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, "test/hang.test.js"), `
    require('node:test')('owned live work', async () => {
      const child = require('node:child_process').spawn(process.execPath, ['-e', \
        "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.send('ready');setInterval(()=>{},1000)", ${JSON.stringify(pidFile)}], { stdio: ['ignore','ignore','ignore','ipc'] });
      await new Promise(resolve => child.once('message', resolve)); child.disconnect(); child.unref();
      console.log('runner-descendant-ready');
      await new Promise(() => setInterval(()=>{},1000));
    });
  `);
  const child = spawn(process.execPath, [path.join(root, "scripts/test.cjs"), "--timeout", "8000"], { cwd: root, env: { ...process.env, TMPDIR: tmp } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
  t.after(async () => {
    child.kill("SIGKILL");
    const pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
    if (pid && alive(pid)) { process.kill(pid, "SIGKILL"); await waitFor(() => !alive(pid), "owned test descendant disposal"); }
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("runner-descendant-ready"), "runner test and signal handler ready");
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  child.kill("SIGTERM");
  assert.notEqual(await done, 0);
  assert.equal(alive(pid), false, "runner must await resistant descendant closure");
  assert.match(output, /Cleanup confirmed/);
  assert.deepEqual(await fs.readdir(tmp), []);
});
