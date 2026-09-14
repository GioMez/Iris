const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const enabled = process.env.IRIS_TEST_BROWSER === "1";
const options = { skip: !enabled, timeout: 60000 };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function waitFor(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < deadline, label()); await delay(20); }
}

async function fixture(t, entrypoint, phase) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-browser-lifecycle-"));
  const tmp = path.join(root, "temporary"), output = path.join(root, "images");
  await fs.mkdir(tmp); await fs.mkdir(output);
  const args = entrypoint === "capture" ? ["scripts/capture-docs.cjs", "--output", output] : ["scripts/smoke.cjs", "--native", "--browser"];
  if (phase === "launch-failure") args.push("--browser-executable", path.join(root, "missing-chromium"));
  else if (process.env.IRIS_BROWSER_EXECUTABLE) args.push("--browser-executable", process.env.IRIS_BROWSER_EXECUTABLE);
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "helpers/browser-lifecycle.cjs"), ...args], {
    cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmp, IRIS_BROWSER_LIFECYCLE_PHASE: phase },
  });
  let outputText = "", closed = false;
  const events = [];
  child.on("message", (event) => events.push(event));
  child.stdout.on("data", (chunk) => { outputText += chunk; });
  child.stderr.on("data", (chunk) => { outputText += chunk; });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolve({ code, signal }); }); });
  // RED/failure cleanup targets only the exact processes and PGDATA we observed.
  t.after(async () => {
    if (!closed) { child.kill("SIGKILL"); await done; }
    for (const { kind, pid, data, tool } of events.filter((event) => ["app", "chrome", "postgres"].includes(event.kind))) {
      if (kind === "postgres" && alive(pid)) {
        const stopped = spawnSync(tool, ["-D", data, "-m", "fast", "-w", "-t", "10", "stop"], { timeout: 15000, encoding: "utf8" });
        assert.equal(stopped.status, 0, stopped.stderr);
      } else if (kind !== "postgres" && alive(-pid)) {
        process.kill(-pid, "SIGKILL");
      }
      await waitFor(() => !alive(pid) && (kind === "postgres" || !alive(-pid)), () => `test finalizer: ${kind} ${pid} still alive`);
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const waitEvent = (kind) => waitFor(() => {
    const found = events.some((event) => event.kind === kind);
    assert.ok(found || !closed, `${entrypoint}/${phase}: exited before ${kind}; ${outputText}`);
    return found;
  }, () => `${entrypoint}/${phase}: missing ${kind}; ${outputText}`, 30000);
  return { tmp, events, child, done, waitEvent, output: () => outputText,
    async expectCleanup() {
      await waitFor(() => closed, () => `${entrypoint}/${phase}: driver did not exit after cancellation; ${outputText}`, phase === "launch-timeout" ? 15000 : 10000);
      const result = await done;
      assert.equal(result.signal, null, outputText);
      for (const { kind, pid } of events.filter((event) => ["app", "chrome", "postgres"].includes(event.kind))) {
        assert.equal(alive(pid), false, `${entrypoint}/${phase}: ${kind} PID ${pid} survived driver exit\n${outputText}`);
        if (kind !== "postgres") assert.equal(alive(-pid), false, `${kind} process group ${pid} survived`);
      }
      for (const { root } of events.filter((event) => event.kind === "workspace")) {
        assert.equal(await fs.stat(root).catch(() => null), null, `owned workspace survived: ${root}`);
        const completion = events.find((event) => event.kind === "workspace-closed" && event.root === root);
        assert.ok(completion, outputText);
        assert.deepEqual(completion.survivors, [], "workspace cleanup must finish after all owned processes, before driver exit handlers");
      }
      assert.deepEqual(await fs.readdir(tmp), [], "owned temporary storage must be removed after process cleanup");
      return result;
    },
  };
}

for (const entrypoint of ["capture", "smoke"]) {
  for (const [phase, signal] of [
    ["before-launch", "SIGINT"], ["during-launch", "SIGINT"], ["during-work", "SIGINT"], ["during-close", "SIGINT"],
    ["launch-timeout", "SIGINT"],
    ["during-work", "SIGTERM"], ["during-work", "SIGHUP"],
  ]) test(`${entrypoint} browser lifecycle: ${signal} ${phase} completes owned cleanup`, options, async (t) => {
    const f = await fixture(t, entrypoint, phase);
    await f.waitEvent("paused");
    assert.ok(f.events.some((e) => e.kind === "app") && f.events.some((e) => e.kind === "postgres"), "real app and cluster started");
    if (phase !== "before-launch") assert.ok(f.events.some((e) => e.kind === "chrome"), "real Chrome spawned before interruption");
    f.child.kill(signal); await f.waitEvent("signal");
    if (["before-launch", "during-launch", "during-close"].includes(phase)) f.child.send("release");
    const result = await f.expectCleanup();
    if (phase !== "during-close") assert.notEqual(result.code, 0, "cancelled work must not report success");
    if (["before-launch", "during-launch", "launch-timeout"].includes(phase)) assert.equal(f.events.some((e) => e.kind === "browser-use"), false, "cancelled launch must not enter browser work");
    t.diagnostic(`${entrypoint}: ${signal} ${phase}; exit ${result.code}; app/Chrome groups, PostgreSQL and workspace absent`);
  });

  for (const phase of ["launch-failure", "launch-crash"]) test(`${entrypoint} browser lifecycle: ${phase} cleans app and PostgreSQL`, options, async (t) => {
    const f = await fixture(t, entrypoint, phase);
    await f.waitEvent("postgres");
    const result = await f.expectCleanup();
    assert.notEqual(result.code, 0);
    if (phase === "launch-failure") assert.match(f.output(), /missing-chromium/);
    assert.equal(f.events.some((event) => event.kind === "chrome"), phase === "launch-crash");
  });
}
