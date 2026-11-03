const { createPodmanRuntime } = require("../../src/pipeline/runtime");

(async () => {
  const options = JSON.parse(process.argv[2]);
  const runtime = await createPodmanRuntime(options);
  const workspace = await runtime.createWorkspace({ runId: options.runId, stepId: "abandoned", input: options.input });
  if (options.workspaceOnly) { process.send({ ready: true }); return; }
  await runtime.runContained({ workspace, tool: runtime.resolveTool("node"),
    args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
    onOutput: chunk => { if (chunk.toString().includes("ready")) process.send({ ready: true }); },
  });
  await runtime.close();
})().catch(error => { process.send?.({ error: error.code || "FIXTURE_FAILED" }); process.exitCode = 1; });
