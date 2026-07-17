const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { auditTruth, fetchNpmLatest, formatTruth, quickVerifiedState, quickVersionDrift } = require('../lib/truth');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-truth-'));
  fs.mkdirSync(path.join(root, '.intent'));
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '---\nupdated: 2026-06-15\n---\n# Status\nPackage v0.1.0 shipped.\n');
  fs.writeFileSync(path.join(root, '.intent', 'project.json'), JSON.stringify({
    name: 'Truth Fixture',
    decisionGate: { constraints: { budget: 10 } },
  }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '<!-- PHEWSH:START -->\n> Auto-synced by `phewsh seq` | 2026-06-14\n<!-- PHEWSH:END -->\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.2.0' }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  // Real drift: a code commit lands *after* status.md was last updated. This is
  // the honest "shipped code, intent narrative is behind" signal — not a stale
  // mtime on a file that's actually current at HEAD.
  fs.writeFileSync(path.join(root, 'app.js'), 'console.log("shipped after status");\n');
  execFileSync('git', ['add', 'app.js'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'feat: code after status'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.3.0' }));
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'local');
  return root;
}

test('truth audit is read-only and reports explicit conflicts', async () => {
  const root = fixture();
  const before = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, encoding: 'utf-8' });
  const report = await auditTruth({
    cwd: root,
    packageJsonPath: path.join(root, 'package.json'),
    npmLatest: { status: 'unknown', reason: 'offline test' },
    outcomes: { total: 2, pending: 1, judged: 1, autoFailed: 0, kept: 1, recent: [] },
    receipts: { totalEvents: 3, completed: 2, failed: 1, blocked: 0, gated: 0, dispatched: 0 },
  });
  const after = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: root, encoding: 'utf-8' });

  assert.equal(after, before);
  assert.equal(report.package.version, '0.3.0');
  assert.equal(report.git.committedPackageVersion, '0.2.0');
  assert.equal(report.git.untracked.includes('dirty.txt'), true);
  assert.ok(report.conflicts.some(item => /Working package is 0\.3\.0; Git HEAD contains 0\.2\.0/.test(item)));
  assert.ok(report.conflicts.some(item => /Package is 0\.3\.0/.test(item)));
  assert.ok(report.conflicts.some(item => /CLAUDE\.md is older/.test(item)));
  assert.ok(report.conflicts.some(item => /Worktree is dirty/.test(item)));
  assert.ok(report.conflicts.some(item => /commit\(s\) changed code since \.intent\/status\.md was last updated/.test(item)));
  assert.ok(report.sourceContract.some(item => item.authority === 'authoritative-claim'));
  assert.equal(report.outcomes.judged, 1);
  assert.equal(report.receipts.totalEvents, 3);
  assert.match(formatTruth(report), /npm latest: unknown \(offline test\)/);
  assert.match(formatTruth(report), /Machine-local:/);
});

test('status.md current at HEAD does not trigger a false staleness conflict', async () => {
  // Regression: committing status.md used to immediately flag it as "predating
  // HEAD" because the commit timestamp is always >= the file mtime. A file that
  // is current at HEAD with no later code commits must read as clean.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-truth-clean-'));
  fs.mkdirSync(path.join(root, '.intent'));
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '---\nupdated: 2026-06-15\n---\n# Status\nShipped.\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.1.0' }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'ship: status.md and code together'], { cwd: root });

  const report = await auditTruth({
    cwd: root,
    packageJsonPath: path.join(root, 'package.json'),
    npmLatest: { status: 'known', version: '0.1.0' },
    outcomes: { total: 0, pending: 0, judged: 0, autoFailed: 0, kept: 0, recent: [] },
    receipts: { totalEvents: 0, completed: 0, failed: 0, blocked: 0, gated: 0, dispatched: 0 },
  });
  assert.equal(report.git.drift.commitsSince, 0);
  assert.ok(!report.conflicts.some(item => /status\.md was last updated/.test(item)));
});

test('an initialized repository without a first commit is still verified as a Git repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-truth-unborn-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'first.txt'), 'not committed yet\n');

  const state = quickVerifiedState(root);
  assert.equal(state.available, true);
  assert.equal(state.isRepo, true);
  assert.equal(state.shortHead, null);
  assert.equal(state.dirtyCount, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test('npm latest explicitly degrades to unknown offline', async () => {
  const latest = await fetchNpmLatest('phewsh', {
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.deepEqual(latest, { status: 'unknown', reason: 'offline or registry unavailable' });
});

test('quickVersionDrift flags docs behind shipped code, and stays quiet when current', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-vdrift-'));
  fs.mkdirSync(path.join(root, '.intent'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.15.62' }));

  // Headline claims an older version than shipped → drift.
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '# Status\nDogfood `0.15.55` is live.\n');
  assert.deepEqual(quickVersionDrift(root), { shipped: '0.15.62', claimed: '0.15.55' });

  // Docs caught up (max claim equals shipped) → no false alarm, even with old refs in history.
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '# Status\nShipped `0.15.62`; earlier `0.15.55` is history.\n');
  assert.equal(quickVersionDrift(root), null);

  // Explicitly archived release history never overrides the current claim.
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '# Status\nCurrent `0.15.62`.\n\n## Archive\nPlanned `0.99.0`; old `0.1.0`.\n');
  assert.equal(quickVersionDrift(root), null);

  // No package version anywhere → nothing to compare, stays quiet.
  fs.rmSync(path.join(root, 'package.json'));
  assert.equal(quickVersionDrift(root), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('quickVersionDrift finds the version in a cli/ monorepo child (like phewsh itself)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-vdrift-mono-'));
  fs.mkdirSync(path.join(root, '.intent'));
  fs.mkdirSync(path.join(root, 'cli'));
  fs.writeFileSync(path.join(root, 'cli', 'package.json'), JSON.stringify({ name: 'phewsh', version: '0.15.63' }));
  fs.writeFileSync(path.join(root, '.intent', 'next.md'), '# Next\n`phewsh@0.15.55` is live.\n');
  assert.deepEqual(quickVersionDrift(root), { shipped: '0.15.63', claimed: '0.15.55' });
  fs.rmSync(root, { recursive: true, force: true });
});
