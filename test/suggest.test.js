// Tests for the self-aware guidance engine.

const { test } = require('node:test');
const assert = require('node:assert');
const { suggest, suggestAll } = require('../lib/suggest');

test('quiet at rest — no triggers, no suggestions', () => {
  assert.equal(suggest({ intentFileCount: 3, turnsThisSession: 0 }), null);
});

test('capture-intent fires after 1 turn with no intent', () => {
  const s = suggest({ intentFileCount: 0, turnsThisSession: 1 });
  assert.equal(s.id, 'capture-intent');
  assert.equal(s.command, '/clarify');
});

test('capture-intent does NOT fire before any real turn', () => {
  const all = suggestAll({ intentFileCount: 0, turnsThisSession: 0 });
  assert.ok(!all.find(x => x.id === 'capture-intent'));
});

test('capture-intent suppressed once intent exists', () => {
  const all = suggestAll({ intentFileCount: 2, turnsThisSession: 9 });
  assert.ok(!all.find(x => x.id === 'capture-intent'));
});

test('label-outcomes fires at 3 pending', () => {
  const all = suggestAll({ intentFileCount: 1, pendingOutcomes: 3 });
  assert.ok(all.find(x => x.id === 'label-outcomes'));
});

test('label-outcomes silent below threshold', () => {
  const all = suggestAll({ intentFileCount: 1, pendingOutcomes: 2 });
  assert.ok(!all.find(x => x.id === 'label-outcomes'));
});

test('intent-behind-code fires when commits outpace .intent/', () => {
  const all = suggestAll({ hasIntentDir: true, intentFileCount: 3, commitsSinceIntent: 5 });
  const s = all.find(x => x.id === 'intent-behind-code');
  assert.ok(s);
  assert.equal(s.command, '/wrap');
});

test('intent-behind-code silent below 3 commits or without .intent/', () => {
  assert.ok(!suggestAll({ hasIntentDir: true, commitsSinceIntent: 2 }).find(x => x.id === 'intent-behind-code'));
  assert.ok(!suggestAll({ hasIntentDir: false, commitsSinceIntent: 9 }).find(x => x.id === 'intent-behind-code'));
});

test('capture-intent outranks label-outcomes', () => {
  const top = suggest({ intentFileCount: 0, turnsThisSession: 5, pendingOutcomes: 9 });
  assert.equal(top.id, 'capture-intent');
});

test('resync fires on drift, not without an .intent/', () => {
  assert.ok(suggestAll({ hasIntentDir: true, intentFileCount: 1, seqStale: true }).find(x => x.id === 'resync-harness-context'));
  assert.ok(!suggestAll({ hasIntentDir: false, seqStale: true }).find(x => x.id === 'resync-harness-context'));
});

test('council suggested only with 2+ harnesses and some history', () => {
  const fire = suggestAll({ intentFileCount: 1, installedHarnesses: ['claude-code', 'codex'], route: 'claude-code', turnsThisSession: 3 });
  assert.ok(fire.find(x => x.id === 'try-council'));
  const quiet = suggestAll({ intentFileCount: 1, installedHarnesses: ['claude-code'], route: 'claude-code', turnsThisSession: 9 });
  assert.ok(!quiet.find(x => x.id === 'try-council'));
});

test('enable-ambient fires for any installed harness when ambient is off', () => {
  // Claude Code off → suggest (it gets the live hook).
  assert.ok(suggestAll({ hasIntentDir: true, intentFileCount: 1, ambientOn: false, installedHarnesses: ['claude-code'] }).find(x => x.id === 'enable-ambient'));
  // Ambient already on → never suggest.
  assert.ok(!suggestAll({ hasIntentDir: true, intentFileCount: 1, ambientOn: true, installedHarnesses: ['claude-code'] }).find(x => x.id === 'enable-ambient'));
  // Non-Claude tool off → NOW suggest too: it benefits via synced + global base files.
  assert.ok(suggestAll({ hasIntentDir: true, intentFileCount: 1, ambientOn: false, installedHarnesses: ['codex'] }).find(x => x.id === 'enable-ambient'));
  // No tools installed → nothing to enhance, stay quiet.
  assert.ok(!suggestAll({ hasIntentDir: true, intentFileCount: 1, ambientOn: false, installedHarnesses: [] }).find(x => x.id === 'enable-ambient'));
});

test('prefer-best-route fires when the record has a clear favorite elsewhere', () => {
  const all = suggestAll({
    intentFileCount: 2, route: 'claude-code',
    bestKeeper: { route: 'codex', label: 'Codex', keptRate: 0.8, total: 10 },
  });
  const s = all.find((x) => x.id === 'prefer-best-route');
  assert.ok(s);
  assert.equal(s.command, '/use codex');
  assert.match(s.message, /Codex keeps best/);
});

test('prefer-best-route stays quiet when already on the best route or thin data', () => {
  assert.ok(!suggestAll({ intentFileCount: 2, route: 'codex', bestKeeper: { route: 'codex', label: 'Codex', keptRate: 0.8, total: 10 } }).find((x) => x.id === 'prefer-best-route'));
  assert.ok(!suggestAll({ intentFileCount: 2, route: 'claude-code', bestKeeper: { route: 'codex', label: 'Codex', keptRate: 0.8, total: 2 } }).find((x) => x.id === 'prefer-best-route'));
  assert.ok(!suggestAll({ intentFileCount: 2, route: 'claude-code', bestKeeper: { route: 'codex', label: 'Codex', keptRate: 0.4, total: 10 } }).find((x) => x.id === 'prefer-best-route'));
});

test('every suggestion carries a command and a why', () => {
  const all = suggestAll({
    intentFileCount: 0, turnsThisSession: 5, pendingOutcomes: 5,
    hasIntentDir: true, seqStale: true,
    installedHarnesses: ['claude-code', 'codex'], route: 'claude-code', ambientOn: false,
  });
  assert.ok(all.length >= 3);
  for (const s of all) {
    assert.ok(s.command && s.command.length, `${s.id} has a command`);
    assert.ok(s.why && s.why.length, `${s.id} has a why`);
    assert.ok(s.message && s.message.length, `${s.id} has a message`);
  }
});
