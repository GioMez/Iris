/* ===================== Iris · motion ===================== */
/* Shared motion primitives for dialogs and the project workspace. Keeping
   transitions here avoids subtly different timing and close behaviour in each
   feature module. */
(function () {
  const root = document.documentElement;
  const dialogClosures = new WeakMap();
  const dialogTokens = new WeakMap();
  let projectToken = 0;

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const elementOf = (target) => typeof target === "string" ? document.getElementById(target) : target;
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const setDialogInteractive = (dialog, interactive) => {
    const surface = dialog.querySelector(":scope > .modal");
    if (surface) surface.inert = !interactive;
  };

  function openDialog(target) {
    const dialog = elementOf(target);
    if (!dialog) return null;
    dialogTokens.set(dialog, (dialogTokens.get(dialog) || 0) + 1);
    dialogClosures.delete(dialog);
    setDialogInteractive(dialog, true);
    dialog.classList.remove("is-closing");
    dialog.classList.add("on");
    return dialog;
  }

  function closeDialog(target, options = {}) {
    const dialog = elementOf(target);
    if (!dialog) return Promise.resolve(false);
    const immediate = !!options.immediate || reducedMotion();
    if (immediate) {
      dialogTokens.set(dialog, (dialogTokens.get(dialog) || 0) + 1);
      dialogClosures.delete(dialog);
      const wasOpen = dialog.classList.contains("on") || dialog.classList.contains("is-closing");
      setDialogInteractive(dialog, false);
      dialog.classList.remove("on", "is-closing");
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
      if (dialogTokens.get(dialog) === token) dialog.classList.remove("on", "is-closing");
      if (dialogClosures.get(dialog) === closing) dialogClosures.delete(dialog);
      return true;
    });
    dialogClosures.set(dialog, closing);
    return closing;
  }

  function closeAllDialogs(options = {}) {
    return Promise.all(Array.from(document.querySelectorAll(".scrim.on, .scrim.is-closing"))
      .map((dialog) => closeDialog(dialog, options)));
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

  window.IrisMotion = { openDialog, closeDialog, closeAllDialogs, openProject, closeProject, resetProject };
})();
