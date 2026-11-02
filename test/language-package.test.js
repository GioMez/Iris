const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const exec = promisify(require("node:child_process").execFile);
const { save } = require("./helpers/language-performance.cjs");
const enabled = process.env.IRIS_LANGUAGE_QUALIFY === "1";

test("HP08 extracted candidate fresh installs production startup local browser assets and identical regeneration", { skip: !enabled, timeout: 600000 }, async t => {
  const repo = path.resolve(__dirname, ".."), root = await fs.mkdtemp(path.join(os.tmpdir(), "iris-hp08-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const { included } = require("../scripts/release.cjs");
  // Explicit candidate whitelist from public release policy. Never descend into
  // .git/.env/node_modules/drafts; capture working bytes, not HEAD, and persist
  // the exact manifest/hashes for review. The extracted phase uses no Git.
  const names = [];
  async function walk(dir, prefix = "") {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + e.name;
      if (e.isDirectory()) {
        if ((!prefix && ["src", "public", "db", "test", "scripts", "docs", "branding"].includes(e.name))
          || prefix && !e.name.startsWith(".") && !["node_modules", "data", "storage", "coverage", "tmp", "temp", "dist", "build", "artifacts", "superpowers"].includes(e.name)) await walk(path.join(dir, e.name), name + "/");
      } else if (e.isFile() && included(name)) names.push(name);
    }
  }
  await walk(repo); names.sort();
  const manifest = path.join(root, "manifest.json"); await fs.writeFile(manifest, JSON.stringify(names));
  const env = { ...process.env, NODE_PATH: "", IRIS_HP_PLAYWRIGHT: require.resolve("playwright-core"), npm_config_cache: path.join(root, "npm-cache"), npm_config_userconfig: path.join(root, "empty-npmrc") };
  // node:test marks its file children; carrying that into a nested --test
  // invocation makes Node skip execution as a recursive runner.
  delete env.NODE_TEST_CONTEXT;
  const report = { files: [], stages: [] };
  for (const name of names) report.files.push({ name, sha256: createHash("sha256").update(await fs.readFile(path.join(repo, name))).digest("hex") });
  const run = async (command, args, cwd = root, timeout = 120000) => {
    const result = await exec(command, args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    report.stages.push({ command: path.basename(command), args, stdout: result.stdout, stderr: result.stderr }); await save("package", report);
    return result;
  };
  await run(process.execPath, [path.join(repo, "scripts/release.cjs"), "--candidate", repo, "--manifest", manifest, "--output", path.join(root, "out")]);
  const version = require("../package.json").version, archive = path.join(root, "out", `iris-${version}.tar.gz`);
  report.archiveSHA256 = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  if (process.env.IRIS_LANGUAGE_RESULTS) await fs.copyFile(archive, path.join(process.env.IRIS_LANGUAGE_RESULTS, `candidate-${report.archiveSHA256}.tar.gz`));
  await run("tar", ["-xzf", archive, "-C", root]);
  const packaged = path.join(root, `iris-${version}`);
  await assert.rejects(fs.stat(path.join(packaged, ".git")), { code: "ENOENT" });
  // Assert no ancestor module directory can satisfy missing production imports.
  for (let parent = path.dirname(packaged); parent !== path.dirname(parent); parent = path.dirname(parent)) await assert.rejects(fs.stat(path.join(parent, "node_modules")), { code: "ENOENT" });
  const npm = async args => process.platform === "win32"
    ? run(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], packaged)
    : run("npm", args, packaged);
  await npm(["ci", "--omit=dev", "--no-audit", "--no-fund"]);
  await assert.rejects(fs.stat(path.join(packaged, "node_modules/@lezer/generator")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(packaged, "node_modules/esbuild")), { code: "ENOENT" });
  await run(process.execPath, ["--input-type=module", "-e", `import {analyze} from './public/iris-language-service.mjs'; for (const [k,s] of [['tex','\\\\section{Package}'],['ly','\\\\score { c4 }']]) { const a=await analyze(k,s); if(a.status!=='ready'||!a.data.outline.length) throw Error(k); }`], packaged);
  // Child lifetime prevents a loaded Windows native addon locking node_modules.
  const child = await run(process.execPath, ["--test", "--test-reporter=tap", "test/helpers/language-package-browser.cjs"], packaged);
  const payload = child.stdout.match(/HP08_PACKAGE (\{[^\n]+\})/);
  assert.ok(payload, `extracted browser child must actually execute: ${child.stdout}\n${child.stderr}`);
  report.productionBrowser = JSON.parse(payload[1]);
  const external = report.productionBrowser.external;
  report.blockedExternalRequests = external;
  await save("package", report);
  await npm(["ci", "--include=dev", "--no-audit", "--no-fund"]);
  await run(process.execPath, ["scripts/build-languages.cjs", "--check"], packaged);
  await run(process.execPath, ["scripts/build-language-worker.cjs", "--check"], packaged);
  const generated = report.files.filter(f => /\/parser(?:\.terms)?\.mjs$/.test(f.name));
  for (const f of generated) await fs.rm(path.join(packaged, f.name));
  await run(process.execPath, ["scripts/build-languages.cjs"], packaged);
  for (const f of generated) assert.equal(createHash("sha256").update(await fs.readFile(path.join(packaged, f.name))).digest("hex"), f.sha256);
  const workerFiles = report.files.filter(f => /^public\/vendor\/language-worker\/.*\.mjs$/.test(f.name));
  for (const f of workerFiles) await fs.rm(path.join(packaged, f.name));
  await run(process.execPath, ["scripts/build-language-worker.cjs"], packaged);
  for (const f of workerFiles) assert.equal(createHash("sha256").update(await fs.readFile(path.join(packaged, f.name))).digest("hex"), f.sha256);
  report.regenerationIdentical = true; await save("package", report);
  t.diagnostic(`Candidate ${report.archiveSHA256}; ${names.length} files; production startup and ${generated.length} regenerated files verified`);
  assert.deepEqual(external, [], "whole-app no-CDN gate: requested fonts are reported even when language runtime works offline");
});
