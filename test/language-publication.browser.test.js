const test = require("node:test");
const assert = require("node:assert/strict");
const { languageBrowser, readySyntax } = require("./helpers/language-browser.cjs");
const { generateFixture } = require("./helpers/language-fixtures.cjs");
const enabled = process.env.IRIS_TEST_BROWSER === "1";

test("HP08 mounted changed roles paint from a real prefix while full analysis is held", { skip: !enabled, timeout: 30000 }, async t => {
  const pageFor = await languageBrowser(t, { beforeNavigate: async page => {
    await page.addInitScript(() => { window.hp08Hold = false; window.hp08Held = new Map(); window.hp08HoldID = 0; window.hp08ParseTime = 0; });
    await page.route("**/iris-language-state.mjs", async route => {
      const response = await route.fetch(), source = await response.text();
      const schedule = "const schedule = hooks.schedule || ownedTasks.schedule;", cancel = "const cancel = hooks.cancel || ownedTasks.cancel;";
      assert.ok(source.includes(schedule) && source.includes(cancel) && source.includes("now: hooks.parseNow,"));
      // Hold only owned zero-delay work. The real editor/parser/highlighter runs;
      // the injected parse clock deterministically exhausts its initial slice.
      await route.fulfill({ response, body: source.replace(schedule,
        "const schedule = (fn, delay) => { if (hp08Hold && delay === 0) { const id = --hp08HoldID; hp08Held.set(id, fn); return id; } return ownedTasks.schedule(fn, delay); };")
        .replace(cancel, "const cancel = id => { if (id < 0) hp08Held.delete(id); else ownedTasks.cancel(id); };")
        .replace("now: hooks.parseNow,", "now: () => hp08Hold ? hp08ParseTime += .02 : performance.now(),") });
    });
  } });
  const source = generateFixture("ly", 100 * 1024).source;
  const page = await pageFor(t, [{ id: "main", type: "file", kind: "ly", name: "main.ly", content: source }]);
  await readySyntax(page);
  const result = await page.evaluate(async () => {
    const { EditorView } = await import("@codemirror/view");
    const { syntaxTree, syntaxTreeAvailable } = await import("@codemirror/language");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor")), pos = view.state.doc.toString().indexOf("c4");
    const roles = pos => { const dom = view.domAtPos(pos), element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node; return [...element.classList].filter(c => c.startsWith("t-")); };
    const before = roles(pos);
    hp08Hold = true;
    IrisEditor.replaceRange(pos, pos + 1, "r");
    await new Promise(requestAnimationFrame);
    const tree = syntaxTree(view.state);
    const result = { before, roles: roles(pos), node: tree.resolveInner(pos, 1).name, headCovered: syntaxTreeAvailable(view.state, pos + 1),
      fullCovered: syntaxTreeAvailable(view.state), treeLength: tree.length, viewport: view.viewport.to,
      text: view.state.doc.sliceString(pos, pos + 1), pending: hp08Held.size };
    hp08Hold = false;
    for (const fn of hp08Held.values()) setTimeout(fn, 0);
    hp08Held.clear();
    return result;
  });
  assert.ok(result.before.includes("t-pitch"));
  assert.equal(result.text, "r");
  assert.equal(result.node, "Rest");
  assert.equal(result.headCovered, true);
  assert.equal(result.fullCovered, false);
  assert.ok(result.treeLength < result.viewport && result.pending > 0, JSON.stringify(result));
  assert.ok(result.roles.includes("t-rest"), `actual changed role must paint before full publication: ${JSON.stringify(result)}`);
  assert.equal((await readySyntax(page)).status, "ready");
});
