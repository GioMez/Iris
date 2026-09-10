/* ===================== Iris · admin console ===================== */
/* Server-level user administration, visible only to the admin role. The server
   is the real authority: every call is authorized server-side, and this screen
   simply surfaces the /api/admin/users endpoints. */
(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  const openDialog = (id) => window.IrisMotion.openDialog(id);
  const closeDialog = (id, options) => window.IrisMotion.closeDialog(id, options);
  const ti = (name) => (window.IrisIcons ? window.IrisIcons.icon(name) : "");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let users = [];
  let editingId = null;
  let loadSequence = 0;
  let adminTab = "users";
  let loadFailed = false;

  const ADMIN_TABS = {
    users: { title: "admin.title", heading: "adminUsersTitle" },
    projects: { title: "adminProjects.title", heading: "adminProjectsTitle" },
    templates: { title: "adminTemplates.title", heading: "adminTemplatesTitle" },
  };

  // Projects and templates are separate modules, activated only when their
  // sibling dashboard is selected.
  function setAdminTab(tab, { focusTab = false, focusPanel = false } = {}) {
    adminTab = Object.prototype.hasOwnProperty.call(ADMIN_TABS, tab) ? tab : "users";
    document.querySelectorAll("#adminSwitch [data-admin-tab]").forEach((b) => {
      const on = b.dataset.adminTab === adminTab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
      if (on && focusTab) b.focus();
    });
    document.querySelectorAll("[data-admin-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.adminPanel !== adminTab;
    });
    if (adminTab === "projects" && window.IrisAdminProjects) window.IrisAdminProjects.activate();
    if (adminTab === "templates" && window.IrisAdminTemplates) window.IrisAdminTemplates.activate();
    document.title = `${t(ADMIN_TABS[adminTab].title)} · Iris`;
    if (focusPanel) setTimeout(() => $(ADMIN_TABS[adminTab].heading).focus(), 0);
  }

  // A 401 here means my own session fell (self-disable, self password reset):
  // IrisNet routes it to the registered handler, which drops back to login.
  const api = (path, options) => window.IrisNet.request(path, options);

  const initials = (name) =>
    String(name || "").split(/\s+/).filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase() || "–";
  const isAdmin = () => document.documentElement.dataset.role === "admin";
  const myId = () => document.documentElement.dataset.uid || "";

  function status(message, isError, retry) {
    const el = $("adminStatusMsg");
    const button = $("adminStatusRetry");
    el.setAttribute("role", isError ? "alert" : "status");
    el.setAttribute("aria-live", isError ? "assertive" : "polite");
    el.classList.toggle("error", !!isError);
    el.textContent = message || "";
    button.hidden = !retry;
    button.onclick = retry ? () => {
        $(ADMIN_TABS[adminTab].heading).focus();
        retry();
      } : null;
  }

  function fmtTime(ts) {
    if (!ts) return t("admin.never");
    return window.IrisI18n.formatDate(new Date(ts), { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function open() {
    if (!isAdmin()) return;
    document.documentElement.classList.add("iris-inadmin");
    window.IrisMotion.setActiveSurface("admin");
    if (window.location.hash !== "#admin") history.pushState(null, "", "#admin");
    setAdminTab("users");
    setTimeout(() => {
      if (window.IrisMotion.activeSurface() === "admin") $("adminUsersTitle").focus();
    }, 0);
    void load();
  }

  function close() {
    loadSequence += 1;
    document.querySelectorAll('[id^="admin"][class~="scrim"].on, [id^="admin"][class~="scrim"].is-closing').forEach((dialog) => {
      void closeDialog(dialog, { immediate: true, restoreFocus: false });
    });
    document.documentElement.classList.remove("iris-inadmin");
    if (window.location.hash === "#admin") history.replaceState(null, "", window.location.pathname + window.location.search);
    document.title = `${t("projects.yourProjects")} · Iris`;
    window.IrisMotion.setActiveSurface("picker");
    setTimeout(() => {
      if (window.IrisMotion.activeSurface() !== "picker") return;
      const trigger = $("pkAdmin");
      if (trigger && trigger.getClientRects().length) trigger.focus();
      else $("projectPickerTitle").focus();
    }, 0);
  }

  async function load({ preserveStatus = false } = {}) {
    const sequence = ++loadSequence;
    loadFailed = false;
    if (!preserveStatus) status(t("common.loading"));
    $("adminTableWrap").setAttribute("aria-busy", "true");
    $("adminTableWrap").classList.add("loading");
    const params = new URLSearchParams();
    const q = $("adminSearch").value.trim();
    if (q) params.set("q", q);
    if ($("adminRoleFilter").value) params.set("role", $("adminRoleFilter").value);
    if ($("adminStatusFilter").value) params.set("status", $("adminStatusFilter").value);
    try {
      const data = await api(`/api/admin/users${params.toString() ? `?${params}` : ""}`);
      if (sequence !== loadSequence) return false;
      users = data.users || [];
      loadFailed = false;
      render();
      if (!preserveStatus) status("");
      return true;
    } catch (err) {
      if (sequence !== loadSequence) return false;
      users = [];
      loadFailed = true;
      render();
      status(window.IrisI18n.error(err), true, () => { void load(); });
      return false;
    } finally {
      if (sequence === loadSequence) {
        $("adminTableWrap").removeAttribute("aria-busy");
        $("adminTableWrap").classList.remove("loading");
      }
    }
  }

  function badge(kind, value, label) {
    return `<span class="admin-badge ${kind}-${value}">${esc(label)}</span>`;
  }

  const ROLE_LABEL = { admin: "admin.roleAdmin", external: "admin.roleExternal", regular: "admin.roleRegular" };
  const STATUS_LABEL = { active: "admin.statusActive", pending: "admin.statusPending", disabled: "admin.statusDisabled" };
  const roleLabel = (role) => t(ROLE_LABEL[role] || ROLE_LABEL.regular);
  const statusLabel = (value) => t(STATUS_LABEL[value] || STATUS_LABEL.disabled);

  function render() {
    const body = $("adminRows");
    const empty = $("adminEmpty");
    body.innerHTML = "";
    if (loadFailed) { empty.style.display = "none"; return; }
    if (!users.length) { empty.style.display = ""; return; }
    empty.style.display = "none";
    for (const u of users) {
      const tr = document.createElement("tr");
      tr.dataset.userId = u.id;
      const you = u.id === myId() ? ` <span class="admin-me-tag">${esc(t("admin.you"))}</span>` : "";
      tr.innerHTML =
        `<td><div class="admin-user-cell"><span class="avatar">${esc(initials(u.name))}</span>` +
          `<span><span class="admin-user-name">${esc(u.name)}</span>${you}<br>` +
          `<span class="admin-user-sub">${esc(u.username)} · ${esc(u.email)}</span>` +
          `<span class="admin-mobile-meta">${esc(u.authSource === "oidc" ? t("admin.sourceOidc") : t("admin.sourceLocal"))} · ${esc(fmtTime(u.lastLoginAt))}</span></span></div></td>` +
        `<td>${badge("role", u.role, roleLabel(u.role))}</td>` +
        `<td>${badge("status", u.status, statusLabel(u.status))}</td>` +
        `<td class="admin-hide-sm"><span class="admin-source">${esc(u.authSource === "oidc" ? t("admin.sourceOidc") : t("admin.sourceLocal"))}</span></td>` +
        `<td class="admin-hide-sm"><span class="admin-time">${esc(fmtTime(u.lastLoginAt))}</span></td>` +
        `<td class="admin-col-actions"><button class="admin-row-edit" type="button" aria-label="${esc(t("admin.manageUserAria", { name: u.name || u.username }))}">${ti("edit")}<span>${esc(t("admin.manage"))}</span></button></td>`;
      tr.querySelector(".admin-row-edit").addEventListener("click", () => openEdit(u));
      body.appendChild(tr);
    }
  }

  /* ---------------- create ---------------- */
  function openCreate() {
    $("adminCreateError").style.display = "none";
    $("adminCreateForm").querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
    $("adminCreateUsername").value = "";
    $("adminCreateEmail").value = "";
    $("adminCreateName").value = "";
    $("adminCreateRole").value = "regular";
    openDialog("adminCreateModal");
    setTimeout(() => $("adminCreateUsername").focus(), 50);
  }

  function modalError(id, err) {
    const el = $(id);
    el.textContent = window.IrisI18n.error(err);
    el.style.display = "flex";
  }

  async function submitCreate() {
    const btn = $("adminCreateSave");
    btn.disabled = true; btn.classList.add("loading");
    try {
      const data = await api("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: $("adminCreateUsername").value.trim(),
          email: $("adminCreateEmail").value.trim(),
          name: $("adminCreateName").value.trim(),
          role: $("adminCreateRole").value,
        }),
      });
      await closeDialog("adminCreateModal");
      showCredentials(data.user.username, data.temporaryPassword);
      if (await load({ preserveStatus: true })) status(t("admin.userCreated", { name: data.user.username }));
    } catch (err) {
      modalError("adminCreateError", err);
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  /* ---------------- edit ---------------- */
  function openEdit(u) {
    editingId = u.id;
    $("adminEditError").style.display = "none";
    $("adminEditForm").querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
    $("adminEditTitle").textContent = t("admin.editTitle", { name: u.username });
    $("adminEditIdentity").textContent = `${u.email} · ${u.authSource === "oidc" ? t("admin.sourceOidc") : t("admin.sourceLocal")}`;
    $("adminEditUsername").value = u.username || "";
    $("adminEditName").value = u.name || "";
    $("adminEditEmail").value = u.email || "";
    $("adminEditRole").value = u.role;
    // A pending account has no assignable status to show, so the placeholder
    // option is revealed just for it: the administrator approves by choosing
    // Active or turns the account away by choosing Disabled, and cannot put it
    // back. The hint explains which is which.
    const isPending = u.status === "pending";
    $("adminEditStatusPending").hidden = !isPending;
    $("adminEditPendingHint").style.display = isPending ? "" : "none";
    $("adminEditStatus").value = u.status;
    // Local accounts can have their password reset and be offered the one-time
    // SSO linking window; OIDC accounts (native or converted) can instead be
    // unlinked, reverting to local with a fresh temporary password.
    const isLocal = u.authSource === "local";
    $("adminResetRow").style.display = isLocal ? "" : "none";
    $("adminEditLinkPending").checked = !!u.oidcLinkPending;
    $("adminLinkRow").style.display = isLocal ? "" : "none";
    $("adminUnlinkRow").style.display = isLocal ? "none" : "";
    // Physical deletion is a distinct, protected step: offered only for an account
    // that has no access — disabled, or never approved — and never for oneself.
    $("adminDeleteUserRow").style.display = (u.status !== "active" && u.id !== myId()) ? "" : "none";
    openDialog("adminEditModal");
    setTimeout(() => $("adminEditName").focus(), 50);
  }

  async function submitEdit() {
    const btn = $("adminEditSave");
    btn.disabled = true; btn.classList.add("loading");
    try {
      // The pending placeholder is never sent back: it is a state the console can
      // display but not assign, so leaving it untouched means "not decided yet"
      // and the field is simply omitted from the patch.
      const nextStatus = $("adminEditStatus").value;
      const data = await api(`/api/admin/users/${editingId}`, {
        method: "PATCH",
        body: JSON.stringify({
          username: $("adminEditUsername").value.trim(),
          name: $("adminEditName").value.trim(),
          email: $("adminEditEmail").value.trim(),
          role: $("adminEditRole").value,
          status: nextStatus === "pending" ? undefined : nextStatus,
          oidcLinkPending: $("adminEditLinkPending").checked,
        }),
      });
      await closeDialog("adminEditModal");
      // Acting on my own account can revoke my access to this console: a
      // self-demotion changes my role with no 401, a self-disable kills the
      // session (401 on refresh → routed to login). Re-sync before touching the
      // admin list, which would otherwise 403 and blank the console.
      if (editingId === myId()) {
        await window.IrisAuth.refreshSession();
        if (!isAdmin()) { close(); return; }
      }
      if (await load({ preserveStatus: true })) {
        status(t("admin.userUpdated", { name: data.user.username }));
        const rowAction = document.querySelector(`#adminRows tr[data-user-id="${editingId}"] .admin-row-edit`);
        if (rowAction) rowAction.focus();
        else $("adminUsersTitle").focus();
      }
    } catch (err) {
      modalError("adminEditError", err);
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  async function openResetConfirmation() {
    if (!editingId) return;
    const target = users.find((u) => u.id === editingId);
    $("adminResetConfirmText").textContent = t("admin.resetConfirm", { name: target ? target.username : "" });
    await closeDialog("adminEditModal");
    openDialog("adminResetConfirmModal");
    setTimeout(() => $("adminResetConfirmBtn").focus(), 50);
  }

  async function closeResetConfirmation() {
    await closeDialog("adminResetConfirmModal");
    openDialog("adminEditModal");
    setTimeout(() => $("adminResetBtn").focus(), 50);
  }

  async function resetPassword() {
    if (!editingId) return;
    const target = users.find((u) => u.id === editingId);
    const btn = $("adminResetConfirmBtn");
    btn.disabled = true; btn.classList.add("loading");
    try {
      const data = await api(`/api/admin/users/${editingId}/reset-password`, { method: "POST", body: "{}" });
      await closeDialog("adminResetConfirmModal");
      showCredentials(target ? target.username : "", data.temporaryPassword);
    } catch (err) {
      await closeDialog("adminResetConfirmModal");
      openDialog("adminEditModal");
      modalError("adminEditError", err);
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  async function unlinkSso() {
    if (!editingId) return;
    const btn = $("adminUnlinkBtn");
    btn.disabled = true; btn.classList.add("loading");
    try {
      const target = users.find((u) => u.id === editingId);
      const wasSelf = editingId === myId();
      const data = await api(`/api/admin/users/${editingId}/unlink-sso`, { method: "POST", body: "{}" });
      await closeDialog("adminEditModal");
      showCredentials(target ? target.username : "", data.temporaryPassword);
      // Refresh the list so the account shows as local again — unless I unlinked
      // myself, whose session is now dead (a reload would 401 to login and hide
      // the temporary password before it can be copied).
      if (!wasSelf) await load();
    } catch (err) {
      modalError("adminEditError", err);
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  /* ---------------- delete account ---------------- */
  // Physical, irreversible deletion, separate from the reversible disable. The
  // server guards it (self / not-disabled / sole-owner) and hard-deletes the row;
  // this flow surfaces any sole-owner projects and points to the projects console
  // to resolve them, then confirms by typing the username.
  let deleteUserTarget = null;

  async function askDeleteUser() {
    if (!editingId) return;
    const btn = $("adminDeleteUserBtn");
    btn.disabled = true; btn.classList.add("loading");
    try {
      const preview = await api(`/api/admin/users/${editingId}/deletion-preview`);
      deleteUserTarget = { id: editingId, username: preview.user.username, soleOwnerProjects: preview.soleOwnerProjects || [] };
      await closeDialog("adminEditModal");
      renderDeleteUser();
      openDialog("adminDeleteUserModal");
      if (!deleteUserTarget.soleOwnerProjects.length) setTimeout(() => $("adminDeleteUserConfirm").focus(), 50);
    } catch (err) {
      modalError("adminEditError", err);
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  function renderDeleteUser() {
    if (!deleteUserTarget) return;
    const { username, soleOwnerProjects } = deleteUserTarget;
    const blocked = soleOwnerProjects.length > 0;
    $("adminDeleteUserTitle").textContent = t("admin.deleteUserTitle", { name: username });
    $("adminDeleteUserError").style.display = "none";
    const soleBox = $("adminDeleteUserSoleOwner");
    soleBox.style.display = blocked ? "" : "none";
    if (blocked) {
      const list = $("adminDeleteUserProjects");
      list.innerHTML = "";
      for (const project of soleOwnerProjects) {
        const li = document.createElement("li");
        li.textContent = project.name;
        list.appendChild(li);
      }
    }
    $("adminDeleteUserConfirmField").style.display = blocked ? "none" : "";
    $("adminDeleteUserConfirmLabel").textContent = t("admin.deleteUserConfirmLabel", { username });
    const input = $("adminDeleteUserConfirm");
    input.value = "";
    input.classList.remove("nomatch");
    input.removeAttribute("aria-invalid");
    $("adminDeleteUserOk").disabled = blocked;
  }

  async function confirmDeleteUser(event) {
    event.preventDefault();
    if (!deleteUserTarget || deleteUserTarget.soleOwnerProjects.length) return;
    const { id, username } = deleteUserTarget;
    const input = $("adminDeleteUserConfirm");
    if (input.value.trim() !== username) {
      input.classList.add("nomatch"); input.setAttribute("aria-invalid", "true"); input.focus();
      const error = $("adminDeleteUserError");
      error.textContent = t("api.ADMIN_DELETE_CONFIRMATION");
      error.style.display = "flex";
      return;
    }
    const btn = $("adminDeleteUserOk");
    btn.disabled = true; btn.classList.add("loading");
    try {
      await api(`/api/admin/users/${id}`, { method: "DELETE", body: JSON.stringify({ confirmation: username }) });
      await closeDialog("adminDeleteUserModal");
      deleteUserTarget = null;
      if (await load({ preserveStatus: true })) {
        status(t("admin.deleteUserDone", { name: username }));
        $("adminUsersTitle").focus();
      }
    } catch (err) {
      const el = $("adminDeleteUserError");
      el.textContent = window.IrisI18n.error(err);
      el.style.display = "flex";
    } finally {
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  async function openProjectsFromDelete() {
    await closeDialog("adminDeleteUserModal", { restoreFocus: false });
    setAdminTab("projects", { focusPanel: true });
  }

  /* ---------------- credentials (shown once) ---------------- */
  function showCredentials(username, password) {
    $("adminCredsUser").textContent = username;
    $("adminCredsPass").textContent = password;
    const copy = $("adminCredsCopy");
    copy.querySelector("span:last-child").textContent = t("admin.copyPassword");
    copy.querySelector(".ic").innerHTML = window.IrisIcons.icon("copy");
    openDialog("adminCredsModal");
  }

  function wire() {
    $("pkAdmin").addEventListener("click", open);
    $("adminBack").addEventListener("click", close);
    const adminTabs = Array.from(document.querySelectorAll("#adminSwitch [data-admin-tab]"));
    adminTabs.forEach((b) => {
      b.addEventListener("click", () => setAdminTab(b.dataset.adminTab));
      b.addEventListener("keydown", (event) => {
        const current = adminTabs.indexOf(b);
        let next = current;
        if (event.key === "ArrowRight") next = (current + 1) % adminTabs.length;
        else if (event.key === "ArrowLeft") next = (current - 1 + adminTabs.length) % adminTabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = adminTabs.length - 1;
        else return;
        event.preventDefault();
        setAdminTab(adminTabs[next].dataset.adminTab, { focusTab: true });
      });
    });
    $("adminNew").addEventListener("click", openCreate);
    let searchTimer;
    $("adminSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 220); });
    $("adminRoleFilter").addEventListener("change", load);
    $("adminStatusFilter").addEventListener("change", load);
    $("adminCreateForm").addEventListener("submit", (event) => { event.preventDefault(); void submitCreate(); });
    $("adminEditForm").addEventListener("submit", (event) => { event.preventDefault(); void submitEdit(); });
    $("adminResetBtn").addEventListener("click", () => { void openResetConfirmation(); });
    $("adminResetConfirmForm").addEventListener("submit", (event) => { event.preventDefault(); void resetPassword(); });
    $("adminResetConfirmCancel").addEventListener("click", () => { void closeResetConfirmation(); });
    $("adminResetConfirmClose").addEventListener("click", () => { void closeResetConfirmation(); });
    $("adminUnlinkBtn").addEventListener("click", unlinkSso);
    $("adminDeleteUserBtn").addEventListener("click", () => { void askDeleteUser(); });
    $("adminDeleteUserForm").addEventListener("submit", (e) => { void confirmDeleteUser(e); });
    $("adminDeleteUserOpenProjects").addEventListener("click", () => { void openProjectsFromDelete(); });
    $("adminDeleteUserConfirm").addEventListener("input", () => {
      $("adminDeleteUserConfirm").classList.remove("nomatch");
      $("adminDeleteUserConfirm").removeAttribute("aria-invalid");
      $("adminDeleteUserError").style.display = "none";
    });
    ["adminCreateForm", "adminEditForm"].forEach((id) => {
      const clear = (event) => {
        event.target.removeAttribute("aria-invalid");
        $(id === "adminCreateForm" ? "adminCreateError" : "adminEditError").style.display = "none";
      };
      $(id).addEventListener("input", clear);
      $(id).addEventListener("change", clear);
    });
    $("adminCredsCopy").addEventListener("click", async () => {
      const copy = $("adminCredsCopy");
      try {
        await navigator.clipboard.writeText($("adminCredsPass").textContent);
        copy.querySelector("span:last-child").textContent = t("admin.copied");
        copy.querySelector(".ic").innerHTML = window.IrisIcons.icon("check");
      } catch (e) {
        // The clipboard can be refused outright; say so instead of no-opping.
        copy.querySelector("span:last-child").textContent = t("admin.copyFailed");
        copy.querySelector(".ic").innerHTML = window.IrisIcons.icon("alert-circle");
      }
    });
    document.querySelectorAll("[data-admin-close]").forEach((b) =>
      b.addEventListener("click", (e) => { void closeDialog(e.target.closest(".scrim")); })
    );
    document.querySelectorAll("#adminCreateModal, #adminEditModal, #adminCredsModal, #adminDeleteUserModal").forEach((scrim) =>
      scrim.addEventListener("click", (e) => { if (e.target === scrim) void closeDialog(scrim); })
    );
    $("adminResetConfirmModal").addEventListener("click", (event) => {
      if (event.target === $("adminResetConfirmModal")) void closeResetConfirmation();
    });
    // IrisApp has a global Escape handler for scrims. Handle this nested flow in
    // capture phase so cancelling returns to the edit dialog instead of closing
    // the whole account-management flow.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !$("adminResetConfirmModal").classList.contains("on")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeResetConfirmation();
    }, true);
    // A hard refresh at #admin lands on the console when the session is an admin.
    window.addEventListener("hashchange", () => {
      if (window.location.hash === "#admin") open();
      else if (document.documentElement.classList.contains("iris-inadmin")) close();
    });
  }

  function boot() {
    if (window.location.hash === "#admin" && isAdmin()) open();
  }

  window.IrisAdmin = { open, close, boot };
  window.IrisI18n.ready.then(() => {
    wire();
    // IrisAuth calls boot() from showApp once the role is known; the console
    // opens then if the page was loaded directly at #admin.
    document.addEventListener("iris:languagechange", () => {
      if (!document.documentElement.classList.contains("iris-inadmin")) return;
      document.title = `${t(ADMIN_TABS[adminTab].title)} · Iris`;
      render();
      if ($("adminDeleteUserModal").classList.contains("on")) renderDeleteUser();
    });
  });
})();
