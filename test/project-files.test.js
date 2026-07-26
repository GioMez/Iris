const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeProjectPath, collectProjectFiles, reconcileProjectFiles } = require("../src/project-files");
const { isUuid } = require("../src/ids");

const UUID_A = "019f99b9-61cf-7fee-963f-8f7dee086983";
const UUID_B = "019f99bb-6923-7322-a37d-c8f46b5e5cc9";

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
