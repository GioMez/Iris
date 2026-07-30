/* ===================== Iris · motion ===================== */
/* Shared motion primitives for dialogs and the project workspace. Keeping
   transitions here avoids subtly different timing and close behaviour in each
   feature module. */
(function () {
  const root = document.documentElement;
  const dialogClosures = new WeakMap();
  const dialogTokens = new WeakMap();
  const dialogOpeners = new WeakMap();
  const dialogStack = [];
  let projectToken = 0;
  let activeSurface = "login";

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const elementOf = (target) => typeof target === "string" ? document.getElementById(target) : target;
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const setDialogInteractive = (dialog, interactive) => {
    const surface = dialog.querySelector(":scope > .modal");
    if (surface) surface.inert = !interactive;
  };

  function topLevelSurfaces() {
    return {
      app: document.querySelector(".app"),
      picker: document.getElementById("pickerScreen"),
      admin: document.getElementById("adminScreen"),
      login: document.getElementById("loginScreen"),
    };
  }

  function syncSurfaceInteractivity() {
    const blockedByDialog = dialogStack.length > 0;
    Object.entries(topLevelSurfaces()).forEach(([name, element]) => {
      if (!element) return;
      const interactive = !blockedByDialog && name === activeSurface;
      element.inert = !interactive;
      element.setAttribute("aria-hidden", interactive ? "false" : "true");
    });
  }

  function setActiveSurface(name) {
    if (!Object.prototype.hasOwnProperty.call(topLevelSurfaces(), name)) return;
    if (name !== activeSurface) {
      document.querySelectorAll(".menu.on").forEach((menu) => menu.classList.remove("on"));
      document.querySelectorAll('[aria-expanded="true"][aria-controls]').forEach((trigger) => trigger.setAttribute("aria-expanded", "false"));
    }
    activeSurface = name;
    syncSurfaceInteractivity();
  }

  function focusableElements(dialog) {
    const surface = dialog && dialog.querySelector(":scope > .modal");
    if (!surface) return [];
    return Array.from(surface.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0);
  }

  function focusActiveSurface() {
    const targets = {
      app: window.IrisEditor ? window.IrisEditor.focusTarget() : null,
      picker: document.getElementById("projectPickerTitle"),
      admin: document.querySelector('#adminScreen [data-admin-panel]:not([hidden]) .picker-title'),
      login: document.getElementById("loginUser"),
    };
    const target = targets[activeSurface];
    if (target && !target.disabled && target.getClientRects().length > 0) target.focus();
  }

  function restoreDialogContext(dialog, restoreFocus) {
    const index = dialogStack.lastIndexOf(dialog);
    const wasTop = index === dialogStack.length - 1;
    if (index >= 0) dialogStack.splice(index, 1);
    dialog.setAttribute("aria-hidden", "true");
    setDialogInteractive(dialog, false);
    const parent = dialogStack[dialogStack.length - 1];
    if (parent) {
      parent.setAttribute("aria-hidden", "false");
      setDialogInteractive(parent, true);
    }
    syncSurfaceInteractivity();
    if (!restoreFocus || !wasTop) return;
    const opener = dialogOpeners.get(dialog);
    if (opener && opener.isConnected && !opener.disabled && !opener.hidden && !opener.closest("[inert]") && opener.getClientRects().length > 0) opener.focus();
    else focusActiveSurface();
  }

  function openDialog(target) {
    const dialog = elementOf(target);
    if (!dialog) return null;
    const previousTop = dialogStack[dialogStack.length - 1];
    if (previousTop && previousTop !== dialog) {
      previousTop.setAttribute("aria-hidden", "true");
      setDialogInteractive(previousTop, false);
    }
    const existingIndex = dialogStack.lastIndexOf(dialog);
    if (existingIndex >= 0) dialogStack.splice(existingIndex, 1);
    const opener = document.activeElement;
    if (opener && opener !== document.body && !dialog.contains(opener)) dialogOpeners.set(dialog, opener);
    dialogStack.push(dialog);
    dialogTokens.set(dialog, (dialogTokens.get(dialog) || 0) + 1);
    dialogClosures.delete(dialog);
    setDialogInteractive(dialog, true);
    dialog.setAttribute("aria-hidden", "false");
    dialog.classList.remove("is-closing");
    dialog.classList.add("on");
    syncSurfaceInteractivity();
    if (!dialog.contains(document.activeElement)) {
      const focusTarget = dialog.querySelector("[autofocus]") || focusableElements(dialog)[0];
      if (focusTarget) focusTarget.focus();
    }
    return dialog;
  }

  function closeDialog(target, options = {}) {
    const dialog = elementOf(target);
    if (!dialog) return Promise.resolve(false);
    if (dialog.classList.contains("forced") && !options.force) return Promise.resolve(false);
    const immediate = !!options.immediate || reducedMotion();
    if (immediate) {
      dialogTokens.set(dialog, (dialogTokens.get(dialog) || 0) + 1);
      dialogClosures.delete(dialog);
      const wasOpen = dialog.classList.contains("on") || dialog.classList.contains("is-closing");
      dialog.classList.remove("on", "is-closing");
      restoreDialogContext(dialog, options.restoreFocus !== false);
      return Promise.resolve(wasOpen);
    }
    const pending = dialogClosures.get(dialog);
    if (pending) return pending;
    if (!dialog.classList.contains("on") && !dialog.classList.contains("is-closing")) {
      return Promise.resolve(false);
    }

    const token = (dialogTokens.get(dialog) || 0) + 1;
    dialogTokens.set(dialog, token);
    setDialogInteractive(dialog, false);
    dialog.classList.add("is-closing");
    const closing = wait(160).then(() => {
      if (dialogTokens.get(dialog) === token) {
        dialog.classList.remove("on", "is-closing");
        restoreDialogContext(dialog, options.restoreFocus !== false);
      }
      if (dialogClosures.get(dialog) === closing) dialogClosures.delete(dialog);
      return true;
    });
    dialogClosures.set(dialog, closing);
    return closing;
  }

  function closeAllDialogs(options = {}) {
    return Promise.all(Array.from(document.querySelectorAll(".scrim.on, .scrim.is-closing"))
      .map((dialog) => closeDialog(dialog, { ...options, force: true, restoreFocus: false })));
  }

  function closeTopDialog() {
    const dialog = dialogStack[dialogStack.length - 1];
    if (!dialog || dialog.classList.contains("forced")) return Promise.resolve(false);
    return closeDialog(dialog);
  }

  function openProject() {
    const token = ++projectToken;
    root.classList.remove("iris-project-closing", "iris-project-opening");
    root.classList.add("iris-inproject");
    if (reducedMotion()) return;
    // Restart the entrance when a different project is opened without relying
    // on the browser retaining a previous animation state.
    void document.querySelector(".app")?.offsetWidth;
    root.classList.add("iris-project-opening");
    setTimeout(() => {
      if (projectToken === token) root.classList.remove("iris-project-opening");
    }, 260);
  }

  async function closeProject() {
    if (!root.classList.contains("iris-inproject")) return false;
    const token = ++projectToken;
    root.classList.remove("iris-project-opening");
    if (reducedMotion()) {
      root.classList.remove("iris-inproject", "iris-project-closing");
      return true;
    }
    root.classList.add("iris-project-closing");
    await wait(190);
    if (projectToken === token) root.classList.remove("iris-inproject", "iris-project-closing");
    return true;
  }

  function resetProject() {
    projectToken += 1;
    root.classList.remove("iris-inproject", "iris-project-opening", "iris-project-closing");
  }

  document.addEventListener("keydown", (event) => {
    const dialog = dialogStack[dialogStack.length - 1];
    if (!dialog) return;
    if (event.key === "Escape" && !dialog.classList.contains("forced")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeTopDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialog);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && !dialog.contains(document.activeElement)) {
      event.preventDefault(); first.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  setActiveSurface("login");

  window.IrisMotion = {
    openDialog,
    closeDialog,
    closeAllDialogs,
    closeTopDialog,
    openProject,
    closeProject,
    resetProject,
    setActiveSurface,
    activeSurface: () => activeSurface,
  };
})();
