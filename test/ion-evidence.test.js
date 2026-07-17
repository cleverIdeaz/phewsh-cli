const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalizeTaskEvidence, safeHttpUrl, recordState } = require('../../ion/evidence');

test('Ion evidence merges append-only events without inferring test success', () => {
  const evidence = normalizeTaskEvidence(
    { status: 'pr_open', branch: 'phewsh/abc-fix', pull_request_url: 'https://github.com/acme/repo/pull/7' },
    [
      { metadata: { harness: 'codex' } },
      { metadata: {
        changed_files: ['src/app.js', '.intent/work/task-abc.json'],
        changed_file_count: 2,
        tests: { status: 'not_recorded', requested: ['npm test'] },
      } },
    ]
  );
  assert.equal(evidence.branch, 'phewsh/abc-fix');
  assert.deepEqual(evidence.changedFiles, ['src/app.js', '.intent/work/task-abc.json']);
  assert.equal(evidence.changedFileCount, 2);
  assert.deepEqual(evidence.tests, { status: 'not_recorded', requested: ['npm test'] });
  assert.equal(evidence.prUrl, 'https://github.com/acme/repo/pull/7');
  assert.equal(evidence.record, 'PR open · review pending');
});

test('Ion evidence rejects executable URLs and bounds untrusted metadata', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('data:text/html,bad'), '');
  assert.equal(safeHttpUrl('https://example.com/proof'), 'https://example.com/proof');
  const evidence = normalizeTaskEvidence(
    { status: 'reconciled', pull_request_url: 'javascript:alert(1)' },
    [{ metadata: { changed_files: Array.from({ length: 30 }, (_, i) => `<file-${i}>`) } }]
  );
  assert.equal(evidence.prUrl, '');
  assert.equal(evidence.changedFiles.length, 20);
  assert.equal(evidence.changedFileCount, 30);
  assert.equal(evidence.record, 'Recorded into project truth');
});

test('Ion page escapes normalized evidence and labels unavailable proof honestly', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'ion', 'index.html'), 'utf8');
  assert.match(html, /PhewshIonEvidence\.normalizeTaskEvidence/);
  assert.match(html, /Not recorded by worker/);
  assert.match(html, /href="\$\{escapeHtml\(evidence\.prUrl\)\}"/);
  assert.match(html, /changedFiles\.map\(\(file\) => `<code>\$\{escapeHtml\(file\)\}<\/code>`\)/);
  assert.equal(recordState('merged'), 'Merged · reconciliation not recorded');
});

test('Ion local run stays an explicit loopback claim with project-scoped ids', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'ion', 'index.html'), 'utf8');
  assert.match(html, /task\.status === "open" && bridgeServes\(project\)/);
  assert.match(html, /Run on this machine/);
  assert.match(html, /fetch\("http:\/\/localhost:7483\/claim"/);
  assert.match(html, /JSON\.stringify\(\{ projectId: project\.id, taskId: task\.id, runtimeId \}\)/);
  assert.match(html, /if \(runLocal\) runLocalTask\(runLocal\.dataset\.runLocal\)/);
});
