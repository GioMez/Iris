#!/usr/bin/env node
// Restores text sources that were saved as the data URL of their own contents.
//
// A file attached through the upload dialog used to be carried as a data URL,
// and the writer could not read back a media type with parameters
// (`data:text/plain; charset=utf-8;base64,...`), so it wrote the URL itself as
// the file's bytes. A .bib repaired this way is parsed again by BibTeX, which
// until now saw a file with no entries and produced an empty bibliography
// without reporting an error.
//
// Reports by default; pass --apply to rewrite the files it found.

const fs = require("node:fs/promises");
const path = require("node:path");
const { loadDotEnv } = require("../src/env");

loadDotEnv(path.resolve(".env"));

const TEXT_FILE = /\.(tex|ly|ily|bib|txt|sty|cls|md|csv|dat|scm|lua|json|ya?ml|log|aux|bbl|blg|idx|ilg|ind|out|toc|xml|bcf|fls|fdb_latexmk)$/i;
const DATA_URL = /^data:([^,]*),([\s\S]*)$/;

// Only a file that is nothing but one data URL is repaired: a source that merely
// mentions one keeps whatever else it contains.
function decodeStoredDataUrl(content) {
  const match = content.trim().match(DATA_URL);
  if (!match) return null;
  const [, header, payload] = match;
  let bytes;
  if (/;\s*base64\s*$/i.test(header)) {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return null;
    bytes = Buffer.from(payload.replace(/\s+/g, ""), "base64");
  } else {
    try { bytes = Buffer.from(decodeURIComponent(payload), "utf8"); } catch { return null; }
  }
  const text = bytes.toString("utf8");
  // A decode that does not survive a round-trip is not the text this file held.
  if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  return text;
}

async function walk(directory, onFile) {
  const children = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, child.name);
    if (child.isSymbolicLink()) continue;
    // Generated output is rebuilt by the next compilation, and the manifest is
    // repaired by the server the next time it writes the project.
    if (child.isDirectory()) {
      if (child.name === "output" || child.name === ".iris") continue;
      await walk(absolute, onFile);
    } else if (child.isFile() && TEXT_FILE.test(child.name)) {
      await onFile(absolute);
    }
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dataDir = path.resolve(process.env.DATA_DIR || "./data");
  const roots = [path.join(dataDir, "projects"), path.join(dataDir, "orphaned")];
  let repaired = 0;

  for (const root of roots) {
    if (!await fs.stat(root).then(() => true, () => false)) continue;
    await walk(root, async (file) => {
      const content = await fs.readFile(file, "utf8").catch(() => null);
      if (content == null || !content.startsWith("data:")) return;
      const text = decodeStoredDataUrl(content);
      if (text == null) return;
      repaired += 1;
      console.log(`${apply ? "Repaired" : "Would repair"} ${path.relative(dataDir, file)} (${content.length} -> ${Buffer.byteLength(text)} bytes)`);
      if (apply) await fs.writeFile(file, text, "utf8");
    });
  }

  if (!repaired) console.log(`No source file below ${dataDir} holds a data URL.`);
  else if (!apply) console.log(`\n${repaired} file(s) to repair. Re-run with --apply to write them.`);
  else console.log(`\n${repaired} file(s) repaired.`);
}

main().catch((err) => {
  console.error("Source repair failed");
  console.error(err.message || err);
  process.exit(1);
});
