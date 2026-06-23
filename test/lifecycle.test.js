const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { auditTruth } = require('../lib/truth');
const {
  applyReconciliation,
  captureSnapshot,
  compareSnapshots,
  reconciliationProposal,
} = require('../lib/lifecycle');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-lifecycle-'));
  fs.mkdirSync(path.join(root, '.intent'));
  fs.writeFileSync(path.join(root, '.intent', 'vision.md'), '# Vision\nBuild verified continuity.\n');
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '---\nupdated: 2026-06-14\n---\n# Status\nVersion 0.1.0 shipped.\n');
  fs.writeFileSync(path.join(root, '.intent', 'next.md'), '# Next\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '<!-- PHEWSH:START -->\nold\n<!-- PHEWSH:END -->\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.0' }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

function addStartedCriterion(root, expectedPath = 'changed.txt') {
  fs.writeFileSync(path.join(root, '.intent', 'next.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'n1',
      title: 'Complete verified work',
      state: 'now',
      criteria: [{
        expected: `${expectedPath} exists`,
        type: 'measurable',
        accepted: true,
        check: { kind: 'file', path: expectedPath },
      }],
    }],
  }, null, 2));
}

function addStartedChangedCriterion(root, expectedPath) {
  fs.writeFileSync(path.join(root, '.intent', 'next.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'n1',
      title: 'Commit verified work',
      state: 'now',
      criteria: [{
        expected: `${expectedPath} changed`,
        type: 'measurable',
        accepted: true,
        check: { kind: 'changed', path: expectedPath },
      }],
    }],
  }, null, 2));
}

async function truth(root) {
  return auditTruth({
    cwd: root,
    packageJsonPath: path.join(root, 'package.json'),
    npmLatest: { status: 'known', version: '0.1.0' },
    outcomes: { total: 0, pending: 0, judged: 0, autoFailed: 0, kept: 0, recent: [] },
    receipts: { totalEvents: 0, completed: 0, failed: 0, blocked: 0, gated: 0, dispatched: 0 },
  });
}

test('postflight distinguishes changes made during work from pre-existing dirty state', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'before.txt'), 'already dirty');
  const before = captureSnapshot(await truth(root), { cwd: root });

  fs.writeFileSync(path.join(root, 'before.txt'), 'changed during work');
  fs.writeFileSync(path.join(root, 'new.txt'), 'created during work');
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '---\nupdated: 2026-06-15\n---\n# Status\nVersion 0.1.0 still claimed.\n');
  const old = Date.now() - 10000;
  fs.utimesSync(path.join(root, 'CLAUDE.md'), old / 1000, old / 1000);

  const after = captureSnapshot(await truth(root), { cwd: root });
  const report = compareSnapshots(before, after);
  assert.ok(report.preExistingDirty.includes('before.txt'));
  assert.ok(report.files.includes('before.txt'));
  assert.ok(report.files.includes('new.txt'));
  assert.ok(report.intentFiles.includes('.intent/status.md'));
  assert.ok(report.claims.some(claim => claim.file === '.intent/status.md'));
  assert.ok(report.conflicts.some(conflict => /CLAUDE\.md is older/.test(conflict)));
  assert.ok(report.diffSummary.additions > 0);
});

test('reconciliation proposes a diff without writing and applies only after explicit call', async () => {
  const root = fixture();
  addStartedCriterion(root);
  const before = captureSnapshot(await truth(root), { cwd: root });
  fs.writeFileSync(path.join(root, 'changed.txt'), 'work');
  const after = captureSnapshot(await truth(root), { cwd: root });
  const report = compareSnapshots(before, after);
  const nextPath = path.join(root, '.intent', 'next.md');
  const original = fs.readFileSync(nextPath, 'utf-8');

  const proposal = reconciliationProposal(report, { cwd: root });
  assert.equal(proposal.available, true);
  assert.match(proposal.diff, /Uncommitted working-tree changes; not shipped/);
  assert.match(proposal.diff, /Verification verdict: pass/);
  assert.match(proposal.diff, /\[pass\] changed\.txt exists/);
  assert.equal(fs.readFileSync(nextPath, 'utf-8'), original);

  const applied = applyReconciliation(proposal);
  assert.equal(applied.written, true);
  assert.match(fs.readFileSync(nextPath, 'utf-8'), /Observed work requiring reconciliation/);
});

test('wrap/postflight reports an honest verification verdict from current evidence', async () => {
  const root = fixture();
  addStartedCriterion(root, 'artifact.txt');
  const before = captureSnapshot(await truth(root), { cwd: root });
  fs.writeFileSync(path.join(root, 'artifact.txt'), 'done');
  const after = captureSnapshot(await truth(root), { cwd: root });
  const report = compareSnapshots(before, after);
  assert.equal(report.verification.summary.pass, 1);
  assert.match(require('../lib/lifecycle').formatObservedReport(report), /Verification:\n- pass: Complete verified work/);
});

test('postflight changed criteria use the preflight baseline even when work was committed', async () => {
  const root = fixture();
  addStartedChangedCriterion(root, 'committed.txt');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'define work'], { cwd: root });
  const before = captureSnapshot(await truth(root), { cwd: root });
  fs.writeFileSync(path.join(root, 'committed.txt'), 'done');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'complete work'], { cwd: root });
  const after = captureSnapshot(await truth(root), { cwd: root });
  const report = compareSnapshots(before, after);
  assert.equal(report.verification.results[0].status, 'pass');
});

test('reconciliation refuses to apply when the authoritative file changed after review', async () => {
  const root = fixture();
  const before = captureSnapshot(await truth(root), { cwd: root });
  fs.writeFileSync(path.join(root, 'changed.txt'), 'work');
  const after = captureSnapshot(await truth(root), { cwd: root });
  const proposal = reconciliationProposal(compareSnapshots(before, after), { cwd: root });
  fs.appendFileSync(path.join(root, '.intent', 'next.md'), '\nmanual edit\n');

  const applied = applyReconciliation(proposal);
  assert.equal(applied.written, false);
  assert.match(applied.reason, /changed after the proposal/);
});
