/* ===================== Iris · auth ===================== */
/* Login / logout. Gli account sono verificati dal backend; la sessione
   vive in un cookie HttpOnly firmato dal server. */
(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  const openDialog = (id) => window.IrisMotion.openDialog(id);
  const closeDialog = (id, options) => window.IrisMotion.closeDialog(id, options);
  let ssoEnabled = false;
  let currentUser = null;
  // While a forced first-login password change is pending the modal is mandatory:
  // it cannot be dismissed and the app stays behind it until the change succeeds.
  let passwordForced = false;

  // This module owns the login/session/password endpoints, where a 401 means
  // "wrong credentials" and must be handled locally — never as a session drop —
  // so it opts out of IrisNet's global unauthorized handler.
  const api = (path, options) => window.IrisNet.request(path, { ...options, skipUnauthorizedHook: true });

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
    const pa = $("pkAvatar"), pn = $("pkName");
    if (pa) pa.textContent = ini;
    if (pn) pn.textContent = u.name;
    const aa = $("adminAvatar"), an = $("adminName");
    if (aa) aa.textContent = ini;
    if (an) an.textContent = u.name;
    // Only local accounts manage their own credentials/handle here; for an SSO
    // account (including one migrated to SSO) both are hidden — the password
    // lives at the IdP and changing the Iris username is pointless.
    const isLocalAccount = u.canChangePassword;
    const pwd = $("miPassword");
    if (pwd) pwd.style.display = isLocalAccount ? "" : "none";
    const uname = $("miUsername");
    if (uname) uname.style.display = isLocalAccount ? "" : "none";
  }

  // Re-reads the live session and re-stamps role/identity. Used after an admin
  // acts on their own account: a self-demotion changes the role with no forced
  // logout, so the console must re-sync to notice it is no longer authorized.
  // A self-disable instead 401s here and is routed straight back to login.
  async function refreshSession() {
    try {
      const { user } = await window.IrisNet.request("/api/auth/session");
      applyUserUI(user);
      return user;
    } catch (e) {
      return null;
    }
  }

  function showApp(u) {
    applyUserUI(u);
    document.documentElement.classList.add("iris-authed");
    window.IrisMotion.setActiveSurface("picker");
    if (window.IrisProjects) window.IrisProjects.showPicker();
    // Role is now stamped; let the admin console honour a direct #admin link.
    if (window.IrisAdmin) window.IrisAdmin.boot();
  }

  function showLogin() {
    void window.IrisMotion.closeAllDialogs({ immediate: true });
    void window.IrisI18n.useDefaultLanguage({ silent: true });
    if (window.IrisProjects) window.IrisProjects.onLogout();
    if (window.IrisAdmin) window.IrisAdmin.close();
    document.documentElement.classList.remove("iris-authed");
    delete document.documentElement.dataset.role;
    delete document.documentElement.dataset.uid;
    currentUser = null;
    closeUserMenu();
    window.IrisMotion.setActiveSurface("login");
    document.title = "Iris";
    $("loginUser").value = "";
    $("loginPass").value = "";
    hideError();
    setTimeout(() => $("loginUser").focus(), 60);
  }

  // The eye states what the click will do; the label and pressed state follow it.
  function setPasswordToggle(revealed) {
    const button = $("pwToggle");
    const label = t(revealed ? "auth.hidePassword" : "auth.showPassword");
    button.innerHTML = window.IrisIcons.icon(revealed ? "eye-off" : "eye");
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.dataset.i18nAriaLabel = revealed ? "auth.hidePassword" : "auth.showPassword";
    button.dataset.i18nTitle = button.dataset.i18nAriaLabel;
    button.setAttribute("aria-pressed", revealed ? "true" : "false");
  }

  function showError(msg) {
    const e = $("loginError");
    e.textContent = msg;
    e.style.display = "flex";
    $("loginUser").setAttribute("aria-invalid", "true");
    $("loginPass").setAttribute("aria-invalid", "true");
    const card = $("loginCard");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
  }
  const hideError = () => {
    $("loginError").style.display = "none";
    $("loginUser").removeAttribute("aria-invalid");
    $("loginPass").removeAttribute("aria-invalid");
  };

  function passwordError(msg, fields = []) {
    const e = $("passwordError");
    e.textContent = msg;
    e.style.display = "flex";
    fields.forEach((id) => $(id).setAttribute("aria-invalid", "true"));
  }
  function hidePasswordError() {
    $("passwordError").style.display = "none";
    $("passwordHint").textContent = "";
    ["passwordCurrent", "passwordNew", "passwordConfirm"].forEach((id) => $(id).removeAttribute("aria-invalid"));
  }
  async function closePasswordModal() {
    if (passwordForced) return; // mandatory change: not dismissable
    await closeDialog("passwordModal");
    ["passwordCurrent", "passwordNew", "passwordConfirm"].forEach((id) => { $(id).value = ""; });
    hidePasswordError();
  }
  function openPasswordModal(forced) {
    if (!forced && (!currentUser || !currentUser.canChangePassword)) return;
    passwordForced = !!forced;
    $("passwordModal").classList.toggle("forced", passwordForced);
    hidePasswordError();
    if (passwordForced) $("passwordHint").textContent = t("password.mustChange");
    openDialog("passwordModal");
    setTimeout(() => $("passwordCurrent").focus(), 50);
  }

  // Entry point after a successful login/session: an account still owing a forced
  // password change is held on the login screen behind the mandatory modal.
  function proceedAfterAuth(user) {
    if (user && user.passwordChangeRequired) {
      showLogin();
      openPasswordModal(true);
      return;
    }
    showApp(user);
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
      proceedAfterAuth(user);
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
    if (window.IrisApp && window.IrisApp.waitForPersistence) await window.IrisApp.waitForPersistence();
    if (window.IrisProjects) await window.IrisProjects.persistCurrent();
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch (e) {}
    showLogin();
  }

  async function changePassword() {
    const currentPassword = $("passwordCurrent").value;
    const newPassword = $("passwordNew").value;
    const confirmPassword = $("passwordConfirm").value;
    if (!currentPassword || !newPassword || !confirmPassword) {
      passwordError(t("password.allFields"), ["passwordCurrent", "passwordNew", "passwordConfirm"]);
      return;
    }
    if (newPassword.length < 10) {
      passwordError(t("password.tooShort"), ["passwordNew"]);
      $("passwordNew").focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordError(t("password.mismatch"), ["passwordConfirm"]);
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
      if (passwordForced) {
        // Mandatory change satisfied: release the modal and enter the app.
        passwordForced = false;
        $("passwordModal").classList.remove("forced");
        await closeDialog("passwordModal");
        ["passwordCurrent", "passwordNew", "passwordConfirm"].forEach((id) => { $(id).value = ""; });
        showApp(user);
        return;
      }
      if (user) applyUserUI(user);
      $("passwordHint").textContent = t("password.updated");
      setTimeout(closePasswordModal, 650);
    } catch (err) {
      passwordError(window.IrisI18n.error(err, "password.updateFailed"), ["passwordCurrent"]);
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  function usernameError(msg, field = "usernameNew") {
    const e = $("usernameError");
    e.textContent = msg;
    e.style.display = "flex";
    $(field).setAttribute("aria-invalid", "true");
  }
  function hideUsernameError() {
    $("usernameError").style.display = "none";
    $("usernameHint").textContent = "";
    $("usernameNew").removeAttribute("aria-invalid");
    $("usernameCurrent").removeAttribute("aria-invalid");
  }
  async function closeUsernameModal() {
    await closeDialog("usernameModal");
    $("usernameNew").value = ""; $("usernameCurrent").value = "";
    hideUsernameError();
  }
  function openUsernameModal() {
    if (!currentUser) return;
    hideUsernameError();
    $("usernameNew").value = currentUser.username || "";
    // Step-up: local accounts confirm with their password; SSO accounts have no
    // local secret, so the live session stands in for it.
    $("usernameReauthRow").style.display = currentUser.canChangePassword ? "" : "none";
    openDialog("usernameModal");
    setTimeout(() => $("usernameNew").focus(), 50);
  }

  function openDefaultLanguageModal() {
    openDialog("defaultLanguageModal");
    setTimeout(() => $("defaultLanguageSelect").focus(), 50);
  }

  async function closeDefaultLanguageModal() {
    await closeDialog("defaultLanguageModal");
    const trigger = activeAccountTrigger();
    if (trigger) trigger.focus();
  }
  async function changeUsername() {
    const username = $("usernameNew").value.trim();
    const currentPassword = $("usernameCurrent").value;
    if (!username) { usernameError(t("admin.usernameHint")); return; }
    if (username === currentUser.username) { usernameError(t("account.usernameUnchanged")); return; }
    // Local accounts must re-enter their password; catch it here so the user is
    // told before a round-trip instead of the modal closing on a no-op.
    if (currentUser.canChangePassword && !currentPassword) { usernameError(t("account.reauthHint"), "usernameCurrent"); return; }
    const btn = $("usernameSave");
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const { user } = await api("/api/account/username", {
        method: "POST",
        body: JSON.stringify({ username, currentPassword }),
      });
      if (user) applyUserUI(user);
      $("usernameHint").textContent = t("account.usernameUpdated");
      setTimeout(closeUsernameModal, 650);
    } catch (err) {
      usernameError(window.IrisI18n.error(err));
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  }

  // The account menu is shared by the in-project chip and the home (picker)
  // account block, so it can be opened from either screen.
  const USER_MENU_TRIGGERS = ["userChip", "pkAccount", "adminAccount"];
  let userMenuTrigger = null;
  function activeAccountTrigger() {
    if (document.documentElement.classList.contains("iris-inadmin")) return $("adminAccount");
    if (document.documentElement.classList.contains("iris-inproject")) return $("userChip");
    return $("pkAccount");
  }
  function closeUserMenu(restoreFocus = false) {
    $("userMenu").classList.remove("on");
    USER_MENU_TRIGGERS.forEach((id) => { const el = $(id); if (el) el.setAttribute("aria-expanded", "false"); });
    if (restoreFocus && userMenuTrigger && userMenuTrigger.isConnected) userMenuTrigger.focus();
  }
  function toggleUserMenu(trigger) {
    const um = $("userMenu");
    const open = !um.classList.contains("on");
    if (open) {
      userMenuTrigger = trigger;
      const r = trigger.getBoundingClientRect();
      um.style.left = Math.max(8, r.right - 232) + "px";
      um.style.top = r.bottom + 6 + "px";
    }
    um.classList.toggle("on", open);
    USER_MENU_TRIGGERS.forEach((id) => { const el = $(id); if (el) el.setAttribute("aria-expanded", open && el === trigger ? "true" : "false"); });
    if (open) requestAnimationFrame(() => {
      Array.from(um.querySelectorAll('[role="menuitem"]')).find((item) => item.getClientRects().length > 0)?.focus();
    });
  }

  function wire() {
    $("loginCard").addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
    $("loginUser").addEventListener("input", hideError);
    $("loginPass").addEventListener("input", hideError);
    $("pwToggle").addEventListener("click", () => {
      const p = $("loginPass");
      const reveal = p.type === "password";
      p.type = reveal ? "text" : "password";
      setPasswordToggle(reveal);
      p.focus();
    });
    document.querySelectorAll("[data-sso]").forEach((b) => b.addEventListener("click", () => ssoLogin()));

    const um = $("userMenu");
    $("userChip").addEventListener("click", (e) => { e.stopPropagation(); toggleUserMenu($("userChip")); });
    const pkAccount = $("pkAccount");
    if (pkAccount) pkAccount.addEventListener("click", (e) => { e.stopPropagation(); toggleUserMenu(pkAccount); });
    const adminAccount = $("adminAccount");
    if (adminAccount) adminAccount.addEventListener("click", (e) => { e.stopPropagation(); toggleUserMenu(adminAccount); });
    um.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => closeUserMenu());

    um.addEventListener("keydown", (event) => {
      const items = Array.from(um.querySelectorAll('[role="menuitem"]')).filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);
      let next = index;
      if (event.key === "ArrowDown") next = (index + 1 + items.length) % items.length;
      else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = items.length - 1;
      else if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); closeUserMenu(true); return;
      }
      else if (event.key === "Tab") {
        event.preventDefault(); event.stopImmediatePropagation(); closeUserMenu(true); return;
      }
      else return;
      event.preventDefault();
      event.stopPropagation();
      items[next].focus();
    });

    $("miLanguage").addEventListener("click", () => { closeUserMenu(true); openDefaultLanguageModal(); });
    $("miUsername").addEventListener("click", () => { closeUserMenu(true); openUsernameModal(); });
    $("miPassword").addEventListener("click", () => { closeUserMenu(true); openPasswordModal(); });
    $("miLogout").addEventListener("click", () => { closeUserMenu(true); openDialog("logoutModal"); });
    $("logoutConfirm").addEventListener("click", async () => {
      await closeDialog("logoutModal");
      await doLogout();
    });
    document.querySelectorAll("#logoutModal [data-close]").forEach((b) =>
      b.addEventListener("click", () => { void closeDialog("logoutModal"); })
    );
    document.querySelectorAll("#defaultLanguageModal [data-close]").forEach((button) =>
      button.addEventListener("click", () => { void closeDefaultLanguageModal(); })
    );
    $("defaultLanguageModal").addEventListener("click", (event) => {
      if (event.target === $("defaultLanguageModal")) void closeDefaultLanguageModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if ($("defaultLanguageModal").classList.contains("on")) {
        event.preventDefault(); event.stopImmediatePropagation(); void closeDefaultLanguageModal();
      } else if ($("passwordModal").classList.contains("on")) {
        event.preventDefault(); event.stopImmediatePropagation(); void closePasswordModal();
      } else if ($("usernameModal").classList.contains("on")) {
        event.preventDefault(); event.stopImmediatePropagation(); void closeUsernameModal();
      }
    }, true);
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
    $("usernameSave").addEventListener("click", changeUsername);
    ["usernameNew", "usernameCurrent"].forEach((id) => {
      $(id).addEventListener("input", hideUsernameError);
      $(id).addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); changeUsername(); }
        if (e.key === "Escape") { e.preventDefault(); closeUsernameModal(); }
      });
    });
    $("usernameModal").addEventListener("click", (e) => { if (e.target === $("usernameModal")) closeUsernameModal(); });
    document.querySelectorAll("#usernameModal [data-close]").forEach((b) =>
      b.addEventListener("click", closeUsernameModal)
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
      proceedAfterAuth(user);
    } catch (e) {
      showLogin();
      if (authError === "sso") showError(t("auth.ssoFailed"));
      else if (authError === "sso_link_required") showError(t("auth.ssoLinkRequired"));
      else if (authError === "account_pending") showError(t("auth.accountPending"));
    }
  }

  // Any authed request that 401s (expired cookie, disabled account, forced
  // logout after a password reset) drops the whole app back to the login screen.
  window.IrisNet.setUnauthorizedHandler(showLogin);

  window.IrisAuth = { showLogin, showApp, refreshSession };
  document.addEventListener("iris:languagechange", () => {
    const reveal = $("loginPass").type === "text";
    setPasswordToggle(reveal);
    void loadConfig();
  });
  window.IrisI18n.ready.then(boot);
})();
