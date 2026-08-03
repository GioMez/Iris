const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/Iris.html"), "utf8");
const projects = fs.readFileSync(path.join(root, "public/iris-projects.js"), "utf8");

const blankNodesSource = projects.slice(
  projects.indexOf("function blankNodes("),
  projects.indexOf("/* ---------------- helpers", projects.indexOf("function blankNodes("))
);

function createBlankNodes(projectType, latexTemplate) {
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
    latexTemplate,
    result: null,
    t: (key) => messages[key] || key,
  };
  vm.runInNewContext(
    `${blankNodesSource}\nresult = blankNodes("Project title", projectType, latexTemplate);`,
    context
  );
  return context.result;
}

test("new LaTeX projects offer article as the default and four additional templates", () => {
  const field = html.slice(html.indexOf('id="projTemplateField"'), html.indexOf("</select>", html.indexOf('id="projTemplateField"')));
  assert.match(field, /id="projTemplateSelect"/);
  assert.deepEqual(
    [...field.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
    ["article", "beamer", "book", "report", "letter"]
  );
  assert.match(projects, /\$\("projTemplateSelect"\)\.value = "article"/);
  assert.match(projects, /\$\("projTemplateField"\)\.style\.display = isLatex \? "" : "none"/);
});

test("each LaTeX choice creates a matching minimal main.tex", () => {
  const expectedClasses = ["article", "beamer", "book", "report", "letter"];
  expectedClasses.forEach((template) => {
    const nodes = createBlankNodes("latex", template);
    assert.equal(nodes[0].path, "main.tex");
    assert.match(nodes[0].content, new RegExp(`^\\\\documentclass(?:\\[11pt\\])?\\{${template}\\}`));
  });

  assert.match(createBlankNodes("latex", "article")[0].content, /\\section\{Introduction\}/);
  assert.match(createBlankNodes("latex", "book")[0].content, /\\chapter\{Introduction\}/);
  assert.match(createBlankNodes("latex", "report")[0].content, /\\chapter\{Introduction\}/);
  assert.match(createBlankNodes("latex", "beamer")[0].content, /\\begin\{frame\}\{Introduction\}/);
  assert.match(createBlankNodes("latex", "letter")[0].content, /\\begin\{letter\}\{Recipient\\\\Address\}/);
});

test("unknown LaTeX templates fall back to article and LilyPond remains unchanged", () => {
  assert.match(createBlankNodes("latex", "unknown")[0].content, /^\\documentclass\[11pt\]\{article\}/);
  const lilypond = createBlankNodes("lilypond", "book");
  assert.equal(lilypond.length, 1);
  assert.equal(lilypond[0].path, "main.ly");
  assert.match(lilypond[0].content, /^\\version "2\.24\.0"/);
});
