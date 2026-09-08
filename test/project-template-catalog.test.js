const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  MANIFEST_FILE,
  MAX_PROJECT_TEMPLATE_BYTES,
  initializeProjectTemplates,
  discoverProjectTemplates,
  listAdminProjectTemplates,
  readProjectTemplate,
  getAdminProjectTemplate,
  createProjectTemplate,
  updateProjectTemplate,
  deleteProjectTemplate,
  validateProjectTemplate,
} = require("../src/project-templates");

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function input(overrides = {}) {
  return {
    id: "custom",
    title: "Custom template",
    description: "A project template",
    type: "latex",
    default: false,
    content: "template content",
    ...overrides,
  };
}

test("the bundled LaTeX and LilyPond templates are discovered from a direct template root", async () => {
  const templateDir = path.resolve(__dirname, "../public/templates");
  const templates = await discoverProjectTemplates(templateDir);
  assert.deepEqual(templates.latex.map((template) => template.id), ["article", "beamer", "book", "letter", "report"]);
  assert.equal(templates.latex.find((template) => template.default).id, "article");
  assert.deepEqual(templates.lilypond.map((template) => template.id), ["default"]);
  assert.equal(templates.lilypond[0].default, true);
  assert.equal(templates.latex[0].type, "latex");
  assert.equal(templates.latex[0].title, "Article");
  assert.ok(templates.latex[0].size > 0);
});

test("manually dropped files are discovered with filename-derived metadata", async (t) => {
  const templateDir = await temporaryDirectory(t, "iris-template-catalog-");
  await fs.mkdir(path.join(templateDir, "latex"), { recursive: true });
  await fs.mkdir(path.join(templateDir, "lilypond"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(templateDir, "latex/conference-poster.tex"), "poster"),
    fs.writeFile(path.join(templateDir, "latex/.hidden.tex"), "hidden"),
    fs.writeFile(path.join(templateDir, "latex/notes.txt"), "wrong extension"),
    fs.writeFile(path.join(templateDir, "lilypond/chamber orchestra.ly"), "score"),
  ]);

  const templates = await discoverProjectTemplates(templateDir);
  assert.deepEqual(templates.latex, [{
    id: "conference-poster",
    title: "Conference poster",
    description: "",
    type: "latex",
    default: true,
    size: 6,
    label: "Conference poster",
    url: "/api/project-templates/latex/conference-poster.tex",
  }]);
  assert.equal(templates.lilypond[0].id, "chamber orchestra");
  assert.equal(templates.lilypond[0].url, "/api/project-templates/lilypond/chamber%20orchestra.ly");
});

test("template reads reject traversal, symlinks, oversized files, invalid UTF-8, and NUL bytes", async (t) => {
  const templateDir = await temporaryDirectory(t, "iris-template-security-");
  const latexDir = path.join(templateDir, "latex");
  const outside = path.join(templateDir, "secret.tex");
  await fs.mkdir(latexDir, { recursive: true });
  await fs.mkdir(path.join(templateDir, "lilypond"), { recursive: true });
  await fs.writeFile(outside, "secret");
  await fs.symlink(outside, path.join(latexDir, "linked.tex"));
  await fs.writeFile(path.join(latexDir, "huge.tex"), Buffer.alloc(MAX_PROJECT_TEMPLATE_BYTES + 1, 0x61));
  await fs.writeFile(path.join(latexDir, "invalid.tex"), Buffer.from([0xc3, 0x28]));
  await fs.writeFile(path.join(latexDir, "nul.tex"), "before\0after");

  const templates = await discoverProjectTemplates(templateDir);
  assert.deepEqual(templates.latex.map((template) => template.id), ["invalid"]);
  await assert.rejects(readProjectTemplate(templateDir, "latex", "../secret.tex"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND", status: 404 });
  await assert.rejects(readProjectTemplate(templateDir, "latex", "linked.tex"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND", status: 404 });
  await assert.rejects(readProjectTemplate(templateDir, "latex", "huge.tex"), { errorCode: "PROJECT_TEMPLATE_TOO_LARGE", status: 413 });
  await assert.rejects(readProjectTemplate(templateDir, "latex", "invalid.tex"), { errorCode: "PROJECT_TEMPLATE_INVALID", status: 422 });
  await assert.rejects(readProjectTemplate(templateDir, "latex", "nul.tex"), { errorCode: "PROJECT_TEMPLATE_INVALID", status: 422 });
  await assert.rejects(readProjectTemplate(templateDir, "unknown", "file.tex"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND", status: 404 });

  await assert.rejects(deleteProjectTemplate(templateDir, "latex", "linked"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND", status: 404 });
  assert.equal(await fs.readFile(outside, "utf8"), "secret");
  assert.equal((await fs.lstat(path.join(latexDir, "linked.tex"))).isSymbolicLink(), true);
});

test("invalid manual IDs are ignored and markup-like metadata remains inert text", async (t) => {
  const templateDir = await temporaryDirectory(t, "iris-template-markup-");
  const latexDir = path.join(templateDir, "latex");
  const fileName = '\"><img src=x onerror=alert(1)>.tex';
  const content = "</textarea><script>alert('template')</script>";
  await fs.mkdir(latexDir, { recursive: true });
  await fs.mkdir(path.join(templateDir, "lilypond"), { recursive: true });
  await fs.writeFile(path.join(latexDir, fileName), content);

  let templates = await discoverProjectTemplates(templateDir);
  assert.deepEqual(templates.latex, []);
  assert.equal(await readProjectTemplate(templateDir, "latex", fileName), content);

  await createProjectTemplate(templateDir, input({
    id: "markup",
    title: '\"><img src=x onerror=alert(1)>',
    description: "<script>description</script>",
    content,
  }));
  templates = await discoverProjectTemplates(templateDir);
  assert.equal(templates.latex[0].title, '\"><img src=x onerror=alert(1)>');
  assert.equal(await readProjectTemplate(templateDir, "latex", "markup.tex"), content);
});

test("admin storage CRUD supports metadata, rename, type move, defaults, and delete", async (t) => {
  const dataDir = await temporaryDirectory(t, "iris-template-crud-");
  const templateDir = path.join(dataDir, "templates");
  await initializeProjectTemplates(templateDir);

  const article = await createProjectTemplate(templateDir, input({
    id: "article",
    title: "Starter article",
    description: "The conventional fallback",
    content: "article body",
  }));
  assert.equal(article.default, true);
  assert.equal(article.size, Buffer.byteLength("article body"));

  const created = await createProjectTemplate(templateDir, input({
    id: "Résumé score",
    title: "Résumé score",
    default: true,
    content: "first body",
  }));
  assert.deepEqual(created, {
    id: "Résumé score",
    title: "Résumé score",
    description: "A project template",
    type: "latex",
    default: true,
    size: 10,
    content: "first body",
  });
  assert.equal((await listAdminProjectTemplates(templateDir)).latex.find((template) => template.id === "article").default, false);

  await createProjectTemplate(templateDir, input({
    id: "fallback",
    title: "Fallback score",
    type: "lilypond",
    content: "fallback score",
  }));

  const moved = await updateProjectTemplate(templateDir, "latex", "Résumé score", input({
    id: "Orchestral score",
    title: "Orchestral score",
    description: "Moved into LilyPond",
    type: "lilypond",
    default: true,
    content: "new score",
  }));
  assert.equal(moved.type, "lilypond");
  assert.equal(moved.id, "Orchestral score");
  assert.equal(moved.default, true);
  assert.equal(moved.content, "new score");
  await assert.rejects(getAdminProjectTemplate(templateDir, "latex", "Résumé score"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND" });
  assert.equal((await listAdminProjectTemplates(templateDir)).latex[0].default, true);
  assert.equal((await listAdminProjectTemplates(templateDir)).lilypond.find((template) => template.id === "fallback").default, false);

  assert.deepEqual(await deleteProjectTemplate(templateDir, "lilypond", "Orchestral score"), { ok: true });
  assert.equal((await listAdminProjectTemplates(templateDir)).lilypond.find((template) => template.id === "fallback").default, true);
  await assert.rejects(getAdminProjectTemplate(templateDir, "lilypond", "Orchestral score"), { errorCode: "PROJECT_TEMPLATE_NOT_FOUND" });
});

test("admin mutations reject case-insensitive collisions", async (t) => {
  const templateDir = path.join(await temporaryDirectory(t, "iris-template-collision-"), "templates");
  await initializeProjectTemplates(templateDir);
  await createProjectTemplate(templateDir, input({ id: "Résumé", title: "First" }));
  await assert.rejects(
    createProjectTemplate(templateDir, input({ id: "résumé", title: "Duplicate" })),
    { errorCode: "ADMIN_TEMPLATE_EXISTS", status: 409 }
  );
  await createProjectTemplate(templateDir, input({ id: "Other", title: "Other" }));
  await assert.rejects(
    updateProjectTemplate(templateDir, "latex", "Other", input({ id: "RÉSUMÉ", title: "Collision" })),
    { errorCode: "ADMIN_TEMPLATE_EXISTS", status: 409 }
  );

  const concurrent = await Promise.allSettled([
    createProjectTemplate(templateDir, input({ id: "Race", title: "Race one" })),
    createProjectTemplate(templateDir, input({ id: "race", title: "Race two" })),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.find((result) => result.status === "rejected").reason.errorCode, "ADMIN_TEMPLATE_EXISTS");
});

test("admin template input validation returns the contracted errors", () => {
  const cases = [
    [input({ type: "html" }), "ADMIN_TEMPLATE_TYPE_INVALID"],
    [input({ id: "../escape" }), "ADMIN_TEMPLATE_ID_INVALID"],
    [input({ id: ".hidden" }), "ADMIN_TEMPLATE_ID_INVALID"],
    [input({ id: "bad:name" }), "ADMIN_TEMPLATE_ID_INVALID"],
    [input({ id: "NUL" }), "ADMIN_TEMPLATE_ID_INVALID"],
    [input({ id: "x".repeat(81) }), "ADMIN_TEMPLATE_ID_INVALID"],
    [input({ title: " " }), "ADMIN_TEMPLATE_TITLE_REQUIRED"],
    [input({ title: "x".repeat(121) }), "ADMIN_TEMPLATE_TITLE_TOO_LONG"],
    [input({ description: "x".repeat(501) }), "ADMIN_TEMPLATE_DESCRIPTION_TOO_LONG"],
    [input({ content: "before\0after" }), "PROJECT_TEMPLATE_INVALID"],
    [input({ content: "x".repeat(MAX_PROJECT_TEMPLATE_BYTES + 1) }), "PROJECT_TEMPLATE_TOO_LARGE"],
  ];
  for (const [value, errorCode] of cases) assert.throws(() => validateProjectTemplate(value), { errorCode });

  assert.equal(validateProjectTemplate(input({ id: "  score one  " })).id, "score one");
});

test("first initialization seeds once and deleted bundled templates do not reappear", async (t) => {
  const root = await temporaryDirectory(t, "iris-template-seeding-");
  const seedDir = path.join(root, "seed");
  const templateDir = path.join(root, "data/templates");
  await fs.mkdir(path.join(seedDir, "latex"), { recursive: true });
  await fs.mkdir(path.join(seedDir, "lilypond"), { recursive: true });
  await fs.writeFile(path.join(seedDir, "latex/article.tex"), "seed article");
  await fs.writeFile(path.join(seedDir, "lilypond/default.ly"), "seed score");

  await initializeProjectTemplates(templateDir, seedDir);
  assert.equal(await readProjectTemplate(templateDir, "latex", "article.tex"), "seed article");
  await deleteProjectTemplate(templateDir, "latex", "article");
  await initializeProjectTemplates(templateDir, seedDir);
  assert.deepEqual((await discoverProjectTemplates(templateDir)).latex, []);
  assert.equal(await readProjectTemplate(templateDir, "lilypond", "default.ly"), "seed score");

  const pristineDir = path.join(root, "pristine");
  await fs.mkdir(path.join(pristineDir, "latex"), { recursive: true });
  await fs.mkdir(path.join(pristineDir, "lilypond"), { recursive: true });
  await initializeProjectTemplates(pristineDir, seedDir);
  assert.equal(await readProjectTemplate(pristineDir, "latex", "article.tex"), "seed article");
});

test("an existing instance catalog is marked initialized without adding bundled files", async (t) => {
  const root = await temporaryDirectory(t, "iris-template-existing-");
  const seedDir = path.join(root, "seed");
  const templateDir = path.join(root, "templates");
  await fs.mkdir(path.join(seedDir, "latex"), { recursive: true });
  await fs.mkdir(path.join(seedDir, "lilypond"), { recursive: true });
  await fs.writeFile(path.join(seedDir, "latex/article.tex"), "bundled");
  await fs.mkdir(path.join(templateDir, "latex"), { recursive: true });
  await fs.writeFile(path.join(templateDir, "latex/manual.tex"), "manual");

  await initializeProjectTemplates(templateDir, seedDir);
  assert.deepEqual((await discoverProjectTemplates(templateDir)).latex.map((template) => template.id), ["manual"]);
  assert.ok((await fs.lstat(path.join(templateDir, MANIFEST_FILE))).isFile());
});

test("a corrupt or hostile manifest is ignored without hiding manually dropped files", async (t) => {
  const templateDir = path.join(await temporaryDirectory(t, "iris-template-manifest-"), "templates");
  await initializeProjectTemplates(templateDir);
  await fs.writeFile(path.join(templateDir, "latex/manual-file.tex"), "manual");
  await fs.writeFile(path.join(templateDir, MANIFEST_FILE), '{"defaults":{"latex":"../../outside"},"templates":[{"type":"latex","id":"../manual-file","title":"Bad"}]}');

  let templates = await discoverProjectTemplates(templateDir);
  assert.equal(templates.latex[0].title, "Manual file");
  assert.equal(templates.latex[0].default, true);

  await fs.writeFile(path.join(templateDir, MANIFEST_FILE), "{ definitely not json");
  templates = await discoverProjectTemplates(templateDir);
  assert.equal(templates.latex[0].id, "manual-file");
  assert.equal(await readProjectTemplate(templateDir, "latex", "manual-file.tex"), "manual");

  await createProjectTemplate(templateDir, input({ id: "recovered", title: "Recovered metadata" }));
  assert.equal((await getAdminProjectTemplate(templateDir, "latex", "recovered")).title, "Recovered metadata");
});

test("catalog discovery exposes at most 200 regular templates per type", async (t) => {
  const templateDir = await temporaryDirectory(t, "iris-template-limit-");
  await fs.mkdir(path.join(templateDir, "latex"), { recursive: true });
  await fs.mkdir(path.join(templateDir, "lilypond"), { recursive: true });
  await Promise.all(Array.from({ length: 201 }, (_, index) =>
    fs.writeFile(path.join(templateDir, "latex", `template-${String(index).padStart(3, "0")}.tex`), "x")));

  const templates = await discoverProjectTemplates(templateDir);
  assert.equal(templates.latex.length, 200);
  assert.equal(templates.latex.filter((template) => template.default).length, 1);
  await assert.rejects(
    createProjectTemplate(templateDir, input({ id: "one-more", title: "One more" })),
    { errorCode: "PROJECT_TEMPLATE_INVALID", status: 422 }
  );
});
