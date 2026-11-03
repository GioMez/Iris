const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { uuidv7 } = require("../src/ids");
const { createPodmanRuntime } = require("../src/pipeline/runtime");

const contained = { skip: !process.env.IRIS_TEST_PIPELINE_IMAGE, timeout: 45000 };
async function fixture(t, timeoutMs = 5000, input) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-lua-worker-")), state = path.join(root, "state");
  const runtime = await createPodmanRuntime({ root: state, coordinatorId: uuidv7(),
    transport: { connection: process.env.IRIS_TEST_PODMAN_CONNECTION, home: process.env.IRIS_TEST_PODMAN_HOME },
    policy: { image: process.env.IRIS_TEST_PIPELINE_IMAGE, memoryBytes: 268435456, totalMemoryBytes: 293601280,
      outputBytes: 8388608, tempBytes: 8388608, outputEntries: 128, tempEntries: 64 },
    tools: [{ id: "lua-vm-probe", path: "/usr/local/bin/node", timeoutMs }, { id: "lua-io-probe", path: "/bin/sh", timeoutMs }],
  });
  t.after(async () => {
    await runtime.close();
    const { installationId } = JSON.parse(await fs.readFile(path.join(state, "installation.json")));
    for (const args of [["ps", "--all"], ["volume", "ls"]]) {
      const prefix = process.env.IRIS_TEST_PODMAN_CONNECTION ? ["--connection", process.env.IRIS_TEST_PODMAN_CONNECTION] : [];
      const result = await promisify(execFile)("podman", [...prefix, ...args, "--filter", `label=iris.installation=${installationId}`, "--format", "{{.Name}}"],
        { env: { PATH: process.env.PATH, HOME: process.env.IRIS_TEST_PODMAN_HOME }, timeout: 10000 });
      assert.equal(result.stdout.trim(), "");
    }
    await fs.rm(root, { recursive: true });
  });
  const workspace = await runtime.createWorkspace({ runId: uuidv7(), stepId: "lua", input });
  return { runtime, workspace, run: (request, options = {}) => runtime.runContained({ workspace, tool: runtime.resolveTool("lua-vm-probe"),
    args: ["-e", `require('/opt/iris/src/pipeline/lua-vm').executeLua(${JSON.stringify(request)})
      .then(value=>console.log(JSON.stringify({value})),error=>{console.log(JSON.stringify({error:error.code}));process.exitCode=1})`],
    captureStreams: true, outputLimitBytes: 1048576, ...options }),
  };
}

test("the image-local Lua VM loads approved modules without host globals", contained, async t => {
  const f = await fixture(t);
  const result = await f.run({ mode: "plan", script: "iris.lua", modules: {
    "iris.lua": `assert(os==nil and io==nil and js==nil and package==nil)
      local v=require("local.value"); return {plan=function() return {answer=v,empty=iris.array{}} end}`,
    "local/value.lua": "return 42",
  } });
  assert.equal(result.code, 0, result.log);
  assert.equal(result.drained, true);
  assert.deepEqual(JSON.parse(result.stdout), { value: { answer: 42, empty: [] } });
});

test("the contained Lua file protocol transfers binary outputs and logical diagnostics", contained, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-lua-transfer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex"), bytes = Buffer.alloc(1048576);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const script = `return {generate=function(ctx)
    ctx.write('output','generated/bytes.bin',ctx.read('source','bytes.bin'))
    ctx.log('info','binary output')
    ctx.diagnostic({severity='warning',message='input note',input='source',file='bytes.bin',line=1})
  end}`;
  const request = { version: 1, mode: "transform", script: "iris.lua", entrypoint: "generate", context: { options: {} },
    modules: [{ path: "iris.lua", size: Buffer.byteLength(script), contentHash: hash(script) }],
    inputs: { source: { kind: "collection", mediaType: "application/octet-stream", files: [{ path: "bytes.bin", size: bytes.length, contentHash: hash(bytes) }] } },
    outputs: { output: { kind: "file", path: "generated/bytes.bin", mediaType: "application/octet-stream" } } };
  const files = [], directories = ["modules", "inputs", "inputs/source"];
  for (const directory of directories) await fs.mkdir(path.join(root, directory), { recursive: true });
  for (const [relative, value] of [["request.json", JSON.stringify(request)], ["modules/iris.lua", script], ["inputs/source/bytes.bin", bytes]]) {
    await fs.writeFile(path.join(root, relative), value);
    files.push({ path: relative, size: Buffer.byteLength(value), contentHash: hash(value) });
  }
  const f = await fixture(t, 5000, { root, files, directories });
  const result = await f.runtime.runContained({ workspace: f.workspace, tool: f.runtime.resolveTool("lua-vm-probe"),
    args: ["/opt/iris/src/pipeline/lua-worker.js"] });
  assert.equal(result.code, 0, result.log);
  assert.equal(result.drained, true);
  assert.deepEqual(result.log.trim().split("\n").map(line => JSON.parse(line)), [
    { level: "info", message: "binary output" },
    { diagnostic: { severity: "warning", message: "input note", input: "source", file: "bytes.bin", line: 1 } },
  ]);
  const response = await f.runtime.exportWorkspace({ workspace: f.workspace, directory: "response", destination: path.join(root, "reply") });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(response.root, "response/result.json"), "utf8")), {
    version: 1, value: null, diagnostics: [{ severity: "warning", message: "input note", input: "source", file: "bytes.bin", line: 1 }], logsTruncated: false,
  });
  const output = await f.runtime.exportWorkspace({ workspace: f.workspace, directory: "output", destination: path.join(root, "exported") });
  assert.deepEqual(await fs.readFile(path.join(output.root, "output/generated/bytes.bin")), bytes);
});

test("contained workspaces exclude image-owned scratch files", contained, async t => {
  const f = await fixture(t);
  const result = await f.runtime.runContained({ workspace: f.workspace, tool: f.runtime.resolveTool("lua-vm-probe"),
    args: ["-e", "const fs=require('node:fs');console.log(JSON.stringify(['/work','/tmp'].map(p=>fs.readdirSync(p))))"],
  });
  assert.equal(result.code, 0, result.log);
  assert.deepEqual(JSON.parse(result.log), [[], []]);
});

test("contained Lua loops time out and release their worker reservation", contained, async t => {
  const f = await fixture(t, 1000);
  const result = await f.run({ mode: "plan", script: "iris.lua", modules: { "iris.lua": "while true do end" } });
  assert.equal(result.timedOut, true, result.log);
  assert.equal(result.drained, true);
});

test("Lua planner output limits return explicit failures", contained, async t => {
  const f = await fixture(t);
  for (const [source, extra, expected] of [
    ["string.rep('x',1048576)", {}, "PIPELINE_LUA_VALUE_INVALID"],
  ]) {
    const result = await f.run({ mode: "plan", script: "iris.lua", modules: { "iris.lua": `return {plan=function() return ${source} end}` }, ...extra });
    assert.equal(result.code, 1, result.log);
    assert.equal(result.drained, true);
    assert.deepEqual(JSON.parse(result.stdout), { error: expected });
  }
});

test("cancellation drains an executing Lua loop before runtime disposal", contained, async t => {
  const f = await fixture(t, 15000), controller = new AbortController();
  // A trusted probe callback marks entry; the project receives only that callback.
  const tool = f.runtime.resolveTool("lua-vm-probe");
  const result = await f.runtime.runContained({ workspace: f.workspace, tool, signal: controller.signal,
    args: ["-e", `require('/opt/iris/src/pipeline/lua-vm').executeLua({mode:'transform',script:'iris.lua',entrypoint:'loop',
      modules:{'iris.lua':'return {loop=function(ctx) ctx.log("info","started"); while true do end end}'},
      host:{log:()=>console.log('entered')}}).catch(()=>{process.exitCode=1})`],
    onOutput: chunk => { if (chunk.includes("entered")) controller.abort(); },
  });
  assert.equal(controller.signal.aborted, true, result.log);
  assert.equal(result.cancelled, true);
  assert.equal(result.drained, true);
});

test("cancellation drains Lua while its host callback is blocked in filesystem I/O", contained, async t => {
  const f = await fixture(t, 15000), controller = new AbortController();
  const source = `const fs=require('node:fs');
      require('/opt/iris/src/pipeline/lua-vm').executeLua({mode:'transform',script:'iris.lua',entrypoint:'read',
        modules:{'iris.lua':'return {read=function(ctx) ctx.read("input","blocked") end}'},
        host:{read:()=>{fs.writeSync(1,'reading\\n');return fs.readFileSync(0)}}}).catch(()=>{process.exitCode=1})`;
  // An anonymous shell pipe supplies a blocking read without requiring a named
  // special file in the worker volume. Cancellation must drain both processes.
  const result = await f.runtime.runContained({ workspace: f.workspace, tool: f.runtime.resolveTool("lua-io-probe"), signal: controller.signal,
    args: ["-c", `sleep 60 | /usr/local/bin/node -e '${source.replaceAll("'", "'\\''")}'`],
    onOutput: chunk => { if (chunk.includes("reading")) controller.abort(); },
  });
  assert.equal(controller.signal.aborted, true, result.log);
  assert.equal(result.cancelled, true);
  assert.equal(result.drained, true);
});
