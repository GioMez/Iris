const test = require("node:test");
const assert = require("node:assert/strict");
const { serverFixture } = require("./helpers/server-fixture.cjs");
const { uuidv7 } = require("../src/ids");
const { extractZip } = require("../src/zip");

test("custom command settings are validated, shared, persisted and portable in project archives", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 20000,
}, async (t) => {
  const f = await serverFixture(t);
  const user = async (name) => (await f.pool.query(
    "INSERT INTO users (id, username, email, display_name) VALUES ($1, $2, $3, $2) RETURNING *",
    [uuidv7(), name, `${name}@example.test`]
  )).rows[0];
  const owner = await user("completion-owner"), viewer = await user("completion-viewer");
  const cookie = f.cookieFor(owner);
  const create = (commands) => f.request("/api/projects", { cookie, method: "POST", body: {
    name: "Completion settings", data: { customCommands: commands, projectType: "latex", project: { nodes: [
      { type: "file", id: "main", path: "main.tex", name: "main.tex", content: "\\documentclass{article}" },
    ] } },
  } });
  const invalid = await create({ tex: ["\\invalid{argument}"] });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).errorCode, "CUSTOM_COMMANDS_INVALID");
  const createdResponse = await create({ tex: ["myMacro", "\\myMacro"], ly: ["my-music"] });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const projectId = created.project.id;
  const expected = { tex: ["\\myMacro"], ly: ["\\my-music"] };
  assert.deepEqual(created.data.customCommands, expected);
  await f.pool.query("INSERT INTO project_members (project_id, user_id, role, invited_by) VALUES ($1, $2, 'viewer', $3)", [projectId, viewer.id, owner.id]);
  const shared = await (await f.request(`/api/projects/${projectId}`, { cookie: f.cookieFor(viewer) })).json();
  assert.deepEqual(shared.customCommands, expected);
  const changed = { ...created.data, customCommands: { tex: ["\\secondMacro"], ly: [] } };
  const saved = await f.request(`/api/projects/${projectId}`, { cookie, method: "PUT", body: { baseRevision: 0, data: changed } });
  assert.equal(saved.status, 200);
  const latest = await (await f.request(`/api/projects/${projectId}`, { cookie })).json();
  assert.deepEqual(latest.customCommands, changed.customCommands);
  const rejected = await f.request(`/api/projects/${projectId}`, { cookie, method: "PUT", body: {
    baseRevision: latest.revision, data: { ...latest, customCommands: { ly: ["not a command"] } },
  } });
  assert.equal(rejected.status, 400);
  const after = await (await f.request(`/api/projects/${projectId}`, { cookie })).json();
  assert.equal(after.revision, latest.revision);
  assert.deepEqual(after.customCommands, changed.customCommands);
  const denied = await f.request(`/api/projects/${projectId}`, { cookie: f.cookieFor(viewer), method: "PUT", body: {
    baseRevision: latest.revision, data: changed,
  } });
  assert.equal(denied.status, 403);
  const archive = await f.request(`/api/projects/${projectId}/archive`, { cookie });
  assert.equal(archive.status, 200);
  const archiveBytes = Buffer.from(await archive.arrayBuffer());
  const zip = extractZip(archiveBytes);
  const manifest = JSON.parse(zip.files.get(".iris/project.json").toString());
  assert.deepEqual(manifest.customCommands, changed.customCommands);
  const imported = await fetch(`${f.baseUrl}/api/projects/import?filename=completion.zip`, {
    method: "POST", headers: { cookie, "content-type": "application/zip" },
    body: archiveBytes, signal: AbortSignal.timeout(10000),
  });
  assert.equal(imported.status, 201);
  assert.deepEqual((await imported.json()).data.customCommands, changed.customCommands);
});
