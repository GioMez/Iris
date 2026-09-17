import { loadLanguage } from "./iris-language-service.mjs";
import { createGuardedLanguage } from "./iris-language-state.mjs";

// HP04 installs syntax only. HP07 can replace this with a per-document summary
// owner using the identical guard. No owner/timer is disposed and then reused
// across EditorView.setState, language reconfiguration, or collaborative resync.
export async function createTexHighlighting(options = {}) {
  const language = createGuardedLanguage(await loadLanguage("tex", options));
  return () => language;
}
