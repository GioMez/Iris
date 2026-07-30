/* ===================== Iris · realtime collaboration (OT) ===================== */
// WebSocket transport between the editor and the OT authority on the server.
// The algorithm lives in @codemirror/collab (client) and src/collab.js (server);
// this layer only moves messages and survives a broken link.
//
// One socket per tab carries one room at a time: the file open in the editor.
// The lifecycle is driven by iris-app.js through join()/leave().
//
// Sync loop:
//   * the editor reports pending local updates → push them at the synced version;
//   * a rejected push means the server accepted someone else's updates first, so
//     pull, let @codemirror/collab rebase, and push again;
//   * updates from others arrive unsolicited and are applied straight away;
//   * after a reconnection, pull from the version still held. If the server has
//     dropped that far back in its log it answers with the full document instead.
(function () {
  const RECONNECT_BASE_MS = 700;
  const RECONNECT_MAX_MS = 15000;
  // Server-side revocation and shutdown; reconnecting on these is pointless.
  const CLOSE_REVOKED = 4403;
  // Pacing, overridden by /api/config. Typing stays instant locally whatever
  // these are: they only decide how often this browser talks to the server.
  // Batching keystrokes keeps the round trip well inside the second that reads
  // as immediate while cutting the message rate during fast typing.
  const pacing = { push: 300, presence: 200 };

  const listeners = [];
  const peerListeners = [];
  const buildListeners = [];
  const state = {
    socket: null,
    // The project this tab has open. Watched independently of any document, so
    // build notifications still arrive while looking at the preview with no file
    // in a room.
    project: null,
    // The room the app wants open, kept across reconnections so the session is
    // restored automatically.
    desired: null,       // { fileId, kind }
    joined: null,        // fileId confirmed open by the server
    status: "off",       // off | connecting | live | offline | readonly | revoked | error
    role: null,
    attempt: 0,
    reconnectTimer: 0,
    pushTimer: 0,
    presenceTimer: 0,
    pushing: false,
    peers: [],
  };

  const ed = () => window.IrisEditor;
  function emit() {
    const snapshot = { status: state.status, role: state.role, fileId: state.joined };
    listeners.forEach((fn) => {
      try { fn(snapshot); } catch (err) { console.error("IrisCollab listener failed", err); }
    });
  }
  function emitPeers() {
    peerListeners.forEach((fn) => {
      try { fn(state.peers); } catch (err) { console.error("IrisCollab peer listener failed", err); }
    });
  }
  function setPeers(peers) {
    state.peers = Array.isArray(peers) ? peers : [];
    ed().setPeers(state.peers);
    emitPeers();
  }
  function setStatus(status) {
    if (state.status === status) return;
    state.status = status;
    emit();
  }

  function send(message) {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function socketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/collab`;
  }

  function connect() {
    if (state.socket || (!state.desired && !state.project)) return;
    setStatus("connecting");
    let socket;
    try {
      socket = new WebSocket(socketUrl());
    } catch (err) {
      return scheduleReconnect();
    }
    state.socket = socket;
    socket.addEventListener("open", () => {
      state.attempt = 0;
      // Restore what this tab was watching. After a reconnection this is what
      // brings the session back without the app having to notice.
      if (state.project) send({ t: "project", projectId: state.project });
      if (state.desired) send({ t: "open", fileId: state.desired.fileId });
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      handle(message);
    });
    socket.addEventListener("close", (event) => {
      state.socket = null;
      state.joined = null;
      state.pushing = false;
      clearTimeout(state.pushTimer);
      state.pushTimer = 0;
      clearTimeout(state.presenceTimer);
      state.presenceTimer = 0;
      // Nobody is visible over a dead link; the list is rebuilt on reconnection.
      setPeers([]);
      if (event.code === CLOSE_REVOKED) {
        setStatus("revoked");
        return;
      }
      if (!state.desired && !state.project) return void setStatus("off");
      if (state.desired) setStatus("offline");
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {});
  }

  function scheduleReconnect() {
    if (state.reconnectTimer || (!state.desired && !state.project)) return;
    // Exponential backoff with jitter, so a server restart does not get a
    // synchronised stampede from every open tab.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** state.attempt);
    state.attempt = Math.min(state.attempt + 1, 8);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = 0;
      state.socket = null;
      connect();
    }, delay + Math.random() * 300);
  }

  function isCurrent(fileId) {
    return !!state.desired && state.desired.fileId === fileId;
  }

  function handle(message) {
    if (message.t === "ready") {
      state.sessionId = message.sessionId;
      state.color = message.color;
      return;
    }

    if (message.t === "opened") {
      if (!isCurrent(message.fileId)) {
        // The app moved on while the server was answering.
        send({ t: "close", fileId: message.fileId });
        return;
      }
      state.joined = message.fileId;
      state.role = message.role;
      ed().loadCollab(message.doc, state.desired.kind, { version: message.version });
      setStatus(message.role === "viewer" ? "readonly" : "live");
      // Anything typed before the room opened is now sendable.
      pushPending();
      sendPresence();
      return;
    }

    if (message.t === "peers") {
      if (!isCurrent(message.fileId)) return;
      setPeers(message.peers);
      return;
    }

    if (message.t === "build") {
      if (message.projectId !== state.project) return;
      buildListeners.forEach((fn) => {
        try { fn(message); } catch (err) { console.error("IrisCollab build listener failed", err); }
      });
      return;
    }

    if (message.t === "updates") {
      if (!isCurrent(message.fileId)) return;
      ed().collabReceive(message.updates);
      setStatus(state.role === "viewer" ? "readonly" : "live");
      pushPending();
      return;
    }

    if (message.t === "resync") {
      if (!isCurrent(message.fileId)) return;
      // The server replaced the document (rollback) or our version fell out of
      // its log: local pending edits cannot be rebased and are dropped, which is
      // why only the server may ask for this.
      ed().loadCollab(message.doc, state.desired.kind, { version: message.version });
      setStatus(state.role === "viewer" ? "readonly" : "live");
      sendPresence();
      return;
    }

    if (message.t === "pushed") {
      state.pushing = false;
      if (!isCurrent(message.fileId)) return;
      // Accepted or refused, the next step is the same: pull. On acceptance that
      // confirms our own updates and advances the synced version; on refusal it
      // brings in what got there first so the pending work can be rebased.
      pullNow();
      return;
    }

    if (message.t === "role") {
      if (!isCurrent(message.fileId)) return;
      state.role = message.role;
      setStatus(message.role === "viewer" ? "readonly" : "live");
      document.dispatchEvent(new CustomEvent("iris:collabrole", { detail: { role: message.role } }));
      return;
    }

    if (message.t === "revoked") {
      if (!isCurrent(message.fileId)) return;
      state.desired = null;
      state.joined = null;
      setStatus("revoked");
      document.dispatchEvent(new CustomEvent("iris:collabrevoked"));
      return;
    }

    if (message.t === "error") {
      // A file the server will not share in realtime (not text, not found, or no
      // longer permitted) falls back to the ordinary save path.
      if (["COLLAB_FILE_NOT_FOUND", "COLLAB_NOT_TEXT", "COLLAB_BAD_FILE"].includes(message.code)) {
        state.desired = null;
        state.joined = null;
        setStatus("off");
        document.dispatchEvent(new CustomEvent("iris:collabunavailable"));
        return;
      }
      if (message.code === "COLLAB_READ_ONLY") {
        setStatus("readonly");
        return;
      }
      console.error("Realtime session error", message.code);
      setStatus("error");
    }
  }

  function pullNow() {
    if (!state.joined) return;
    send({ t: "pull", fileId: state.joined, version: ed().collabVersion() });
  }

  // Pushes whatever the editor has pending. One push is in flight at a time: the
  // server only accepts updates based on the version it last confirmed.
  function pushPending() {
    clearTimeout(state.pushTimer);
    state.pushTimer = 0;
    if (state.pushing || !state.joined || state.role === "viewer") return;
    const pending = ed().collabPending();
    if (!pending || !pending.updates.length) return;
    state.pushing = send({ t: "push", fileId: state.joined, version: pending.version, updates: pending.updates });
  }

  // Coalesces a burst of keystrokes into one message. @codemirror/collab keeps
  // accumulating unconfirmed updates meanwhile, so nothing is lost by waiting.
  function schedulePush() {
    if (state.pushTimer || state.pushing || !state.joined || state.role === "viewer") return;
    state.pushTimer = setTimeout(pushPending, pacing.push);
  }

  function sendPresence() {
    clearTimeout(state.presenceTimer);
    state.presenceTimer = 0;
    if (!state.joined) return;
    const selection = ed().selection();
    send({
      t: "presence",
      fileId: state.joined,
      anchor: selection.from,
      head: selection.to,
      version: ed().collabVersion(),
    });
  }

  // Cursor moves are ephemeral, so they are paced on their own budget: losing an
  // intermediate position costs nothing, the next one supersedes it.
  function schedulePresence() {
    if (state.presenceTimer || !state.joined) return;
    state.presenceTimer = setTimeout(sendPresence, pacing.presence);
  }

  // The operator can retune the cadence without a code change.
  function applyPacing(config) {
    if (!config) return;
    if (Number.isFinite(config.pushDebounceMs)) pacing.push = Math.max(0, config.pushDebounceMs);
    if (Number.isFinite(config.presenceDebounceMs)) pacing.presence = Math.max(0, config.presenceDebounceMs);
  }

  window.IrisCollab = {
    // Follows a project for as long as it is open, which is what makes build
    // notifications arrive even with no document in a room.
    watchProject(projectId) {
      if (!projectId || state.project === projectId) return;
      state.project = projectId;
      if (state.socket && state.socket.readyState === WebSocket.OPEN) send({ t: "project", projectId });
      else connect();
    },
    // Opens a realtime session for a file. Only files with a canonical id can be
    // shared, so a document created this session joins after its first save.
    join(fileId, kind) {
      if (!fileId) return;
      if (state.desired && state.desired.fileId === fileId) return;
      if (state.desired) this.leave();
      state.desired = { fileId, kind: kind || null };
      state.attempt = 0;
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        setStatus("connecting");
        send({ t: "open", fileId });
      } else {
        connect();
      }
    },
    leave() {
      const fileId = state.joined || (state.desired && state.desired.fileId);
      if (fileId) send({ t: "close", fileId });
      state.desired = null;
      state.joined = null;
      state.role = null;
      state.pushing = false;
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = 0;
      clearTimeout(state.pushTimer);
      state.pushTimer = 0;
      clearTimeout(state.presenceTimer);
      state.presenceTimer = 0;
      setPeers([]);
      setStatus("off");
    },
    // Closes the transport entirely (leaving the project, signing out).
    disconnect() {
      this.leave();
      state.project = null;
      const socket = state.socket;
      state.socket = null;
      if (socket) {
        try { socket.close(1000, "client left"); } catch (err) {}
      }
    },
    // Sends everything still pending straight away, skipping the debounce.
    flush: pushPending,
    configure: applyPacing,
    pacing() { return { ...pacing }; },
    active() { return !!state.joined; },
    status() { return state.status; },
    role() { return state.role; },
    fileId() { return state.joined; },
    peers() { return state.peers; },
    watching() { return state.project; },
    onStatus(fn) { listeners.push(fn); },
    onPeers(fn) { peerListeners.push(fn); },
    // Fires when any member finishes a compilation of the watched project.
    onBuild(fn) { buildListeners.push(fn); },
  };

  // The editor tells us when it has local updates to send, and where the caret
  // is. Both are paced: the document through the OT stream, the cursor as
  // ephemeral presence.
  ed().onSync(schedulePush);
  ed().onCursor(schedulePresence);
})();
