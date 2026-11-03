const { readPolicy, cloneValue, createSchemaValidator, portContract, name, names, record, freeze, fail } = require("./contracts");

function createRegistry(definitions, { policy: overrides } = {}) {
  const code = "PIPELINE_REGISTRY_INVALID", policy = readPolicy(overrides);
  if (!Array.isArray(definitions) || definitions.length > policy.maxSteps) fail(code, "Invalid pipeline adapter registry");
  const entries = new Map(), manifest = [];
  for (const definition of definitions) {
    if (!definition || typeof definition.execute !== "function") fail(code, "Adapter requires a host execution function");
    const { execute, ...wire } = definition;
    const metadata = cloneValue(wire, policy, code);
    record(metadata, ["id", "version", "implementationHash", "optionsSchema", "inputs", "outputs", "additionalInputs", "additionalOutputs", "capabilities"], code, "adapter definition");
    name(metadata.id, code);
    if (typeof metadata.version !== "string" || metadata.version.length > 32 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(metadata.version)) fail(code, "Adapter requires an exact semantic version");
    if (typeof metadata.implementationHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.implementationHash)) fail(code, "Invalid adapter implementation identity");
    const key = `${metadata.id}@${metadata.version}`;
    if (entries.has(key)) fail(code, "Duplicate adapter identity");
    for (const direction of ["inputs", "outputs"]) {
      const ports = record(metadata[direction] ?? {}, null, code, "adapter ports");
      if (Object.keys(ports).length > policy.maxPorts) fail(code, "Adapter port limit exceeded");
      metadata[direction] = {};
      for (const [key, value] of Object.entries(ports)) { name(key, code); metadata[direction][key] = portContract(value); }
    }
    for (const field of ["additionalInputs", "additionalOutputs"]) metadata[field] = metadata[field] == null ? null : portContract(metadata[field]);
    metadata.capabilities = names(metadata.capabilities, policy.maxValues, code);
    const options = createSchemaValidator(metadata.optionsSchema ?? { type: "object", properties: {} }, policy);
    metadata.optionsSchema = options.schema;
    freeze(metadata); manifest.push(metadata);
    entries.set(key, Object.freeze({ ...metadata, execute, validateOptions: value => options.validate(value, "PIPELINE_OPTIONS_INVALID") }));
  }
  freeze(manifest);
  return Object.freeze({
    resolve(id, version) {
      if (typeof id !== "string" || typeof version !== "string") fail("PIPELINE_ADAPTER_UNKNOWN", "Unknown pipeline adapter version");
      const definition = entries.get(`${id}@${version}`);
      if (!definition) fail("PIPELINE_ADAPTER_UNKNOWN", "Unknown pipeline adapter version");
      return definition;
    },
    manifest() { return manifest; },
  });
}

module.exports = { createRegistry };
