// Tests for self-healing continuity — the deterministic half of the trust
// promise: phewsh keeps CLAUDE.md current from .intent/ so nobody hand-runs
// `seq -w`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const selfheal = require('../lib/selfheal');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-selfheal-'));
  fs.mkdirSync(path.join(dir, '.intent'));
  fs.writeFileSync(path.join(dir, '.intent', 'vision.md'), '# Vision\nBuild a thing.\n');
  fs.writeFileSync(path.join(dir, '.intent', 'plan.md'), '# Plan\nStep one.\n');
  return dir;
}

function setMtime(p, ms) {
  const t = ms / 1000;
  fs.utimesSync(p, t, t);
}

test('isStale: false when no CLAUDE.md exists (nothing to heal)', () => {
  const dir = tmpProject();
  assert.equal(selfheal.isStale(dir), false);
});

test('isStale: false when no .intent/ exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-nointent-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# hi\n');
  assert.equal(selfheal.isStale(dir), false);
});

test('isStale: true when .intent/ is newer than CLAUDE.md', () => {
  const dir = tmpProject();
  const claude = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(claude, '# old\n');
  const now = Date.now();
  setMtime(claude, now - 10000);                          // CLAUDE.md older
  setMtime(path.join(dir, '.intent', 'vision.md'), now);  // intent newer
  assert.equal(selfheal.isStale(dir), true);
});

test('isStale: false when the managed core matches, regardless of mtime noise', () => {
  const dir = tmpProject();
  const claude = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(claude, '# human notes\n');
  selfheal.syncContextFiles({ cwd: dir, targets: ['CLAUDE.md'] });
  const now = Date.now();
  setMtime(claude, now);
  setMtime(path.join(dir, '.intent', 'vision.md'), now + 5000);
  assert.equal(selfheal.isStale(dir), false);
});

test('heal: brings a stale CLAUDE.md current and is idempotent', () => {
  const dir = tmpProject();
  const claude = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(claude, '# original\n');
  const now = Date.now();
  setMtime(claude, now - 10000);
  setMtime(path.join(dir, '.intent', 'vision.md'), now);

  const r1 = selfheal.heal({ cwd: dir });
  assert.equal(r1.healed, true);
  assert.equal(selfheal.isStale(dir), false);

  const r2 = selfheal.heal({ cwd: dir });
  assert.equal(r2.healed, false);
  assert.equal(r2.reason, 'fresh');
});

test('heal: restores original cwd even on a different project dir', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# x\n');
  const before = process.cwd();
  selfheal.heal({ cwd: dir, force: true });
  assert.equal(process.cwd(), before);
});

test('heal: never throws on a bogus dir', () => {
  const r = selfheal.heal({ cwd: '/nonexistent/path/here', force: true });
  assert.equal(r.healed, false);
});

test('one canonical core syncs every harness file and preserves human content', () => {
  const dir = tmpProject();
  const next = require('../lib/next');
  next.add('Ship the verified lifecycle', dir);
  next.addCriterion(1, { expected: 'accepted evidence passes', type: 'measurable' }, dir);
  next.addCriterion(1, { expected: 'unaccepted model idea', type: 'human', accepted: false }, dir);
  fs.writeFileSync(path.join(dir, '.intent', 'status.md'),
    '# Status\n\n## Now\nCurrent focus stays concise.\n\n---\n\n' + 'historical detail\n'.repeat(2000));
  fs.writeFileSync(path.join(dir, '.intent', 'next.md'),
    '# Next\n\n## Current handoff\nShip the current item.\n\n## History\n' + 'old handoff detail\n'.repeat(2000));
  fs.writeFileSync(path.join(dir, '.intent', 'narrative.md'),
    '# Marketing archive\nThis should not consume the operational harness budget.\n');
  fs.writeFileSync(path.join(dir, '.intent', 'project.json'), JSON.stringify({
    name: 'Test project',
    decisionGate: {
      createdAt: new Date().toISOString(),
      constraints: { budget: 50, timeHoursPerWeek: 15, skillLevel: 'expert' },
      responsibilitySplit: { ai: ['legacy routing rule'], human: ['legacy approval rule'] },
    },
    actions: [{ state: 'intended', intent: 'legacy parallel action', category: 'test' }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Claude-only note\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Codex-only note\n');
  selfheal.syncContextFiles({ cwd: dir });
  next.addCriterion(1, { expected: 'replacement stays stable', type: 'measurable' }, dir);
  const result = selfheal.syncContextFiles({ cwd: dir });
  assert.deepEqual(result.synced.sort(), selfheal.TARGET_FILES.slice().sort());

  const managed = selfheal.TARGET_FILES.map(file => {
    const text = fs.readFileSync(path.join(dir, file), 'utf-8');
    const match = text.match(/<!-- PHEWSH:START -->([\s\S]*?)<!-- PHEWSH:END -->/);
    assert.ok(match, `${file} has a managed block`);
    return match[1].replace(/\n?>\s*—\s*synced by phewsh[\s\S]*$/m, '').trim();
  });
  assert.ok(managed.every(core => core === managed[0]), 'all harnesses receive the same canonical core');
  assert.match(managed[0], /accepted evidence passes/);
  assert.match(managed[0], /replacement stays stable/);
  assert.match(managed[0], /Budget: \$50/);
  assert.doesNotMatch(managed[0], /unaccepted model idea/);
  assert.doesNotMatch(managed[0], /Marketing archive/);
  assert.doesNotMatch(managed[0], /legacy routing rule|legacy approval rule|legacy parallel action/);
  assert.doesNotMatch(managed[0], /Claude-only note|Codex-only note/);
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8'), /Claude-only note/);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8'), /Codex-only note/);
});

test('drift in one harness projection is detected and healed without creating missing files', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Claude\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  selfheal.syncContextFiles({ cwd: dir, targets: ['CLAUDE.md', 'AGENTS.md'] });
  const agents = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(agents, fs.readFileSync(agents, 'utf-8').replace('Build a thing.', 'stale project truth'));

  const status = selfheal.projectionStatus({ cwd: dir });
  assert.equal(status.stale, true);
  assert.deepEqual(status.drifted, ['AGENTS.md']);
  const healed = selfheal.heal({ cwd: dir });
  assert.equal(healed.healed, true);
  assert.equal(selfheal.projectionStatus({ cwd: dir }).stale, false);
  assert.equal(fs.existsSync(path.join(dir, 'GEMINI.md')), false, 'refresh-only heal does not seed missing files');
});

test('project projection removal is reversible and preserves human-authored content', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Keep this Claude note\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Keep this Codex note\n');
  selfheal.syncContextFiles({ cwd: dir, targets: ['CLAUDE.md', 'AGENTS.md'] });

  const result = selfheal.removeProjectContextFiles({ cwd: dir, targets: ['CLAUDE.md', 'AGENTS.md'] });
  assert.deepEqual(result.removed.sort(), ['AGENTS.md', 'CLAUDE.md']);
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8'), /Keep this Claude note/);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8'), /Keep this Codex note/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8'), /PHEWSH:START/);
});

// ── the deeper drift: code shipped but .intent/ behind ──────────────────────
const { execFileSync } = require('child_process');

function tmpGitProject() {
  const dir = tmpProject();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  return { dir, git };
}

test('commitsSinceIntent: 0 when no commit follows the latest intent commit', () => {
  const { dir } = tmpGitProject();
  assert.equal(selfheal.commitsSinceIntent(dir), 0);
});

test('a commit that reconciles code and intent together is immediately current', () => {
  const { dir, git } = tmpGitProject();
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped');
  fs.writeFileSync(path.join(dir, '.intent', 'status.md'), '# Status\nFeature shipped.\n');
  git('add', '-A'); git('commit', '-qm', 'feat: ship with its record');

  assert.equal(selfheal.commitsSinceIntent(dir), 0);
  assert.equal(selfheal.wrapDraft(dir), null);
});

test('an uncommitted canonical intent update suppresses stale claims while reconciliation is active', () => {
  const { dir, git } = tmpGitProject();
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'shipped');
  git('add', '-A'); git('commit', '-qm', 'feat: ship before record');
  fs.writeFileSync(path.join(dir, '.intent', 'next.json'), '{"version":1,"items":[]}\n');

  assert.equal(selfheal.commitsSinceIntent(dir), 0);
  const draft = selfheal.wrapDraft(dir);
  assert.ok(draft);
  assert.deepEqual(draft.commits, []);
  assert.ok(draft.dirty.some(item => item.file === '.intent/next.json'));
});

test('commitsSinceIntent + wrapDraft: counts commits after the newest narrative file', () => {
  const { dir, git } = tmpGitProject();
  // Make .intent/ old, then ship two commits "after" it.
  for (const f of ['vision.md', 'plan.md']) setMtime(path.join(dir, '.intent', f), Date.now() - 60000);
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git('add', '-A'); git('commit', '-qm', 'feat: thing one');
  fs.writeFileSync(path.join(dir, 'b.txt'), '2');
  git('add', '-A'); git('commit', '-qm', 'fix: thing two');

  assert.ok(selfheal.commitsSinceIntent(dir) >= 2);
  const draft = selfheal.wrapDraft(dir);
  assert.ok(draft);
  assert.ok(draft.commits.includes('feat: thing one'));
  assert.ok(draft.block.includes('Shipped since last update'));
});

test('wrapDraft: null when not a git repo', () => {
  const dir = tmpProject();
  assert.equal(selfheal.wrapDraft(dir), null);
});

test('wrapDraft: reports dirty work and never claims current', () => {
  const { dir } = tmpGitProject();
  setMtime(path.join(dir, '.intent', 'vision.md'), Date.now() + 5000);
  setMtime(path.join(dir, '.intent', 'plan.md'), Date.now() + 5000);
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'not committed');
  const draft = selfheal.wrapDraft(dir);
  assert.ok(draft);
  assert.equal(draft.commits.length, 0);
  assert.equal(draft.block, null);
  assert.ok(draft.dirty.some(item => item.file === 'dirty.txt'));
});

test('appendToNext: writes the block into next.md', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, '.intent', 'next.md'), '# Next\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# x\n');
  const r = selfheal.appendToNext('\n## Shipped\n- did a thing\n', { cwd: dir });
  assert.equal(r.written, true);
  const next = fs.readFileSync(path.join(dir, '.intent', 'next.md'), 'utf-8');
  assert.ok(next.includes('did a thing'));
});

test('appendToNext: false when next.md is missing', () => {
  const dir = tmpProject(); // no next.md
  const r = selfheal.appendToNext('x', { cwd: dir });
  assert.equal(r.written, false);
});
