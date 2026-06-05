/* ===================== WebTeX · auth ===================== */
/* Login / logout. Gli account sono verificati dal backend; la sessione
   vive in un cookie HttpOnly firmato dal server. */
(function () {
  const $ = (id) => document.getElementById(id);

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

  function ssoLogin(provider) {
    const btn = document.querySelector(`[data-sso="${provider}"]`);
    if (btn) {
      btn.classList.remove("loading");
      btn.blur();
    }
    showError("SSO non ancora collegato. Per ora usa nome utente e password.");
  }

  async function doLogout() {
    if (window.WTProjects) await window.WTProjects.persistCurrent();
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (e) {}
    showLogin();
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
    document.querySelectorAll("[data-sso]").forEach((b) =>
      b.addEventListener("click", () => ssoLogin(b.dataset.sso))
    );

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
  }

  async function boot() {
    wire();
    try {
      const { user } = await api("/api/auth/session");
      showApp(user);
    } catch (e) {
      showLogin();
    }
  }

  window.WTAuth = { showLogin, showApp };
  boot();
})();
