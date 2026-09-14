// Replace only the HTTP journey. Container ownership, real subprocesses, signal
// handling and the smoke adapter's probe/helper/finally paths run as shipped.
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const load = Module._load;
Module._load = function (name, ...args) {
  const exports = load.call(this, name, ...args);
  if (name === "./lib/smoke-journey.cjs") return { ...exports, journey: async (source) => source.marker(true) };
  return exports;
};
process.on("SIGINT", () => fs.writeFileSync(path.join(process.env.SMOKE_CANCELLATION_ROOT, "interrupt-seen"), ""));
