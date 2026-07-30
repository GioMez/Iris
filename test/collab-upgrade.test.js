// Exercises the real WebSocket upgrade against a live HTTP server: no database is
// needed to prove the security-critical part, because an unauthenticated request
// is refused before any query runs. This is the boundary that decides whether an
// anonymous socket can reach a project's documents at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { collabAttach } = require("../src/server");

async function listening(t) {
  const server = http.createServer((req, res) => {
    res.writeHead(200).end("http");
  });
  collabAttach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

// Performs the handshake by hand so the HTTP response to a refused upgrade can be
// read, which a WebSocket client would hide.
function handshake(port, { pathname = "/api/collab", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      port,
      host: "127.0.0.1",
      path: pathname,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        ...headers,
      },
    });
    request.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ upgraded: true, status: res.statusCode });
    });
    // A refused upgrade answers with an ordinary response instead.
    request.on("response", (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ upgraded: false, status: res.statusCode, body }));
    });
    request.on("error", (err) => {
      // The socket being destroyed without a reply is also a refusal.
      if (err.code === "ECONNRESET") return resolve({ upgraded: false, status: null, body: "" });
      reject(err);
    });
    request.end();
  });
}

test("an unauthenticated upgrade to the collaboration endpoint is refused", async (t) => {
  const port = await listening(t);
  const result = await handshake(port);
  assert.equal(result.upgraded, false, "an anonymous socket must never be accepted");
  assert.equal(result.status, 401);
  assert.match(result.body, /Not authenticated/);
});

test("an invalid session cookie is refused just like a missing one", async (t) => {
  const port = await listening(t);
  const result = await handshake(port, { headers: { Cookie: "iris_session=forged.token.value" } });
  assert.equal(result.upgraded, false);
  assert.equal(result.status, 401);
});

test("upgrades to any other path are dropped without a reply", async (t) => {
  const port = await listening(t);
  const result = await handshake(port, { pathname: "/api/projects" });
  assert.equal(result.upgraded, false, "only the collaboration endpoint is upgradable");
  assert.equal(result.status, null, "the socket is destroyed rather than answered");
});

test("ordinary HTTP on the same server is unaffected", async (t) => {
  const port = await listening(t);
  const body = await new Promise((resolve, reject) => {
    http.get({ port, host: "127.0.0.1", path: "/" }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve(text));
    }).on("error", reject);
  });
  assert.equal(body, "http");
});
