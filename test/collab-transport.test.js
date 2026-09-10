const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setTimeout: delay } = require("node:timers/promises");
const WebSocket = require("ws");
const { EditorState, ChangeSet } = require("@codemirror/state");
const { collab, receiveUpdates, sendableUpdates, getSyncedVersion } = require("@codemirror/collab");
const { CollabDocument } = require("../src/collab");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture } = require("./helpers/server-fixture.cjs");

const source = fs.readFileSync(path.join(__dirname, "../public/iris-collab.js"), "utf8");

// Only the browser shell and delivery timing are simulated. Every edit, rebase,
// confirmation and version comes from the real CodeMirror collaboration state.
function browser(clientID, live = null) {
  let state;
  let sync;
  const timers = new Set();
  const sockets = [];
  const editor = {
    loadCollab(doc, _kind, { version }) {
      state = EditorState.create({ doc, extensions: [collab({ clientID, startVersion: version })] });
    },
    collabReceive(updates) {
      state = receiveUpdates(state, updates.map((u) => ({ ...u, changes: ChangeSet.fromJSON(u.changes) }))).state;
      if (sendableUpdates(state).length) sync();
    },
    collabVersion: () => getSyncedVersion(state),
    collabPending: () => ({
      version: getSyncedVersion(state),
      updates: sendableUpdates(state).map((u) => ({ clientID: u.clientID, changes: u.changes.toJSON() })),
    }),
    selection: () => ({ from: 0, to: 0 }),
    setPeers() {},
    onSync(fn) { sync = fn; },
    onCursor() {},
  };
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.sent = [];
      this.incoming = [];
      this.handlers = {};
      sockets.push(this);
      if (live) {
        this.ws = new WebSocket(live.url, { headers: { cookie: live.cookie } });
        this.ws.on("open", () => this.fire("open"));
        this.ws.on("message", (data) => {
          const message = JSON.parse(data.toString());
          this.incoming.push(message);
          if (!this.hold?.(message)) this.deliver(message);
        });
        this.ws.on("close", (code) => this.fire("close", { code }));
        this.ws.on("error", () => {});
      }
    }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    fire(type, event = {}) { for (const fn of this.handlers[type] || []) fn(event); }
    deliver(message) { this.fire("message", { data: JSON.stringify(message) }); }
    send(raw) { this.sent.push(JSON.parse(raw)); this.ws?.send(raw); }
    close() { this.readyState = 3; this.ws?.close(); }
    of(type) { return this.sent.filter((m) => m.t === type); }
    last(type) { return this.of(type).at(-1); }
  }
  const window = { IrisEditor: editor, location: { protocol: "http:", host: "test" } };
  vm.runInNewContext(source, {
    window, WebSocket: Socket, console,
    document: { dispatchEvent() {} }, CustomEvent: class {},
    setTimeout(fn) { timers.add(fn); return fn; },
    clearTimeout(fn) { timers.delete(fn); },
  });
  const api = window.IrisCollab;
  return {
    api, editor, sockets,
    socket: () => sockets.at(-1),
    doc: () => state.doc.toString(),
    version: () => getSyncedVersion(state),
    pending: () => sendableUpdates(state).length,
    tick() { for (const fn of [...timers]) { timers.delete(fn); fn(); } },
    type(changes) { state = state.update({ changes }).state; sync(); },
    join(room) {
      const previous = this.socket();
      api.join(room.fileId, "tex");
      if (!live) {
        if (this.socket() !== previous) this.socket().fire("open");
        this.socket().deliver({ t: "opened", fileId: room.fileId, doc: room.text(), version: room.version, role: "editor" });
      }
    },
  };
}

function room() { return new CollabDocument({ fileId: "file-1", content: "abcd" }); }
function batch(r, start) { return { t: "updates", fileId: r.fileId, version: r.version, updates: r.since(start) }; }
function accept(r, b) {
  const push = b.socket().last("push");
  const result = r.receive(push.version, push.updates);
  assert.equal(result.accepted, true);
  return { t: "pushed", fileId: r.fileId, accepted: true, version: result.version };
}
function remote(r, changes) {
  assert.equal(r.receive(r.version, [{ clientID: "remote", changes: ChangeSet.of(changes, r.doc.length).toJSON() }]).accepted, true);
}
function converged(r, ...clients) {
  for (const b of clients) {
    assert.equal(b.doc(), r.text());
    assert.equal(b.version(), r.version, "browser version must equal authority, not count duplicate deliveries");
    assert.equal(b.pending(), 0);
  }
}

for (const insert of ["X", "LONG"]) {
  for (const pullFirst of [false, true]) {
    test(`overlapping pull and broadcast apply once (${insert}, pull first: ${pullFirst})`, () => {
      const r = room();
      const b = browser("local");
      b.join(r);
      remote(r, { from: 1, to: 2, insert });
      const first = batch(r, 0);
      remote(r, { from: 0, to: 1, insert: "Z" });
      const pull = batch(r, 0);
      b.socket().deliver(pullFirst ? pull : first);
      b.socket().deliver(pullFirst ? first : pull);
      b.socket().deliver(pull);
      converged(r, b);
    });
  }

  test(`ack before own confirmation cannot send twice or apply a dependent broadcast early (${insert})`, () => {
    const r = room();
    const a = browser("a");
    const b = browser("b");
    a.join(r); b.join(r);
    a.type({ from: 1, to: 2, insert }); a.api.flush();
    const ack = accept(r, a);
    const own = batch(r, 0);
    b.socket().deliver(own);
    a.socket().deliver(ack);
    a.type({ from: a.doc().length, insert: "!" }); a.tick(); a.api.flush();
    assert.equal(a.socket().of("push").length, 1, "ack alone must not resend unconfirmed edits");
    b.type({ from: 0, to: 1, insert: "other" }); b.api.flush();
    const otherAck = accept(r, b);
    const dependent = batch(r, 1);
    a.socket().deliver(dependent);
    assert.equal(a.version(), 0, "a gap must not be passed to CodeMirror");
    a.socket().deliver(own);
    // The first pull can finish before the dropped dependent batch; recovery
    // must remember its end version and request the rest, not lose that tail.
    assert.equal(a.socket().last("pull").version, 1);
    a.socket().deliver(batch(r, 1));
    const secondAck = accept(r, a);
    const second = batch(r, 2);
    a.socket().deliver(second); a.socket().deliver(secondAck);
    b.socket().deliver(dependent); b.socket().deliver(otherAck); b.socket().deliver(second);
    converged(r, a, b);
  });
}

test("sender echo does not unlock a push until its ack, including more typing", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  b.type({ from: 4, insert: " first" }); b.api.flush();
  const ack = accept(r, b);
  b.type({ from: b.doc().length, insert: " second" });
  b.socket().deliver(batch(r, 0));
  remote(r, { from: 0, insert: "remote " });
  b.socket().deliver(batch(r, 1));
  b.tick(); b.api.flush();
  assert.equal(b.socket().of("push").length, 1);
  b.socket().deliver(ack);
  assert.equal(b.socket().of("push").length, 2);
  assert.equal(b.socket().last("push").updates.length, 1);
  const nextAck = accept(r, b);
  b.socket().deliver(batch(r, 2)); b.socket().deliver(nextAck);
  converged(r, b);
});

for (const broadcastFirst of [false, true]) {
  test(`rejected push and another accepted broadcast rebase once (broadcast first: ${broadcastFirst})`, () => {
    const r = room();
    const b = browser("local"); b.join(r);
    b.type({ from: 4, insert: " mine" }); b.api.flush();
    remote(r, { from: 0, insert: "theirs " });
    const pushed = b.socket().last("push");
    const rejected = r.receive(pushed.version, pushed.updates);
    assert.equal(rejected.accepted, false);
    const ack = { t: "pushed", fileId: r.fileId, ...rejected };
    const updates = batch(r, 0);
    b.socket().deliver(broadcastFirst ? updates : ack);
    b.socket().deliver(broadcastFirst ? ack : updates);
    assert.equal(b.socket().of("push").length, 2);
    b.socket().deliver(updates); // outstanding overlapping pull reply
    const accepted = accept(r, b);
    b.socket().deliver(batch(r, 1)); b.socket().deliver(accepted);
    assert.equal(r.text(), "theirs abcd mine");
    converged(r, b);
  });
}

test("many gap broadcasts coalesce a pull and its short reply requests the missing tail", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  remote(r, { from: 0, insert: "0" });
  const shortReply = batch(r, 0);
  for (let i = 1; i < 30; i++) {
    remote(r, { from: 0, insert: String(i) });
    b.socket().deliver(batch(r, r.version - 1));
  }
  assert.equal(b.version(), 0);
  assert.equal(b.socket().of("pull").length, 1, "no payload buffer or pull storm for gaps");
  b.socket().deliver(shortReply);
  assert.equal(b.socket().of("pull").length, 2);
  assert.equal(b.socket().last("pull").version, 1);
  b.socket().deliver(batch(r, 1));
  converged(r, b);
});

test("resync retires old ranges but waits for the old push ack before sending new typing", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  b.type({ from: 4, insert: " old" }); b.api.flush();
  const oldAck = accept(r, b);
  const oldUpdates = batch(r, 0);
  r.reset("restored");
  b.socket().deliver({ t: "resync", fileId: r.fileId, version: r.version, doc: r.text() });
  b.type({ from: 8, insert: " new" }); b.api.flush();
  assert.equal(b.socket().of("push").length, 1);
  b.socket().deliver(oldUpdates);
  b.socket().deliver(oldAck);
  assert.equal(b.socket().of("push").length, 2);
  const ack = accept(r, b);
  b.socket().deliver(batch(r, 2)); b.socket().deliver(ack);
  b.socket().deliver({ t: "resync", fileId: r.fileId, version: 2, doc: "restored" });
  converged(r, b);
});

test("restore rejects a queued old-version push and its ack releases new typing only once", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  b.type({ from: 4, insert: " old" }); b.api.flush();
  const oldPush = b.socket().last("push");
  r.reset("restored");
  b.socket().deliver({ t: "resync", fileId: r.fileId, version: r.version, doc: r.text() });
  b.type({ from: 8, insert: " new" }); b.tick(); b.api.flush();
  assert.equal(b.socket().of("push").length, 1);
  const rejected = r.receive(oldPush.version, oldPush.updates);
  assert.equal(rejected.accepted, false);
  b.socket().deliver({ t: "pushed", fileId: r.fileId, ...rejected });
  assert.equal(b.socket().of("push").length, 2);
  const ack = accept(r, b);
  b.socket().deliver(batch(r, 1)); b.socket().deliver(ack);
  b.socket().deliver(batch(r, 1)); b.tick(); b.api.flush();
  assert.equal(b.socket().of("push").length, 2);
  assert.equal(r.text(), "restored new");
  converged(r, b);
});

test("deleted room retains real unconfirmed text and ignores late pull, resync and ack", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  b.type({ from: 4, insert: " mine" }); b.api.flush();
  remote(r, { from: 0, insert: "remote " });
  b.socket().deliver({ t: "pushed", fileId: r.fileId, accepted: false, version: r.version });
  assert.equal(b.socket().of("pull").length, 1);
  b.socket().deliver({ t: "file-closed", fileId: r.fileId });
  assert.equal(b.api.active(), false);
  const sent = b.socket().sent.length;
  b.socket().deliver(batch(r, 0));
  b.socket().deliver({ t: "resync", fileId: r.fileId, version: 10, doc: "stale" });
  b.socket().deliver({ t: "pushed", fileId: r.fileId, accepted: false, version: 10 });
  b.tick(); b.api.flush();
  assert.equal(b.socket().sent.length, sent);
  assert.equal(b.doc(), "abcd mine");
  assert.equal(b.pending(), 1);
  const other = new CollabDocument({ fileId: "file-2", content: "two" });
  b.join(other);
  b.type({ from: 3, insert: "!" }); b.api.flush();
  const pushes = b.socket().of("push").length;
  b.socket().deliver({ t: "pushed", fileId: r.fileId, accepted: true, version: 10 });
  b.socket().deliver({ t: "error", request: "pull", fileId: r.fileId, code: "COLLAB_READ_ONLY" });
  b.socket().deliver({ t: "file-closed", fileId: r.fileId });
  b.type({ from: 4, insert: "?" }); b.api.flush();
  assert.equal(b.api.status(), "live");
  assert.equal(b.socket().of("push").length, pushes, "old ack must not release the new push");
  const ack = accept(other, b);
  b.socket().deliver(batch(other, 0)); b.socket().deliver(ack);
  const nextAck = accept(other, b);
  b.socket().deliver(batch(other, 1)); b.socket().deliver(nextAck);
  converged(other, b);
});

for (const deleted of ["file-1", "file-2"]) {
  test(`file closure retires only ${deleted} from an A-B-A open queue`, () => {
    const b = browser("local");
    b.api.join("file-1", "tex");
    const socket = b.socket(); socket.fire("open");
    b.api.join("file-2", "tex"); b.api.join("file-1", "tex");
    socket.deliver({ t: "file-closed", fileId: deleted });
    if (deleted === "file-1") b.api.join("file-2", "tex");
    // Deleted opens need not reply at all; don't leave their slots blocking B/A.
    if (deleted === "file-1") {
      socket.deliver({ t: "error", request: "open", fileId: "file-2", code: "COLLAB_ERROR" });
    } else {
      socket.deliver({ t: "opened", fileId: "file-1", doc: "obsolete A", version: 0, role: "viewer" });
    }
    assert.equal(b.api.active(), false);
    const r = new CollabDocument({ fileId: deleted === "file-1" ? "file-2" : "file-1", content: "current" });
    socket.deliver({ t: "opened", fileId: r.fileId, doc: r.text(), version: 0, role: "editor" });
    assert.equal(b.api.fileId(), r.fileId);
    socket.deliver({ t: "opened", fileId: deleted, doc: "late deleted file", version: 30, role: "viewer" });
    socket.deliver({ t: "error", request: "open", fileId: deleted, code: "COLLAB_FILE_NOT_FOUND" });
    assert.equal(b.api.status(), "live");
    b.type({ from: 7, insert: "!" }); b.api.flush();
    const ack = accept(r, b);
    socket.deliver(batch(r, 0)); socket.deliver(ack);
    converged(r, b);
  });
}

test("stale file acks cannot release the current file's in-flight push", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  b.type({ from: 4, insert: "old" }); b.api.flush();
  const oldAck = accept(r, b);
  const other = new CollabDocument({ fileId: "file-2", content: "two" });
  b.join(other);
  b.type({ from: 3, insert: "!" }); b.api.flush();
  b.socket().deliver(oldAck);
  b.type({ from: 4, insert: "?" }); b.api.flush();
  assert.equal(b.socket().of("push").length, 2);
  b.socket().deliver(batch(r, 0));
  assert.equal(b.doc(), "two!?");
  assert.equal(b.version(), 0);
});

test("a short resync during gap recovery still pulls the known missing tail", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  r.reset("restored");
  const resync = { t: "resync", fileId: r.fileId, version: r.version, doc: r.text() };
  remote(r, { from: 8, insert: " tail" });
  b.socket().deliver(batch(r, 1));
  assert.equal(b.socket().last("pull").version, 0);
  b.socket().deliver(resync);
  assert.equal(b.socket().last("pull").version, 1);
  b.socket().deliver(batch(r, 1));
  converged(r, b);
});

test("rapid A-B-A switching ignores the first A open and its updates until the final open", () => {
  const b = browser("local");
  b.api.join("file-1", "tex");
  const socket = b.socket(); socket.fire("open");
  b.api.join("file-2", "tex");
  b.api.join("file-1", "tex");
  socket.deliver({ t: "opened", fileId: "file-1", doc: "stale", version: 0, role: "viewer" });
  assert.equal(b.api.active(), false, "old same-file open must not install editor state");
  socket.deliver({ t: "updates", fileId: "file-1", version: 1, updates: [{
    clientID: "remote", changes: ChangeSet.of({ from: 5, insert: "!" }, 5).toJSON(),
  }] });
  socket.deliver({ t: "opened", fileId: "file-2", doc: "two", version: 0, role: "editor" });
  socket.deliver({ t: "opened", fileId: "file-1", doc: "current", version: 0, role: "editor" });
  assert.equal(b.api.active(), true);
  assert.equal(b.doc(), "current");
  assert.equal(b.api.role(), "editor");
  b.type({ from: 7, insert: "!" }); b.api.flush();
  assert.equal(socket.last("push").version, 0);
});

for (const returnToA of [false, true]) {
  test(`generic open failure retires its request before ${returnToA ? "queued A-B-A" : "opening B"}`, () => {
    const b = browser("local");
    b.api.join("file-1", "tex");
    const socket = b.socket(); socket.fire("open");
    const failure = { t: "error", code: "COLLAB_ERROR", request: "open", fileId: "file-1" };
    if (!returnToA) socket.deliver(failure);
    b.api.join("file-2", "tex");
    if (returnToA) {
      b.api.join("file-1", "tex");
      socket.deliver(failure);
      assert.equal(b.api.status(), "connecting", "an obsolete failure must not alter the current open");
    }
    socket.deliver({ t: "opened", fileId: "file-2", version: 0, doc: "two", role: "editor" });
    const r = returnToA ? room() : new CollabDocument({ fileId: "file-2", content: "two" });
    if (returnToA) socket.deliver({ t: "opened", fileId: r.fileId, version: 0, doc: r.text(), role: "editor" });
    assert.equal(b.api.status(), "live");
    assert.equal(b.api.fileId(), r.fileId);
    assert.equal(b.api.active(), true);
    b.type({ from: b.doc().length, insert: " confirmed" }); b.api.flush();
    const ack = accept(r, b);
    socket.deliver(batch(r, 0)); socket.deliver(ack);
    converged(r, b);
  });
}

for (const request of ["project", "push", "pull"]) {
  test(`generic ${request} error cannot retire a pending open`, () => {
    const b = browser("local");
    const r = room();
    b.api.join(r.fileId, "tex");
    const socket = b.socket(); socket.fire("open");
    // Even an error mentioning the same file isn't an open response. Untagged
    // errors are the existing server protocol for non-open requests.
    socket.deliver({ t: "error", code: "COLLAB_ERROR", request, fileId: r.fileId });
    socket.deliver({ t: "error", code: "COLLAB_ERROR" });
    socket.deliver({ t: "opened", fileId: r.fileId, version: 0, doc: r.text(), role: "editor" });
    assert.equal(b.api.status(), "live");
    assert.equal(b.api.active(), true);
    b.type({ from: 4, insert: "!" }); b.api.flush();
    const ack = accept(r, b);
    socket.deliver(batch(r, 0)); socket.deliver(ack);
    converged(r, b);
  });
}

test("same-file reconnect ignores old socket open, updates, resync, ack and close events", () => {
  const r = room();
  const b = browser("local"); b.join(r);
  const old = b.socket();
  b.api.disconnect(); b.join(r);
  b.type({ from: 4, insert: "!" }); b.api.flush();
  const ack = accept(r, b);
  const current = b.socket();
  old.fire("open");
  assert.equal(current.of("open").length, 1);
  old.deliver({ t: "opened", fileId: r.fileId, doc: "stale", version: 50, role: "viewer" });
  old.deliver(batch(r, 0));
  old.deliver({ t: "resync", fileId: r.fileId, doc: "stale", version: 50 });
  old.deliver(ack);
  old.fire("close", { code: 4403 });
  assert.equal(b.api.status(), "live");
  assert.equal(b.doc(), "abcd!");
  assert.equal(b.version(), 0);
  current.deliver(batch(r, 0)); current.deliver(ack);
  converged(r, b);
});

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

for (const echoFirst of [false, true]) {
  for (const resumeBeforeAck of [false, true]) {
    test(`maintenance preserves an accepted in-flight push and unsent typing (echo first: ${echoFirst}, resume before ack: ${resumeBeforeAck})`, () => {
      const r = room(), b = browser("local"); b.join(r);
      const socket = b.socket();
      b.type({ from: 4, insert: " first" }); b.api.flush();
      const ack = accept(r, b), own = batch(r, 0);
      b.type({ from: 10, insert: " second" });
      socket.deliver({ t: "maintenance", active: true });
      if (echoFirst) socket.deliver(own);
      if (resumeBeforeAck) socket.deliver({ t: "maintenance", active: false });
      b.tick(); b.api.flush();
      assert.equal(socket.of("push").length, 1, "neither notice nor echo is a push ack");
      socket.deliver(ack);
      if (!echoFirst) socket.deliver(own);
      if (!resumeBeforeAck) {
        b.tick(); b.api.flush();
        assert.equal(socket.of("push").length, 1, "ack does not bypass maintenance");
        assert.equal(b.doc(), "abcd first second");
        assert.equal(b.pending(), 1);
        assert.equal(b.api.pending(), true);
        socket.deliver({ t: "maintenance", active: false });
      }
      assert.equal(socket.of("push").length, 2);
      assert.equal(socket.last("push").version, 1);
      assert.equal(socket.last("push").updates.length, 1, "only unsent typing remains");
      const next = accept(r, b);
      socket.deliver(batch(r, 1)); socket.deliver(next);
      assert.equal(r.text(), "abcd first second");
      assert.equal(b.api.pending(), false);
      converged(r, b);
    });
  }
}

for (const refusalAt of ["before pause", "during pause", "after resume"]) {
  test(`tagged maintenance refusal ${refusalAt} keeps real OT edits and resumes through gap recovery`, () => {
    const r = room(), b = browser("local"); b.join(r);
    const socket = b.socket();
    b.type({ from: 4, insert: " first" }); b.api.flush();
    b.type({ from: 10, insert: " second" });
    const refused = { t: "error", code: "MAINTENANCE_MODE", request: "push", fileId: r.fileId };
    if (refusalAt === "before pause") socket.deliver(refused);
    assert.equal(socket.of("push").length, 1, "a refusal is not an invitation to retry immediately");
    socket.deliver({ t: "maintenance", active: true });
    if (refusalAt === "during pause") socket.deliver(refused);
    assert.equal(b.doc(), "abcd first second");
    assert.equal(b.version(), 0);
    assert.equal(b.pending(), 2);
    assert.equal(b.api.pending(), true);
    // Learn a gap while paused; a short pull reply must retain its missing tail.
    remote(r, { from: 0, insert: "remote " });
    const short = batch(r, 0);
    remote(r, { from: r.doc.length, insert: "!" });
    socket.deliver(batch(r, 1));
    assert.equal(socket.last("pull").version, 0, "reads remain available during maintenance");
    b.tick(); b.api.flush();
    assert.equal(socket.of("push").length, 1);
    socket.deliver({ t: "maintenance", active: false });
    socket.deliver(short);
    assert.equal(socket.last("pull").version, 1);
    socket.deliver(batch(r, 1));
    if (refusalAt === "after resume") {
      assert.equal(socket.of("push").length, 1, "resume must retain the in-flight barrier");
      socket.deliver(refused);
    }
    assert.equal(socket.of("push").length, 2, "resume sends exactly one rebased batch");
    assert.equal(socket.last("push").version, 2);
    assert.equal(socket.last("push").updates.length, 2);
    const ack = accept(r, b);
    socket.deliver(batch(r, 2)); socket.deliver(ack);
    assert.equal(r.text(), "remote abcd! first second");
    converged(r, b);
  });
}

test("only a tagged matching push refusal releases the current request", () => {
  const r = room(), b = browser("local"); b.join(r);
  const old = b.socket();
  b.api.disconnect(); b.join(r);
  b.type({ from: 4, insert: " first" }); b.api.flush();
  const socket = b.socket();
  b.type({ from: 10, insert: " second" });
  socket.deliver({ t: "maintenance", active: true });
  const refused = { t: "error", code: "MAINTENANCE_MODE", request: "push", fileId: r.fileId };
  for (const message of [
    { t: "error", code: "MAINTENANCE_MODE" },
    { ...refused, request: "pull" }, { ...refused, request: "open" },
    { ...refused, fileId: "file-2" }, { ...refused, fileId: undefined },
  ]) socket.deliver(message);
  old.deliver(refused);
  old.fire("error"); old.fire("close", { code: 1001 });
  socket.deliver({ t: "maintenance", active: false });
  b.tick(); b.api.flush();
  assert.equal(b.api.status(), "live", "unrelated errors must not disrupt the stream");
  assert.equal(socket.of("push").length, 1);
  socket.deliver(refused);
  assert.equal(socket.of("push").length, 2);
  const ack = accept(r, b);
  socket.deliver(batch(r, 0)); socket.deliver(ack);
  converged(r, b);
});

test("late maintenance refusal from the old file cannot release a new file's push", () => {
  const r = room(), b = browser("local"); b.join(r);
  b.type({ from: 4, insert: " old" }); b.api.flush();
  const other = new CollabDocument({ fileId: "file-2", content: "two" });
  b.join(other);
  b.type({ from: 3, insert: "!" }); b.api.flush();
  const socket = b.socket();
  b.type({ from: 4, insert: "?" });
  socket.deliver({ t: "maintenance", active: true });
  socket.deliver({ t: "error", code: "MAINTENANCE_MODE", request: "push", fileId: r.fileId });
  socket.deliver({ t: "maintenance", active: false });
  b.tick(); b.api.flush();
  assert.equal(socket.of("push").length, 2);
  const ack = accept(other, b);
  socket.deliver(batch(other, 0)); socket.deliver(ack);
  assert.equal(socket.of("push").length, 3);
  const next = accept(other, b);
  socket.deliver(batch(other, 1)); socket.deliver(next);
  converged(other, b);
});

test("real WS authority echoes to sender before ack and dependent peer edits converge", {
  skip: !connectionString, timeout: 15000,
}, async (t) => {
  const fixture = await serverFixture(t, { COLLAB_HEARTBEAT_MS: "60000" });
  const { rows: [user] } = await fixture.pool.query(
    "INSERT INTO users (id, username, email, display_name, system_role) VALUES ($1, 'transport', 'transport@example.test', 'Transport', 'admin') RETURNING *",
    [uuidv7()]
  );
  const cookie = fixture.cookieFor(user);
  const response = await fixture.request("/api/projects", {
    cookie, method: "POST", body: { name: "Transport", data: { project: { nodes: [
      { id: uuidv7(), type: "file", name: "main.tex", content: "abcd" },
    ] } } },
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  const { rows: [file] } = await fixture.pool.query("SELECT id FROM project_files WHERE project_id = $1", [created.project.id]);
  const live = { url: `${fixture.baseUrl.replace("http:", "ws:")}/api/collab`, cookie };
  const a = browser("a", live), b = browser("b", live);
  try {
    a.join({ fileId: file.id }); b.join({ fileId: file.id });
    await until(() => a.api.active() && b.api.active(), "both opened");
    a.socket().hold = (message) => message.t === "pushed";
    a.type({ from: 1, to: 2, insert: "LONG" }); a.api.flush();
    await until(() => a.socket().incoming.some((m) => m.t === "pushed") && b.version() === 1, "first acceptance");
    const stream = a.socket().incoming.filter((m) => ["updates", "pushed"].includes(m.t));
    assert.deepEqual(stream.map((m) => m.t), ["updates", "pushed"], "sender must see confirmation before ack");
    a.type({ from: a.doc().length, insert: "!" }); a.api.flush();
    b.type({ from: 0, insert: "peer " }); b.api.flush();
    await until(() => a.version() === 2 && b.version() === 2, "dependent broadcast while ack held");
    assert.equal(a.socket().of("push").length, 1);
    a.socket().hold = null;
    a.socket().deliver(stream[1]);
    await until(() => a.version() === 3 && b.version() === 3 && !a.pending() && !b.pending(), "convergence");
    const authority = fixture.app.collabRooms.get(file.id);
    assert.equal(authority.text(), "peer aLONGcd!");
    converged(authority, a, b);
    a.socket().send(JSON.stringify({ t: "pull", fileId: file.id, version: 0 }));
    await until(() => a.socket().incoming.some((m) => m.t === "updates" && m.updates.length === 3), "overlapping real pull");
    converged(authority, a, b);
  } finally {
    a.api.disconnect(); b.api.disconnect();
    for (const client of [a, b]) for (const socket of client.sockets) socket.ws?.terminate();
  }
});

for (const returnToA of [false, true]) {
  test(`real WS one-shot file lookup failure followed by ${returnToA ? "A-B-A" : "B"} reaches live and confirms an edit`, {
    skip: !connectionString, timeout: 15000,
  }, async (t) => {
    const fixture = await serverFixture(t, { COLLAB_HEARTBEAT_MS: "60000" });
    const { rows: [user] } = await fixture.pool.query(
      "INSERT INTO users (id, username, email, display_name, system_role) VALUES ($1, 'open-failure', 'open-failure@example.test', 'Open Failure', 'admin') RETURNING *",
      [uuidv7()]
    );
    const cookie = fixture.cookieFor(user);
    const response = await fixture.request("/api/projects", {
      cookie, method: "POST", body: { name: "Open failure", data: { project: { nodes: [
        { id: uuidv7(), type: "file", name: "a.tex", content: "first" },
        { id: uuidv7(), type: "file", name: "b.tex", content: "second" },
      ] } } },
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    const { rows: [a, b] } = await fixture.pool.query("SELECT id FROM project_files WHERE project_id = $1 ORDER BY path", [created.project.id]);
    const client = browser("local", { url: `${fixture.baseUrl.replace("http:", "ws:")}/api/collab`, cookie });
    let failed = false;
    fixture.hooks.beforeQuery = (sql, params) => {
      if (!failed && sql.includes("SELECT id, project_id, path, kind, deleted_at FROM project_files WHERE id = $1") && params[0] === a.id) {
        failed = true;
        throw new Error("injected one-shot file lookup failure");
      }
    };
    try {
      client.join({ fileId: a.id });
      const socket = client.socket();
      // Wait for the actual failed lookup, rather than racing the handshake.
      // For A-B-A, hold only its delivery while the later opens are requested.
      if (returnToA) socket.hold = (message) => message.t === "error";
      await until(() => socket.incoming.some((m) => m.t === "error"), "open failure reply");
      const failure = socket.incoming.find((m) => m.t === "error");
      assert.equal(failed, true);
      assert.equal(failure.code, "COLLAB_ERROR");
      client.api.join(b.id, "tex");
      if (returnToA) {
        client.api.join(a.id, "tex");
        socket.hold = null;
        socket.deliver(failure);
      }
      await until(() => socket.incoming.filter((m) => m.t === "opened").length === (returnToA ? 2 : 1), "successful open replies");
      assert.equal(client.api.status(), "live", "a failed older open must not block successful replies");
      const fileId = returnToA ? a.id : b.id;
      assert.equal(client.api.active(), true);
      assert.equal(client.api.fileId(), fileId);
      assert.equal(failure.request, "open");
      assert.equal(failure.fileId, a.id);
      client.type({ from: client.doc().length, insert: " confirmed" }); client.api.flush();
      await until(() => client.version() === 1 && !client.pending() && socket.incoming.some((m) => m.t === "pushed"), "local edit confirmation");
      const authority = fixture.app.collabRooms.get(fileId);
      assert.equal(authority.text(), `${returnToA ? "first" : "second"} confirmed`);
      converged(authority, client);
    } finally {
      fixture.hooks.beforeQuery = null;
      if (client.socket()) client.socket().hold = null;
      client.api.disconnect();
      for (const socket of client.sockets) socket.ws?.terminate();
    }
  });
}
