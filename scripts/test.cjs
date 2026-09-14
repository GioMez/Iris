#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { run, workspace, postgres } = require("./lib/disposable.cjs");
const root = path.resolve(__dirname, "..");
const help = `Usage: node scripts/test.cjs [options] [test/NAME.test.js ...]

Creates a disposable loopback-only PostgreSQL 18+ cluster with generated test
credentials, empty cwd, isolated HOME/TMPDIR/storage and no workspace .env.
Requires Node 24+, npm ci, PostgreSQL tools and a non-root POSIX user.
No Git or personal paths are needed. No supplied database URL is ever used.

--browser                  Enable browser suites (installed Chrome by default).
--browser-executable PATH  Enable browser suites with this Chromium executable.
--native                   Enable native compiler suites; requires pdflatex,
                           lilypond and gs on PATH. Navigation browser suites
                           also use native compilers when --browser is enabled.
--pg-bin DIR               PostgreSQL binaries (default: pg_config --bindir).
--pattern REGEXP           node:test name filter.
--concurrency N            File concurrency (default 4).
--timeout MS               Whole suite deadline (default 600000).
--test-timeout MS          Per-test deadline (default 60000).
--help                    Show this help.

Default: all top-level test/*.test.js. TAP reports passes, failures and opt-in
skips separately. Disabled browser/native suites are not claimed as passing.
Individual node --test invocations remain available for an explicitly isolated
TEST_DATABASE_URL. SIGINT/SIGTERM and failures trigger bounded owned cleanup.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean" }, browser: { type: "boolean" }, native: { type: "boolean" },
    ...Object.fromEntries(["browser-executable", "pg-bin", "pattern", "concurrency", "timeout", "test-timeout"].map((key) => [key, { type: "string" }])),
  } });
  if (values.help) return console.log(help);
  const number = (key, fallback) => {
    const value = values[key] ?? String(fallback);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid --${key}`);
    return Number(value);
  };
  const concurrency = number("concurrency", 4), timeout = number("timeout", 600000), testTimeout = number("test-timeout", 60000);
  const names = positionals.length ? positionals : (await fs.readdir(path.join(root, "test"))).filter((name) => name.endsWith(".test.js")).sort().map((name) => `test/${name}`);
  if (!names.length) throw new Error("No tests selected");
  const tests = await Promise.all(names.map(async (name) => {
    const file = await fs.realpath(path.resolve(root, name));
    if (!file.startsWith(`${root}${path.sep}test${path.sep}`) || !file.endsWith(".test.js")) throw new Error(`Invalid test path: ${name}`);
    return file;
  }));
  const browser = values.browser || !!values["browser-executable"];
  const work = await workspace();
  try {
    const pg = await postgres(work, values["pg-bin"]);
    // serverFixture deliberately disables dotenv but its default static path is
    // cwd-relative. A read-only source link lets all suites share the empty cwd.
    await fs.symlink(path.join(root, "public"), path.join(work.cwd, "public"), "dir");
    console.log(`Isolated suite: ${tests.length} files; browser=${browser ? "enabled" : "SKIPPED"}; native=${values.native ? "enabled" : "SKIPPED"}`);
    const result = await run(process.execPath, ["--test", "--test-reporter=tap", `--test-concurrency=${concurrency}`, `--test-timeout=${testTimeout}`,
      ...(values.pattern ? [`--test-name-pattern=${values.pattern}`] : []), ...tests], {
      cwd: work.cwd, timeout, allowFailure: true,
      env: { ...work.env, PATH: pg.env.PATH, TEST_DATABASE_URL: pg.url,
        IRIS_SECRET: "disposable-tests-only-secret-with-sufficient-entropy", DB_PASSWORD: pg.password,
        DB_HOST: "127.0.0.1", DB_PORT: String(pg.port), DB_USER: pg.user, DB_NAME: "postgres",
        DATA_DIR: path.join(work.root, "config-data"), PUBLIC_DIR: path.join(root, "public"), PORT: "0",
        IRIS_TEST_BROWSER: browser ? "1" : "0", IRIS_TEST_COMPILERS: values.native ? "1" : "0",
        ...(values["browser-executable"] ? { IRIS_BROWSER_EXECUTABLE: path.resolve(values["browser-executable"]) } : {}),
      },
    });
    process.exitCode ||= result.code ?? 1;
  } finally { await work.close(); }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
