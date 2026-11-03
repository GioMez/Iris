// Controlled fixtures only. Production callers use the checked worker.
process.on("message", async request => {
  const controller = new AbortController();
  const timer = request.abortAfterMs === undefined ? null : setTimeout(() => controller.abort(), request.abortAfterMs);
  try {
    const { executeLua } = require("../../src/pipeline/lua-vm");
    const writes = [], logs = [];
    const result = await executeLua({ ...request, signal: controller.signal, host: {
      read: (name, file) => {
        if (name !== "input" || file !== "bytes.bin") throw Object.assign(new Error("denied"), { code: "PIPELINE_INPUT_INVALID" });
        return Buffer.from(request.bytes || "", "base64");
      },
      write: (port, file, bytes) => { writes.push({ port, file, bytes: bytes.toString("base64") }); },
      list: () => request.listFiles || [{ path: "bytes.bin", size: Buffer.from(request.bytes || "", "base64").length, metadata: { list: [], nullable: null } }],
      diagnostic: value => { logs.push(value); },
      log: (level, message) => { logs.push({ level, message }); },
    } });
    process.send({ result, writes, logs }, () => process.disconnect());
  } catch (error) {
    process.send({ error: { code: error.code, message: error.message } }, () => process.disconnect());
  } finally { clearTimeout(timer); }
});
