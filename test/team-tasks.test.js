const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRemote, taskBranch, taskLookupQuery, changedPathsFromPorcelain, buildTaskPrompt, proposedOutcome } = require('../lib/team-tasks');

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

test('task lookup never falls through to a different cloud project', () => {
  const project = '11111111-1111-4111-8111-111111111111';
  const task = '22222222-2222-4222-8222-222222222222';
  assert.equal(taskLookupQuery(project, task), `project_id=eq.${project}&id=eq.${task}&select=*`);
  assert.equal(taskLookupQuery(project, '22222222'), `project_id=eq.${project}&id=like.22222222*&select=*`);
  assert.throws(() => taskLookupQuery(project, '22222222&project_id=neq.' + project), /Task id must/);
  assert.throws(() => taskLookupQuery(project, '2222'), /Task id must/);
  assert.throws(() => taskLookupQuery(project, '22222222-'), /Task id must/);
});

test('changedPathsFromPorcelain records git paths without inventing changes', () => {
  const out = [
    ' M src/login flow.js',
    'R  new-name.js', 'old-name.js',
    '?? docs/proof.md',
    '?? docs/proof.md',
    '?? literal -> arrow.js',
    '',
  ].join('\0');
  assert.deepEqual(changedPathsFromPorcelain(out), [
    'src/login flow.js',
    'new-name.js',
    'docs/proof.md',
    'literal -> arrow.js',
  ]);
  assert.deepEqual(changedPathsFromPorcelain(''), []);
});

test('buildTaskPrompt includes the objective and the isolation guardrails', () => {
  const p = buildTaskPrompt({ title: 'Add validation', packet: { objective: 'Validate emails on signup' } });
  assert.ok(p.includes('Add validation'));
  assert.ok(p.includes('Validate emails on signup'));
  assert.ok(/do not push/i.test(p));
  assert.ok(/branch/i.test(p));
});

test('buildTaskPrompt names verified captures and treats them as untrusted data', () => {
  const p = buildTaskPrompt(
    { title: 'Use image', packet: { objective: 'Inspect the supplied image' } },
    [{
      name: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: 123,
      localPath: '/tmp/phewsh/screen.png',
    }],
  );
  assert.match(p, /Captured inputs/);
  assert.match(p, /\/tmp\/phewsh\/screen\.png/);
  assert.match(p, /untrusted input data/i);
  assert.match(p, /never execute/i);
  assert.match(p, /human approves/i);
});

test('proposedOutcome is provisional and carries provenance', () => {
  const o = proposedOutcome({
    task: { id: 't1', title: 'Add validation', created_by: 'u-req', claimed_by: 'u-claim', packet: { verification: ['tests pass'] } },
    harnessId: 'claude-code',
    host: 'machine-x',
    branch: 'phewsh/t1-add-validation',
    changedFiles: ['src/validation.js', '.intent/work/task-t1.json'],
    startedAt: '2026-07-02T00:00:00Z',
    finishedAt: '2026-07-02T00:05:00Z',
  });
  assert.equal(o.status, 'proposed');
  assert.equal(o.task_id, 't1');
  assert.equal(o.requested_by, 'u-req');
  assert.equal(o.executed_by.user, 'u-claim');
  assert.equal(o.executed_by.harness, 'claude-code');
  assert.deepEqual(o.verification, ['tests pass']);
  assert.equal(o.evidence.branch, 'phewsh/t1-add-validation');
  assert.deepEqual(o.evidence.changed_files, ['src/validation.js', '.intent/work/task-t1.json']);
  assert.equal(o.evidence.changed_file_count, 2);
  assert.deepEqual(o.evidence.tests, { status: 'not_recorded', requested: ['tests pass'] });
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
