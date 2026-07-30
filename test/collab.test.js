// Convergence tests for the OT engine. The clients here are real CodeMirror
// editor states running the same @codemirror/collab extension the browser uses,
// so what is exercised is the actual protocol — push/reject/pull/rebase — and
// not a mock of it. This is the completion criterion of the realtime phase:
// concurrent edits, disconnection and reconnection must all converge.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EditorState, ChangeSet } = require("@codemirror/state");
const { collab, getSyncedVersion, sendableUpdates, receiveUpdates } = require("@codemirror/collab");
const { CollabDocument, CollabRooms, CollabError, PEER_COLORS, peerColor, normalizePresence } = require("../src/collab");

function makeRoom(content, options = {}) {
  return new CollabDocument({ fileId: "file-1", projectId: "project-1", path: "main.tex", content, ...options });
}

// A client exactly as the browser runs it: an editor state with the collab
// extension, synchronised through the room's push/pull surface.
function makeClient(id, room) {
  return {
    id,
    state: EditorState.create({
      doc: room.text(),
      extensions: [collab({ startVersion: room.version, clientID: id })],
    }),
  };
}

function type(client, changes) {
  client.state = client.state.update({ changes }).state;
}

function push(client, room, meta = {}) {
  const sendable = sendableUpdates(client.state);
  if (!sendable.length) return { accepted: true, idle: true };
  return room.receive(
    getSyncedVersion(client.state),
    sendable.map((update) => ({ changes: update.changes.toJSON(), clientID: update.clientID })),
    { userId: meta.userId || client.id },
  );
}

// Returns "resync" when the client has fallen out of the room's history window
// and must reload the authoritative document, mirroring the client transport.
function pull(client, room) {
  const updates = room.since(getSyncedVersion(client.state));
  if (updates === null) return "resync";
  if (!updates.length) return "idle";
  client.state = receiveUpdates(
    client.state,
    updates.map((update) => ({ changes: ChangeSet.fromJSON(update.changes), clientID: update.clientID })),
  ).state;
  return "applied";
}

function resync(client, room) {
  client.state = EditorState.create({
    doc: room.text(),
    extensions: [collab({ startVersion: room.version, clientID: client.id })],
  });
}

// Push, and on rejection rebase against the room and retry — the loop the real
// client runs. Returns the number of attempts it took.
function sync(client, room) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = push(client, room);
    if (result.accepted) {
      pull(client, room);
      return attempt;
    }
    if (pull(client, room) === "resync") resync(client, room);
  }
  throw new Error("client failed to synchronise");
}

test("concurrent edits from two clients converge on the same text", () => {
  const room = makeRoom("hello world");
  const a = makeClient("a", room);
  const b = makeClient("b", room);

  // Both edit from the same version, without seeing each other.
  type(a, { from: 0, insert: "A says: " });
  type(b, { from: 11, insert: "!" });

  assert.equal(push(a, room).accepted, true);
  // B is now behind: its push must be refused rather than silently reordered.
  const refused = push(b, room);
  assert.equal(refused.accepted, false);
  assert.equal(refused.version, 1);

  // B rebases its pending insert over A's and retries.
  assert.equal(pull(b, room), "applied");
  assert.equal(push(b, room).accepted, true);
  pull(b, room);
  pull(a, room);

  assert.equal(room.version, 2);
  assert.equal(a.state.doc.toString(), room.text());
  assert.equal(b.state.doc.toString(), room.text());
  assert.equal(room.text(), "A says: hello world!");
});

test("interleaved edits from three clients converge and keep every insertion", () => {
  const room = makeRoom("1\n2\n3\n");
  const clients = ["a", "b", "c"].map((id) => makeClient(id, room));

  // Several rounds of simultaneous typing at overlapping positions.
  for (let round = 0; round < 6; round++) {
    clients.forEach((client, index) => {
      const line = client.state.doc.line(1 + ((round + index) % client.state.doc.lines));
      type(client, { from: line.from, insert: `${client.id}${round} ` });
    });
    // Deliberately unfair order: the same client pushes first every round.
    clients.forEach((client) => sync(client, room));
  }
  clients.forEach((client) => pull(client, room));

  const text = room.text();
  clients.forEach((client) => assert.equal(client.state.doc.toString(), text, `client ${client.id} diverged`));
  // Nothing was lost in the rebases: every edit is present exactly once.
  for (let round = 0; round < 6; round++) {
    clients.forEach((client) => {
      const token = `${client.id}${round} `;
      assert.equal(text.split(token).length - 1, 1, `missing or duplicated ${token}`);
    });
  }
  assert.equal(room.version, 18);
});

test("a client that misses updates while disconnected catches up on reconnect", () => {
  const room = makeRoom("shared");
  const a = makeClient("a", room);
  const b = makeClient("b", room);

  // B is offline; A keeps working.
  type(a, { from: 6, insert: " one" });
  sync(a, room);
  type(a, { from: 10, insert: " two" });
  sync(a, room);

  // B reconnects, pulls from the version it still holds, and converges without
  // reloading the document.
  assert.equal(getSyncedVersion(b.state), 0);
  assert.equal(pull(b, room), "applied");
  assert.equal(b.state.doc.toString(), room.text());
  assert.equal(getSyncedVersion(b.state), room.version);

  // Work done offline is not lost: it rebases on top of what it missed.
  type(b, { from: 0, insert: "B: " });
  sync(b, room);
  pull(a, room);
  assert.equal(a.state.doc.toString(), room.text());
  assert.equal(room.text(), "B: shared one two");
});

test("edits made while offline survive a reconnection that needs a rebase", () => {
  const room = makeRoom("base");
  const a = makeClient("a", room);
  const b = makeClient("b", room);

  // Both work offline, then reconnect in turn.
  type(b, { from: 4, insert: " from B" });
  type(a, { from: 0, insert: "from A " });
  sync(a, room);
  sync(b, room);
  pull(a, room);

  assert.equal(a.state.doc.toString(), room.text());
  assert.equal(b.state.doc.toString(), room.text());
  assert.equal(room.text(), "from A base from B");
});

test("a client older than the history window is told to resync instead of guessing", () => {
  const room = makeRoom("x", { historyLimit: 4 });
  const a = makeClient("a", room);
  const stale = makeClient("stale", room);

  for (let i = 0; i < 6; i++) {
    type(a, { from: 0, insert: `${i}` });
    sync(a, room);
  }
  // The log no longer reaches version 0, so replaying is impossible.
  assert.equal(room.log.length, 4);
  assert.equal(room.logStart, 2);
  assert.equal(pull(stale, room), "resync");

  resync(stale, room);
  assert.equal(stale.state.doc.toString(), room.text());
  // And it can contribute again straight away.
  type(stale, { from: 0, insert: "S" });
  sync(stale, room);
  pull(a, room);
  assert.equal(a.state.doc.toString(), room.text());
});

test("the log stays replayable from its start after trimming", () => {
  const room = makeRoom("", { historyLimit: 3 });
  const a = makeClient("a", room);
  for (let i = 0; i < 5; i++) {
    type(a, { from: a.state.doc.length, insert: `${i}` });
    sync(a, room);
  }
  // since(logStart) must be exactly the retained tail, and each later version
  // must return one fewer update.
  assert.equal(room.since(room.logStart).length, 3);
  assert.equal(room.since(room.version).length, 0);
  assert.equal(room.since(room.version - 1).length, 1);
  const late = makeClient("late", room);
  assert.equal(pull(late, room), "idle");
  assert.equal(late.state.doc.toString(), "01234");
});

test("a push from behind leaves the document untouched", () => {
  const room = makeRoom("keep");
  const a = makeClient("a", room);
  const b = makeClient("b", room);
  type(a, { from: 4, insert: "!" });
  sync(a, room);

  const before = room.text();
  const version = room.version;
  type(b, { from: 0, insert: "no" });
  assert.equal(push(b, room).accepted, false);
  assert.equal(room.text(), before);
  assert.equal(room.version, version);
});

test("malformed and inapplicable updates are refused without corrupting the room", () => {
  const room = makeRoom("stable");
  assert.throws(() => room.receive(0, [{ changes: "nonsense", clientID: "x" }]), (err) => err.code === "COLLAB_BAD_CHANGES");
  // A change set built against a different document length cannot apply here.
  const foreign = ChangeSet.of([{ from: 0, insert: "z" }], 99).toJSON();
  assert.throws(() => room.receive(0, [{ changes: foreign, clientID: "x" }]), (err) => err.code === "COLLAB_BAD_CHANGES");
  assert.throws(() => room.receive(0, []), (err) => err.code === "COLLAB_EMPTY_PUSH");
  assert.throws(() => room.receive(-1, [{ changes: [], clientID: "x" }]), (err) => err.code === "COLLAB_BAD_VERSION");
  assert.throws(() => room.since(room.version + 1), (err) => err.code === "COLLAB_BAD_VERSION");

  // The second update of a batch failing must not leave the first applied.
  const good = ChangeSet.of([{ from: 0, insert: "a" }], 6).toJSON();
  assert.throws(() => room.receive(0, [{ changes: good }, { changes: foreign }]), (err) => err instanceof CollabError);
  assert.equal(room.text(), "stable");
  assert.equal(room.version, 0);
  assert.ok(room.receive(0, [{ changes: good, clientID: "x" }]).accepted);
  assert.equal(room.text(), "astable");
});

test("an oversized push is refused", () => {
  const room = makeRoom("x");
  const many = Array.from({ length: 201 }, () => ({ changes: ChangeSet.of([], 1).toJSON(), clientID: "x" }));
  assert.throws(() => room.receive(0, many), (err) => err.code === "COLLAB_PUSH_TOO_LARGE");
});

test("resetting a document forces connected clients to resync", () => {
  const room = makeRoom("draft");
  const a = makeClient("a", room);
  type(a, { from: 5, insert: " edit" });
  sync(a, room);

  // A rollback replaces the text outside the update stream.
  const version = room.reset("restored");
  assert.equal(room.text(), "restored");
  assert.ok(version > 1);
  // The client's version is stranded before the reset, so replaying is refused.
  a.state = EditorState.create({ doc: "draft edit", extensions: [collab({ startVersion: 1, clientID: "a" })] });
  assert.equal(pull(a, room), "resync");
  resync(a, room);
  assert.equal(a.state.doc.toString(), "restored");
});

test("persistence and revision bookkeeping follow the accepted version", () => {
  const room = makeRoom("a");
  assert.equal(room.needsPersist(), false);
  assert.equal(room.needsRevision(), false);

  const client = makeClient("a", room);
  type(client, { from: 1, insert: "b" });
  sync(client, room);
  assert.equal(room.needsPersist(), true);
  assert.equal(room.needsRevision(), true);

  room.markPersisted();
  assert.equal(room.needsPersist(), false);
  // A revision is consolidated on its own cadence, so it is still pending.
  assert.equal(room.needsRevision(), true);
  room.markRevisioned();
  assert.equal(room.needsRevision(), false);

  // A reset counts as unpersisted work: the new text must reach disk.
  room.reset("z");
  assert.equal(room.needsPersist(), true);
  assert.equal(room.needsRevision(), true);
});

/* ---- presence ---- */

test("a participant's colour is stable and derived only from their identity", () => {
  const userId = "019fb1db-4bfd-7242-aff6-cdec7aa83d02";
  assert.equal(peerColor(userId), peerColor(userId), "the same person is always the same colour");
  assert.ok(PEER_COLORS.includes(peerColor(userId)));
  // Every colour in the palette is reachable and none repeats.
  assert.equal(new Set(PEER_COLORS).size, PEER_COLORS.length);
  const produced = new Set(Array.from({ length: 400 }, (_, i) => peerColor(`user-${i}`)));
  assert.equal(produced.size, PEER_COLORS.length, "the whole palette is used");
  // A missing id still yields a usable colour rather than undefined.
  assert.ok(PEER_COLORS.includes(peerColor(null)));
});

test("presence reports are clamped to the document and never trusted blindly", () => {
  assert.deepEqual(normalizePresence({ anchor: 2, head: 5, version: 3 }, 10), { anchor: 2, head: 5, version: 3 });
  // Positions past the end of the document are clamped, not rejected: the sender
  // may simply be a moment ahead of us.
  assert.deepEqual(normalizePresence({ anchor: 99, head: 99, version: 1 }, 10), { anchor: 10, head: 10, version: 1 });
  assert.deepEqual(normalizePresence({ anchor: -5, head: 3, version: 0 }, 10), { anchor: 0, head: 3, version: 0 });
  // Fractions are floored rather than smuggled into a position.
  assert.equal(normalizePresence({ anchor: 2.9, head: 2.9, version: 0 }, 10).anchor, 2);
  // Anything unusable is dropped: presence is a hint, not a command.
  assert.equal(normalizePresence({ anchor: "x", head: 1 }, 10), null);
  assert.equal(normalizePresence({ head: 1 }, 10), null);
  assert.equal(normalizePresence(null, 10), null);
  // A malformed version degrades to zero instead of poisoning the report.
  assert.equal(normalizePresence({ anchor: 1, head: 1, version: -4 }, 10).version, 0);
  assert.equal(normalizePresence({ anchor: 1, head: 1, version: "soon" }, 10).version, 0);
});

test("rooms are keyed per file and seeded only on creation", () => {
  const rooms = new CollabRooms();
  const first = rooms.open({ fileId: "f1", projectId: "p1", path: "a.tex", content: "one" });
  // A second join must not reseed from a stale disk read.
  const again = rooms.open({ fileId: "f1", projectId: "p1", path: "a.tex", content: "STALE" });
  assert.equal(again, first);
  assert.equal(again.text(), "one");

  rooms.open({ fileId: "f2", projectId: "p1", path: "b.tex", content: "two" });
  rooms.open({ fileId: "f3", projectId: "p2", path: "c.tex", content: "three" });
  assert.equal(rooms.forProject("p1").length, 2);
  assert.equal(rooms.all().length, 3);
  assert.equal(rooms.get("f2").text(), "two");

  rooms.close("f2");
  assert.equal(rooms.get("f2"), null);
  assert.equal(rooms.forProject("p1").length, 1);
});
