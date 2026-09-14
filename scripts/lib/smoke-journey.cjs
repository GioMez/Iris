const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const { until, operationSignal } = require("./disposable.cjs");
const { withBrowser } = require("./browser.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tables = ["iris_schema", "users", "projects", "project_members", "project_files", "document_versions", "build_outputs", "build_artifacts", "audit_events", "project_deletions"];
const snapshotSQL = `SELECT jsonb_build_object(${tables.map((name) => `'${name}', (SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM ${name} t)`).join(",")});`;
// Runs inside either runtime to compare every file and its mode at the frozen point.
const filesystemProbe = `const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{const root=process.argv[1],out={}; async function walk(dir){for(const e of await fs.readdir(path.join(root,dir),{withFileTypes:true})){
 const name=path.posix.join(dir,e.name),file=path.join(root,name),s=await fs.lstat(file);
 if(s.isSymbolicLink())throw Error('Unexpected storage symlink: '+name);
 out[name]={mode:s.mode&511,sha256:s.isDirectory()?null:crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')};
 if(s.isDirectory())await walk(name);}} await walk('');console.log(JSON.stringify(out));})().catch(e=>{console.error(e);process.exitCode=1});`;
function client(base) {
  let cookie = "";
  const request = async (route, { method = "GET", body, status = 200, binary = false } = {}) => {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(`${base}${route}`, { method, signal: operationSignal(90000),
      headers: { ...(cookie ? { cookie } : {}), origin: base, ...(body !== undefined ? { "content-type": raw ? "application/zip" : "application/json" } : {}) },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, status, `${method} ${route}: ${bytes.toString().slice(0, 1000)}`);
    const replacement = response.headers.get("set-cookie");
    if (replacement) cookie = replacement.split(";")[0];
    return binary ? bytes : JSON.parse(bytes.toString());
  };
  return { request, cookie: () => cookie, login: (username, password) => request("/api/auth/login", { method: "POST", body: { username, password } }) };
}
async function ready(instance) {
  await until(async () => {
    try { return (await (await fetch(`${instance.url}/api/health`, { signal: AbortSignal.timeout(1000) })).json()).status === "ok"; }
    catch { return false; }
  }, `${instance.name} readiness`, 60000);
}
async function drain(instance, api) {
  await instance.marker(true);
  await until(async () => {
    const h = await api.request("/api/health");
    return h.status === "maintenance" && h.maintenance && h.pendingWrites === 0;
  }, "maintenance with zero pending writes");
  const refusal = await api.request("/api/projects", { method: "POST", body: { name: "must be refused" }, status: 503 });
  assert.equal(refusal.errorCode, "MAINTENANCE_MODE");
}
const sources = {
  latex: "\\documentclass{article}\n\\begin{document}\nA stable release smoke.\n\\end{document}\n",
  lilypond: '\\version "2.24.3"\n\\relative c\' { c4 d e f }\n',
};
async function verifyProject(api, record, compiled) {
  const base = `/api/projects/${record.id}`;
  const data = await api.request(base);
  assert.equal(data.projectType, record.type);
  assert.equal(data.autoSaveDelay, 900);
  assert.equal(data.sourceMapping, true);
  const source = await api.request(`${base}/files/download?path=${record.file}`, { binary: true });
  assert.equal(source.toString(), sources[record.type]);
  const note = await api.request(`${base}/files/download?path=notes.txt`, { binary: true });
  assert.equal(note.toString(), "Portable é 😀\r\nByte-preserving source.\r\n");
  if (!record.build) return;
  const build = await api.request(`${base}/builds/${record.build.buildId}`);
  assert.equal(build.build.status, compiled ? "succeeded" : "failed");
  if (compiled) {
    const artifact = record.build.artifacts[0];
    const bytes = await api.request(`${base}/builds/${record.build.buildId}/artifacts/${artifact.id}`, { binary: true });
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal(hash(bytes), record.pdfHash);
    const navigation = await api.request(`${base}/builds/${record.build.buildId}/navigation`, { method: "POST", body: {
      direction: "forward", sourceFileId: record.build.sourceFileId, line: record.type === "latex" ? 3 : 2, column: record.type === "latex" ? 0 : 16,
    } });
    assert.equal(navigation.status, "ready", JSON.stringify(navigation));
    const m = navigation.matches[0];
    const inverse = await api.request(`${base}/builds/${record.build.buildId}/navigation`, { method: "POST", body: {
      direction: "inverse", artifactId: m.artifactId, page: m.page, x: m.x + Math.min(2, m.width / 2), y: m.y + m.height / 2,
    } });
    assert.equal(inverse.status, "ready", JSON.stringify(inverse));
    assert.equal(inverse.matches[0].sourceFileId, record.build.sourceFileId);
  }
}
async function preview(work, instance, api, records, executable) {
  await withBrowser(work, executable ? { executablePath: executable } : { channel: "chrome" }, async (browser) => {
    const context = await browser.newContext();
    await context.addCookies([{ name: "iris_session", value: api.cookie().slice("iris_session=".length), url: instance.url }]);
    const page = await context.newPage();
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(instance.url, { waitUntil: "networkidle", timeout: 15000 });
    for (const record of records) {
      await page.evaluate(async (id) => { await IrisEditor.ready; await IrisProjects.openProject(id); }, record.id);
      await page.waitForFunction((id) => IrisApp.currentBuildId() === id && document.querySelector(".pdf-page canvas")?.width > 0, record.build.buildId, { timeout: 15000 });
      assert.equal(await page.locator(".cm-content").count(), 1);
    }
    await page.evaluate(() => IrisCollab.disconnect());
    assert.deepEqual(errors, []);
    console.log(`PASS browser PDF painting and project navigation: Chromium ${browser.version()}`);
  });
}
async function journey(source, target, { native = false, browser = false, browserExecutable, work } = {}) {
  await source.start(); await ready(source);
  const logs = await source.logs();
  const initial = logs.match(/Password: ([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(initial, "fresh installation prints its initial admin credential");
  const api = client(source.url), password = `smoke-${randomBytes(18).toString("hex")}`;
  assert.equal((await api.login("admin", initial)).user.role, "admin");
  await api.request("/api/auth/password", { method: "POST", body: { currentPassword: initial, newPassword: password } });
  const createdViewer = await api.request("/api/admin/users", { method: "POST", status: 201, body: { username: "smoke-viewer", email: "viewer@example.test", name: "Synthetic viewer", role: "regular" } });
  const viewer = client(source.url), viewerPassword = `viewer-${randomBytes(18).toString("hex")}`;
  await viewer.login("smoke-viewer", createdViewer.temporaryPassword);
  await viewer.request("/api/auth/password", { method: "POST", body: { currentPassword: createdViewer.temporaryPassword, newPassword: viewerPassword } });
  console.log("PASS fresh schema, first-admin login, password change and account creation");
  const records = [];
  for (const type of ["latex", "lilypond"]) {
    const file = type === "latex" ? "main.tex" : "main.ly";
    const made = await api.request("/api/projects", { method: "POST", status: 201, body: { name: `Smoke ${type}`, data: {
      projectType: type, language: "en", sourceMapping: true, autoSave: false, autoSaveDelay: 900,
      project: { nodes: [{ id: "main", type: "file", name: file, path: file, kind: file.split(".").pop(), content: sources[type] },
        { id: "note", type: "file", name: "notes.txt", path: "notes.txt", kind: "txt", content: "Portable é 😀\r\nByte-preserving source.\r\n" }] },
    } } });
    const record = { id: made.project.id, type, file };
    const base = `/api/projects/${record.id}`;
    await api.request(`${base}/members`, { method: "POST", status: 201, body: { userId: createdViewer.user.id, role: "viewer" } });
    await viewer.request(`${base}/compile`, { method: "POST", body: {}, status: 403 });
    record.build = await api.request(`${base}/compile`, { method: "POST", body: {} });
    assert.equal(record.build.success, native, record.build.log);
    if (native) record.pdfHash = hash(Buffer.from(record.build.artifacts[0].base64, "base64"));
    else assert.match(record.build.log, /ENOENT|not found|spawn/i, "stock image reports an unavailable compiler");
    await verifyProject(api, record, native);
    const archive = await api.request(`${base}/archive`, { binary: true });
    const imported = await api.request("/api/projects/import?filename=smoke.zip", { method: "POST", body: archive, status: 201 });
    assert.notEqual(imported.project.id, record.id);
    await verifyProject(api, { ...record, id: imported.project.id, build: null }, native);
    await viewer.request(`/api/projects/${imported.project.id}`, { status: 404 });
    record.members = await api.request(`${base}/members`);
    records.push(record);
  }
  console.log(`PASS create, source bytes/settings, viewer permissions, export/import; ${native ? "LaTeX + LilyPond compile, PDF bytes and forward/inverse navigation" : "compiler-free image returns honest failed build records"}`);
  if (browser) await preview(work, source, api, records, browserExecutable);
  else console.log("SKIP browser PDF painting (enable --browser on the native smoke)");
  await source.restart(); await ready(source);
  await api.login("admin", password);
  for (const record of records) { await verifyProject(api, record, native); assert.deepEqual(await api.request(`/api/projects/${record.id}/members`), record.members); }
  console.log("PASS stop/start retains login, projects, permissions and build history");
  await drain(source, api);
  await source.stop(); // A stopped, drained writer also prevents a later client from changing either layer.
  const beforeDB = JSON.parse(await source.sql(snapshotSQL)), beforeFS = await source.files();
  assert.equal(beforeDB.iris_schema[0].version, 2);
  assert.equal(beforeDB.projects.length, 4);
  assert.equal(beforeDB.build_outputs.length, 2);
  const backup = await source.backup();
  await target.restore(backup);
  assert.deepEqual(JSON.parse(await target.sql(snapshotSQL)), beforeDB, "every database row restored before startup");
  assert.deepEqual(await target.files(), beforeFS, "every filesystem byte and mode restored to a separate data volume");
  await target.marker(false); await target.start(); await ready(target);
  const restored = client(target.url), restoredViewer = client(target.url);
  await restored.login("admin", password); await restoredViewer.login("smoke-viewer", viewerPassword);
  for (const record of records) {
    await verifyProject(restored, record, native);
    assert.deepEqual(await restored.request(`/api/projects/${record.id}/members`), record.members);
    await restoredViewer.request(`/api/projects/${record.id}`);
    await restoredViewer.request(`/api/projects/${record.id}/compile`, { method: "POST", body: {}, status: 403 });
  }
  const other = await restored.request("/api/projects", { method: "POST", body: { name: "Restore target only" }, status: 201 });
  assert.ok(other.project.id);
  assert.deepEqual(JSON.parse(await source.sql(snapshotSQL)), beforeDB, "target writes cannot mutate source database");
  assert.deepEqual(await source.files(), beforeFS, "target writes cannot mutate source storage");
  console.log(`PASS drained backup + separate-instance restore: ${tables.length} tables, ${Object.keys(beforeFS).length} filesystem entries; login, permissions, builds, source/settings and target-only mutation`);
}
module.exports = { journey, filesystemProbe };
