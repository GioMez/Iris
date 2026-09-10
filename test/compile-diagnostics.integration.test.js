const test = require("node:test");
const assert = require("node:assert/strict");
const { serverFixture } = require("./helpers/server-fixture.cjs");
const { uuidv7 } = require("../src/ids");

for (const [projectType, extension, include] of [["latex", "tex", "chapters/intro.tex"], ["lilypond", "ly", "parts/voice.ily"]]) {
  test(`${projectType} diagnostics and included-source provenance survive build storage and retrieval`, {
    skip: !process.env.TEST_DATABASE_URL, timeout: 20000,
  }, async (t) => {
    const f = await serverFixture(t);
    const user = (await f.pool.query(
      "INSERT INTO users (id, username, email, display_name) VALUES ($1, 'diagnostics', 'diagnostics@example.test', 'Diagnostics') RETURNING *",
      [uuidv7()]
    )).rows[0];
    const cookie = f.cookieFor(user);
    const createdResponse = await f.request("/api/projects", { cookie, method: "POST", body: {
      name: "Diagnostic source references", data: { projectType, project: { nodes: [
        { type: "file", id: "main", name: `main.${extension}`, path: `main.${extension}`, content: "main source" },
        { type: "file", id: "part", name: include.split("/").pop(), path: include, content: "first\nbroken\nlast" },
      ] } },
    } });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    f.hooks.spawn = () => ({ command: process.execPath, args: ["-e", `
      console.error(${JSON.stringify(include + ":2:1: error: bad command")});
      console.error(${JSON.stringify(include + ":3:1: warning: unresolved reference")});
      process.exitCode = 1;
    `] });
    const response = await f.request(`/api/projects/${created.project.id}/compile`, { cookie, method: "POST", body: {
      baseRevision: 0, data: created.data,
    } });
    assert.equal(response.status, 200);
    const compiled = await response.json();
    assert.equal(compiled.success, false);
    assert.equal(compiled.errors.length, 1);
    assert.equal(compiled.warnings.length, 1);
    const diagnostic = compiled.diagnostics[0];
    assert.equal(diagnostic.file, include);
    assert.equal(diagnostic.line, 2);
    assert.ok(diagnostic.sourceFileId);
    assert.ok(diagnostic.sourceRevisionId);
    const detail = await (await f.request(`/api/projects/${created.project.id}/builds/${compiled.buildId}`, { cookie })).json();
    assert.equal(detail.build.diagnostics.length, 2);
    for (const item of compiled.diagnostics) {
      assert.deepEqual(detail.build.diagnostics.find((d) => d.severity === item.severity), item);
    }
    assert.deepEqual(detail.build.errors, ["bad command"]);
    assert.deepEqual(detail.build.warnings, ["unresolved reference"]);
    const revision = await (await f.request(`/api/projects/${created.project.id}/files/${diagnostic.sourceFileId}/versions/${diagnostic.sourceRevisionId}`, { cookie })).json();
    assert.equal(revision.content, "first\nbroken\nlast");
  });
}
