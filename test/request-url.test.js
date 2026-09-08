const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.IRIS_SECRET = "test-only-secret-with-sufficient-entropy";
process.env.DB_PASSWORD = "test-only-database-password";

const { handle, collabAttach } = require("../src/server");

async function listening(t) {
  const server = http.createServer(handle);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  collabAttach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    sockets.forEach((socket) => socket.destroy());
    server.close(resolve);
  }));
  return server.address().port;
}

function request(port, { path = "/api/health", host = "localhost", upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      agent: false,
      headers: {
        Host: host,
        Connection: upgrade ? "Upgrade" : "close",
        ...(upgrade ? {
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        } : {}),
      },
    });
    req.setTimeout(2000, () => req.destroy(new Error("Request did not receive a response")));
    req.on("error", reject);
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, upgraded: true });
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body, upgraded: false }));
    });
    req.end();
  });
}

for (const upgrade of [false, true]) {
  const transport = upgrade ? "WebSocket upgrade" : "HTTP";
  for (const [name, invalid] of [
    ["malformed IPv6 Host", { host: "[" }],
    ["invalid Host port", { host: "localhost:not-a-port" }],
    ["malformed absolute request target", { path: "http://[" }],
  ]) {
    test(`${transport} rejects ${name} without breaking subsequent requests`, async (t) => {
      const port = await listening(t);
      const result = await request(port, {
        path: upgrade ? "/api/collab" : "/api/health",
        upgrade,
        ...invalid,
      });
      assert.equal(result.status, 400);
      assert.equal(result.upgraded, false);

      const health = await request(port);
      assert.equal(health.status, 200);
      assert.equal(JSON.parse(health.body).pendingWrites, 0);
      if (upgrade) {
        const auth = await request(port, { path: "/api/collab", upgrade: true });
        assert.equal(auth.status, 401, "the upgrade must still reach the authentication gate");
      }
    });
  }

  test(`${transport} retains routing with valid hostname, IPv4 and IPv6 Hosts`, async (t) => {
    const port = await listening(t);
    for (const host of ["iris.example", "IRIS.EXAMPLE:80", "127.0.0.1:3000", "[::1]:3000"]) {
      const result = await request(port, { path: upgrade ? "/api/collab" : "/api/health", host, upgrade });
      assert.equal(result.status, upgrade ? 401 : 200, host);
      assert.equal(result.upgraded, false);
    }
  });
}
