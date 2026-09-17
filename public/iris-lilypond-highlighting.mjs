import { loadLanguage } from './iris-language-service.mjs';
import { createGuardedLanguage } from './iris-language-state.mjs';

// Syntax-only installation, like TeX. A reusable guarded language has no summary
// owner/timer that can be disposed by setState and accidentally installed again.
export async function createLilyPondHighlighting(options = {}) {
  const language = createGuardedLanguage(await loadLanguage('ly', options));
  return () => language;
}
