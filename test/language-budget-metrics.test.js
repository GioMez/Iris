const test = require("node:test"), assert = require("node:assert/strict");
const evaluate = data => require("./helpers/language-budget.cjs").evaluateFeatureBudgets(data);
test("feature budgets apply during load as well as editing, independent of the long-task gate", () => {
  const data = { tasks: [{ name: "parseChunk", start: 10, ms: 5 }, { name: "chunk", start: 20, ms: 8 }],
    initialPrefixes: [{ start: 1, ms: 5 }], queries: [{ start: 30, ms: 5 }] };
  assert.deepEqual(evaluate(data).failures, []);
  data.tasks[0].ms = 5.01;
  assert.equal(evaluate(data).failures.length, 1, "a sub-50ms load parser slice must still fail its 5ms budget");
  data.tasks[1].ms = 8.01; data.initialPrefixes[0].ms = 5.01; data.queries[0].ms = 5.01;
  assert.equal(evaluate(data).failures.length, 4);
});
test("feature diagnostic reports every over-budget sample and cannot call absent query evidence passing", () => {
  const data = { tasks: [{name:"publishSyntax", start:1, ms:9}, {name:"prepareSource", start:20, ms:9}], initialPrefixes: [], queries: [] };
  const result = evaluate(data);
  assert.equal(result.failures.length, 2);
  assert.equal(result.queries.measured, false); assert.equal(result.initialPrefixes.measured, false);
  assert.equal(result.passed, false); assert.equal(result.complete, false);
});
