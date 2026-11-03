const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { uuidv7 } = require("../src/ids");
const { ConcurrencyGate } = require("../src/throttle");
const { validatePlan } = require("../src/pipeline/contracts");
const { createRegistry } = require("../src/pipeline/registry");
const { createRunWorkspace, materializeInputs, materializeOverlay, validateOutputs, disposeRunWorkspace } = require("../src/pipeline/workspaces");
const { executePlan } = require("../src/pipeline/executor");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ref = (step, port = "files") => ({ step, port });
const collection = { kind: "collection", mediaType: "text/plain", path: "generated" };
const step = (id, extra = {}) => ({ id, adapter: { id: "transform", version: "1.0.0" }, ...extra });
function registry(execute, implementationHash = "a".repeat(64)) {
  return createRegistry([{ id: "transform", version: "1.0.0", implementationHash,
    optionsSchema: { type: "object" }, inputs: {}, outputs: {}, capabilities: [],
    additionalInputs: { kinds: ["file", "collection"], mediaTypes: ["*/*"] },
    additionalOutputs: { kinds: ["file", "collection"], mediaTypes: ["*/*"] }, execute }]);
}
function plan(registry, steps, publish = [], terminal = steps.at(-1).id) {
  return validatePlan({ apiVersion: 1, pluginId: "fixture", steps,
    targets: { main: { steps: [terminal], publish } } }, { registry });
}
async function fixture(t, files = { "main.tex": Buffer.from("main\r\n"), "image.bin": Buffer.from([0, 255, 13, 10]) }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-pipeline-work-")), source = path.join(root, "source");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(source);
  const entries = [];
  for (const [relative, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
    await fs.writeFile(path.join(source, relative), bytes);
    entries.push({ id: uuidv7(), path: relative });
  }
  await fs.mkdir(path.join(source, "empty"));
  const snapshot = { root: source, files: entries, directories: ["empty"], settings: { projectType: "latex" } };
  const policy = { root: path.join(root, "runs") };
  return { root, source, snapshot, policy, workspace: await createRunWorkspace(snapshot, policy) };
}
async function writeOutput(context, relative, text) {
  const file = path.join(context.outputDir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

test("a failed adapter outcome keeps diagnostics and blocks dependents even without declared outputs", async t => {
  const f = await fixture(t), diagnostics = [{ severity: "error", message: "Missing include", file: "main.tex", line: 2 }];
  const adapters = registry(async () => ({ errorCode: "PIPELINE_COMPILE_FAILED", diagnostics }));
  const selected = plan(adapters, [step("compile"), step("later", { after: ["compile"] })]);
  const result = await executePlan({ plan: selected, target: "main", workspace: f.workspace, registry: adapters,
    gate: new ConcurrencyGate({ limit: 1, queueLimit: 1 }) });
  assert.equal(result.state, "failed");
  assert.deepEqual(result.steps.map(s => s.state), ["failed", "blocked"]);
  assert.equal(result.steps[0].errorCode, "PIPELINE_COMPILE_FAILED");
  assert.deepEqual(result.steps[0].diagnostics, diagnostics);
});

test("snapshot bytes and identity include binary files, empty folders and settings without reading old outputs", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, "output"));
  await fs.writeFile(path.join(f.source, "output", "old.pdf"), "old");
  const same = await createRunWorkspace(f.snapshot, f.policy);
  assert.equal(same.snapshotHash, f.workspace.snapshotHash);
  await fs.writeFile(path.join(f.source, "main.tex"), "changed");
  assert.equal(await fs.readFile(path.join(f.workspace.snapshot.root, "main.tex"), "utf8"), "main\r\n");
  assert.deepEqual(await fs.readFile(path.join(f.workspace.snapshot.root, "image.bin")), Buffer.from([0, 255, 13, 10]));
  assert.ok((await fs.stat(path.join(f.workspace.snapshot.root, "empty"))).isDirectory());
  await assert.rejects(fs.stat(path.join(f.workspace.snapshot.root, "output")), { code: "ENOENT" });
  const changed = await createRunWorkspace(f.snapshot, f.policy);
  assert.notEqual(changed.snapshotHash, f.workspace.snapshotHash);
  const settings = await createRunWorkspace({ ...f.snapshot, settings: { projectType: "lilypond" } }, f.policy);
  assert.notEqual(settings.snapshotHash, changed.snapshotHash);
  assert.equal(f.workspace.snapshot.files.find(file => file.path === "main.tex").contentHash, hash("main\r\n"));
  await disposeRunWorkspace(f.workspace);
  await assert.rejects(fs.stat(f.workspace.root), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(f.source, "main.tex"), "utf8"), "changed");
});

test("snapshot copying preserves source files above the history text limit", async t => {
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 97), f = await fixture(t, { "large.tex": bytes });
  const file = f.workspace.snapshot.files[0];
  assert.equal(file.size, bytes.length);
  assert.equal(file.contentHash, hash(bytes));
});

test("snapshot identity distinguishes source revisions and preserves mapping eligibility through overlays", async t => {
  const f = await fixture(t), revision = uuidv7();
  const files = f.snapshot.files.map(file => ({ ...file, sourceRevisionId: file.path === "main.tex" ? revision : null,
    binary: file.path === "image.bin", kind: file.path === "main.tex" ? "tex" : "file" }));
  const snapshot = await createRunWorkspace({ ...f.snapshot, files }, f.policy);
  const main = snapshot.snapshot.files.find(file => file.path === "main.tex");
  assert.equal(main.sourceRevisionId, revision);
  const again = await createRunWorkspace({ ...f.snapshot, files: [...files].reverse() }, f.policy);
  assert.equal(again.snapshotHash, snapshot.snapshotHash);
  const revised = await createRunWorkspace({ ...f.snapshot, files: files.map(file => ({ ...file, sourceRevisionId: uuidv7() })) }, f.policy);
  assert.notEqual(revised.snapshotHash, snapshot.snapshotHash);
  const binary = await createRunWorkspace({ ...f.snapshot, files: files.map(file => ({ ...file, binary: true })) }, f.policy);
  assert.notEqual(binary.snapshotHash, snapshot.snapshotHash);
  const context = await materializeInputs(snapshot, step("read", { inputs: { source: { snapshot: true } } }), new Map());
  const overlay = await materializeOverlay(context, ["source"]);
  assert.deepEqual(overlay.files, snapshot.snapshot.files);
  assert.equal(overlay.files.find(file => file.path === "image.bin").binary, true);
  assert.equal(main.kind, "tex");
  assert.equal(main.contentHash, hash("main\r\n"));
});

test("malformed or duplicate source identities fail before snapshot admission", async t => {
  const f = await fixture(t);
  for (const changed of [{ id: "not-a-file-id" }, { sourceRevisionId: "not-a-revision" }, { binary: "false" }, { kind: {} }]) {
    await assert.rejects(createRunWorkspace({ ...f.snapshot, files: [{ ...f.snapshot.files[0], ...changed }] }, f.policy), { code: "PIPELINE_SNAPSHOT_INVALID" });
  }
  await assert.rejects(createRunWorkspace({ ...f.snapshot, files: f.snapshot.files.map(file => ({ ...file, id: f.snapshot.files[0].id })) }, f.policy), { code: "PIPELINE_SNAPSHOT_INVALID" });
  assert.deepEqual(await fs.readdir(f.policy.root), [path.basename(f.workspace.root)]);
});

test("physical artifact identities survive downstream copies while new producer outputs get fresh identities", async t => {
  const f = await fixture(t), produced = [];
  for (const id of ["first", "second"]) {
    const spec = step(id, { outputs: { files: collection, single: { kind: "file", mediaType: "text/plain", path: "single.txt" } } });
    const context = await materializeInputs(f.workspace, spec, new Map());
    for (const relative of ["generated/a.txt", "generated/nested/b.txt", "single.txt"]) await writeOutput(context, relative, "same bytes");
    const artifacts = await validateOutputs(f.workspace, spec);
    assert.strictEqual(await validateOutputs(f.workspace, spec), artifacts);
    const members = artifacts.flatMap(artifact => artifact.files);
    for (const member of members) {
      assert.match(member.id, /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.equal(member.producerStep, id);
      assert.equal(member.outputPort, member.path === "single.txt" ? "single" : "files");
    }
    assert.equal(artifacts[1].id, artifacts[1].files[0].id);
    assert.equal(artifacts[1].contentHash, hash("same bytes"));
    assert.equal(artifacts[1].size, 10);
    produced.push(...members);
    for (const consumer of ["left", "right"]) {
      const inputs = await materializeInputs(f.workspace, step(`${id}-${consumer}`, { inputs: { generated: ref(id), single: ref(id, "single") } }),
        new Map([[`${id}:files`, artifacts[0]], [`${id}:single`, artifacts[1]]]));
      const overlay = await materializeOverlay(inputs, ["generated", "single"]);
      assert.deepEqual(overlay.files, members);
    }
  }
  assert.equal(new Set(produced.map(file => file.id)).size, 6);
});

test("snapshot refuses symlink files and ancestors rather than importing outside bytes", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "private"), "not an input");
  await fs.symlink(path.join(f.root, "private"), path.join(f.source, "link.txt"));
  await fs.symlink(f.root, path.join(f.source, "linked"));
  for (const relative of ["link.txt", "linked/private", "../private"]) {
    await assert.rejects(createRunWorkspace({ ...f.snapshot, files: [{ id: uuidv7(), path: relative }] }, f.policy), { code: "PIPELINE_PATH_INVALID" });
  }
  assert.deepEqual(await fs.readdir(f.policy.root), [path.basename(f.workspace.root)], "failed snapshots clean only their owned workspace");
});

test("collections retain nested member paths and inputs cannot alias producer bytes", async t => {
  const f = await fixture(t), producer = step("generate", { outputs: { files: collection } });
  const output = await materializeInputs(f.workspace, producer, new Map());
  await writeOutput(output, "generated/one.txt", "one");
  await writeOutput(output, "generated/nested/two.txt", "two");
  const products = await validateOutputs(f.workspace, producer);
  assert.deepEqual(products[0].files.map(file => file.path), ["generated/nested/two.txt", "generated/one.txt"]);
  const consumer = step("read", { inputs: { generated: ref("generate") } });
  const inputs = await materializeInputs(f.workspace, consumer, new Map([["generate:files", products[0]]]));
  const copied = path.join(inputs.inputs.generated.root, "generated/one.txt");
  await fs.chmod(copied, 0o600); await fs.writeFile(copied, "edited consumer copy");
  assert.equal(await fs.readFile(path.join(products[0].root, "generated/one.txt"), "utf8"), "one");
  assert.equal(products[0].files.find(file => file.path === "generated/one.txt").contentHash, hash("one"));
});

test("undeclared outputs, symlinks and exceeded output budgets produce no usable artifact manifests", async t => {
  const f = await fixture(t);
  for (const mode of ["undeclared", "symlink", "bytes", "entries", "missing"]) {
    const spec = step(mode, { outputs: { files: { kind: "file", mediaType: "text/plain", path: "result.txt" } } });
    const workspace = await createRunWorkspace(f.snapshot, { ...f.policy, maxArtifactBytes: 8, maxOutputBytes: 8, maxOutputEntries: 1 });
    const context = await materializeInputs(workspace, spec, new Map());
    if (mode === "symlink") await fs.symlink(path.join(f.source, "main.tex"), path.join(context.outputDir, "result.txt"));
    else if (mode !== "missing") await writeOutput(context, mode === "undeclared" ? "other.txt" : "result.txt", mode === "bytes" ? "123456789" : "result");
    if (mode === "entries") await writeOutput(context, "extra.txt", "extra");
    await assert.rejects(validateOutputs(workspace, spec), error => error.code?.startsWith("PIPELINE_"), mode);
  }
});

test("static target traversal executes a diamond prerequisite once and ignores unrelated branches", async t => {
  const f = await fixture(t), calls = [], events = [];
  const adapters = registry(async context => {
    calls.push(context.step.id);
    if (context.step.outputs.files) await writeOutput(context, "generated/result.txt", context.step.id);
    return { diagnostics: [] };
  });
  const p = plan(adapters, [
    step("source", { inputs: { project: { snapshot: true } }, outputs: { files: collection } }),
    step("left", { inputs: { data: ref("source") } }),
    step("right", { after: ["source"] }),
    step("unrelated"), step("finish", { after: ["left", "right"], outputs: { files: collection } }),
  ], [ref("finish")]);
  const result = await executePlan({ plan: p, target: "main", workspace: f.workspace, registry: adapters,
    gate: new ConcurrencyGate({ limit: 1 }), emit: async event => events.push(event) });
  assert.deepEqual(calls, ["source", "left", "right", "finish"]);
  assert.equal(result.state, "succeeded");
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].producerStep, "finish");
  assert.deepEqual(events.filter(event => event.state === "succeeded").map(event => event.stepId), calls);
});

test("step failure blocks descendants and leaves independent required work eligible", async t => {
  const f = await fixture(t), calls = [];
  const adapters = registry(async context => {
    calls.push(context.step.id);
    if (context.step.id === "broken") throw Object.assign(new Error("fixture failure"), { code: "FIXTURE_FAILURE" });
    return { diagnostics: [] };
  });
  const p = plan(adapters, [step("broken"), step("independent"), step("child", { after: ["broken"] }),
    step("finish", { after: ["independent", "child"] })]);
  const result = await executePlan({ plan: p, target: "main", workspace: f.workspace, registry: adapters, gate: new ConcurrencyGate({ limit: 1 }), emit: async () => {} });
  assert.deepEqual(calls, ["broken", "independent"]);
  assert.equal(result.state, "failed");
  assert.deepEqual(result.steps.map(s => [s.id, s.state]), [["broken", "failed"], ["independent", "succeeded"], ["child", "blocked"], ["finish", "blocked"]]);
  assert.deepEqual(result.artifacts, []);
});

test("validation-only targets succeed and forged or mismatched plans start no adapter work", async t => {
  const f = await fixture(t); let calls = 0;
  const adapters = registry(async () => { calls++; return { diagnostics: [] }; });
  const p = plan(adapters, [step("check")]);
  const args = { plan: p, target: "main", workspace: f.workspace, registry: adapters, gate: new ConcurrencyGate({ limit: 1 }), emit: async () => {} };
  await assert.rejects(executePlan({ ...args, plan: structuredClone(p) }), { code: "PIPELINE_PLAN_INVALID" });
  await assert.rejects(executePlan({ ...args, registry: registry(async () => { calls++; }, "b".repeat(64)) }), { code: "PIPELINE_ADAPTER_CHANGED" });
  assert.equal(calls, 0);
  const result = await executePlan(args);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.artifacts, []);
  assert.equal(calls, 1);
});

test("concurrent graphs share the existing gate and queued cancellation starts no work", async t => {
  const f = await fixture(t), second = await createRunWorkspace(f.snapshot, f.policy), gate = new ConcurrencyGate({ limit: 1, queueLimit: 1 });
  let release, started;
  const held = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  let calls = 0;
  const adapters = registry(async () => { calls++; started(); await held; return { diagnostics: [] }; });
  const p = plan(adapters, [step("check")]), args = { plan: p, target: "main", registry: adapters, gate, emit: async () => {} };
  const first = executePlan({ ...args, workspace: f.workspace });
  await entered;
  const controller = new AbortController();
  const next = executePlan({ ...args, workspace: second, signal: controller.signal });
  controller.abort();
  try {
    assert.equal((await next).state, "cancelled");
    assert.equal(calls, 1);
    assert.equal(gate.active, 1);
  } finally { release(); await first; }
  assert.equal(gate.active, 0);
});

test("active cancellation waits for adapter drain and never starts or publishes descendants", async t => {
  const f = await fixture(t), gate = new ConcurrencyGate({ limit: 1 }), controller = new AbortController();
  let entered, drain, aborted;
  const started = new Promise(resolve => { entered = resolve; });
  const stopped = new Promise(resolve => { aborted = resolve; });
  const drained = new Promise(resolve => { drain = resolve; });
  t.after(() => drain());
  const calls = [];
  const adapters = registry(async context => {
    calls.push(context.step.id);
    await writeOutput(context, "generated/result.txt", "partial");
    const abort = new Promise(resolve => context.signal.addEventListener("abort", resolve, { once: true }));
    entered(); await abort; aborted(); await drained;
    return { diagnostics: [] };
  });
  const p = plan(adapters, [step("first", { outputs: { files: collection } }), step("second", { inputs: { data: ref("first") } })], [ref("first")]);
  let finished = false;
  const executing = executePlan({ plan: p, target: "main", workspace: f.workspace, registry: adapters, gate,
    signal: controller.signal, emit: async () => {} }).then(result => { finished = true; return result; });
  await started; controller.abort(); await stopped;
  assert.equal(finished, false);
  assert.equal(gate.active, 1);
  drain();
  const result = await executing;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(calls, ["first"]);
  assert.equal(gate.active, 0);
});

test("workspace boundaries reject hardlinks and special files without opening a FIFO", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await fs.link(path.join(f.source, "main.tex"), path.join(f.source, "hardlink.tex"));
  await promisify(execFile)("mkfifo", [path.join(f.source, "pipe")]);
  for (const relative of ["hardlink.tex", "pipe"]) {
    await assert.rejects(createRunWorkspace({ ...f.snapshot, files: [{ id: uuidv7(), path: relative }] }, f.policy), { code: "PIPELINE_PATH_INVALID" });
  }
  for (const kind of ["hardlink", "pipe"]) {
    const spec = step(kind, { outputs: { files: { kind: "file", mediaType: "text/plain", path: "result.txt" } } });
    const context = await materializeInputs(f.workspace, spec, new Map());
    if (kind === "hardlink") await fs.link(path.join(f.source, "main.tex"), path.join(context.outputDir, "result.txt"));
    else await promisify(execFile)("mkfifo", [path.join(context.outputDir, "result.txt")]);
    await assert.rejects(validateOutputs(f.workspace, spec), { code: "PIPELINE_PATH_INVALID" });
  }
});

test("workspace disposal refuses a forged root and never removes a source directory", async t => {
  const f = await fixture(t);
  await assert.rejects(disposeRunWorkspace({ ...f.workspace, root: f.source }), { code: "PIPELINE_WORKSPACE_INVALID" });
  assert.equal(await fs.readFile(path.join(f.source, "main.tex"), "utf8"), "main\r\n");
  await disposeRunWorkspace(f.workspace);
  await disposeRunWorkspace(f.workspace);
  await assert.rejects(materializeInputs(f.workspace, step("late"), new Map()), { code: "PIPELINE_WORKSPACE_INVALID" });
});

test("input materialization detects tampered producer bytes and forged provenance", async t => {
  const f = await fixture(t), producer = step("generate", { outputs: { files: collection } });
  const context = await materializeInputs(f.workspace, producer, new Map());
  await writeOutput(context, "generated/one.txt", "one");
  const [artifact] = await validateOutputs(f.workspace, producer);
  const consumer = step("read", { inputs: { generated: ref("generate") } });
  await assert.rejects(materializeInputs(f.workspace, consumer, new Map([["generate:files", { ...artifact, root: f.source }]])), { code: "PIPELINE_INPUT_INVALID" });
  await assert.rejects(materializeInputs(f.workspace, step("wrong-producer", { inputs: { data: ref("other") } }), new Map([["other:files", artifact]])), { code: "PIPELINE_INPUT_INVALID" });
  await fs.chmod(path.join(artifact.root, "generated/one.txt"), 0o600);
  await fs.writeFile(path.join(artifact.root, "generated/one.txt"), "bad");
  await assert.rejects(materializeInputs(f.workspace, { ...consumer, id: "changed" }, new Map([["generate:files", artifact]])), { code: "PIPELINE_INPUT_CHANGED" });
});

test("workspace copying respects the validated plan's raised option budget", async t => {
  const f = await fixture(t), text = "x".repeat(65537), policy = { maxStringBytes: 131072 };
  let observed;
  const adapters = createRegistry([{ id: "large", version: "1.0.0", implementationHash: "a".repeat(64),
    optionsSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: async context => { observed = context.options.text.length; return { diagnostics: [] }; } }], { policy });
  const p = validatePlan({ apiVersion: 1, pluginId: "fixture", steps: [{ id: "large", adapter: { id: "large", version: "1.0.0" }, options: { text } }],
    targets: { main: { steps: ["large"], publish: [] } } }, { registry: adapters, policy });
  const result = await executePlan({ plan: p, target: "main", workspace: f.workspace, registry: adapters, gate: new ConcurrencyGate({ limit: 1 }) });
  assert.equal(result.state, "succeeded");
  assert.equal(observed, 65537);
});

test("output budgets include directories and all successful steps without double-counting validation", async t => {
  const f = await fixture(t), workspace = await createRunWorkspace(f.snapshot, { ...f.policy, maxArtifactBytes: 4, maxOutputBytes: 8, maxOutputEntries: 4 });
  for (const id of ["one", "two"]) {
    const spec = step(id, { outputs: { files: collection } });
    const context = await materializeInputs(workspace, spec, new Map());
    await writeOutput(context, "generated/result.txt", "1234");
    assert.equal((await validateOutputs(workspace, spec))[0].files[0].size, 4);
    assert.equal((await validateOutputs(workspace, spec))[0].files[0].size, 4);
  }
  const spec = step("over", { outputs: { files: collection } });
  const context = await materializeInputs(workspace, spec, new Map());
  await writeOutput(context, "generated/result.txt", "1");
  await assert.rejects(validateOutputs(workspace, spec), { code: "PIPELINE_OUTPUT_LIMIT" });
});

test("compiler overlays preserve source and generated paths while rejecting file and directory collisions", async t => {
  const f = await fixture(t, { "main.tex": "main", "score.ly": "music", "parts/one.tex": "one" });
  const producer = step("generate", { outputs: { files: collection } });
  const output = await materializeInputs(f.workspace, producer, new Map());
  await writeOutput(output, "generated/part.tex", "generated");
  const [artifact] = await validateOutputs(f.workspace, producer);
  const inputs = await materializeInputs(f.workspace, step("compile", { inputs: { source: { snapshot: true }, generated: ref("generate") } }), new Map([["generate:files", artifact]]));
  const overlay = await materializeOverlay(inputs, ["source", "generated"]);
  assert.equal(await fs.readFile(path.join(overlay.root, "parts/one.tex"), "utf8"), "one");
  assert.equal(await fs.readFile(path.join(overlay.root, "generated/part.tex"), "utf8"), "generated");
  for (const relative of ["main.tex", "parts", "main.tex/child"]) {
    const id = `collision-${relative.replaceAll("/", "-")}`;
    const spec = step(id, { outputs: { file: { kind: "file", mediaType: "text/plain", path: relative } } });
    const context = await materializeInputs(f.workspace, spec, new Map());
    await writeOutput(context, relative, "collision");
    const [product] = await validateOutputs(f.workspace, spec);
    const read = await materializeInputs(f.workspace, step(`read-${id}`, { inputs: { source: { snapshot: true }, generated: ref(id, "file") } }), new Map([[`${id}:file`, product]]));
    await assert.rejects(materializeOverlay(read, ["source", "generated"]), { code: "PIPELINE_INPUT_COLLISION" });
    assert.equal(await fs.readFile(path.join(f.workspace.snapshot.root, "main.tex"), "utf8"), "main");
  }
});

test("registered adapters can prepare an overlay from their executor context", async t => {
  const f = await fixture(t);
  const adapters = registry(async context => {
    const overlay = await materializeOverlay(context, ["source"], { signal: context.signal });
    assert.equal(await fs.readFile(path.join(overlay.root, "main.tex"), "utf8"), "main\r\n");
    return { diagnostics: [] };
  });
  const p = plan(adapters, [step("compile", { inputs: { source: { snapshot: true } } })]);
  const result = await executePlan({ plan: p, target: "main", workspace: f.workspace, registry: adapters, gate: new ConcurrencyGate({ limit: 1 }) });
  assert.equal(result.state, "succeeded");
});

test("materialization cancellation stops before copying and produces no runnable step", async t => {
  const f = await fixture(t);
  await assert.rejects(materializeInputs(f.workspace, step("cancelled", { inputs: { source: { snapshot: true } } }), new Map(), { signal: AbortSignal.abort() }), { name: "AbortError" });
  await assert.rejects(fs.stat(path.join(f.workspace.root, "steps", "cancelled")), { code: "ENOENT" });
});

test("adapter rejections with no Error value still fail their branch and release admission", async t => {
  const f = await fixture(t), gate = new ConcurrencyGate({ limit: 1 }), calls = [];
  const adapters = registry(async context => { calls.push(context.step.id); if (context.step.id === "bad") throw null; return { diagnostics: [] }; });
  const p = plan(adapters, [step("bad"), step("good"), step("end", { after: ["bad", "good"] })]);
  const result = await executePlan({ plan: p, target: "main", workspace: f.workspace, registry: adapters, gate });
  assert.equal(result.state, "failed");
  assert.deepEqual(calls, ["bad", "good"]);
  assert.equal(gate.active, 0);
});

test("a failed durable state callback stops scheduling and releases its active slot", async t => {
  const f = await fixture(t), gate = new ConcurrencyGate({ limit: 1 }), calls = [];
  const adapters = registry(async context => { calls.push(context.step.id); return { diagnostics: [] }; });
  const p = plan(adapters, [step("first"), step("later", { after: ["first"] })]);
  await assert.rejects(executePlan({ plan: p, target: "main", workspace: f.workspace, registry: adapters, gate,
    emit: async event => { if (event.state === "succeeded") throw new Error("state commit unavailable"); } }), /state commit unavailable/);
  assert.deepEqual(calls, ["first"]);
  assert.equal(gate.active, 0);
});
