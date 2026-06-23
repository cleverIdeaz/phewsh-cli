const test = require('node:test');
const assert = require('node:assert/strict');
const { createFailureTracker, createLineDispatcher } = require('../lib/session-input');

test('empty input is a true no-op', async () => {
  const turns = [];
  const dispatcher = createLineDispatcher(async input => turns.push(input));
  dispatcher.push('');
  dispatcher.push('   ');
  await dispatcher.drain();
  assert.deepEqual(turns, []);
});

test('multi-line paste dispatches exactly once', async () => {
  const turns = [];
  const batches = [];
  const dispatcher = createLineDispatcher(
    async input => turns.push(input),
    { onBatch: batch => batches.push(batch) }
  );
  dispatcher.push('first line');
  dispatcher.push('second line');
  dispatcher.push('third line');
  await dispatcher.drain();
  assert.deepEqual(turns, ['first line\nsecond line\nthird line']);
  assert.deepEqual(batches, [{
    input: 'first line\nsecond line\nthird line',
    lines: ['first line', 'second line', 'third line'],
  }]);
});

test('separate input batches execute serially', async () => {
  const turns = [];
  const scheduled = [];
  const dispatcher = createLineDispatcher(async input => {
    turns.push(`start:${input}`);
    await Promise.resolve();
    turns.push(`end:${input}`);
  }, { schedule: fn => scheduled.push(fn) });

  dispatcher.push('one');
  scheduled.shift()();
  dispatcher.push('two');
  scheduled.shift()();
  await dispatcher.drain();

  assert.deepEqual(turns, ['start:one', 'end:one', 'start:two', 'end:two']);
});

test('identical Claude usage failures are classified once', () => {
  const tracker = createFailureTracker();
  const first = tracker.classify('claude-code', 'Claude Code exited 1\nYou have hit your session limit');
  const second = tracker.classify('claude-code', 'Claude Code exited 1\nYou have hit your session limit');
  assert.equal(first.kind, 'usage-limit');
  assert.equal(first.duplicate, false);
  assert.equal(second.kind, 'usage-limit');
  assert.equal(second.duplicate, true);
});

test('non-Claude failures are not suppressed', () => {
  const tracker = createFailureTracker();
  assert.equal(tracker.classify('codex', 'Codex CLI exited 1').duplicate, false);
  assert.equal(tracker.classify('codex', 'Codex CLI exited 1').duplicate, false);
});
