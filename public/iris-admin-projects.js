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

  let projects = [];
  let activeId = null;
  let loadSequence = 0;
  let busy = false;

  function fmtTime(ts) {
    if (!ts) return "—";
    return window.IrisI18n.formatDate(new Date(ts), { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function status(message, isError) {
    const el = $("adminProjectStatusMsg");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
  }
  function modalError(err) {
    const el = $("adminProjectError");
    el.textContent = err ? window.IrisI18n.error(err) : "";
    el.style.display = err ? "flex" : "none";
  }

  function activeProject() {
    return projects.find((p) => p.id === activeId) || null;
  }

  async function load({ preserveStatus = false } = {}) {
    const sequence = ++loadSequence;
    if (!preserveStatus) status("");
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
      render();
      return true;
    } catch (err) {
      if (sequence !== loadSequence) return false;
      projects = [];
      render();
      status(window.IrisI18n.error(err, "adminProjects.loadFailed"), true);
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
    if (!projects.length) { empty.style.display = ""; return; }
    empty.style.display = "none";
    for (const p of projects) {
      const tr = document.createElement("tr");
      if (p.orphaned) tr.className = "adminproj-orphan-row";
      const state = p.orphaned
        ? `<span class="admin-badge adminproj-badge-orphan">${esc(t("adminProjects.orphaned"))}</span>`
        : `<span class="admin-badge status-active">${esc(t("adminProjects.active"))}</span>`;
      tr.innerHTML =
        `<td><div class="adminproj-name">${esc(p.name)}</div></td>` +
        `<td>${memberChips(p.members)}</td>` +
        `<td>${state}</td>` +
        `<td class="admin-hide-sm"><span class="admin-time">${esc(fmtTime(p.updatedAt))}</span></td>` +
        `<td class="admin-col-actions"><button class="admin-row-edit" type="button">${ti("settings-2")}<span>${esc(t("adminProjects.manage"))}</span></button></td>`;
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
      const options = ROLES.map((r) => `<option value="${r}"${r === m.role ? " selected" : ""}>${esc(roleLabel(r))}</option>`).join("");
      row.innerHTML =
        `<span class="adminproj-member-id"><b>${esc(m.name || m.username)}</b><span class="adminproj-member-sub">${esc(m.username)}${m.status === "disabled" ? " · " + esc(t("admin.statusDisabled")) : ""}</span></span>` +
        `<select class="input adminproj-role"${lockOwner ? " disabled title=\"" + esc(t("api.PROJECT_LAST_OWNER")) + "\"" : ""} aria-label="${esc(t("adminProjects.role"))}">${options}</select>` +
        `<button class="node-act danger adminproj-remove" type="button"${lockOwner ? " disabled" : ""} title="${esc(t("adminProjects.removeAria", { name: m.username }))}" aria-label="${esc(t("adminProjects.removeAria", { name: m.username }))}">${ti("trash")}</button>`;
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
    if (!identifier) { $("adminProjectAddIdentifier").focus(); return; }
    busy = true;
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
      status(t("adminProjects.memberAdded", { name: (out.member && (out.member.name || out.member.username)) || identifier }), false);
    } catch (err) {
      modalError(err);
    } finally {
      busy = false;
      btn.disabled = false; btn.classList.remove("loading");
    }
  }

  async function changeRole(userId, nextRole, previousRole) {
    if (busy || nextRole === previousRole) return;
    const project = activeProject();
    if (!project) return;
    busy = true;
    try {
      await api(`/api/admin/projects/${project.id}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role: nextRole }) });
      modalError(null);
      await refreshActive();
      status(t("adminProjects.roleChanged"), false);
    } catch (err) {
      modalError(err);
      renderMembers(); // revert the select to the real state
    } finally {
      busy = false;
    }
  }

  async function removeMember(userId) {
    if (busy) return;
    const project = activeProject();
    if (!project) return;
    busy = true;
    try {
      await api(`/api/admin/projects/${project.id}/members/${userId}`, { method: "DELETE" });
      modalError(null);
      await refreshActive();
      status(t("adminProjects.memberRemoved"), false);
    } catch (err) {
      modalError(err);
    } finally {
      busy = false;
    }
  }

  /* ---------------- delete a project ---------------- */
  function askDeleteProject() {
    const project = activeProject();
    if (!project) return;
    $("adminProjectDeleteText").textContent = t("adminProjects.deleteProjectText", { name: project.name });
    $("adminProjectDeleteLabel").textContent = t("adminProjects.deleteProjectConfirmLabel");
    $("adminProjectDeleteConfirm").value = "";
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
    $("adminProjectDeleteBtn").addEventListener("click", askDeleteProject);
    $("adminProjectDeleteForm").addEventListener("submit", (e) => { void confirmDeleteProject(e); });
    $("adminProjectDeleteConfirm").addEventListener("input", () => $("adminProjectDeleteConfirm").classList.remove("nomatch"));
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
