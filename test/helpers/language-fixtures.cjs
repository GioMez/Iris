const fs = require("node:fs");
const path = require("node:path");
const { StringStream } = require("@codemirror/language");

const FIXTURE_ROOT = path.resolve(__dirname, "../fixtures/languages");
const REQUIREMENT_IDS = Object.freeze([
  "TX-01", "TX-02", "TX-03", "TX-04", "TX-05", "TX-06", "TX-07", "TX-08", "TX-09",
  "LY-01", "LY-02", "LY-03", "LY-04", "LY-05", "LY-06", "LY-07", "LY-08",
]);
const ROLE_NAMES = Object.freeze(("command structure environment context definition variable reference citation path string literal lyric math pitch number duration rest operator articulation comment delimiter property scheme text").split(" "));
const CONTEXT_MODES = Object.freeze(["text", "math", "comment", "literal", "music", "lyrics", "markup", "chords", "drums", "figures", "scheme", "string"]);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function relativeFile(file) {
  check(typeof file === "string" && file.length > 0, "fixture path must be nonempty and relative");
  const normalized = file.replace(/\\/g, "/");
  check(!normalized.startsWith("/") && !/[:\0]/.test(normalized) && !normalized.split("/").includes(".."), "fixture path must be relative and contained");
  const result = path.posix.normalize(normalized);
  check(result !== ".", "fixture path must name a file");
  return result;
}

function contained(root, absolute) {
  const relative = path.relative(root, absolute);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveFixturePath(root, file) {
  const absolute = path.resolve(root, relativeFile(file));
  check(contained(path.resolve(root), absolute), "fixture path escapes containment");
  check(contained(fs.realpathSync(root), fs.realpathSync(absolute)), "fixture symlink escapes containment");
  check(fs.statSync(absolute).isFile(), "fixture path must name a file");
  return absolute;
}

function boundary(source, pos) {
  return Number.isInteger(pos) && pos >= 0 && pos <= source.length &&
    !(pos > 0 && /[\uD800-\uDBFF]/.test(source[pos - 1]) && /[\uDC00-\uDFFF]/.test(source[pos] || ""));
}

function validateCase(item, source) {
  const id = item?.id;
  const fail = message => `${id || "fixture"}: ${message}`;
  check(typeof source === "string" && source.isWellFormed(), fail("invalid Unicode"));
  check(!source.startsWith("\ufeff"), fail("BOM is forbidden"));
  check(!source.includes("\r"), fail("fixtures must use LF; offsets are never normalized"));
  check(typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id), fail("invalid id"));
  check(item.kind === "tex" || item.kind === "ly", fail("invalid kind"));
  check(item.expectations === "target", fail("expectations must identify target data"));
  check(item.origin && ["synthetic", "user-supplied"].includes(item.origin.type) &&
    typeof item.origin.author === "string" && item.origin.author.trim() &&
    typeof item.origin.license === "string" && item.origin.license.trim(), fail("missing origin/license"));
  check(typeof item.syntax === "string" && item.syntax.trim(), fail("missing syntax version"));
  check(item.validity && ["complete", "incomplete", "invalid"].includes(item.validity.status) &&
    typeof item.validity.note === "string" && item.validity.note.trim(), fail("missing validity status/note"));
  check(Array.isArray(item.requirements) && item.requirements.length > 0 &&
    new Set(item.requirements).size === item.requirements.length &&
    item.requirements.every(req => REQUIREMENT_IDS.includes(req) && req.startsWith(item.kind === "tex" ? "TX-" : "LY-")), fail("invalid requirements"));
  check(Array.isArray(item.roles) && Array.isArray(item.contexts) && Array.isArray(item.outline), fail("roles, contexts and outline must be arrays"));
  check(item.outline.every(title => typeof title === "string" && title.trim()), fail("invalid outline title"));
  const covered = new Set();
  const requirement = annotation => {
    check(item.requirements.includes(annotation.requirement), fail("annotation requirement is not declared"));
    covered.add(annotation.requirement);
  };
  const range = span => {
    requirement(span);
    check(boundary(source, span.from) && boundary(source, span.to) && span.from < span.to, fail("invalid range or surrogate split"));
    check(typeof span.text === "string" && source.slice(span.from, span.to) === span.text,
      fail(`annotation text mismatch at [${span.from},${span.to}): ${JSON.stringify(source.slice(span.from, span.to))}`));
  };
  for (const span of item.roles) {
    check(ROLE_NAMES.includes(span.role), fail("unknown role"));
    range(span);
  }
  const sorted = item.roles.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < sorted.length; i++) check(sorted[i].from >= sorted[i - 1].to, fail("overlapping roles"));
  if (item.regions !== undefined) {
    check(Array.isArray(item.regions), fail("regions must be an array"));
    const stack = [], seen = new Set();
    for (const region of item.regions.slice().sort((a, b) => a.from - b.from || b.to - a.to)) {
      range(region);
      check(typeof region.label === "string" && region.label.trim(), fail("missing region label"));
      const key = `${region.from}:${region.to}`;
      check(!seen.has(key), fail("duplicate region")); seen.add(key);
      while (stack.length && region.from >= stack.at(-1).to) stack.pop();
      check(!stack.length || region.to <= stack.at(-1).to, fail("crossed regions"));
      stack.push(region);
    }
  }
  const positions = new Set();
  for (const context of item.contexts) {
    requirement(context);
    check(CONTEXT_MODES.includes(context.mode), fail("unknown context mode"));
    check(boundary(source, context.pos), fail("invalid caret or surrogate split"));
    check(!positions.has(context.pos), fail("duplicate caret"));
    positions.add(context.pos);
    check(typeof context.before === "string" && typeof context.after === "string" &&
      (context.before.length > 0 || context.after.length > 0) &&
      context.before.length <= context.pos && source.slice(context.pos - context.before.length, context.pos) === context.before &&
      source.slice(context.pos, context.pos + context.after.length) === context.after, fail(`caret anchor mismatch at ${context.pos}`));
  }
  check(item.requirements.every(req => covered.has(req)), fail("requirement has no annotation"));
  return item;
}

function metrics(source) {
  return { bytes: Buffer.byteLength(source, "utf8"), codeUnits: source.length, lines: source.split(/\r\n|\r|\n/).length };
}

function validateManifest(manifest, root = FIXTURE_ROOT) {
  check(Array.isArray(manifest), "manifest must be an array");
  check(manifest.length > 0, "manifest must not be empty");
  const ids = new Set(), files = new Set();
  // Check aliases before reading: this is portable even on case-sensitive hosts.
  for (const item of manifest) {
    check(item && typeof item === "object", "invalid case");
    check(!ids.has(item.id), `duplicate id: ${item.id}`); ids.add(item.id);
    const file = relativeFile(item.file).toLowerCase();
    check(!files.has(file), `duplicate file: ${item.file}`); files.add(file);
    check(item.kind === "tex" ? file.endsWith(".tex") : item.kind === "ly" && /\.(?:ly|ily)$/.test(file), "kind/extension mismatch");
  }
  const realFiles = new Set();
  return manifest.map(item => {
    const absolute = resolveFixturePath(root, item.file);
    const real = fs.realpathSync(absolute).toLowerCase();
    check(!realFiles.has(real), `duplicate physical file: ${item.file}`); realFiles.add(real);
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(absolute));
    validateCase(item, source);
    return { ...item, source, metrics: metrics(source) };
  });
}

function loadFixtures(root = FIXTURE_ROOT) {
  const manifest = JSON.parse(fs.readFileSync(resolveFixturePath(root, "cases.json"), "utf8"));
  return validateManifest(manifest, root);
}

function collectBaseline(spec, source) {
  const tokens = [], lines = [], classes = new Array(source.length).fill(null);
  const state = spec.startState();
  let from = 0;
  const endings = [...source.matchAll(/\r\n|\r|\n/g), { index: source.length, 0: "" }];
  for (const ending of endings) {
    const to = ending.index, end = to + ending[0].length;
    lines.push({ from, to, end });
    const stream = new StringStream(source.slice(from, to), 2);
    if (stream.eol() && spec.blankLine) spec.blankLine(state);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const style = spec.token(stream, state) || null;
      check(Number.isInteger(stream.pos) && stream.pos > stream.start && stream.pos <= stream.string.length,
        `tokenizer progress/boundary violation at line ${lines.length}, offset ${from + stream.start}`);
      tokens.push({ from: from + stream.start, to: from + stream.pos, style, line: lines.length });
      classes.fill(style, from + stream.start, from + stream.pos);
    }
    from = end;
  }
  return { tokens, lines, classes, state, metrics: metrics(source) };
}

function generateFixture(kind, bytes, { singleLine = false } = {}) {
  check(kind === "tex" || kind === "ly", "unknown generator kind");
  const eol = singleLine ? " " : "\n";
  const prefix = kind === "tex" ? `\\documentclass{article}${eol}\\begin{document}${eol}` : `\\version "2.26.0"${eol}\\language "nederlands"${eol}{${eol}`;
  const unit = kind === "tex" ? `Testo 😀: $a_1+\\alpha$.${eol}` : `c4 d8 e8 f2 | %{ frase 😀 %}${eol}`;
  const suffix = kind === "tex" ? `\\end{document}${eol}` : `}${eol}`;
  const budget = bytes - Buffer.byteLength(prefix + suffix);
  check(Number.isSafeInteger(bytes) && budget >= 0, "size must be an integer large enough for a complete envelope");
  const width = Buffer.byteLength(unit);
  const source = prefix + unit.repeat(Math.floor(budget / width)) + " ".repeat(budget % width) + suffix;
  return { source, metrics: metrics(source) };
}

// Semantic identities must all come from ESM, just like the browser adapter.
// Callers needing availability metadata can use analysisRolesFor directly.
async function analysisRolesFor(kind, source, options = {}) {
  const [{ analyze }, { highlightTree }, { roleHighlighter }] = await Promise.all([
    import("../../public/iris-language-service.mjs"), import("@lezer/highlight"), import("../../public/iris-syntax-style.mjs"),
  ]);
  const result = await analyze(kind, source, options);
  const roles = result.status === "unavailable" ? null : Array(result.doc.length).fill(null);
  if (roles) highlightTree(result.tree, roleHighlighter, (from, to, role) => roles.fill(role, from, to));
  return { ...result, roles };
}
async function rolesFor(kind, source, options = {}) {
  return (await analysisRolesFor(kind, source, options)).roles;
}
module.exports = { FIXTURE_ROOT, REQUIREMENT_IDS, ROLE_NAMES, CONTEXT_MODES, resolveFixturePath, validateCase, validateManifest, loadFixtures, collectBaseline, generateFixture, rolesFor, analysisRolesFor };
