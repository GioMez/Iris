const test = require("node:test");
const assert = require("node:assert/strict");

const { REASONS, MAX_VERSION_BYTES, hashContent, isVersionableText, contentChanged } = require("../src/versions");

test("content hashing is stable and content-addressed", () => {
  assert.equal(hashContent("hello"), hashContent("hello"));
  assert.notEqual(hashContent("hello"), hashContent("world"));
  // Known SHA-256 of "hello" pins the algorithm.
  assert.equal(hashContent("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("only text source files within the size cap are versionable", () => {
  assert.equal(isVersionableText(Buffer.from("\\documentclass{article}"), "tex"), true);
  assert.equal(isVersionableText(Buffer.from("{ c1 d1 }"), "ly"), true);
  // A NUL byte marks binary content.
  assert.equal(isVersionableText(Buffer.from([0x89, 0x50, 0x00, 0x01]), "img"), false);
  assert.equal(isVersionableText(Buffer.from([0x00]), null), false);
  // Binary kinds are excluded even without a NUL byte.
  assert.equal(isVersionableText(Buffer.from("not really"), "img"), false);
  assert.equal(isVersionableText(Buffer.from("a font"), "font"), false);
  // Oversized text is skipped.
  assert.equal(isVersionableText(Buffer.alloc(MAX_VERSION_BYTES + 1, 0x61), "tex"), false);
  assert.equal(isVersionableText("not a buffer", "tex"), false);
});

test("a revision is recorded only when the content changed", () => {
  const a = hashContent("one");
  const b = hashContent("two");
  assert.equal(contentChanged(null, a), true, "first revision always records");
  assert.equal(contentChanged(a, a), false, "no change, no revision");
  assert.equal(contentChanged(a, b), true, "changed content records");
});

test("the reason vocabulary matches the schema constraint", () => {
  assert.deepEqual([...REASONS].sort(), ["compile", "initial", "manual", "rollback"]);
});
