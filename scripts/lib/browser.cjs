// Browser ownership belongs to the disposable runtime, including an unresolved
// launch. Playwright's SIGINT default calls process.exit before PG/app cleanup.
const { AsyncLocalStorage } = require("node:async_hooks");
const { channel } = require("node:diagnostics_channel");
const { trackProcess } = require("./disposable.cjs");
const launches = new AsyncLocalStorage();
async function withBrowser(work, options, use) {
  const signal = work.signal;
  signal.throwIfAborted();
  const { chromium } = require("playwright-core");
  // Playwright allocates driver-side profiles before checking the executable.
  // Its env option only configures Chrome; scope driver temp files to our root
  // too, so a failed launch cannot leave profiles outside owned cleanup.
  const previous = Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = work.tmp;
  let pending;
  const token = {}, stops = [], children = channel("child_process");
  const observe = ({ process: child }) => {
    if (launches.getStore() !== token) return;
    // Node publishes this channel at construction, before pid/spawnargs exist.
    // Register ownership now, and classify after the native spawn completes.
    const owned = new Promise((resolve) => {
      child.once("spawn", () => resolve(child.spawnargs.includes("--remote-debugging-pipe")
        ? trackProcess(child, child.spawnfile, { allowFailure: true }) : null));
      child.once("error", () => resolve(null));
    });
    stops.push(work.defer(async () => { const process = await owned; if (process) await process.stop(); }));
  };
  children.subscribe(observe);
  const close = work.defer(async () => {
    const browser = await pending?.catch(() => null);
    try { if (browser) await browser.close(); }
    finally { for (const stop of stops) await stop(); }
  });
  const cancel = () => { void close().catch(() => {}); }; // finally awaits/retries cleanup failures
  signal.addEventListener("abort", cancel, { once: true });
  try {
    pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return launches.run(token, () => chromium.launch({ headless: true, timeout: 10000, env: work.env, ...options,
        handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }));
    });
    const browser = await pending;
    signal.throwIfAborted(); // A late launch result must close without entering browser work.
    const result = await use(browser);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    try { await close(); }
    finally {
      children.unsubscribe(observe);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}
module.exports = { withBrowser };
