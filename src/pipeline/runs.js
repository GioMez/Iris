const { createHash } = require("node:crypto");
const { isDeepStrictEqual, types: { isProxy } } = require("node:util");
const { uuidv7, isUuid } = require("../ids");
const { authorizeProjectRecord, canCancelRun, PROJECT_OWNER_LOCK } = require("../project-access");
const { cloneValue, readPolicy, name, logicalPath, record, freeze, resolveTarget, validateBoundDescriptor, isPreviewMediaType } = require("./contracts");

const ACTIVE = new Set(["queued", "planning", "running"]);
const NEXT = { queued: ["planning", "failed", "cancelled", "interrupted"], planning: ["running", "failed", "cancelled", "interrupted"], running: ["failed", "cancelled", "interrupted"] };
const STEP_NEXT = { pending: ["running", "cancelled", "blocked"], running: ["succeeded", "failed", "cancelled"] };
const HASH = /^[a-f0-9]{64}$/;
const EVENT_BYTES = 1048576;
const LOG_TRUNCATED = '{"truncated":true}\n';

function invalid(store, code = "PIPELINE_REQUEST_INVALID", status = 400) {
  throw store.requestError(code, status);
}
function checked(store, work) {
  try { return work(); }
  catch (error) {
    if (error.code?.startsWith("PIPELINE_")) invalid(store, error.code);
    throw error;
  }
}
function jsonValue(store, value) {
  return checked(store, () => cloneValue(value, readPolicy()));
}
function identity(store, value) {
  for (const key of ["bundleHash", "policyHash", "registryHash"]) if (typeof value[key] !== "string" || !HASH.test(value[key])) invalid(store);
}
const authorize = (store, queryable, id, principal, capability) => authorizeProjectRecord(queryable, id, principal, capability, store.requestError);
function owned(store, row) {
  if (!isUuid(store.coordinatorId) || row.coordinator_id !== store.coordinatorId) invalid(store, "PIPELINE_COORDINATOR_CHANGED", 409);
}

async function readRecord(client, id, projectId = null, lock = false, progress = false) {
  const columns = progress ? `id,project_id,status,target,request_order,event_sequence,created_by,
    coordinator_id,approval_id,bundle_hash,policy_hash,registry_hash,deadline_at,
    octet_length(log) AS log_bytes,right(log,${LOG_TRUNCATED.length})='${LOG_TRUNCATED}' AS logs_truncated` : "*";
  const result = await client.query(`SELECT ${columns} FROM build_outputs WHERE id=$1 AND kind='pipeline'
    AND ($2::uuid IS NULL OR project_id=$2)${lock ? " FOR UPDATE" : ""}`, [id, projectId]);
  return result.rows[0] || null;
}
async function lookup(store, id, principal = null, projectId = null, progress = false) {
  if (!isUuid(id) || (projectId !== null && !isUuid(projectId))) invalid(store, "PIPELINE_RUN_NOT_FOUND", 404);
  const row = await readRecord(store.pool, id, projectId, false, progress);
  if (!row) invalid(store, "PIPELINE_RUN_NOT_FOUND", 404);
  if (principal) {
    const access = await store.pool.query(`SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
      WHERE m.project_id=$1 AND m.user_id=$2 AND u.status='active'`, [row.project_id, principal.sub]);
    if (!access.rowCount) invalid(store, "PIPELINE_RUN_NOT_FOUND", 404);
  }
  return row;
}
async function view(client, row) {
  const { rows } = await client.query("SELECT step_id,adapter_id,adapter_version,state,started_at,completed_at,diagnostics FROM pipeline_steps WHERE build_id=$1 ORDER BY step_id", [row.id]);
  return {
    id: row.id, projectId: row.project_id, target: row.target, state: row.status,
    requestOrder: row.request_order, sequence: row.event_sequence, createdBy: row.created_by,
    createdByLabel: row.created_by_label, createdAt: row.created_at, completedAt: row.completed_at,
    saveRevision: row.save_revision, snapshotHash: row.snapshot_hash, bundleHash: row.bundle_hash,
    policyHash: row.policy_hash, registryHash: row.registry_hash, planHash: row.plan_hash,
    primaryPreview: row.primary_preview,
    approvalId: row.approval_id, parameters: row.parameters, reason: row.terminal_reason,
    artifactCount: row.artifact_count, storagePath: row.storage_path, log: row.log, logsTruncated: row.log.endsWith(LOG_TRUNCATED),
    steps: rows.map(s => ({ id: s.step_id, adapter: { id: s.adapter_id, version: s.adapter_version }, state: s.state,
      startedAt: s.started_at, completedAt: s.completed_at, diagnostics: s.diagnostics })),
  };
}
function notification(record) {
  return { projectId: record.projectId, runId: record.id, target: record.target, requestOrder: record.requestOrder,
    sequence: record.sequence, state: record.state };
}

// Use the same gate, project row lock and uncertain-commit handling as saves.
// Release the project gate before draining workers: their pending output events
// may need that same gate to finish persistence.
async function transaction(store, projectId, principal, capability, action, actorId = principal?.sub, afterCommit = null) {
  const notices = [], stopped = new Set();
  const result = await store.mutations.gate(projectId, async () => {
    const value = await store.mutations.transaction({ id: projectId,
      beforeLock: async client => {
        if (actorId) {
          const user = await client.query("SELECT status FROM users WHERE id=$1 FOR SHARE", [actorId]);
          if (principal && user.rows[0]?.status !== "active") invalid(store, "PROJECT_NOT_FOUND", 404);
        }
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [PROJECT_OWNER_LOCK, projectId]);
      },
      authorize: principal ? client => authorize(store, client, projectId, principal, capability) : null,
    }, client => action(client, notices, stopped));
    afterCommit?.();
    return value;
  }, principal ? () => authorize(store, store.pool, projectId, principal, capability) : null);
  for (const id of stopped) await store.stop(id);
  for (const record of notices) await store.emit(notification(record));
  return result;
}
async function finish(client, row, state, reason, notices, stopped) {
  const { rows } = await client.query(`UPDATE build_outputs SET status=$2::text,terminal_reason=$3,
    completed_at=CASE WHEN $2 IN ('queued','planning','running') THEN NULL ELSE CURRENT_TIMESTAMP END,
    event_sequence=event_sequence+1 WHERE id=$1 RETURNING *`, [row.id, state, reason]);
  if (!ACTIVE.has(state) && state !== "succeeded") {
    await client.query(`UPDATE pipeline_steps SET state=CASE WHEN $2='cancelled' OR state='running' THEN 'cancelled' ELSE 'blocked' END,
      completed_at=CURRENT_TIMESTAMP WHERE build_id=$1 AND state IN ('pending','running')`, [row.id, state]);
    stopped.add(row.id);
  }
  const result = await view(client, rows[0]);
  notices.push(result);
  return result;
}
async function authorityReason(store, client, row) {
  if (row.policy_hash !== store.policyHash || row.registry_hash !== store.registryHash) return "execution-policy-changed";
  if (row.deadline_at.getTime() <= Date.now()) return "run-timeout";
  const { rows } = await client.query(`SELECT m.role,u.status,a.revoked_at,p.enabled,
      a.bundle_hash,a.policy_hash,a.registry_hash
    FROM pipeline_approvals a JOIN project_pipelines p ON p.project_id=a.project_id
    LEFT JOIN project_members m ON m.project_id=a.project_id AND m.user_id=$2
    LEFT JOIN users u ON u.id=m.user_id WHERE a.id=$1 AND a.project_id=$3`, [row.approval_id, row.created_by, row.project_id]);
  const a = rows[0];
  if (!a || !a.enabled || a.revoked_at || a.bundle_hash !== row.bundle_hash || a.policy_hash !== row.policy_hash || a.registry_hash !== row.registry_hash) return "approval-revoked";
  if (a.status !== "active" || !["owner", "editor"].includes(a.role)) return "compile-permission-revoked";
  return null;
}
async function withRun(store, id, principal, capability, action, projectId = null, progress = false) {
  const initial = await lookup(store, id, principal, projectId, progress);
  return transaction(store, initial.project_id, principal, capability, async (client, notices, stopped) => {
    const row = await readRecord(client, id, initial.project_id, true, progress);
    if (!row) invalid(store, "PIPELINE_RUN_NOT_FOUND", 404);
    return action(client, row, notices, stopped);
  }, principal?.sub || initial.created_by);
}

async function approveBundle(store, projectId, principal, hashes, { validate, afterCommit } = {}) {
  principal = { sub: principal.sub };
  hashes = { bundleHash: hashes.bundleHash, policyHash: hashes.policyHash, registryHash: hashes.registryHash };
  identity(store, hashes);
  if (hashes.policyHash !== store.policyHash || hashes.registryHash !== store.registryHash) invalid(store, "PIPELINE_POLICY_CHANGED", 409);
  return transaction(store, projectId, principal, "approvePipeline", async client => {
    if (validate) await validate(client);
    const { rows } = await client.query(`INSERT INTO pipeline_approvals
      (id,project_id,bundle_hash,policy_hash,registry_hash,approved_by,approved_by_label)
      SELECT $1,$2,$3,$4,$5,u.id,u.display_name FROM users u WHERE u.id=$6
      RETURNING id,bundle_hash,policy_hash,registry_hash,approved_at`, [uuidv7(), projectId, hashes.bundleHash, hashes.policyHash, hashes.registryHash, principal.sub]);
    await client.query(`INSERT INTO project_pipelines (project_id,enabled,approval_id) VALUES ($1,true,$2)
      ON CONFLICT (project_id) DO UPDATE SET enabled=true,approval_id=EXCLUDED.approval_id`, [projectId, rows[0].id]);
    return { id: rows[0].id, ...hashes, approvedAt: rows[0].approved_at };
  }, principal.sub, afterCommit);
}
async function setAutoApproval(store, projectId, principal, enabled) {
  return transaction(store, projectId, principal, "approvePipeline", async client => {
    if (enabled) await client.query("INSERT INTO pipeline_auto_approvals (project_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [projectId, principal.sub]);
    else await client.query("DELETE FROM pipeline_auto_approvals WHERE project_id=$1 AND user_id=$2", [projectId, principal.sub]);
    return { enabled };
  });
}
async function revokeApproval(store, projectId, approvalId, principal) {
  return transaction(store, projectId, principal, "approvePipeline", async (client, notices, stopped) => {
    const result = await client.query("UPDATE pipeline_approvals SET revoked_at=COALESCE(revoked_at,CURRENT_TIMESTAMP) WHERE id=$1 AND project_id=$2", [approvalId, projectId]);
    if (!result.rowCount) invalid(store, "PIPELINE_APPROVAL_NOT_FOUND", 404);
    await client.query("UPDATE project_pipelines SET enabled=false WHERE project_id=$1 AND approval_id=$2", [projectId, approvalId]);
    const { rows } = await client.query("SELECT * FROM build_outputs WHERE approval_id=$1 AND status IN ('queued','planning','running') ORDER BY request_order FOR UPDATE", [approvalId]);
    for (const row of rows) await finish(client, row, "cancelled", "approval-revoked", notices, stopped);
    return { id: approvalId, revoked: true };
  });
}
async function createRun(store, request) {
  request = { ...request, principal: { sub: request.principal?.sub } };
  identity(store, request);
  for (const id of [request.id, request.projectId, request.approvalId, request.coordinatorId, request.principal?.sub]) if (!isUuid(id)) invalid(store);
  if (typeof request.snapshotHash !== "string" || !HASH.test(request.snapshotHash) || !Number.isSafeInteger(request.saveRevision) || request.saveRevision < 0) invalid(store);
  const target = checked(store, () => name(request.target));
  const parameters = jsonValue(store, request.parameters);
  if (!parameters || Array.isArray(parameters) || typeof parameters !== "object") invalid(store);
  const deadline = new Date(request.deadlineAt);
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) invalid(store);
  return transaction(store, request.projectId, request.principal, "compile", async (client, notices) => {
    const approved = await client.query(`SELECT a.id FROM pipeline_approvals a JOIN project_pipelines p ON p.approval_id=a.id AND p.project_id=a.project_id
      WHERE a.id=$1 AND a.project_id=$2 AND p.enabled AND a.revoked_at IS NULL AND a.bundle_hash=$3 AND a.policy_hash=$4 AND a.registry_hash=$5`,
    [request.approvalId, request.projectId, request.bundleHash, request.policyHash, request.registryHash]);
    if (!approved.rowCount || request.policyHash !== store.policyHash || request.registryHash !== store.registryHash) invalid(store, "PIPELINE_APPROVAL_REQUIRED", 409);
    const { rows } = await client.query(`INSERT INTO build_outputs (id,project_id,created_by,created_by_label,display_name,
      kind,target,status,snapshot_hash,bundle_hash,policy_hash,registry_hash,approval_id,save_revision,parameters,coordinator_id,deadline_at,event_sequence)
      SELECT $1,$2,u.id,u.display_name,$3::text,'pipeline',$3::text,'queued',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,1 FROM users u WHERE u.id=$13 RETURNING *`,
    [request.id, request.projectId, target, request.snapshotHash, request.bundleHash, request.policyHash, request.registryHash,
      request.approvalId, request.saveRevision, JSON.stringify(parameters), request.coordinatorId, deadline, request.principal.sub]);
    const result = await view(client, rows[0]); notices.push(result); return result;
  });
}
async function getRun(store, id, principal, projectId = null) {
  const row = await lookup(store, id, principal, projectId);
  return store.mutations.gate(row.project_id, async () => {
    const current = await readRecord(store.pool, id, row.project_id);
    if (!current) invalid(store, "PIPELINE_RUN_NOT_FOUND", 404);
    return view(store.pool, current);
  }, () => authorize(store, store.pool, row.project_id, principal, "read"));
}
async function cancelRun(store, id, principal, projectId = null) {
  return withRun(store, id, principal, "read", async (client, row, notices, stopped) => {
    const project = await authorize(store, client, row.project_id, principal, "read");
    if (!canCancelRun(project.role, principal.sub, row.created_by)) invalid(store, "PROJECT_FORBIDDEN", 403);
    if (!ACTIVE.has(row.status)) {
      if (row.status !== "succeeded") stopped.add(row.id);
      return view(client, row);
    }
    return finish(client, row, "cancelled", "user-cancelled", notices, stopped);
  }, projectId);
}
async function getPipeline(store, projectId, principal) {
  return store.mutations.gate(projectId, async () => {
    const { rows } = await store.pool.query(`SELECT p.enabled,a.id,a.bundle_hash,a.policy_hash,a.registry_hash,
      a.approved_at,a.revoked_at,a.descriptor FROM project_pipelines p
      LEFT JOIN pipeline_approvals a ON a.id=p.approval_id AND a.project_id=p.project_id WHERE p.project_id=$1`, [projectId]);
    const row = rows[0];
    if (!row) return { enabled: false, approval: null, descriptor: null };
    return { enabled: row.enabled, descriptor: row.descriptor, approval: row.id ? {
      id: row.id, bundleHash: row.bundle_hash, policyHash: row.policy_hash, registryHash: row.registry_hash,
      approvedAt: row.approved_at, revokedAt: row.revoked_at,
    } : null };
  }, () => authorize(store, store.pool, projectId, principal, "read"));
}

async function cacheDescriptor(store, projectId, approvalId, principal, value) {
  return transaction(store, projectId, principal, "compile", async client => {
    const { rows } = await client.query(`SELECT a.* FROM pipeline_approvals a
      JOIN project_pipelines p ON p.project_id=a.project_id AND p.approval_id=a.id
      WHERE a.project_id=$1 AND a.id=$2 AND p.enabled AND a.revoked_at IS NULL`, [projectId, approvalId]);
    const approval = rows[0];
    if (!approval || approval.policy_hash !== store.policyHash || approval.registry_hash !== store.registryHash) invalid(store, "PIPELINE_APPROVAL_REQUIRED", 409);
    const descriptor = checked(store, () => validateBoundDescriptor(value, { identity: {
      bundleHash: approval.bundle_hash, policyHash: approval.policy_hash, registryHash: approval.registry_hash,
    } }));
    if (approval.descriptor && !isDeepStrictEqual(approval.descriptor, descriptor)) invalid(store, "PIPELINE_DESCRIPTOR_CHANGED", 409);
    await client.query("UPDATE pipeline_approvals SET descriptor=$2::jsonb WHERE id=$1", [approvalId, JSON.stringify(descriptor)]);
    return descriptor;
  });
}
async function transitionRun(store, id, expectedState, nextState, details = {}) {
  return withRun(store, id, null, null, async (client, row, notices, stopped) => {
    owned(store, row);
    if (!ACTIVE.has(row.status) || row.status !== expectedState) return view(client, row);
    if (!NEXT[row.status].includes(nextState)) invalid(store, "PIPELINE_TRANSITION_INVALID", 409);
    const reason = await authorityReason(store, client, row);
    if (reason) return finish(client, row, "cancelled", reason, notices, stopped);
    if (nextState === "running") {
      const selected = checked(store, () => resolveTarget(details.plan, row.target));
      if (!isDeepStrictEqual(details.plan.parameters, row.parameters)) invalid(store, "PIPELINE_PARAMETERS_INVALID");
      await client.query("UPDATE build_outputs SET plan_hash=$2,primary_preview=$3::jsonb WHERE id=$1",
        [id, details.plan.planHash, selected.primaryPreview === null ? null : JSON.stringify(selected.primaryPreview)]);
      const steps = selected.steps.map(s => ({ step_id: s.id, adapter_id: s.adapter.id, adapter_version: s.adapter.version, implementation_hash: s.adapter.implementationHash }));
      await client.query(`INSERT INTO pipeline_steps (build_id,step_id,adapter_id,adapter_version,implementation_hash,state)
        SELECT $1,s.step_id,s.adapter_id,s.adapter_version,s.implementation_hash,'pending'
        FROM jsonb_to_recordset($2::jsonb) AS s(step_id text,adapter_id text,adapter_version text,implementation_hash text)`, [id, JSON.stringify(steps)]);
    }
    const terminal = !ACTIVE.has(nextState);
    if (terminal && (typeof details.reason !== "string" || !/^[a-z0-9-]{1,64}$/.test(details.reason))) invalid(store, "PIPELINE_TRANSITION_INVALID");
    return finish(client, row, nextState, terminal ? details.reason : null, notices, stopped);
  });
}

function checkDiagnostic(store, stepId, item) {
  if (!item || typeof item !== "object" || Array.isArray(item)
    || (item.stepId !== undefined && item.stepId !== stepId)) invalid(store, "PIPELINE_DIAGNOSTICS_INVALID");
  function text(value) {
    if (typeof value === "string" && (value.includes("\0") || !value.isWellFormed())) invalid(store, "PIPELINE_DIAGNOSTICS_INVALID");
    if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { text(key); text(item); }
  }
  // JSONB cannot represent NUL or lone surrogates. Reject them at this boundary
  // rather than returning a database error or altering diagnostic text.
  text(item);
}

async function checkDiagnostics(store, client, id, stepId, diagnostics) {
  if (!Array.isArray(diagnostics)) invalid(store, "PIPELINE_DIAGNOSTICS_INVALID");
  const { rows } = await client.query("SELECT step_id,diagnostics FROM pipeline_steps WHERE build_id=$1", [id]);
  const previous = rows.find(step => step.step_id === stepId)?.diagnostics;
  if (!previous) invalid(store, "PIPELINE_STEP_CONFLICT", 409);
  if (previous.some((item, index) => !isDeepStrictEqual(item, diagnostics[index]))) invalid(store, "PIPELINE_DIAGNOSTICS_CHANGED", 409);
  for (let i = previous.length; i < diagnostics.length; i++) checkDiagnostic(store, stepId, diagnostics[i]);
  const encoded = JSON.stringify(diagnostics);
  const bytes = rows.reduce((total, step) => total + (step.step_id === stepId ? 0 : Buffer.byteLength(JSON.stringify(step.diagnostics))), Buffer.byteLength(encoded));
  if (bytes > EVENT_BYTES) invalid(store, "PIPELINE_DIAGNOSTICS_LIMIT");
  return encoded;
}

// A worker output callback cannot await its own drain. Reject lost authority
// here; the coordinator aborts the worker and finalizes after the callback exits.
async function recordProgress(store, id, value) {
  const event = jsonValue(store, value);
  checked(store, () => { record(event, ["stepId", "diagnostic", "level", "message"], "PIPELINE_PROGRESS_INVALID", "progress event"); name(event.stepId); });
  const diagnostic = Object.hasOwn(event, "diagnostic");
  if (diagnostic ? Object.hasOwn(event, "level") || Object.hasOwn(event, "message") :
    !["debug", "info", "warning", "error"].includes(event.level) || typeof event.message !== "string") invalid(store, "PIPELINE_PROGRESS_INVALID");
  return withRun(store, id, null, null, async (client, row, notices) => {
    owned(store, row);
    const receipt = () => ({ id: row.id, projectId: row.project_id, target: row.target, requestOrder: row.request_order,
      sequence: row.event_sequence, state: row.status, logsTruncated: row.logs_truncated });
    if (!ACTIVE.has(row.status)) return receipt();
    if (await authorityReason(store, client, row)) invalid(store, "PIPELINE_RUN_AUTHORITY_CHANGED", 409);
    const { rows } = await client.query("SELECT state,jsonb_array_length(diagnostics) AS count FROM pipeline_steps WHERE build_id=$1 AND step_id=$2", [id, event.stepId]);
    const step = rows[0];
    if (row.status !== "running" || !step || step.state === "pending") invalid(store, "PIPELINE_STEP_CONFLICT", 409);
    if (step.state !== "running") return receipt();
    if (diagnostic) {
      checkDiagnostic(store, event.stepId, event.diagnostic);
      const encoded = JSON.stringify(event.diagnostic);
      const budget = await client.query("SELECT sum(octet_length(diagnostics::text)) AS bytes FROM pipeline_steps WHERE build_id=$1", [id]);
      // JSONB's text form adds formatting whitespace. Most events fit even that
      // upper bound; near the limit, measure compact JSON to preserve capacity.
      if (Number(budget.rows[0].bytes) + Buffer.byteLength(encoded) + (step.count ? 1 : 0) > EVENT_BYTES) {
        const previous = await client.query("SELECT diagnostics FROM pipeline_steps WHERE build_id=$1 AND step_id=$2", [id, event.stepId]);
        await checkDiagnostics(store, client, id, event.stepId, [...previous.rows[0].diagnostics, event.diagnostic]);
      }
      await client.query("UPDATE pipeline_steps SET diagnostics=diagnostics || $3::jsonb WHERE build_id=$1 AND step_id=$2", [id, event.stepId, `[${encoded}]`]);
    } else {
      if (row.logs_truncated) return receipt();
      const frame = JSON.stringify(event) + "\n";
      row.logs_truncated = row.log_bytes + Buffer.byteLength(frame) + Buffer.byteLength(LOG_TRUNCATED) > EVENT_BYTES;
      await client.query("UPDATE build_outputs SET log=log || $2 WHERE id=$1", [id, row.logs_truncated ? LOG_TRUNCATED : frame]);
    }
    const update = await client.query("UPDATE build_outputs SET event_sequence=event_sequence+1 WHERE id=$1 RETURNING event_sequence", [id]);
    row.event_sequence = update.rows[0].event_sequence;
    const result = receipt(); notices.push(result); return result;
  }, null, true);
}

async function transitionStep(store, id, stepId, expectedState, nextState, details = {}) {
  return withRun(store, id, null, null, async (client, row, notices, stopped) => {
    owned(store, row);
    if (!ACTIVE.has(row.status)) return view(client, row);
    const reason = await authorityReason(store, client, row);
    if (reason) return finish(client, row, "cancelled", reason, notices, stopped);
    if (row.status !== "running" || !STEP_NEXT[expectedState]?.includes(nextState)) invalid(store, "PIPELINE_TRANSITION_INVALID", 409);
    const previous = await client.query("SELECT diagnostics FROM pipeline_steps WHERE build_id=$1 AND step_id=$2 AND state=$3", [id, stepId, expectedState]);
    if (!previous.rowCount) invalid(store, "PIPELINE_STEP_CONFLICT", 409);
    const diagnostics = details.diagnostics === undefined ? previous.rows[0].diagnostics : jsonValue(store, details.diagnostics);
    const encoded = await checkDiagnostics(store, client, id, stepId, diagnostics);
    const update = await client.query(`UPDATE pipeline_steps SET state=$4,
      started_at=CASE WHEN $4='running' THEN CURRENT_TIMESTAMP ELSE started_at END,
      completed_at=CASE WHEN $4='running' THEN NULL ELSE CURRENT_TIMESTAMP END,diagnostics=$5::jsonb
      WHERE build_id=$1 AND step_id=$2 AND state=$3`, [id, stepId, expectedState, nextState, encoded]);
    if (!update.rowCount) invalid(store, "PIPELINE_STEP_CONFLICT", 409);
    return finish(client, row, "running", null, notices, stopped);
  });
}

function publication(store, id, artifacts) {
  const code = "PIPELINE_REQUEST_INVALID";
  if (isProxy(artifacts) || !Array.isArray(artifacts) || artifacts.length > 20000) invalid(store);
  // The planner JSON budget does not limit collection metadata. Clone one bounded
  // record at a time, and hash incrementally instead of encoding a second full tree.
  const values = [], policy = readPolicy(), paths = new Set(), ports = new Set(), ids = new Set();
  let bytes = 0;
  for (let i = 0; i < artifacts.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(artifacts, String(i));
    if (!slot || !Object.hasOwn(slot, "value")) invalid(store);
    const item = checked(store, () => {
      const value = cloneValue(slot.value, policy, code);
      return record(value, ["id", "name", "storagePath", "logicalPath", "producerStep", "outputPort", "mimeType", "size", "contentHash"], code, "artifact");
    });
    if (!isUuid(item.id) || ids.has(item.id) || typeof item.name !== "string" || !item.name
      || [".", ".."].includes(item.name) || Array.from(item.name).length > 255 || /[/\\\x00-\x1f\x7f]/.test(item.name)
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 134217728 || typeof item.contentHash !== "string" || !HASH.test(item.contentHash)
      || typeof item.mimeType !== "string" || item.mimeType.length > 100 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(item.mimeType)) invalid(store);
    checked(store, () => {
      name(item.producerStep, code); name(item.outputPort, code);
      logicalPath(item.logicalPath, code); logicalPath(item.storagePath, code);
    });
    const portPath = JSON.stringify([item.producerStep, item.outputPort, item.logicalPath]);
    bytes += item.size;
    if (bytes > 536870912 || !item.storagePath.startsWith(`output/${id}/`) || paths.has(item.storagePath) || ports.has(portPath)) invalid(store);
    paths.add(item.storagePath); ports.add(portPath); ids.add(item.id); values.push(item);
  }
  values.sort((a, b) => a.storagePath < b.storagePath ? -1 : a.storagePath > b.storagePath ? 1 : 0);
  const digest = createHash("sha256").update("[");
  for (const [i, a] of values.entries()) {
    if (i) digest.update(",");
    digest.update(JSON.stringify([a.id,a.producerStep,a.outputPort,a.logicalPath,a.storagePath,a.mimeType,a.size,a.contentHash]));
  }
  return freeze({ artifacts: values, hash: digest.update("]").digest("hex"), path: values.length ? `output/${id}` : null });
}
async function publicationReady(store, client, row, notices, stopped) {
  owned(store, row);
  if (!ACTIVE.has(row.status)) return view(client, row);
  const reason = await authorityReason(store, client, row);
  if (reason) return finish(client, row, "cancelled", reason, notices, stopped);
  const pending = await client.query("SELECT 1 FROM pipeline_steps WHERE build_id=$1 AND state<>'succeeded' LIMIT 1", [row.id]);
  if (row.status !== "running" || !row.plan_hash || pending.rowCount) invalid(store, "PIPELINE_STEPS_INCOMPLETE", 409);
  return null;
}
async function publishRun(store, id, artifacts) {
  const manifest = publication(store, id, artifacts);
  const prepared = await withRun(store, id, null, null, async (client, row, notices, stopped) => {
    const terminal = await publicationReady(store, client, row, notices, stopped);
    if (terminal) return terminal;
    const steps = await client.query("SELECT step_id FROM pipeline_steps WHERE build_id=$1", [id]);
    const producers = new Set(steps.rows.map(step => step.step_id));
    if (manifest.artifacts.some(artifact => !producers.has(artifact.producerStep))) invalid(store);
    if (row.primary_preview) {
      const matches = manifest.artifacts.filter(a => a.producerStep === row.primary_preview.step && a.outputPort === row.primary_preview.port);
      if (matches.length !== 1 || !isPreviewMediaType(matches[0].mimeType)) invalid(store, "PIPELINE_PREVIEW_INVALID");
    }
    if (row.publication_state === "prepared") {
      if (row.publication_hash !== manifest.hash || row.publication_path !== manifest.path) invalid(store, "PIPELINE_PUBLICATION_CONFLICT", 409);
    } else await client.query("UPDATE build_outputs SET publication_state='prepared',publication_hash=$2,publication_path=$3 WHERE id=$1", [id, manifest.hash, manifest.path]);
    return null;
  });
  if (prepared) return prepared;
  return withRun(store, id, null, null, async (client, row, notices, stopped) => {
    const terminal = await publicationReady(store, client, row, notices, stopped);
    if (terminal) return terminal;
    if (manifest.artifacts.length) {
      if (typeof store.publish !== "function") invalid(store, "PIPELINE_PUBLICATION_UNAVAILABLE", 503);
      await store.publish(row, manifest);
    }
    for (const a of manifest.artifacts) await client.query(`INSERT INTO build_artifacts
      (id,build_id,name,storage_path,mime_type,size,content_hash,producer_step,output_port,logical_path)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [a.id,id,a.name,a.storagePath,a.mimeType,a.size,a.contentHash,a.producerStep,a.outputPort,a.logicalPath]);
    const { rows } = await client.query(`UPDATE build_outputs SET status='succeeded',completed_at=CURRENT_TIMESTAMP,
      publication_state='committed',storage_path=$2,artifact_count=$3,size=$4,content_hash=$5,event_sequence=event_sequence+1
      WHERE id=$1 RETURNING *`, [id,manifest.path,manifest.artifacts.length,manifest.artifacts.reduce((n,a) => n+a.size,0),manifest.artifacts.length ? manifest.hash : null]);
    const result = await view(client, rows[0]); notices.push(result); return result;
  });
}

async function reconcileRuns(store, activeOwners) {
  const result = { interrupted: [], unresolved: [] };
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await store.pool.query(`SELECT id,coordinator_id,deadline_at FROM build_outputs WHERE kind='pipeline'
      AND (status IN ('queued','planning','running') OR publication_state='prepared') AND id>$1 ORDER BY id LIMIT 100`, [cursor]);
    if (!rows.length) break;
    for (const candidate of rows) {
      cursor = candidate.id;
      if (activeOwners.has(candidate.coordinator_id) && candidate.deadline_at.getTime() > Date.now()) continue;
      try {
        const interrupted = await withRun(store, candidate.id, null, null, async (client, row, notices, stopped) => {
          // Cancellation and revocation end execution, not publication recovery.
          // Inspect prepared evidence even when another operation made the run terminal.
          if (row.publication_state === "prepared") {
            const inspected = store.inspectPublication ? await store.inspectPublication(row) : { state: "unavailable" };
            if (!["absent", "matching"].includes(inspected.state)) { result.unresolved.push(row.id); return false; }
          }
          if (!ACTIVE.has(row.status)) return false;
          await finish(client, row, "interrupted", "coordinator-interrupted", notices, stopped);
          return true;
        });
        if (interrupted) result.interrupted.push(candidate.id);
      } catch (error) {
        if (error.errorCode === "PROJECT_RECOVERY_REQUIRED") result.unresolved.push(candidate.id);
        else if (error.errorCode !== "PIPELINE_RUN_NOT_FOUND") throw error;
      }
    }
  }
  return result;
}

async function recheckRunPermissions(store, { projectId = null, userId = null } = {}) {
  let cursor = "00000000-0000-0000-0000-000000000000", cancelled = 0;
  for (;;) {
    const { rows } = await store.pool.query(`SELECT b.id FROM build_outputs b
      WHERE b.kind='pipeline' AND b.status IN ('queued','planning','running') AND b.id>$1
      AND ($2::uuid IS NULL OR b.project_id=$2) AND ($3::uuid IS NULL OR b.created_by=$3)
      AND NOT EXISTS (SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
        WHERE m.project_id=b.project_id AND m.user_id=b.created_by AND m.role IN ('owner','editor') AND u.status='active')
      ORDER BY b.id LIMIT 100`, [cursor, projectId, userId]);
    if (!rows.length) return cancelled;
    for (const candidate of rows) {
      cursor = candidate.id;
      const changed = await withRun(store, candidate.id, null, null, async (client, row, notices, stopped) => {
        if (!ACTIVE.has(row.status)) return false;
        const allowed = await client.query(`SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
          WHERE m.project_id=$1 AND m.user_id=$2 AND m.role IN ('owner','editor') AND u.status='active'`, [row.project_id, row.created_by]);
        if (allowed.rowCount) return false;
        await finish(client, row, "cancelled", "compile-permission-revoked", notices, stopped);
        return true;
      });
      if (changed) cancelled++;
    }
  }
}

module.exports = { approveBundle, setAutoApproval, revokeApproval, createRun, getRun, getPipeline, cacheDescriptor, cancelRun, transitionRun, transitionStep, recordProgress, publishRun, reconcileRuns, recheckRunPermissions, validatePublication: publication };
