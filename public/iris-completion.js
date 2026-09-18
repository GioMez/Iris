/* Iris · project command settings. Shared by CommonJS server and browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IrisCompletion = api;
})(typeof window === "undefined" ? globalThis : window, function () {
  const MAX_COMMANDS = 200;
  const COMMAND_NAME = /^[\p{L}@][\p{L}\p{N}@_-]*\*?$/u;
  function normalizeCustomCommands(value) {
    const invalid = (kind, line) => Object.assign(new Error("Invalid custom command"), { code: "CUSTOM_COMMANDS_INVALID", kind, line });
    if (value == null) value = {};
    if (typeof value !== "object" || Array.isArray(value)) throw invalid("tex", 1);
    const result = { tex: [], ly: [] };
    for (const kind of ["tex", "ly"]) {
      const input = value[kind] ?? [];
      if (typeof input !== "string" && !Array.isArray(input)) throw invalid(kind, 1);
      if (input.length > (typeof input === "string" ? 20000 : 1000)) throw invalid(kind, 1);
      const lines = typeof input === "string" ? input.split(/\r?\n/) : input;
      const seen = new Set();
      lines.forEach((line, index) => {
        if (typeof line !== "string" || line.length > 256) throw invalid(kind, index + 1);
        const name = line.trim().replace(/^\\/, "");
        if (!line.trim()) return;
        if (name.length > 80 || !COMMAND_NAME.test(name)) throw invalid(kind, index + 1);
        if (!seen.has(name)) { seen.add(name); result[kind].push("\\" + name); }
        if (result[kind].length > MAX_COMMANDS) throw invalid(kind, index + 1);
      });
    }
    return result;
  }
  return { normalizeCustomCommands, MAX_COMMANDS };
});
