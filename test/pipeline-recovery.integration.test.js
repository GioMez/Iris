const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { connectionString, isolatedSchema } = require("./helpers/isolated-schema.cjs");
const { workspace, launch, freePort, until } = require("../scripts/lib/disposable.cjs");

const options = { skip: !connectionString || process.env.IRIS_TEST_LUA !== "1", timeout: 30000 };
const source = `return {apiVersion=1,pluginId='crash',plan=function() return {
  apiVersion=1,pluginId='crash',steps={{id='generate',adapter={id='iris.lua',version='1.0.0'},
  options={script='iris.lua',entrypoint='generate'},outputs={out={kind='file',mediaType='text/plain',path='result.txt'}}}},
  targets={main={steps={'generate'},publish={{step='generate',port='out'}}}}} end,
  generate=function(ctx) ctx.write('out','result.txt','preserve publication bytes') end}`;

for (const phase of ["before-rename", "after-rename", "cancelled-publication", "revoked-publication"]) {
  test(`coordinator SIGKILL at ${phase} retains publication evidence across real restart`, options, async t => {
    const pool = await isolatedSchema(t), work = await workspace("iris-publication-crash-");
    try {
      const schema = (await pool.query("SELECT current_schema() AS name")).rows[0].name;
      const database = new URL(connectionString), repo = path.resolve(__dirname, ".."), port = await freePort();
      const data = path.join(work.root, "data"), marker = path.join(work.root, "publication.json"), hook = path.join(work.root, "pause-publication.cjs");
      // Pause only at the filesystem boundary. The real server, SQL, Lua and
      // publication protocol run unchanged; a parent-owned SIGKILL ends the wait.
      await fs.writeFile(hook, `const fs=require('node:fs/promises');const rename=fs.rename;
        fs.rename=async function(from,to) {
          const receipt=await fs.stat(require('node:path').join(from,'.iris-pipeline-publication.jsonl')).catch(e=>{if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e});
          if(!receipt)return rename(from,to);
          if(process.env.CRASH_PHASE!=='before-rename')await rename(from,to);
          await fs.writeFile(process.env.CRASH_MARKER,JSON.stringify({from,to}));
          await new Promise(()=>{});
        };`);
      const env = { ...work.env, DATA_DIR: data, PUBLIC_DIR: path.join(repo, "public"), PORT: String(port), BIND_ADDRESS: "127.0.0.1",
        IRIS_SECRET: "publication-crash-test-only-secret", DB_HOST: database.hostname, DB_PORT: database.port,
        DB_USER: decodeURIComponent(database.username), DB_PASSWORD: decodeURIComponent(database.password), DB_NAME: database.pathname.slice(1),
        PGOPTIONS: `-c search_path=${schema}`, RETENTION_ENABLED: "false", LUA_BIN_PATH: process.env.LUA_BIN_PATH || "" };
      const start = async paused => {
        const app = launch(process.execPath, [...(paused ? ["--require", hook] : []), path.join(repo, "src/server.js")], {
          cwd: work.cwd, env: { ...env, CRASH_PHASE: phase, CRASH_MARKER: marker }, quiet: true, allowFailure: true, timeout: 25000,
        });
        work.defer(() => app.stop());
        await until(() => /Iris listening|Unable to start Iris backend/.test(app.output()), "real server start", 10000);
        assert.match(app.output(), /Iris listening/);
        return app;
      };
      const app = await start(true), origin = `http://127.0.0.1:${port}`;
      let cookie;
      const request = async (url, method = "GET", body, status = 200) => {
        const response = await fetch(origin + url, { method, signal: AbortSignal.timeout(10000),
          headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
        cookie = response.headers.get("set-cookie")?.split(";")[0] || cookie;
        return value;
      };
      await until(() => /Password: [A-Za-z0-9_-]+/.test(app.output()), "initial administrator credential", 5000);
      await request("/api/auth/login", "POST", { username: "admin", password: app.output().match(/Password: ([A-Za-z0-9_-]+)/)[1] });
      const made = await request("/api/projects", "POST", { name: "Crash fixture", data: { project: { nodes: [
        { id: "script", type: "file", name: "iris.lua", path: "iris.lua", content: source },
      ] } } }, 201);
      const base = `/api/projects/${made.project.id}`;
      const { pipeline } = await request(`${base}/pipeline`);
      const { approval } = await request(`${base}/pipeline/approval`, "POST", { identity: pipeline.candidate }, 201);
      const { descriptor } = await request(`${base}/pipeline/inspect`, "POST", {});
      const { run } = await request(`${base}/runs`, "POST", { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash }, 202);
      let publication;
      await until(async () => {
        try { publication = JSON.parse(await fs.readFile(marker, "utf8")); return true; }
        catch (error) { if (error.code !== "ENOENT") throw error; return false; }
      }, "publication rename boundary", 10000);
      assert.equal((await pool.query("SELECT publication_state FROM build_outputs WHERE id=$1", [run.id])).rows[0].publication_state, "prepared");
      app.child.kill("SIGKILL");
      assert.equal((await app.done).signal, "SIGKILL");
      const output = phase === "before-rename" ? publication.from : publication.to;
      const bytesPath = path.join(output, "generate/out/result.txt"), receipt = await fs.readFile(path.join(output, ".iris-pipeline-publication.jsonl"));
      assert.equal(await fs.readFile(bytesPath, "utf8"), "preserve publication bytes");
      const changed = phase.endsWith("-publication");
      if (changed) {
        await fs.chmod(bytesPath, 0o600); await fs.writeFile(bytesPath, "altered publication bytes!");
      }
      const before = await fs.readFile(bytesPath), restarted = await start(false);
      if (!changed) {
        await until(async () => (await request(`${base}/runs/${run.id}`)).run.state === "interrupted", "interrupted run reconciliation", 5000);
        assert.equal((await request(`${base}/builds/${run.id}`)).artifacts.length, 0);
        await until(async () => (await request("/api/health")).pendingWrites === 0, "recovery drain", 5000);
        assert.equal((await restarted.stop()).code, 0);
      } else {
        assert.equal((await request(`${base}/runs/${run.id}`)).run.state, "running");
        assert.ok((await request("/api/health")).pendingWrites > 0);
        const refused = await request(`${base}/runs`, "POST", { target: "main", parameters: {}, descriptorHash: descriptor.descriptorHash }, 503);
        assert.equal(refused.errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
        assert.equal((await request(`${base}/pipeline/inspect`, "POST", {}, 503)).errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
        if (phase === "cancelled-publication") await request(`${base}/runs/${run.id}/cancel`, "POST", {});
        else await request(`${base}/pipeline/approval/${approval.id}`, "DELETE");
        assert.equal((await request(`${base}/runs/${run.id}`)).run.state, "cancelled");
        assert.equal((await restarted.stop()).code, 1);
        const again = await start(false);
        assert.ok((await request("/api/health")).pendingWrites > 0, "terminal status cannot clear a prepared publication obligation");
        if (phase === "revoked-publication") {
          const metadata = (await request(`${base}/pipeline`)).pipeline;
          await request(`${base}/pipeline/approval`, "POST", { identity: metadata.candidate }, 201);
        }
        assert.equal((await request(`${base}/pipeline/inspect`, "POST", {}, 503)).errorCode, "PIPELINE_WORKER_RECOVERY_REQUIRED");
        assert.equal((await again.stop()).code, 1);
      }
      assert.deepEqual(await fs.readFile(bytesPath), before);
      assert.deepEqual(await fs.readFile(path.join(output, ".iris-pipeline-publication.jsonl")), receipt);
      if (phase === "before-rename") await assert.rejects(fs.stat(publication.to), { code: "ENOENT" });
    } finally { await work.close(); }
  });
}
