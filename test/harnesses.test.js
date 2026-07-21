const test = require('node:test');
const assert = require('node:assert/strict');
const { HARNESSES, interactiveLaunchArgs } = require('../lib/harnesses');

test('core harnesses say what they are best for without owning model lists', () => {
  assert.match(HARNESSES['claude-code'].bestFor, /repo edits/);
  assert.match(HARNESSES.codex.bestFor, /reviews/);
  assert.match(HARNESSES.gemini.bestFor, /broad/);
  assert.match(HARNESSES.kimi.bestFor, /repo work/);
});

test('Kimi Code uses its documented non-interactive prompt and output flags', () => {
  assert.deepEqual(
    HARNESSES.kimi.args('review this change', 'kimi-code/kimi-for-coding'),
    ['-p', 'review this change', '--output-format', 'text', '-m', 'kimi-code/kimi-for-coding']
  );
});

test('Codex can run from directories that are not Git repositories', () => {
  assert.deepEqual(
    HARNESSES.codex.args('hello', undefined),
    ['exec', '--skip-git-repo-check', 'hello']
  );
});

test('Codex keeps the outside-repo flag when a model is selected', () => {
  assert.deepEqual(
    HARNESSES.codex.args('hello', 'gpt-5.5'),
    ['exec', '--skip-git-repo-check', '-m', 'gpt-5.5', 'hello']
  );
});

test('interactive Claude and Codex launches receive the current verified briefing', () => {
  assert.deepEqual(
    interactiveLaunchArgs('claude-code', 'BRIEF', { model: 'sonnet' }),
    { args: ['--append-system-prompt', 'BRIEF', '--model', 'sonnet'], briefingPassed: true }
  );
  assert.deepEqual(
    interactiveLaunchArgs('codex', 'UPDATED BRIEF', { model: 'gpt-5.5' }),
    { args: ['-m', 'gpt-5.5', 'UPDATED BRIEF'], briefingPassed: true }
  );
});

test('unknown interactive briefing support degrades without inventing flags', () => {
  assert.deepEqual(interactiveLaunchArgs('hermes', 'BRIEF'), { args: [], briefingPassed: false });
});

const { test: t2 } = require('node:test');
const assert2 = require('node:assert');
const { resolveHarness } = require('../lib/harnesses');
t2('resolveHarness accepts id, binary, and alias', () => {
  assert2.equal(resolveHarness('claude'), 'claude-code');     // the real binary
  assert2.equal(resolveHarness('claude-code'), 'claude-code'); // canonical id
  assert2.equal(resolveHarness('cursor-agent'), 'cursor');    // binary → id
  assert2.equal(resolveHarness('codex'), 'codex');
  assert2.equal(resolveHarness('kimi'), 'kimi');
  assert2.equal(resolveHarness('nope'), null);
});
