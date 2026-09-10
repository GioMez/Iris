// Guards the places where the realtime layer has to be connected to the rest of
// the server. These are the invariants that are cheap to break by editing an
// unrelated handler and expensive to notice: an unauthenticated upgrade, a
// permission change that never reaches an open session, or a room whose text
// never reaches disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const server = read("src/server.js");
const app = read("public/iris-app.js");
const editor = read("public/iris-editor.js");
const html = read("public/Iris.html");
const css = read("public/iris.css");

test("the WebSocket upgrade authenticates before accepting the socket", () => {
  const upgrade = server.slice(server.indexOf("async function collabUpgrade"), server.indexOf("function collabAttach"));
  // requireUser re-reads the account from the database on every call, so a
  // disabled account or a bumped session epoch cannot open a realtime session.
  assert.match(upgrade, /await requireUser\(req\)/);
  const authIndex = upgrade.indexOf("requireUser");
  const acceptIndex = upgrade.indexOf("handleUpgrade");
  assert.ok(authIndex !== -1 && acceptIndex !== -1 && authIndex < acceptIndex,
    "handleUpgrade must run only after the request is authenticated");
  assert.match(upgrade, /401 Unauthorized/);
  // Maintenance and shutdown refuse new realtime work like any other mutation.
  assert.match(upgrade, /shuttingDown \|\| maintenanceActive\(\)/);
  // Only the collaboration endpoint is upgradable; anything else is dropped.
  assert.match(server, /if \(url\.pathname !== COLLAB_PATH\) \{\s*socket\.destroy\(\);/);
  assert.match(server, /new WebSocketServer\(\{ noServer: true, maxPayload: COLLAB_MAX_MESSAGE_BYTES \}\)/);
});

test("joining a room checks project membership and hides unauthorised files", () => {
  const join = server.slice(server.indexOf("async function collabJoin"), server.indexOf("function collabLeave"));
  assert.match(join, /collabMembership\(file\.project_id, session\.user\.sub\)/);
  // A non-member gets the same answer as for a file that does not exist.
  const notFound = join.match(/COLLAB_FILE_NOT_FOUND/g) || [];
  assert.ok(notFound.length >= 2, "a non-member must not be able to probe for existing files");
  assert.match(join, /if \(file\.kind === "img" \|\| file\.kind === "font"\) throw new CollabError\("COLLAB_NOT_TEXT"\)/);
  // Membership is read per join, not taken from the connection's cached role.
  assert.match(server, /async function collabMembership\(projectId, userId\)/);
  assert.match(server, /FROM projects p JOIN project_members m ON m\.project_id = p\.id/);
});

test("only a member with write capability may push updates", () => {
  const handler = server.slice(server.indexOf("async function collabHandleMessage"), server.indexOf("function collabCloseSession"));
  assert.match(handler, /if \(!roleHasCapability\(entry\.role, "write"\)\) throw new CollabError\("COLLAB_READ_ONLY"\)/);
  // Reading, writing and reporting a caret all require this session to have
  // joined the room, which is where membership was checked.
  // Room membership and post-wait identity checks are exercised by the
  // session-collab and room-lifecycle behavior tests.
});

test("every membership mutation re-checks open realtime sessions", () => {
  // One recheck per mutation site: share, role change and removal, each in the
  // owner console and the admin console, plus ownership lost when an account
  // becomes external. Committed project deletion now
  // invalidates rooms synchronously; room-lifecycle.test.js exercises both routes.
  const calls = server.match(/await collabRecheckProject\(/g) || [];
  assert.equal(calls.length, 7, `expected a recheck at every membership mutation site, found ${calls.length}`);
  const recheck = server.slice(server.indexOf("async function collabRecheckProject"), server.indexOf("// Stamps the authoritative text"));
  // Losing membership closes the session; losing write only downgrades it.
  assert.match(recheck, /collabSend\(session\.socket, \{ t: "revoked", fileId \}\)/);
  assert.match(recheck, /collabCloseSession\(session, 4403, "permission revoked"\)/);
  assert.match(recheck, /collabSend\(session\.socket, \{ t: "role", fileId, role: project\.role \}\)/);
});

test("realtime text reaches disk on a debounce, on last leave and on shutdown", () => {
  assert.match(server, /const COLLAB_FLUSH_MS = positiveIntEnv\("COLLAB_FLUSH_MS", 2000\)/);
  assert.match(server, /const COLLAB_FLUSH_MAX_MS = positiveIntEnv\("COLLAB_FLUSH_MAX_MS", 15000\)/);
  // A continuously edited room cannot postpone its write for ever.
  assert.match(server, /if \(!room\.flushDeadline\) room\.flushDeadline = now \+ COLLAB_FLUSH_MAX_MS/);
  // The last participant flushes and records the consolidated revision.
  const leave = server.slice(server.indexOf("function collabLeave"), server.indexOf("// Tracks in-flight persistence"));
  assert.match(leave, /collabPersist\(room, \{ revision: true \}\)/);
  // Retirement must also check room identity; the lifecycle tests cover an old
  // completion racing with a replacement room.
  // Shutdown drains what the debounce has not written yet.
  assert.match(server, /await collabShutdown\(\)/);
  // Runtime lifecycle tests hold final touches and room persistence across drain.
  assert.match(server, /await Promise\.allSettled\(\[\.\.\.collabPending, \.\.\.collabStarted\]\)/);
  assert.match(server, /collabAttach\(server\)/);
  // Realtime edits are consolidated, not one revision per keystroke.
  assert.match(server, /reason: "realtime"/);
  assert.ok(fs.existsSync(path.join(root, "db/migrations/013_realtime_revisions.sql")));
  assert.match(read("db/migrations/013_realtime_revisions.sql"), /'realtime'/);
});

// Save/restore authority and omitted-content persistence are exercised against
// real PostgreSQL and filesystem I/O in project-mutations.test.js.

test("the client only sends content for files it edited", () => {
  assert.match(app, /function snapshotNodes\(nodes\)/);
  assert.match(app, /state\.dirtyFiles\.has\(node\.id\) \|\| isRealtimeFile\(node\.id\)/);
  assert.match(app, /const \{ content, \.\.\.rest \} = node;/);
  // Reopening a project must not be served from a content-stripped cache.
  const projects = read("public/iris-projects.js");
  const loadData = projects.slice(projects.indexOf("async function loadData"), projects.indexOf("async function refreshCurrent"));
  assert.doesNotMatch(loadData, /cache\.has\(id\)/);
});

test("a realtime document is the server's to persist, not the user's to save", () => {
  const wiring = app.slice(app.indexOf("function wireEditorEvents"), app.indexOf("/* ---------------- realtime session"));
  // An edit in a session is not unsaved work: no dirty flag, no autosave.
  assert.match(wiring, /if \(!realtime\) markFileDirty\(f\.id\)/);
  assert.match(wiring, /if \(!realtime\) schedulePersist\(\)/);
  // The local tree still follows the document, for the outline and the compiler.
  assert.match(wiring, /f\.content = ed\(\)\.getValue\(\)/);
  // Losing write access mid-session drops the workspace to read-only in place.
  assert.match(wiring, /iris:collabrole/);
  assert.match(wiring, /applyRoleGate\(\)/);
});

test("the session follows the open file and ends with the project", () => {
  assert.match(app, /function syncRealtimeSession\(\)/);
  // Realtime needs the canonical id a save assigns, so the join is retried then.
  assert.match(app, /syncRealtimeSession\(\);\s*return true;/);
  assert.match(app, /window\.IrisCollab\.disconnect\(\)/);
  const cancel = app.slice(app.indexOf("function cancelPendingProjectLoad"), app.indexOf("function buildLog"));
  assert.match(cancel, /disconnect/);
});

test("the editor exposes the collab stream and the app shows its state", () => {
  assert.match(editor, /import\("@codemirror\/collab"\)/);
  assert.match(editor, /CO\.collab\(\{ startVersion: collabVersion, clientID \}\)/);
  assert.match(editor, /CO\.sendableUpdates\(view\.state\)/);
  assert.match(editor, /CO\.receiveUpdates\(view\.state/);
  assert.match(editor, /CO\.getSyncedVersion\(view\.state\)/);
  // Remote updates carry no sendable work, so only local edits ask for a push.
  assert.match(editor, /if \(collaborative && update\.docChanged && CO\.sendableUpdates\(update\.state\)\.length\) emit\("sync"\)/);
  // Minimal but present UI: one status chip, announced to assistive technology.
  assert.match(html, /id="stSync"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(app, /function renderSyncStatus\(snapshot\)/);
  assert.match(css, /\.sb-sync\[data-sync="live"\]/);
  assert.match(css, /prefers-reduced-motion/);
  ["connecting", "live", "readonly", "offline", "revoked", "error"].forEach((key) => {
    assert.match(read("public/locales/en/translation.json"), new RegExp(`"${key}":`));
    assert.match(read("public/locales/it/translation.json"), new RegExp(`"${key}":`));
  });
});

/* ---- presence (phase 7) ---- */

test("presence is ephemeral and scoped to the room", () => {
  // It is never written to disk, never versioned and never replayed: it only
  // exists on the live sessions of a room.
  const code = server.split("\n").filter((line) => !line.trim().startsWith("//"));
  const persisted = code.filter((line) => /presence/i.test(line) && /(db\.query|fs\.writeFile|INSERT |UPDATE )/.test(line));
  assert.deepEqual(persisted, [], "presence must never reach the database or the disk");
  const roomPeers = server.slice(server.indexOf("function collabRoomPeers"), server.indexOf("function collabBroadcastPeers"));
  assert.match(roomPeers, /color: peerColor\(client\.user\.sub\)/);
  // A participant is told about the others only. The list is built once per
  // broadcast and each recipient is removed from their own copy by connection
  // id, so nobody needs an identity of their own to filter themselves out.
  const broadcast = server.slice(server.indexOf("function collabBroadcastPeers"), server.indexOf("// Presence reports arrive continuously"));
  assert.match(broadcast, /peers: all\.filter\(\(peer\) => peer\.id !== client\.id\)/);
  // Joining the room already required membership, so presence cannot reach
  // anyone who could not read the file anyway.
  assert.match(server, /const presence = normalizePresence\(message, entry\.room\.doc\.length\)/);
});

test("the participant list is rebroadcast whenever it can have changed", () => {
  // Joining, leaving, moving the caret and a role change all refresh it.
  const calls = server.match(/collabSchedulePeers\(/g) || [];
  assert.ok(calls.length >= 5, `expected a broadcast at every change, found ${calls.length}`);
  const leave = server.slice(server.indexOf("function collabLeave"), server.indexOf("// Tracks in-flight persistence"));
  assert.match(leave, /if \(room\.clients\.size\) return void collabSchedulePeers\(room, true\)/);
  // A caret move is coalesced onto the next tick; a join, a leave and a role
  // change are not, because a user is waiting to see each of them confirmed.
  const presenceMessage = server.slice(server.indexOf('if (message.t === "presence")'), server.indexOf('if (message.t === "pull")'));
  assert.match(presenceMessage, /collabSchedulePeers\(entry\.room\)\s*;/);
  assert.doesNotMatch(presenceMessage, /collabSchedulePeers\(entry\.room, true\)/);
  // Each connection is its own participant: the same person in two tabs shows
  // two carets, which is what the others should see.
  assert.match(server, /const session = \{ id: uuidv7\(\)/);
});

test("peer positions follow the text they pointed at", () => {
  const field = editor.slice(editor.indexOf("const peersEffect"), editor.indexOf("// Line number (1-based)"));
  // Association 1 keeps a peer's caret after the text that peer is typing.
  assert.match(field, /anchor: tr\.changes\.mapPos\(peer\.anchor, 1\)/);
  assert.match(field, /head: tr\.changes\.mapPos\(peer\.head, 1\)/);
  // A fresh list from the server replaces the mapped one rather than being
  // mapped on top of it.
  assert.match(field, /for \(const effect of tr\.effects\) if \(effect\.is\(peersEffect\)\) return effect\.value/);
  // Incoming positions are clamped to this document before being drawn.
  assert.match(editor, /const rebased = rebasePeerPos\(value, version\);/);
  assert.match(editor, /return rebased == null \? null : Math\.max\(0, Math\.min\(max, rebased\)\)/);
});

test("the lines other participants are on are marked in the editor", () => {
  assert.match(editor, /class PeerMarker extends V\.GutterMarker/);
  assert.match(editor, /const peerGutter = V\.gutter\(\{/);
  assert.match(editor, /class: "cm-iris-peer-line"/);
  // The marker is keyed so CodeMirror can tell two states of a line apart.
  assert.match(editor, /eq\(other\) \{ return other\.key === this\.key; \}/);
  assert.match(css, /\.cm-host \.cm-iris-peer-gutter\{/);
  assert.match(css, /\.cm-host \.cm-iris-peer-line\{/);
  assert.match(css, /\.cm-host \.cm-iris-peer-mark\{/);
});

test("the footer names who else is in the file and warns about overlap", () => {
  assert.match(html, /id="stPeers"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(app, /function renderPresence\(peers\)/);
  // One entry per person even when they have several tabs open.
  assert.match(app, /function peopleFromPeers\(peers\)/);
  assert.match(app, /const key = peer\.userId \|\| peer\.id/);
  // The warning is advisory: it names the risk and blocks nothing. What counts
  // as "the same area" is covered on its own further down.
  assert.match(app, /function overlappingPeers\(peers\)/);
  assert.match(app, /OVERLAP_LINES/);
  assert.match(app, /collab\.overlapWarning/);
  assert.doesNotMatch(app, /overlap[^\n]*(disabled|readOnly|preventDefault)/i);
  // Moving onto a busy line updates the warning without the participants
  // themselves having changed.
  assert.match(app, /if \(lastPeers\.length\) renderPresence\(lastPeers\)/);
  assert.match(css, /\.sb-peers \.peer-dot\{/);
  assert.match(css, /\.sb-peers\.overlap\{/);
  ["someone", "peersTitle", "overlapWarning"].forEach((key) => {
    assert.match(read("public/locales/en/translation.json"), new RegExp(`"${key}":`));
    assert.match(read("public/locales/it/translation.json"), new RegExp(`"${key}":`));
  });
});

test("a participant's selection is drawn over the range it covers", () => {
  const collab = read("public/iris-collab.js");
  // The caret's own side of the range goes on the wire: reporting the ordered
  // pair would put every remote cursor at the end of its selection.
  assert.match(collab, /anchor: selection\.anchor/);
  assert.match(collab, /head: selection\.head/);
  assert.match(editor, /anchor: range\.anchor,\s*\n\s*head: range\.head,/);
  // One decoration per participant however long the selection is.
  assert.match(editor, /const peerSelections = V\.EditorView\.decorations\.compute/);
  assert.match(editor, /class: "cm-iris-peer-selection"/);
  assert.match(editor, /peerSelections,/, "the extension has to be in the editor's configuration");
  // A bare caret has no range to shade, so it produces no mark.
  assert.match(editor, /if \(!range \|\| range\.to === range\.from\) return/);
  // The caret line stays the one the head is on, whichever way it was dragged.
  assert.match(editor, /function peerRange\(state, peer\)/);
  assert.match(editor, /return \{ from: Math\.min\(anchor, head\), to: Math\.max\(anchor, head\), head \}/);
  assert.match(css, /\.cm-host \.cm-iris-peer-selection\{/);
});

test("a peer's position is carried forward from the version it was reported at", () => {
  // Attributing a position to a structural region makes a stale offset visible:
  // a marker two lines out goes unnoticed, a warning naming the wrong construct
  // does not. The confirmed updates the sender had not seen are replayed, then
  // this tab's own unconfirmed ones.
  assert.match(editor, /function rebasePeerPos\(pos, version\)/);
  assert.match(editor, /collabLog\.push\(\{ version, changes: update\.changes \}\)/);
  assert.match(editor, /if \(entry\.version < version\) continue/);
  assert.match(editor, /if \(entry\.version >= synced\) break/);
  assert.match(editor, /CO\.sendableUpdates\(view\.state\)\.forEach\(\(update\) => \{ mapped = update\.changes\.mapPos\(mapped, 1\); \}\)/);
  // The log is bounded, and a new document invalidates all of it.
  assert.match(editor, /collabLog\.splice\(0, collabLog\.length - COLLAB_LOG_LIMIT\)/);
  const state = editor.slice(editor.indexOf("function makeState"), editor.indexOf("const host = document.createElement"));
  assert.match(state, /collabLog = \[\]/);
  // The version has to survive as far as the mapping to be usable at all.
  assert.match(editor, /const version = Number\(peer\.version\)/);
  assert.match(editor, /anchor: place\(peer\.anchor, version\)/);
});

test("the overlap warning is decided by structure, and falls back to lines", () => {
  const overlap = app.slice(app.indexOf("function overlappingPeers"), app.indexOf("function renderPresence"));
  // Sharing an ancestor is not sharing work: siblings always share one.
  assert.match(overlap, /const \{ node, contained \} = window\.IrisStructure\.shared\(mine, theirs\)/);
  assert.match(overlap, /return contained \? \{ peer, node \} : null/);
  // Where either position is in no region, the line rule still applies.
  assert.match(overlap, /if \(!mine\.length \|\| peer\.head == null\) return nearInLines\(peer\) \? \{ peer, node: null \} : null/);
  assert.match(overlap, /if \(!theirs\.length\) return nearInLines\(peer\) \? \{ peer, node: null \} : null/);
  assert.match(app, /function nearInLines\(peer\)/);
  // Structure is resolved against offsets; lines cannot express containment.
  assert.match(editor, /head: range\.head,/);
  assert.match(app, /const mine = pathAtOffset\(lastCursor\.head\)/);
});

test("the index is rebuilt when the text settles, never when a caret moves", () => {
  // Parsing on presence would put a parse behind every keystroke of every
  // participant; the index belongs to the document and is only consulted.
  assert.match(app, /const STRUCTURE_DEBOUNCE = 250/);
  assert.match(app, /function scheduleStructure\(\)/);
  assert.match(app, /structureTimer = setTimeout\(rebuildStructure, STRUCTURE_DEBOUNCE\)/);
  const cursor = app.slice(app.indexOf("ed().onCursor("), app.indexOf("ed().onPeers("));
  assert.doesNotMatch(cursor, /rebuildStructure|scheduleStructure/);
  // Opening a different document has no typing to wait for.
  const open = app.slice(app.indexOf("function openFile(id)"), app.indexOf("/* ---------------- file tree"));
  assert.match(open, /rebuildStructure\(\)/);
  // The parsing itself never reaches the server: it stays language-agnostic.
  assert.doesNotMatch(server, /IrisStructure|\\\\begin\{/);
  assert.match(html, /<script src="iris-structure\.js"><\/script>/);
});

test("the shared construct is named and marked", () => {
  const render = app.slice(app.indexOf("function renderPresence"), app.indexOf("// The same marks on the outline"));
  assert.match(render, /const contested = overlapping\.find\(\(hit\) => hit\.node\) \|\| null/);
  assert.match(render, /ed\(\)\.setSharedRegion\(contested/);
  // Nobody present means nothing contested.
  assert.match(render, /ed\(\)\.setSharedRegion\(null\)/);
  assert.match(render, /t\("collab\.overlapRegion", \{ names: atRisk, region: regionLabel\(contested\.node\) \}\)/);
  // Region names come from the document, so they are trimmed to fit.
  assert.match(app, /function regionLabel\(node\)/);
  assert.match(app, /label\.length > 40 \? `\$\{label\.slice\(0, 39\)\}…` : label/);
  // A band over a construct longer than the screen is noise, not information.
  assert.match(editor, /const REGION_LINE_CAP = 300/);
  assert.match(editor, /if \(last - first > REGION_LINE_CAP\) return V\.Decoration\.none/);
  // Its own custom property: it can share a line with the caret tint.
  assert.match(editor, /--region-color:/);
  assert.match(css, /\.cm-host \.cm-iris-peer-region\{/);
  ["overlapRegion", "peerAt"].forEach((key) => {
    assert.match(read("public/locales/en/translation.json"), new RegExp(`"${key}":`));
    assert.match(read("public/locales/it/translation.json"), new RegExp(`"${key}":`));
  });
});

test("the outline shows who is working under each heading", () => {
  assert.match(app, /function renderOutlinePresence\(\)/);
  assert.match(app, /box\.querySelectorAll\("\.ol-item\[data-offset\]"\)/);
  // The panel is a linear list, so the heading somebody is under is the last
  // one at or before them.
  assert.match(app, /if \(Number\.isFinite\(offsets\[i\]\) && offsets\[i\] <= peer\.head\) index = i/);
  // One dot per person, as in the tree and the footer.
  assert.match(app, /if \(!list\.some\(\(other\) => other\.userId === peer\.userId\)\) list\.push\(peer\)/);
  // The tree and the outline draw the same marks through the same helper.
  assert.match(app, /function fillPeerPins\(slot, peers, key\)/);
  // Same marks, but a heading is not a file and must not say it is.
  assert.match(app, /fillPeerPins\(slot, byRow\.get\(index\) \|\| \[\], "collab\.outlinePeers"\)/);
  assert.match(app, /fillPeerPins\(slot, \(fileId && byFile\.get\(fileId\)\) \|\| \[\], "collab\.filePeers"\)/);
  ["outlinePeers"].forEach((key) => {
    assert.match(read("public/locales/en/translation.json"), new RegExp(`"${key}":`));
    assert.match(read("public/locales/it/translation.json"), new RegExp(`"${key}":`));
  });
  assert.match(css, /\.ol-item \.node-peers\{/);
});

test("the overlap warning compares areas and spares whoever cannot write", () => {
  // A selection is an area on both sides of the comparison, so the local range
  // travels with the cursor event.
  assert.match(editor, /fromLine: view\.state\.doc\.lineAt\(range\.from\)\.number/);
  assert.match(editor, /toLine: view\.state\.doc\.lineAt\(range\.to\)\.number/);
  assert.match(editor, /fromLine: state\.doc\.lineAt\(range\.from\)\.number/);
  const overlap = app.slice(app.indexOf("function overlappingPeers"), app.indexOf("function renderPresence"));
  // A viewer's position carries no risk: it cannot become a change.
  assert.match(overlap, /if \(peer\.role === "viewer"\) return null/);
  // Interval overlap, widened by the tolerance on both sides. It is the
  // fallback now, so the formula lives in nearInLines.
  const near = app.slice(app.indexOf("function nearInLines"), app.indexOf("function overlappingPeers"));
  assert.match(near, /peer\.fromLine - OVERLAP_LINES <= lastCursor\.toLine/);
  assert.match(near, /peer\.toLine \+ OVERLAP_LINES >= lastCursor\.fromLine/);
  // Still advisory: nothing about it blocks an edit.
  assert.doesNotMatch(overlap, /(disabled|readOnly|preventDefault)/i);
});

test("the tree marks the project's files somebody else is in", () => {
  // Server: the list carries no positions, so a moving caret never triggers it.
  const presence = server.slice(server.indexOf("function collabFilePresenceFor"), server.indexOf("function collabSendFilePresence"));
  assert.match(presence, /if \(client === recipient \|\| people\.has\(client\.user\.sub\)\) return/);
  assert.doesNotMatch(presence, /anchor|head/, "the tree asks who is in a file, not where they are");
  // It travels on the project channel, and is sent on joins and leaves only.
  assert.match(server, /function collabBroadcastFilePresence\(projectId\)/);
  assert.match(server, /if \(session\.projectId !== projectId\) return;\s*\n\s*collabSendFilePresence/);
  // Joins and leaves both refresh it, on the project's coalescing tick: the
  // answer it carries stays true for as long as somebody is in the file, so a
  // crowd arriving at once costs one rebuild rather than one per arrival.
  const join = server.slice(server.indexOf('if (message.t === "open")'), server.indexOf('if (message.t === "project")'));
  assert.match(join, /collabScheduleFilePresence\(entry\.room\.projectId\)/);
  const leave = server.slice(server.indexOf("function collabLeave"), server.indexOf("// Tracks in-flight persistence"));
  assert.match(leave, /collabScheduleFilePresence\(entry\.projectId\)/);
  // A tab that starts watching gets the state as it is, not only the changes.
  const watch = server.slice(server.indexOf('if (message.t === "project")'), server.indexOf('if (message.t === "unwatch")'));
  assert.match(watch, /collabSendFilePresence\(session, projectId\)/);
  const membershipIndex = watch.indexOf("collabMembership");
  assert.ok(membershipIndex !== -1 && membershipIndex < watch.indexOf("collabSendFilePresence"),
    "the watch is authorized before any presence is disclosed");

  // Client: the badge is filled in place, because rebuilding the tree on every
  // join would take the focus with it.
  assert.match(app, /function renderTreePresence\(\)/);
  assert.match(app, /window\.IrisCollab\.onFilePeers\(renderTreePresence\)/);
  assert.match(app, /`<span class="node-peers" role="img" hidden><\/span>`/);
  assert.match(app, /root\.querySelectorAll\("\.node\[data-id\]"\)/);
  // The names reach assistive technology, not only the pointer.
  assert.match(app, /slot\.setAttribute\("aria-label", title\)/);
  assert.match(css, /^\.node-peer-dot\{/m);
  ["filePeers"].forEach((key) => {
    assert.match(read("public/locales/en/translation.json"), new RegExp(`"${key}":`));
    assert.match(read("public/locales/it/translation.json"), new RegExp(`"${key}":`));
  });
});

test("edits the server has not ordered yet are shown as unconfirmed", () => {
  const collab = read("public/iris-collab.js");
  assert.match(collab, /function hasPendingWork\(\)/);
  // Held by this tab, not confirmed by the room: a dropped link does not settle
  // an edit, so the flag follows the room the app wants, not the one it has.
  assert.match(collab, /if \(!state\.desired \|\| state\.role === "viewer"\) return false/);
  assert.match(collab, /const snapshot = \{ status: state\.status, role: state\.role, fileId: state\.joined, pending: state\.pending, paused: state\.paused \}/);
  // Raised when the edit is typed, cleared when the update comes back.
  const schedule = collab.slice(collab.indexOf("function schedulePush"), collab.indexOf("function sendPresence"));
  assert.match(schedule, /refreshPending\(\)/);
  const updates = collab.slice(collab.indexOf('if (message.t === "updates")'), collab.indexOf('if (message.t === "resync")'));
  assert.match(updates, /refreshPending\(\)/);
  // "Realtime" on its own would claim the document is settled when it is not.
  const status = app.slice(app.indexOf("function renderSyncStatus"), app.indexOf("/* ---------------- presence"));
  assert.match(status, /const unconfirmed = pending && \(status === "live" \|\| status === "offline" \|\| status === "maintenance"\)/);
  assert.match(status, /t\("collab\.pending"\)/);
  assert.match(status, /chip\.classList\.toggle\("pending", unconfirmed\)/);
  assert.match(css, /\.sb-sync\.pending\{/);
  ["pending", "pendingTitle"].forEach((key) => {
    assert.match(read("public/locales/en/translation.json"), new RegExp(`"${key}":`));
    assert.match(read("public/locales/it/translation.json"), new RegExp(`"${key}":`));
  });
});

test("the sync cadence is server-configurable and applied by the client", () => {
  assert.match(server, /const COLLAB_PUSH_DEBOUNCE_MS = positiveIntEnv\("COLLAB_PUSH_DEBOUNCE_MS", 300\)/);
  assert.match(server, /const COLLAB_PRESENCE_DEBOUNCE_MS = positiveIntEnv\("COLLAB_PRESENCE_DEBOUNCE_MS", 200\)/);
  assert.match(server, /pushDebounceMs: COLLAB_PUSH_DEBOUNCE_MS/);
  const collab = read("public/iris-collab.js");
  assert.match(collab, /function schedulePush\(\)/);
  assert.match(collab, /function schedulePresence\(\)/);
  assert.match(collab, /function applyPacing\(config\)/);
  assert.match(app, /window\.IrisCollab\.configure\(cfg\.collab\)/);
  // Typing is batched; the caret is paced separately because losing an
  // intermediate position costs nothing.
  assert.match(collab, /ed\(\)\.onSync\(schedulePush\)/);
  assert.match(collab, /ed\(\)\.onCursor\(schedulePresence\)/);
});

/* ---- build notifications ---- */

test("watching a project is authorized like anything else", () => {
  const handler = server.slice(server.indexOf("async function collabHandleMessage"), server.indexOf("function collabCloseSession"));
  const watch = handler.slice(handler.indexOf('message.t === "project"'), handler.indexOf('message.t === "unwatch"'));
  assert.match(watch, /collabMembership\(projectId, session\.user\.sub\)/);
  assert.match(watch, /COLLAB_PROJECT_NOT_FOUND/);
  assert.match(watch, /if \(!isUuid\(projectId\)\) throw new CollabError\("COLLAB_BAD_PROJECT"\)/);
  // Losing membership stops the notifications along with the editing session.
  assert.match(server, /if \(session\.projectId === projectId\) session\.projectId = null/);
  assert.match(server, /session\.projectId === projectId\s*\|\| Array\.from\(session\.rooms\.values\(\)\)/);
});

test("both outcomes of a compilation are announced, and nothing more", () => {
  // Two call sites: the normal outcome (succeeded or failed) and the
  // internal-error path that still finalizes a build.
  const calls = server.split("\n").filter((line) =>
    line.includes("collabNotifyBuild({") && !line.includes("function collabNotifyBuild"));
  assert.equal(calls.length, 2, `expected an announcement per finalized build, found ${calls.length}`);
  calls.forEach((line) => assert.match(line, /status/, "the announcement must carry the build outcome"));
  // Every announcement follows the write that made the build final, so a client
  // that reacts immediately cannot read a build that is still running.
  const compile = server.slice(server.indexOf("async function compileProject"), server.indexOf("const PROJECT_ROUTE ="));
  compile.split("collabNotifyBuild({").slice(0, -1).forEach((before) => {
    assert.ok(before.lastIndexOf("finalizeBuildOutput") > before.lastIndexOf("createBuildOutput"),
      "the build must be finalized before it is announced");
  });
  const notify = server.slice(server.indexOf("function collabNotifyBuild"), server.indexOf("async function collabHandleMessage"));
  // Only the fact travels: the output itself is fetched through the ordinary
  // authorized route, so the socket never becomes a second way to read a build.
  assert.doesNotMatch(notify, /artifact|storagePath|log|base64/i);
  assert.match(notify, /if \(session\.projectId !== projectId\) return/);
});

test("the notice is driven by what is on screen, not by who compiled", () => {
  const block = app.slice(app.indexOf("function onRemoteBuild"), app.indexOf("async function loadNewerBuild"));
  // Our own compilation replaces the preview by itself, so it stays silent.
  assert.match(block, /if \(state\.compiling \|\| build\.buildId === state\.previewBuildId\) return/);
  // Anything that puts a build on screen clears the notice.
  assert.match(app, /clearNewerBuild\(\);\s*state\.lastCompile/);
  const cancel = app.slice(app.indexOf("function cancelPendingProjectLoad"), app.indexOf("function buildLog"));
  assert.match(cancel, /clearNewerBuild/);
  // The refresh loads the latest finished build, not necessarily the announced
  // one: several may have completed while the notice was up.
  assert.match(app, /window\.IrisBuilds\.loadLatest\(projectId\)/);
});

test("the notice and its refresh button live in the preview and stay hidden", () => {
  assert.match(html, /id="pvNewer"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /id="pvNewerLoad"/);
  assert.match(html, /id="pvNewerDismiss"/);
  // It sits above the preview stage, so it cannot be scrolled out of sight.
  assert.ok(html.indexOf('id="pvNewer"') < html.indexOf('id="pvStage"'));
  assert.match(css, /\.pv-newer\{/);
  assert.match(css, /\.pv-newer\[hidden\]\{display:none\}/);
  assert.match(css, /\.pv-newer\.failed\{/);
  assert.match(app, /\$\("pvNewerLoad"\)\.addEventListener\("click"/);
  assert.match(app, /\$\("pvNewerDismiss"\)\.addEventListener\("click", clearNewerBuild\)/);
  ["newer", "newerBy", "newerFailed", "newerLoad"].forEach((key) => {
    assert.match(read("public/locales/en/translation.json"), new RegExp(`"${key}":`));
    assert.match(read("public/locales/it/translation.json"), new RegExp(`"${key}":`));
  });
});

test("the realtime transport loads after the editor and before the app", () => {
  const order = [...html.matchAll(/<script src="(iris-[a-z-]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.ok(order.indexOf("iris-editor.js") < order.indexOf("iris-collab.js"));
  assert.ok(order.indexOf("iris-collab.js") < order.indexOf("iris-app.js"));
});
