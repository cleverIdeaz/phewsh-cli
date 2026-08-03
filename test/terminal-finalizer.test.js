const { test } = require('node:test');
const assert = require('node:assert/strict');

const { observedChanges, buildRunReceipt } = require('../lib/run-receipt');

// One run, one terminal state, one truthful account of it.
//
// The specific lie this closes: the finalizer substituted empty change arrays
// whenever a tree snapshot was missing, with a comment calling it "no attributed
// changes". Empty arrays are a CLAIM — the receipt renders "no files changed" in
// Ion and in the Record — while a missing snapshot means the engine never looked.
// Those are opposite statements, and only one of them is honest.

test('an unreadable tree is unknown, never "nothing changed"', () => {
  const snapshot = { 'a.txt': { status: ' M', fingerprint: 'x' } };

  assert.equal(observedChanges(null, snapshot), null, 'no before snapshot is unknown');
  assert.equal(observedChanges(snapshot, null), null, 'no after snapshot is unknown');
  assert.equal(observedChanges(null, null), null, 'neither snapshot is unknown');
  assert.equal(observedChanges(undefined, undefined), null);
});

test('two readable snapshots are an observation, even when nothing moved', () => {
  const snapshot = { 'a.txt': { status: ' M', fingerprint: 'x' } };
  const changes = observedChanges(snapshot, snapshot);

  assert.notEqual(changes, null, 'a real observation of no change is not unknown');
  assert.deepEqual(changes.modified, []);
  assert.deepEqual(changes.preExisting, ['a.txt']);
});

test('an empty tree observed twice is an honest "nothing changed"', () => {
  const changes = observedChanges({}, {});
  assert.notEqual(changes, null);
  assert.deepEqual(changes, { preExisting: [], created: [], modified: [], deleted: [] });
});

// The two halves have to stay wired together: `observedChanges` returning null is
// only useful because buildRunReceipt turns null into an explicit unknown.
test('the unknown survives into the receipt as an unknown, not an empty list', () => {
  const base = {
    receiptId: 'r-unknown-1',
    jobId: 'j-1',
    projectId: 'phewsh',
    boundProjectId: 'bound-1',
    boundProjectRemote: 'github.com/example/phewsh',
    runtimeId: 'claude-code',
    runtimeLabel: 'Claude Code',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: 'error',
    output: { bytes: 0, sha256: null },
  };

  const unobserved = buildRunReceipt({ ...base, changes: observedChanges(null, {}) });
  assert.equal(unobserved.changes.observed, false);
  assert.ok(
    unobserved.unknowns.some((u) => /which files changed/i.test(u)),
    'an unobserved tree must become an explicit unknown a person can read',
  );

  const observed = buildRunReceipt({ ...base, changes: observedChanges({}, {}) });
  assert.equal(observed.changes.observed, true);
  assert.ok(
    !observed.unknowns.some((u) => /which files changed/i.test(u)),
    'a real observation must not carry the unknown',
  );
});

test('a failed run still carries its observation, so failure is not silence', () => {
  const changes = observedChanges({}, { 'half-written.txt': { status: '??', fingerprint: 'y' } });
  const receipt = buildRunReceipt({
    receiptId: 'r-failed-1',
    jobId: 'j-2',
    projectId: 'phewsh',
    boundProjectId: 'bound-1',
    boundProjectRemote: 'github.com/example/phewsh',
    runtimeId: 'claude-code',
    runtimeLabel: 'Claude Code',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: 'error',
    changes,
    output: { bytes: 0, sha256: null },
  });

  // A run that failed halfway can still have left a file behind. Reporting the
  // failure without the file is how a dirty tree becomes a surprise later.
  assert.equal(receipt.changes.observed, true);
  assert.deepEqual(receipt.changes.created, ['half-written.txt']);
});
