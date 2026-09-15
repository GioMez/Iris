const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROLE_NAMES } = require('./helpers/language-fixtures.cjs');

test('semantic highlighter returns bare names for all 23 source roles', async () => {
  const { syntaxTags, roleHighlighter, bibliographyTokenTable } = await import('../public/iris-syntax-style.mjs');
  const roles = ROLE_NAMES.filter(role => role !== 'text');
  assert.deepEqual(roles.map(role => roleHighlighter.style([syntaxTags[role]])), roles,
    'semantic consumers receive raw roles without CSS prefixes or compatibility aliases');
  for (const tag of Object.values(bibliographyTokenTable)) {
    assert.equal(roleHighlighter.style([tag]), null, 'bibliography tags do not masquerade as source roles');
  }
});

test('CSS highlighter and editor extension preserve source classes and bibliography aliases', async () => {
  assert.ok(fs.existsSync(path.join(__dirname, '../public/iris-syntax-style.mjs')), 'shared syntax style module exists');
  const style = await import('../public/iris-syntax-style.mjs');
  const { Tag } = await import('@lezer/highlight');
  const { EditorState } = await import('@codemirror/state');
  const { highlightingFor } = await import('@codemirror/language');
  const { syntaxTags, syntaxClasses, legacyTokenTable, bibliographyTokenTable, cssHighlighter, syntaxExtension } = style;
  const roles = ROLE_NAMES.filter(role => role !== 'text');
  assert.deepEqual(Object.keys(syntaxTags).sort(), [...roles].sort());
  assert.equal(new Set(Object.values(syntaxTags)).size, roles.length, 'different roles can be recolored independently');
  const state = EditorState.create({ extensions: [syntaxExtension] });
  const compatibility = { command: ' t-cmd', environment: ' t-env', delimiter: ' t-brace', operator: ' t-special' };
  for (const role of roles) {
    assert.ok(syntaxTags[role] instanceof Tag, 'tags use the installed native ESM graph');
    const expected = `t-${role}${compatibility[role] || ''}`;
    assert.equal(cssHighlighter.style([syntaxTags[role]]), expected, role);
    assert.equal(highlightingFor(state, [syntaxTags[role]]), expected, 'editor installs CSS output');
    assert.equal(syntaxClasses[role], expected);
  }
  for (const [token, expected] of Object.entries({ entryType: 't-bib-entry-type t-cmd', key: 't-bib-key t-env',
    field: 't-bib-field t-special', value: 't-bib-value t-math', comment: 't-bib-comment t-comment',
    brace: 't-bib-delimiter t-brace', special: 't-bib-operator t-special' })) {
    assert.equal(cssHighlighter.style([bibliographyTokenTable[token]]), expected, token);
    assert.equal(highlightingFor(state, [bibliographyTokenTable[token]]), expected, 'editor retains bibliography CSS output');
  }
  for (const [token, role] of Object.entries({ cmd: 'command', env: 'environment', brace: 'delimiter', math: 'math',
    comment: 'comment', special: 'operator', string: 'string' })) assert.equal(legacyTokenTable[token], syntaxTags[role]);
  for (const token of ['comment', 'brace', 'special']) {
    assert.notEqual(bibliographyTokenTable[token], legacyTokenTable[token], `${token} preserves bibliography paint independently`);
  }
  assert.equal((await import('../public/iris-syntax-style.mjs')).syntaxTags, syntaxTags, 'imports share one set of tags');
});
