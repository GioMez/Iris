const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROLE_NAMES } = require('./helpers/language-fixtures.cjs');

function boot({ stored = null, dark = false, blocked = false } = {}) {
  const file = path.resolve(__dirname, '../public/iris-theme.js');
  assert.ok(fs.existsSync(file), 'standalone synchronous theme module exists');
  const listeners = [];
  const media = { matches: dark, addEventListener(type, listener) {
    assert.equal(type, 'change'); listeners.push(listener);
  } };
  const root = { dataset: {}, style: {} };
  const storage = { getItem(key) { assert.equal(key, 'iris_theme'); if (blocked) throw Error('blocked'); return stored; },
    setItem(key, value) { assert.equal(key, 'iris_theme'); if (blocked) throw Error('blocked'); stored = value; } };
  const window = { matchMedia(query) { assert.equal(query, '(prefers-color-scheme: dark)'); return media; },
    get localStorage() { if (blocked) throw Error('blocked'); return storage; } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window, document: { documentElement: root } });
  return { api: window.IrisTheme, root, stored: () => stored, listeners,
    os(value) { media.matches = value; listeners.forEach(listener => listener({ matches: value })); } };
}

for (const dark of [false, true]) for (const stored of [null, 'invalid', '', 'system']) {
  test(`initial system resolution without body: OS dark=${dark}, stored=${JSON.stringify(stored)}`, () => {
    const b = boot({ dark, stored });
    assert.equal(b.api.preference(), 'system');
    assert.equal(b.api.resolved(), dark ? 'dark' : 'light');
    assert.equal(b.root.dataset.theme, dark ? 'dark' : 'light');
    assert.equal(b.root.style.colorScheme, dark ? 'dark' : 'light');
    assert.equal(b.listeners.length, 1);
    b.os(!dark);
    assert.equal(b.root.dataset.theme, dark ? 'light' : 'dark');
  });
}
for (const preference of ['dark', 'light']) test(`manual ${preference} persists and ignores live OS until returning to system`, () => {
  const b = boot({ stored: preference, dark: preference === 'light' });
  assert.equal(b.api.resolved(), preference);
  b.os(false); b.os(true);
  assert.equal(b.root.dataset.theme, preference);
  b.api.setPreference(preference === 'dark' ? 'light' : 'dark');
  assert.equal(b.stored(), preference === 'dark' ? 'light' : 'dark');
  assert.equal(boot({ stored: b.stored() }).api.resolved(), b.stored());
  b.api.setPreference('system');
  assert.equal(b.api.resolved(), 'dark');
  b.os(false);
  assert.equal(b.api.resolved(), 'light');
  assert.equal(b.stored(), 'system');
  assert.equal(b.listeners.length, 1);
});
test('invalid setters normalize to system and apply immediately', () => {
  const b = boot();
  for (const value of [undefined, null, '', 'DARK', {}, 1]) {
    b.api.setPreference('dark'); b.api.setPreference(value);
    assert.equal(b.api.preference(), 'system');
    assert.equal(b.root.dataset.theme, 'light');
    assert.equal(b.stored(), 'system');
  }
});
test('inaccessible storage retains manual choice in memory and keeps OS following usable', () => {
  const b = boot({ blocked: true });
  assert.equal(b.api.preference(), 'system');
  b.api.setPreference('dark'); b.os(false);
  assert.equal(b.api.preference(), 'dark');
  assert.equal(b.root.dataset.theme, 'dark');
  b.api.setPreference('system');
  assert.equal(b.root.dataset.theme, 'light');
  b.os(true);
  assert.equal(b.root.dataset.theme, 'dark');
});

test('light palette keeps all syntax readable on selections and UI text on its surfaces', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../public/iris.css'), 'utf8');
  const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(light, 'light palette exists');
  const declarations = Object.fromEntries([...`${css.match(/:root\s*\{([^}]+)\}/)[1]}${light}`.matchAll(/--([\w-]+):\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value]));
  function value(name) {
    const raw = declarations[name], alias = raw?.match(/^var\(--([\w-]+)\)$/);
    if (alias) return value(alias[1]);
    assert.match(raw, /^#[\da-f]{6}$/i, name);
    return raw;
  }
  function luminance(hex) {
    return hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  }
  const failures = [];
  function check(fg, bg, minimum = 4.5) {
    const a = luminance(value(fg)), b = luminance(value(bg));
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    if (ratio < minimum) failures.push(`${fg} on ${bg}: ${ratio}`);
  }
  for (const role of ['command', 'environment', 'bracket', 'argument', 'math', 'comment', 'text', 'special', 'number']) {
    for (const bg of ['editor-bg', 'editor-selection', 'editor-selection-idle']) check(`syntax-${role}`, bg);
  }
  for (const fg of ['txt', 'txt-dim', 'txt-mut', 'semantic-success', 'semantic-danger', 'semantic-warning', 'semantic-info']) {
    for (const bg of ['bg', 'panel', 'panel-2', 'topbar', 'toast-bg', 'number-field-bg']) check(fg, bg);
  }
  for (const [fg, bg, minimum] of [['on-accent', 'accent', 4.5], ['on-accent', 'accent-press', 4.5],
    ['on-danger', 'semantic-danger', 4.5], ['switch-thumb', 'switch-track', 3], ['switch-compact-thumb', 'switch-compact-track', 3]]) check(fg, bg, minimum);
  assert.deepEqual(failures, []);
});

for (const theme of ['dark', 'light']) test(`${theme} full semantic syntax palette separates roles and qualifies selections`, (t) => {
  const css = fs.readFileSync(path.resolve(__dirname, '../public/iris.css'), 'utf8');
  const root = css.match(/:root\s*\{([^}]+)\}/)[1];
  const light = css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)[1];
  const declarations = Object.fromEntries([...`${root}${theme === 'light' ? light : ''}`.matchAll(/--([\w-]+):\s*([^;]+);/g)]
    .map(([, name, value]) => [name, value]));
  function value(name) {
    const raw = declarations[name], alias = raw?.match(/^var\(--([\w-]+)\)$/);
    if (alias) return value(alias[1]);
    assert.match(raw || '', /^#[\da-f]{6}$/i, `${theme} ${name} has a concrete palette foreground`);
    return raw;
  }
  function luminance(hex) {
    return hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  }
  const samples = [];
  const backgrounds = ['editor-bg', 'editor-selection', 'editor-selection-idle'].map(name => [name, value(name)]);
  // A peer caret line can tint local selection even without a peer range.
  const peerAlpha = Number(css.match(/\.cm-host \.cm-iris-peer-line\{[^}]*var\(--peer-color\)\s+(\d+)%/)[1]) / 100;
  for (const selection of ['editor-selection', 'editor-selection-idle']) {
    for (const peer of ['#ffffff', '#9ece6a', '#7aa2f7', '#f7768e', '#e0af68', '#bb9af7', '#2ac3de', '#ff9e64', '#b4f9f8', value('peer-fallback')]) {
      const rgb = hex => hex.slice(1).match(/../g).map(v => parseInt(v, 16));
      const mixed = rgb(value(selection)).map((v, i) => Math.round(v * (1 - peerAlpha) + rgb(peer)[i] * peerAlpha));
      backgrounds.push([`${selection} + peer line ${peer}`, '#' + mixed.map(v => v.toString(16).padStart(2, '0')).join('')]);
    }
  }
  for (const role of ROLE_NAMES) for (const [bg, color] of backgrounds) {
    const a = luminance(value(`syntax-${role}`)), b = luminance(color);
    samples.push({ role, bg, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
  }
  assert.deepEqual(samples.filter(s => s.ratio < 4.5), []);
  for (const [a, b] of [['command', 'text'], ['comment', 'delimiter'], ['string', 'environment']]) {
    const rgb = role => value(`syntax-${role}`).slice(1).match(/../g).map(v => parseInt(v, 16));
    assert.ok(Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i])) >= 40, `${a}/${b} must be visibly separated`);
  }
  const comment = luminance(value('syntax-comment')), delimiter = luminance(value('syntax-delimiter'));
  assert.ok(theme === 'dark' ? delimiter > comment : delimiter < comment, 'delimiters are more prominent than comments');
  t.diagnostic(`HP02 ${theme} minimum base/selection contrast: ${Math.min(...samples.filter(s => !s.bg.includes(' + ')).map(s => s.ratio)).toFixed(3)}:1; including peer caret line: ${Math.min(...samples.map(s => s.ratio)).toFixed(3)}:1`);
});
