const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

async function fixture(t, target, when, failRemoval = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-smoke-cancellation-"));
  const tmp = path.join(root, "temporary"), bin = path.join(root, "bin");
  await fs.mkdir(tmp); await fs.mkdir(bin);
  await fs.writeFile(path.join(root, "engine.json"), JSON.stringify({ target, when, failRemoval, containers: {}, volumes: {}, calls: [] }));
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  await fs.writeFile(path.join(bin, "docker"), `#!/bin/sh\nexec ${[process.execPath, path.join(__dirname, "helpers/smoke-engine.cjs"), root].map(quote).join(" ")} "$@"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "helpers/smoke-cancellation.cjs"), path.resolve(__dirname, "../scripts/smoke.cjs"), "--engine", "docker", "--use-image"], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, TMPDIR: tmp, SMOKE_CANCELLATION_ROOT: root },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
  t.after(async () => { child.kill("SIGKILL"); await fs.rm(root, { recursive: true, force: true }); });
  const wait = async (name) => {
    const deadline = Date.now() + 6000;
    while (!await fs.stat(path.join(root, name)).catch(() => null)) {
      assert.ok(Date.now() < deadline && child.exitCode == null, `${name}: ${output}`); await delay(10);
    }
  };
  return { root, tmp, child, done, wait, output: () => output,
    state: async () => JSON.parse(await fs.readFile(path.join(root, "engine.json"), "utf8")),
  };
}

for (const target of ["probe", "helper"]) for (const when of ["before", "during"]) {
  test(`smoke interruption ${when} ${target} cleanup removes its standalone resource`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t, target, when);
    await f.wait("paused");
    assert.equal(await fs.readFile(path.join(f.root, "paused"), "utf8"), `${when === "before" ? "run" : "rm"}-${target}`);
    assert.ok(Object.values((await f.state()).containers).some((c) => c.kind === target), "engine-side resource exists before interruption");
    f.child.kill("SIGINT"); await f.wait("interrupt-seen");
    if (when === "during") await fs.writeFile(path.join(f.root, "release"), "");
    assert.notEqual(await f.done, 0, "interrupted smoke cannot succeed");
    assert.deepEqual((await f.state()).containers, {}, f.output());
    assert.deepEqual((await f.state()).volumes, {}, f.output());
    assert.equal(!!await fs.stat(path.join(f.root, "cleanup-killed")).catch(() => null), false, "interrupt cannot kill an in-progress removal");
    assert.match(f.output(), /Cleanup confirmed/);
    assert.deepEqual(await fs.readdir(f.tmp), []);
  });
}

test("smoke reports failed standalone removal and retains its workspace for diagnosis", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, "probe", "before", true);
  await f.wait("paused"); f.child.kill("SIGINT"); await f.wait("interrupt-seen");
  assert.notEqual(await f.done, 0);
  assert.ok(Object.keys((await f.state()).containers).length);
  assert.match(f.output(), /Cleanup failed/);
  assert.doesNotMatch(f.output(), /Cleanup confirmed/);
  assert.ok((await fs.readdir(f.tmp)).length, "failed cleanup must not discard ownership evidence");
});

test("final cleanup retries a failed helper removal before disposing its volume", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, "helper", "before", "once");
  await f.wait("paused"); f.child.kill("SIGINT"); await f.wait("interrupt-seen");
  assert.notEqual(await f.done, 0);
  assert.deepEqual((await f.state()).containers, {}, f.output());
  assert.deepEqual((await f.state()).volumes, {}, f.output());
  assert.match(f.output(), /Cleanup confirmed/);
  assert.deepEqual(await fs.readdir(f.tmp), []);
});
