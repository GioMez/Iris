const { createHash } = require("node:crypto");
const { isProxy } = require("node:util").types;
const Ajv = require("ajv");

const DEFAULT_POLICY = Object.freeze({
  maxSteps: 128, maxTargets: 64, maxPorts: 64, maxEdges: 2048,
  maxPlanBytes: 1024 * 1024, maxValues: 50000, maxDepth: 32, maxStringBytes: 65536,
  maxSchemaBytes: 65536, maxSchemaValues: 2048, maxSchemaDepth: 16,
});
// Snapshot manifests and collection listings may exceed a graph's serialization
// allowance. Keep their transfer budget separate from returned planner data.
const LUA_DATA_POLICY = Object.freeze({ ...DEFAULT_POLICY, maxPlanBytes: 16777216, maxValues: 500000 });
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const KINDS = new Set(["file", "collection", "layout"]);
const PREVIEWS = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const SNAPSHOT_TYPE = "application/vnd.iris.source-tree";
const validatedPlans = new WeakSet();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function readPolicy(overrides = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) fail("PIPELINE_POLICY_INVALID", "Invalid pipeline policy");
  const result = { ...DEFAULT_POLICY };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < 1) fail("PIPELINE_POLICY_INVALID", "Invalid pipeline policy limit");
    result[key] = value;
  }
  // The copy walker must not acquire an unbounded JavaScript call stack.
  if (result.maxDepth > 64 || result.maxSchemaDepth > 64) fail("PIPELINE_POLICY_INVALID", "Pipeline nesting limit exceeds supported depth");
  return Object.freeze(result);
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Copy without invoking getters/toJSON. IPC must also bound bytes before parsing.
function cloneValue(value, policy, code = "PIPELINE_PLAN_INVALID", schema = false) {
  const limit = schema ? policy.maxSchemaBytes : policy.maxPlanBytes;
  const nodes = schema ? policy.maxSchemaValues : policy.maxValues;
  const depthLimit = schema ? policy.maxSchemaDepth : policy.maxDepth;
  const seen = new Set();
  let count = 0, bytes = 0;
  function add(size) { bytes += size; if (bytes > limit) fail(code, "Pipeline data exceeds its byte limit"); }
  function text(text) {
    if (Buffer.byteLength(text, "utf8") > policy.maxStringBytes) fail(code, "Pipeline string exceeds its byte limit");
    add(Buffer.byteLength(JSON.stringify(text), "utf8"));
    return text;
  }
  function copy(item, depth) {
    if (++count > nodes || depth > depthLimit) fail(code, "Pipeline data exceeds its structural limit");
    if (item === null) { add(4); return null; }
    if (typeof item === "string") return text(item);
    if (typeof item === "boolean") { add(item ? 4 : 5); return item; }
    if (typeof item === "number" && Number.isFinite(item)) { add(String(item).length); return item === 0 ? 0 : item; }
    if (!item || typeof item !== "object" || isProxy(item)) fail(code, "Pipeline data must be JSON-compatible");
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if ((!array && prototype !== Object.prototype && prototype !== null) || (array && prototype !== Array.prototype) || seen.has(item)) {
      fail(code, "Pipeline data contains a cycle or unsupported prototype");
    }
    seen.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    const result = array ? [] : {};
    if (array && (keys.length !== item.length + 1 || item.length > nodes)) fail(code, "Pipeline arrays must be dense JSON arrays");
    add(2);
    let first = true;
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (typeof key !== "string" || RESERVED.has(key) || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(code, "Unsupported pipeline property");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail(code, "Unsupported pipeline array property");
      if (!array) { text(key); add(1); }
      if (!first) add(1);
      first = false;
      result[key] = copy(descriptor.value, depth + 1);
    }
    seen.delete(item);
    return result;
  }
  return copy(value, 0);
}
function record(value, allowed, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `Invalid ${label}`);
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) fail(code, `Unknown ${label} field`);
  return value;
}
function name(value, code = "PIPELINE_PLAN_INVALID") {
  if (typeof value !== "string" || !NAME.test(value)) fail(code, "Invalid pipeline identifier");
  return value;
}
function names(values = [], limit, code = "PIPELINE_PLAN_INVALID") {
  if (!Array.isArray(values) || values.length > limit) fail(code, "Invalid pipeline identifier list");
  const result = values.map(value => name(value, code));
  if (new Set(result).size !== result.length) fail(code, "Duplicate pipeline identifier");
  return result;
}
function logicalPath(value, code = "PIPELINE_PLAN_INVALID") {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f\x7f:]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) {
    fail(code, "Invalid pipeline output path");
  }
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

const SCHEMA_KEYS = ["type", "properties", "required", "additionalProperties", "items", "enum", "default", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "title", "description"];
function createSchemaValidator(schema, policy = readPolicy()) {
  const code = "PIPELINE_SCHEMA_INVALID";
  const normalized = cloneValue(schema, policy, code, true);
  function visit(node) {
    record(node, SCHEMA_KEYS, code, "parameter schema");
    if (!["object", "array", "string", "number", "integer", "boolean"].includes(node.type)) fail(code, "Unsupported parameter schema type");
    if (node.type === "object") {
      if (node.properties === undefined) node.properties = {};
      record(node.properties, null, code, "parameter properties");
      for (const child of Object.values(node.properties)) visit(child);
      if (node.additionalProperties === undefined) node.additionalProperties = false;
      if (typeof node.additionalProperties !== "boolean") fail(code, "Additional parameter properties must use a boolean policy");
    }
    if (node.type === "array") visit(node.items);
  }
  visit(normalized);
  if (normalized.type !== "object") fail(code, "Parameters require an object schema");
  // A fresh bounded compiler avoids retaining attacker-selected schemas in Ajv's cache.
  const ajv = new Ajv({ strict: true, allErrors: false, useDefaults: true, coerceTypes: false, removeAdditional: false, ownProperties: true });
  let validate;
  try { validate = ajv.compile(normalized); }
  catch { fail(code, "Invalid parameter schema"); }
  const publicSchema = freeze(normalized);
  return {
    schema: publicSchema,
    validate(value, errorCode = "PIPELINE_PARAMETERS_INVALID") {
      const copy = cloneValue(value, policy, errorCode);
      if (!copy || typeof copy !== "object" || Array.isArray(copy) || !validate(copy)) fail(errorCode, "Invalid pipeline parameter values");
      // Defaults also consume the value/byte budget.
      return freeze(cloneValue(copy, policy, errorCode));
    },
  };
}
function validateParameters(schema, values, { policy } = {}) {
  return createSchemaValidator(schema, readPolicy(policy)).validate(values);
}

function portContract(value, code = "PIPELINE_REGISTRY_INVALID") {
  record(value, ["kinds", "mediaTypes", "required"], code, "adapter port");
  if (!Array.isArray(value.kinds) || !value.kinds.length || value.kinds.some(kind => !KINDS.has(kind)) ||
      !Array.isArray(value.mediaTypes) || !value.mediaTypes.length || value.mediaTypes.some(type => typeof type !== "string" || (type !== "*/*" && !MIME.test(type))) ||
      (value.required !== undefined && typeof value.required !== "boolean")) fail(code, "Invalid adapter port contract");
  return { kinds: [...new Set(value.kinds)], mediaTypes: [...new Set(value.mediaTypes)], required: value.required === true };
}
function compatible(contract, output) {
  return contract && contract.kinds.includes(output.kind) && (contract.mediaTypes.includes("*/*") || contract.mediaTypes.includes(output.mediaType));
}
function declaredPort(ports, key, additional) {
  return Object.hasOwn(ports, key) ? ports[key] : additional;
}
function reference(value) {
  record(value, ["step", "port"], "PIPELINE_PLAN_INVALID", "artifact reference");
  return { step: name(value.step), port: name(value.port) };
}

function validatePlan(value, { registry, policy: overrides } = {}) {
  const policy = readPolicy(overrides), code = "PIPELINE_PLAN_INVALID";
  const source = cloneValue(value, policy);
  record(source, ["apiVersion", "pluginId", "parameterSchema", "parameters", "requiredCapabilities", "steps", "targets"], code, "pipeline plan");
  if (source.apiVersion !== 1) fail(code, "Unsupported pipeline API version");
  name(source.pluginId);
  if (!registry || typeof registry.resolve !== "function" || typeof registry.manifest !== "function") fail(code, "Pipeline requires an adapter registry");
  const parameter = createSchemaValidator(source.parameterSchema === undefined ? { type: "object", properties: {} } : source.parameterSchema, policy);
  const parameters = parameter.validate(source.parameters === undefined ? {} : source.parameters);
  const requiredCapabilities = names(source.requiredCapabilities, policy.maxValues);
  if (!Array.isArray(source.steps) || !source.steps.length || source.steps.length > policy.maxSteps) fail(code, "Pipeline step limit exceeded");
  const steps = [], byId = new Map(), definitions = new Map();
  for (const raw of source.steps) {
    record(raw, ["id", "adapter", "inputs", "options", "outputs", "after", "requiredCapabilities"], code, "pipeline step");
    const id = name(raw.id);
    if (byId.has(id)) fail(code, "Duplicate pipeline step");
    record(raw.adapter, ["id", "version"], code, "adapter reference");
    const definition = registry.resolve(raw.adapter.id, raw.adapter.version);
    const capabilities = names(raw.requiredCapabilities, policy.maxValues);
    if (capabilities.some(capability => !definition.capabilities.includes(capability))) fail(code, "Adapter lacks a required capability");
    const inputs = record(raw.inputs === undefined ? {} : raw.inputs, null, code, "step inputs");
    const outputs = record(raw.outputs === undefined ? {} : raw.outputs, null, code, "step outputs");
    if (Object.keys(inputs).length > policy.maxPorts || Object.keys(outputs).length > policy.maxPorts) fail(code, "Pipeline port limit exceeded");
    const paths = [];
    for (const [key, output] of Object.entries(outputs)) {
      name(key);
      record(output, ["kind", "mediaType", "path"], code, "step output");
      if (!KINDS.has(output.kind) || typeof output.mediaType !== "string" || !MIME.test(output.mediaType)) fail(code, "Invalid output type");
      if (!compatible(declaredPort(definition.outputs, key, definition.additionalOutputs), output)) fail(code, "Output does not match its adapter port");
      const path = logicalPath(output.path);
      if (paths.some(other => other === path || other.startsWith(`${path}/`) || path.startsWith(`${other}/`))) fail(code, "Overlapping step output paths");
      paths.push(path);
    }
    for (const [key, contract] of Object.entries(definition.outputs)) if (contract.required && !Object.hasOwn(outputs, key)) fail(code, "Missing required output port");
    const step = { id, adapter: { id: definition.id, version: definition.version, implementationHash: definition.implementationHash },
      inputs, outputs, options: definition.validateOptions(raw.options === undefined ? {} : raw.options), after: names(raw.after, policy.maxSteps), requiredCapabilities: capabilities };
    steps.push(step); byId.set(id, step); definitions.set(id, definition);
  }
  const available = new Set([...definitions.values()].flatMap(definition => definition.capabilities));
  if (requiredCapabilities.some(capability => !available.has(capability))) fail(code, "Pipeline lacks a required capability");
  function produced(ref) {
    const outputs = byId.get(ref.step)?.outputs;
    if (!outputs || !Object.hasOwn(outputs, ref.port)) fail(code, "Unknown artifact producer or output port");
    return outputs[ref.port];
  }
  const dependencies = {}, successors = new Map(steps.map(step => [step.id, []]));
  let edges = 0;
  for (const step of steps) {
    const definition = definitions.get(step.id), prerequisites = new Set(step.after);
    for (const [key, contract] of Object.entries(definition.inputs)) if (contract.required && !Object.hasOwn(step.inputs, key)) fail(code, "Missing required input port");
    for (const [key, input] of Object.entries(step.inputs)) {
      name(key);
      let product;
      if (input && input.snapshot === true) {
        record(input, ["snapshot"], code, "snapshot input");
        product = { kind: "collection", mediaType: SNAPSHOT_TYPE };
      } else {
        const ref = reference(input); product = produced(ref); prerequisites.add(ref.step);
      }
      if (!compatible(declaredPort(definition.inputs, key, definition.additionalInputs), product)) fail(code, "Input does not match its adapter port");
    }
    dependencies[step.id] = [...prerequisites];
    edges += prerequisites.size;
    if (edges > policy.maxEdges) fail(code, "Pipeline dependency limit exceeded");
    for (const id of prerequisites) {
      if (!byId.has(id)) fail(code, "Unknown completion dependency");
      successors.get(id).push(step.id);
    }
  }
  const remaining = new Map(steps.map(step => [step.id, dependencies[step.id].length]));
  const order = steps.filter(step => remaining.get(step.id) === 0).map(step => step.id);
  for (let position = 0; position < order.length; position++) {
    for (const id of successors.get(order[position])) {
      const count = remaining.get(id) - 1; remaining.set(id, count);
      if (!count) order.push(id);
    }
  }
  if (order.length !== steps.length) fail(code, "Pipeline dependencies contain a cycle");
  const rawTargets = record(source.targets, null, code, "pipeline targets"), targets = {};
  if (!Object.keys(rawTargets).length || Object.keys(rawTargets).length > policy.maxTargets) fail(code, "Pipeline target limit exceeded");
  for (const [key, target] of Object.entries(rawTargets)) {
    name(key); record(target, ["steps", "publish", "primaryPreview"], code, "pipeline target");
    const terminal = names(target.steps, policy.maxSteps);
    if (terminal.some(id => !byId.has(id))) fail(code, "Unknown target step");
    if (!Array.isArray(target.publish) || target.publish.length > policy.maxPorts || (!terminal.length && !target.publish.length)) fail(code, "Invalid target publications");
    const publish = target.publish.map(reference), seen = new Set();
    for (const ref of publish) {
      produced(ref); const identity = `${ref.step}/${ref.port}`;
      if (seen.has(identity)) fail(code, "Duplicate target publication");
      seen.add(identity);
    }
    const primaryPreview = target.primaryPreview == null ? null : reference(target.primaryPreview);
    if (primaryPreview) {
      const output = produced(primaryPreview);
      if (!seen.has(`${primaryPreview.step}/${primaryPreview.port}`) || output.kind !== "file" || !PREVIEWS.has(output.mediaType)) fail(code, "Invalid primary preview artifact");
    }
    targets[key] = { steps: terminal, publish, primaryPreview };
  }
  const result = { apiVersion: 1, pluginId: source.pluginId, parameterSchema: parameter.schema, parameters, requiredCapabilities,
    steps, targets, dependencies, order, policy };
  // Normalization can expand defaults and resolved metadata; bound that too.
  cloneValue(result, policy);
  result.planHash = createHash("sha256").update(canonical(result)).digest("hex");
  freeze(result); validatedPlans.add(result);
  return result;
}
function resolveTarget(plan, targetName) {
  if (!validatedPlans.has(plan)) fail("PIPELINE_PLAN_INVALID", "Target resolution requires a validated plan");
  const target = Object.hasOwn(plan.targets, targetName) && plan.targets[targetName];
  if (!target) fail("PIPELINE_TARGET_UNKNOWN", "Unknown pipeline target");
  const required = new Set(), pending = [...target.steps, ...target.publish.map(ref => ref.step)];
  while (pending.length) {
    const id = pending.pop();
    if (required.has(id)) continue;
    required.add(id); pending.push(...plan.dependencies[id]);
  }
  const byId = new Map(plan.steps.map(step => [step.id, step]));
  return freeze({ steps: plan.order.filter(id => required.has(id)).map(id => byId.get(id)), publish: target.publish, primaryPreview: target.primaryPreview });
}

module.exports = { DEFAULT_POLICY, LUA_DATA_POLICY, SNAPSHOT_TYPE, validatePlan, resolveTarget, validateParameters,
  readPolicy, cloneValue, createSchemaValidator, portContract, name, names, logicalPath, canonical, record, freeze, fail };
