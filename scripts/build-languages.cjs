#!/usr/bin/env node
// Installed generator only. Keep the input/output manifest explicit as languages grow.
const fs = require("node:fs/promises");
const path = require("node:path");
const { buildParserFile } = require("@lezer/generator");

const languages = ["latex", "lilypond"];
async function build({ check = false, root = path.resolve(__dirname, "..") } = {}) {
  const outputs = [];
  for (const name of languages) {
    const dir = `public/languages/${name}`;
    const grammar = await fs.readFile(path.join(root, dir, `${name}.grammar`), "utf8");
    const generated = buildParserFile(grammar, { fileName: `${dir}/${name}.grammar`, moduleStyle: "es", exportName: "parser" });
    outputs.push([`${dir}/parser.mjs`, generated.parser], [`${dir}/parser.terms.mjs`, generated.terms]);
  }
  const changed = [];
  for (const [name, text] of outputs) {
    const target = path.join(root, name);
    if (check) {
      const existing = await fs.readFile(target, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (existing !== text) changed.push(name);
    } else await fs.writeFile(target, text);
  }
  if (changed.length) throw new Error(`Generated language files differ or are missing:\n${changed.join("\n")}\nRun npm run build:languages.`);
  return outputs.map(([name]) => name);
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--check") || args.length > 1) {
    console.error("Usage: node scripts/build-languages.cjs [--check]");
    process.exitCode = 1;
  } else build({ check: args.includes("--check") }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { build };
