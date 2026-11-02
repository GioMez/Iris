const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { languageBrowser } = require("./helpers/language-browser.cjs");
const { workload, representative, save, machine, installProbe } = require("./helpers/language-performance.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1" && process.env.IRIS_LANGUAGE_QUALIFY === "1";
const root = path.resolve(__dirname, "..");

function baseRoutes() {
  // Read Git objects only, in the retained worktree. No checkout/worktree writes.
  const ref = "2bdafe8", git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(git(["show", `${ref}:package.json`])).dependencies, require("../package.json").dependencies);
  const files = new Set(git(["ls-tree", "-r", "--name-only", ref, "public"]).trim().split(/\r?\n/)), content = new Map();
  return async page => page.route("**/*", async route => {
    const pathname = new URL(route.request().url()).pathname, file = `public/${pathname === "/" ? "Iris.html" : pathname.slice(1)}`;
    if (!files.has(file) || !/\.(?:js|mjs|css|html)$/.test(file)) return route.fallback();
    if (!content.has(file)) content.set(file, git(["show", `${ref}:${file}`]));
    return route.fulfill({ body: content.get(file), contentType: file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "text/javascript" });
  });
}

for (const [kind, label, variant] of [
  ["tex", "1m", "current"], ["tex", "representative-1m", "current"], ["ly", "1m", "current"],
  ["tex", "5m", "current"], ["ly", "5m", "current"],
  ["tex", "5m", "pre-hp08-control"], ["ly", "5m", "pre-hp08-control"],
]) test(`HP08 cold/warm load proof ${variant} ${kind} ${label}`, { skip: !enabled, timeout: 300000 }, async t => {
  const control = variant === "pre-hp08-control", limited = label === "5m";
  const pageFor = await languageBrowser(t, control ? { beforeNavigate: baseRoutes() } : {});
  const w = label === "representative-1m" ? representative(kind) : workload(kind, limited ? 5 * 1048576 : 1048576);
  const report = { machine: machine(), variant, base: control ? "2bdafe8" : null, workload: { kind, label, ...w.metrics },
    method: "unchanged hp08.load (loadCollab/select/focus), fresh page cold then reload after 25 local and 25 remote edits; no CPU/flatten probes",
    loads: [], preparationEdits: [], failures: [] };
  for (let round = 0; round < (limited ? 3 : 1); round++) {
    const page = await pageFor(t, [{ id: "main", type: "file", kind, name: `main.${kind}`, content: "" }]);
    report.browser = page.context().browser().version();
    await installProbe(page);
    await page.evaluate(w => { window.hp08Workload = w; }, w);
    for (const phase of ["cold", "after-local-25", "after-remote-25"]) {
      if (phase !== "cold") {
        const mode = phase === "after-local-25" ? "local" : "remote";
        for (let i = 0; i < 25; i++) report.preparationEdits.push({ round, ...await page.evaluate(({ mode, i }) => hp08.edit(hp08Workload, mode, i), { mode, i }) });
      }
      const sample = await page.evaluate(() => hp08.load(hp08Workload));
      report.loads.push({ round, phase, ...sample });
      assert.ok(sample.ok && sample.syntaxReady);
      assert.equal(sample.status, limited ? "unavailable" : "ready"); assert.equal(sample.covered, !limited);
      if (limited) assert.equal(sample.lrStarts, 0);
      if (sample.longTasks.some(task => task.duration > 50)) report.failures.push({ round, phase, tasks: sample.longTasks });
      await save(`load-proof-${variant}-${kind}-${label}`, report);
    }
    await page.context().close();
  }
  t.diagnostic(JSON.stringify({ variant, workload: report.workload, loads: report.loads, failures: report.failures }));
  // Control collection is diagnostic, not a claim the base passes this rule.
  if (!control) assert.deepEqual(report.failures, [], "unchanged whole-observer load-task rule; every raw task retained");
});
