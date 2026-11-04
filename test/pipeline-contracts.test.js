const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePlan, resolveTarget, validateParameters } = require("../src/pipeline/contracts");
const { createRegistry } = require("../src/pipeline/registry");

const digest = "a".repeat(64);
const sourceType = "application/vnd.iris.source-tree";
const port = (kind, mediaType, required = true) => ({ kinds: [kind], mediaTypes: [mediaType], required });
const ref = (step, port = "out") => ({ step, port });
const output = (path = "result.txt", mediaType = "text/plain", kind = "file") => ({ path, mediaType, kind });
const emptyOptions = { type: "object", properties: {} };

function fixture() {
  let executions = 0;
  const definitions = [
    { id: "generate", version: "1.0.0", implementationHash: digest,
      optionsSchema: emptyOptions, inputs: {}, outputs: { out: port("file", "text/plain") },
      capabilities: ["generate.text"], execute: async () => { executions++; } },
    { id: "transform", version: "1.0.0", implementationHash: digest,
      optionsSchema: emptyOptions, inputs: { input: port("file", "text/plain") },
      outputs: { out: port("file", "text/plain") }, capabilities: [], execute: async () => { executions++; } },
    { id: "validate", version: "1.0.0", implementationHash: digest,
      optionsSchema: emptyOptions, inputs: {}, outputs: {}, capabilities: [], execute: async () => { executions++; } },
    { id: "compile", version: "1.0.0", implementationHash: digest,
      optionsSchema: { type: "object", properties: { engine: { type: "string", enum: ["latex", "lilypond"] } }, required: ["engine"] },
      inputs: { source: port("collection", sourceType), include: port("file", "text/plain", false) },
      outputs: { pdf: port("file", "application/pdf") }, capabilities: ["compile.pdf"], execute: async () => { executions++; } },
    { id: "lua", version: "1.0.0", implementationHash: digest,
      optionsSchema: emptyOptions, inputs: {}, outputs: {},
      additionalInputs: { kinds: ["file", "collection", "layout"], mediaTypes: ["*/*"] },
      additionalOutputs: { kinds: ["file", "collection", "layout"], mediaTypes: ["*/*"] },
      capabilities: [], execute: async () => { executions++; } },
  ];
  const registry = createRegistry(definitions);
  return { registry, definitions, executions: () => executions };
}
function step(id, adapter = "generate", extra = {}) {
  return { id, adapter: { id: adapter, version: "1.0.0" }, inputs: {}, options: {}, outputs: { out: output() }, ...extra };
}
function plan(steps = [step("first")], targets = { default: { steps: [steps.at(-1).id], publish: [ref(steps.at(-1).id)] } }) {
  return { apiVersion: 1, pluginId: "fixture", parameterSchema: emptyOptions, parameters: {}, requiredCapabilities: [], steps, targets };
}
function rejected(value, code = "PIPELINE_PLAN_INVALID", policy) {
  const f = fixture();
  assert.throws(() => validatePlan(value, { registry: f.registry, policy }), { code });
  assert.equal(f.executions(), 0, "validation must not call adapter execution");
}

test("pipeline target selects a diamond's shared prerequisite once and excludes unrelated work", () => {
  const f = fixture();
  const p = plan([
    step("join", "validate", { outputs: {}, after: ["right", "left"] }),
    step("unrelated"),
    step("left", "transform", { inputs: { input: ref("seed") } }),
    step("right", "transform", { inputs: { input: ref("seed") } }),
    step("seed"),
  ], { check: { steps: ["join"], publish: [ref("left")] } });
  const validated = validatePlan(p, { registry: f.registry });
  const selected = resolveTarget(validated, "check");
  assert.equal(selected.steps.length, 4);
  assert.deepEqual(new Set(selected.steps.map(s => s.id)), new Set(["seed", "left", "right", "join"]));
  const ids = selected.steps.map(s => s.id);
  assert.ok(ids.indexOf("seed") < ids.indexOf("left") && ids.indexOf("seed") < ids.indexOf("right"));
  assert.ok(ids.indexOf("left") < ids.indexOf("join") && ids.indexOf("right") < ids.indexOf("join"));
  assert.deepEqual(selected.publish, [ref("left")]);
  assert.equal(f.executions(), 0);
});

test("validation-only targets can succeed without output ports or artifacts", () => {
  const f = fixture();
  const p = plan([step("check", "validate", { outputs: {} })], { validate: { steps: ["check"], publish: [] } });
  const selected = resolveTarget(validatePlan(p, { registry: f.registry }), "validate");
  assert.deepEqual(selected.steps.map(s => s.id), ["check"]);
  assert.deepEqual(selected.publish, []);
  assert.equal(selected.primaryPreview, null);
});

test("explicit two-pass and mixed-engine graphs retain compiler-independent dependencies", () => {
  const f = fixture();
  const p = plan([
    step("first", "compile", { inputs: { source: { snapshot: true } }, options: { engine: "latex" }, outputs: { pdf: output("first.pdf", "application/pdf") } }),
    step("adjust", "lua", { inputs: { layoutSource: ref("first", "pdf") }, outputs: { out: output("include.ily") } }),
    step("second", "compile", { inputs: { source: { snapshot: true }, include: ref("adjust") }, options: { engine: "lilypond" }, outputs: { pdf: output("score.pdf", "application/pdf") } }),
  ], { score: { steps: ["second"], publish: [ref("second", "pdf")], primaryPreview: ref("second", "pdf") } });
  const selected = resolveTarget(validatePlan(p, { registry: f.registry }), "score");
  assert.deepEqual(selected.steps.map(s => s.id), ["first", "adjust", "second"]);
  assert.deepEqual(selected.steps.filter(s => s.adapter.id === "compile").map(s => s.options.engine), ["latex", "lilypond"]);
  assert.deepEqual(selected.primaryPreview, ref("second", "pdf"));
});

test("publication references make their producers reachable without a redundant terminal list", () => {
  const f = fixture();
  const p = plan([step("first")], { export: { steps: [], publish: [ref("first")] } });
  assert.deepEqual(resolveTarget(validatePlan(p, { registry: f.registry }), "export").steps.map(s => s.id), ["first"]);
});

test("artifact, completion and mixed-edge cycles are rejected before execution", () => {
  rejected(plan([step("a", "transform", { inputs: { input: ref("b") } }), step("b", "transform", { inputs: { input: ref("a") } })]));
  rejected(plan([step("a", "generate", { after: ["b"] }), step("b", "generate", { after: ["a"] })]));
  rejected(plan([step("a", "generate", { after: ["b"] }), step("b", "transform", { inputs: { input: ref("a") } })]));
  rejected(plan([step("a", "generate", { after: ["a"] })]));
});

test("unreachable invalid steps are rejected instead of hidden by target selection", () => {
  rejected(plan([step("first"), step("invalid", "transform", { inputs: { input: ref("missing") } })], { default: { steps: ["first"], publish: [ref("first")] } }));
});

test("missing ports, producers, targets and completion steps fail explicitly", () => {
  for (const missing of [ref("missing"), ref("first", "absent")]) {
    rejected(plan([step("first"), step("consumer", "transform", { inputs: { input: missing } })]));
  }
  rejected(plan([step("first", "generate", { after: ["absent"] })]));
  rejected(plan([step("first")], { broken: { steps: ["missing"], publish: [] } }));
  rejected(plan([step("first")], { broken: { steps: ["first"], publish: [ref("first", "missing")] } }));
  const f = fixture();
  assert.throws(() => resolveTarget(validatePlan(plan(), { registry: f.registry }), "missing"), { code: "PIPELINE_TARGET_UNKNOWN" });
});

test("typed ports reject missing required inputs, wrong media and collection/file mismatches", () => {
  rejected(plan([step("first", "transform")]));
  rejected(plan([step("first", "generate", { outputs: { out: output("bad.pdf", "application/pdf") } })]));
  rejected(plan([step("first"), step("consumer", "transform", { inputs: { input: { snapshot: true } } })]));
  rejected(plan([step("first", "lua", { outputs: { out: output("text", "text/plain", "collection") } }), step("consumer", "transform", { inputs: { input: ref("first") } })]));
  rejected(plan([step("first", "generate", { outputs: {} })]));
  rejected(plan([step("first", "generate", { outputs: { out: output(), extra: output("extra.txt") } })]));
});

test("duplicate step identifiers and duplicate/overlapping output roots are rejected", () => {
  rejected(plan([step("duplicate"), step("duplicate")]));
  for (const second of ["bundle", "bundle/part.txt"]) {
    rejected(plan([step("first", "lua", { outputs: { out: output("bundle", sourceType, "collection"), other: output(second) } })]));
  }
  const f = fixture();
  assert.equal(validatePlan(plan([step("one"), step("two")]), { registry: f.registry }).steps.length, 2, "different steps own independent roots");
});

test("output paths reject traversal and platform aliases while retaining Unicode", () => {
  for (const path of ["../x", "/x", "C:/x", "a\\b", "a/./b", "a//b", "a/../b", "x\0y", ".", "", "a/"]) {
    rejected(plan([step("first", "generate", { outputs: { out: output(path) } })]));
  }
  const f = fixture();
  assert.equal(validatePlan(plan([step("first", "generate", { outputs: { out: output("é/part one.txt") } })]), { registry: f.registry }).steps[0].outputs.out.path, "é/part one.txt");
});

test("preview must reference a published previewable file", () => {
  rejected(plan([step("first")], { bad: { steps: ["first"], publish: [ref("first")], primaryPreview: ref("first") } }));
  rejected(plan([step("first", "lua", { outputs: { out: output("main.pdf", "application/pdf") } })], { bad: { steps: ["first"], publish: [], primaryPreview: ref("first") } }));
});

test("exact adapter versions and capabilities are host-resolved", () => {
  const p = plan(); p.steps[0].adapter.version = "^1.0.0"; rejected(p, "PIPELINE_ADAPTER_UNKNOWN");
  const missing = plan(); missing.steps[0].adapter.id = "missing"; rejected(missing, "PIPELINE_ADAPTER_UNKNOWN");
  const cap = plan(); cap.requiredCapabilities = ["unsupported"]; rejected(cap);
  const stepCap = plan(); stepCap.steps[0].requiredCapabilities = ["compile.pdf"]; rejected(stepCap);
  const f = fixture(); const good = plan(); good.requiredCapabilities = ["generate.text"];
  assert.equal(validatePlan(good, { registry: f.registry }).steps[0].adapter.implementationHash, digest);
});

test("adapter registries reject duplicate identities and keep host execution out of the wire manifest", () => {
  const f = fixture();
  assert.throws(() => createRegistry([f.definitions[0], f.definitions[0]]), { code: "PIPELINE_REGISTRY_INVALID" });
  assert.equal(typeof f.registry.resolve("generate", "1.0.0").execute, "function");
  const manifest = f.registry.manifest();
  assert.equal(Object.hasOwn(manifest[0], "execute"), false);
  f.definitions[0].outputs.out.mediaTypes.push("application/pdf");
  assert.deepEqual(f.registry.resolve("generate", "1.0.0").outputs.out.mediaTypes, ["text/plain"]);
});

test("parameter defaults normalize detached values without coercion or dropping unknown fields", () => {
  const schema = { type: "object", properties: {
    clearance: { type: "number", minimum: 0, maximum: 72, default: 4 },
    enabled: { type: "boolean", default: true },
    labels: { type: "array", maxItems: 2, items: { type: "string", maxLength: 4 }, default: [] },
    nested: { type: "object", default: {}, properties: { seed: { type: "integer", default: 7 } } },
  } };
  const supplied = { labels: ["one"] };
  const value = validateParameters(schema, supplied);
  assert.deepEqual(value, { clearance: 4, enabled: true, labels: ["one"], nested: { seed: 7 } });
  assert.deepEqual(supplied, { labels: ["one"] });
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.labels));
  for (const invalid of [{ clearance: "4" }, { clearance: -1 }, { clearance: 73 }, { nested: { seed: 1.5 } }, { enabled: 1 }, { extra: 4 }, { labels: ["longer"] }, { labels: ["a", "b", "c"] }]) {
    assert.throws(() => validateParameters(schema, invalid), { code: "PIPELINE_PARAMETERS_INVALID" });
  }
});

test("schemas and option validation reject executable or unbounded schema features", () => {
  for (const property of [{ $ref: "https://example.invalid/schema" }, { type: "string", pattern: "(a+)+$" }, { type: "string", format: "uri" }, { type: "string", unknown: true }]) {
    assert.throws(() => validateParameters({ type: "object", properties: { input: property } }, {}), { code: "PIPELINE_SCHEMA_INVALID" });
  }
  const f = fixture(); const bad = plan(); bad.steps[0].options = { unknown: true };
  assert.throws(() => validatePlan(bad, { registry: f.registry }), { code: "PIPELINE_OPTIONS_INVALID" });
  const params = plan(); params.parameters = { secret: "sensitive-fixture" };
  assert.throws(() => validatePlan(params, { registry: f.registry }), e => e.code === "PIPELINE_PARAMETERS_INVALID" && !JSON.stringify(e).includes("sensitive-fixture"));
});

test("plans reject non-JSON data, accessors, cycles and prototype-bearing objects without evaluating them", () => {
  let reads = 0;
  const getter = plan(); Object.defineProperty(getter.steps[0].options, "surprise", { enumerable: true, get() { reads++; return 1; } }); rejected(getter);
  assert.equal(reads, 0);
  for (const value of [undefined, Infinity, NaN, 1n, () => {}, new Date(), Object.create({ inherited: true })]) {
    const p = plan(); p.steps[0].options.value = value; rejected(p);
  }
  const cyclic = plan(); cyclic.steps[0].options.self = cyclic; rejected(cyclic);
  const pollution = plan(); pollution.parameters = JSON.parse('{"__proto__":{"polluted":true}}'); rejected(pollution);
  const sparse = plan(); sparse.steps[0].after = new Array(2); rejected(sparse);
});

test("versioned plans reject unknown fields rather than silently dropping author mistakes", () => {
  const version = plan(); version.apiVersion = 2; rejected(version);
  const typo = plan(); typo.steps[0].ouputs = {}; rejected(typo);
  const root = plan(); root.targets.default.other = []; rejected(root);
});

test("policy limits accept the boundary and reject excess work before execution", () => {
  const f = fixture();
  assert.equal(validatePlan(plan(), { registry: f.registry, policy: { maxSteps: 1 } }).steps.length, 1);
  rejected(plan([step("one"), step("two")]), "PIPELINE_PLAN_INVALID", { maxSteps: 1 });
  rejected(plan([step("one")], { a: { steps: ["one"], publish: [] }, b: { steps: ["one"], publish: [] } }), "PIPELINE_PLAN_INVALID", { maxTargets: 1 });
  rejected(plan([step("one"), step("two", "generate", { after: ["one"] }), step("three", "generate", { after: ["one", "two"] })]), "PIPELINE_PLAN_INVALID", { maxEdges: 2 });
  rejected(plan(), "PIPELINE_PLAN_INVALID", { maxPlanBytes: 100 });
  rejected(plan(), "PIPELINE_PLAN_INVALID", { maxValues: 5 });
  rejected(plan(), "PIPELINE_PLAN_INVALID", { maxDepth: 2 });
  const long = plan(); long.pluginId = "a".repeat(65); rejected(long);
  assert.throws(() => validatePlan(plan(), { registry: f.registry, policy: { maxSteps: NaN } }), { code: "PIPELINE_POLICY_INVALID" });
});

test("canonical plan identity includes adapter implementations and normalized values, independent of key order", () => {
  const f = fixture(); const first = plan(); const reordered = { targets: first.targets, steps: first.steps, requiredCapabilities: [], parameters: {}, parameterSchema: emptyOptions, pluginId: "fixture", apiVersion: 1 };
  const a = validatePlan(first, { registry: f.registry }), b = validatePlan(reordered, { registry: f.registry });
  assert.match(a.planHash, /^[a-f0-9]{64}$/); assert.equal(a.planHash, b.planHash);
  first.steps[0].outputs.out.path = "later.txt";
  assert.equal(a.steps[0].outputs.out.path, "result.txt");
  assert.notEqual(a.planHash, validatePlan(first, { registry: f.registry }).planHash);
  const otherRegistry = createRegistry(f.definitions.map(d => ({ ...d, implementationHash: "b".repeat(64) })));
  assert.notEqual(a.planHash, validatePlan(plan(), { registry: otherRegistry }).planHash);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.steps[0].outputs));
  assert.equal(JSON.stringify(a).includes("execute"), false);
});

test("explicit invalid optional values cannot turn into default options or schemas", () => {
  for (const field of ["inputs", "outputs", "options"]) {
    const p = plan([step("check", "validate", { outputs: {}, [field]: null })], { check: { steps: ["check"], publish: [] } });
    rejected(p, field === "options" ? "PIPELINE_OPTIONS_INVALID" : "PIPELINE_PLAN_INVALID");
  }
  const parameters = plan(); parameters.parameters = null; rejected(parameters, "PIPELINE_PARAMETERS_INVALID");
  for (const value of [null, false, 0, ""]) {
    const p = plan(); p.parameterSchema = value; rejected(p, "PIPELINE_SCHEMA_INVALID");
  }
  for (const field of ["properties", "additionalProperties"]) {
    assert.throws(() => validateParameters({ type: "object", [field]: null }, {}), { code: "PIPELINE_SCHEMA_INVALID" });
  }
});

test("publication cannot refer to an inherited property instead of an output port", () => {
  rejected(plan([step("first")], { bad: { steps: ["first"], publish: [ref("first", "toString")] } }));
});

test("author-named ports that match Object methods use the declared wildcard contract", () => {
  const f = fixture();
  const p = plan([
    step("first", "lua", { outputs: { toString: output("one.txt") } }),
    step("second", "lua", { inputs: { valueOf: ref("first", "toString") } }),
  ]);
  assert.deepEqual(resolveTarget(validatePlan(p, { registry: f.registry }), "default").steps.map(s => s.id), ["first", "second"]);
  const invalid = plan(); invalid.steps[0].outputs.toString = output("bad.txt"); rejected(invalid);
});

test("JSON byte limits count UTF-8 and separators exactly", () => {
  const schema = { type: "object", properties: { s: { type: "string" } } };
  assert.deepEqual(validateParameters(schema, { s: "é" }, { policy: { maxPlanBytes: 10 } }), { s: "é" });
  assert.throws(() => validateParameters(schema, { s: "é" }, { policy: { maxPlanBytes: 9 } }), { code: "PIPELINE_PARAMETERS_INVALID" });
  assert.deepEqual(validateParameters(emptyOptions, {}, { policy: { maxPlanBytes: 2 } }), {});
});

test("JSON boundary refuses proxy traps before examining their properties", () => {
  let calls = 0;
  const p = plan(); p.parameters = new Proxy({}, { getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; } });
  rejected(p);
  assert.equal(calls, 0);
});

test("default graph limits preserve the promised capacity and refuse the next step, target, port or edge", () => {
  const f = fixture();
  const manySteps = Array.from({ length: 128 }, (_, i) => step(`s${i}`));
  assert.equal(validatePlan(plan(manySteps), { registry: f.registry }).steps.length, 128);
  rejected(plan([...manySteps, step("extra")]));

  const manyTargets = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`t${i}`, { steps: ["first"], publish: [] }]));
  assert.equal(Object.keys(validatePlan(plan([step("first")], manyTargets), { registry: f.registry }).targets).length, 64);
  rejected(plan([step("first")], { ...manyTargets, extra: { steps: ["first"], publish: [] } }));

  const outputs = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${i}`, output(`file${i}.txt`)]));
  const ports = plan([step("first", "lua", { outputs })], { check: { steps: ["first"], publish: [] } });
  assert.equal(Object.keys(validatePlan(ports, { registry: f.registry }).steps[0].outputs).length, 64);
  outputs.extra = output("extra.txt"); rejected(ports);

  const producers = Array.from({ length: 64 }, (_, i) => step(`p${i}`));
  const consumers = Array.from({ length: 32 }, (_, i) => step(`c${i}`, "generate", { after: producers.map(s => s.id) }));
  const graph = plan([...producers, ...consumers]);
  assert.equal(validatePlan(graph, { registry: f.registry }).steps.length, 96);
  consumers[1].after.push("c0"); rejected(graph);
});

test("parameter boundaries count strings, values, depth and default expansion", () => {
  const open = { type: "object", additionalProperties: true };
  assert.equal(validateParameters(open, { text: "é".repeat(32768) }).text.length, 32768);
  assert.throws(() => validateParameters(open, { text: "é".repeat(32768) + "x" }), { code: "PIPELINE_PARAMETERS_INVALID" });

  const values = { list: Array(49998).fill(null) };
  assert.equal(validateParameters(open, values).list.length, 49998);
  values.list.push(null);
  assert.throws(() => validateParameters(open, values), { code: "PIPELINE_PARAMETERS_INVALID" });

  const nested = {}; let leaf = nested;
  for (let i = 0; i < 32; i++) { leaf.child = {}; leaf = leaf.child; }
  assert.ok(validateParameters(open, nested).child);
  leaf.child = {};
  assert.throws(() => validateParameters(open, nested), { code: "PIPELINE_PARAMETERS_INVALID" });

  const withDefault = { type: "object", properties: { list: { type: "array", items: { type: "boolean" }, default: [true, false] } } };
  assert.throws(() => validateParameters(withDefault, {}, { policy: { maxValues: 3 } }), { code: "PIPELINE_PARAMETERS_INVALID" });
  assert.deepEqual(validateParameters(withDefault, {}, { policy: { maxValues: 4 } }), { list: [true, false] });
});

test("parameter and schema byte ceilings apply independently", () => {
  const open = { type: "object", additionalProperties: true };
  const values = { chunks: Array(16).fill("x".repeat(65536)) };
  const excess = Buffer.byteLength(JSON.stringify(values)) - 1048576;
  values.chunks[15] = values.chunks[15].slice(excess);
  assert.equal(Buffer.byteLength(JSON.stringify(values)), 1048576);
  assert.equal(validateParameters(open, values).chunks.length, 16);
  values.chunks[15] += "x";
  assert.throws(() => validateParameters(open, values), { code: "PIPELINE_PARAMETERS_INVALID" });

  assert.throws(() => validateParameters({ type: "object", title: "x".repeat(65536) }, {}), { code: "PIPELINE_SCHEMA_INVALID" });
  assert.throws(() => validateParameters({ type: "object", properties: Object.fromEntries(Array.from({ length: 1024 }, (_, i) => [`p${i}`, { type: "boolean" }])) }, {}), { code: "PIPELINE_SCHEMA_INVALID" });
});
