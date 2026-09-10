const path = require("node:path");
const WARNING = /^(?:(?:LaTeX|LaTeX Font|pdfTeX|LuaTeX|XeTeX|Package \S+|Class \S+) Warning\b|warning\b|WARN\s*-)/i;

// Positions use the compiler's coordinates: lines are 1-based, while a
// LilyPond column may be zero. The UI selects the whole line for both tools.
function sourcePath(value, cwd) {
  if (!value) return null;
  const file = path.posix.normalize(value.replace(/\\/g, "/"));
  const root = cwd && path.posix.normalize(cwd.replace(/\\/g, "/")).replace(/\/$/, "");
  const comparable = (s) => /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
  return root && comparable(file).startsWith(comparable(root) + "/")
    ? file.slice(root.length + 1) : file;
}

function diagnostic(severity, message, file = null, line = null, column = null) {
  return { severity, file, line, column, message: message.trim() };
}

function diagnosticResult(items) {
  const seen = new Set();
  const counts = { error: 0, warning: 0 };
  const diagnostics = items.filter((item) => {
    const key = JSON.stringify([item.severity, item.file, item.line, item.column, item.message]);
    if (seen.has(key) || counts[item.severity] >= 80) return false;
    seen.add(key);
    counts[item.severity] += 1;
    return true;
  });
  return {
    diagnostics,
    warnings: diagnostics.filter((d) => d.severity === "warning").map((d) => d.message),
    errors: diagnostics.filter((d) => d.severity === "error").map((d) => d.message),
  };
}

function parseCompileLog(log, { cwd = "" } = {}) {
  const lines = String(log || "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const items = [];
  const stack = [];
  const currentFile = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return stack[i];
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (/^===== Iris step /.test(text)) { stack.length = 0; continue; }
    if (text.startsWith("$ ")) continue;
    const located = text.match(/^(.+?):(\d+):(?:(\d+):)?\s*(.*)$/);
    if (located) {
      const label = located[4].match(/^(warning|(?:fatal |programming )?error):\s*/i);
      items.push(diagnostic(
        WARNING.test(located[4]) ? "warning" : "error",
        label ? located[4].slice(label[0].length) : located[4],
        sourcePath(located[1], cwd), Number(located[2]) || null,
        located[3] == null ? null : Number(located[3])
      ));
      continue;
    }
    if (/^!\s/.test(text)) {
      let line = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 13); j++) {
        const position = lines[j].match(/^l\.(\d+)\s/);
        if (position) { line = Number(position[1]); break; }
        if (/^!|^=====|^\(/.test(lines[j])) break;
      }
      items.push(diagnostic("error", text.slice(2), currentFile(), line));
      continue;
    }
    if (WARNING.test(text)) {
      let message = text;
      while (i + 1 < lines.length) {
        const continuation = lines[i + 1].match(/^\([\w@.-]+\)\s+(.+)/);
        if (!continuation) break;
        message += " " + continuation[1].trim();
        i += 1;
      }
      const line = message.match(/\bon input line\s+(\d+)/i);
      items.push(diagnostic("warning", message, currentFile(), line ? Number(line[1]) : null));
      continue;
    }
    if (/^(?:(?:fatal |programming )?error:|ERROR\s*-|Emergency stop|Iris: .*?(?:unable to start|failed|stopped after|terminated by signal))/i.test(text)) {
      items.push(diagnostic("error", text));
      continue;
    }
    // TeX reports opened input files in parentheses. Non-file parentheses get
    // their own stack entry so ordinary prose cannot accidentally close a file.
    // Diagnostic messages and source excerpts must never affect this stack.
    if (/^l\.\d+\s/.test(text)) continue;
    const tokens = text.matchAll(/\((?:"([^"\r\n]+\.(?:tex|sty|cls|ltx|aux|bib|bbl|cfg|def|fd))"|([^()\r\n]*?\.(?:tex|sty|cls|ltx|aux|bib|bbl|cfg|def|fd))(?=[\s()]|$))|[()]/gi);
    for (const token of tokens) {
      if (token[0] === ")") stack.pop();
      else stack.push(sourcePath(token[1] || token[2], cwd));
    }
  }
  return diagnosticResult(items);
}

// The existing JSONB warning/error arrays store structured entries for new
// builds. Old builds still contain strings; recover their locations from the
// log, and preserve setup/publication failures even when absent from that log.
function compileDiagnosticsView(result) {
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const stored = [...warnings, ...errors].filter((item) => item && typeof item === "object");
  const items = Array.isArray(result.diagnostics) ? result.diagnostics.slice()
    : stored.length ? stored.slice() : parseCompileLog(result.log).diagnostics;
  for (const [severity, values] of [["warning", warnings], ["error", errors]]) {
    for (const value of values) {
      if (typeof value !== "string") continue;
      const parsed = parseCompileLog(value).diagnostics;
      if (parsed.length) {
        // A legacy string may lack the file context present in the full log.
        for (const item of parsed) if (!items.some((d) => d.message === item.message && d.severity === item.severity)) items.push(item);
      } else if (!items.some((d) => d.message === value)) {
        items.push(diagnostic(severity, value));
      }
    }
  }
  return diagnosticResult(items);
}

module.exports = { parseCompileLog, compileDiagnosticsView };
