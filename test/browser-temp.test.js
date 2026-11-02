const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const runtime = require("../scripts/lib/disposable.cjs");
const posix = { skip: process.platform === "win32" };

test("browser socket temp is private, short, unique and isolated from app/compiler temp", posix, async t => {
  const work = await runtime.workspace("iris-browser-temp-");
  t.after(() => work.close());
  assert.equal(typeof runtime.browserTemp, "function", "owned browser socket temp helper is required");
  const ambient = { ...process.env }, environment = { ...work.env }, first = runtime.browserTemp(work), second = runtime.browserTemp(work);
  assert.notEqual(first.env.TMPDIR, second.env.TMPDIR);
  assert.deepEqual(work.env, environment);
  assert.deepEqual({ ...process.env }, ambient);
  assert.equal(first.env.HOME, work.env.HOME);
  assert.equal(first.env.TMP, first.env.TMPDIR);
  assert.equal(first.env.TEMP, first.env.TMPDIR);
  assert.equal((await fs.stat(first.env.TMPDIR)).mode & 0o777, 0o700);
  const socket = path.join(first.env.TMPDIR, "org.chromium.Chromium.abcdef", "SingletonSocket");
  assert.ok(Buffer.byteLength(socket) < 104, "fits POSIX Unix socket paths including Chromium's suffix");
  await fs.mkdir(path.dirname(socket));
  const server = net.createServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  await new Promise(resolve => server.close(resolve));
  await first.close(); await first.close();
  assert.equal(await fs.stat(first.env.TMPDIR).catch(() => null), null);
  assert.ok(await fs.stat(second.env.TMPDIR));
  await work.close();
  assert.equal(await fs.stat(second.env.TMPDIR).catch(() => null), null);
});

test("browser socket temp is registered before a failed asynchronous launch handoff", posix, async t => {
  const work = await runtime.workspace("iris-browser-temp-failure-");
  t.after(() => work.close());
  assert.equal(typeof runtime.browserTemp, "function");
  let temp;
  await assert.rejects(async () => {
    temp = runtime.browserTemp(work);
    await Promise.resolve();
    throw new Error("launch handoff failed");
  }, /launch handoff failed/);
  await work.close();
  assert.equal(await fs.stat(temp.env.TMPDIR).catch(() => null), null);
});

test("already cancelled browser temp acquisition allocates no owned resource", () => {
  assert.equal(typeof runtime.browserTemp, "function");
  const reason = new Error("cancelled before launch");
  assert.throws(() => runtime.browserTemp({ signal: AbortSignal.abort(reason), defer() { assert.fail("must not allocate after cancellation"); } }), error => error === reason);
});

test("Windows browser temp retains its qualified driver paths without POSIX allocation", { skip: process.platform !== "win32" }, async () => {
  assert.equal(typeof runtime.browserTemp, "function");
  const env = { TMPDIR: "C:\\owned\\tmp", TMP: "C:\\owned\\tmp", TEMP: "C:\\owned\\tmp", HOME: "C:\\owned\\home" };
  const temp = runtime.browserTemp({ env, signal: new AbortController().signal, defer() { assert.fail("Windows needs no POSIX socket root"); } });
  assert.deepEqual(temp.env, env);
  await temp.close();
});
