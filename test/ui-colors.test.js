const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const namedColors = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
  "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
  "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
  "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey " +
  "honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
  "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen " +
  "linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
  "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred " +
  "papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna " +
  "silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));
// Named, functional, hexadecimal and URL-encoded colors. Numeric HTML entities
// and CSS ID selectors are not color values.
const literal = /(?<![\w&])(?:#|%23)(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|\b(?:black|white|red|blue|green|yellow|gray|grey|orange|purple|pink|navy|teal|lime|maroon|aqua|fuchsia|silver|olive|rebeccapurple)\b/gi;
function colors(value) {
  value = value.replace(/--[\w-]+/g, "");
  const found = [...value.matchAll(literal)].map((match) => match[0]);
  for (const word of value.match(/\b[a-z]+\b/gi) || []) {
    if (namedColors.has(word.toLowerCase()) && !found.includes(word)) found.push(word);
  }
  return found;
}
function violations(file, source) {
  const issues = [];
  source = source.replace(/\/\*[\s\S]*?\*\//g, "");
  if (file.endsWith(".css")) {
    for (const match of source.matchAll(/([\w-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
      const [, property, value] = match;
      if (property.startsWith("--palette-")) continue;
      if (property === "--icon-alert-circle" && colors(value).join() === "%23000") continue;
      const found = colors(value);
      if (found.length) issues.push(`${property}: ${found.join(", ")}`);
    }
  } else if (file.endsWith(".js")) {
    // Scan standalone strings independently so quotes inside template
    // interpolations cannot hide a fallback literal.
    for (const match of source.matchAll(/(["'])(#[\da-f]{3,8}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^"'\n]*\)|[a-z]+)\1/gi)) {
      const value = match[2];
      if (colors(value).length && !issues.includes(value)) issues.push(value);
    }
    for (const match of source.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      const value = match[1];
      if (namedColors.has(value.toLowerCase()) || /^(?:#|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|color\()/i.test(value) || /(?:color|background|fill|stroke)\s*[:=]/i.test(value)) {
        const found = colors(value);
        if (found.length && !issues.includes(value)) issues.push(value);
      }
    }
  } else {
    for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) issues.push(...violations("inline.css", match[1]));
    for (const match of source.matchAll(/(?:style|fill|stroke|color|bgcolor)\s*=\s*["']([^"']*)["']/gi)) {
      const found = colors(match[1]);
      if (found.length) issues.push(match[0]);
    }
  }
  return issues;
}

// Repository-relative paths; keep exceptions at this boundary so direct scans
// and the filesystem walk exercise the same policy.
function runtimeViolations(file, source) {
  file = file.replace(/\\/g, "/");
  const brand = new Set(["public/iris_logo.svg", "public/iris_logo_w.svg", "public/iris_text_logo_w.svg"]);
  if (brand.has(file)) return [];
  // Only the server-assigned identity array is exempt, not UI fallbacks.
  if (file === "src/collab.js") source = source.replace(/const PEER_COLORS = \[[\s\S]*?\];/, "");
  return violations(file, source);
}

test("known artwork exceptions accept POSIX and Windows relative paths only", () => {
  for (const separator of ["/", "\\"]) {
    for (const name of ["iris_logo.svg", "iris_logo_w.svg", "iris_text_logo_w.svg"]) {
      assert.deepEqual(runtimeViolations(`public${separator}${name}`, '<svg fill="#fff"/>'), []);
      assert.equal(runtimeViolations(`public${separator}icons${separator}${name}`, '<svg fill="#fff"/>').length, 1);
    }
    assert.equal(runtimeViolations(`public${separator}ordinary.svg`, '<svg fill="#fff"/>').length, 1);
  }
});

test("peer array exception is path-independent and cannot hide ordinary UI paint", () => {
  const peers = 'const PEER_COLORS = ["#123456", "coral"];';
  for (const separator of ["/", "\\"]) {
    const file = `src${separator}collab.js`;
    assert.deepEqual(runtimeViolations(file, peers), []);
    assert.deepEqual(runtimeViolations(file, peers + '\nnode.style.color = "#abcdef";'), ["#abcdef"]);
    assert.deepEqual(runtimeViolations(file, 'const UI_COLORS = ["#123456"];'), ["#123456"]);
    assert.ok(runtimeViolations(`src${separator}other.js`, peers).length > 0);
    assert.ok(runtimeViolations(`src${separator}nested${separator}collab.js`, peers).length > 0);
  }
});

test("color contract detects new literals including encoded UI SVG colors", () => {
  for (const value of ["#abc", "rgba(1,2,3,.5)", "red", "cornflowerblue", "oklch(50% .1 30)", "url(\"data:image/svg+xml,stroke='%239aa5ce'\")"]) {
    assert.equal(violations("test.css", `.control{background:${value}}`).length, 1, value);
  }
  assert.deepEqual(violations("test.css", ":root{--palette-ink:#123456}.control{color:var(--txt)}"), []);
  assert.equal(violations("test.js", 'const color = peer.color || "#123456";').length, 1);
  assert.equal(violations("test.js", 'const style = `--color:${peer.color || "#abcdef"}`;').length, 1);
  assert.equal(violations("test.js", 'node.style.color = "coral";').length, 1);
  assert.equal(violations("test.html", '<svg stroke="red"/>').length, 1);
  assert.equal(violations("test.html", '<style>.control{color:coral}</style>').length, 1);
});

test("first-party runtime colors are palette primitives or individually documented exceptions", () => {
  const failures = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "vendor") continue;
      const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.(?:css|js|html|svg)$/.test(entry.name)) {
        const source = fs.readFileSync(absolute, "utf8");
        failures.push(...runtimeViolations(relative, source).map((issue) => `${relative}: ${issue}`));
      }
    }
  }
  walk(path.join(root, "public"));
  walk(path.join(root, "src"));
  assert.deepEqual(failures, [], "literal UI colors bypass theme roles");
});

test("template fallbacks cannot hide named or modern functional colors", () => {
  for (const value of ["coral", "cornflowerblue", "oklch(50% .1 30)", "color(display-p3 1 0 0)", "hwb(30 10% 20%)", "lab(50% 20 30)"]) {
    for (const quote of ['"', "'"]) {
      const source = 'const style = `--peer-color:${peer.color || ' + quote + value + quote + '}`;';
      assert.equal(violations("test.js", source).length, 1, source);
    }
  }
  assert.deepEqual(violations("test.js", 'const style = `--peer-color:${peer.color || "var(--peer-fallback)"}`;'), []);
});
