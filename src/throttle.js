// Admission control: how much work a caller may ask the process to do, and how
// much of that work may be in flight at once. Kept pure — the clock is injected
// and nothing here starts a timer — so the decision tables are unit-tested
// without a server, a socket or a database.
//
// Two shapes cover every case the server has:
//
//   * RateLimiter bounds a *rate*. It answers "may this caller start another
//     one now", which is what protects an endpoint whose cost is paid before
//     the answer is known — a password verification is the motivating case,
//     because Argon2 spends its memory whether or not the password is right.
//   * ConcurrencyGate bounds a *population*. It answers "may this work run
//     yet", holding the rest in a bounded queue, which is what protects a
//     resource whose total cost is the sum of what is running — compiler
//     processes are the motivating case.
//
// The two are deliberately separate: a rate limit alone still permits a hundred
// simultaneous Argon2 hashes if they arrive in the same second, and a
// concurrency gate alone still permits an attacker to keep the queue
// permanently full at no cost to themselves.

// A token bucket rather than a fixed window, for two reasons that both matter
// here. It has no boundary burst — a fixed window lets twice the limit through
// across the instant two windows meet — and it yields an honest Retry-After,
// because the time until the next token is a quantity the bucket already knows.
//
// The bucket is also self-describing for memory purposes: an entry that has
// refilled to capacity is indistinguishable from an entry that never existed,
// so sweeping is exactly "forget every full bucket" and needs no separate
// expiry bookkeeping.
class RateLimiter {
  // `limit` tokens accumulate over `windowMs`, and `limit` is also the burst a
  // caller may spend at once. `maxKeys` bounds the tracking map itself: a
  // limiter that grows a permanent entry per source address is its own denial
  // of service, which is the failure mode this parameter exists to prevent.
  constructor({ limit, windowMs, maxKeys = 10000 } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("RateLimiter requires a positive limit");
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("RateLimiter requires a positive windowMs");
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = Math.max(1, Math.floor(maxKeys));
    this.ratePerMs = limit / windowMs;
    this.buckets = new Map();
  }

  // Tokens a key holds right now, without recording anything. Refill is computed
  // from elapsed time instead of being driven by a timer, so an idle limiter
  // costs nothing and a process that was suspended does not owe anyone tokens.
  available(key, now) {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.limit;
    return Math.min(this.limit, bucket.tokens + (now - bucket.updatedAt) * this.ratePerMs);
  }

  // Spends `cost` tokens when the key can afford them. The refusal carries the
  // wait in milliseconds, so the caller can answer with a Retry-After that is
  // true rather than a guess.
  consume(key, now = Date.now(), cost = 1) {
    const tokens = this.available(key, now);
    if (tokens < cost) {
      return { allowed: false, remaining: tokens, retryAfterMs: Math.ceil((cost - tokens) / this.ratePerMs) };
    }
    const remaining = tokens - cost;
    // A key back at full capacity is the same as an absent one, so it is not
    // worth an entry. This is what keeps a stream of one-shot callers from
    // leaving a permanent trace in the map.
    if (remaining >= this.limit) this.buckets.delete(key);
    else this.#store(key, remaining, now);
    return { allowed: true, remaining, retryAfterMs: 0 };
  }

  // Charges a key without asking permission first. Failure-driven limits use
  // this: a wrong password should cost more than a right one, and the charge
  // has to land after the answer is known.
  penalize(key, now = Date.now(), cost = 1) {
    const remaining = Math.max(0, this.available(key, now) - cost);
    if (remaining >= this.limit) this.buckets.delete(key);
    else this.#store(key, remaining, now);
    return remaining;
  }

  // Forgets a key's debt. A successful authentication calls this so a user who
  // mistyped a password twice is not still paying for it an hour later.
  reset(key) {
    this.buckets.delete(key);
  }

  #store(key, tokens, now) {
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) this.#evict(now);
    this.buckets.set(key, { tokens, updatedAt: now });
  }

  // Runs only when the map is at its cap. Full buckets go first because
  // dropping them changes no decision at all; if that is not enough, the
  // buckets closest to being full go next, since they are the ones whose loss
  // grants the least undeserved credit. Evicting rather than refusing is
  // deliberate: refusing new keys under pressure would let anyone with a wide
  // address range lock out every caller the limiter has not seen yet.
  #evict(now) {
    for (const [key] of this.buckets) {
      if (this.available(key, now) >= this.limit) this.buckets.delete(key);
    }
    if (this.buckets.size < this.maxKeys) return;
    const ranked = Array.from(this.buckets.keys())
      .map((key) => ({ key, tokens: this.available(key, now) }))
      .sort((a, b) => b.tokens - a.tokens);
    const excess = this.buckets.size - this.maxKeys + 1;
    for (let index = 0; index < excess && index < ranked.length; index++) {
      this.buckets.delete(ranked[index].key);
    }
  }

  // Periodic housekeeping for a long-lived limiter, so a quiet process does not
  // hold entries for callers that have long since gone away.
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [key] of this.buckets) {
      if (this.available(key, now) >= this.limit) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.buckets.size;
  }
}

class GateRejectedError extends Error {
  constructor(code = "GATE_QUEUE_FULL") {
    super(code);
    this.code = code;
  }
}

// Bounds how much expensive work runs at once, and how much may wait. The queue
// is bounded on purpose: an unbounded queue does not protect a resource, it only
// moves the exhaustion from the CPU to the heap and replaces a fast refusal with
// a slow one. Callers past the queue limit are refused immediately, which is the
// honest answer and the one a client can act on.
class ConcurrencyGate {
  constructor({ limit, queueLimit = 0 } = {}) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("ConcurrencyGate requires a positive limit");
    this.limit = Math.floor(limit);
    this.queueLimit = Math.max(0, Math.floor(queueLimit));
    this.active = 0;
    this.waiting = [];
  }

  // Resolves to the release function once a slot is free. Release is idempotent,
  // so a caller that releases in both a success path and a `finally` cannot
  // hand back a slot it no longer holds and let the gate over-admit.
  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.#release());
    }
    if (this.waiting.length >= this.queueLimit) return Promise.reject(new GateRejectedError());
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }

  #release() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // The slot is handed straight to the next waiter instead of being given
      // back to the pool, so a burst cannot slip past a queue that is already
      // holding callers who arrived first.
      if (next) return next.resolve(this.#release());
      this.active -= 1;
    };
  }

  // Refuses everyone still waiting. Shutdown uses this: a caller that will never
  // get a slot should be told so rather than left holding a request open until
  // the process dies under it.
  drain(code = "GATE_UNAVAILABLE") {
    const waiting = this.waiting.splice(0);
    for (const entry of waiting) entry.reject(new GateRejectedError(code));
    return waiting.length;
  }

  get queued() {
    return this.waiting.length;
  }
}

module.exports = { RateLimiter, ConcurrencyGate, GateRejectedError };
