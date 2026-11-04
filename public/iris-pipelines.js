/* ===================== Iris · Lua author controls ===================== */
(function () {
  const $ = id => document.getElementById(id);
  const t = (key, params) => window.IrisI18n.t(`pipelines.${key}`, params);
  const projects = () => window.IrisProjects;
  const active = run => run && ["queued", "planning", "running"].includes(run.state);
  const fresh = () => ({ projectId: null, metadata: null, descriptor: null, plan: null, target: "", run: null,
    fields: [], busy: false, refreshSeq: 0, viewSeq: 0, wanted: null, fetching: false, previewVersion: null, terminal: null });
  let state = fresh();
  const current = owner => owner === state && owner.projectId === projects().currentProjectId();
  const role = () => state.role || projects().currentRole();
  const editable = () => ["owner", "editor"].includes(role());
  function approved(owner = state) {
    const m = owner.metadata;
    return m?.enabled && m.approval && !m.approval.revokedAt && m.candidate &&
      ["bundleHash", "policyHash", "registryHash"].every(key => m.candidate[key] === m.approval[key]);
  }
  function notice(message = "") { $("pipelineNotice").textContent = message; $("pipelineNotice").hidden = !message; }
  function errorNotice(error) { if (!error.stale) notice(window.IrisI18n.error(error)); }
  function render() {
    const m = state.metadata, owner = role() === "owner", allowed = approved();
    $("pipelineStatus").textContent = t(!m ? "loading" : !m.candidate ? "missing" : allowed ? "approved" : "approvalRequired");
    $("pipelineIdentity").textContent = m?.candidate?.bundleHash || "";
    $("pipelineIdentity").hidden = !m?.candidate;
    $("pipelineApprove").hidden = !owner;
    $("pipelineApprove").disabled = state.busy || !m?.candidate || allowed;
    $("pipelineRevoke").hidden = !owner;
    $("pipelineRevoke").disabled = !m?.approval || !!m.approval.revokedAt;
    $("pipelineInspect").disabled = state.busy || !editable() || !allowed;
    $("pipelineTargetsInspect").disabled = state.busy || !editable() || !allowed || !state.descriptor;
    $("pipelineRun").disabled = state.busy || !editable() || !allowed || !state.plan || !state.target;
    const userId = document.documentElement.dataset.uid;
    $("pipelineCancel").disabled = !active(state.run) || !(owner || (editable() && state.run.createdBy === userId));
    $("pipelineTarget").disabled = !$("pipelineTarget").options.length;
    state.fields.forEach(field => {
      field.input.disabled = !editable() || state.busy || (field.include && !field.include.checked);
      if (field.include) field.include.disabled = !editable() || state.busy;
    });
    const run = state.run;
    $("pipelineRunState").dataset.state = run?.state || "";
    $("pipelineRunState").textContent = run ? `${run.target}: ${t(`states.${run.state}`)}` : "";
    if (run?.state === "failed" && run.reason) $("pipelineRunState").textContent += `: ${window.IrisDiagnostics.message({ errorCode: run.reason.toUpperCase().replaceAll("-", "_") })}`;
    $("pipelineSteps").replaceChildren();
    for (const step of run?.steps || []) {
      const item = document.createElement("li");
      item.textContent = `${step.id}: ${t(`states.${step.state}`)}`;
      for (const diagnostic of step.diagnostics || []) {
        const line = document.createElement("div");
        line.textContent = `${diagnostic.file ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}: ` : ""}${window.IrisDiagnostics.message(diagnostic)}`;
        item.appendChild(line);
      }
      $("pipelineSteps").appendChild(item);
    }
    $("pipelineLogDetails").hidden = !run?.log;
    $("pipelineLog").textContent = run?.log || "";
  }
  function changedParameters() { state.plan = null; notice(); render(); }
  function parameterFields(descriptor, values = {}) {
    const form = $("pipelineParameters"); form.replaceChildren(); state.fields = [];
    const root = descriptor?.parameterSchema;
    if (!root) return;
    const properties = root.additionalProperties ? { parameters: { type: "object", title: t("parametersJson"), default: values } } : root.properties;
    for (const [name, schema] of Object.entries(properties || {})) {
      const field = document.createElement("div"); field.className = "field";
      const label = document.createElement("label"); label.className = "label";
      const id = `pipelineParameter${state.fields.length}`, required = root.additionalProperties || root.required?.includes(name);
      const value = root.additionalProperties ? values : Object.hasOwn(values, name) ? values[name] : schema.default;
      const input = document.createElement(schema.enum ? "select" : ["object", "array"].includes(schema.type) ? "textarea" : "input");
      input.id = id; input.dataset.pipelineParam = name; input.className = schema.enum ? "select" : "input";
      label.htmlFor = id; label.textContent = schema.title || name;
      let include = null;
      if (!required) {
        const toggle = document.createElement("label"); toggle.className = "pipeline-include";
        include = document.createElement("input"); include.type = "checkbox"; include.checked = value !== undefined;
        const text = document.createElement("span"); text.textContent = t("include", { name: schema.title || name });
        toggle.append(include, text); field.appendChild(toggle); include.addEventListener("change", changedParameters);
      }
      if (schema.enum) {
        schema.enum.forEach((item, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = typeof item === "string" ? item : JSON.stringify(item); input.appendChild(option); });
        const selected = schema.enum.findIndex(item => JSON.stringify(item) === JSON.stringify(value));
        input.value = String(Math.max(0, selected));
      } else if (schema.type === "boolean") { input.type = "checkbox"; input.className = ""; input.checked = value === true; }
      else if (["object", "array"].includes(schema.type)) input.value = JSON.stringify(value ?? (schema.type === "object" ? {} : []), null, 2);
      else {
        input.type = ["integer", "number"].includes(schema.type) ? "number" : "text";
        if (input.type === "number") {
          input.step = schema.type === "integer" ? "1" : "any";
          if (schema.minimum !== undefined) input.min = schema.minimum;
          if (schema.maximum !== undefined) input.max = schema.maximum;
        }
        if (schema.minLength !== undefined) input.minLength = schema.minLength;
        if (schema.maxLength !== undefined) input.maxLength = schema.maxLength;
        input.value = value ?? "";
      }
      input.required = required && schema.type !== "boolean";
      input.addEventListener("input", changedParameters);
      field.append(label, input);
      if (schema.description) { const hint = document.createElement("p"); hint.className = "hint"; hint.id = `${id}Hint`; hint.textContent = schema.description; field.appendChild(hint); input.setAttribute("aria-describedby", hint.id); }
      form.appendChild(field); state.fields.push({ name, schema, input, include });
    }
    render();
  }
  function parameters() {
    if (!$("pipelineParameters").reportValidity()) return null;
    const values = {};
    for (const { name, schema, input, include } of state.fields) {
      if (include && !include.checked) continue;
      if (schema.enum) values[name] = schema.enum[Number(input.value)];
      else if (schema.type === "boolean") values[name] = input.checked;
      else if (["object", "array"].includes(schema.type)) {
        try { values[name] = JSON.parse(input.value); }
        catch { notice(t("invalidJson", { name })); input.focus(); return null; }
      } else if (["integer", "number"].includes(schema.type)) values[name] = input.valueAsNumber;
      else values[name] = input.value;
    }
    return state.descriptor.parameterSchema.additionalProperties ? values.parameters : values;
  }
  function targets(names) {
    $("pipelineTarget").replaceChildren();
    for (const name of names) { const option = document.createElement("option"); option.value = name; option.textContent = name; $("pipelineTarget").appendChild(option); }
    $("pipelineTarget").value = state.target;
  }
  async function refresh() {
    const owner = state;
    if (!current(owner) || !owner.projectId) return;
    const seq = ++owner.refreshSeq;
    try {
      const result = await projects().getPipeline();
      if (!current(owner) || seq !== owner.refreshSeq) return;
      owner.metadata = result.pipeline;
      const descriptor = approved(owner) ? result.pipeline.descriptor : null;
      if (descriptor?.descriptorHash !== owner.descriptor?.descriptorHash) {
        owner.descriptor = descriptor; owner.plan = null;
        parameterFields(descriptor);
      }
      render();
      return true;
    } catch (error) { if (current(owner) && seq === owner.refreshSeq) errorNotice(error); }
  }
  async function action(work) {
    const owner = state;
    if (!current(owner) || owner.busy || !editable()) return false;
    owner.busy = true; notice(); render();
    try { await work(owner); return current(owner); }
    catch (error) { if (current(owner)) { errorNotice(error); if ([403, 409].includes(error.status)) await refresh(); } return false; }
    finally { if (current(owner)) { owner.busy = false; render(); } }
  }
  async function terminalPreview(owner, run) {
    if (active(run) || owner.terminal === `${run.id}:${run.sequence}`) return;
    owner.terminal = `${run.id}:${run.sequence}`;
    if (owner.previewVersion === null || owner.previewVersion !== window.IrisApp.previewVersion()) return;
    const seq = owner.viewSeq, version = owner.previewVersion;
    const payload = await projects().loadBuildOutput(run.id);
    if (!current(owner) || seq !== owner.viewSeq || owner.run?.id !== run.id || version !== window.IrisApp.previewVersion()) return;
    await window.IrisApp.showBuildOutput(payload, { activateWorkspace: false });
    if (current(owner) && seq === owner.viewSeq) owner.previewVersion = window.IrisApp.previewVersion();
  }
  function acceptRun(owner, run) {
    if (!current(owner) || run.target !== owner.target) return false;
    if (owner.run && (BigInt(run.requestOrder) < BigInt(owner.run.requestOrder) || (run.id === owner.run.id && BigInt(run.sequence) < BigInt(owner.run.sequence)))) return false;
    owner.run = run; render(); return true;
  }
  async function adoptRun(owner, run) {
    if (acceptRun(owner, run)) await terminalPreview(owner, run);
  }
  async function runEvent(event) {
    const owner = state;
    if (!current(owner) || event.projectId !== owner.projectId || event.target !== owner.target) return;
    if (owner.run && (BigInt(event.requestOrder) < BigInt(owner.run.requestOrder) || (event.runId === owner.run.id && BigInt(event.sequence) <= BigInt(owner.run.sequence)))) return;
    if (owner.wanted && (BigInt(event.requestOrder) < BigInt(owner.wanted.requestOrder)
      || (event.runId === owner.wanted.runId && BigInt(event.sequence) <= BigInt(owner.wanted.sequence)))) return;
    owner.wanted = event;
    if (owner.fetching) return;
    owner.fetching = true;
    try {
      while (current(owner) && owner.wanted) {
        const wanted = owner.wanted; owner.wanted = null;
        const result = await projects().getPipelineRun(wanted.runId);
        await adoptRun(owner, result.run);
      }
    } catch (error) { if (current(owner)) errorNotice(error); }
    finally { owner.fetching = false; }
  }
  async function selectTarget({ preview = true } = {}) {
    const owner = state, target = owner.target, seq = ++owner.viewSeq;
    const previousId = window.IrisApp.currentBuildId(), version = window.IrisApp.previewVersion();
    if (owner.run?.target !== target) owner.run = null;
    owner.terminal = null; owner.previewVersion = preview ? version : null; render();
    if (!target) return;
    try {
      const listed = await projects().listBuildOutputs({ kind: "pipeline", target });
      if (!current(owner) || seq !== owner.viewSeq) return;
      const latest = listed.builds[0];
      const run = latest ? (await projects().getPipelineRun(latest.id)).run : null;
      if (!current(owner) || seq !== owner.viewSeq) return;
      if (run ? !acceptRun(owner, run) : owner.run) return;
      if (!preview || version !== window.IrisApp.previewVersion()) return;
      if (listed.latestSuccessfulId) {
        const payload = await projects().loadBuildOutput(listed.latestSuccessfulId);
        if (!current(owner) || seq !== owner.viewSeq || owner.run !== run || version !== window.IrisApp.previewVersion()) return;
        await window.IrisApp.showBuildOutput(payload, { activateWorkspace: false });
        if (!current(owner) || seq !== owner.viewSeq) return;
        if (!payload.artifacts.length) await window.IrisApp.clearBuildOutput(previousId);
      } else await window.IrisApp.clearBuildOutput(previousId);
      if (current(owner) && seq === owner.viewSeq) owner.previewVersion = window.IrisApp.previewVersion();
    } catch (error) { if (current(owner) && seq === owner.viewSeq) errorNotice(error); }
  }
  async function activate(projectId) {
    reset(); const owner = state; owner.projectId = projectId;
    await refresh();
    if (!current(owner)) return;
    try {
      const listed = await projects().listBuildOutputs({ kind: "pipeline", limit: 1 });
      if (!current(owner) || owner.target) return;
      if (listed.builds[0]) { owner.target = listed.builds[0].target; targets([owner.target]); await selectTarget({ preview: false }); }
    } catch (error) { if (current(owner)) errorNotice(error); }
  }
  function reset() { state = fresh(); $("pipelineParameters").replaceChildren(); targets([]); notice(); render(); }
  async function run() {
    if (!state.plan || !approved()) { window.IrisApp.openPipelineControls(); notice(t("inspectFirst")); return; }
    await action(async owner => {
      ++owner.viewSeq; owner.previewVersion = window.IrisApp.previewVersion(); owner.terminal = null;
      const result = await projects().createPipelineRun({ target: owner.target, parameters: owner.plan.parameters, descriptorHash: owner.descriptor.descriptorHash });
      await adoptRun(owner, result.run);
    });
  }
  async function compile() {
    const owner = state;
    const refreshed = await refresh();
    if (!current(owner)) return true;
    if (!refreshed) { window.IrisApp.openPipelineControls(); return true; }
    if (!owner.metadata.enabled) return false;
    await run(); return true;
  }
  function wire() {
    $("pipelineParameters").addEventListener("submit", event => event.preventDefault());
    $("pipelineRefresh").addEventListener("click", () => { void refresh(); });
    $("pipelineApprove").addEventListener("click", () => { void action(async owner => {
      await projects().approvePipeline(owner.metadata.candidate); if (current(owner)) await refresh();
    }); });
    $("pipelineRevoke").addEventListener("click", async () => {
      const owner = state; notice();
      try { await projects().revokePipelineApproval(owner.metadata.approval.id); if (current(owner)) await refresh(); }
      catch (error) { if (current(owner)) errorNotice(error); }
    });
    $("pipelineInspect").addEventListener("click", () => { void action(async owner => {
      const result = await projects().inspectPipeline();
      if (current(owner)) { owner.descriptor = result.descriptor; owner.plan = null; parameterFields(result.descriptor); }
    }); });
    $("pipelineTargetsInspect").addEventListener("click", () => {
      const values = parameters(); if (!values) return;
      void action(async owner => {
        const result = await projects().inspectPipeline({ descriptorHash: owner.descriptor.descriptorHash, parameters: values });
        if (!current(owner)) return;
        owner.plan = result.plan;
        owner.target = result.plan.targets.includes(owner.target) ? owner.target : result.plan.targets[0];
        targets(result.plan.targets); parameterFields(owner.descriptor, result.plan.parameters); await selectTarget();
      });
    });
    $("pipelineTarget").addEventListener("change", () => { state.target = $("pipelineTarget").value; void selectTarget(); });
    $("pipelineRun").addEventListener("click", () => { void run(); });
    $("pipelineCancel").addEventListener("click", async () => {
      const owner = state;
      try { const result = await projects().cancelPipelineRun(owner.run.id); await adoptRun(owner, result.run); }
      catch (error) { if (current(owner)) errorNotice(error); }
    });
    window.IrisCollab.onRun(event => { void runEvent(event); });
    window.IrisCollab.onProjectReady(async projectId => {
      const owner = state; if (owner.projectId !== projectId) return;
      await refresh();
      if (current(owner)) await selectTarget({ preview: owner.previewVersion !== null && owner.previewVersion === window.IrisApp.previewVersion() });
    });
    document.addEventListener("iris:collabrole", event => { state.role = event.detail.role; render(); });
    document.addEventListener("iris:writeforbidden", () => { state.role = "viewer"; render(); });
    document.addEventListener("iris:languagechange", render);
    render();
  }
  window.IrisPipelines = { activate, reset, refresh, compile, run };
  window.IrisI18n.ready.then(wire);
})();
