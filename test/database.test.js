const test = require("node:test");
const assert = require("node:assert/strict");

const { assertSupportedPostgresVersion } = require("../src/database");

test("PostgreSQL 18 is the supported baseline and newer majors are allowed", () => {
  assert.equal(assertSupportedPostgresVersion("180004"), 18);
  // A newer major must not block startup: a routine upgrade stays non-breaking.
  assert.equal(assertSupportedPostgresVersion("190001"), 19);
  assert.equal(assertSupportedPostgresVersion("210000"), 21);
  // Older majors and unparseable values are refused.
  for (const unsupported of ["170006", "150010", "", null, "not-a-version", "-1"]) {
    assert.throws(
      () => assertSupportedPostgresVersion(unsupported),
      /PostgreSQL 18 or later is required/
    );
  }
});
