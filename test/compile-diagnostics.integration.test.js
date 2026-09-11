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

async function multipassProject(t, env) {
  const f = await serverFixture(t, env);
  const user = (await f.pool.query(
    "INSERT INTO users (id, username, email, display_name) VALUES ($1, 'multipass', 'multipass@example.test', 'Multipass') RETURNING *", [uuidv7()]
  )).rows[0];
  const cookie = f.cookieFor(user);
  const response = await f.request("/api/projects", { cookie, method: "POST", body: {
    name: "Multipass diagnostics", data: { projectType: "latex", project: { nodes: [
      { type: "file", id: "main", name: "main.tex", path: "main.tex", content: "\\documentclass{article}\n\\input{chapters/intro}" },
      { type: "file", id: "part", name: "intro.tex", path: "chapters/intro.tex", content: "first\n\\cite{missing}\nlast" },
      { type: "file", id: "refs", name: "refs.bib", path: "refs.bib", content: "@book{missing,title={A key may exist but remain unresolved}}" },
    ] } },
  } });
  assert.equal(response.status, 201);
  const created = await response.json();
  return { ...f, cookie, created, url: `/api/projects/${created.project.id}` };
}

for (const mode of ["bibtex", "biber"]) {
  for (const unresolved of [false, true]) {
    test(`${mode} POST compile -> GET build retains trace and ${unresolved ? "only final included-source provenance" : "authoritative empty arrays"}`, {
      skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
    }, async (t) => {
      const f = await multipassProject(t);
      let pass = 0;
      f.hooks.spawn = (command) => {
        const tex = command === "pdflatex";
        if (tex) pass++;
        const log = !tex ? "Bibliography processed" : pass < 3
          ? "(./main.tex\nLaTeX Warning: Citation 'resolved' undefined on input line 1.\n)"
          : unresolved ? "(./main.tex\n(./chapters/intro.tex\nLaTeX Warning: Citation 'missing' undefined on input line 2.\nPackage hyperref Warning: Token not allowed on input line 3.\n)\n)" : "Output written on main.pdf";
        return { command: process.execPath, args: ["-e", `
          require("node:fs").writeFileSync("output/main.pdf", "%PDF-1.4 fake");
          console.log(${JSON.stringify(log)});
        `] };
      };
      const response = await f.request(`${f.url}/compile`, { cookie: f.cookie, method: "POST", body: {
        baseRevision: 0, data: f.created.data, compileProfile: { mode },
      } });
      assert.equal(response.status, 200);
      const compiled = await response.json();
      assert.equal(compiled.success, true);
      assert.equal(pass, 3);
      assert.match(compiled.log, /Citation 'resolved'/);
      assert.deepEqual(compiled.errors, []);
      assert.equal(compiled.diagnostics.length, unresolved ? 2 : 0);
      assert.equal(compiled.warnings.length, unresolved ? 2 : 0);
      const detailResponse = await f.request(`${f.url}/builds/${compiled.buildId}`, { cookie: f.cookie });
      assert.equal(detailResponse.status, 200);
      const { build } = await detailResponse.json();
      assert.equal(build.log, compiled.log);
      assert.deepEqual(build.diagnostics, compiled.diagnostics);
      assert.deepEqual(build.warnings, compiled.warnings);
      assert.deepEqual(build.errors, []);
      const stored = (await f.pool.query("SELECT diagnostics_version, warnings, errors FROM build_outputs WHERE id = $1", [compiled.buildId])).rows[0];
      assert.equal(stored.diagnostics_version, 1);
      assert.ok(Array.isArray(stored.warnings) && Array.isArray(stored.errors));
      if (unresolved) {
        assert.deepEqual(build.diagnostics.map((d) => [d.file, d.line]), [["chapters/intro.tex", 2], ["chapters/intro.tex", 3]]);
        assert.ok(build.warnings.every((message) => !message.includes("'resolved'")));
        for (const item of build.diagnostics) {
          assert.ok(item.sourceFileId && item.sourceRevisionId);
          assert.notEqual(item.sourceRevisionId, compiled.sourceRevisionId);
          const revision = await (await f.request(`${f.url}/files/${item.sourceFileId}/versions/${item.sourceRevisionId}`, { cookie: f.cookie })).json();
          assert.equal(revision.content, "first\n\\cite{missing}\nlast");
        }
      } else {
        // Concrete pre-version rows still recover from trace, without backfilling them.
        await f.pool.query("UPDATE build_outputs SET diagnostics_version = NULL WHERE id = $1", [compiled.buildId]);
        const legacy = await (await f.request(`${f.url}/builds/${compiled.buildId}`, { cookie: f.cookie })).json();
        assert.equal(legacy.build.warnings.length, 1);
        assert.equal(legacy.build.diagnostics[0].file, "main.tex");
        await f.pool.query("UPDATE build_outputs SET errors = $2::jsonb WHERE id = $1", [compiled.buildId, JSON.stringify(["publication failed"])]);
        const legacyError = await (await f.request(`${f.url}/builds/${compiled.buildId}`, { cookie: f.cookie })).json();
        assert.deepEqual(legacyError.build.errors, ["publication failed"]);
      }
    });
  }
}

for (const phase of ["setup", "publication"]) {
  test(`${phase} failure persists an active error even with explicit empty pipeline diagnostics`, {
    skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
  }, async (t) => {
    const f = await multipassProject(t);
    if (phase === "setup") f.hooks.beforeMkdir = (dir) => {
      if (String(dir).endsWith("texmf-var")) throw new Error("fixture setup failure");
    };
    else f.hooks.beforeClientQuery = (sql) => {
      if (sql.includes("INSERT INTO build_artifacts")) throw new Error("fixture publication failure");
    };
    f.hooks.spawn = () => ({ command: process.execPath, args: ["-e", 'require("node:fs").writeFileSync("output/main.pdf", "%PDF-1.4 fake")'] });
    const response = await f.request(`${f.url}/compile`, { cookie: f.cookie, method: "POST", body: { baseRevision: 0, data: f.created.data } });
    assert.equal(response.status, 500);
    const row = (await f.pool.query("SELECT id, diagnostics_version FROM build_outputs")).rows[0];
    const { build } = await (await f.request(`${f.url}/builds/${row.id}`, { cookie: f.cookie })).json();
    assert.equal(build.status, "failed");
    assert.equal(build.errors.length, 1);
    assert.match(build.errors[0], new RegExp(`fixture ${phase} failure`));
    assert.equal(build.diagnostics[0].file, null);
    assert.equal(build.diagnostics[0].line, null);
    assert.equal(row.diagnostics_version, 1);
  });
}

for (const phase of ["artifact read", "publication finalization"]) {
  test(`saturated diagnostics retain the terminal ${phase} cause through POST compile -> GET build`, {
    skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
  }, async (t) => {
    const f = await multipassProject(t, { COMPILE_LOG_LIMIT: "16384" });
    if (phase === "artifact read") f.hooks.beforeReadFile = (file) => {
      if (String(file).endsWith("/output/main.pdf")) throw new Error("fixture artifact read failure");
    };
    else f.hooks.beforeClientQuery = (sql) => {
      if (!sql.includes("UPDATE build_outputs SET")) return;
      delete f.hooks.beforeClientQuery;
      throw new Error("fixture publication finalization failure");
    };
    f.hooks.spawn = () => ({ command: process.execPath, args: ["-e", `
      require("node:fs").writeFileSync("output/main.pdf", "%PDF-1.4 fake");
      for (let i = 0; i < 80; i++) console.log("chapters/intro.tex:2: error: compiler failure " + i);
      console.log("chapters/intro.tex:3: warning: final included warning");
      console.log("x".repeat(32768));
      process.exitCode = 1;
    `] });
    const response = await f.request(`${f.url}/compile`, { cookie: f.cookie, method: "POST", body: {
      baseRevision: 0, data: f.created.data,
    } });
    assert.equal(response.status, 500);
    const row = (await f.pool.query("SELECT id, diagnostics_version, errors FROM build_outputs")).rows[0];
    const detail = await f.request(`${f.url}/builds/${row.id}`, { cookie: f.cookie });
    assert.equal(detail.status, 200);
    const { build } = await detail.json();
    assert.equal(build.status, "failed");
    assert.equal(build.exitCode, 1);
    assert.equal(build.log.length, 16384);
    assert.match(build.log, /compiler failure 79/);
    assert.doesNotMatch(build.log, /fixture .* failure/);
    assert.match(build.errors[0], new RegExp(`fixture ${phase} failure`));
    assert.equal(build.errors.length, 80);
    assert.equal(build.errors.filter((message) => message.startsWith("compiler failure ")).length, 79);
    assert.equal(row.diagnostics_version, 1);
    assert.deepEqual(row.errors.map((item) => item.message), build.errors);
    assert.deepEqual(build.diagnostics.find((item) => item.severity === "error"), {
      severity: "error", file: null, line: null, column: null, message: build.errors[0],
    });
    assert.deepEqual(build.warnings, ["final included warning"]);
    const warning = build.diagnostics.find((item) => item.severity === "warning");
    assert.equal(warning.file, "chapters/intro.tex");
    assert.equal(warning.line, 3);
    assert.ok(warning.sourceFileId && warning.sourceRevisionId);
    const revision = await (await f.request(`${f.url}/files/${warning.sourceFileId}/versions/${warning.sourceRevisionId}`, { cookie: f.cookie })).json();
    assert.equal(revision.content, "first\n\\cite{missing}\nlast");
  });
}

test("actual timeout with truncated capture cannot clear a previous complete pass", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
}, async (t) => {
  const f = await serverFixture(t, { COMPILE_TIMEOUT_MS: "500", COMPILE_LOG_LIMIT: "1024" });
  let pass = 0;
  f.hooks.spawn = () => ({ command: process.execPath, args: ["-e", ++pass === 1
    ? 'console.log("warning: previous")'
    : 'console.log("warning: observed\\n" + "x".repeat(4096)); setInterval(() => {}, 1000)'] });
  const result = await f.app.runCompilePipeline({
    profile: f.app.normalizeCompileProfile({ mode: "custom", steps: [
      { tool: "pdflatex", args: ["main.tex"] }, { tool: "pdflatex", args: ["main.tex"] }, { tool: "pdflatex", args: ["main.tex"] },
    ] }, "pdflatex", "main.tex"), cwd: f.dataDir, binPath: "", fontDir: "", texmfVar: "", preLog: "",
  });
  assert.equal(result.timedOut, true);
  assert.equal(pass, 2);
  assert.deepEqual(result.warnings, ["warning: previous", "warning: observed"]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /pdflatex.*timeout/i);
  assert.equal(result.diagnostics.at(-1).line, null);
  assert.doesNotMatch(result.log, /Iris step 3/);
});

test("capture marks an oversized command header as truncated even when the tool is silent", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 30000,
}, async (t) => {
  const f = await serverFixture(t, { COMPILE_LOG_LIMIT: "1024" });
  f.hooks.spawn = () => ({ command: process.execPath, args: ["-e", ""] });
  const result = await f.app.runCompileStep({
    step: { tool: "pdflatex", args: ["x".repeat(2048)] }, cwd: f.dataDir, binPath: "", fontDir: "", texmfVar: "",
  });
  assert.equal(result.code, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.log.length, 1024);
});
