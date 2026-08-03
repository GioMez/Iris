const test = require("node:test");
const assert = require("node:assert/strict");

const { RateLimiter, ConcurrencyGate, GateRejectedError } = require("../src/throttle");

/* ---- rate limiting ---- */

test("a bucket spends its burst and then refuses with an honest wait", () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 3000 });
  const now = 1_000_000;
  assert.equal(limiter.consume("a", now).allowed, true);
  assert.equal(limiter.consume("a", now).allowed, true);
  assert.equal(limiter.consume("a", now).allowed, true);
  const refused = limiter.consume("a", now);
  assert.equal(refused.allowed, false);
  // One token accrues per windowMs/limit, so the wait is exactly that.
  assert.equal(refused.retryAfterMs, 1000);
  // And after that wait, exactly one more request gets through.
  assert.equal(limiter.consume("a", now + 1000).allowed, true);
  assert.equal(limiter.consume("a", now + 1000).allowed, false);
});

test("keys are independent", () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  const now = 5000;
  assert.equal(limiter.consume("a", now).allowed, true);
  assert.equal(limiter.consume("a", now).allowed, false);
  assert.equal(limiter.consume("b", now).allowed, true, "one caller's debt is not another's");
});

test("the bucket refills over time and never beyond its capacity", () => {
  const limiter = new RateLimiter({ limit: 5, windowMs: 5000 });
  const now = 0;
  for (let i = 0; i < 5; i++) limiter.consume("a", now);
  assert.equal(limiter.consume("a", now).allowed, false);
  // A full window later the allowance is restored, and an hour later it is
  // still exactly the allowance rather than an hour's worth of credit.
  assert.equal(limiter.available("a", now + 5000), 5);
  assert.equal(limiter.available("a", now + 3_600_000), 5);
});

test("a failure costs more than a success, and proving yourself clears the debt", () => {
  const limiter = new RateLimiter({ limit: 10, windowMs: 60000 });
  const now = 0;
  limiter.consume("user", now);
  limiter.penalize("user", now, 3);
  assert.equal(limiter.available("user", now), 6);
  // This is what a successful sign-in does: the two typos that preceded it stop
  // counting against the person who eventually got it right.
  limiter.reset("user");
  assert.equal(limiter.available("user", now), 10);
});

test("a fully refilled key leaves no trace, so one-shot callers cannot fill the map", () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  for (let i = 0; i < 500; i++) limiter.consume(`caller-${i}`, 0);
  assert.equal(limiter.size, 500);
  // Once every bucket has refilled, they all describe the same thing an absent
  // entry describes, and sweeping is free of any decision.
  assert.equal(limiter.sweep(2000), 500);
  assert.equal(limiter.size, 0);
});

test("the tracking map is bounded, and pressure never locks out an unseen caller", () => {
  const limiter = new RateLimiter({ limit: 5, windowMs: 60000, maxKeys: 20 });
  // Far more distinct sources than the map may hold, all still in debt: this is
  // the shape of an attack from a wide address range.
  for (let i = 0; i < 500; i++) limiter.consume(`ip-${i}`, 0);
  assert.ok(limiter.size <= 20, `expected the map to stay bounded, saw ${limiter.size}`);
  // A caller the limiter has never seen is still served: evicting under
  // pressure rather than refusing is what keeps the limiter from becoming the
  // denial of service it exists to prevent.
  assert.equal(limiter.consume("a-real-user", 0).allowed, true);
});

test("a limiter refuses to be constructed with a meaningless configuration", () => {
  assert.throws(() => new RateLimiter({ limit: 0, windowMs: 1000 }), /positive limit/);
  assert.throws(() => new RateLimiter({ limit: 5, windowMs: 0 }), /positive windowMs/);
});

/* ---- concurrency ---- */

test("the gate admits up to its limit and queues the rest in arrival order", async () => {
  const gate = new ConcurrencyGate({ limit: 2, queueLimit: 4 });
  const first = await gate.acquire();
  const second = await gate.acquire();
  assert.equal(gate.active, 2);

  const order = [];
  const third = gate.acquire().then((release) => { order.push("third"); return release; });
  const fourth = gate.acquire().then((release) => { order.push("fourth"); return release; });
  assert.equal(gate.queued, 2);

  first();
  await third;
  assert.deepEqual(order, ["third"], "the slot goes to whoever was waiting longest");
  second();
  await fourth;
  assert.deepEqual(order, ["third", "fourth"]);
  (await third)();
  (await fourth)();
  assert.equal(gate.active, 0);
});

test("a caller past the queue limit is refused at once rather than made to wait", async () => {
  const gate = new ConcurrencyGate({ limit: 1, queueLimit: 1 });
  const held = await gate.acquire();
  const queued = gate.acquire();
  await assert.rejects(() => gate.acquire(), (err) => {
    assert.ok(err instanceof GateRejectedError);
    assert.equal(err.code, "GATE_QUEUE_FULL");
    return true;
  });
  held();
  (await queued)();
});

test("releasing twice cannot let the gate over-admit", async () => {
  const gate = new ConcurrencyGate({ limit: 1, queueLimit: 2 });
  const release = await gate.acquire();
  release();
  release();
  assert.equal(gate.active, 0, "a double release must not push the count below zero");
  // The slot is still exactly one: a second caller gets in, a third queues.
  const a = await gate.acquire();
  assert.equal(gate.active, 1);
  const b = gate.acquire();
  assert.equal(gate.queued, 1);
  a();
  (await b)();
});

test("draining tells everyone still waiting instead of leaving them hanging", async () => {
  const gate = new ConcurrencyGate({ limit: 1, queueLimit: 3 });
  const held = await gate.acquire();
  const waiting = [gate.acquire(), gate.acquire()];
  assert.equal(gate.drain("GATE_UNAVAILABLE"), 2);
  for (const pending of waiting) {
    await assert.rejects(() => pending, (err) => err.code === "GATE_UNAVAILABLE");
  }
  held();
});
