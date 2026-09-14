const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { AsyncLocalStorage } = require("node:async_hooks");

const active = new Map();
const cleanupScope = new AsyncLocalStorage();
const cleaning = () => cleanupScope.getStore() === true;
let interruptedError, abortController = new AbortController();
function kill(child, signal) {
  if (!child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
function groupExists(child) {
  if (!child.pid) return false;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}
function launch(command, args, { cwd, env = process.env, timeout = 30000, quiet = false, input, allowFailure = false, maxBytes = 32 * 1024 * 1024 } = {}) {
  if (interruptedError && !cleaning()) throw interruptedError;
  const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const owned = trackProcess(child, command, { timeout, quiet, allowFailure, maxBytes });
  child.stdin.end(input);
  return owned;
}
// Also accepts an already spawned, detached process from a library. Observe its
// streams without ending stdin: the library retains its protocol transport.
function trackProcess(child, command, { timeout = 300000, quiet = true, allowFailure = false, maxBytes = 32 * 1024 * 1024 } = {}) {
  const stdout = [], stderr = [];
  let bytes = 0, failure, escalation, closureDeadline, poll, timer;
  let exited = false, closed = false, groupGone = false, finished = false, terminating = false, code, signal;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const state = { cleanup: cleaning(), closed: () => closed && groupGone, done };
  const clearTimers = () => { clearTimeout(timer); clearTimeout(escalation); clearTimeout(closureDeadline); clearInterval(poll); };
  const finish = (closureError) => {
    if (finished) return;
    finished = true; clearTimers();
    // Failed closure remains owned/tracked so workspace disposal cannot report
    // success or remove storage while an unclosed process group still uses it.
    if (state.closed()) active.delete(child);
    const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    if (closureError || failure) rejectDone(closureError || failure);
    else if (code !== 0 && !allowFailure) rejectDone(new Error(`${command} exited ${code ?? signal}: ${result.stderr.toString().slice(-4000)}`));
    else resolveDone(result);
  };
  const send = (signal) => {
    // Once observed empty, release this PGID permanently. A later PID reuse
    // must never become a signal target, even if detached I/O is still open.
    if (groupGone) return;
    try { kill(child, signal); } catch (error) { failure ||= error; }
  };
  const observe = () => {
    if (exited && !groupGone && !groupExists(child)) groupGone = true;
    if (state.closed()) {
      active.delete(child);
      finish();
    } else if (exited && !groupGone && !finished) {
      // Normal leader exit also ends ownership of any same-group background work.
      // Independent descendant stdio says nothing about process-group closure.
      terminate();
    }
    if (groupGone) { clearInterval(poll); poll = undefined; }
  };
  const terminate = (reason, graceMs = 1000) => {
    failure ||= reason;
    if (terminating || finished) return;
    terminating = true;
    send("SIGTERM");
    escalation = setTimeout(() => {
      send("SIGKILL");
      // A daemon may have detached after inheriting these descriptors. Its owner
      // must stop that daemon separately; inherited pipes cannot defeat this deadline.
      for (const stream of child.stdio) stream?.destroy?.();
      closureDeadline = setTimeout(() => {
        observe();
        if (!state.closed()) finish(new Error(`Process-group cleanup failed for ${command} (pgid ${child.pid}): closure not confirmed after SIGKILL`));
      }, 2000);
      observe();
    }, graceMs);
    poll ||= setInterval(observe, 20);
  };
  state.terminate = terminate;
  active.set(child, state);
  timer = setTimeout(() => terminate(new Error(`Command timed out after ${timeout}ms: ${command}`)), timeout);
  for (const [stream, target, output] of [[child.stdout, stdout, process.stdout], [child.stderr, stderr, process.stderr]]) stream?.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= maxBytes) target.push(chunk);
    else terminate(new Error(`Command output exceeded ${maxBytes} bytes: ${command}`));
    if (!quiet) output.write(chunk);
  });
  child.stdin?.on("error", (error) => { if (error.code !== "EPIPE") terminate(error); });
  child.once("error", (error) => { failure ||= error; });
  child.once("exit", () => { exited = true; observe(); });
  child.once("close", (exitCode, exitSignal) => {
    exited = true; closed = true; code = exitCode; signal = exitSignal;
    clearTimeout(timer);
    observe();
  });
  // A background server may fail before its owner starts awaiting its shutdown.
  done.catch(() => {});
  if (interruptedError && !cleaning()) terminate(interruptedError);
  return { child, done, output: () => Buffer.concat([...stdout, ...stderr]).toString(),
    async stop() {
      if (cleaning()) state.cleanup = true;
      if (active.has(child)) terminate(undefined, 20000);
      try { return await done; }
      catch (error) {
        if (error !== interruptedError || !state.closed()) throw error;
      }
    } };
}
async function run(command, args, options) { return launch(command, args, options).done; }
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (interruptedError && !cleaning()) throw interruptedError;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(100);
  }
}
function cleanEnv() {
  return { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
}
async function workspace(prefix = "iris-verify-") {
  if (process.platform === "win32") throw new Error("Disposable process-group cleanup requires a POSIX host (Linux/macOS)");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  interruptedError = undefined; abortController = new AbortController();
  const cwd = path.join(root, "cwd"), tmp = path.join(root, "tmp"), home = path.join(root, "home");
  for (const dir of [cwd, tmp, home]) await fs.mkdir(dir);
  const env = { ...cleanEnv(), HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const cleanups = [];
  let closing = false, closePromise;
  const defer = (cleanup) => {
    let pending, disposed = false;
    const dispose = () => {
      if (disposed) return Promise.resolve();
      // Inline finally blocks use the same protected scope as final disposal.
      // A failed attempt stays registered for a cleanup-phase retry.
      return pending ||= cleanupScope.run(true, async () => {
        await cleanup();
        disposed = true;
        cleanups.splice(cleanups.indexOf(dispose), 1);
      }).finally(() => { pending = undefined; });
    };
    cleanups.push(dispose);
    return dispose;
  };
  const interrupted = (signal) => {
    if (closing) return; // A second signal must not interrupt final disposal.
    interruptedError ||= new Error(`Interrupted by ${signal}`);
    abortController.abort(interruptedError);
    process.exitCode = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal];
    for (const command of active.values()) if (!command.cleanup) command.terminate(interruptedError);
  };
  const onInt = () => interrupted("SIGINT"), onTerm = () => interrupted("SIGTERM"), onHup = () => interrupted("SIGHUP");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm); process.on("SIGHUP", onHup);
  return { root, cwd, tmp, env, cleanups, defer, signal: abortController.signal,
    close() {
      return closePromise ||= cleanupScope.run(true, async () => {
        closing = true;
        const errors = [];
        try {
          for (const cleanup of cleanups.slice().reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
          // Also account for a command whose closure deadline failed, or work a
          // caller launched without awaiting. Files outlive all owned processes.
          const remaining = [...active.values()];
          for (const command of remaining) { command.cleanup = true; command.terminate(); }
          for (const command of remaining) {
            await command.done.catch(() => {});
            if (!command.closed()) errors.push(new Error("Owned process-group closure is unconfirmed"));
          }
          if (errors.length) throw new AggregateError(errors, `Cleanup failed; retained owned resources for diagnosis: ${root}`);
          await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
          console.log(`Cleanup confirmed: removed owned processes, cluster and temporary storage ${root}`);
        } finally {
          process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); process.removeListener("SIGHUP", onHup);
        }
      });
    } };
}
async function postgres(work, pgBin) {
  if (process.getuid?.() === 0) throw new Error("initdb refuses root; run disposable native verification as an unprivileged user");
  if (!pgBin) {
    const config = await run("pg_config", ["--bindir"], { env: work.env, quiet: true });
    pgBin = config.stdout.toString().trim();
  }
  const tool = (name) => path.join(pgBin, name);
  const version = (await run(tool("initdb"), ["--version"], { env: work.env, quiet: true })).stdout.toString().trim();
  if (Number(version.match(/(\d+)\./)?.[1]) < 18 || !/PostgreSQL/.test(version)) throw new Error(`PostgreSQL 18+ required; found ${version}`);
  console.log(version);
  const data = path.join(work.root, "pgdata"), passwordFile = path.join(work.root, "pg-password"), log = path.join(work.root, "postgres.log");
  const password = crypto.randomBytes(24).toString("hex"), user = "iris_test", port = await freePort();
  const env = { ...work.env, PATH: `${pgBin}${path.delimiter}${work.env.PATH}`, PGPASSWORD: password, PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: user, PGDATABASE: "postgres", PGCONNECT_TIMEOUT: "5" };
  await fs.writeFile(passwordFile, password, { mode: 0o600 });
  await run(tool("initdb"), ["-D", data, "-U", user, "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "--no-locale", "--encoding=UTF8"], { env, quiet: true });
  // Register before start: a start timeout can still leave a live postmaster.
  work.cleanups.push(async () => {
    if (!await fs.stat(path.join(data, "postmaster.pid")).catch(() => null)) return;
    await run(tool("pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "10", "stop"], { env, timeout: 15000, quiet: true });
  });
  try {
    await run(tool("pg_ctl"), ["-D", data, "-l", log, "-o", `-h 127.0.0.1 -p ${port} -k '' -c max_connections=100`, "-w", "-t", "10", "start"], { env, quiet: true, timeout: 15000 });
  } catch (error) { console.error(await fs.readFile(log, "utf8").catch(() => "")); throw error; }
  return { tool, env, port, user, password, url: `postgresql://${user}:${password}@127.0.0.1:${port}/postgres` };
}
const operationSignal = (timeout) => cleaning() ? AbortSignal.timeout(timeout) : AbortSignal.any([abortController.signal, AbortSignal.timeout(timeout)]);
module.exports = { run, launch, trackProcess, workspace, postgres, freePort, until, cleanEnv, operationSignal };
