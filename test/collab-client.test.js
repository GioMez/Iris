// Drives the browser transport (public/iris-collab.js) against a fake WebSocket
// and a fake editor, so the sync state machine is exercised for real: the
// push/reject/pull loop, reconnection with backoff, resync, role changes and
// revocation. The OT algorithm itself is covered in collab.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "../public/iris-collab.js"), "utf8");

function harness() {
  const timers = [];
  const events = [];
  // Records what the editor was asked to do, and what it offers to send.
  const editor = {
    loaded: [],
    received: [],
    peerSets: [],
    version: 0,
    pending: null,
    // Mirrors the adapter: from/to ordered, anchor/head keeping the caret's side.
    cursor: { from: 0, to: 0, text: "", anchor: 0, head: 0 },
    syncHandlers: [],
    cursorHandlers: [],
    loadCollab(doc, kind, opts) {
      editor.loaded.push({ doc, kind, version: opts.version });
      editor.version = opts.version;
      editor.pending = null;
    },
    collabReceive(updates) {
      editor.received.push(updates);
      editor.version += updates.length;
    },
    collabVersion() { return editor.version; },
    collabPending() { return editor.pending; },
    selection() { return editor.cursor; },
    setPeers(peers) { editor.peerSets.push(peers); },
    onSync(fn) { editor.syncHandlers.push(fn); },
    onCursor(fn) { editor.cursorHandlers.push(fn); },
  };

  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.closed = null;
      this.handlers = {};
      sockets.push(this);
    }
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = FakeWebSocket.CLOSED;
    }
    // Test-side helpers.
    fire(type, event = {}) { (this.handlers[type] || []).forEach((fn) => fn(event)); }
    deliver(message) { this.fire("message", { data: JSON.stringify(message) }); }
    messagesOfType(t) { return this.sent.filter((m) => m.t === t); }
    lastOfType(t) { return this.messagesOfType(t).pop() || null; }
  }
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSED = 3;

  const context = {
    WebSocket: FakeWebSocket,
    console: { error() {}, warn() {}, log() {} },
    JSON,
    Math,
    Date,
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout(id) { if (id && timers[id - 1]) timers[id - 1].cleared = true; },
    document: {
      addEventListener() {},
      dispatchEvent(event) { events.push(event); return true; },
    },
  };
  context.window = {
    IrisEditor: editor,
    location: { protocol: "https:", host: "iris.example" },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  return {
    collab: context.window.IrisCollab,
    editor,
    sockets,
    events,
    socket: () => sockets[sockets.length - 1],
    // Runs pending timers (reconnection backoff) that have not been cleared.
    runTimers() {
      const due = timers.filter((timer) => !timer.cleared && !timer.done);
      due.forEach((timer) => { timer.done = true; timer.fn(); });
      return due.length;
    },
    scheduledDelays() {
      return timers.filter((timer) => !timer.cleared && !timer.done).map((timer) => timer.delay);
    },
    // Local typing: the editor now has something to push, and tells the
    // transport, which batches it behind the push debounce.
    typeLocally(updates) {
      editor.pending = { version: editor.version, updates };
      editor.syncHandlers.forEach((fn) => fn());
    },
    // Moving the caret schedules an ephemeral presence report. `opts` drives the
    // caret to the other end of the range, as dragging a selection backwards
    // does.
    moveCursor(from, to = from, opts = {}) {
      const anchor = opts.anchor == null ? from : opts.anchor;
      const head = opts.head == null ? to : opts.head;
      editor.cursor = {
        from: Math.min(anchor, head),
        to: Math.max(anchor, head),
        text: "",
        anchor,
        head,
      };
      editor.cursorHandlers.forEach((fn) => fn({ line: 1, column: from + 1, fromLine: 1, toLine: 1 }));
    },
  };
}

// Opens a live session on one file, as the app does when a document is opened.
function joined(h, { role = "owner", version = 3, doc = "hello" } = {}) {
  h.collab.join("file-1", "tex");
  h.socket().fire("open");
  h.socket().deliver({ t: "ready", clientId: "server-side" });
  h.socket().deliver({ t: "opened", fileId: "file-1", version, doc, role });
  return h.socket();
}

test("joining a file opens the room and loads the authoritative document", () => {
  const h = harness();
  h.collab.join("file-1", "tex");
  assert.equal(h.socket().url, "wss://iris.example/api/collab");
  assert.equal(h.collab.status(), "connecting");

  h.socket().fire("open");
  assert.deepEqual(h.socket().lastOfType("open"), { t: "open", fileId: "file-1" });

  h.socket().deliver({ t: "opened", fileId: "file-1", version: 7, doc: "shared text", role: "editor" });
  assert.deepEqual(h.editor.loaded, [{ doc: "shared text", kind: "tex", version: 7 }]);
  assert.equal(h.collab.status(), "live");
  assert.equal(h.collab.active(), true);
  assert.equal(h.collab.fileId(), "file-1");
});

test("a viewer joins read-only and never pushes", () => {
  const h = harness();
  const socket = joined(h, { role: "viewer" });
  assert.equal(h.collab.status(), "readonly");

  h.typeLocally([{ changes: [1], clientID: "me" }]);
  h.runTimers();
  assert.equal(socket.messagesOfType("push").length, 0, "a viewer must not push updates");
});

test("keystrokes are batched behind the push debounce", () => {
  const h = harness();
  const socket = joined(h, { version: 2 });

  // Typing does not put a message on the wire straight away.
  h.typeLocally([{ changes: [[1, "a"]], clientID: "me" }]);
  assert.equal(socket.messagesOfType("push").length, 0);
  assert.deepEqual(h.scheduledDelays(), [300], "the push waits for the configured debounce");

  // More typing in the same window joins the same batch rather than adding a
  // second timer.
  h.typeLocally([{ changes: [[1, "a"], [2, "b"]], clientID: "me" }]);
  assert.equal(h.scheduledDelays().length, 1);

  h.runTimers();
  const push = socket.lastOfType("push");
  assert.equal(socket.messagesOfType("push").length, 1, "one message carries the whole burst");
  assert.equal(push.updates[0].changes.length, 2);
});

test("the pacing can be retuned from the server configuration", () => {
  const h = harness();
  h.collab.configure({ pushDebounceMs: 900, presenceDebounceMs: 50 });
  assert.equal(h.collab.pacing().push, 900);
  assert.equal(h.collab.pacing().presence, 50);
  joined(h);
  h.typeLocally([{ changes: [1], clientID: "me" }]);
  assert.deepEqual(h.scheduledDelays(), [900]);
});

test("flushing sends everything pending without waiting for the debounce", () => {
  const h = harness();
  const socket = joined(h, { version: 4 });
  h.typeLocally([{ changes: [[1, "x"]], clientID: "me" }]);
  h.collab.flush();
  assert.equal(socket.messagesOfType("push").length, 1);
  assert.equal(socket.lastOfType("push").version, 4);
});

test("local edits are pushed once and confirmed by a pull", () => {
  const h = harness();
  const socket = joined(h, { version: 2 });

  h.typeLocally([{ changes: [[1, "x"]], clientID: "me" }]);
  h.runTimers();
  const push = socket.lastOfType("push");
  assert.equal(push.version, 2);
  assert.equal(push.updates.length, 1);

  // While one push is in flight, further typing must not push again: the server
  // only accepts updates based on the version it last confirmed.
  h.typeLocally([{ changes: [[2, "y"]], clientID: "me" }]);
  h.runTimers();
  assert.equal(socket.messagesOfType("push").length, 1);

  // Accepted: confirming our own updates advances the local synced version.
  socket.deliver({ t: "pushed", fileId: "file-1", accepted: true, version: 3 });
  assert.equal(socket.lastOfType("pull").version, 2);
  socket.deliver({ t: "updates", fileId: "file-1", version: 3, updates: [{ changes: [[1, "x"]], clientID: "me" }] });
  assert.equal(h.editor.version, 3);
});

test("a rejected push pulls, rebases and pushes again", () => {
  const h = harness();
  const socket = joined(h, { version: 5 });
  h.typeLocally([{ changes: [[1, "mine"]], clientID: "me" }]);
  h.runTimers();
  assert.equal(socket.messagesOfType("push").length, 1);

  // Someone else got there first.
  socket.deliver({ t: "pushed", fileId: "file-1", accepted: false, version: 6 });
  assert.equal(socket.lastOfType("pull").version, 5, "must pull from the version it holds");

  // The remote update arrives; the editor rebases and still has work to send.
  h.editor.pending = { version: 6, updates: [{ changes: [[1, "mine"]], clientID: "me" }] };
  socket.deliver({ t: "updates", fileId: "file-1", version: 6, updates: [{ changes: [[1, "theirs"]], clientID: "other" }] });
  assert.equal(h.editor.received.length, 1);
  const pushes = socket.messagesOfType("push");
  assert.equal(pushes.length, 2, "the rebased update must be pushed again");
  assert.equal(pushes[1].version, 6);
});

test("updates from other clients are applied as they arrive", () => {
  const h = harness();
  const socket = joined(h, { version: 1 });
  socket.deliver({
    t: "updates",
    fileId: "file-1",
    version: 3,
    updates: [{ changes: [[1, "a"]], clientID: "other" }, { changes: [[2, "b"]], clientID: "other" }],
  });
  assert.deepEqual(h.editor.received[0].length, 2);
  assert.equal(h.editor.version, 3);
  assert.equal(h.collab.status(), "live");
});

test("a server resync replaces the document without leaving the session", () => {
  const h = harness();
  const socket = joined(h, { version: 4, doc: "before" });
  socket.deliver({ t: "resync", fileId: "file-1", version: 9, doc: "restored" });
  assert.deepEqual(h.editor.loaded[1], { doc: "restored", kind: "tex", version: 9 });
  assert.equal(h.collab.status(), "live");
  assert.equal(h.collab.active(), true);
});

test("a dropped connection reconnects with backoff and restores the room", () => {
  const h = harness();
  const first = joined(h);
  assert.equal(h.sockets.length, 1);

  first.fire("close", { code: 1006 });
  assert.equal(h.collab.status(), "offline");
  const delays = h.scheduledDelays();
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 700 && delays[0] < 1100, `unexpected first backoff ${delays[0]}`);

  // The reconnection re-opens the same room, and the server's answer restores the
  // session at the authoritative version.
  h.runTimers();
  assert.equal(h.sockets.length, 2);
  h.socket().fire("open");
  assert.deepEqual(h.socket().lastOfType("open"), { t: "open", fileId: "file-1" });
  h.socket().deliver({ t: "opened", fileId: "file-1", version: 12, doc: "moved on", role: "owner" });
  assert.equal(h.collab.status(), "live");
  assert.equal(h.editor.version, 12);
});

test("repeated failures back off further, and a successful open resets the delay", () => {
  const h = harness();
  joined(h);
  const seen = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    h.socket().fire("close", { code: 1006 });
    seen.push(h.scheduledDelays().pop());
    h.runTimers();
  }
  assert.ok(seen[1] > seen[0] && seen[2] > seen[1], `backoff must grow: ${seen.join(", ")}`);

  // A completed handshake resets the attempt counter.
  h.socket().fire("open");
  h.socket().deliver({ t: "opened", fileId: "file-1", version: 1, doc: "x", role: "owner" });
  h.socket().fire("close", { code: 1006 });
  const next = h.scheduledDelays().pop();
  assert.ok(next < seen[1], `delay must reset after a successful open, got ${next}`);
});

test("revocation ends the session and does not reconnect", () => {
  const h = harness();
  const socket = joined(h);
  socket.deliver({ t: "revoked", fileId: "file-1" });
  assert.equal(h.collab.status(), "revoked");
  assert.equal(h.collab.active(), false);
  assert.ok(h.events.some((event) => event.type === "iris:collabrevoked"));

  socket.fire("close", { code: 4403 });
  assert.equal(h.scheduledDelays().length, 0, "a revoked session must not be retried");
  assert.equal(h.sockets.length, 1);
});

test("a closed socket with the revocation code stops the retry loop", () => {
  const h = harness();
  const socket = joined(h);
  socket.fire("close", { code: 4403 });
  assert.equal(h.collab.status(), "revoked");
  assert.equal(h.scheduledDelays().length, 0);
});

test("losing write access mid-session switches to read-only in place", () => {
  const h = harness();
  const socket = joined(h, { role: "owner" });
  socket.deliver({ t: "role", fileId: "file-1", role: "viewer" });
  assert.equal(h.collab.status(), "readonly");
  assert.equal(h.collab.role(), "viewer");
  const roleEvent = h.events.find((event) => event.type === "iris:collabrole");
  assert.equal(roleEvent.detail.role, "viewer");

  h.typeLocally([{ changes: [1], clientID: "me" }]);
  h.runTimers();
  assert.equal(socket.messagesOfType("push").length, 0);
});

test("a file the server will not share falls back to the ordinary save path", () => {
  const h = harness();
  const socket = joined(h);
  socket.deliver({ t: "error", code: "COLLAB_NOT_TEXT" });
  assert.equal(h.collab.status(), "off");
  assert.equal(h.collab.active(), false);
  assert.ok(h.events.some((event) => event.type === "iris:collabunavailable"));
});

test("switching file leaves the old room and opens the new one on the same socket", () => {
  const h = harness();
  const socket = joined(h);
  h.collab.join("file-2", "ly");
  assert.deepEqual(socket.lastOfType("close"), { t: "close", fileId: "file-1" });
  assert.deepEqual(socket.lastOfType("open"), { t: "open", fileId: "file-2" });
  assert.equal(h.sockets.length, 1, "the transport must be reused");

  socket.deliver({ t: "opened", fileId: "file-2", version: 1, doc: "score", role: "owner" });
  assert.equal(h.collab.fileId(), "file-2");
  // A late answer for the room we already left must not be adopted.
  socket.deliver({ t: "opened", fileId: "file-1", version: 99, doc: "stale", role: "owner" });
  assert.equal(h.collab.fileId(), "file-2");
  assert.equal(h.editor.version, 1);
});

test("messages for a file that is no longer open are ignored", () => {
  const h = harness();
  const socket = joined(h, { version: 2 });
  h.collab.join("file-2", "tex");
  socket.deliver({ t: "opened", fileId: "file-2", version: 5, doc: "two", role: "owner" });

  const receivedBefore = h.editor.received.length;
  socket.deliver({ t: "updates", fileId: "file-1", version: 3, updates: [{ changes: [1], clientID: "other" }] });
  assert.equal(h.editor.received.length, receivedBefore, "updates for a closed room must be dropped");
});

test("leaving tells the server and stops tracking the room", () => {
  const h = harness();
  const socket = joined(h);
  h.collab.leave();
  assert.deepEqual(socket.lastOfType("close"), { t: "close", fileId: "file-1" });
  assert.equal(h.collab.active(), false);
  assert.equal(h.collab.status(), "off");

  // A close arriving afterwards is not a dropped connection to retry.
  socket.fire("close", { code: 1006 });
  assert.equal(h.scheduledDelays().length, 0);
});

test("disconnecting closes the transport itself", () => {
  const h = harness();
  const socket = joined(h);
  h.collab.disconnect();
  assert.equal(socket.closed.code, 1000);
  assert.equal(h.collab.status(), "off");
});

/* ---- presence ---- */

test("joining reports where the caret is", () => {
  const h = harness();
  const socket = joined(h, { version: 6 });
  const presence = socket.lastOfType("presence");
  assert.equal(presence.fileId, "file-1");
  assert.equal(presence.version, 6, "the position is stamped with the version it refers to");
});

test("caret moves are paced on their own budget and coalesced", () => {
  const h = harness();
  const socket = joined(h);
  const before = socket.messagesOfType("presence").length;

  h.moveCursor(10, 14);
  assert.equal(socket.messagesOfType("presence").length, before, "not sent straight away");
  assert.deepEqual(h.scheduledDelays(), [200]);

  // Intermediate positions are dropped: only the latest one matters.
  h.moveCursor(20, 20);
  assert.equal(h.scheduledDelays().length, 1);
  h.runTimers();
  const sent = socket.lastOfType("presence");
  assert.equal(sent.anchor, 20);
  assert.equal(sent.head, 20);
  assert.equal(socket.messagesOfType("presence").length, before + 1);
});

test("a selection is reported as a range, not just a caret", () => {
  const h = harness();
  const socket = joined(h);
  h.moveCursor(4, 19);
  h.runTimers();
  const sent = socket.lastOfType("presence");
  assert.equal(sent.anchor, 4);
  assert.equal(sent.head, 19);
});

test("a selection dragged backwards keeps the caret where the drag ended", () => {
  const h = harness();
  const socket = joined(h);
  h.moveCursor(0, 0, { anchor: 19, head: 4 });
  h.runTimers();
  const sent = socket.lastOfType("presence");
  // Reporting the ordered pair would put everyone's cursor at the end of their
  // selection, whichever way they actually dragged it.
  assert.equal(sent.anchor, 19);
  assert.equal(sent.head, 4);
});

test("the participant list is handed to the editor", () => {
  const h = harness();
  const socket = joined(h);
  const peers = [
    { id: "s1", userId: "u1", name: "Ada", color: "#7aa2f7", role: "editor", anchor: 3, head: 7 },
    { id: "s2", userId: "u2", name: "Bo", color: "#9ece6a", role: "viewer", anchor: 40, head: 40 },
  ];
  socket.deliver({ t: "peers", fileId: "file-1", peers });
  assert.deepEqual(h.editor.peerSets.pop(), peers);
  assert.equal(h.collab.peers().length, 2);
});

test("participants of a file that is no longer open are ignored", () => {
  const h = harness();
  const socket = joined(h);
  h.collab.join("file-2", "tex");
  const sets = h.editor.peerSets.length;
  socket.deliver({ t: "peers", fileId: "file-1", peers: [{ id: "s1", userId: "u1", name: "Ada" }] });
  assert.equal(h.editor.peerSets.length, sets, "a stale room's participants must not be drawn");
});

test("nobody is shown as present over a dead or closed connection", () => {
  const h = harness();
  const socket = joined(h);
  socket.deliver({ t: "peers", fileId: "file-1", peers: [{ id: "s1", userId: "u1", name: "Ada" }] });
  assert.equal(h.collab.peers().length, 1);

  socket.fire("close", { code: 1006 });
  assert.equal(h.collab.peers().length, 0, "a dropped link clears the participants");
  assert.equal(h.editor.peerSets.pop().length, 0);

  // Leaving clears them too, rather than leaving ghosts on the previous file.
  h.runTimers();
  h.socket().fire("open");
  h.socket().deliver({ t: "opened", fileId: "file-1", version: 1, doc: "x", role: "owner" });
  h.socket().deliver({ t: "peers", fileId: "file-1", peers: [{ id: "s1", userId: "u1", name: "Ada" }] });
  assert.equal(h.collab.peers().length, 1);
  h.collab.leave();
  assert.equal(h.collab.peers().length, 0);
});

test("a resync re-reports the caret at the new version", () => {
  const h = harness();
  const socket = joined(h, { version: 2 });
  const before = socket.messagesOfType("presence").length;
  socket.deliver({ t: "resync", fileId: "file-1", version: 30, doc: "restored" });
  const sent = socket.lastOfType("presence");
  assert.equal(socket.messagesOfType("presence").length, before + 1);
  assert.equal(sent.version, 30);
});

/* ---- edits the server has not confirmed yet ---- */

test("an edit counts as unconfirmed until it comes back from the server", () => {
  const h = harness();
  const socket = joined(h);
  const seen = [];
  h.collab.onStatus((snapshot) => seen.push(snapshot.pending));
  assert.equal(h.collab.pending(), false);

  h.typeLocally([{ changes: [[1, "a"]], clientID: "me" }]);
  assert.equal(h.collab.pending(), true, "unconfirmed from the moment it is typed, not when it is sent");
  assert.deepEqual(seen, [true], "the state is announced, not only polled");

  h.runTimers();
  assert.equal(h.collab.pending(), true, "still unconfirmed while the push is in flight");

  socket.deliver({ t: "pushed", fileId: "file-1", accepted: true, version: 4 });
  assert.equal(h.collab.pending(), true, "acceptance is not confirmation until the update returns");

  // Receiving the update is what lets @codemirror/collab retire it.
  h.editor.pending = null;
  socket.deliver({ t: "updates", fileId: "file-1", version: 4, updates: [{ changes: [[1, "a"]], clientID: "me" }] });
  assert.equal(h.collab.pending(), false);
  assert.deepEqual(seen, [true, false]);
});

test("unconfirmed work stays unconfirmed when the link drops", () => {
  const h = harness();
  const socket = joined(h);
  h.typeLocally([{ changes: [[1, "a"]], clientID: "me" }]);
  socket.fire("close", { code: 1006 });
  // The edit is still sitting in this tab: the dead link does not settle it.
  assert.equal(h.collab.status(), "offline");
  assert.equal(h.collab.pending(), true);
});

test("leaving the room leaves nothing to confirm", () => {
  const h = harness();
  joined(h);
  h.typeLocally([{ changes: [[1, "a"]], clientID: "me" }]);
  assert.equal(h.collab.pending(), true);
  h.collab.leave();
  assert.equal(h.collab.pending(), false);
});

test("a viewer never has anything pending", () => {
  const h = harness();
  joined(h, { role: "viewer" });
  h.typeLocally([{ changes: [[1, "a"]], clientID: "me" }]);
  assert.equal(h.collab.pending(), false, "a viewer's editor cannot produce work for the server");
});

/* ---- presence in the project's other files ---- */

const FILE_PRESENCE = [{ fileId: "file-2", peers: [{ userId: "u2", name: "Bo", color: "#9ece6a" }] }];

function watching(h, projectId = "p-1") {
  h.collab.watchProject(projectId);
  h.socket().fire("open");
  return h.socket();
}

test("who is in the project's other files arrives on the project channel", () => {
  const h = harness();
  const socket = watching(h);
  const seen = [];
  h.collab.onFilePeers((files) => seen.push(files));
  socket.deliver({ t: "filepeers", projectId: "p-1", files: FILE_PRESENCE });
  assert.deepEqual(h.collab.filePeers(), FILE_PRESENCE);
  assert.deepEqual(seen, [FILE_PRESENCE]);
  // It does not depend on having a document open: that is the point of it.
  assert.equal(h.collab.active(), false);
});

test("file presence for another project is ignored", () => {
  const h = harness();
  const socket = watching(h);
  socket.deliver({ t: "filepeers", projectId: "p-other", files: FILE_PRESENCE });
  assert.equal(h.collab.filePeers().length, 0);
});

test("no file is shown as occupied over a dead connection", () => {
  const h = harness();
  const socket = watching(h);
  socket.deliver({ t: "filepeers", projectId: "p-1", files: FILE_PRESENCE });
  socket.fire("close", { code: 1006 });
  assert.equal(h.collab.filePeers().length, 0, "the list is rebuilt on reconnection");
});

test("switching project drops the previous project's file presence", () => {
  const h = harness();
  const socket = watching(h);
  socket.deliver({ t: "filepeers", projectId: "p-1", files: FILE_PRESENCE });
  h.collab.watchProject("p-2");
  assert.equal(h.collab.filePeers().length, 0);
});

/* ---- build notifications ---- */

test("watching a project connects even with no document open", () => {
  const h = harness();
  h.collab.watchProject("p-1");
  assert.equal(h.sockets.length, 1, "the transport connects for the project alone");
  h.socket().fire("open");
  assert.deepEqual(h.socket().lastOfType("project"), { t: "project", projectId: "p-1" });
  assert.equal(h.collab.watching(), "p-1");
  // No room was joined, so nothing claims to be editing.
  assert.equal(h.collab.active(), false);
});

test("a finished compilation is reported to the project's watchers", () => {
  const h = harness();
  const seen = [];
  h.collab.onBuild((build) => seen.push(build));
  h.collab.watchProject("p-1");
  h.socket().fire("open");

  h.socket().deliver({ t: "build", projectId: "p-1", buildId: "b-9", status: "succeeded", by: "Ada" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].buildId, "b-9");
  assert.equal(seen[0].by, "Ada");

  // A failed build is reported too: it is still newer than what is on screen.
  h.socket().deliver({ t: "build", projectId: "p-1", buildId: "b-10", status: "failed", by: "Bo" });
  assert.equal(seen[1].status, "failed");
});

test("builds of another project are ignored", () => {
  const h = harness();
  const seen = [];
  h.collab.onBuild((build) => seen.push(build));
  h.collab.watchProject("p-1");
  h.socket().fire("open");
  h.socket().deliver({ t: "build", projectId: "p-other", buildId: "b-1", status: "succeeded" });
  assert.equal(seen.length, 0);
});

test("the watched project is restored after a reconnection", () => {
  const h = harness();
  h.collab.watchProject("p-1");
  h.socket().fire("open");
  h.socket().fire("close", { code: 1006 });
  // Watching alone is enough to keep retrying: the notice must not go quiet
  // just because no document happened to be open.
  assert.equal(h.scheduledDelays().length, 1);
  h.runTimers();
  h.socket().fire("open");
  assert.deepEqual(h.socket().lastOfType("project"), { t: "project", projectId: "p-1" });
});

test("both the project and the room are restored together", () => {
  const h = harness();
  h.collab.watchProject("p-1");
  joined(h);
  h.socket().fire("close", { code: 1006 });
  h.runTimers();
  h.socket().fire("open");
  assert.deepEqual(h.socket().lastOfType("project"), { t: "project", projectId: "p-1" });
  assert.deepEqual(h.socket().lastOfType("open"), { t: "open", fileId: "file-1" });
});

test("disconnecting stops watching the project", () => {
  const h = harness();
  const seen = [];
  h.collab.onBuild((build) => seen.push(build));
  h.collab.watchProject("p-1");
  h.socket().fire("open");
  const socket = h.socket();
  h.collab.disconnect();
  assert.equal(h.collab.watching(), null);
  socket.deliver({ t: "build", projectId: "p-1", buildId: "b-1", status: "succeeded" });
  assert.equal(seen.length, 0);
});

test("leaving a file keeps watching the project", () => {
  const h = harness();
  h.collab.watchProject("p-1");
  const socket = joined(h);
  h.collab.leave();
  assert.equal(h.collab.watching(), "p-1", "closing a document must not silence build notices");
  const seen = [];
  h.collab.onBuild((build) => seen.push(build));
  socket.deliver({ t: "build", projectId: "p-1", buildId: "b-1", status: "succeeded" });
  assert.equal(seen.length, 1);
});

test("joining the file already open is a no-op", () => {
  const h = harness();
  const socket = joined(h);
  const opens = socket.messagesOfType("open").length;
  h.collab.join("file-1", "tex");
  assert.equal(socket.messagesOfType("open").length, opens);
  assert.equal(h.collab.status(), "live");
});
