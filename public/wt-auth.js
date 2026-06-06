/* ===================== WebTeX · auth ===================== */
/* Login / logout. Gli account sono verificati dal backend; la sessione
   vive in un cookie HttpOnly firmato dal server. */
(function () {
  const $ = (id) => document.getElementById(id);
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
      const err = new Error(data.error || "Errore di comunicazione con il server.");
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const initials = (name) =>
    String(name || "").split(/\s+/).filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase() || "–";

  function applyUserUI(u) {
    currentUser = u;
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
    document.documentElement.classList.add("wt-authed");
    const app = document.querySelector(".app");
    if (app) app.inert = false;
    if (window.WTProjects) window.WTProjects.showPicker();
  }

  function showLogin() {
    if (window.WTProjects) window.WTProjects.onLogout();
    document.documentElement.classList.remove("wt-authed");
    document.documentElement.classList.remove("wt-inproject");
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
    if (!username || !password) { showError("Inserisci nome utente e password."); return; }
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
      showError(err.message || "Credenziali non valide. Riprova.");
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
      btn.title = ssoEnabled ? "Accedi con SSO" : "SSO non configurato sul backend";
    }
  }

  function ssoLogin() {
    if (!ssoEnabled) {
      showError("SSO non configurato. Usa le credenziali locali o aggiorna la configurazione del backend.");
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
    if (window.WTProjects) await window.WTProjects.persistCurrent();
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (e) {}
    showLogin();
  }

  async function changePassword() {
    const currentPassword = $("passwordCurrent").value;
    const newPassword = $("passwordNew").value;
    const confirmPassword = $("passwordConfirm").value;
    if (!currentPassword || !newPassword || !confirmPassword) {
      passwordError("Compila tutti i campi.");
      return;
    }
    if (newPassword.length < 10) {
      passwordError("La nuova password deve contenere almeno 10 caratteri.");
      $("passwordNew").focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordError("La conferma non coincide con la nuova password.");
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
      $("passwordHint").textContent = "Password aggiornata.";
      setTimeout(closePasswordModal, 650);
    } catch (err) {
      passwordError(err.message || "Impossibile aggiornare la password.");
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
      $("pwToggle").textContent = reveal ? "nascondi" : "mostra";
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
    });
    um.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => um.classList.remove("on"));

    $("miPassword").addEventListener("click", () => {
      um.classList.remove("on");
      openPasswordModal();
    });
    $("miLogout").addEventListener("click", () => {
      um.classList.remove("on");
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
      if (authError === "sso") showError("Accesso SSO non riuscito. Riprova o usa le credenziali locali.");
    }
  }

  window.WTAuth = { showLogin, showApp };
  boot();
})();
