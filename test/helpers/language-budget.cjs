// Strict assessment of the separately instrumented UI-thread feature work.
// Profiling perturbs timing; retain every overrun and never assert universal
// hard real-time guarantees from a finite diagnostic collection.
function evaluateFeatureBudgets({ tasks = [], queries = [], initialPrefixes = [] }) {
  const failures = [];
  const summary = (records, budgetMs, category) => {
    for (const sample of records) if (!Number.isFinite(sample.ms) || sample.ms > budgetMs) failures.push({ category, budgetMs, ...sample });
    const sorted = records.map(s => s.ms).sort((a, b) => a - b);
    return { measured: records.length > 0, count: records.length, budgetMs,
      p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null, maxMs: sorted.at(-1) ?? null };
  };
  const taskGroups = Object.fromEntries([...new Set(tasks.map(t => t.name))].map(name =>
    [name || "anonymous", summary(tasks.filter(t => t.name === name), name === "parseChunk" ? 5 : 8, `task:${name || "anonymous"}`)]));
  const queryResult = summary(queries, 5, "context-query"), initialResult = summary(initialPrefixes, 5, "initial-prefix");
  const complete = tasks.length > 0 && queryResult.measured && initialResult.measured;
  return { gateVersion: "hp08-v2-feature-work", taskGroups, queries: queryResult, initialPrefixes: initialResult,
    complete, failures, passed: complete && failures.length === 0,
    scope: "Instrumented application task callbacks, complete context queries and initial prefix construction; load and edit phases included. CPU sampling/observer overhead retained. Not an all-input hard real-time guarantee." };
}
module.exports = { evaluateFeatureBudgets };
