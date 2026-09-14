// Timing/ownership observer for real entrypoints, PostgreSQL and installed Chrome.
// No compiler/API/browser substitutes: pauses make signal delivery deterministic.
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const phase = process.env.IRIS_BROWSER_LIFECYCLE_PHASE;
const send = (event) => process.send?.(event);
const owned = [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
let release;
process.on("message", (message) => { if (message === "release") { release?.(); process.channel?.unref(); } });
process.channel?.unref();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => send({ kind: "signal", signal }));
const pause = () => new Promise((resolve) => { process.channel?.ref(); release = resolve; send({ kind: "paused", phase }); });

const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const child = spawn.call(this, command, args, options);
  const kind = args?.includes("--remote-debugging-pipe") ? "chrome"
    : args?.some((arg) => /[/\\]src[/\\]server\.js$/.test(arg)) ? "app" : null;
  if (kind) {
    owned.push({ kind, pid: child.pid });
    send({ kind, pid: child.pid });
    child.on("exit", (code, signal) => send({ kind: "process-exit", process: kind, pid: child.pid, code, signal }));
    if (kind === "chrome" && phase === "launch-timeout") {
      // Suspend the actual child before protocol negotiation completes. This
      // exercises a real in-flight launch that must time out and kill Chrome.
      process.kill(child.pid, "SIGSTOP");
      send({ kind: "paused", phase });
    }
    if (kind === "chrome" && phase === "launch-crash") process.kill(child.pid, "SIGKILL");
  }
  return child;
};

const runtime = require("../../scripts/lib/disposable.cjs");
const workspace = runtime.workspace, postgres = runtime.postgres;
runtime.workspace = async (...args) => {
  const work = await workspace(...args);
  send({ kind: "workspace", root: work.root });
  const close = work.close;
  work.close = async () => {
    await close();
    send({ kind: "workspace-closed", root: work.root,
      survivors: owned.filter(({ kind, pid }) => alive(pid) || (kind !== "postgres" && alive(-pid))) });
  };
  return work;
};
runtime.postgres = async (work, ...args) => {
  const pg = await postgres(work, ...args);
  const data = path.join(work.root, "pgdata");
  const pid = Number(fs.readFileSync(path.join(data, "postmaster.pid"), "utf8").split("\n")[0]);
  owned.push({ kind: "postgres", pid });
  send({ kind: "postgres", data, pid, tool: pg.tool("pg_ctl") });
  return pg;
};

const { chromium } = require("playwright-core");
const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  if (phase === "before-launch") await pause();
  const browser = await launch(options);
  send({ kind: "browser-ready", version: browser.version() });
  // Hold delivery of a real launch result: the caller still owns an unresolved
  // launch while Chrome already exists. Keep the resource for its actual caller.
  if (phase === "during-launch") await pause();
  const close = browser.close.bind(browser);
  if (phase === "during-close") browser.close = async (...args) => { await pause(); return close(...args); };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    send({ kind: "browser-use" });
    const context = await newContext(...args), newPage = context.newPage.bind(context);
    context.newPage = async (...args) => {
      const page = await newPage(...args), goto = page.goto.bind(page);
      if (phase === "during-work") page.goto = async (...args) => {
        const response = await goto(...args);
        // An outstanding real protocol wait must end when the owner cancels.
        const waiting = page.evaluate(() => new Promise(() => {}));
        send({ kind: "paused", phase });
        await waiting;
        return response;
      };
      return page;
    };
    return context;
  };
  return browser;
};
