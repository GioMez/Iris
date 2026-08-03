const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  MAX_PROJECT_TEMPLATE_BYTES,
  discoverProjectTemplates,
  readProjectTemplate,
} = require("../src/project-templates");

test("the bundled LaTeX and LilyPond templates are discovered with their conventional defaults", async () => {
  const publicDir = path.resolve(__dirname, "../public");
  const templates = await discoverProjectTemplates(publicDir);
  assert.deepEqual(templates.latex.map((template) => template.id), ["article", "beamer", "book", "letter", "report"]);
  assert.equal(templates.latex.find((template) => template.default).id, "article");
  assert.deepEqual(templates.lilypond.map((template) => template.id), ["default"]);
  assert.equal(templates.lilypond[0].default, true);
});

test("instance administrators can add arbitrary templates without changing application code", async (t) => {
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-template-catalog-"));
  t.after(() => fs.rm(publicDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(publicDir, "templates/latex"), { recursive: true });
  await fs.mkdir(path.join(publicDir, "templates/lilypond"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(publicDir, "templates/latex/conference-poster.tex"), "poster"),
    fs.writeFile(path.join(publicDir, "templates/latex/.hidden.tex"), "hidden"),
    fs.writeFile(path.join(publicDir, "templates/latex/notes.txt"), "wrong extension"),
    fs.writeFile(path.join(publicDir, "templates/lilypond/chamber orchestra.ly"), "score"),
  ]);

  const templates = await discoverProjectTemplates(publicDir);
  assert.deepEqual(templates.latex, [{
    id: "conference-poster",
    label: "Conference poster",
    url: "/api/project-templates/latex/conference-poster.tex",
    default: true,
  }]);
  assert.deepEqual(templates.lilypond, [{
    id: "chamber orchestra",
    label: "Chamber orchestra",
    url: "/api/project-templates/lilypond/chamber%20orchestra.ly",
    default: true,
  }]);
});

test("template reads reject traversal, symlinks, oversized files, invalid UTF-8, and NUL bytes", async (t) => {
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-template-security-"));
  const latexDir = path.join(publicDir, "templates/latex");
  const outside = path.join(publicDir, "secret.tex");
  t.after(() => fs.rm(publicDir, { recursive: true, force: true }));
  await fs.mkdir(latexDir, { recursive: true });
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(latexDir, "linked.tex"));
  await fs.writeFile(path.join(latexDir, "huge.tex"), Buffer.alloc(MAX_PROJECT_TEMPLATE_BYTES + 1, 0x61));
  await fs.writeFile(path.join(latexDir, "invalid.tex"), Buffer.from([0xc3, 0x28]));
  await fs.writeFile(path.join(latexDir, "nul.tex"), "before\0after");

  const templates = await discoverProjectTemplates(publicDir);
  assert.deepEqual(templates.latex.map((template) => template.id), ["invalid", "nul"]);
  await assert.rejects(readProjectTemplate(publicDir, "latex", "../secret.tex"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND", status: 404 });
  await assert.rejects(readProjectTemplate(publicDir, "latex", "linked.tex"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND", status: 404 });
  await assert.rejects(readProjectTemplate(publicDir, "latex", "huge.tex"), { errorCode: "PROJECT_TEMPLATE_TOO_LARGE", status: 413 });
  await assert.rejects(readProjectTemplate(publicDir, "latex", "invalid.tex"), { errorCode: "PROJECT_TEMPLATE_INVALID", status: 422 });
  await assert.rejects(readProjectTemplate(publicDir, "latex", "nul.tex"), { errorCode: "PROJECT_TEMPLATE_INVALID", status: 422 });
});

test("markup-like template names and contents remain inert text", async (t) => {
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-template-markup-"));
  const latexDir = path.join(publicDir, "templates/latex");
  const fileName = '"><img src=x onerror=alert(1)>.tex';
  const content = "</textarea><script>alert('template')</script>";
  t.after(() => fs.rm(publicDir, { recursive: true, force: true }));
  await fs.mkdir(latexDir, { recursive: true });
  await fs.writeFile(path.join(latexDir, fileName), content);

  const templates = await discoverProjectTemplates(publicDir);
  assert.equal(templates.latex[0].id, '"><img src=x onerror=alert(1)>');
  assert.match(templates.latex[0].url, /^\/api\/project-templates\/latex\//);
  assert.equal(await readProjectTemplate(publicDir, "latex", fileName), content);
});
