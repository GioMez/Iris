const test = require("node:test");
const assert = require("node:assert/strict");

async function parserFixture(t, { worker = false, viewportFinalization = 1.3, stepCost = .2 } = {}) {
  const { EditorState } = await import("@codemirror/state");
  const { Language, ensureSyntaxTree, syntaxTreeAvailable, syntaxTree } = await import("@codemirror/language");
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createGuardedLanguage } = await import("../public/iris-language-state.mjs");
  const { createCooperativeParser } = await import("../public/iris-language-parser.mjs");
  const adapter = await loadLanguage("tex"), guarded = createGuardedLanguage(adapter), start = guarded.parser.startParse;
  if (worker) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    // Only advertise Worker capability; the real client's asynchronous source
    // preparation remains pending until this controlled parser test disposes it.
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { postMessage() {} terminate() {} } });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor); else delete globalThis.Worker; });
  }
  let time = 0, state, id = 0;
  const tasks = new Map(), durations = [], publications = [];
  // Charge real LR advances, including the measured 1.3 ms stopped-tree return.
  // Reads of now() are free: the last nonpreemptible step must fit too.
  guarded.parser.startParse = function (...args) {
    time += .2;
    const parse = start.apply(this, args), advance = parse.advance.bind(parse);
    parse.advance = () => { const tree = advance(); time += tree ? (parse.stoppedAt === 3000 ? viewportFinalization : 1.3) : stepCost; return tree; };
    return parse;
  };
  const owner = createCooperativeParser(guarded.parser, { adapter: worker ? adapter : null, now: () => time, requestFrame: null,
    schedule(fn) { tasks.set(++id, fn); return id; }, cancel: id => tasks.delete(id),
    notify() { ensureSyntaxTree(state, state.doc.length, 0); publications.push(ensureSyntaxTree(state, 0, 0).length); },
  });
  t.after(() => owner.dispose());
  state = EditorState.create({ doc: "$a$\n" + "x".repeat(256) + "{x} ".repeat(10000), extensions: new Language(guarded.data, owner.parser) });
  const initialMs = time;
  owner.commit(state.doc, 0);
  return { owner, state, initialMs, now: () => time, syntaxTree, syntaxTreeAvailable, durations, publications,
    drain() {
      for (let turns = 0; tasks.size; turns++) {
        assert.ok(turns < 10000);
        const [id, fn] = tasks.entries().next().value; tasks.delete(id);
        const before = time; fn();
        if (fn.name === "parseChunk") { time += .2; durations.push(time - before); }
      }
    },
  };
}

test("initial prefix reserves stopped finalization inside the actual 5 ms ceiling", async t => {
  const f = await parserFixture(t);
  t.diagnostic(`initial construction including stopped finalization: ${f.initialMs} ms`);
  assert.ok(f.initialMs <= 5, `initial construction spent ${f.initialMs} ms`);
  assert.equal(f.syntaxTree(f.state).resolveInner(1, 1).name, "MathText");
  assert.equal(f.syntaxTreeAvailable(f.state, 3), true);
  assert.equal(f.syntaxTreeAvailable(f.state), false);
});

test("viewport stopped-tree finalization gets headroom after parsing reaches its boundary", async t => {
  const f = await parserFixture(t, { worker: true, viewportFinalization: 3.7, stepCost: .4 });
  f.drain();
  assert.equal(f.syntaxTreeAvailable(f.state, 3000), true);
  assert.equal(f.syntaxTreeAvailable(f.state), false, "only the Worker may complete this document");
  const maximum = Math.max(...f.durations);
  t.diagnostic(`3.7 ms real stopped-return charge; max scheduled parse ${maximum} ms`);
  assert.ok(maximum <= 5, `known finalization appended to spent parse work: ${maximum} ms`);
});

test("cold viewport publications bound newly exposed syntax while the full Worker is pending", async t => {
  const f = await parserFixture(t, { worker: true }), initial = f.syntaxTree(f.state).length;
  f.drain();
  assert.equal(f.syntaxTreeAvailable(f.state, 3000), true);
  assert.equal(f.syntaxTreeAvailable(f.state), false);
  const sizes = [initial, ...f.publications];
  const maximum = Math.max(...sizes.slice(1).map((length, i) => length - sizes[i]));
  t.diagnostic(`real published tree lengths: ${sizes.join(", ")}`);
  assert.ok(maximum <= 768, `one notification exposed ${maximum} new units of dense syntax`);
});

test("scheduled parsing reserves its last LR step and bookkeeping inside 5 ms", async t => {
  const f = await parserFixture(t);
  f.drain();
  assert.equal(f.syntaxTreeAvailable(f.state), true);
  const maximum = Math.max(...f.durations);
  t.diagnostic(`${f.durations.length} real continuation turns; max ${maximum} ms`);
  assert.ok(maximum <= 5, `scheduled parse spent ${maximum} ms`);
});

test("bounded queries leave headroom inside their unchanged 5 ms allowance", async t => {
  const f = await parserFixture(t), start = f.now();
  f.owner.query(f.state.doc, f.state.doc.length, 5);
  const elapsed = f.now() - start + .2;
  t.diagnostic(`query plus caller bookkeeping: ${elapsed} ms`);
  assert.ok(elapsed <= 5, `query spent ${elapsed} ms`);
  f.drain();
  assert.equal(f.syntaxTreeAvailable(f.state), true);
});

test("summary turns reserve last bounded step and task-finalization headroom inside 8 ms", async t => {
  const { EditorState } = await import("@codemirror/state");
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createLanguageState } = await import("../public/iris-language-state.mjs");
  const adapter = await loadLanguage("tex"), tasks = new Map(), durations = [];
  let work = 0, id = 0, publications = 0;
  const owner = createLanguageState({ ...adapter, *summarySteps(tree, doc) {
    const data = yield* adapter.summarySteps(tree, doc);
    for (let i = 0; i < 30; i++) { work += 1.1; yield; }
    return data;
  } }, () => { publications++; work += 4; }, { now: () => work,
    schedule(fn) { tasks.set(++id, fn); return id; }, cancel: id => tasks.delete(id),
  });
  t.after(() => owner.dispose());
  const state = EditorState.create({ doc: "\\section{Headroom}", extensions: owner.extension });
  owner.update(state);
  for (let turns = 0; tasks.size; turns++) {
    assert.ok(turns < 1000);
    const [id, fn] = tasks.entries().next().value; tasks.delete(id);
    const before = work; fn();
    // A small real-world pause can occur after the loop's final clock check.
    work += 1.3; durations.push(work - before);
  }
  assert.equal(publications, 1);
  assert.deepEqual(owner.read(state).outline.map(item => item.title), ["Headroom"]);
  const maximum = Math.max(...durations);
  t.diagnostic(`${durations.length} application turns; max ${maximum} ms`);
  assert.ok(maximum <= 8, `application turn spent ${maximum} ms`);
});
