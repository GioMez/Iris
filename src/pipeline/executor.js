const { resolveTarget, cloneValue, fail } = require("./contracts");
const { materializeInputs, validateOutputs } = require("./workspaces");

async function executePlan({ plan, target, workspace, registry, gate, signal = new AbortController().signal, emit = async () => {}, onArtifacts = async () => {} }) {
  const selected = resolveTarget(plan, target), definitions = new Map();
  // Resolve before admission, including branches outside the selected target.
  for (const step of plan.steps) {
    const definition = registry.resolve(step.adapter.id, step.adapter.version);
    if (definition.implementationHash !== step.adapter.implementationHash) fail("PIPELINE_ADAPTER_CHANGED", "Pipeline adapter identity changed");
    definitions.set(step.id, definition);
  }
  const artifacts = new Map(), states = new Map(), steps = [];
  let failed = false, diagnosticBytes = 0;
  for (const step of selected.steps) {
    const result = { id: step.id, state: "pending", diagnostics: [] };
    steps.push(result);
    async function transition(next) {
      await emit({ stepId: step.id, state: next, diagnostics: result.diagnostics, ...(result.errorCode ? { errorCode: result.errorCode } : {}) });
      result.state = next; states.set(step.id, next);
    }
    if (signal.aborted) { await transition("cancelled"); continue; }
    if (plan.dependencies[step.id].some(id => states.get(id) !== "succeeded")) { await transition("blocked"); continue; }
    let release;
    try { release = await gate.acquire({ signal }); }
    catch (error) {
      if (!signal.aborted) throw error;
      await transition("cancelled"); continue;
    }
    try {
      if (signal.aborted) { await transition("cancelled"); continue; }
      await transition("running");
      let produced, error, rejected = false;
      try {
        const context = await materializeInputs(workspace, step, artifacts, { signal, policy: plan.policy });
        signal.throwIfAborted();
        // Registered adapters settle only after contained workers have drained.
        const outcome = await definitions.get(step.id).execute(context);
        signal.throwIfAborted();
        const diagnostics = cloneValue(outcome?.diagnostics ?? [], plan.policy);
        if (!Array.isArray(diagnostics)) fail("PIPELINE_DIAGNOSTICS_INVALID", "Invalid pipeline diagnostics");
        diagnosticBytes += Buffer.byteLength(JSON.stringify(diagnostics));
        if (diagnosticBytes > 1048576) fail("PIPELINE_DIAGNOSTICS_LIMIT", "Pipeline diagnostics exceed the run budget");
        result.diagnostics = diagnostics;
        if (outcome?.errorCode !== undefined) {
          if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(outcome.errorCode)) fail("PIPELINE_OUTCOME_INVALID", "Invalid pipeline failure code");
          fail(outcome.errorCode, "Pipeline adapter failed");
        }
        produced = await validateOutputs(workspace, step, { signal });
        signal.throwIfAborted();
        // Host-only association of private maps/provenance stays inside the same
        // admission and drain boundary, before success or downstream visibility.
        await onArtifacts(context, produced);
        signal.throwIfAborted();
      } catch (caught) { error = caught; rejected = true; }
      if (signal.aborted) await transition("cancelled");
      else if (rejected) {
        failed = true;
        result.errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || "") ? error.code : "PIPELINE_STEP_FAILED";
        await transition("failed");
      } else {
        for (const artifact of produced) artifacts.set(`${step.id}:${artifact.outputPort}`, artifact);
        await transition("succeeded");
      }
    } finally { release(); }
  }
  const state = signal.aborted ? "cancelled" : failed ? "failed" : "succeeded";
  return { state, steps, artifacts: state === "succeeded" ? selected.publish.map(ref => artifacts.get(`${ref.step}:${ref.port}`)) : [],
    primaryPreview: state === "succeeded" ? selected.primaryPreview : null };
}

module.exports = { executePlan };
