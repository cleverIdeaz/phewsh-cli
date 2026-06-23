// Tests for recall — warning before you repeat a reverted/failed decision.

const { test } = require('node:test');
const assert = require('node:assert');
const { similarity, recallSimilar, closestRegret } = require('../lib/recall');

const decisions = [
  { ts: '2026-06-10T10:00:00Z', project: 'p', route: 'codex', summary: 'add a dark mode toggle to settings', outcome: 'reverted' },
  { ts: '2026-06-11T10:00:00Z', project: 'p', route: 'claude-code', summary: 'rewrite the auth flow with oauth', outcome: 'kept' },
  { ts: '2026-06-12T10:00:00Z', project: 'p', route: 'gemini', summary: 'migrate database to postgres', outcome: 'failed' },
  { ts: '2026-06-09T10:00:00Z', project: 'other', route: 'codex', summary: 'dark mode toggle settings page', outcome: 'reverted' },
];

test('similarity matches intent, not exact strings', () => {
  assert.ok(similarity('build the dark-mode switch in settings', 'add a dark mode toggle to settings') > 0.4);
  assert.equal(similarity('completely unrelated thing', 'add a dark mode toggle'), 0);
});

test('recallSimilar surfaces only reverted/failed matches', () => {
  const hits = recallSimilar(decisions, 'add dark mode toggle', { project: 'p' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].outcome, 'reverted');
  assert.match(hits[0].summary, /dark mode/);
});

test('kept decisions never trigger a warning', () => {
  const hits = recallSimilar(decisions, 'rewrite the auth flow with oauth', { project: 'p' });
  assert.equal(hits.length, 0);
});

test('failed decisions do trigger', () => {
  const hits = recallSimilar(decisions, 'migrate the database to postgres now', { project: 'p' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].outcome, 'failed');
});

test('project scoping isolates the thread', () => {
  const hits = recallSimilar(decisions, 'dark mode toggle', { project: 'other' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].project, 'other');
});

test('closestRegret returns the single best, or null', () => {
  assert.ok(closestRegret(decisions, 'dark mode toggle', { project: 'p' }));
  assert.equal(closestRegret(decisions, 'something totally new and different', { project: 'p' }), null);
});

test('below-threshold similarity does not warn', () => {
  // one weak shared token shouldn't cross 0.5
  assert.equal(closestRegret(decisions, 'add a settings page for notifications', { project: 'p', minSimilarity: 0.5 }), null);
});
