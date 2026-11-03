// Controlled fixtures only. Production callers must use the contained worker.
process.on("message", async request => {
  try {
    const { executeLua } = require("../../src/pipeline/lua-vm");
    const writes = [], logs = [];
    const result = await executeLua({ ...request, host: {
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
  }
});
