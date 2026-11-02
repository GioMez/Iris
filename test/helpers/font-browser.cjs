const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

// Install before navigation: observe the browser's actual font responses, not
// independent fetches that could hide a broken CSS path or an installed fallback.
function observeFonts(page) {
  const responses = [];
  page.on("response", response => {
    if (/\/fonts\/.*\.woff2?$/.test(new URL(response.url()).pathname)) {
      responses.push((async () => {
        try {
          const bytes = await response.body();
          return { path: new URL(response.url()).pathname, origin: new URL(response.url()).origin,
            status: response.status(), type: response.headers()["content-type"], bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex") };
        } catch (error) { return { error: error.message, url: response.url() }; }
      })());
    }
  });
  return async baseUrl => {
    const result = await page.evaluate(async () => {
      const sheet = [...document.styleSheets].find(s => s.href && new URL(s.href).pathname === "/iris-fonts.css");
      if (!sheet) throw Error("Local font stylesheet missing");
      const rules = [...sheet.cssRules].filter(r => r.type === CSSRule.FONT_FACE_RULE).map(r => ({
        family: r.style.fontFamily.replace(/["']/g, ""), weight: r.style.fontWeight, style: r.style.fontStyle,
        range: r.style.unicodeRange, src: r.style.src
      }));
      // FontFace.load rejects invalid binaries; status cannot be satisfied by a
      // platform fallback as document.fonts.check alone can be.
      const faces = [...document.fonts];
      await Promise.all(faces.map(face => face.load()));
      await document.fonts.ready;
      const loaded = faces.map(f => ({ family: f.family.replace(/["']/g, ""), weight: f.weight, style: f.style, range: f.unicodeRange, status: f.status }));
      const selections = [];
      for (const [family, style, weight] of [
        ["IBM Plex Sans", "normal", "400"], ["IBM Plex Sans", "normal", "500"], ["IBM Plex Sans", "normal", "600"],
        ["IBM Plex Mono", "normal", "400"], ["IBM Plex Mono", "normal", "500"], ["IBM Plex Mono", "normal", "600"], ["IBM Plex Mono", "italic", "400"],
        ["CMU Serif", "normal", "500"], ["CMU Serif", "italic", "500"], ["CMU Serif", "normal", "700"], ["CMU Serif", "italic", "700"]
      ]) {
        const selected = await document.fonts.load(`${style} ${weight} 16px "${family}"`, "Iris Àé Ā ắ Ж Ѣ α");
        selections.push({ family, style, weight, faces: selected.map(f => ({ family: f.family.replace(/["']/g, ""), weight: f.weight, style: f.style, status: f.status })) });
      }
      return { rules, loaded, selections };
    });
    assert.equal(result.rules.length, 42);
    assert.equal(result.loaded.length, 42);
    const descriptors = {};
    for (const face of result.loaded) {
      assert.equal(face.status, "loaded");
      const key = `${face.family}/${face.style}/${face.weight}`;
      descriptors[key] = (descriptors[key] || 0) + 1;
    }
    assert.deepEqual(descriptors, {
      "IBM Plex Mono/italic/400": 5, "IBM Plex Mono/normal/400": 5, "IBM Plex Mono/normal/500": 5, "IBM Plex Mono/normal/600": 5,
      "IBM Plex Sans/normal/400": 6, "IBM Plex Sans/normal/500": 6, "IBM Plex Sans/normal/600": 6,
      "CMU Serif/normal/500": 1, "CMU Serif/italic/500": 1, "CMU Serif/normal/700": 1, "CMU Serif/italic/700": 1
    });
    for (const selection of result.selections) {
      assert.equal(selection.faces.length, selection.family === "CMU Serif" ? 1 : selection.family === "IBM Plex Sans" ? 6 : 5);
      for (const face of selection.faces) assert.deepEqual(face, { family: selection.family, style: selection.style, weight: selection.weight, status: "loaded" });
    }
    for (const rule of result.rules) assert.match(rule.src, /^url\(["']?fonts\/[a-z0-9.-]+\.woff2?["']?\) format\(["']woff2?["']\)$/);
    const manifestResponse = await page.request.get(`${baseUrl}/fonts/manifest.json`);
    assert.equal(manifestResponse.status(), 200);
    const manifest = await manifestResponse.json();
    for (const rule of result.rules) {
      const file = rule.src.match(/fonts\/([a-z0-9.-]+\.woff2?)/)[1];
      const asset = manifest.assets.find(a => a.file === file);
      assert.ok(asset, file);
      assert.equal(rule.family, asset.family, file);
      assert.equal(rule.style, asset.style, file);
      assert.ok(asset.weights.includes(Number(rule.weight)), file);
    }
    const http = await Promise.all(responses);
    assert.deepEqual([...new Set(http.map(r => r.path))].sort(), manifest.assets.map(a => `/fonts/${a.file}`).sort());
    for (const response of http) {
      assert.equal(response.origin, baseUrl);
      assert.equal(response.status, 200, response.path);
      assert.equal(response.type, response.path.endsWith("woff2") ? "font/woff2" : "font/woff");
      const asset = manifest.assets.find(a => `/fonts/${a.file}` === response.path);
      assert.equal(response.sha256, asset.sha256, response.path);
      assert.equal(response.bytes, asset.bytes, response.path);
    }
    for (const license of manifest.licenses) {
      const response = await page.request.get(`${baseUrl}/fonts/${license.file}`);
      assert.equal(response.status(), 200, "packaged full license is served locally");
      assert.equal(createHash("sha256").update(await response.body()).digest("hex"), license.sha256);
    }
    return { faces: result.loaded, selections: result.selections, http };
  };
}
module.exports = { observeFonts };
