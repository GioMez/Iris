#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const assert = require("node:assert/strict");
const { parseArgs } = require("node:util");
const { run, launch, workspace, postgres, freePort, until } = require("./lib/disposable.cjs");
const { journey, filesystemProbe } = require("./lib/smoke-journey.cjs");
const root = path.resolve(__dirname, "..");
const image = `localhost/iris:${require("../package.json").version}`;
const help = `Usage:
  node scripts/smoke.cjs --native [--browser] [--pg-bin DIR]
  node scripts/smoke.cjs --engine docker
  node scripts/smoke.cjs --engine podman [--connection NAME] [--compose-provider PATH]

--native                  Two disposable native installations and PG18+ cluster;
                          requires npm ci, pdflatex, lilypond and gs on PATH.
--browser                 Paint both native PDFs in installed Chrome.
--browser-executable PATH  Enable native PDF browser smoke in this Chromium.
--pg-bin DIR              PostgreSQL tools (default pg_config --bindir).
--engine docker|podman    Build lightweight image from this source root; exercise
                          the same Compose, restart and two-layer backup/restore.
--connection NAME         Explicit Podman connection (never changes defaults).
--compose-provider PATH   Explicit Podman Compose provider (tested: podman-compose).
--use-image               Use an already-built ${image}. Otherwise
                          refuse to overwrite it, build it and remove it on cleanup.
--help                    Show help.

All credentials/storage are generated and disposable; no external DB URL or .env
is consumed. Container engines must already be provisioned. This script creates
unique projects, containers and volumes and removes only its owned resources.
The engine must see this source path for the Compose init-script bind mount.
Docker context/DOCKER_HOST or an explicit Podman connection selects the engine.
No machine provisioning, registry publication, or Git is performed here.
Native smoke requires an unprivileged POSIX host. Docker/Podman smokes verify
missing-compiler failures; successful compilation belongs to --native.
`;
async function nativeInstances(work, values) {
  const pg = await postgres(work, values["pg-bin"]), password = randomBytes(24).toString("hex");
  const adminSQL = (sql) => run(pg.tool("psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-c", sql], { env: pg.env, quiet: true });
  await adminSQL(`CREATE ROLE iris LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
  const instances = [];
  for (const name of ["source", "restore"]) {
    const database = `iris_${name}`, data = path.join(work.root, name), port = await freePort();
    await adminSQL(`CREATE DATABASE ${database} OWNER iris`);
    await fs.mkdir(data);
    const env = { ...work.env, PATH: pg.env.PATH, DB_HOST: "127.0.0.1", DB_PORT: String(pg.port), DB_NAME: database, DB_USER: "iris", DB_PASSWORD: password,
      IRIS_SECRET: randomBytes(32).toString("hex"), DATA_DIR: data, TEMPLATE_DIR: path.join(data, "templates"), PUBLIC_DIR: path.join(root, "public"), BIND_ADDRESS: "127.0.0.1", PORT: String(port),
      TEX_PATH_LOCKED: "true", LILYPOND_PATH_LOCKED: "true", RETENTION_ENABLED: "false", SHUTDOWN_TIMEOUT_MS: "15000" };
    const dbEnv = { ...pg.env, PGUSER: "iris", PGPASSWORD: password, PGDATABASE: database };
    let app, transcript = "";
    const instance = { name, url: `http://127.0.0.1:${port}`,
      async start() { app = launch(process.execPath, [path.join(root, "src/server.js")], { cwd: work.cwd, env, quiet: true, timeout: 300000 }); },
      async stop() { if (app) { const current = app; app = null; await current.stop(); transcript += current.output(); } },
      async restart() {
        await instance.stop();
        await run(pg.tool("pg_ctl"), ["-D", path.join(work.root, "pgdata"), "-l", path.join(work.root, "postgres.log"), "-m", "fast", "-w", "-t", "10", "restart"], { env: pg.env, quiet: true, timeout: 15000 });
        await instance.start();
      },
      async logs() { return transcript + (app?.output() || ""); },
      marker: (on) => on ? fs.writeFile(path.join(data, ".maintenance"), "") : fs.rm(path.join(data, ".maintenance")),
      async sql(sql) { return (await run(pg.tool("psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql], { env: dbEnv, quiet: true })).stdout.toString(); },
      async files() { return JSON.parse((await run(process.execPath, ["-e", filesystemProbe, data], { env: work.env, quiet: true })).stdout); },
      async backup() {
        const dump = path.join(work.root, "database.dump"), archive = path.join(work.root, "storage.tar");
        await run(pg.tool("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", "--file", dump], { env: dbEnv, quiet: true });
        await run("tar", ["-cf", archive, "-C", data, "."], { env: work.env, quiet: true });
        return { dump, archive };
      },
      async restore({ dump, archive }) {
        await run(pg.tool("pg_restore"), ["--exit-on-error", "--no-owner", "--no-privileges", "--dbname", database, dump], { env: dbEnv, quiet: true });
        await run("tar", ["-xf", archive, "-C", data], { env: work.env, quiet: true });
      },
    };
    work.cleanups.push(() => instance.stop()); instances.push(instance);
  }
  return instances;
}
async function containerInstances(work, values) {
  const engine = values.engine, prefix = engine === "podman" && values.connection ? ["--connection", values.connection] : [];
  // The engine CLI needs its operator connection configuration, never app config.
  const env = { ...work.env, HOME: process.env.HOME,
    ...(engine === "docker" ? Object.fromEntries(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_CONFIG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]])) : {}),
    ...(values.connection ? { CONTAINER_CONNECTION: values.connection } : {}),
    ...(values["compose-provider"] ? { PODMAN_COMPOSE_PROVIDER: path.resolve(values["compose-provider"]) } : {}),
  };
  const cli = (args, options = {}) => run(engine, [...prefix, ...args], { cwd: root, env, timeout: 120000, quiet: true, ...options });
  const ownContainer = (name) => work.defer(async () => {
    const removed = await cli(["rm", "-f", name], { allowFailure: true });
    // rm can race the engine's --rm. Only a successful listing proves absence;
    // an unreachable engine or refused removal must not look like cleanup.
    const remaining = (await cli(["container", "ls", "-a", "--format", "{{.Names}}"])).stdout.toString().trim().split(/\r?\n/);
    assert.ok(!remaining.includes(name), `Container cleanup failed for ${name}: ${removed.stderr.toString()}`);
  });
  await cli(["version"], { quiet: false }); await cli(["compose", "version"], { quiet: false });
  const nullEnv = path.join(work.root, "compose-empty.env"); await fs.writeFile(nullEnv, "");
  for (const missing of ["IRIS_SECRET", "DB_PASSWORD", "POSTGRES_ADMIN_PASSWORD"]) {
    const configured = { ...env, IRIS_SECRET: "smoke-session-only", DB_PASSWORD: "smoke-db-only", POSTGRES_ADMIN_PASSWORD: "smoke-admin-only" };
    delete configured[missing];
    const refused = await cli(["compose", "--env-file", nullEnv, "-f", path.join(root, "docker-compose.yml"), "config"], { env: configured, allowFailure: true });
    assert.notEqual(refused.code, 0, `Compose must refuse missing ${missing}`);
    assert.ok(Buffer.concat([refused.stdout, refused.stderr]).toString().includes(missing), `Compose identifies missing ${missing}`);
  }
  console.log("PASS Compose refuses each missing session/database/admin secret");
  const exists = (await cli(["image", "inspect", image], { allowFailure: true })).code === 0;
  if (!values["use-image"] && exists) throw new Error(`${image} already exists; pass --use-image or select a disposable engine`);
  if (values["use-image"] && !exists) throw new Error(`${image} is missing; omit --use-image to build`);
  if (!exists) {
    work.cleanups.push(async () => {
      if ((await cli(["image", "inspect", image], { allowFailure: true })).code === 0) await cli(["image", "rm", image]);
    });
    await cli(["build", "-t", image, "."], { timeout: 600000, quiet: false });
  }
  const probeName = `iris-smoke-probe-${randomBytes(5).toString("hex")}`;
  const removeProbe = ownContainer(probeName);
  try {
    await cli(["run", "--rm", "--name", probeName, "--network", "none", "--entrypoint", "sh", image, "-c",
      "test -r /app/LICENSE && test -r /app/THIRD_PARTY_NOTICES.md && test -r /app/db/schema.sql && ! command -v pdflatex && ! command -v lilypond && test $(id -u) -eq 1000"]);
  } finally { await removeProbe(); }
  const instances = [];
  for (const name of ["source", "restore"]) {
    const project = `iris-smoke-${name}-${randomBytes(5).toString("hex")}`, port = await freePort();
    const composeEnv = { ...env, IRIS_PORT: String(port), IRIS_BIND_ADDRESS: "127.0.0.1", IRIS_SECRET: randomBytes(32).toString("hex"), DB_PASSWORD: randomBytes(24).toString("hex"), POSTGRES_ADMIN_PASSWORD: randomBytes(24).toString("hex") };
    const compose = (args, options = {}) => cli(["compose", "--env-file", nullEnv, "-f", path.join(root, "docker-compose.yml"), "-p", project, ...args], { env: composeEnv, ...options });
    const id = async (service) => {
      const found = (await cli(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`])).stdout.toString().trim().split(/\s+/).filter(Boolean);
      assert.equal(found.length, 1, `${project} ${service} container identity`); return found[0];
    };
    const volume = `${project}_project-data`;
    let helperCounter = 0;
    const helper = async (args, input) => {
      const helperName = `${project}-helper-${++helperCounter}`;
      const removeHelper = ownContainer(helperName);
      try { return await cli(["run", "--rm", "-i", "--name", helperName, "--network", "none", "--user", "0", "-v", `${volume}:/restore`, "--entrypoint", args[0], image, ...args.slice(1)], { input }); }
      finally { await removeHelper(); }
    };
    work.cleanups.push(async () => {
      await compose(["down", "--volumes", "--remove-orphans"], { timeout: 120000 });
      // A target volume created before Compose starts the app is still ours.
      const remainingVolume = await cli(["volume", "inspect", volume], { allowFailure: true });
      if (remainingVolume.code === 0) await cli(["volume", "rm", volume]);
      const remaining = (await cli(["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`])).stdout.toString().trim();
      assert.equal(remaining, "", `cleanup containers for ${project}`);
      for (const vol of [volume, `${project}_postgres-data`]) assert.notEqual((await cli(["volume", "inspect", vol], { allowFailure: true })).code, 0, `cleanup volume ${vol}`);
      assert.notEqual((await cli(["network", "inspect", `${project}_default`], { allowFailure: true })).code, 0, `cleanup network ${project}`);
      console.log(`Cleanup confirmed: ${engine} project ${project}, containers and both volumes removed`);
    });
    await compose(["up", "-d", "postgres"]);
    await until(async () => {
      const data = JSON.parse((await cli(["inspect", await id("postgres")])).stdout)[0];
      return (data.State.Health?.Status || data.State.Healthcheck?.Status) === "healthy";
    }, `${engine} PostgreSQL health`, 120000);
    const pgId = await id("postgres");
    const pg = (tool, args, options) => cli(["exec", "-i", "-e", `PGPASSWORD=${composeEnv.DB_PASSWORD}`, pgId, tool, "-U", "iris", "-d", "iris", ...args], options);
    assert.ok(Number((await pg("psql", ["-X", "-Atc", "SHOW server_version_num"])).stdout.toString().trim()) >= 180000);
    assert.equal((await pg("psql", ["-X", "-Atc", "SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user"])).stdout.toString().trim(), "f");
    if (name === "restore") await cli(["volume", "create", volume]);
    const instance = { name, url: `http://127.0.0.1:${port}`,
      async start() {
        await compose(["up", "-d", "webapp"]);
        const webId = await id("webapp");
        await until(async () => {
          const data = JSON.parse((await cli(["inspect", webId])).stdout)[0];
          return (data.State.Health?.Status || data.State.Healthcheck?.Status) === "healthy";
        }, `${engine} app health`, 120000);
        await cli(["exec", webId, "node", "-e", `const fs=require('fs');if(process.getuid()!==1000)throw Error('uid');try{fs.writeFileSync('/app/forbidden','x');throw Error('root writable')}catch(e){if(e.code!=='EROFS')throw e}fs.writeFileSync('/tmp/owned-probe','ok');fs.unlinkSync('/tmp/owned-probe');fs.writeFileSync('/app/data/owned-probe','ok');fs.unlinkSync('/app/data/owned-probe')`]);
      },
      async stop() { await compose(["stop", "webapp"]); const state = JSON.parse((await cli(["inspect", await id("webapp")])).stdout)[0].State; assert.equal(state.ExitCode, 0, "graceful app shutdown"); },
      async restart() {
        await compose(["stop"]);
        for (const service of ["webapp", "postgres"]) assert.equal(JSON.parse((await cli(["inspect", await id(service)])).stdout)[0].State.ExitCode, 0, `${service} graceful shutdown`);
        await instance.start();
      },
      async logs() { return (await cli(["logs", await id("webapp")])).stdout.toString(); },
      async marker(on) { await helper(["node", "-e", `require('fs').${on ? "writeFileSync('/restore/.maintenance','')" : "unlinkSync('/restore/.maintenance')"}`]); },
      async sql(sql) { return (await pg("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql])).stdout.toString(); },
      async files() { return JSON.parse((await helper(["node", "-e", filesystemProbe, "/restore"])).stdout); },
      async backup() { return { dump: (await pg("pg_dump", ["--format=custom", "--no-owner", "--no-privileges"])).stdout, archive: (await helper(["tar", "-cf", "-", "-C", "/restore", "."])).stdout }; },
      async restore({ dump, archive }) { await pg("pg_restore", ["--exit-on-error", "--no-owner", "--no-privileges"], { input: dump }); await helper(["tar", "-xpf", "-", "-C", "/restore"], archive); },
    };
    instances.push(instance);
  }
  return instances;
}
async function main() {
  const { values } = parseArgs({ options: {
    ...Object.fromEntries(["help", "native", "browser", "use-image"].map((name) => [name, { type: "boolean" }])),
    ...Object.fromEntries(["engine", "connection", "compose-provider", "pg-bin", "browser-executable"].map((name) => [name, { type: "string" }])),
  } });
  if (values.help) return console.log(help);
  if (!!values.native === !!values.engine || (values.engine && !["docker", "podman"].includes(values.engine))) throw new Error("Choose --native or --engine docker|podman; see --help");
  if ((values.browser || values["browser-executable"] || values["pg-bin"]) && !values.native) throw new Error("Browser/PG tool options require --native");
  if ((values.connection || values["compose-provider"]) && values.engine !== "podman") throw new Error("Connection/provider options require --engine podman");
  const work = await workspace("iris-smoke-");
  try {
    console.log(`Smoke source ${root}; Node ${process.version}; mode ${values.native ? "native" : values.engine}`);
    const [source, target] = values.native ? await nativeInstances(work, values) : await containerInstances(work, values);
    try { await journey(source, target, { native: values.native, browser: values.browser || !!values["browser-executable"], browserExecutable: values["browser-executable"], work }); }
    catch (error) { console.error((await source.logs()).replace(/Password: \S+/g, "Password: [disposable credential redacted]")); throw error; }
  } finally { await work.close(); }
}
main().catch((error) => { console.error(error.stack); if (error.errors) for (const cause of error.errors) console.error(cause.stack); process.exitCode ||= 1; });
