const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const handoff = require('../lib/handoff-receipt');

function fixture({ git = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-handoff-project-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-handoffs-'));
  fs.mkdirSync(path.join(cwd, '.intent'));
  fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\nportable-marker-secret\n');
  fs.writeFileSync(path.join(cwd, '.intent', 'next.json'), '{"items":[]}\n');
  fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'dirty-marker-secret\n');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd });
    execFileSync('git', ['add', '.intent'], { cwd });
    execFileSync('git', ['commit', '-qm', 'intent'], { cwd });
  }
  const report = git ? {
    git: {
      available: true,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).trim(),
      tracked: [],
      untracked: ['dirty.txt'],
    },
  } : { git: { available: false, tracked: [], untracked: [] } };
  return { cwd, root, report, cleanup: () => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

test('writes a deterministic integrity-checksummed receipt without transcript or file content', () => {
  const f = fixture();
  try {
    const now = new Date('2026-07-15T14:02:11.000Z');
    const first = handoff.createHandoffReceipt({ ...f, now, fromRoute: 'codex', toRoute: 'claude-code' });
    const second = handoff.createHandoffReceipt({ ...f, now, fromRoute: 'codex', toRoute: 'claude-code' });
    assert.equal(first.written, true);
    assert.deepEqual(first.receipt, second.receipt);
    assert.equal(handoff.integrityValid(first.receipt), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
    const bytes = fs.readFileSync(first.file, 'utf-8');
    assert.doesNotMatch(bytes, /portable-marker-secret|dirty-marker-secret/);
    assert.match(bytes, /conversation transcript/);
    assert.deepEqual(first.receipt.routes, { from: 'codex', to: 'claude-code' });
    assert.equal(first.receipt.trigger, 'explicit-handoff');
  } finally { f.cleanup(); }
});

test('verifies untouched state and names exact truth and repository movement', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.cwd, 'odd name.txt'), 'before\n');
    const made = handoff.createHandoffReceipt({ ...f });
    assert.equal(handoff.verifyHandoffReceipt(made.file, { cwd: f.cwd }).status, 'verified');

    fs.writeFileSync(path.join(f.cwd, '.intent', 'next.json'), '{"items":[1]}\n');
    fs.writeFileSync(path.join(f.cwd, 'another.txt'), 'new\n');
    fs.writeFileSync(path.join(f.cwd, 'dirty.txt'), 'same path, different bytes\n');
    fs.writeFileSync(path.join(f.cwd, 'odd name.txt'), 'after\n');
    const moved = handoff.verifyHandoffReceipt(made.file, { cwd: f.cwd });
    assert.equal(moved.status, 'moved');
    assert.deepEqual(moved.truthChanged, ['.intent/next.json']);
    assert.ok(moved.repositoryChanged.includes('working path changed: another.txt'));
    assert.ok(moved.repositoryChanged.includes('working path changed: dirty.txt'));
    assert.ok(moved.repositoryChanged.includes('working path changed: odd name.txt'));
  } finally { f.cleanup(); }
});

test('handoff summaries bound large movement sets while preserving the total', () => {
  const changes = Array.from({ length: 25 }, (_, index) => `working path changed: file-${index}.txt`);
  const summary = handoff.summarizeEvidence(changes);
  assert.match(summary, /file-0\.txt, working path changed: file-1\.txt, working path changed: file-2\.txt/);
  assert.match(summary, /… \+22 more \(25 changes total\)$/);
  assert.doesNotMatch(summary, /file-3\.txt/);
  assert.ok(summary.length < 240);
});

test('a modified receipt is invalid, preserved, and never replaced by an older success', () => {
  const f = fixture();
  try {
    const made = handoff.createHandoffReceipt({ ...f });
    const body = JSON.parse(fs.readFileSync(made.file, 'utf-8'));
    body.routes.to = 'tampered';
    fs.writeFileSync(made.file, JSON.stringify(body));
    const result = handoff.verifyHandoffReceipt(made.file, { cwd: f.cwd });
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, /integrity/);
    assert.equal(fs.existsSync(made.file), true);
    assert.equal(handoff.latestHandoffReceipt({ cwd: f.cwd, root: f.root }).status, 'invalid');
  } finally { f.cleanup(); }
});

test('works without Git and attaches the exact handoff brief hash', () => {
  const f = fixture({ git: false });
  try {
    const made = handoff.createHandoffReceipt({ ...f });
    assert.deepEqual(made.receipt.carried.repository, { available: false });
    assert.equal(handoff.verifyHandoffReceipt(made.file, { cwd: f.cwd }).status, 'verified');
    const briefFile = path.join(f.root, 'briefs', 'project', 'handoff.md');
    fs.mkdirSync(path.dirname(briefFile), { recursive: true });
    fs.writeFileSync(briefFile, 'exact brief\n');
    const briefHash = handoff.digest('exact brief\n');
    const attached = handoff.attachBrief(made.file, briefHash, briefFile, { phewshRoot: f.root });
    assert.equal(attached.written, true);
    assert.deepEqual(attached.receipt.carried.brief, {
      sha256: briefHash,
      path: 'briefs/project/handoff.md',
    });
    assert.equal(handoff.integrityValid(attached.receipt), true);
    assert.equal(handoff.verifyHandoffReceipt(made.file, { cwd: f.cwd, phewshRoot: f.root }).status, 'verified');
    fs.writeFileSync(briefFile, 'changed brief\n');
    assert.deepEqual(
      handoff.verifyHandoffReceipt(made.file, { cwd: f.cwd, phewshRoot: f.root }).briefChanged,
      ['handoff brief changed'],
    );
  } finally { f.cleanup(); }
});

test('receipts are project-scoped even when project basenames collide', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-handoffs-'));
  const parentA = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-parent-a-'));
  const parentB = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-parent-b-'));
  const a = path.join(parentA, 'same');
  const b = path.join(parentB, 'same');
  try {
    for (const cwd of [a, b]) {
      fs.mkdirSync(path.join(cwd, '.intent'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), cwd);
      handoff.createHandoffReceipt({ cwd, root, report: { git: { available: false } } });
    }
    assert.notEqual(
      handoff.latestHandoffReceipt({ cwd: a, root }).receipt.project.identity.value,
      handoff.latestHandoffReceipt({ cwd: b, root }).receipt.project.identity.value,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(parentA, { recursive: true, force: true });
    fs.rmSync(parentB, { recursive: true, force: true });
  }
});

test('normalized git remote is the project identity, so moving a checkout keeps its receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-handoffs-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-move-parent-'));
  const before = path.join(parent, 'before');
  const after = path.join(parent, 'after');
  try {
    fs.mkdirSync(path.join(before, '.intent'), { recursive: true });
    fs.writeFileSync(path.join(before, '.intent', 'vision.md'), '# Vision\n');
    execFileSync('git', ['init', '-q'], { cwd: before });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: before });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: before });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Example/Project.git'], { cwd: before });
    execFileSync('git', ['add', '-A'], { cwd: before });
    execFileSync('git', ['commit', '-qm', 'intent'], { cwd: before });
    const made = handoff.createHandoffReceipt({
      cwd: before, root,
      report: { git: { available: true, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: before, encoding: 'utf-8' }).trim() } },
    });
    assert.deepEqual(made.receipt.project.identity, { kind: 'git-remote', value: 'github.com/example/project' });
    fs.renameSync(before, after);
    assert.equal(handoff.latestHandoffReceipt({ cwd: after, root }).status, 'verified');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('an oversized dirty file degrades to partial instead of blocking or claiming verified', () => {
  const f = fixture();
  try {
    const large = path.join(f.cwd, 'large.bin');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, handoff.MAX_DIRTY_HASH_BYTES + 1);
    const made = handoff.createHandoffReceipt({ ...f });
    const result = handoff.verifyHandoffReceipt(made.file, { cwd: f.cwd });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.repositoryPartial, ['working path not fingerprinted (over 10 MB): large.bin']);
  } finally { f.cleanup(); }
});

test('an interrupted atomic write leaves no partial receipt behind', () => {
  const f = fixture();
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('simulated interruption before publish'); };
    const made = handoff.createHandoffReceipt({ ...f });
    assert.equal(made.written, false);
    assert.match(made.reason, /simulated interruption/);
    const leftovers = [];
    const walk = current => {
      let entries = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) walk(child); else leftovers.push(child);
      }
    };
    walk(f.root);
    assert.deepEqual(leftovers, []);
  } finally {
    fs.renameSync = rename;
    f.cleanup();
  }
});

test('an interrupted brief attachment preserves the original valid receipt', () => {
  const f = fixture({ git: false });
  const rename = fs.renameSync;
  try {
    const made = handoff.createHandoffReceipt({ ...f });
    const before = fs.readFileSync(made.file, 'utf-8');
    fs.renameSync = () => { throw new Error('simulated interruption before replacement'); };
    const attached = handoff.attachBrief(
      made.file,
      handoff.digest('brief'),
      path.join(f.root, 'briefs', 'brief.md'),
      { phewshRoot: f.root },
    );
    assert.equal(attached.written, false);
    assert.equal(fs.readFileSync(made.file, 'utf-8'), before);
    assert.equal(handoff.integrityValid(JSON.parse(before)), true);
    assert.deepEqual(
      fs.readdirSync(path.dirname(made.file)).filter(file => file.endsWith('.tmp')),
      [],
    );
  } finally {
    fs.renameSync = rename;
    f.cleanup();
  }
});
