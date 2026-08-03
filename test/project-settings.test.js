const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "..", "public", "iris-app.js"), "utf8");

function compileProfileHarness() {
  const controls = () => ({
    value: "",
    disabled: false,
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    dispatch(type, value) {
      this.value = value;
      this.listeners[type]({ target: this });
    },
  });
  const elements = {
    compilePreset: controls(),
    compileSteps: {
      children: [],
      set innerHTML(value) { if (value === "") this.children = []; },
      appendChild(child) { this.children.push(child); },
    },
    compileAddStep: controls(),
    compilePipelineControls: { hidden: false },
  };
  const context = {
    state: {
      compileProfile: {
        mode: "custom",
        steps: [{ tool: "bibtex", args: ["output/[jobname]"] }],
      },
    },
    $: (id) => elements[id],
    document: {
      createElement() {
        const fields = {
          "[data-step-tool]": controls(),
          "[data-step-args]": controls(),
          "[data-step-del]": controls(),
        };
        return {
          className: "",
          innerHTML: "",
          querySelector: (selector) => fields[selector],
          querySelectorAll: (selector) => selector === "select,input,button" ? Object.values(fields) : [],
        };
      },
    },
    isLilyPondProject: () => false,
    persistWhenDocumentClean: () => Promise.resolve(true),
    esc: String,
    t: (key) => key,
    ti: () => "",
  };
  vm.createContext(context);
  const start = app.indexOf("function presetCompileProfile");
  const end = app.indexOf("function updateMainPathControl");
  assert.ok(start >= 0 && end > start, "compile profile functions not found");
  vm.runInContext(app.slice(start, end), context);
  context.renderCompileProfile();
  return { context, input: elements.compileSteps.children[0].querySelector("[data-step-args]") };
}

test("custom compile arguments retain consecutive input events", () => {
  const { context, input } = compileProfileHarness();

  input.dispatch("input", "output/[jobname]-a");
  input.dispatch("input", "output/[jobname]-ab");
  assert.deepEqual(Array.from(context.state.compileProfile.steps[0].args), ["output/[jobname]-ab"]);

  input.dispatch("input", "output/[jobname]-a");
  input.dispatch("input", "output/[jobname]-");
  assert.deepEqual(Array.from(context.state.compileProfile.steps[0].args), ["output/[jobname]-"]);
});
