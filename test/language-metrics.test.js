const test = require("node:test");
const assert = require("node:assert/strict");
const metrics = () => require("./helpers/language-metrics.cjs");
const snapshot = (generation = 2, revision = 4, status = "ready", kind = "tex", parsedTo = 100) => ({ generation, revision, status, kind, parsedTo });
const sample = (index, overrides = {}) => ({ mode: "local", index, warmup: index < 5, startTime: 1000 + index * 1000,
  endTime: 1500 + index * 1000, visibleMs: 30, summaryMs: 480, summaryObservedMs: 480,
  readyPublicationMs: 440, unavailablePublicationMs: null, status: "ready", longTasks: [], ...overrides });
const report = (label = "1m") => ({ workload: { label, codeUnits: label === "5m" ? 5 * 1024 * 1024 : 900000 },
  loads: [{ mode: "local", cold: true, startTime: 0, endTime: 900, firstViewportMs: 150, longTasks: [] }],
  samples: Array.from({ length: 25 }, (_, i) => sample(i)), observedLongTasks: [] });

test("v2 preserves load-only tasks and legacy failure while applying the typing-scoped gate", () => {
  const r = report(); r.loads[0].longTasks.push({ start: 20, duration: 80, attribution: [{ name: "unknown" }] });
  const before = structuredClone(r), result = metrics().evaluate(r);
  assert.deepEqual(result.failures, []);
  assert.equal(result.longTasks.loads.maximumMs, 80); assert.equal(result.longTasks.edits.maximumMs, 0);
  assert.equal(result.legacyWholeWindow.passed, false); assert.match(result.legacyWholeWindow.failures.join(), /long task/);
  assert.deepEqual(r, before, "policy cannot discard or relabel input evidence");
});

test("a task labelled load that starts earlier but overlaps an edit fails v2", () => {
  const r = report(); r.loads[0].longTasks.push({ start: 980, duration: 60, attribution: [] });
  const result = metrics().evaluate(r);
  assert.match(result.failures.join(), /edit.*long task/);
  assert.equal(result.longTasks.edits.maximumMs, 60);
});

test("strict editing tasks include warmups and late observer records; 50 is allowed, over 50 is not", () => {
  const r = report(); r.observedLongTasks = [{ start: 1010, duration: 50, attribution: [] }];
  assert.deepEqual(metrics().evaluate(r).failures, []);
  r.observedLongTasks[0].duration = 50.1;
  assert.match(metrics().evaluate(r).failures.join(), /edit.*long task/);
  r.observedLongTasks[0].start = 950; r.observedLongTasks[0].duration = 50;
  assert.deepEqual(metrics().evaluate(r).failures, [], "ending exactly at edit start does not overlap");
});

test("v2 gates actual ready publication, retaining the later two-frame summary observation", () => {
  const r = report(); r.samples.forEach(s => { s.readyPublicationMs = 499.9; s.summaryMs = s.summaryObservedMs = 532; });
  const result = metrics().evaluate(r);
  assert.deepEqual(result.failures, []); assert.equal(result.legacyWholeWindow.passed, false);
  assert.equal(result.summary.local.measured.p95Ms, 499.9);
  assert.equal(result.p95.local.summaryMs, 532);
});

for (const index of [0, 24]) test(`every normal 1 MiB publication meets 500ms, including ${index ? "p95-hidden maximum" : "warmup"}`, () => {
  const r = report(); r.samples[index].readyPublicationMs = 500;
  assert.deepEqual(metrics().evaluate(r).failures, []);
  r.samples[index].readyPublicationMs = 500.1;
  const result = metrics().evaluate(r);
  assert.match(result.failures.join(), /publication.*500/);
  assert.equal(result.summary.local.all.maxMs, 500.1);
  assert.equal(result.summary.local.measured.p95Ms, 440);
});

test("observed ready cannot substitute for a missing publication; unavailable never satisfies ready", () => {
  const r = report(); r.samples[3].readyPublicationMs = null;
  assert.match(metrics().evaluate(r).failures.join(), /missing.*publication/);
  r.samples[3].unavailablePublicationMs = 10; r.samples[3].status = "unavailable";
  assert.match(metrics().evaluate(r).failures.join(), /missing.*publication/);
  const limited = report("5m");
  limited.samples.forEach(s => { s.readyPublicationMs = null; s.status = "unavailable"; s.unavailablePublicationMs = 10; });
  const result = metrics().evaluate(limited);
  assert.deepEqual(result.failures, []); assert.equal(result.summary.local.all.p95Ms, null);
});

test("first viewport and visible p95 retain their independent exact thresholds", () => {
  const r = report(); r.loads[0].firstViewportMs = 200.1;
  assert.match(metrics().evaluate(r).failures.join(), /viewport/);
  r.loads[0].firstViewportMs = 200;
  r.samples[23].visibleMs = r.samples[24].visibleMs = 100.1;
  assert.match(metrics().evaluate(r).failures.join(), /visible p95/);
  r.workload.label = "100k"; r.samples[23].visibleMs = r.samples[24].visibleMs = 50.1;
  assert.match(metrics().evaluate(r).failures.join(), /visible p95/);
});

test("publication observer captures synchronous callbacks before target binding with their original timestamp", () => {
  const recorder = metrics().createPublicationRecorder();
  recorder.begin(1000);
  const s = snapshot(); recorder.observe(s, s, 1200);
  recorder.bind(s, 100);
  const result = recorder.finish(s, 1550);
  assert.equal(result.readyPublicationMs, 200); assert.equal(result.events[0].at, 1200);
  assert.deepEqual(result.target, { kind: "tex", generation: 2, revision: 4, length: 100 });
});

test("observer rejects wrong generation/revision/kind, noncurrent payload and incomplete coverage", () => {
  const recorder = metrics().createPublicationRecorder(), current = snapshot();
  recorder.begin(1000); recorder.bind(current, 100);
  for (const s of [snapshot(1), snapshot(2, 3), snapshot(2, 4, "ready", "ly"), snapshot(2, 4, "partial"), snapshot(2, 4, "ready", "tex", 99)]) recorder.observe(s, s, 1100);
  recorder.observe(snapshot(), current, 1200); // same IDs but not the current publication object
  assert.equal(recorder.finish(current, 1400).readyPublicationMs, null);
});

test("observer excludes old callbacks, retired identities and unavailability without dropping evidence", () => {
  const recorder = metrics().createPublicationRecorder(), current = snapshot();
  recorder.begin(1000); recorder.bind(current, 100);
  recorder.observe(current, current, 999);
  const unavailable = snapshot(2, 4, "unavailable", "tex", 0);
  recorder.observe(unavailable, unavailable, 1100);
  const limited = recorder.finish(unavailable, 1200);
  assert.equal(limited.readyPublicationMs, null); assert.equal(limited.unavailablePublicationMs, 100);
  assert.equal(limited.events.length, 2);
  recorder.begin(2000); recorder.bind(current, 100); recorder.observe(current, current, 2100);
  assert.equal(recorder.finish(snapshot(3), 2200).readyPublicationMs, null, "a replaced current identity invalidates the measurement");
});
