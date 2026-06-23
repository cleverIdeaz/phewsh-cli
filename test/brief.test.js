const test = require('node:test');
const assert = require('node:assert/strict');
const { formatBrief } = require('../lib/brief');

function report({ dirty = 0, conflict = null } = {}) {
  return {
    auditedAt: '2026-06-15T00:00:00.000Z',
    package: { version: '1.0.0', npmLatest: { status: 'known', version: '1.0.0' } },
    git: {
      available: true,
      shortHead: 'abc12345',
      committedPackageVersion: '1.0.0',
      tracked: Array.from({ length: dirty }, (_, i) => ({ code: ' M', file: `f${i}.js` })),
      untracked: [],
    },
    intent: {
      authoritative: [
        { file: '.intent/next.md', declaredUpdated: '2026-06-15', summary: 'Finish the lifecycle.' },
      ],
    },
    conflicts: conflict ? [conflict] : [],
    unknowns: ['Remote Git was not fetched.'],
    outcomes: { total: 1, judged: 1, pending: 0, recent: [{ route: 'codex', summary: 'prior work', outcome: 'kept' }] },
    receipts: { totalEvents: 1, completed: 1, failed: 0 },
  };
}

test('brief uses verified truth and labels intent as claims', () => {
  const brief = formatBrief(report({ conflict: 'Generated context is stale.' }), { cwd: '/tmp/project' });
  assert.match(brief, /PHEWSH Verified Project Brief/);
  assert.match(brief, /Intent Claims/);
  assert.match(brief, /Conflict: Generated context is stale/);
  assert.match(brief, /generated summaries or model memory/);
});

test('a fresh brief changes when the working state changes before switching tools', () => {
  const first = formatBrief(report({ dirty: 0 }), { cwd: '/tmp/project' });
  const second = formatBrief(report({ dirty: 2 }), { cwd: '/tmp/project' });
  assert.match(first, /Working tree: clean/);
  assert.match(second, /Working tree: 2 changed path\(s\), uncommitted/);
  assert.notEqual(first, second);
});

test('brief carries only accepted success criteria for the current work item', () => {
  const brief = formatBrief(report(), {
    cwd: '/tmp/project',
    task: {
      title: 'Complete the continuity loop',
      state: 'now',
      accepted: [
        { expected: 'all lifecycle checks pass', type: 'measurable' },
        { expected: 'the result feels clear', type: 'human' },
      ],
      proposedCount: 1,
    },
  });
  assert.match(brief, /Current Work Contract/);
  assert.match(brief, /Item: Complete the continuity loop/);
  assert.match(brief, /\[measurable\] all lifecycle checks pass/);
  assert.match(brief, /\[human judgment\] the result feels clear/);
  assert.match(brief, /1 proposed criterion\/criteria omitted until the user accepts them/);
});
