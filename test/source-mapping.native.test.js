const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const enabled = process.env.IRIS_TEST_COMPILERS === "1";
const mapping = enabled ? require("../src/source-mapping") : null;
const options = { skip: !enabled, timeout: 60000 };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (tool, args, cwd) => exec(tool, args, { cwd, timeout: 45000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: os.tmpdir(), SYNCTEX_EDITOR: "", SYNCTEX_VIEWER: "", LANG: "en_US.UTF-8" } });

async function fixture(t, backend, files, extraArgs = [], { sourceMapping = true, expectedStatus = "ready", beforeCompile } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `iris-map-native-${backend}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const staging = path.join(root, "staging"), outputDir = path.join(staging, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const buildId = randomUUID(), projectId = randomUUID();
  const records = [];
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(staging, name)), { recursive: true });
    await fs.writeFile(path.join(staging, name), text);
    records.push({ id: randomUUID(), path: name, kind: backend === "latex" ? "tex" : "ly" });
  }
  const sources = await mapping.captureMappingSources(staging, records, new Map(records.map((r) => [r.id, randomUUID()])));
  if (beforeCompile) await beforeCompile(outputDir);
  const tool = backend === "latex" ? "pdflatex" : "lilypond";
  try {
    await run(tool, backend === "latex" ? ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", sourceMapping ? "-synctex=1" : "-synctex=0", "-output-directory=output", "main.tex"] : ["--pdf", "--output=output/main", ...mapping.lilypondMappingArgs(sourceMapping, "pdf"), ...extraArgs, "main.ly"], staging);
  } catch (error) { throw new Error(`Required native ${tool} failed: ${error.message}\n${error.stdout || ""}\n${error.stderr || ""}`); }
  const artifacts = [];
  for (const name of (await fs.readdir(outputDir)).filter((n) => n.endsWith(".pdf")).sort()) {
    const bytes = await fs.readFile(path.join(outputDir, name));
    artifacts.push({ id: randomUUID(), fileName: name, size: bytes.length, contentHash: hash(bytes) });
  }
  assert.ok(artifacts.length);
  const publication = await mapping.publishSourceMapping({ outputDir, snapshotRoot: staging, sources, projectId, buildId, artifacts, backend, enabled: sourceMapping, format: "pdf" });
  assert.equal(publication.status, expectedStatus, JSON.stringify(publication));
  await fs.mkdir(path.join(root, "output"));
  const directory = path.join(root, "output", buildId);
  await fs.rename(outputDir, directory);
  await fs.rm(staging, { recursive: true });
  const ctx = { projectStorageDir: root, projectId, buildId, storagePath: `output/${buildId}`, artifacts, enabled: true };
  const navigate = (query) => mapping.navigateBuild({ ...ctx, query });
  return { root, directory, sources, artifacts, navigate };
}

test("native SyncTeX forward and inverse use retained output, Unicode/spaced includes and physical pages", options, async (t) => {
  const f = await fixture(t, "latex", {
    "main.tex": "\\documentclass{article}\n\\begin{document}\n\\setcounter{page}{7}\n\\input{parts/é section one.tex}\n\\newpage\nSecond page.\n\\end{document}\n",
    "parts/é section one.tex": "A retained included source.\n",
  });
  const source = f.sources.find((s) => s.path.startsWith("parts/"));
  const forward = await f.navigate({ direction: "forward", sourceFileId: source.sourceFileId, line: 1, column: 0 });
  assert.equal(forward.status, "ready", JSON.stringify(forward));
  const match = forward.matches[0];
  assert.equal(match.page, 1);
  assert.equal(match.artifactId, f.artifacts[0].id);
  assert.ok(match.x > 50 && match.x < 200 && match.y > 50 && match.y < 200);
  const inverse = await f.navigate({ direction: "inverse", artifactId: match.artifactId, page: 1, x: match.x + 3, y: match.y + match.height / 2 });
  assert.equal(inverse.status, "ready", JSON.stringify(inverse));
  assert.equal(inverse.matches[0].sourceFileId, source.sourceFileId);
  assert.equal(inverse.matches[0].line, 1);
  assert.equal(inverse.matches[0].column, null);
  const pages = await redPixels(path.join(f.directory, "main.pdf"), f.directory, "tex", "black");
  const ink = pages[0].red;
  assert.ok(ink.length > 200);
  // The first physical page contains just this text and its printed page number.
  const textInk = ink.filter(([, y]) => y < 300);
  assert.ok(textInk.length > 100);
  assert.equal(textInk.filter(([x, y]) => x < match.x - 1 || x > match.x + match.width + 1 || y < match.y - 1 || y > match.y + match.height + 1).length, 0);
  t.diagnostic(JSON.stringify({ texRaster: { width: pages[0].width, height: pages[0].height, textPixels: textInk.length } }));
  t.diagnostic(JSON.stringify({ artifacts: f.artifacts, forward: match, inverse: inverse.matches[0] }));
});

// Parse Ghostscript's raw PPM raster, without inspecting PDF annotations.
async function redPixels(pdf, directory, stem, color = "red") {
  const pattern = path.join(directory, `${stem}-%d.ppm`);
  await run("gs", ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=ppmraw", "-r72", `-sOutputFile=${pattern}`, pdf], directory);
  const pages = [];
  for (let page = 1; ; page++) {
    const bytes = await fs.readFile(path.join(directory, `${stem}-${page}.ppm`)).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
    if (!bytes) break;
    let offset = 0;
    const token = () => {
      while (bytes[offset] <= 32 || bytes[offset] === 35) {
        if (bytes[offset] === 35) while (bytes[offset] !== 10) offset++;
        else offset++;
      }
      const start = offset;
      while (bytes[offset] > 32) offset++;
      return bytes.subarray(start, offset).toString();
    };
    assert.equal(token(), "P6");
    const width = Number(token()), height = Number(token());
    assert.equal(token(), "255"); offset++;
    const red = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = offset + 3 * (y * width + x);
      if (color === "black" ? bytes[i] < 100 && bytes[i + 1] < 100 && bytes[i + 2] < 100 : bytes[i] > 150 && bytes[i + 1] < 100 && bytes[i + 2] < 100) red.push([x, y]);
    }
    pages.push({ page, width, height, red });
  }
  return pages;
}

for (const transformed of [false, true]) test(`native LilyPond final-page geometry matches rasterized chords/rests/repeats across books (${transformed ? "scaled/rotated/translated" : "standard PS"})`, options, async (t) => {
  const transform = transformed ? `#(let* ((m (resolve-module '(lily framework-ps))) (original (module-ref m 'output-stencils)))
    (module-set! m 'output-stencils (lambda (name stencils header paper formats)
      (original name (map (lambda (s) (ly:stencil-translate (ly:stencil-rotate (ly:stencil-scale s 0.8 0.9) 8 0 0) '(15 . -20))) stencils) header paper formats))))\n` : "";
  const f = await fixture(t, "lilypond", {
    "main.ly": `\\version "2.26.0"\n${transform}\\include "parts/é air.ly"\n\\paper { first-page-number = 7 print-page-number = ##t }\n\\book { \\bookOutputSuffix "one" \\score { \\theme } \\pageBreak \\score { \\theme } }\n\\book { \\bookOutputSuffix "two" \\score { \\theme } }\n`,
    "parts/é air.ly": `theme = { \\override NoteHead.color = #red \\override Rest.color = #red c'4^"é😀" <e' g'>4 r4 d'4 }\n`,
  });
  assert.deepEqual(f.artifacts.map((a) => a.fileName), ["main-one.pdf", "main-two.pdf"]);
  const source = f.sources.find((s) => s.path.startsWith("parts/"));
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, mapping.MANIFEST_NAME), "utf8"));
  const entries = manifest.entries.filter((m) => m.sourceFileId === source.sourceFileId);
  assert.ok(entries.some((m) => m.page === 2));
  const dColumn = source.text.indexOf("d'4");
  assert.ok(entries.some((m) => m.column === dColumn), `UTF-16 d column ${dColumn}, observed ${entries.map((m) => m.column)}`);
  for (const m of entries.filter((e) => e.column === dColumn)) assert.ok(m.width > 2 && m.width < 12 && m.height > 2 && m.height < 10, JSON.stringify(m));
  t.diagnostic(JSON.stringify({ nativeArtifacts: f.artifacts, dColumn, dRectangle: entries.find((e) => e.column === dColumn), transformed }));
  for (const artifact of f.artifacts) {
    const pages = await redPixels(path.join(f.directory, artifact.fileName), f.directory, artifact.fileName);
    for (const page of pages) {
      assert.ok(page.red.length > 20, "rendered red music required");
      const rectangles = entries.filter((m) => m.artifactId === artifact.id && m.page === page.page);
      const uncovered = page.red.filter(([x, y]) => !rectangles.some((m) => x >= m.x - 2 && x <= m.x + m.width + 2 && y >= m.y - 2 && y <= m.y + m.height + 2));
      assert.equal(uncovered.length, 0, `uncovered red pixels: ${JSON.stringify(uncovered.slice(0, 10))}; rectangles ${JSON.stringify(rectangles)}`);
      t.diagnostic(JSON.stringify({ artifact: artifact.fileName, page: page.page, width: page.width, height: page.height, redPixels: page.red.length, rectangles: rectangles.length, transformed }));
    }
  }
  const forward = await f.navigate({ direction: "forward", sourceFileId: source.sourceFileId, line: 1, column: dColumn });
  assert.equal(forward.status, "ready");
  const m = forward.matches[0];
  const inverse = await f.navigate({ direction: "inverse", artifactId: m.artifactId, page: m.page, x: m.x + m.width / 2, y: m.y + m.height / 2 });
  assert.equal(inverse.status, "ready");
  assert.equal(inverse.matches[0].sourceFileId, source.sourceFileId);
});

test("native Lily collector I/O failure leaves both successful PDF output and an unavailable map", options, async (t) => {
  const f = await fixture(t, "lilypond", { "main.ly": "\\version \"2.26.0\"\n{ c'4 d'4 }\n" }, [], {
    expectedStatus: "unavailable", beforeCompile: (outputDir) => fs.mkdir(path.join(outputDir, "main.iris-map.tsv")),
  });
  assert.equal((await fs.readFile(path.join(f.directory, "main.pdf"))).subarray(0, 5).toString(), "%PDF-");
  const result = await f.navigate({ direction: "forward", sourceFileId: f.sources[0].sourceFileId, line: 2, column: 2 });
  assert.equal(result.status, "unavailable");
});

for (const backend of ["latex", "lilypond"]) test(`native ${backend} disabled setting avoids mapping sidecars while producing PDF`, options, async (t) => {
  const files = backend === "latex" ? { "main.tex": "\\documentclass{article}\n\\begin{document}Disabled map.\\end{document}" } : { "main.ly": "\\version \"2.26.0\"\n{ c'4 d'4 }\n" };
  const f = await fixture(t, backend, files, [], { sourceMapping: false, expectedStatus: "disabled" });
  const names = await fs.readdir(f.directory);
  assert.equal(names.some((n) => n.includes(".synctex") || n.includes(".iris-map") || n === mapping.MANIFEST_NAME), false);
  assert.equal((await f.navigate({ direction: "forward", sourceFileId: f.sources[0].sourceFileId, line: 1, column: 0 })).status, "missing");
});

test("native Lily settings includes remain effective alongside the compilation-local collector", options, async (t) => {
  const f = await fixture(t, "lilypond", {
    "main.ly": "\\version \"2.26.0\"\n\\settingsMusic\n",
    "settings.ily": "settingsMusic = { c'4 d'4 }\n\\paper { first-page-number = 9 }\n",
  }, ["-dinclude-settings=settings.ily"]);
  const source = f.sources.find((s) => s.path === "settings.ily");
  const result = await f.navigate({ direction: "forward", sourceFileId: source.sourceFileId, line: 1, column: 18 });
  assert.equal(result.status, "ready");
  assert.equal(result.matches[0].page, 1);
});

test("native Lily transform-depth budget fails mapping while the normal outputter still produces PDF", options, async (t) => {
  const f = await fixture(t, "lilypond", { "main.ly": `\\version "2.26.0"
#(let* ((m (resolve-module '(lily framework-ps))) (original (module-ref m 'output-stencils)))
  (module-set! m 'output-stencils (lambda (name stencils header paper formats)
    (original name (map (lambda (s) (let loop ((i 0) (result s))
      (if (= i 300) result (loop (1+ i) (ly:stencil-scale result 1.0001 0.9999))))) stencils) header paper formats))))
{ c'4 d'4 }
` }, [], { expectedStatus: "unavailable" });
  const result = await f.navigate({ direction: "forward", sourceFileId: f.sources[0].sourceFileId, line: 6, column: 2 });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "map-limit");
  assert.ok(f.artifacts[0].size > 1000);
});

test("native Lily landscape coordinates use the unrotated PDF page", options, async (t) => {
  const f = await fixture(t, "lilypond", { "main.ly": `\\version "2.26.0"
\\paper { #(set-paper-size "a4" 'landscape) }
{ \\override NoteHead.color = #red c'4 d'4 }
` });
  const pdf = path.join(f.directory, "main.pdf");
  const metadata = await run("gs", ["-q", "-dSAFER", "-dBATCH", "-dNODISPLAY", `--permit-file-read=${pdf}`, `-sPDFname=${pdf}`, "-c", "PDFname (r) file runpdfbegin 1 pdfgetpage dup /MediaBox get == dup /Rotate known { /Rotate get == } { pop 0 == } ifelse quit"], f.directory);
  t.diagnostic(`Landscape PDF MediaBox/Rotate: ${metadata.stdout.trim()}`);
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, mapping.MANIFEST_NAME)));
  const pages = await redPixels(pdf, f.directory, "landscape");
  const rotation = Number(metadata.stdout.trim().split("\n").at(-1));
  const media = /\[([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\]/.exec(metadata.stdout);
  assert.ok(media);
  const width = Number(media[3]), height = Number(media[4]);
  const unrotate = ([x, y]) => rotation === 90 ? [y, height - x] : rotation === 270 ? [width - y, x] : [x, y];
  const pixels = pages[0].red.map(unrotate);
  assert.ok(pixels.length > 20);
  const uncovered = pixels.filter(([x, y]) => !manifest.entries.some((m) => x >= m.x - 2 && x <= m.x + m.width + 2 && y >= m.y - 2 && y <= m.y + m.height + 2));
  assert.equal(uncovered.length, 0, JSON.stringify({ pixels: uncovered.slice(0, 10), entries: manifest.entries }));
});

test("native SyncTeX prefers physical page 40 for reused source beyond the 32-match response cap", options, async (t) => {
  const f = await fixture(t, "latex", {
    // One source row yields geometry on fifty pages, without repeated input
    // tags (the native CLI selects only the last tag for repeated \input).
    "main.tex": "\\documentclass{article}\\begin{document}\n" + Array.from({ length: 50 }, (_, i) => `${i ? "\\newpage " : ""}Repeated source on fifty physical pages.\\par `).join("") + "\n\\end{document}\n",
  });
  const part = f.sources[0];
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory, mapping.MANIFEST_NAME)));
  const input = manifest.artifacts[0].inputs.find((entry) => entry.sourceFileId === part.sourceFileId).input;
  const raw = await run("synctex", ["view", "-i", `2:0:${input}`, "-o", path.join(f.directory, "main.pdf")], f.directory);
  const nativePages = Array.from(raw.stdout.matchAll(/^Page:(\d+)$/gm), (match) => Number(match[1]));
  assert.ok(nativePages.indexOf(40) >= 32, JSON.stringify(nativePages));
  const result = await f.navigate({ direction: "forward", sourceFileId: part.sourceFileId, line: 2, column: 0, artifactId: f.artifacts[0].id, page: 40 });
  assert.equal(result.status, "ready", JSON.stringify(result));
  t.diagnostic(JSON.stringify({ pages: result.matches.map((m) => m.page), requestedPage: 40 }));
  assert.equal(result.matches.length, 32);
  assert.equal(result.matches[0].page, 40);
  assert.equal(result.matches[0].sourceFileId, part.sourceFileId);
  t.diagnostic(JSON.stringify({ nativeRecordCount: nativePages.length, preferredNativeRecord: nativePages.indexOf(40) + 1, preferredPage: result.matches[0].page, matchCount: result.matches.length, artifactBytes: f.artifacts[0].size }));
});
