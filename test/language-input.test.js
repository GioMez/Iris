const test = require("node:test");
const assert = require("node:assert/strict");
const { generateFixture } = require("./helpers/language-fixtures.cjs");

for (const kind of ["tex", "ly"]) test(`guarded ${kind} parsing bounds random input seeks while preserving UTF-16 nodes`, async () => {
  const { loadLanguage } = await import("../public/iris-language-service.mjs");
  const { createGuardedLanguage } = await import("../public/iris-language-state.mjs");
  const adapter = await loadLanguage(kind), source = generateFixture(kind, 32 * 1024).source;
  let position = 0, travel = 0, largestRead = 0;
  // Same public Input contract as CM DocInput: chunks are lines; a backwards
  // cursor seek traverses the intervening document. Context reductions revisit
  // openers, then return to the token, repeatedly on long enclosing scopes.
  const input = { length: source.length, lineChunks: true,
    chunk(pos) {
      travel += Math.abs(pos - position); position = pos;
      const end = source.indexOf("\n", pos);
      return source.slice(pos, end < 0 ? source.length : end === pos ? pos + 1 : end);
    },
    read(from, to) { largestRead = Math.max(largestRead, to - from); return source.slice(from, to); },
  };
  const actual = createGuardedLanguage(adapter).parser.parse(input);
  const nodes = tree => { const out = []; tree.iterate({ enter: n => out.push([n.name, n.from, n.to]) }); return out; };
  assert.deepEqual(nodes(actual), nodes(adapter.language.parser.parse(source)));
  assert.ok(travel < source.length * 20, `cursor travel ${travel} for ${source.length} code units`);
  assert.ok(largestRead <= 4096, `bounded input windows, observed ${largestRead}`);
});
