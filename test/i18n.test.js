const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const en = JSON.parse(fs.readFileSync(path.join(publicDir, "locales/en/translation.json"), "utf8"));
const it = JSON.parse(fs.readFileSync(path.join(publicDir, "locales/it/translation.json"), "utf8"));
const html = fs.readFileSync(path.join(publicDir, "Iris.html"), "utf8");
const runtime = fs.readFileSync(path.join(publicDir, "iris-i18n.js"), "utf8");
const app = fs.readFileSync(path.join(publicDir, "iris-app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
const uiScripts = [
  "iris-projects.js", "iris-builds.js", "iris-admin.js", "iris-admin-projects.js",
  "iris-admin-templates.js", "iris-auth.js", "iris-lilypond.js", "iris-diagnostics.js",
]
  .map((file) => fs.readFileSync(path.join(publicDir, file), "utf8"));
uiScripts.unshift(app);

function flatten(value, prefix = "", output = {}) {
  Object.entries(value).forEach(([key, child]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, fullKey, output);
    else output[fullKey] = child;
  });
  return output;
}

function placeholders(value) {
  return [...String(value).matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g)].map((match) => match[1]).sort();
}

const english = flatten(en);
const italian = flatten(it);

test("English is the default locale and the i18n runtime loads before UI modules", () => {
  assert.match(html, /<html lang="en">/);
  assert.match(runtime, /const DEFAULT_LANGUAGE = "en"/);
  const i18nIndex = html.indexOf('<script src="iris-i18n.js">');
  assert.ok(i18nIndex > html.indexOf('<script src="iris-icons.js">'));
  ["iris-app.js", "iris-projects.js", "iris-builds.js", "iris-auth.js"].forEach((script) => {
    assert.ok(i18nIndex < html.indexOf(`<script src="${script}">`), `${script} must load after translations`);
  });
});

test("English and Italian catalogs have identical non-empty keys and placeholders", () => {
  assert.deepEqual(Object.keys(italian).sort(), Object.keys(english).sort());
  Object.keys(english).forEach((key) => {
    assert.equal(typeof english[key], "string", `${key} must be a string in English`);
    assert.equal(typeof italian[key], "string", `${key} must be a string in Italian`);
    assert.ok(english[key].trim(), `${key} is empty in English`);
    assert.ok(italian[key].trim(), `${key} is empty in Italian`);
    assert.deepEqual(placeholders(italian[key]), placeholders(english[key]), `${key} has mismatched placeholders`);
  });
});

test("all static and literal dynamic translation keys exist", () => {
  const staticKeys = [...html.matchAll(/data-i18n(?:-(?:title|placeholder|aria-label))?="([^"]+)"/g)]
    .map((match) => match[1]);
  const dynamicKeys = uiScripts.flatMap((source) =>
    [...source.matchAll(/(?:\bt|IrisI18n\.t)\(\s*["']([^"']+)["']/g)].map((match) => match[1])
  );
  [...new Set([...staticKeys, ...dynamicKeys])].forEach((key) => {
    const exists = key in english || `${key}_one` in english || `${key}_other` in english;
    assert.ok(exists, `Missing English translation key ${key}`);
  });
});

test("plural messages use i18next v4 CLDR suffixes", () => {
  const pluralBases = new Set(Object.keys(english).filter((key) => key.endsWith("_one")).map((key) => key.slice(0, -4)));
  assert.ok(pluralBases.size > 0);
  pluralBases.forEach((base) => {
    assert.ok(`${base}_other` in english, `${base} is missing the English other form`);
    assert.ok(`${base}_one` in italian, `${base} is missing the Italian one form`);
    assert.ok(`${base}_other` in italian, `${base} is missing the Italian other form`);
  });
  assert.match(runtime, /new Intl\.PluralRules/);
});

test("every API error code returned by the server is translated", () => {
  const codes = new Set([
    ...[...server.matchAll(/requestError\("([A-Z0-9_]+)"/g)].map((match) => match[1]),
    ...[...server.matchAll(/errorJson\([^\n]*"([A-Z0-9_]+)"/g)].map((match) => match[1]),
    "SERVER_ERROR",
  ]);
  codes.forEach((code) => {
    assert.ok(`api.${code}` in english, `Missing English API error ${code}`);
    assert.ok(`api.${code}` in italian, `Missing Italian API error ${code}`);
  });
  assert.doesNotMatch(server, /\{\s*error:\s*["'`]/);
});

test("admin template errors and catalog namespace are translated", () => {
  [
    "ADMIN_TEMPLATE_TYPE_INVALID",
    "ADMIN_TEMPLATE_ID_INVALID",
    "ADMIN_TEMPLATE_TITLE_REQUIRED",
    "ADMIN_TEMPLATE_TITLE_TOO_LONG",
    "ADMIN_TEMPLATE_DESCRIPTION_TOO_LONG",
    "ADMIN_TEMPLATE_EXISTS",
  ].forEach((code) => {
    assert.ok(`api.${code}` in english, `Missing English API error ${code}`);
    assert.ok(`api.${code}` in italian, `Missing Italian API error ${code}`);
  });
  assert.ok(Object.keys(english).some((key) => key.startsWith("adminTemplates.")));
  assert.match(html, /data-i18n="adminTemplates\.title"/);
});

test("default and project language preferences remain separate", () => {
  assert.match(html, /id="loginLanguage"[^>]*data-language-select/);
  assert.match(html, /id="miLanguage"[^>]*role="menuitem"/);
  assert.match(html, /id="defaultLanguageSelect"[^>]*data-language-scope="default"/);
  assert.match(html, /id="settingsLanguage"[^>]*data-language-scope="project"/);
  assert.match(runtime, /localStorage\.setItem\(STORAGE_KEY, defaultLanguage\)/);
  assert.match(runtime, /function setDefaultLanguage\(nextLanguage/);
  assert.match(runtime, /function useDefaultLanguage\(options/);
  assert.match(runtime, /document\.documentElement\.lang/);
});

test("stale locale loads can be discarded before they change the interface", () => {
  assert.match(runtime, /typeof options\.isCurrent === "function" && !options\.isCurrent\(\)/);
  assert.match(app, /isCurrent: \(\) => generation === state\.projectLoadGeneration/);
});
