#!/usr/bin/env node
// Moves project directories recorded with a pre-002 absolute path to the
// canonical DATA_DIR-relative layout.
//
// The server performs the same relocation on startup; running it here lets an
// operator do it during a maintenance window, or after restoring a backup into
// a DATA_DIR that differs from the one the dump was taken from.

const path = require("node:path");
const { loadDotEnv, databaseSettings } = require("../src/env");

loadDotEnv(path.resolve(".env"));

const { createDatabase } = require("../src/database");
const { relocateProjectStorage } = require("../src/project-storage");

async function main() {
  const dataDir = path.resolve(process.env.DATA_DIR || "./data/projects");
  const db = await createDatabase(databaseSettings());
  try {
    console.log(`Relocating project storage into ${dataDir}`);
    const summary = await relocateProjectStorage({ db, dataDir });
    console.log(
      `Done: ${summary.moved} moved, ${summary.alreadyRelocated} already in place, ${summary.missing} without data on disk.`
    );
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Project storage relocation failed");
  console.error(err.message || err);
  process.exit(1);
});
