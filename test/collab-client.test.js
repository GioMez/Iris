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
    version: 0,
    pending: null,
    syncHandlers: [],
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
    onSync(fn) { editor.syncHandlers.push(fn); },
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
      return timers.filter((timer) => !timer.cleared).map((timer) => timer.delay);
    },
    // Local typing: the editor now has something to push, and tells the transport.
    typeLocally(updates) {
      editor.pending = { version: editor.version, updates };
      editor.syncHandlers.forEach((fn) => fn());
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
  assert.equal(socket.messagesOfType("push").length, 0, "a viewer must not push updates");
});

test("local edits are pushed once and confirmed by a pull", () => {
  const h = harness();
  const socket = joined(h, { version: 2 });

  h.typeLocally([{ changes: [[1, "x"]], clientID: "me" }]);
  const push = socket.lastOfType("push");
  assert.equal(push.version, 2);
  assert.equal(push.updates.length, 1);

  // While one push is in flight, further typing must not push again: the server
  // only accepts updates based on the version it last confirmed.
  h.typeLocally([{ changes: [[2, "y"]], clientID: "me" }]);
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

test("joining the file already open is a no-op", () => {
  const h = harness();
  const socket = joined(h);
  const opens = socket.messagesOfType("open").length;
  h.collab.join("file-1", "tex");
  assert.equal(socket.messagesOfType("open").length, opens);
  assert.equal(h.collab.status(), "live");
});
