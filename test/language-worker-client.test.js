const test = require("node:test");
const assert = require("node:assert/strict");
async function setup(t, factory, timeout = 100) {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createWorkerClient } = await import("../public/iris-language-worker-client.mjs");
  const client = createWorkerClient(await loadLanguage("tex"), { workerFactory: factory, timeout });
  t.after(() => client.dispose()); return client;
}
function transport() {
  return { messages: [], terminated: false, postMessage(message) { this.messages.push(message); }, terminate() { this.terminated = true; } };
}
for (const fault of ["load", "error", "messageerror", "reject", "timeout", "post"]) test(`Worker ${fault} fault settles explicitly and releases its slot`, async t => {
  const worker = transport();
  const client = await setup(t, () => { if (fault === "load") throw Error("asset missing"); return worker; }, 20);
  if (fault === "post") worker.postMessage = () => { throw Error("clone rejected"); };
  const pending = client.parse("{x}", { generation: 1, revision: 1 });
  if (fault === "error") worker.onerror({ preventDefault() {} });
  if (fault === "messageerror") worker.onmessageerror({});
  if (fault === "reject") worker.onmessage({ data: { ...worker.messages[0], type: "error", reason: "rejected" } });
  const result = await pending;
  assert.equal(result.status, "unavailable"); assert.equal(result.tree, null);
  if (fault !== "load") assert.equal(worker.terminated, true);
  assert.equal((await client.parse("x", { generation: 1, revision: 2 })).status, "unavailable");
});

test("old responses after replacement cannot finish or cancel the new request", async t => {
  const worker = transport(), client = await setup(t, () => worker);
  const old = client.parse("old", { generation: 1, revision: 1 }), response = { ...worker.messages[0], type: "error", reason: "obsolete" };
  const current = client.parse("new", { generation: 2, revision: 2 });
  assert.equal((await old).reason, "cancelled");
  worker.onmessage({ data: response });
  assert.equal(worker.terminated, false);
  client.dispose(); assert.equal((await current).status, "unavailable");
});

test("stale generation/revision requests cannot retire the current document", async t => {
  const worker = transport(), client = await setup(t, () => worker);
  const current = client.parse("new project", { generation: 2, revision: 10 });
  const stale = await client.parse("same path from old project", { generation: 1, revision: 9 });
  assert.equal(stale.reason, "stale-identity");
  assert.equal(worker.messages.filter(m => m.type === "parse").length, 1);
  client.dispose(); assert.equal((await current).status, "unavailable");
});

test("concurrency and waiting owners are bounded; disposal settles queued requests", async t => {
  let live = 0, peak = 0;
  const factory = () => { const w = transport(); live++; peak = Math.max(peak, live); w.terminate = () => { live--; }; return w; };
  const clients = [], pending = [];
  for (let i = 0; i < 22; i++) {
    const client = await setup(t, factory, 1000); clients.push(client);
    pending.push(client.parse("text", { generation: 0, revision: 0 }));
  }
  for (const client of clients) client.dispose();
  const result = await Promise.all(pending);
  assert.equal(peak, 2); assert.equal(live, 0);
  assert.ok(result.every(r => r.status === "unavailable"));
  assert.equal(result.filter(r => r.reason === "worker-capacity").length, 4);
});
