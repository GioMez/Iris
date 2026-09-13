/* Browser-local preference, applied synchronously before the application CSS. */
(function () {
  "use strict";
  const normalize = value => ["system", "dark", "light"].includes(value) ? value : "system";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try { preference = normalize(window.localStorage.getItem("iris_theme")); } catch (_) { /* Session-only preference. */ }
  const resolve = () => preference === "system" ? (media.matches ? "dark" : "light") : preference;
  function apply() {
    const theme = resolve();
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
  window.IrisTheme = {
    preference: () => preference,
    resolved: resolve,
    setPreference(value) {
      preference = normalize(value);
      apply();
      try { window.localStorage.setItem("iris_theme", preference); } catch (_) { /* Keep the in-memory choice. */ }
    },
  };
  apply();
  media.addEventListener("change", () => { if (preference === "system") apply(); });
})();
