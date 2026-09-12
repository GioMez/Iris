const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("public/Iris.html");
const projects = read("public/iris-projects.js");
const app = read("public/iris-app.js");
const server = read("src/server.js");

test("owners get an accessible in-project sharing console", () => {
  assert.match(html, /id="btnShareProject"[^>]*hidden/);
  assert.match(html, /id="projectShareModal"[\s\S]*?role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="projectShareSearch"[^>]*type="search"/);
  assert.match(html, /id="projectShareResults"/);
  assert.match(html, /id="projectShareRole"[\s\S]*?value="owner"[\s\S]*?value="editor"[\s\S]*?value="viewer"/);
  assert.match(projects, /button\.hidden = !currentId \|\| role !== "owner"/);
});

test("the sharing console uses project-scoped member APIs and immutable user ids", () => {
  assert.match(projects, /\/api\/projects\/\$\{currentId\}\/members\/search\?\$\{params\}/);
  assert.match(projects, /JSON\.stringify\(\{ userId: selected\.userId, role:/);
  assert.match(projects, /method: "PATCH"/);
  assert.match(projects, /method: "DELETE"/);
  assert.match(projects, /const lastOwner = member\.role === "owner" && ownerCount === 1/);
});

test("member search is owner-authorized and returns only eligible accounts", () => {
  assert.match(server, /searchProjectMembers[\s\S]*?authorizeProject\(projectId, user, "share"\)/);
  assert.match(server, /u\.status = 'active'/);
  assert.match(server, /NOT EXISTS \([\s\S]*?project_members/);
  assert.match(server, /LIMIT 20/);
  // Add-target eligibility after lock waits is exercised through HTTP/PostgreSQL
  // in project-sharing-auth.test.js.
});

test("the project role reaches the workspace controls", () => {
  // Database authority is exercised through GET in project-mutations.test.js.
  assert.match(projects, /data\.role = data\.role \|\| \(m && m\.role\)/);
  assert.match(app, /setRole\(role\)[\s\S]*?applyRoleGate\(\)/);
});
