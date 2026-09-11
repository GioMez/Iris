const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function worker() {
  const messages = [];
  const context = vm.createContext({ postMessage: (message) => messages.push(structuredClone(message)) });
  context.self = context;
  context.importScripts = (...names) => names.forEach((name) => vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../public", name), "utf8"), context, { filename: name }));
  assert.ok(fs.existsSync(path.join(__dirname, "../public/iris-bibliography-worker.js")), "the local parsing Worker must exist");
  context.importScripts("iris-bibliography-worker.js");
  return { context, messages };
}

test("Worker validates the full real document and echoes each original generation", () => {
  const { context, messages } = worker();
  const first = { requestId: 7, documentKey: "p1/refs", revision: 10, text: "@book{a,title={A}}", hint: "bib" };
  const second = { requestId: 8, documentKey: "p1/refs", revision: 11, text: "TY  - BOOK\nTI  - A\nER  -\nTY  - JOUR", hint: "ris" };
  context.self.onmessage({ data: first });
  context.self.onmessage({ data: second });
  assert.deepEqual(messages.map(({ requestId, documentKey, revision }) => ({ requestId, documentKey, revision })), [
    { requestId: 7, documentKey: "p1/refs", revision: 10 }, { requestId: 8, documentKey: "p1/refs", revision: 11 },
  ]);
  assert.equal(messages[0].result.status, "valid");
  assert.equal(messages[0].result.entries[0].fields[0].value, "A");
  assert.equal(messages[0].result.text, first.text);
  assert.ok(messages[0].result.diagnostics.some((item) => item.code === "bibtex.missingMetadata"));
  assert.equal(messages[1].result.status, "invalid");
  assert.deepEqual(messages[1].result.entries, []);
  assert.equal(messages[1].result.diagnostics[0].params.expected, "ER");
});

test("Worker reports technical failure without manufacturing parser invalidity", () => {
  const { context, messages } = worker();
  context.self.onmessage({ data: { requestId: 9, documentKey: "p2/a", revision: 3, text: null, hint: "bib" } });
  assert.deepEqual(messages, [{ requestId: 9, documentKey: "p2/a", revision: 3, error: "BIBLIOGRAPHY_PARSE_FAILED" }]);
});
