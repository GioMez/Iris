const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const WebSocket = require("ws");
const { ChangeSet } = require("@codemirror/state");
const { uuidv7 } = require("../src/ids");
const { connectionString, serverFixture, deferred } = require("./helpers/server-fixture.cjs");

const options = { skip: !connectionString, timeout: 15000 };

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 3000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(5);
  }
}

function connect(t, fixture, cookie) {
  const ws = new WebSocket(`${fixture.baseUrl.replace("http:", "ws:")}/api/collab`, { headers: { cookie } });
  const messages = [];
  const handshake = new Promise((resolve) => {
    ws.once("open", () => resolve(101));
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.once("error", () => resolve(0));
  });
  const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  ws.on("error", () => {});
  t.after(() => ws.terminate());
  return {
    ws, messages, handshake, closed,
    send: (message) => ws.send(JSON.stringify(message)),
    async next(type) {
      await until(() => messages.some((message) => message.t === type), type);
      return messages.splice(messages.findIndex((message) => message.t === type), 1)[0];
    },
  };
}

async function seed(t, env = {}) {
  const fixture = await serverFixture(t, { COLLAB_HEARTBEAT_MS: "60000", ...env });
  const users = [];
  for (const role of ["admin", "regular"]) {
    const id = uuidv7();
    const { rows } = await fixture.pool.query(
      `INSERT INTO users (id, username, email, display_name, system_role)
       VALUES ($1, $2, $3, $2, $4) RETURNING *`,
      [id, role, `${role}@example.test`, role]
    );
    users.push(rows[0]);
  }
  const [admin, user] = users;
  const adminCookie = fixture.cookieFor(admin);
  const response = await fixture.request("/api/projects", {
    cookie: adminCookie, method: "POST",
    body: { name: "Realtime auth", data: { project: { nodes: [{ id: uuidv7(), type: "file", name: "main.tex", content: "base" }] } } },
  });
  const created = await response.json();
  assert.equal(response.status, 201, JSON.stringify(created));
  const projectId = created.project.id;
  const { rows: files } = await fixture.pool.query("SELECT * FROM project_files WHERE project_id = $1", [projectId]);
  assert.equal(files.length, 1);
  await fixture.pool.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'editor')", [projectId, user.id]);
  return { ...fixture, admin, user, adminCookie, cookie: fixture.cookieFor(user), projectId, fileId: files[0].id };
}

async function ready(t, fixture, cookie = fixture.cookie) {
  const client = connect(t, fixture, cookie);
  assert.equal(await client.handshake, 101);
  const message = await client.next("ready");
  client.session = Array.from(fixture.app.collabSessions).find((session) => session.id === message.sessionId);
  return client;
}

async function open(client, fixture) {
  client.send({ t: "open", fileId: fixture.fileId });
  return client.next("opened");
}

function push(client, fileId, version, text, insert) {
  client.send({ t: "push", fileId, version, updates: [{
    clientID: "test-client", changes: ChangeSet.of({ from: text.length, insert }, text.length).toJSON(),
  }] });
}

test("forced-password-change accounts cannot upgrade to realtime", options, async (t) => {
  const fixture = await seed(t);
  await fixture.pool.query("UPDATE users SET password_change_required = TRUE WHERE id = $1", [fixture.user.id]);
  const client = connect(t, fixture, fixture.cookie);
  assert.equal(await client.handshake, 403);
  assert.equal(fixture.app.collabSessions.size, 0);
});

for (const mutation of ["disable", "reset-password", "unlink-sso"]) {
  test(`${mutation} closes every old socket before audit and preserves accepted edits`, options, async (t) => {
    const fixture = await seed(t);
    if (mutation === "unlink-sso") {
      await fixture.pool.query("UPDATE users SET auth_source = 'oidc', oidc_issuer = 'https://issuer.test', oidc_subject = 'subject' WHERE id = $1", [fixture.user.id]);
    }
    const writer = await ready(t, fixture);
    const watcher = await ready(t, fixture);
    const otherUser = await ready(t, fixture, fixture.adminCookie);
    await open(writer, fixture);
    watcher.send({ t: "project", projectId: fixture.projectId });
    await until(() => watcher.session.projectId === fixture.projectId, "project watch");
    push(writer, fixture.fileId, 0, "base", " accepted");
    assert.equal((await writer.next("pushed")).accepted, true);
    const room = fixture.app.collabRooms.get(fixture.fileId);
    const auditEntered = deferred();
    const release = deferred();
    fixture.hooks.beforeQuery = async (sql) => {
      if (!sql.includes("INSERT INTO audit_events")) return;
      auditEntered.resolve();
      await release.promise;
    };
    let response;
    try {
      response = fixture.request(`/api/admin/users/${fixture.user.id}${mutation === "disable" ? "" : `/${mutation}`}`, {
        cookie: fixture.adminCookie, method: mutation === "disable" ? "PATCH" : "POST",
        ...(mutation === "disable" ? { body: { status: "disabled" } } : {}),
      });
      await within(auditEntered.promise, "account audit");
      assert.equal(writer.session.closed, true, "writer must be revoked synchronously before auditing");
      assert.equal(watcher.session.closed, true, "idle watcher must be revoked too");
      assert.equal(writer.session.rooms.size, 0);
      assert.equal(watcher.session.projectId, null);
      await until(() => writer.ws.readyState === WebSocket.CLOSED && watcher.ws.readyState === WebSocket.CLOSED, "revoked sockets");
      assert.equal(await writer.closed, 4401);
      assert.equal(room.text(), "base accepted");
      otherUser.send({ t: "ping" });
      await otherUser.next("pong");
    } finally {
      fixture.hooks.beforeQuery = null;
      release.resolve();
      if (response) assert.equal((await response).status, 200);
    }
    await until(() => fixture.app.collabRooms.get(fixture.fileId) === null, "last-leave persistence");
    const stored = await fs.readFile(path.join(room.storageDir, room.path), "utf8");
    assert.equal(stored, "base accepted");
  });
}

test("an out-of-band session version change is rejected on the next message", options, async (t) => {
  const fixture = await seed(t);
  const client = await ready(t, fixture);
  await open(client, fixture);
  const room = fixture.app.collabRooms.get(fixture.fileId);
  await fixture.pool.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [fixture.user.id]);
  push(client, fixture.fileId, 0, "base", " forbidden");
  client.send({ t: "pull", fileId: fixture.fileId, version: 0 });
  client.send({ t: "project", projectId: fixture.projectId });
  await until(() => client.ws.readyState === WebSocket.CLOSED, "version revocation");
  assert.equal(await client.closed, 4401);
  assert.equal(room.text(), "base");
  assert.equal(client.session.rooms.size, 0);
  assert.equal(client.session.projectId, null);
  assert.ok(!client.messages.some((message) => ["pushed", "updates", "resync"].includes(message.t)));
});

for (const failQuery of [false, true]) {
  test(`heartbeat closes idle sockets on ${failQuery ? "auth query failure" : "out-of-band disable"}`, options, async (t) => {
    const fixture = await seed(t, { COLLAB_HEARTBEAT_MS: "40" });
    const client = await ready(t, fixture);
    if (failQuery) {
      fixture.hooks.beforeQuery = async (sql) => {
        if (sql.includes("FROM users WHERE id = $1")) throw new Error("auth database unavailable");
      };
    } else {
      await fixture.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [fixture.user.id]);
    }
    try {
      await until(() => client.ws.readyState === WebSocket.CLOSED, "heartbeat auth failure");
      assert.equal(await client.closed, 4401);
    } finally {
      fixture.hooks.beforeQuery = null;
    }
  });
}

test("token expiry closes an idle socket without waiting for heartbeat", options, async (t) => {
  const fixture = await seed(t);
  const client = await ready(t, fixture, fixture.cookieFor(fixture.user, { exp: Math.floor(Date.now() / 1000) + 2 }));
  await open(client, fixture);
  await until(() => client.ws.readyState === WebSocket.CLOSED, "token expiry");
  assert.equal(await client.closed, 4401);
  assert.equal(client.session.rooms.size, 0);
});

for (const trigger of ["message", "broadcast"]) {
  test(`expiry guards ${trigger}s even when the expiry timer is delayed`, options, async (t) => {
    const fixture = await seed(t);
    const exp = Math.floor(Date.now() / 1000) + 2;
    const reader = await ready(t, fixture, fixture.cookieFor(fixture.user, { exp }));
    const writer = await ready(t, fixture, fixture.adminCookie);
    await open(reader, fixture);
    await open(writer, fixture);
    const room = fixture.app.collabRooms.get(fixture.fileId);
    // Leave the real token expired while its timer has not run.
    clearTimeout(reader.session.expiryTimer);
    await until(() => Date.now() >= exp * 1000, "signed token expiry");
    if (trigger === "message") {
      reader.send({ t: "pull", fileId: fixture.fileId, version: 0 });
      push(reader, fixture.fileId, 0, "base", " forbidden");
      await until(() => reader.ws.readyState === WebSocket.CLOSED, "expired message sender");
    }
    push(writer, fixture.fileId, 0, "base", " allowed");
    assert.equal((await writer.next("pushed")).accepted, true);
    await until(() => reader.ws.readyState === WebSocket.CLOSED, "overdue reader expiry");
    assert.equal(room.text(), "base allowed");
    assert.ok(!reader.messages.some((message) => ["updates", "resync", "pushed"].includes(message.t)));
  });
}

for (const role of [null, "viewer"]) {
  for (const waitAt of ["disk", "final membership"]) {
    test(`pending join cannot retain editor access after ${role ? "demotion" : "removal"} during ${waitAt}`, options, async (t) => {
      const fixture = await seed(t);
      const client = await ready(t, fixture);
      const entered = deferred();
      const release = deferred();
      let membershipReads = 0;
      fixture.hooks.beforeReadFile = async (filename) => {
        if (waitAt === "disk" && String(filename).endsWith("main.tex")) {
          entered.resolve();
          await release.promise;
        }
      };
      fixture.hooks.afterQuery = async (sql) => {
        if (waitAt !== "final membership" || !sql.includes("FROM projects p JOIN project_members")) return;
        if (++membershipReads !== 2) return;
        entered.resolve();
        await release.promise;
      };
      try {
        client.send({ t: "open", fileId: fixture.fileId });
        await within(entered.promise, `join ${waitAt}`);
        if (role) {
          await fixture.pool.query("UPDATE project_members SET role = $1 WHERE project_id = $2 AND user_id = $3", [role, fixture.projectId, fixture.user.id]);
        } else {
          await fixture.pool.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [fixture.projectId, fixture.user.id]);
        }
        await fixture.app.collabRecheckProject(fixture.projectId);
        release.resolve();
        if (role) {
          assert.equal((await client.next("opened")).role, "viewer");
          push(client, fixture.fileId, 0, "base", " forbidden");
          assert.equal((await client.next("error")).code, "COLLAB_READ_ONLY");
          assert.equal(fixture.app.collabRooms.get(fixture.fileId).text(), "base");
        } else {
          assert.equal((await client.next("error")).code, "COLLAB_FILE_NOT_FOUND");
          assert.equal(client.session.rooms.size, 0);
          assert.ok(!client.messages.some((message) => message.t === "opened"));
        }
      } finally {
        fixture.hooks.beforeReadFile = null;
        fixture.hooks.afterQuery = null;
        release.resolve();
      }
    });
  }
}

for (const reason of ["socket close", "socket closing", "account reset"]) {
  test(`${reason} while a join waits cannot resurrect a room or queued work`, options, async (t) => {
    const fixture = await seed(t);
    const client = await ready(t, fixture);
    const entered = deferred();
    const release = deferred();
    fixture.hooks.beforeReadFile = async (filename) => {
      if (!String(filename).endsWith("main.tex")) return;
      entered.resolve();
      await release.promise;
    };
    try {
      client.send({ t: "open", fileId: fixture.fileId });
      await within(entered.promise, "join disk read");
      client.send({ t: "project", projectId: fixture.projectId });
      push(client, fixture.fileId, 0, "base", " forbidden");
      if (reason === "socket close") client.ws.close();
      else if (reason === "socket closing") {
        // Hold the close handshake open while the server's join resumes.
        client.ws.pause();
        client.session.socket.close();
        assert.equal(client.session.socket.readyState, WebSocket.CLOSING);
      } else {
        const response = await fixture.request(`/api/admin/users/${fixture.user.id}/reset-password`, { cookie: fixture.adminCookie, method: "POST" });
        assert.equal(response.status, 200);
      }
      if (reason !== "socket closing") {
        await within(client.closed, "socket close");
        await until(() => !fixture.app.collabSessions.has(client.session), "server close cleanup");
      }
      release.resolve();
      await until(() => client.session.closed || client.session.rooms.size > 0, "pending join completion");
      await within(client.session.messages, "queued messages");
      assert.equal(client.session.rooms.size, 0);
      assert.equal(client.session.projectId, null);
      assert.equal(fixture.app.collabRooms.get(fixture.fileId), null);
    } finally {
      fixture.hooks.beforeReadFile = null;
      release.resolve();
      client.ws.resume();
    }
  });
}

test("messages stay ordered while opening a room awaits disk I/O", options, async (t) => {
  const fixture = await seed(t);
  const client = await ready(t, fixture);
  const entered = deferred();
  const release = deferred();
  fixture.hooks.beforeReadFile = async (filename) => {
    if (!String(filename).endsWith("main.tex")) return;
    entered.resolve();
    await release.promise;
  };
  try {
    client.send({ t: "open", fileId: fixture.fileId });
    await within(entered.promise, "join disk read");
    push(client, fixture.fileId, 0, "base", " first");
    push(client, fixture.fileId, 1, "base first", " second");
    client.send({ t: "pull", fileId: fixture.fileId, version: 0 });
    release.resolve();
    await client.next("opened");
    assert.equal((await client.next("updates")).version, 1);
    assert.equal((await client.next("pushed")).version, 1);
    assert.equal((await client.next("updates")).version, 2);
    assert.equal((await client.next("pushed")).version, 2);
    assert.equal((await client.next("updates")).updates.length, 2);
    assert.equal(fixture.app.collabRooms.get(fixture.fileId).text(), "base first second");
    assert.ok(!client.messages.some((message) => message.t === "error"));
  } finally {
    fixture.hooks.beforeReadFile = null;
    release.resolve();
  }
});

test("a pending project watch cannot install membership removed during its query", options, async (t) => {
  const fixture = await seed(t);
  const client = await ready(t, fixture);
  const entered = deferred();
  const release = deferred();
  let blocked = false;
  fixture.hooks.afterQuery = async (sql) => {
    if (blocked || !sql.includes("FROM projects p JOIN project_members")) return;
    blocked = true;
    entered.resolve();
    await release.promise;
  };
  try {
    client.send({ t: "project", projectId: fixture.projectId });
    await within(entered.promise, "watch membership read");
    await fixture.pool.query("DELETE FROM project_members WHERE project_id = $1 AND user_id = $2", [fixture.projectId, fixture.user.id]);
    await fixture.app.collabRecheckProject(fixture.projectId);
    release.resolve();
    assert.equal((await client.next("error")).code, "COLLAB_PROJECT_NOT_FOUND");
    assert.ok(!client.session.projectId);
  } finally {
    fixture.hooks.afterQuery = null;
    release.resolve();
  }
});

test("a pending upgrade cannot install auth captured before account revocation", options, async (t) => {
  const fixture = await seed(t);
  const entered = deferred();
  const release = deferred();
  let blocked = false;
  fixture.hooks.afterQuery = async (sql, params) => {
    if (blocked || !sql.includes("FROM users WHERE id = $1") || params[0] !== fixture.user.id) return;
    blocked = true;
    entered.resolve();
    await release.promise;
  };
  try {
    const client = connect(t, fixture, fixture.cookie);
    await within(entered.promise, "upgrade auth read");
    const response = await fixture.request(`/api/admin/users/${fixture.user.id}/reset-password`, { cookie: fixture.adminCookie, method: "POST" });
    assert.equal(response.status, 200);
    release.resolve();
    assert.equal(await client.handshake, 401);
    assert.equal(fixture.app.collabSessions.size, 0);
  } finally {
    fixture.hooks.afterQuery = null;
    release.resolve();
  }
});

test("overlapping membership rechecks cannot restore an older editor role", options, async (t) => {
  const fixture = await seed(t);
  const client = await ready(t, fixture);
  await open(client, fixture);
  const entered = deferred();
  const release = deferred();
  let blocked = false;
  let first;
  fixture.hooks.afterQuery = async (sql) => {
    if (blocked || !sql.includes("FROM projects p JOIN project_members")) return;
    blocked = true;
    entered.resolve();
    await release.promise;
  };
  try {
    first = fixture.app.collabRecheckProject(fixture.projectId);
    await within(entered.promise, "first membership recheck");
    await fixture.pool.query("UPDATE project_members SET role = 'viewer' WHERE project_id = $1 AND user_id = $2", [fixture.projectId, fixture.user.id]);
    await fixture.app.collabRecheckProject(fixture.projectId);
    assert.equal((await client.next("role")).role, "viewer");
    release.resolve();
    await first;
    push(client, fixture.fileId, 0, "base", " forbidden");
    assert.equal((await client.next("error")).code, "COLLAB_READ_ONLY");
    assert.equal(client.session.rooms.get(fixture.fileId).role, "viewer");
  } finally {
    fixture.hooks.afterQuery = null;
    release.resolve();
    if (first) await first;
  }
});

for (const initiallyOpen of [true, false]) {
  test(`a join waiting on permission retains accepted edits with the room initially ${initiallyOpen ? "open" : "absent"}`, options, async (t) => {
    const fixture = await seed(t);
    const writer = await ready(t, fixture, fixture.adminCookie);
    if (initiallyOpen) await open(writer, fixture);
    const joining = await ready(t, fixture);
    const entered = deferred();
    const release = deferred();
    let membershipReads = 0;
    fixture.hooks.afterQuery = async (sql, params) => {
      if (!sql.includes("FROM projects p JOIN project_members") || params[1] !== fixture.user.id) return;
      if (++membershipReads !== 2) return;
      entered.resolve();
      await release.promise;
    };
    try {
      joining.send({ t: "open", fileId: fixture.fileId });
      await within(entered.promise, "join final permission");
      if (!initiallyOpen) await open(writer, fixture);
      push(writer, fixture.fileId, 0, "base", " accepted");
      assert.equal((await writer.next("pushed")).accepted, true);
      writer.ws.close();
      await within(writer.closed, "writer close");
      await until(() => fixture.app.collabRooms.get(fixture.fileId) === null, "previous room persistence");
      release.resolve();
      assert.equal((await joining.next("opened")).doc, "base accepted");
    } finally {
      fixture.hooks.afterQuery = null;
      release.resolve();
    }
  });
}
