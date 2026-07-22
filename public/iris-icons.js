/* Tabler Icons 3.45.0 — MIT License — https://tabler.io/icons */
(function () {
  const paths = {
    "layout-sidebar-left-collapse": "<path d=\"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12\" /><path d=\"M9 4v16\" /><path d=\"M15 10l-2 2l2 2\" />",
    "arrow-left": "<path d=\"M5 12l14 0\" /><path d=\"M5 12l6 6\" /><path d=\"M5 12l6 -6\" />",
    "file-plus": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\" /><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\" /><path d=\"M12 11l0 6\" /><path d=\"M9 14l6 0\" />",
    "folder-open": "<path d=\"M5 19l2.757 -7.351a1 1 0 0 1 .936 -.649h12.307a1 1 0 0 1 .986 1.164l-.996 5.211a2 2 0 0 1 -1.964 1.625h-14.026a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v2\" />",
    "device-floppy": "<path d=\"M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2\" /><path d=\"M10 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" /><path d=\"M14 4l0 4l-6 0l0 -4\" />",
    "paperclip": "<path d=\"M15 7l-6.5 6.5a1.5 1.5 0 0 0 3 3l6.5 -6.5a3 3 0 0 0 -6 -6l-6.5 6.5a4.5 4.5 0 0 0 9 9l6.5 -6.5\" />",
    "chevron-down": "<path d=\"M6 9l6 6l6 -6\" />",
    "chevron-up": "<path d=\"M6 15l6 -6l6 6\" />",
    "chevron-left": "<path d=\"M15 6l-6 6l6 6\" />",
    "chevron-right": "<path d=\"M9 6l6 6l-6 6\" />",
    "files": "<path d=\"M15 3v4a1 1 0 0 0 1 1h4\" /><path d=\"M18 17h-7a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h4l5 5v7a2 2 0 0 1 -2 2\" /><path d=\"M16 17v2a2 2 0 0 1 -2 2h-7a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2h2\" />",
    "list-tree": "<path d=\"M9 6h11\" /><path d=\"M12 12h8\" /><path d=\"M15 18h5\" /><path d=\"M5 6v.01\" /><path d=\"M8 12v.01\" /><path d=\"M11 18v.01\" />",
    "plus": "<path d=\"M12 5l0 14\" /><path d=\"M5 12l14 0\" />",
    "refresh": "<path d=\"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\" /><path d=\"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4\" />",
    "upload": "<path d=\"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2\" /><path d=\"M7 9l5 -5l5 5\" /><path d=\"M12 4l0 12\" />",
    "search": "<path d=\"M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0\" /><path d=\"M21 21l-6 -6\" />",
    "replace": "<path d=\"M3 4a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4\" /><path d=\"M15 16a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4\" /><path d=\"M21 11v-3a2 2 0 0 0 -2 -2h-6l3 3m0 -6l-3 3\" /><path d=\"M3 13v3a2 2 0 0 0 2 2h6l-3 -3m0 6l3 -3\" />",
    "x": "<path d=\"M18 6l-12 12\" /><path d=\"M6 6l12 12\" />",
    "file-type-pdf": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\" /><path d=\"M5 12v-7a2 2 0 0 1 2 -2h7l5 5v4\" /><path d=\"M5 18h1.5a1.5 1.5 0 0 0 0 -3h-1.5v6\" /><path d=\"M17 18h2\" /><path d=\"M20 15h-3v6\" /><path d=\"M11 15v6h1a2 2 0 0 0 2 -2v-2a2 2 0 0 0 -2 -2h-1\" />",
    "terminal-2": "<path d=\"M8 9l3 3l-3 3\" /><path d=\"M13 15l3 0\" /><path d=\"M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12\" />",
    "minus": "<path d=\"M5 12l14 0\" />",
    "download": "<path d=\"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2\" /><path d=\"M7 11l5 5l5 -5\" /><path d=\"M12 4l0 12\" />",
    "align-left-2": "<path d=\"M4 4v16\" /><path d=\"M8 6h12\" /><path d=\"M8 12h6\" /><path d=\"M8 18h10\" />",
    "settings": "<path d=\"M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065\" /><path d=\"M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0\" />",
    "key": "<path d=\"M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0\" /><path d=\"M15 9h.01\" />",
    "logout": "<path d=\"M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2\" /><path d=\"M9 12h12l-3 -3\" /><path d=\"M18 15l3 -3\" />",
    "typography": "<path d=\"M4 20l3 0\" /><path d=\"M14 20l7 0\" /><path d=\"M6.9 15l6.9 0\" /><path d=\"M10.2 6.3l5.8 13.7\" /><path d=\"M5 20l6 -16l2 0l7 16\" />",
    "code": "<path d=\"M7 8l-4 4l4 4\" /><path d=\"M17 8l4 4l-4 4\" /><path d=\"M14 4l-4 16\" />",
    "settings-2": "<path d=\"M19.875 6.27a2.225 2.225 0 0 1 1.125 1.948v7.284c0 .809 -.443 1.555 -1.158 1.948l-6.75 4.27a2.269 2.269 0 0 1 -2.184 0l-6.75 -4.27a2.225 2.225 0 0 1 -1.158 -1.948v-7.285c0 -.809 .443 -1.554 1.158 -1.947l6.75 -3.98a2.33 2.33 0 0 1 2.25 0l6.75 3.98h-.033\" /><path d=\"M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0\" />",
    "player-play": "<path d=\"M7 4v16l13 -8l-13 -8\" />",
    "trash": "<path d=\"M4 7l16 0\" /><path d=\"M10 11l0 6\" /><path d=\"M14 11l0 6\" /><path d=\"M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12\" /><path d=\"M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3\" />",
    "edit": "<path d=\"M7 7h-1a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-1\" /><path d=\"M20.385 6.585a2.1 2.1 0 0 0 -2.97 -2.97l-8.415 8.385v3h3l8.385 -8.415\" /><path d=\"M16 5l3 3\" />",
    "file-text": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\" /><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\" /><path d=\"M9 9l1 0\" /><path d=\"M9 13l6 0\" /><path d=\"M9 17l6 0\" />",
    "music": "<path d=\"M3 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0\" /><path d=\"M13 17a3 3 0 1 0 6 0a3 3 0 0 0 -6 0\" /><path d=\"M9 17v-13h10v13\" /><path d=\"M9 8h10\" />",
    "photo": "<path d=\"M15 8h.01\" /><path d=\"M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12\" /><path d=\"M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5\" /><path d=\"M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3\" />",
    "book-2": "<path d=\"M19 4v16h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h12\" /><path d=\"M19 16h-12a2 2 0 0 0 -2 2\" /><path d=\"M9 8h6\" />",
    "file": "<path d=\"M14 3v4a1 1 0 0 0 1 1h4\" /><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\" />",
    "folder": "<path d=\"M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2\" />",
    "box": "<path d=\"M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5\" /><path d=\"M12 12l8 -4.5\" /><path d=\"M12 12l0 9\" /><path d=\"M12 12l-8 -4.5\" />",
    "check": "<path d=\"M5 12l5 5l10 -10\" />",
    "circle-check": "<path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0\" /><path d=\"M9 12l2 2l4 -4\" />",
    "alert-triangle": "<path d=\"M12 9v4\" /><path d=\"M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0\" /><path d=\"M12 16h.01\" />",
    "circle-x": "<path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0\" /><path d=\"M10 10l4 4m0 -4l-4 4\" />",
    "arrow-right": "<path d=\"M5 12l14 0\" /><path d=\"M13 18l6 -6\" /><path d=\"M13 6l6 6\" />",
    "login": "<path d=\"M15 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2\" /><path d=\"M21 12h-13l3 -3\" /><path d=\"M11 15l-3 -3\" />",
    "shield-lock": "<path d=\"M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3\" /><path d=\"M11 11a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\" /><path d=\"M12 12l0 2.5\" />",
    "file-code-2": "<path d=\"M10 12h-1v5h1\" /><path d=\"M14 12h1v5h-1\" /><path d=\"M14 3v4a1 1 0 0 0 1 1h4\" /><path d=\"M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2\" />",
    "info-circle": "<path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0\" /><path d=\"M12 9h.01\" /><path d=\"M11 12h1v4h1\" />",
    "language": "<path d=\"M4 5h7\" /><path d=\"M7 4c0 4.5 -1.5 7.5 -4 9\" /><path d=\"M5 9c1.5 2 3.5 3.5 6 4\" /><path d=\"M12 20l4 -9l4 9\" /><path d=\"M14 17h4\" />",
  };

  function icon(name, className = "", label = "") {
    const body = paths[name];
    if (!body) return "";
    const cls = ["ti", className].filter(Boolean).join(" ");
    const aria = label ? `role="img" aria-label="${escapeAttr(label)}"` : 'aria-hidden="true"';
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${aria} focusable="false">${body}</svg>`;
  }

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
  }

  function hydrate(root = document) {
    root.querySelectorAll("[data-icon]").forEach((host) => {
      if (host.dataset.iconReady === "true") return;
      host.innerHTML = icon(host.dataset.icon, host.dataset.iconClass || "", host.dataset.iconLabel || "");
      host.dataset.iconReady = "true";
    });
  }

  window.IrisIcons = { icon, hydrate };
  hydrate();
})();
