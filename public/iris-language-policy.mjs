// Shared by analysis, state and language queries. UTF-16 units, not UTF-8 bytes.
// Future editor/completion entry points must consult this before installing LR.
export const MAX_ANALYSIS_LENGTH = 1048576;

/** @returns {Readonly<{mode:'full'|'limited',length:number,maxLength:number,reason:'source-too-large'|null}>} */
export function analysisPolicy(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid source length");
  const limited = length > MAX_ANALYSIS_LENGTH;
  return Object.freeze({ mode: limited ? "limited" : "full", length, maxLength: MAX_ANALYSIS_LENGTH, reason: limited ? "source-too-large" : null });
}

export const emptySummary = Object.freeze(Object.fromEntries(["outline", "regions", "symbols", "references", "includes"].map(key => [key, Object.freeze([])])));
export const unknownContext = pos => Object.freeze({ mode: "unknown", argumentRole: null, from: pos, to: pos, certainty: "unknown" });

/** Direct batch visitors cannot encode status; reject instead of returning a
 * misleading complete-empty summary. analyze()/state return explicit status.
 */
export function requireAnalysisLength(length) {
  if (analysisPolicy(length).mode === "limited") {
    const error = new RangeError(`Source exceeds the ${MAX_ANALYSIS_LENGTH} UTF-16 analysis limit`);
    error.code = "IRIS_ANALYSIS_LIMIT";
    throw error;
  }
}
