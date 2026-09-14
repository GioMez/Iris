#!/usr/bin/env node
// Source-only packaging. No npm dependencies, index writes or checkout reads in ref mode.
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { parseArgs } = require("node:util");

const help = `Usage:
  node scripts/release.cjs --ref R1.0.1 --output .drafts/release-1.0.1
  node scripts/release.cjs --candidate DIR --manifest FILE --output DIR

--ref REF        Read only Git objects at an explicit commit, tag or tree.
                 Working-tree/index changes and untracked files are never included.
--repo DIR       Git repository for --ref (default: this script's source root).
--candidate DIR  Explicit pre-tag source tree, also works without .git.
--manifest FILE  JSON array of relative file paths; required for --candidate.
                 This explicitly opts into those candidate bytes, including edits.
                 Forbidden paths, links, duplicates and missing inputs are errors.
--output DIR     New output directory (required; never overwrites an existing one).
--help           Show this help.

Produces iris-VERSION.tar.gz (iris-VERSION/ prefix) and SHA256SUMS.
Sorted ustar entries, uid/gid/mtime 0, normalized modes, gzip level 9 without
timestamps or filenames. Same inputs yield the same bytes. Secrets, local data,
dependencies, drafts, planning documents and temporary artifacts are excluded.
Review the explicit candidate manifest; only a reviewed final ref is a release.
`;
const rootFiles = new Set(["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "TRANSLATING.md", ".npmrc", ".gitignore", ".dockerignore", ".env.example", "Dockerfile", "docker-compose.yml"]);
const required = ["package.json", "package-lock.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", ".npmrc", ".env.example", ".dockerignore", "Dockerfile", "docker-compose.yml", "db/schema.sql", "db/init/01-create-iris-user.sh", "src/server.js", "public/Iris.html", "public/templates/.metadata.json", "scripts/test.cjs", "scripts/smoke.cjs"];
function safePath(name) {
  if (typeof name !== "string" || !name || /[\\\x00-\x1f\x7f:]/.test(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  return name;
}
function included(name) {
  safePath(name);
  if (rootFiles.has(name)) return true;
  if (!/^(src|public|db|test|scripts|docs|branding)\//.test(name)) return false;
  if (name.startsWith("docs/superpowers/")) return false;
  const parts = name.split("/");
  if (parts.some((part) => part.startsWith(".") || /^(node_modules|data|storage|coverage|tmp|temp|dist|build|artifacts)$/i.test(part)) && name !== "public/templates/.metadata.json") return false;
  return /\.(?:js|cjs|mjs|json|html|css|sql|sh|md|svg|png|jpg|jpeg|webp|tex|ly|ily|woff2?)$/.test(name);
}
async function candidateFiles(root, manifest) {
  root = await fs.realpath(root);
  const names = JSON.parse(await fs.readFile(manifest, "utf8"));
  if (!Array.isArray(names) || !names.length || names.length > 20000) throw new Error("Manifest must be a nonempty JSON array of at most 20000 paths");
  const seen = new Set(), result = [];
  for (const name of names) {
    if (!included(name)) throw new Error(`Excluded candidate path: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate candidate path: ${name}`);
    seen.add(name);
    let target = root;
    for (const part of name.split("/")) {
      target = path.join(target, part);
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error(`Symbolic link in candidate: ${name}`);
    }
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(`Not a regular source file or exceeds 64 MiB: ${name}`);
    result.push({ name, data: await fs.readFile(target) });
  }
  return result;
}
function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { timeout: 30000, maxBuffer: 65 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Git failed: ${result.error?.message || result.stderr.toString().trim()}`);
  return result.stdout;
}
function refFiles(repo, ref) {
  const tree = git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`]).toString().trim();
  const entries = git(repo, ["ls-tree", "-rz", "--full-tree", tree]).toString().split("\0").filter(Boolean);
  if (entries.length > 20000) throw new Error("Tree exceeds 20000 entries");
  const files = [];
  for (const entry of entries) {
    const match = entry.match(/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new Error("Invalid Git tree entry");
    const [, mode, type, oid, name] = match;
    if (!included(name)) continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error(`Only regular files are allowed: ${name}`);
    const size = Number(git(repo, ["cat-file", "-s", oid]).toString());
    if (size > 64 * 1024 * 1024) throw new Error(`Source file exceeds 64 MiB: ${name}`);
    files.push({ name, data: git(repo, ["cat-file", "blob", oid]) });
  }
  return { tree, files };
}
function versionFor(files) {
  const byName = new Map(files.map((file) => [file.name, file.data]));
  for (const name of required) if (!byName.has(name)) throw new Error(`Missing required source file: ${name}`);
  const pkg = JSON.parse(byName.get("package.json")), lock = JSON.parse(byName.get("package-lock.json"));
  if (pkg.name !== "iris" || !/^\d+\.\d+\.\d+$/.test(pkg.version) || lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name || lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) throw new Error("Package/lock metadata must agree on the Iris stable version");
  return pkg.version;
}
function tar(files, prefix) {
  let total = 0;
  const chunks = [];
  for (const file of files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    total += file.data.length;
    if (total > 512 * 1024 * 1024) throw new Error("Source exceeds 512 MiB");
    let name = `${prefix}/${file.name}`, dir = "";
    if (Buffer.byteLength(name) > 100) {
      const split = name.split("/");
      name = split.pop();
      while (split.length && Buffer.byteLength(`${split.at(-1)}/${name}`) <= 100) name = `${split.pop()}/${name}`;
      dir = split.join("/");
    }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(dir) > 155) throw new Error(`Path too long for ustar: ${file.name}`);
    const header = Buffer.alloc(512);
    const text = (value, offset, length) => header.write(value, offset, length, "utf8");
    const octal = (value, offset, length) => text(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
    text(name, 0, 100); octal(file.name.endsWith(".sh") ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8); octal(0, 116, 8); octal(file.data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); text("0", 156, 1); text("ustar\0", 257, 6); text("00", 263, 2); text(dir, 345, 155);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    text(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, file.data, Buffer.alloc((512 - file.data.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
async function main() {
  const { values } = parseArgs({ options: Object.fromEntries(["ref", "repo", "candidate", "manifest", "output"].map((name) => [name, { type: "string" }]).concat([["help", { type: "boolean" }]])) });
  if (values.help) return console.log(help);
  if (!!values.ref === !!values.candidate || !values.output || (values.candidate && !values.manifest) || (values.ref && values.manifest) || (values.candidate && values.repo)) throw new Error("Pass --ref or --candidate with --manifest, and a new --output directory; see --help");
  const output = path.resolve(values.output);
  let files, source;
  if (values.ref) {
    const result = refFiles(values.repo || path.resolve(__dirname, ".."), values.ref);
    files = result.files; source = { ref: values.ref, tree: result.tree };
  } else { files = await candidateFiles(values.candidate, values.manifest); source = { candidate: path.resolve(values.candidate) }; }
  const version = versionFor(files), name = `iris-${version}.tar.gz`;
  const bytes = gzipSync(tar(files, `iris-${version}`), { level: 9 });
  bytes[9] = 255; // Normalize gzip's OS identifier as well as its zero timestamp.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output); // Exclusive: never remove or overwrite somebody else's output.
  try {
    await fs.writeFile(path.join(output, name), bytes, { flag: "wx" });
    await fs.writeFile(path.join(output, "SHA256SUMS"), `${sha256}  ${name}\n`, { flag: "wx" });
  } catch (error) { await fs.rm(output, { recursive: true, force: true }); throw error; }
  console.log(JSON.stringify({ ...source, version, files: files.length, archive: path.join(output, name), sha256 }, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { included };
