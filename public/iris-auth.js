/* ===================== Iris · auth ===================== */
/* Login / logout. Gli account sono verificati dal backend; la sessione
   vive in un cookie HttpOnly firmato dal server. */
(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  let ssoEnabled = false;
  let currentUser = null;

  async function api(path, options) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...(options && options.headers) },
      ...options,
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error();
      err.code = data.errorCode || "SERVER_ERROR";
      err.params = data.params || {};
      err.message = window.IrisI18n.error(err);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const initials = (name) =>
    String(name || "").split(/\s+/).filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase() || "–";

  function applyUserUI(u) {
    currentUser = u;
    // The server role gates the admin console: CSS hides admin-only controls and
    // IrisAdmin reads this to decide what to load.
    document.documentElement.dataset.role = u.role || "regular";
    document.documentElement.dataset.uid = u.id || "";
    const ini = initials(u.name);
    $("userAvatar").textContent = ini;
    $("userName").textContent = u.name;
    $("umAvatar").textContent = ini;
    $("umName").textContent = u.name;
    $("umEmail").textContent = u.email;
    const pa = $("pkAvatar"), pn = $("pkName"), pe = $("pkEmail");
    if (pa) pa.textContent = ini;
    if (pn) pn.textContent = u.name;
    if (pe) pe.textContent = u.email;
    const pwd = $("miPassword");
    if (pwd) pwd.style.display = u.canChangePassword ? "" : "none";
  }

  function showApp(u) {
    applyUserUI(u);
    document.documentElement.classList.add("iris-authed");
    const app = document.querySelector(".app");
    if (app) app.inert = false;
    if (window.IrisProjects) window.IrisProjects.showPicker();
    // Role is now stamped; let the admin console honour a direct #admin link.
    if (window.IrisAdmin) window.IrisAdmin.boot();
  }

  function showLogin() {
    if (window.IrisProjects) window.IrisProjects.onLogout();
    if (window.IrisAdmin) window.IrisAdmin.close();
    document.documentElement.classList.remove("iris-authed");
    document.documentElement.classList.remove("iris-inproject");
    delete document.documentElement.dataset.role;
    delete document.documentElement.dataset.uid;
    currentUser = null;
    const app = document.querySelector(".app");
    if (app) app.inert = true;
    $("loginUser").value = "";
    $("loginPass").value = "";
    hideError();
    setTimeout(() => $("loginUser").focus(), 60);
  }

  function showError(msg) {
    const e = $("loginError");
    e.textContent = msg;
    e.style.display = "flex";
    const card = $("loginCard");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
  }
  const hideError = () => { $("loginError").style.display = "none"; };

  function passwordError(msg) {
    const e = $("passwordError");
    e.textContent = msg;
    e.style.display = "flex";
  }
  function hidePasswordError() {
    $("passwordError").style.display = "none";
    $("passwordHint").textContent = "";
  }
  function closePasswordModal() {
    $("passwordModal").classList.remove("on");
    ["passwordCurrent", "passwordNew", "passwordConfirm"].forEach((id) => { $(id).value = ""; });
    hidePasswordError();
  }
  function openPasswordModal() {
    if (!currentUser || !currentUser.canChangePassword) return;
    hidePasswordError();
    $("passwordModal").classList.add("on");
    setTimeout(() => $("passwordCurrent").focus(), 50);
  }

  async function doLogin() {
    const username = $("loginUser").value.trim();
    const password = $("loginPass").value;
    if (!username || !password) { showError(t("auth.required")); return; }
    const btn = $("loginBtn");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const { user } = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      hideError();
      showApp(user);
    } catch (err) {
      showError(window.IrisI18n.error(err, "auth.invalidRetry"));
      $("loginPass").select();
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  async function loadConfig() {
    try {
      const cfg = await api("/api/config");
      ssoEnabled = !!(cfg.auth && cfg.auth.ssoEnabled);
    } catch (e) {
      ssoEnabled = false;
    }
    const btn = $("ssoLoginBtn");
    if (btn) {
      btn.disabled = !ssoEnabled;
      btn.title = ssoEnabled ? t("auth.ssoSignIn") : t("auth.ssoDisabled");
    }
  }

  function ssoLogin() {
    if (!ssoEnabled) {
      showError(t("auth.ssoNotConfigured"));
      return;
    }
    const btn = $("ssoLoginBtn");
    if (btn) {
      btn.disabled = true;
      btn.classList.add("loading");
    }
    window.location.assign("/api/auth/sso/start");
  }

  async function doLogout() {
    if (window.IrisProjects) await window.IrisProjects.persistCurrent();
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (e) {}
    showLogin();
  }

  async function changePassword() {
    const currentPassword = $("passwordCurrent").value;
    const newPassword = $("passwordNew").value;
    const confirmPassword = $("passwordConfirm").value;
    if (!currentPassword || !newPassword || !confirmPassword) {
      passwordError(t("password.allFields"));
      return;
    }
    if (newPassword.length < 10) {
      passwordError(t("password.tooShort"));
      $("passwordNew").focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordError(t("password.mismatch"));
      $("passwordConfirm").focus();
      return;
    }
    const btn = $("passwordSave");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const { user } = await api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (user) applyUserUI(user);
      $("passwordHint").textContent = t("password.updated");
      setTimeout(closePasswordModal, 650);
    } catch (err) {
      passwordError(window.IrisI18n.error(err, "password.updateFailed"));
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  function wire() {
    $("loginCard").addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
    $("loginUser").addEventListener("input", hideError);
    $("loginPass").addEventListener("input", hideError);
    $("pwToggle").addEventListener("click", () => {
      const p = $("loginPass");
      const reveal = p.type === "password";
      p.type = reveal ? "text" : "password";
      $("pwToggle").textContent = t(reveal ? "auth.hidePassword" : "auth.showPassword");
      p.focus();
    });
    document.querySelectorAll("[data-sso]").forEach((b) => b.addEventListener("click", () => ssoLogin()));

    const um = $("userMenu");
    $("userChip").addEventListener("click", (e) => {
      e.stopPropagation();
      const r = $("userChip").getBoundingClientRect();
      um.style.left = Math.max(8, r.right - 232) + "px";
      um.style.top = r.bottom + 6 + "px";
      um.classList.toggle("on");
      $("userChip").setAttribute("aria-expanded", um.classList.contains("on") ? "true" : "false");
    });
    um.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { um.classList.remove("on"); $("userChip").setAttribute("aria-expanded", "false"); });

    $("miPassword").addEventListener("click", () => {
      um.classList.remove("on");
      $("userChip").setAttribute("aria-expanded", "false");
      openPasswordModal();
    });
    $("miLogout").addEventListener("click", () => {
      um.classList.remove("on");
      $("userChip").setAttribute("aria-expanded", "false");
      $("logoutModal").classList.add("on");
    });
    $("logoutConfirm").addEventListener("click", async () => {
      $("logoutModal").classList.remove("on");
      await doLogout();
    });
    document.querySelectorAll("#logoutModal [data-close]").forEach((b) =>
      b.addEventListener("click", () => $("logoutModal").classList.remove("on"))
    );
    $("passwordSave").addEventListener("click", changePassword);
    ["passwordCurrent", "passwordNew", "passwordConfirm"].forEach((id) => {
      $(id).addEventListener("input", hidePasswordError);
      $(id).addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); changePassword(); }
        if (e.key === "Escape") { e.preventDefault(); closePasswordModal(); }
      });
    });
    $("passwordModal").addEventListener("click", (e) => { if (e.target === $("passwordModal")) closePasswordModal(); });
    document.querySelectorAll("#passwordModal [data-close]").forEach((b) =>
      b.addEventListener("click", closePasswordModal)
    );
  }

  async function boot() {
    wire();
    await loadConfig();
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError) {
      params.delete("auth_error");
      const nextQuery = params.toString();
      history.replaceState(null, "", window.location.pathname + (nextQuery ? `?${nextQuery}` : "") + window.location.hash);
    }
    try {
      const { user } = await api("/api/auth/session");
      showApp(user);
    } catch (e) {
      showLogin();
      if (authError === "sso") showError(t("auth.ssoFailed"));
    }
  }

  window.IrisAuth = { showLogin, showApp };
  document.addEventListener("iris:languagechange", () => {
    const reveal = $("loginPass").type === "text";
    $("pwToggle").textContent = t(reveal ? "auth.hidePassword" : "auth.showPassword");
    void loadConfig();
  });
  window.IrisI18n.ready.then(boot);
})();
