const { spawn } = require("node:child_process");
const path = require("node:path");
const zlib = require("node:zlib");
const { MAX_MAP_BYTES, MAX_ENTRIES, failure, sourceResolver, sourceMatch, validMatch, retainNavigationMatch } = require("./source-mapping-common");

let activeQueries = 0;

// Slots are released on close, including kills. There is deliberately no queue.
async function runNativeQuery(command, args, { cwd, binPath = "", signal, timeoutMs = 5000, spawnChild = spawn } = {}) {
  if (signal?.aborted) throw failure("cancelled");
  if (activeQueries >= 2) throw failure("busy");
  activeQueries++;
  try {
    return await new Promise((resolve, reject) => {
      let child, timer, reason, bytes = 0;
      const stdout = [], stderr = [];
      const kill = (why) => {
        reason ||= why;
        if (!child?.pid) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
      };
      const cancel = () => kill("cancelled");
      try {
        child = spawnChild(command, args, {
          cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: [binPath, process.env.PATH].filter(Boolean).join(path.delimiter), HOME: process.env.HOME || "/tmp", TMPDIR: process.env.TMPDIR || "/tmp", LANG: "en_US.UTF-8", SYNCTEX_EDITOR: "", SYNCTEX_VIEWER: "" },
        });
      } catch { reject(failure("engine-missing")); return; }
      const consume = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) kill("output-limit");
        else if (!reason) target.push(chunk);
      };
      child.stdout.on("data", consume(stdout)); child.stderr.on("data", consume(stderr));
      child.once("error", () => { reason ||= "engine-missing"; });
      child.once("close", (code) => {
        clearTimeout(timer); signal?.removeEventListener("abort", cancel);
        if (reason || code !== 0) reject(failure(reason || "query-failed"));
        else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      });
      timer = setTimeout(() => kill("timeout"), Math.max(1, Math.min(5000, timeoutMs)));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  } finally { activeQueries--; }
}

function inspectSyncTeX(bytes, context) {
  if (bytes.length > MAX_MAP_BYTES) throw failure("map-limit");
  let text;
  try { text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes, { maxOutputLength: MAX_MAP_BYTES }) : bytes).toString("utf8"); }
  catch { throw failure("map-limit"); }
  if (!text.startsWith("SyncTeX Version:1\n")) throw failure(/^SyncTeX Version:\d+\n/.test(text) ? "unsupported" : "malformed-map");
  const inputs = [], seen = new Set();
  const resolve = sourceResolver(context.sources, context.snapshotRoot);
  let count = 0;
  for (const line of text.split("\n", MAX_ENTRIES + 1)) {
    if (++count > MAX_ENTRIES) throw failure("map-limit");
    if (!line.startsWith("Input:")) continue;
    const match = /^Input:(\d+):(.+)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 || seen.has(Number(match[1]))) throw failure("malformed-map");
    seen.add(Number(match[1]));
    const source = resolve(match[2]);
    if (source) inputs.push({ tag: Number(match[1]), input: match[2], sourceFileId: source.sourceFileId });
  }
  return { inputs, entries: count, decodedBytes: Buffer.byteLength(text) };
}

function readSyncTeXInputs(bytes, context) { return inspectSyncTeX(bytes, context).inputs; }

function parseSyncTeX(text, { sources, snapshotRoot, artifact, source, query, inputs = [] }) {
  const matches = [];
  const resolve = sourceResolver(sources, snapshotRoot);
  const byId = new Map(sources.map((s) => [s.sourceFileId, s]));
  const byInput = new Map(inputs.map((i) => [i.input, byId.get(i.sourceFileId)]));
  const rowCounts = new Map();
  const hasRow = (s, row) => {
    if (!rowCounts.has(s)) rowCounts.set(s, s.text.split("\n", MAX_ENTRIES + 1).length);
    return Number.isSafeInteger(row) && row > 0 && row <= rowCounts.get(s);
  };
  let record = null;
  const finish = () => {
    if (!record) return;
    let match;
    if (query.direction === "forward") {
      const x = Number(record.h), bottom = Number(record.v), width = Number(record.W), height = Number(record.H);
      if (!source || !hasRow(source, query.line) || [record.h, record.v, record.W, record.H, record.Page].some((v) => v === undefined)) return;
      match = { artifactId: artifact.id, page: Number(record.Page), x, y: bottom - height, width, height, ...sourceMatch(source, query.line, null) };
    } else {
      const found = byInput.get(record.Input) || resolve(record.Input);
      if (!found || !hasRow(found, Number(record.Line))) return;
      // SyncTeX columns are not reliably emitted by supported engines. Preserve
      // row precision rather than guessing byte/character conventions.
      match = { artifactId: artifact.id, page: query.page, x: query.x, y: query.y, width: 0, height: 0, ...sourceMatch(found, Number(record.Line), null) };
    }
    if (validMatch(match)) retainNavigationMatch(matches, match, query);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "SyncTeX result begin") record = {};
    else if (line === "SyncTeX result end") { finish(); record = null; }
    else if (record) {
      const field = /^([A-Za-z]+):(.*)$/.exec(line);
      if (!field) continue;
      if ((field[1] === "Output" || field[1] === "Input") && record[field[1]] !== undefined) { finish(); record = {}; }
      record[field[1]] = field[2];
    }
  }
  return matches;
}

async function querySyncTeX({ directory, artifact, sources, snapshotRoot, query, binPath = "", signal, spawnChild, timeoutMs }) {
  const source = sources.find((s) => s.sourceFileId === query.sourceFileId);
  const input = artifact.inputs?.find((i) => i.sourceFileId === query.sourceFileId);
  if (query.direction === "forward" && (!source || !input)) return [];
  const pdf = path.join(directory, artifact.fileName);
  const args = query.direction === "forward"
    ? ["view", "-i", `${query.line}:0:${input.input}`, "-o", pdf]
    : ["edit", "-o", `${query.page}:${query.x}:${query.y}:${pdf}`];
  const command = binPath ? path.join(binPath, "synctex") : "synctex";
  const result = await runNativeQuery(command, args, { cwd: directory, binPath, signal, spawnChild, timeoutMs });
  return parseSyncTeX(result.stdout, { sources, snapshotRoot, artifact, source, query, inputs: artifact.inputs });
}

module.exports = { runNativeQuery, readSyncTeXInputs, inspectSyncTeX, parseSyncTeX, querySyncTeX };
