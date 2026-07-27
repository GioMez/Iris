/* ===================== Iris · internationalization ===================== */
(function () {
  "use strict";

  const STORAGE_KEY = "iris_language";
  const DEFAULT_LANGUAGE = "en";
  const SUPPORTED = Object.freeze({
    en: { label: "English", locale: "en", dir: "ltr" },
    it: { label: "Italiano", locale: "it", dir: "ltr" },
  });
  let language = DEFAULT_LANGUAGE;
  let defaultLanguage = DEFAULT_LANGUAGE;
  let messages = {};
  let fallbackMessages = {};
  const catalogs = new Map();

  function supportedLanguage(value) {
    const requested = String(value || "").trim().toLowerCase().replaceAll("_", "-");
    if (!requested) return null;
    const entries = Object.entries(SUPPORTED);
    const exact = entries.find(([code, meta]) =>
      code.toLowerCase().replaceAll("_", "-") === requested ||
      meta.locale.toLowerCase().replaceAll("_", "-") === requested
    );
    if (exact) return exact[0];
    const primary = requested.split("-")[0];
    const compatible = entries.find(([code, meta]) =>
      code.toLowerCase().split(/[-_]/)[0] === primary ||
      meta.locale.toLowerCase().split(/[-_]/)[0] === primary
    );
    return compatible ? compatible[0] : null;
  }

  function normalizeLanguage(value) {
    return supportedLanguage(value) || DEFAULT_LANGUAGE;
  }

  function preferredLanguage() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return normalizeLanguage(saved);
    } catch (error) {}
    for (const candidate of navigator.languages || [navigator.language]) {
      const code = supportedLanguage(candidate);
      if (code) return code;
    }
    return DEFAULT_LANGUAGE;
  }

  function valueAt(catalog, key) {
    return String(key || "").split(".").reduce((value, part) => {
      if (!value || typeof value !== "object") return undefined;
      return value[part];
    }, catalog);
  }

  function interpolate(value, params) {
    return String(value).replace(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g, (match, key) => {
      const replacement = params && Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
      return replacement == null ? "" : String(replacement);
    });
  }

  function pluralKey(key, count) {
    if (count == null || !Number.isFinite(Number(count))) return key;
    const rule = new Intl.PluralRules(SUPPORTED[language].locale).select(Number(count));
    return `${key}_${rule}`;
  }

  function t(key, params = {}) {
    const selectedKey = pluralKey(key, params.count);
    let value = valueAt(messages, selectedKey);
    if (typeof value !== "string") value = valueAt(fallbackMessages, selectedKey);
    if (typeof value !== "string" && selectedKey !== key) value = valueAt(messages, `${key}_other`);
    if (typeof value !== "string" && selectedKey !== key) value = valueAt(fallbackMessages, `${key}_other`);
    if (typeof value !== "string") value = valueAt(messages, key);
    if (typeof value !== "string") value = valueAt(fallbackMessages, key);
    if (typeof value !== "string") {
      console.warn(`Missing translation: ${key}`);
      return key;
    }
    return interpolate(value, params);
  }

  function translateElement(element) {
    if (element.dataset.i18n) element.textContent = t(element.dataset.i18n);
    ["title", "placeholder", "aria-label"].forEach((attribute) => {
      const dataName = `i18n${attribute.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}`;
      if (element.dataset[dataName]) element.setAttribute(attribute, t(element.dataset[dataName]));
    });
  }

  function apply(root = document) {
    const selector = "[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]";
    if (root.matches && root.matches(selector)) translateElement(root);
    root.querySelectorAll(selector).forEach(translateElement);
    document.documentElement.lang = SUPPORTED[language].locale;
    document.documentElement.dir = SUPPORTED[language].dir;
    document.querySelectorAll("[data-language-select]").forEach((select) => {
      select.value = select.dataset.languageScope === "project" ? language : defaultLanguage;
    });
  }

  async function loadCatalog(code) {
    if (catalogs.has(code)) return catalogs.get(code);
    const response = await fetch(`/locales/${code}/translation.json`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Unable to load locale ${code} (${response.status})`);
    const catalog = await response.json();
    catalogs.set(code, catalog);
    return catalog;
  }

  async function setLanguage(nextLanguage, options = {}) {
    const next = normalizeLanguage(nextLanguage);
    const nextMessages = next === DEFAULT_LANGUAGE ? fallbackMessages : await loadCatalog(next);
    language = next;
    messages = nextMessages;
    apply(document);
    if (!options.silent) {
      document.dispatchEvent(new CustomEvent("iris:languagechange", { detail: { language } }));
    }
    return language;
  }

  async function setDefaultLanguage(nextLanguage, options = {}) {
    const next = normalizeLanguage(nextLanguage);
    // Validate and cache the catalog now even when a project keeps its own
    // active language. Returning home must never depend on a later fetch.
    if (next !== DEFAULT_LANGUAGE) await loadCatalog(next);
    defaultLanguage = next;
    try { localStorage.setItem(STORAGE_KEY, defaultLanguage); } catch (error) {}
    if (options.activate !== false) await setLanguage(defaultLanguage, options);
    else apply(document);
    document.dispatchEvent(new CustomEvent("iris:defaultlanguagechange", { detail: { language: defaultLanguage } }));
    return defaultLanguage;
  }

  function useDefaultLanguage(options = {}) {
    return setLanguage(defaultLanguage, options);
  }

  function wireSelectors() {
    document.querySelectorAll("[data-language-select]").forEach((select) => {
      if (select.dataset.languageScope === "project") return;
      select.value = defaultLanguage;
      select.addEventListener("change", () => {
        const activate = !document.documentElement.classList.contains("iris-inproject");
        void setDefaultLanguage(select.value, { activate }).catch((error) => {
          apply(document);
          console.error("Language change failed", error);
        });
      });
    });
  }

  function locale() { return SUPPORTED[language].locale; }
  function formatDate(value, options) { return new Intl.DateTimeFormat(locale(), options).format(value); }
  function formatNumber(value, options) { return new Intl.NumberFormat(locale(), options).format(value); }
  function error(errorLike, fallbackKey = "errors.serverCommunication") {
    const code = errorLike && (errorLike.code || errorLike.errorCode);
    if (code && typeof valueAt(messages, `api.${code}`) === "string") return t(`api.${code}`, errorLike.params || {});
    if (code && typeof valueAt(fallbackMessages, `api.${code}`) === "string") return t(`api.${code}`, errorLike.params || {});
    return t(fallbackKey);
  }

  const ready = (async () => {
    fallbackMessages = await loadCatalog(DEFAULT_LANGUAGE);
    const preferred = preferredLanguage();
    try {
      messages = preferred === DEFAULT_LANGUAGE ? fallbackMessages : await loadCatalog(preferred);
      language = preferred;
      defaultLanguage = preferred;
    } catch (error) {
      console.warn(`Unable to load preferred language ${preferred}; using ${DEFAULT_LANGUAGE}`, error);
      messages = fallbackMessages;
      language = DEFAULT_LANGUAGE;
      defaultLanguage = DEFAULT_LANGUAGE;
    }
    apply(document);
    wireSelectors();
  })().catch((error) => {
    console.error("Iris translations could not be loaded", error);
    language = DEFAULT_LANGUAGE;
    messages = fallbackMessages;
  });

  window.IrisI18n = {
    DEFAULT_LANGUAGE,
    SUPPORTED,
    ready,
    t,
    apply,
    error,
    formatDate,
    formatNumber,
    get language() { return language; },
    get locale() { return locale(); },
    setLanguage,
    setDefaultLanguage,
    useDefaultLanguage,
    get defaultLanguage() { return defaultLanguage; },
  };
})();
