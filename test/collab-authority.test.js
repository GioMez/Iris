// The rules that stop a whole-project save from destroying a collaborator's work:
//
//   1. a source file sent without content is not written — the bytes on disk stay,
//      because the client only sends what it actually edited;
//   2. a file with a live realtime room is written from the room's authoritative
//      text, whatever the saving client believed it contained.
//
// Together these make concurrent saves safe: the only way to change a file is to
// have edited it, and a document being edited in realtime is owned by its room.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ChangeSet } = require("@codemirror/state");
const { writeProjectFile, applyCollabAuthority, collabRooms } = require("../src/server");

async function projectDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iris-collab-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function tree(nodes) {
  return { project: { name: "p", nodes }, assets: {}, fonts: [] };
}

const read = (dir, rel) => fs.readFile(path.join(dir, rel), "utf8");

test("a source file sent without content keeps the bytes already on disk", async (t) => {
  const dir = await projectDir(t);
  await writeProjectFile(dir, tree([
    { type: "file", id: "a", name: "main.tex", path: "main.tex", kind: "tex", content: "original" },
    { type: "file", id: "b", name: "notes.tex", path: "notes.tex", kind: "tex", content: "notes" },
  ]));

  // A collaborator's newer text lands on disk out of band.
  await fs.writeFile(path.join(dir, "notes.tex"), "written by someone else", "utf8");

  // This client edited only main.tex, so notes.tex arrives with no content key.
  await writeProjectFile(dir, tree([
    { type: "file", id: "a", name: "main.tex", path: "main.tex", kind: "tex", content: "edited here" },
    { type: "file", id: "b", name: "notes.tex", path: "notes.tex", kind: "tex" },
  ]));

  assert.equal(await read(dir, "main.tex"), "edited here");
  assert.equal(await read(dir, "notes.tex"), "written by someone else");
});

test("an empty string still truncates, so clearing a file is not mistaken for omitting it", async (t) => {
  const dir = await projectDir(t);
  await writeProjectFile(dir, tree([
    { type: "file", id: "a", name: "main.tex", path: "main.tex", kind: "tex", content: "text" },
  ]));
  await writeProjectFile(dir, tree([
    { type: "file", id: "a", name: "main.tex", path: "main.tex", kind: "tex", content: "" },
  ]));
  assert.equal(await read(dir, "main.tex"), "");
});

test("a file that does not exist yet is created even without content", async (t) => {
  const dir = await projectDir(t);
  await writeProjectFile(dir, tree([
    { type: "file", id: "a", name: "fresh.tex", path: "fresh.tex", kind: "tex" },
    { type: "folder", name: "chapters", children: [
      { type: "file", id: "b", name: "one.tex", path: "chapters/one.tex", kind: "tex" },
    ] },
  ]));
  assert.equal(await read(dir, "fresh.tex"), "");
  assert.equal(await read(dir, "chapters/one.tex"), "");
});

// Rooms are global to the process, so each test cleans up after itself.
function room(t, { fileId, projectId, filePath, content }) {
  const created = collabRooms.open({ fileId, projectId, path: filePath, content });
  t.after(() => collabRooms.close(fileId));
  return created;
}

function edit(created, changes) {
  const result = created.receive(created.version, [
    { changes: ChangeSet.of(changes, created.doc.length).toJSON(), clientID: "peer" },
  ]);
  assert.equal(result.accepted, true);
  return created;
}

test("a live room's text overrides whatever the saving client sent", async (t) => {
  const dir = await projectDir(t);
  const live = edit(room(t, { fileId: "f-live", projectId: "p-1", filePath: "main.tex", content: "shared" }), [
    { from: 6, insert: " and edited live" },
  ]);

  const data = tree([
    { type: "file", id: "f-live", name: "main.tex", path: "main.tex", kind: "tex", content: "stale copy from this client" },
  ]);
  applyCollabAuthority("p-1", data);
  assert.equal(data.project.nodes[0].content, "shared and edited live");

  await writeProjectFile(dir, data);
  assert.equal(await read(dir, "main.tex"), live.text());
});

test("the override reaches files nested in folders and leaves other files alone", async (t) => {
  const dir = await projectDir(t);
  edit(room(t, { fileId: "f-nested", projectId: "p-2", filePath: "parts/one.tex", content: "one" }), [
    { from: 3, insert: "!" },
  ]);

  const data = tree([
    { type: "file", id: "f-plain", name: "main.tex", path: "main.tex", kind: "tex", content: "kept as sent" },
    { type: "folder", name: "parts", children: [
      { type: "file", id: "f-nested", name: "one.tex", path: "parts/one.tex", kind: "tex", content: "stale" },
    ] },
  ]);
  applyCollabAuthority("p-2", data);
  await writeProjectFile(dir, data);

  assert.equal(await read(dir, "parts/one.tex"), "one!");
  assert.equal(await read(dir, "main.tex"), "kept as sent");
});

test("rooms of other projects never leak into this project's save", async (t) => {
  room(t, { fileId: "f-other", projectId: "other-project", filePath: "main.tex", content: "not mine" });
  const data = tree([
    { type: "file", id: "f-other", name: "main.tex", path: "main.tex", kind: "tex", content: "mine" },
  ]);
  applyCollabAuthority("p-3", data);
  assert.equal(data.project.nodes[0].content, "mine");
});

test("a save with no live rooms is left exactly as sent", async (t) => {
  const data = tree([
    { type: "file", id: "f-1", name: "main.tex", path: "main.tex", kind: "tex", content: "as sent" },
    { type: "file", id: "f-2", name: "other.tex", path: "other.tex", kind: "tex" },
  ]);
  applyCollabAuthority("p-empty", data);
  assert.equal(data.project.nodes[0].content, "as sent");
  assert.ok(!("content" in data.project.nodes[1]), "an omitted content must stay omitted");
});

test("a live room supplies content even for a node that omitted it", (t) => {
  edit(room(t, { fileId: "f-omit", projectId: "p-4", filePath: "main.tex", content: "base" }), [
    { from: 4, insert: " live" },
  ]);
  const data = tree([{ type: "file", id: "f-omit", name: "main.tex", path: "main.tex", kind: "tex" }]);
  applyCollabAuthority("p-4", data);
  assert.equal(data.project.nodes[0].content, "base live");
});
