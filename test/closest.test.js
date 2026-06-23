// Tests for the did-you-mean nearest-command matcher.

const { test } = require('node:test');
const assert = require('node:assert');
const { closest, levenshtein } = require('../lib/closest');

const CMDS = ['quit', 'help', 'init', 'intent', 'clarify', 'council', 'use',
  'work', 'run', 'clear', 'status', 'outcomes', 'context', 'gate', 'seq',
  'next', 'watch', 'login', 'model', 'push', 'pull', 'serve'];

test('levenshtein basics', () => {
  assert.equal(levenshtein('clarify', 'clarify'), 0);
  assert.equal(levenshtein('claify', 'clarify'), 1);
  assert.equal(levenshtein('', 'abc'), 3);
});

test('prefix abbreviation resolves to the command', () => {
  assert.equal(closest('cla', CMDS), 'clarify');
  assert.equal(closest('coun', CMDS), 'council');
  assert.equal(closest('out', CMDS), 'outcomes');
});

test('prefix prefers the shortest matching command', () => {
  // both 'context' and 'council'/'clarify' — 'con' only prefixes 'context'/'council'
  assert.equal(closest('cont', CMDS), 'context');
});

test('typo within edit distance suggests the fix', () => {
  assert.equal(closest('claify', CMDS), 'clarify');
  assert.equal(closest('outcoems', CMDS), 'outcomes');
  assert.equal(closest('hepl', CMDS), 'help');
});

test('garbage returns null (no false suggestion)', () => {
  assert.equal(closest('zxcvbnm', CMDS), null);
  assert.equal(closest('flibbertigibbet', CMDS), null);
});

test('very short noise does not latch onto everything', () => {
  // single char shouldn't confidently map to a multi-char command
  const r = closest('x', CMDS);
  assert.ok(r === null, `expected null, got ${r}`);
});

test('empty / missing inputs are safe', () => {
  assert.equal(closest('', CMDS), null);
  assert.equal(closest('help', []), null);
  assert.equal(closest('help', null), null);
});

test('exact command still returns itself (prefix of itself)', () => {
  assert.equal(closest('seq', CMDS), 'seq');
});
