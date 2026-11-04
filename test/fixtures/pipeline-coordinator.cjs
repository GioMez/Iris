const { createNativeRuntime } = require("../../src/pipeline/runtime");

(async () => {
  const options = JSON.parse(process.argv[2]);
  const runtime = await createNativeRuntime(options);
  const workspace = await runtime.createWorkspace({ runId: options.runId, stepId: "abandoned", input: options.input });
  if (options.workspaceOnly) { process.send({ ready: true, workspace }); return; }
  await runtime.runTool({ workspace, tool: runtime.resolveTool("node"),
    args: ["-e", "console.log(process.pid);setInterval(()=>{},1000)"],
    onOutput: chunk => { process.send({ ready: true, workspace, pid: Number(chunk.toString().trim()) }); },
  });
  await runtime.close();
})().catch(error => { process.send?.({ error: error.code || "FIXTURE_FAILED" }); process.exitCode = 1; });
