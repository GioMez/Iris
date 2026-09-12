const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeProjectPath, collectProjectFiles, reconcileProjectFiles, remapImportedFileIds } = require("../src/project-files");
const { isUuid } = require("../src/ids");

const UUID_A = "019f99b9-61cf-7fee-963f-8f7dee086983";
const UUID_B = "019f99bb-6923-7322-a37d-c8f46b5e5cc9";
const UUID_C = "019f99bb-6923-7322-a37d-c8f46b5e5cca";
const UUID_D = "019f99bb-6923-7322-a37d-c8f46b5e5ccb";
const UUID_E = "019f99bb-6923-7322-a37d-c8f46b5e5ccc";

// Deterministic id generator so the plan is assertable.
function counter(prefix = "gen") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

test("path normalization matches the disk writer and rejects traversal", () => {
  assert.equal(normalizeProjectPath("main.tex"), "main.tex");
  assert.equal(normalizeProjectPath("chapters//intro.tex"), "chapters/intro.tex");
  assert.equal(normalizeProjectPath("\\windows\\name.tex"), "windows/name.tex");
  // A leading slash is stripped the same way the disk writer strips it, so an
  // absolute-looking path becomes a contained relative one rather than escaping.
  assert.equal(normalizeProjectPath("/etc/passwd"), "etc/passwd");
  for (const bad of ["", "..", "../escape", "a/../../b"]) {
    assert.equal(normalizeProjectPath(bad), null, `should reject ${bad}`);
  }
});

test("enumeration keeps source files and drops folders, generated and read-only nodes", () => {
  const nodes = [
    { type: "file", id: "a", name: "main.tex", kind: "tex" },
    { type: "folder", name: "chapters", children: [
      { type: "file", id: "b", name: "intro.tex", kind: "tex" },
    ] },
    { type: "folder", name: "output", generated: true, children: [
      { type: "file", id: "gen", name: "main.pdf", generated: true },
    ] },
    { type: "file", id: "ro", name: "readonly.log", readOnly: true },
    { type: "file", id: "c", name: "score.ly", path: "explicit/score.ly", kind: "ly" },
  ];
  const entries = collectProjectFiles(nodes).map(({ nodeId, path, kind }) => ({ nodeId, path, kind }));
  assert.deepEqual(entries, [
    { nodeId: "a", path: "main.tex", kind: "tex" },
    { nodeId: "b", path: "chapters/intro.tex", kind: "tex" },
    { nodeId: "c", path: "explicit/score.ly", kind: "ly" },
  ]);
});

test("enumeration exposes the node so a resolved id can be stamped back", () => {
  const node = { type: "file", id: "x", name: "main.tex" };
  const [entry] = collectProjectFiles([node]);
  assert.equal(entry.node, node);
});

test("a fresh project inserts every file and assigns ids in tree order", () => {
  const incoming = [
    { nodeId: "file_1", path: "main.tex", kind: "tex" },
    { nodeId: "file_2", path: "a/b.tex", kind: "tex" },
  ];
  const plan = reconcileProjectFiles([], incoming, { generateId: counter() });
  assert.deepEqual(plan.resolved, [{ canonicalId: "gen-1" }, { canonicalId: "gen-2" }]);
  assert.deepEqual(plan.inserts, [
    { id: "gen-1", client_ref: "file_1", path: "main.tex", kind: "tex" },
    { id: "gen-2", client_ref: "file_2", path: "a/b.tex", kind: "tex" },
  ]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.softDeletes, []);
});

test("re-saving the same session reuses ids by client_ref without churn", () => {
  // First save minted gen-1 with client_ref file_1; the browser still sends file_1.
  const live = [{ id: "gen-1", client_ref: "file_1", path: "main.tex", kind: "tex" }];
  const plan = reconcileProjectFiles(live, [{ nodeId: "file_1", path: "main.tex", kind: "tex" }], { generateId: counter() });
  assert.deepEqual(plan.resolved, [{ canonicalId: "gen-1" }]);
  assert.deepEqual(plan.inserts, []);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.softDeletes, []);
});

test("a rename keeps the id and updates the path (by client_ref, same session)", () => {
  const live = [{ id: "gen-1", client_ref: "file_1", path: "main.tex", kind: "tex" }];
  const plan = reconcileProjectFiles(live, [{ nodeId: "file_1", path: "renamed.tex", kind: "tex" }], { generateId: counter() });
  assert.deepEqual(plan.resolved, [{ canonicalId: "gen-1" }]);
  assert.deepEqual(plan.updates, [{ id: "gen-1", fromPath: "main.tex", path: "renamed.tex", kind: "tex" }]);
  assert.deepEqual(plan.inserts, []);
  assert.deepEqual(plan.softDeletes, []);
});

test("after reload the file matches by its adopted UUID and a move is tracked", () => {
  const live = [{ id: UUID_A, client_ref: "file_1", path: "main.tex", kind: "tex" }];
  const plan = reconcileProjectFiles(live, [{ nodeId: UUID_A, path: "chapters/main.tex", kind: "tex" }], { generateId: counter() });
  assert.deepEqual(plan.resolved, [{ canonicalId: UUID_A }]);
  assert.deepEqual(plan.updates, [{ id: UUID_A, fromPath: "main.tex", path: "chapters/main.tex", kind: "tex" }]);
});

test("a removed file is soft-deleted, never resurrected on re-add", () => {
  const live = [
    { id: "gen-1", client_ref: "file_1", path: "main.tex", kind: "tex" },
    { id: "gen-2", client_ref: "file_2", path: "gone.tex", kind: "tex" },
  ];
  const removed = reconcileProjectFiles(live, [{ nodeId: "file_1", path: "main.tex", kind: "tex" }], { generateId: counter() });
  assert.deepEqual(removed.softDeletes, ["gen-2"]);

  // A new file later appears at the deleted path: it is a new identity, not a revival.
  const readded = reconcileProjectFiles(
    [{ id: "gen-1", client_ref: "file_1", path: "main.tex", kind: "tex" }],
    [
      { nodeId: "file_1", path: "main.tex", kind: "tex" },
      { nodeId: "file_9", path: "gone.tex", kind: "tex" },
    ],
    { generateId: counter("new") }
  );
  assert.deepEqual(readded.inserts, [{ id: "new-1", client_ref: "file_9", path: "gone.tex", kind: "tex" }]);
  assert.deepEqual(readded.softDeletes, []);
});

test("a new file adopts a client-supplied UUIDv7 but mints one for a legacy id", () => {
  const plan = reconcileProjectFiles(
    [],
    [
      { nodeId: UUID_B, path: "adopted.tex", kind: "tex" },
      { nodeId: "file_legacy", path: "minted.tex", kind: "tex" },
    ],
    { generateId: counter() }
  );
  assert.equal(plan.inserts[0].id, UUID_B);
  assert.ok(isUuid(plan.inserts[0].id));
  assert.equal(plan.inserts[1].id, "gen-1");
});

test("duplicate client refs do not let two files share one identity", () => {
  const live = [{ id: "gen-1", client_ref: "dup", path: "one.tex", kind: "tex" }];
  const plan = reconcileProjectFiles(
    live,
    [
      { nodeId: "dup", path: "one.tex", kind: "tex" },
      { nodeId: "dup", path: "two.tex", kind: "tex" },
    ],
    { generateId: counter() }
  );
  assert.equal(plan.resolved[0].canonicalId, "gen-1");
  assert.notEqual(plan.resolved[1].canonicalId, "gen-1");
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.inserts[0].path, "two.tex");
});

test("a kind change on a matched file is recorded", () => {
  const live = [{ id: "gen-1", client_ref: "file_1", path: "notes.txt", kind: "text" }];
  const plan = reconcileProjectFiles(live, [{ nodeId: "file_1", path: "notes.txt", kind: "tex" }], { generateId: counter() });
  assert.deepEqual(plan.updates, [{ id: "gen-1", fromPath: "notes.txt", path: "notes.txt", kind: "tex" }]);
});

function idSequence(...ids) {
  return () => {
    assert.ok(ids.length, "unexpected extra identity allocation");
    return ids.shift();
  };
}

test("import remaps nested text, binary and font identities without changing path-based data", () => {
  const data = {
    project: { name: "Copy", nodes: [
      { type: "file", id: UUID_A, name: "main.tex", path: "main.tex", content: "source\r\n" },
      { type: "folder", id: "folder", name: "fonts", open: true, children: [
        { type: "file", id: "font_upload", name: "Custom.otf", path: "fonts/Custom.otf", binary: true, data: "data:font/otf;base64,AAE=" },
      ] },
      { type: "file", name: "bytes.bin", binary: true, data: "data:application/octet-stream;base64,AP8=" },
      { type: "file", id: "generated", name: "main.pdf", generated: true },
      { type: "file", id: "readonly", name: "main.log", readOnly: true },
    ] },
    activeId: "font_upload", openTabs: [UUID_A, "font_upload", UUID_A, "gone", "generated", "readonly", "folder"],
    assets: { "fonts/Custom.otf": "data:font/otf;base64,AAE=" },
    fonts: [{ path: "fonts/Custom.otf", family: "Custom", enabled: false }],
    mainPath: "main.tex", customCommands: { tex: ["\\mine"], ly: [] }, settings: { tabSize: 4 },
  };
  const expected = structuredClone(data);
  expected.project.nodes[0].id = UUID_C;
  expected.project.nodes[1].children[0].id = UUID_D;
  expected.project.nodes[2].id = UUID_E;
  expected.activeId = UUID_D;
  expected.openTabs = [UUID_C, UUID_D];
  assert.equal(remapImportedFileIds(data, { generateId: idSequence(UUID_C, UUID_D, UUID_E) }), data);
  assert.deepEqual(data, expected);
});

test("import reserves all original canonical IDs before allocation and retries new-ID collisions", () => {
  const data = { project: { nodes: [
    { id: UUID_A, name: "one.tex" }, { id: UUID_B, name: "two.tex" },
  ] }, activeId: UUID_B, openTabs: [UUID_B, UUID_A] };
  remapImportedFileIds(data, { generateId: idSequence(UUID_B, UUID_A, UUID_C, UUID_C, UUID_A, UUID_D) });
  assert.deepEqual(data.project.nodes.map((node) => node.id), [UUID_C, UUID_D]);
  assert.equal(data.activeId, UUID_D);
  assert.deepEqual(data.openTabs, [UUID_D, UUID_C]);
});

test("import defaults to fresh canonical UUIDv7 identities for each copy", () => {
  const original = { project: { nodes: [{ id: UUID_A, name: "main.tex" }, { name: "new.txt" }] } };
  const copies = [structuredClone(original), structuredClone(original)];
  copies.forEach((data) => remapImportedFileIds(data));
  const ids = copies.flatMap((data) => data.project.nodes.map((node) => node.id));
  assert.equal(new Set([UUID_A, ...ids]).size, 5);
  for (const id of ids) { assert.ok(isUuid(id)); assert.equal(id[14], "7"); }
});

for (const duplicate of [UUID_A, "file_current"]) {
  test(`import drops ambiguous navigation for duplicate source ID ${duplicate}`, () => {
    const data = { project: { nodes: [
      { id: duplicate, name: "one.tex" },
      { type: "folder", name: "nested", children: [{ id: duplicate, name: "two.tex" }] },
      { id: "unique", name: "three.tex" },
    ] }, activeId: duplicate, openTabs: [duplicate, "unique", duplicate, "unique", "missing"] };
    remapImportedFileIds(data, { generateId: idSequence(UUID_C, UUID_D, UUID_E) });
    assert.equal(data.project.nodes[0].id, UUID_C);
    assert.equal(data.project.nodes[1].children[0].id, UUID_D);
    assert.equal(data.project.nodes[2].id, UUID_E);
    assert.equal(data.activeId, null);
    assert.deepEqual(data.openTabs, [UUID_E]);
  });
}

test("import accepts missing and null IDs and maps string references without coercion", () => {
  const data = { project: { nodes: [
    { name: "missing.tex" }, { id: null, name: "null.tex" }, { id: "__proto__", name: "temporary.tex" },
  ] }, activeId: "stale", openTabs: [null, undefined, {}, 0, "null", "__proto__", "__proto__"] };
  remapImportedFileIds(data, { generateId: idSequence(UUID_C, UUID_D, UUID_E) });
  assert.deepEqual(data.project.nodes.map((node) => node.id), [UUID_C, UUID_D, UUID_E]);
  assert.equal(data.activeId, null);
  assert.deepEqual(data.openTabs, [UUID_E]);
});

for (const invalid of [0, 42, true, {}, []]) {
  test(`import rejects nonstring file ID ${JSON.stringify(invalid)} before changing identities`, () => {
    const data = { project: { nodes: [
      { id: UUID_A, name: "valid.tex" },
      { type: "folder", name: "nested", children: [{ id: invalid, name: "invalid.tex" }] },
    ] }, activeId: UUID_A, openTabs: [UUID_A] };
    const before = structuredClone(data);
    assert.throws(() => remapImportedFileIds(data), { name: "TypeError", message: "Invalid imported file ID" });
    assert.deepEqual(data, before);
  });
}

test("import drops navigation when no source file survives", () => {
  const data = { project: { nodes: [] }, activeId: UUID_A, openTabs: [UUID_A] };
  remapImportedFileIds(data, { generateId: idSequence() });
  assert.equal(data.activeId, null);
  assert.deepEqual(data.openTabs, []);
});
