const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { once } = require("node:events");
const { compileFunction } = require("node:vm");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const { deferred } = require("./helpers/server-fixture.cjs");

const serverPath = path.resolve(__dirname, "../src/server.js"), localRequire = createRequire(serverPath);
const limit = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("handler did not drain")), 1500); })]); }
  finally { clearTimeout(timer); }
};

// Real handlers, resolvers, FileHandles, streams and loopback HTTP. Only
// authorization/DB rows and deliberately held/failing I/O are substituted.
async function fixture(t, kind, scenario) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-download-test-"));
  const buildId = randomUUID(), projectId = randomUUID(), artifactId = randomUUID();
  const storage = `output/${buildId}`, filePath = path.join(root, storage, "main.pdf");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.alloc(8 * 1024 * 1024, 97);
  await fs.writeFile(filePath, bytes);
  const entered = deferred(), release = deferred(), settled = deferred(), closed = deferred();
  const handles = [], streams = [], sockets = new Set();
  let request, response, app, server, result;
  t.after(async () => {
    release.resolve(); request?.destroy(); response?.destroy();
    for (const stream of streams) {
      const done = stream.closed ? Promise.resolve() : once(stream, "close").catch(() => {});
      stream.destroy(); await done;
    }
    await Promise.all(handles.map((handle) => handle.close()));
    sockets.forEach((socket) => socket.destroy());
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const wait = async (phase) => { if (scenario === phase) { entered.resolve(); await release.promise; } };
  const builds = localRequire("./builds");
  const resolve = (name) => async (...args) => {
    const file = await builds[name](...args);
    handles.push(file.handle);
    const create = file.handle.createReadStream.bind(file.handle);
    file.handle.createReadStream = (options) => {
      if (scenario === "stream-setup-error") throw new Error("injected stream setup failure");
      const stream = create(options); streams.push(stream);
      if (scenario === "read-error") stream._read = () => stream.destroy(new Error("injected read failure"));
      if (scenario === "response-error") stream.once("data", () => response.destroy(new Error("injected response failure")));
      return stream;
    };
    await wait("during-resolution");
    return file;
  };
  const injectedRequire = (name) => name === "./env" ? { loadDotEnv() {} } : name === "./builds" ? { ...builds, resolveBuildArtifact: resolve("resolveBuildArtifact"), resolveBuildFile: resolve("resolveBuildFile") } : localRequire(name);
  injectedRequire.resolve = localRequire.resolve;
  app = compileFunction(`${await fs.readFile(serverPath, "utf8")}\n
    authorizeProject = async () => { await controls.wait('during-authorization'); return { storageDir: controls.root }; };
    db = { query: async () => { await controls.wait('during-query'); return { rows: [controls.row] }; } };
    return { downloadBuildArtifact, downloadBuildFile };`, ["require", "module", "__dirname", "process", "controls"], { filename: serverPath })(
    injectedRequire,
    { exports: {} }, path.dirname(serverPath), { env: { IRIS_SECRET: "download-tests-only-secret", DB_PASSWORD: "download-tests-only-password", DATA_DIR: root } },
    { root, wait, row: { name: "main.pdf", storage_path: kind === "artifact" ? `${storage}/main.pdf` : storage, build_storage_path: storage, mime_type: "application/pdf", size: bytes.length } });
  server = http.createServer(async (req, res) => {
    response = res; res.once("close", closed.resolve);
    if (scenario === "header-error") res.writeHead = () => { throw new Error("injected header failure"); };
    if (scenario === "before-entry") { entered.resolve(); await release.promise; }
    try {
      const url = new URL("http://localhost/?path=main.pdf");
      if (kind === "artifact") await app.downloadBuildArtifact(req, res, {}, projectId, buildId, artifactId, url);
      else await app.downloadBuildFile(req, res, {}, projectId, buildId, url);
    } catch (error) { result = error; res.destroy(); }
    finally { settled.resolve({ error: result, fds: handles.map((h) => h.fd), streams: streams.map((s) => ({ destroyed: s.destroyed, closed: s.closed })) }); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const delivered = deferred();
  request = http.get(`http://127.0.0.1:${server.address().port}`, (res) => {
    let length = 0;
    res.on("error", () => {});
    res.on("data", (chunk) => { length += chunk.length; if (scenario === "partial-abort") res.destroy(); });
    res.on("close", () => delivered.resolve(length));
  });
  request.on("error", () => delivered.resolve(0));
  return { entered, release, settled, closed, delivered, handles, streams, bytes, abort: () => request.destroy() };
}

for (const kind of ["artifact", "file"]) for (const scenario of ["complete", "partial-abort", "before-entry", "during-authorization", "during-query", "during-resolution", "header-error", "stream-setup-error", "read-error", "response-error"]) {
  test(`${kind} download explicitly closes its source and handle before settling: ${scenario}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t, kind, scenario);
    if (["before-entry", "during-authorization", "during-query", "during-resolution"].includes(scenario)) {
      await limit(f.entered.promise); f.abort(); await limit(f.closed.promise); f.release.resolve();
    }
    const result = await limit(f.settled.promise);
    assert.ok(result.fds.every((fd) => fd === -1), `open descriptors at handler settlement: ${result.fds}`);
    assert.ok(result.streams.every((s) => s.destroyed && s.closed), JSON.stringify(result.streams));
    if (scenario === "complete") assert.equal(await limit(f.delivered.promise), f.bytes.length);
    if (scenario === "partial-abort") {
      const delivered = await limit(f.delivered.promise);
      assert.ok(delivered > 0 && delivered < f.bytes.length);
    }
    if (["before-entry", "during-authorization", "during-query"].includes(scenario)) assert.equal(f.handles.length, 0, "early disconnect must avoid opening storage");
    if (scenario === "during-resolution") { assert.equal(f.handles.length, 1); assert.equal(f.streams.length, 0); }
    if (["header-error", "stream-setup-error", "read-error"].includes(scenario)) assert.match(result.error?.message || "", /injected/);
  });
}
