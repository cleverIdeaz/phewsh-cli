const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRemote, taskBranch, buildTaskPrompt, proposedOutcome } = require('../lib/team-tasks');

test('normalizeRemote handles ssh, https, .git, and case', () => {
  assert.equal(normalizeRemote('git@github.com:Owner/Repo.git'), 'github.com/owner/repo');
  assert.equal(normalizeRemote('https://github.com/owner/repo.git'), 'github.com/owner/repo');
  assert.equal(normalizeRemote('https://github.com/owner/repo'), 'github.com/owner/repo');
  assert.equal(normalizeRemote('github.com/owner/repo'), 'github.com/owner/repo');
  assert.equal(normalizeRemote('ssh://git@github.com/owner/repo.git'), 'github.com/owner/repo');
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote(null), null);
});

test('taskBranch is deterministic, slugged, and capped', () => {
  const id = 'a1b2c3d4-0000-0000-0000-000000000000';
  assert.equal(taskBranch(id, 'Fix the Login Bug!'), 'phewsh/a1b2c3d4-fix-the-login-bug');
  assert.equal(taskBranch(id, 'Fix the Login Bug!'), taskBranch(id, 'Fix the Login Bug!'));
  const long = taskBranch(id, 'x'.repeat(200));
  assert.ok(long.length <= 'phewsh/a1b2c3d4-'.length + 40, `too long: ${long.length}`);
  assert.equal(taskBranch(id, '???'), 'phewsh/a1b2c3d4-task');
});

test('buildTaskPrompt includes the objective and the isolation guardrails', () => {
  const p = buildTaskPrompt({ title: 'Add validation', packet: { objective: 'Validate emails on signup' } });
  assert.ok(p.includes('Add validation'));
  assert.ok(p.includes('Validate emails on signup'));
  assert.ok(/do not push/i.test(p));
  assert.ok(/branch/i.test(p));
});

test('proposedOutcome is provisional and carries provenance', () => {
  const o = proposedOutcome({
    task: { id: 't1', title: 'Add validation', created_by: 'u-req', claimed_by: 'u-claim', packet: { verification: ['tests pass'] } },
    harnessId: 'claude-code',
    host: 'machine-x',
    startedAt: '2026-07-02T00:00:00Z',
    finishedAt: '2026-07-02T00:05:00Z',
  });
  assert.equal(o.status, 'proposed');
  assert.equal(o.task_id, 't1');
  assert.equal(o.requested_by, 'u-req');
  assert.equal(o.executed_by.user, 'u-claim');
  assert.equal(o.executed_by.harness, 'claude-code');
  assert.deepEqual(o.verification, ['tests pass']);
  assert.ok(o.note.includes('merge'), 'must explain it becomes authoritative only on merge');
});

test('dispatch maps to task verbs without a second architecture', () => {
  const { dispatchToTaskArgs } = require('../commands/task');
  assert.deepEqual(dispatchToTaskArgs([]), ['list']);
  assert.deepEqual(dispatchToTaskArgs(['a1b2c3d4']), ['claim', 'a1b2c3d4']);
  assert.deepEqual(dispatchToTaskArgs(['next', '--via', 'codex']), ['claim', 'next', '--via', 'codex']);
  assert.deepEqual(dispatchToTaskArgs(['fix the login flow']), ['new', 'fix the login flow']);
  assert.deepEqual(dispatchToTaskArgs(['write', 'homepage', 'copy']), ['new', 'write', 'homepage', 'copy']);
});
