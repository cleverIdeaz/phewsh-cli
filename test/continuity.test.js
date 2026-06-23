// Tests for the cross-tool continuity thread.

const { test } = require('node:test');
const assert = require('node:assert');
const { agoText, threadFor, lastLeftOff, continuityLine, toolsInThread } = require('../lib/continuity');

const NOW = Date.parse('2026-06-13T12:00:00Z');
const decisions = [
  { ts: '2026-06-13T11:55:00Z', project: 'phewsh', route: 'codex', summary: 'add session resume', outcome: null },
  { ts: '2026-06-13T09:00:00Z', project: 'phewsh', route: 'claude-code', summary: 'fix markdown render', outcome: 'kept' },
  { ts: '2026-06-12T12:00:00Z', project: 'phewsh', route: 'codex', summary: 'old thing', outcome: 'kept' },
  { ts: '2026-06-13T08:00:00Z', project: 'other', route: 'gemini', summary: 'unrelated', outcome: null },
];

test('agoText buckets', () => {
  assert.equal(agoText('2026-06-13T11:59:40Z', NOW), 'just now');
  assert.equal(agoText('2026-06-13T11:30:00Z', NOW), '30m ago');
  assert.equal(agoText('2026-06-13T09:00:00Z', NOW), '3h ago');
  assert.equal(agoText('2026-06-11T12:00:00Z', NOW), '2d ago');
  assert.equal(agoText('not-a-date', NOW), '');
});

test('threadFor is project-scoped and newest-first', () => {
  const t = threadFor(decisions, { project: 'phewsh' });
  assert.equal(t.length, 3);
  assert.equal(t[0].summary, 'add session resume');
  assert.equal(t[2].summary, 'old thing');
});

test('lastLeftOff returns the most recent action', () => {
  const last = lastLeftOff(decisions, { project: 'phewsh' });
  assert.equal(last.summary, 'add session resume');
  assert.equal(last.route, 'codex');
});

test('continuityLine reads like picking up where you left off', () => {
  const line = continuityLine(decisions, { project: 'phewsh', now: NOW });
  assert.match(line, /add session resume/);
  assert.match(line, /via Codex/);
  assert.match(line, /5m ago/);
});

test('continuityLine truncates long summaries', () => {
  const long = [{ ts: '2026-06-13T11:59:00Z', project: 'p', route: 'codex', summary: 'x'.repeat(200) }];
  const line = continuityLine(long, { project: 'p', now: NOW });
  assert.ok(line.includes('…'));
  assert.ok(line.length < 90);
});

test('toolsInThread counts distinct tools — the across-tools proof', () => {
  assert.equal(toolsInThread(decisions, { project: 'phewsh' }), 2); // codex + claude-code
});

test('empty / missing data is safe', () => {
  assert.equal(lastLeftOff([], { project: 'x' }), null);
  assert.equal(continuityLine(null, { project: 'x' }), null);
  assert.equal(toolsInThread(undefined), 0);
});
