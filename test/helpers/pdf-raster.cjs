const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

// Read rendered ink, independently of compiler maps and PDF annotations.
async function redPixels(pdf, directory, stem, color = "red") {
  const pattern = path.join(directory, `${stem}-%d.ppm`);
  await promisify(execFile)("gs", ["-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=ppmraw", "-r72", `-sOutputFile=${pattern}`, pdf], {
    cwd: directory, timeout: 45000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), LANG: "en_US.UTF-8" },
  });
  const pages = [];
  for (let page = 1; ; page++) {
    const bytes = await fs.readFile(path.join(directory, `${stem}-${page}.ppm`)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
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
    assert.equal(bytes.length - offset, 3 * width * height);
    const red = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = offset + 3 * (y * width + x);
      if (color === "ink" ? Math.min(bytes[i], bytes[i + 1], bytes[i + 2]) < 240
        : color === "black" ? bytes[i] < 100 && bytes[i + 1] < 100 && bytes[i + 2] < 100 : bytes[i] > 150 && bytes[i + 1] < 100 && bytes[i + 2] < 100) red.push([x, y]);
    }
    pages.push({ page, width, height, red });
  }
  return pages;
}

module.exports = { redPixels };
