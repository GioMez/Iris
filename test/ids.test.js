const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { uuidv7, isUuid, uuidTimestamp, UUID_PATTERN } = require("../src/ids");

// Yields instead of busy-waiting: a spin loop starves the parallel test workers.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

test("generated ids really are RFC 9562 version 7", () => {
  const id = uuidv7();
  assert.match(id, new RegExp(`^${UUID_PATTERN}$`));
  // Version nibble and variant bits are what distinguish v7 from v4.
  assert.equal(id[14], "7");
  assert.ok("89ab".includes(id[19]), `unexpected variant nibble '${id[19]}'`);

  // Node's own generator is version 4: guards against ever delegating to it.
  assert.equal(crypto.randomUUID()[14], "4");
});

test("the embedded timestamp is the real creation time", () => {
  const before = Date.now();
  const id = uuidv7();
  const after = Date.now();
  const embedded = uuidTimestamp(id).getTime();
  assert.ok(embedded >= before && embedded <= after, `${embedded} outside [${before}, ${after}]`);
  assert.equal(uuidTimestamp("not-a-uuid"), null);
});

test("ids sort by creation time", async () => {
  const ordered = [];
  for (let i = 0; i < 5; i++) {
    ordered.push(uuidv7());
    await nextMillisecond();
  }
  assert.deepEqual(ordered, [...ordered].sort());

  // Control: version 4 has no such property, which is the reason for v7.
  const v4s = Array.from({ length: 8 }, () => crypto.randomUUID());
  assert.notDeepEqual(v4s, [...v4s].sort());
});

test("ids stay unique and well formed in bulk", () => {
  const batch = Array.from({ length: 20000 }, uuidv7);
  assert.equal(new Set(batch).size, batch.length);
  assert.ok(batch.every((id) => id[14] === "7" && "89ab".includes(id[19])));
});

test("ids generated inside one millisecond differ in their random bits", () => {
  // A tight burst lands inside one or two milliseconds without watching the
  // clock; group by the 48-bit prefix and inspect the batch that shares one.
  const burst = Array.from({ length: 200 }, uuidv7);
  const groups = new Map();
  for (const id of burst) {
    const prefix = id.slice(0, 13);
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(id);
  }
  const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  assert.ok(largest.length > 1, "expected several ids within one millisecond");
  // Same timestamp, different random tails: the entropy is not degraded.
  assert.equal(new Set(largest.map((id) => id.slice(14))).size, largest.length);
  // Counting prefixes would be flaky under a GC pause; ordering is the invariant.
  const prefixes = [...groups.keys()];
  assert.deepEqual(prefixes, [...prefixes].sort());
});

test("uuid recognition accepts canonical values and rejects the rest", () => {
  assert.ok(isUuid(uuidv7()));
  assert.ok(isUuid(crypto.randomUUID()));
  for (const invalid of [
    "",
    null,
    undefined,
    42,
    "0123456789abcdef0123456789abcdef",
    "019F99B9-61CF-7FEE-963F-8F7DEE086983",
    "019f99b9-61cf-7fee-963f-8f7dee08698",
    "019f99b9-61cf-7fee-963f-8f7dee086983x",
    "../019f99b9-61cf-7fee-963f-8f7dee086983",
  ]) {
    assert.equal(isUuid(invalid), false, `should reject ${String(invalid)}`);
  }
});
