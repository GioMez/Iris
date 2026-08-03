const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { discoverProjectTemplates, readProjectTemplate } = require("../src/project-templates");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/Iris.html"), "utf8");
const projects = fs.readFileSync(path.join(root, "public/iris-projects.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
const templateDir = path.join(root, "public/templates");
const catalogPromise = discoverProjectTemplates(templateDir);

const blankNodesSource = projects.slice(
  projects.indexOf("let projectTemplates"),
  projects.indexOf("/* ---------------- helpers", projects.indexOf("function blankNodes("))
);

async function createBlankNodes(projectType, templateId) {
  const messages = {
    "templates.newScore": "New score",
    "templates.newDocument": "New document",
    "templates.introduction": "Introduction",
    "templates.recipient": "Recipient\\\\Address",
    "templates.letterOpening": "Dear Sir or Madam,",
    "templates.letterBody": "Write your letter here.",
    "templates.letterClosing": "Sincerely,",
  };
  const context = {
    projectType,
    templateId,
    catalog: await catalogPromise,
    result: null,
    t: (key) => messages[key] || key,
    fetch: async (url) => {
      const match = url.match(/^\/api\/project-templates\/(latex|lilypond)\/(.+)$/);
      if (!match) return { ok: false, text: async () => "" };
      try {
        const content = await readProjectTemplate(templateDir, match[1], decodeURIComponent(match[2]));
        return { ok: true, text: async () => content };
      } catch {
        return { ok: false, text: async () => "" };
      }
    },
  };
  vm.runInNewContext(
    `${blankNodesSource}\nprojectTemplates = catalog; result = blankNodes("Project title", projectType, templateId);`,
    context
  );
  return context.result;
}

test("the new-project dialog populates one template selector for both project types", () => {
  const field = html.slice(html.indexOf('id="projTemplateField"'), html.indexOf("</select>", html.indexOf('id="projTemplateField"')));
  assert.match(field, /id="projTemplateSelect"/);
  assert.deepEqual([...field.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]), [""]);
  assert.match(projects, /api\("\/api\/project-templates"\)/);
  assert.match(projects, /projectTemplates\[projectType\]/);
  assert.match(projects, /option\.textContent = projectTemplateLabel/);
  assert.match(projects, /return template\.label \|\| template\.title \|\| template\.id/);
  assert.doesNotMatch(projects, /BUILTIN_TEMPLATE_KEYS/);
  assert.match(projects, /\$\("projTemplateField"\)\.style\.display = ""/);
  assert.doesNotMatch(projects, /LATEX_TEMPLATES/);
  assert.match(projects, /fetch\(template\.url, \{ credentials: "same-origin", cache: "no-cache" \}\)/);
  assert.doesNotMatch(projects, /\\documentclass|\\version "2\.24\.0"/);
  assert.match(server, /"\/api\/project-templates"\) return listProjectTemplates/);
  assert.match(server, /pathname\.startsWith\("\/templates\/"\)\) return text\(res, 404/);
  assert.match(server, /"\.tex": "text\/plain; charset=utf-8"/);
  assert.match(server, /"\.ly": "text\/plain; charset=utf-8"/);
});

test("each LaTeX choice loads a matching minimal main.tex file", async () => {
  const expectedClasses = ["article", "beamer", "book", "report", "letter"];
  for (const template of expectedClasses) {
    const nodes = await createBlankNodes("latex", template);
    assert.equal(nodes[0].path, "main.tex");
    assert.match(nodes[0].content, new RegExp(`^\\\\documentclass(?:\\[11pt\\])?\\{${template}\\}`));
    assert.doesNotMatch(nodes[0].content, /@@[A-Z_]+@@/);
  }

  assert.match((await createBlankNodes("latex", "article"))[0].content, /\\section\{Introduction\}/);
  assert.match((await createBlankNodes("latex", "book"))[0].content, /\\chapter\{Introduction\}/);
  assert.match((await createBlankNodes("latex", "report"))[0].content, /\\chapter\{Introduction\}/);
  assert.match((await createBlankNodes("latex", "beamer"))[0].content, /\\begin\{frame\}\{Introduction\}/);
  assert.match((await createBlankNodes("latex", "letter"))[0].content, /\\begin\{letter\}\{Recipient\\\\Address\}/);
});

test("unknown selections fall back to each type's configured default", async () => {
  assert.match((await createBlankNodes("latex", "unknown"))[0].content, /^\\documentclass\[11pt\]\{article\}/);
  const lilypond = await createBlankNodes("lilypond", "unknown");
  assert.equal(lilypond.length, 1);
  assert.equal(lilypond[0].path, "main.ly");
  assert.match(lilypond[0].content, /^\\version "2\.24\.0"/);
});

test("admin template routes stay behind server-role authorization", () => {
  const adminHandler = server.slice(server.indexOf("async function handleAdminApi"), server.indexOf("async function handleApi"));
  assert.ok(adminHandler.indexOf("requireAdmin(actor)") < adminHandler.indexOf("ADMIN_TEMPLATES_ROUTE"));
  assert.doesNotMatch(server.slice(server.indexOf("async function handleApi")), /POST[^\n]*\/api\/project-templates/);
});
