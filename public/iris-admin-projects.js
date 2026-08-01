/* ===================== Iris · admin project console ===================== */
/* Server-level project administration, visible only to the admin role and a
   sibling of the users console. Admins manage membership, roles and the
   existence of any project — an explicit, audited exceptional power — but never
   its contents: this module only ever touches /api/admin/projects, which serve
   metadata, never source files. The server is the real authority; every call is
   authorized and the invariants (>=1 owner) are enforced there too. */
(function () {
  const $ = (id) => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(key, params);
  const openDialog = (id) => window.IrisMotion.openDialog(id);
  const closeDialog = (id) => window.IrisMotion.closeDialog(id);
  const ti = (name) => (window.IrisIcons ? window.IrisIcons.icon(name) : "");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = (path, options) => window.IrisNet.request(path, options);

  const ROLES = ["owner", "editor", "viewer"];
  const roleLabel = (role) => t(`adminProjects.role${role.charAt(0).toUpperCase()}${role.slice(1)}`);
  // Owner is unavailable for an external member here too. The console does not get
  // a way around the rule: an invariant an administrator can step around is not
  // one, and the server refuses the promotion whatever this menu offers.
  const rolesFor = (member) => (member.external ? ROLES.filter((role) => role !== "owner") : ROLES);

  let projects = [];
  let activeId = null;
  let loadSequence = 0;
  let busy = false;
  let loadFailed = false;

  function fmtTime(ts) {
    if (!ts) return "—";
    return window.IrisI18n.formatDate(new Date(ts), { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function status(message, isError, retry) {
    const el = $("adminProjectStatusMsg");
    const button = $("adminProjectStatusRetry");
    if (!el) return;
    el.setAttribute("role", isError ? "alert" : "status");
    el.setAttribute("aria-live", isError ? "assertive" : "polite");
    el.classList.toggle("error", !!isError);
    el.textContent = message || "";
    button.hidden = !retry;
    button.onclick = retry ? () => { $("adminProjectsTitle").focus(); retry(); } : null;
  }
  function modalStatus(message) {
    $("adminProjectModalStatus").textContent = message || "";
  }
  function modalError(err) {
    const el = $("adminProjectError");
    el.textContent = err ? window.IrisI18n.error(err) : "";
    el.style.display = err ? "flex" : "none";
  }

  function activeProject() {
    return projects.find((p) => p.id === activeId) || null;
  }

  function syncManageBusy() {
    const modal = $("adminProjectModal");
    if (busy) modal.setAttribute("aria-busy", "true");
    else modal.removeAttribute("aria-busy");
    ["adminProjectAddIdentifier", "adminProjectAddRole", "adminProjectAddBtn", "adminProjectDeleteBtn"].forEach((id) => {
      $(id).disabled = busy;
    });
    $("adminProjectMembers").querySelectorAll("select,button").forEach((control) => { control.disabled = busy || control.disabled; });
  }

  function focusMemberControl(userId, selector) {
    const row = Array.from($("adminProjectMembers").children).find((element) => element.dataset.userId === userId);
    const target = row && row.querySelector(selector);
    if (target && !target.disabled) target.focus();
    else $("adminProjectAddIdentifier").focus();
  }

  async function load({ preserveStatus = false } = {}) {
    const sequence = ++loadSequence;
    loadFailed = false;
    if (!preserveStatus) status(t("common.loading"));
    $("adminProjectTableWrap").classList.add("loading");
    $("adminProjectTableWrap").setAttribute("aria-busy", "true");
    const params = new URLSearchParams();
    const q = $("adminProjectSearch").value.trim();
    if (q) params.set("q", q);
    if ($("adminProjectFilter").value) params.set("filter", $("adminProjectFilter").value);
    try {
      const data = await api(`/api/admin/projects${params.toString() ? `?${params}` : ""}`);
      if (sequence !== loadSequence) return false;
      projects = data.projects || [];
      loadFailed = false;
      render();
      if (!preserveStatus) status("");
      return true;
    } catch (err) {
      if (sequence !== loadSequence) return false;
      projects = [];
      loadFailed = true;
      render();
      status(window.IrisI18n.error(err, "adminProjects.loadFailed"), true, () => { void load(); });
      return false;
    } finally {
      if (sequence === loadSequence) {
        $("adminProjectTableWrap").classList.remove("loading");
        $("adminProjectTableWrap").removeAttribute("aria-busy");
      }
    }
  }

  function memberChips(members) {
    if (!members.length) return `<span class="adminproj-nomembers">${esc(t("adminProjects.noMembers"))}</span>`;
    return `<span class="adminproj-chips">` + members.map((m) =>
      `<span class="adminproj-chip role-${esc(m.role)}"><b>${esc(m.name || m.username)}</b> ${esc(roleLabel(m.role))}</span>`
    ).join("") + `</span>`;
  }

  function render() {
    const body = $("adminProjectRows");
    const empty = $("adminProjectEmpty");
    body.innerHTML = "";
    if (loadFailed) { empty.style.display = "none"; return; }
    if (!projects.length) { empty.style.display = ""; return; }
    empty.style.display = "none";
    for (const p of projects) {
      const tr = document.createElement("tr");
      if (p.orphaned) tr.className = "adminproj-orphan-row";
      const state = p.orphaned
        ? `<span class="admin-badge adminproj-badge-orphan">${esc(t("adminProjects.orphaned"))}</span>`
        : `<span class="admin-badge status-active">${esc(t("adminProjects.active"))}</span>`;
      tr.innerHTML =
        `<td><div class="adminproj-name">${esc(p.name)}</div><span class="admin-mobile-meta">${esc(t("adminProjects.updated", { time: fmtTime(p.updatedAt) }))}</span></td>` +
        `<td>${memberChips(p.members)}</td>` +
        `<td>${state}</td>` +
        `<td class="admin-hide-sm"><span class="admin-time">${esc(fmtTime(p.updatedAt))}</span></td>` +
        `<td class="admin-col-actions"><button class="admin-row-edit" type="button" aria-label="${esc(t("adminProjects.manageAria", { name: p.name }))}">${ti("settings-2")}<span>${esc(t("adminProjects.manage"))}</span></button></td>`;
      tr.querySelector(".admin-row-edit").addEventListener("click", () => openManage(p.id));
      body.appendChild(tr);
    }
  }

  /* ---------------- manage one project ---------------- */
  function openManage(id) {
    activeId = id;
    const project = activeProject();
    if (!project) return;
    modalError(null);
    modalStatus("");
    $("adminProjectTitle").textContent = project.name;
    $("adminProjectOrphan").style.display = project.orphaned ? "" : "none";
    $("adminProjectAddIdentifier").value = "";
    $("adminProjectAddRole").value = "editor";
    renderMembers();
    openDialog("adminProjectModal");
    setTimeout(() => $("adminProjectAddIdentifier").focus(), 50);
  }

  function renderMembers() {
    const project = activeProject();
    const host = $("adminProjectMembers");
    host.innerHTML = "";
    if (!project) return;
    const ownerCount = project.members.filter((m) => m.role === "owner").length;
    for (const m of project.members) {
      // The last owner cannot be demoted or removed (the server enforces it too);
      // locking the controls avoids a futile round-trip and explains why.
      const lockOwner = m.role === "owner" && ownerCount === 1;
      const row = document.createElement("div");
      row.className = "adminproj-member";
      row.dataset.userId = m.userId;
      const options = rolesFor(m).map((r) => `<option value="${r}"${r === m.role ? " selected" : ""}>${esc(roleLabel(r))}</option>`).join("");
      const sub = [esc(m.username)];
      if (m.external) sub.push(esc(t("admin.roleExternal")));
      if (m.status !== "active") sub.push(esc(m.status === "pending" ? t("admin.statusPending") : t("admin.statusDisabled")));
      row.innerHTML =
        `<span class="adminproj-member-id"><b>${esc(m.name || m.username)}</b><span class="adminproj-member-sub">${sub.join(" · ")}</span></span>` +
        `<select class="input adminproj-role"${lockOwner || busy ? " disabled" : ""}${lockOwner ? " title=\"" + esc(t("api.PROJECT_LAST_OWNER")) + "\"" : ""} aria-label="${esc(t("adminProjects.roleAria", { name: m.name || m.username }))}" aria-describedby="adminProjectOwnerHint">${options}</select>` +
        `<button class="node-act danger adminproj-remove" type="button"${lockOwner || busy ? " disabled" : ""} title="${esc(lockOwner ? t("api.PROJECT_LAST_OWNER") : t("adminProjects.removeAria", { name: m.username }))}" aria-label="${esc(t("adminProjects.removeAria", { name: m.username }))}" aria-describedby="adminProjectOwnerHint">${ti("trash")}</button>`;
      const select = row.querySelector(".adminproj-role");
      select.addEventListener("change", () => { void changeRole(m.userId, select.value, m.role); });
      const remove = row.querySelector(".adminproj-remove");
      if (!lockOwner) remove.addEventListener("click", () => { void removeMember(m.userId); });
      host.appendChild(row);
    }
  }

  // Re-fetch the list after a mutation and keep the open modal in sync, or close
  // it if the project is gone.
  async function refreshActive() {
    await load({ preserveStatus: true });
    const project = activeProject();
    if (!project) { await closeDialog("adminProjectModal"); return; }
    $("adminProjectOrphan").style.display = project.orphaned ? "" : "none";
    renderMembers();
  }

  async function addMember(event) {
    event.preventDefault();
    if (busy) return;
    const project = activeProject();
    if (!project) return;
    const identifier = $("adminProjectAddIdentifier").value.trim();
    if (!identifier) {
      $("adminProjectAddIdentifier").setAttribute("aria-invalid", "true");
      modalError({ code: "MEMBER_IDENTIFIER_REQUIRED" });
      $("adminProjectAddIdentifier").focus();
      return;
    }
    busy = true;
    syncManageBusy();
    const btn = $("adminProjectAddBtn");
    btn.disabled = true; btn.classList.add("loading");
    try {
      const out = await api(`/api/admin/projects/${project.id}/members`, {
        method: "POST",
        body: JSON.stringify({ identifier, role: $("adminProjectAddRole").value }),
      });
      modalError(null);
      $("adminProjectAddIdentifier").value = "";
      await refreshActive();
      modalStatus(t("adminProjects.memberAdded", { name: (out.member && (out.member.name || out.member.username)) || identifier }));
    } catch (err) {
      modalError(err);
    } finally {
      busy = false;
      syncManageBusy();
      btn.disabled = false; btn.classList.remove("loading");
      renderMembers();
      $("adminProjectAddIdentifier").focus();
    }
  }

  async function changeRole(userId, nextRole, previousRole) {
    if (busy || nextRole === previousRole) return;
    const project = activeProject();
    if (!project) return;
    busy = true;
    syncManageBusy();
    try {
      await api(`/api/admin/projects/${project.id}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role: nextRole }) });
      modalError(null);
      await refreshActive();
      modalStatus(t("adminProjects.roleChanged"));
    } catch (err) {
      modalError(err);
    } finally {
      busy = false;
      syncManageBusy();
      renderMembers();
      focusMemberControl(userId, ".adminproj-role");
    }
  }

  async function removeMember(userId) {
    if (busy) return;
    const project = activeProject();
    if (!project) return;
    busy = true;
    syncManageBusy();
    try {
      await api(`/api/admin/projects/${project.id}/members/${userId}`, { method: "DELETE" });
      modalError(null);
      await refreshActive();
      modalStatus(t("adminProjects.memberRemoved"));
    } catch (err) {
      modalError(err);
    } finally {
      busy = false;
      syncManageBusy();
      renderMembers();
      $("adminProjectAddIdentifier").focus();
    }
  }

  /* ---------------- delete a project ---------------- */
  function askDeleteProject() {
    const project = activeProject();
    if (!project) return;
    $("adminProjectDeleteText").textContent = t("adminProjects.deleteProjectText", { name: project.name });
    $("adminProjectDeleteLabel").textContent = t("adminProjects.deleteProjectConfirmLabel");
    $("adminProjectDeleteConfirm").value = "";
    $("adminProjectDeleteConfirm").removeAttribute("aria-invalid");
    $("adminProjectDeleteError").style.display = "none";
    openDialog("adminProjectDeleteModal");
    setTimeout(() => $("adminProjectDeleteConfirm").focus(), 50);
  }

  async function confirmDeleteProject(event) {
    event.preventDefault();
    if (busy) return;
    const project = activeProject();
    if (!project) return;
    // Belt-and-suspenders: the name must be typed exactly before the request.
    if ($("adminProjectDeleteConfirm").value.trim() !== project.name) {
      $("adminProjectDeleteConfirm").classList.add("nomatch");
      $("adminProjectDeleteConfirm").setAttribute("aria-invalid", "true");
      const error = $("adminProjectDeleteError");
      error.textContent = t("adminProjects.confirmMismatch");
      error.style.display = "flex";
      $("adminProjectDeleteConfirm").focus();
      return;
    }
    busy = true;
    const btn = $("adminProjectDeleteOk");
    btn.disabled = true; btn.classList.add("loading");
    try {
      await api(`/api/admin/projects/${project.id}`, { method: "DELETE" });
      const name = project.name;
      await closeDialog("adminProjectDeleteModal");
      await closeDialog("adminProjectModal");
      activeId = null;
      await load({ preserveStatus: true });
      status(t("adminProjects.deleteProjectDone", { name }), false);
      $("adminProjectsTitle").focus();
    } catch (err) {
      const el = $("adminProjectDeleteError");
      el.textContent = window.IrisI18n.error(err);
      el.style.display = "flex";
    } finally {
      busy = false;
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  /* ---------------- lifecycle ---------------- */
  function activate() {
    void load();
  }

  function wire() {
    let searchTimer;
    $("adminProjectSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 220); });
    $("adminProjectFilter").addEventListener("change", () => { void load(); });
    $("adminProjectAddForm").addEventListener("submit", (e) => { void addMember(e); });
    $("adminProjectAddForm").addEventListener("input", () => modalError(null));
    $("adminProjectAddForm").addEventListener("change", () => modalError(null));
    $("adminProjectDeleteBtn").addEventListener("click", askDeleteProject);
    $("adminProjectDeleteForm").addEventListener("submit", (e) => { void confirmDeleteProject(e); });
    $("adminProjectDeleteConfirm").addEventListener("input", () => {
      $("adminProjectDeleteConfirm").classList.remove("nomatch");
      $("adminProjectDeleteConfirm").removeAttribute("aria-invalid");
      $("adminProjectDeleteError").style.display = "none";
    });
    // Click-outside for these two modals (data-admin-close buttons and the global
    // Escape handler cover the rest).
    ["adminProjectModal", "adminProjectDeleteModal"].forEach((id) => {
      $(id).addEventListener("click", (e) => { if (e.target === $(id)) void closeDialog(id); });
    });
  }

  window.IrisAdminProjects = { activate };
  window.IrisI18n.ready.then(() => {
    wire();
    // Re-render the open dashboard/modal after a language switch.
    document.addEventListener("iris:languagechange", () => {
      if (!document.documentElement.classList.contains("iris-inadmin")) return;
      if (projects.length) render();
      if ($("adminProjectModal").classList.contains("on")) {
        const project = activeProject();
        if (project) { $("adminProjectTitle").textContent = project.name; renderMembers(); }
      }
    });
  });
})();
