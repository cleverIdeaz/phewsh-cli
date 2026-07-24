const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { parseStatusV2, inspectCheckout } = require('../lib/git-status');

// A fake git runner: map argv (joined) → stdout string.
function fakeRun(map) {
  return (args) => {
    const key = args.join(' ');
    if (!(key in map)) throw new Error(`unexpected git ${key}`);
    const v = map[key];
    if (v instanceof Error) throw v;
    return v;
  };
}

test('parseStatusV2: clean branch tracking an up-to-date upstream', () => {
  const out = parseStatusV2([
    '# branch.oid abcdef1234567890',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +0 -0',
  ].join('\n'));
  assert.equal(out.branch, 'main');
  assert.equal(out.detached, false);
  assert.deepEqual(out.head, { short: 'abcdef1', full: 'abcdef1234567890' });
  assert.equal(out.upstream, 'origin/main');
  assert.equal(out.ahead, 0);
  assert.equal(out.behind, 0);
  assert.deepEqual(out.counts, { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
});

test('parseStatusV2: counts staged, unstaged, untracked, and conflicts distinctly', () => {
  const out = parseStatusV2([
    '# branch.oid deadbeefdeadbeef',
    '# branch.head feature/voice',
    '1 M. N... 100644 100644 100644 aaa bbb staged.txt',   // staged only
    '1 .M N... 100644 100644 100644 ccc ddd worktree.txt', // unstaged only
    '1 MM N... 100644 100644 100644 eee fff both.txt',     // both
    'u UU N... 1 2 3 aaa bbb ccc conflict.txt',            // conflict
    '? untracked.txt',
  ].join('\n'));
  assert.deepEqual(out.counts, { staged: 2, unstaged: 2, untracked: 1, conflicts: 1 });
});

test('parseStatusV2: ahead/behind and diverged', () => {
  const ahead = parseStatusV2('# branch.oid a1\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0');
  assert.equal(ahead.ahead, 2); assert.equal(ahead.behind, 0); assert.equal(ahead.diverged, false);
  const diverged = parseStatusV2('# branch.oid a1\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +3 -4');
  assert.equal(diverged.diverged, true);
});

test('parseStatusV2: detached HEAD has no branch', () => {
  const out = parseStatusV2('# branch.oid c0ffee0\n# branch.head (detached)');
  assert.equal(out.branch, null);
  assert.equal(out.detached, true);
});

test('parseStatusV2: no commits yet → head null', () => {
  const out = parseStatusV2('# branch.oid (initial)\n# branch.head main');
  assert.equal(out.head, null);
});

test('inspectCheckout: non-repo reports isRepo:false', () => {
  const run = () => { throw new Error('not a git repo'); };
  assert.deepEqual(inspectCheckout('/tmp/x', { run }), { isRepo: false });
});

test('inspectCheckout: assembles a privacy-safe, upstream-aware view', () => {
  const run = fakeRun({
    'rev-parse --is-inside-work-tree': 'true\n',
    'status --porcelain=v2 --branch': [
      '# branch.oid 1234567abcdef',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -2',
      '1 .M N... 100644 100644 100644 a b file.txt',
    ].join('\n'),
    'remote get-url origin': 'git@github.com:Mirumora/lead-generation-software.git\n',
  });
  const view = inspectCheckout('/repo', { run, inProgress: null, lastFetch: null });
  assert.equal(view.isRepo, true);
  assert.equal(view.branch, 'main');
  assert.equal(view.dirty, true);
  assert.equal(view.behind, 2);
  assert.equal(view.ahead, 0);
  assert.equal(view.upstream, 'origin/main');
  assert.equal(view.remote, 'github.com/mirumora/lead-generation-software'); // normalized, no token/.git
  assert.equal(view.inProgress, null);
});

test('inspectCheckout: no upstream → ahead/behind are null (unknown), not zero', () => {
  const run = fakeRun({
    'rev-parse --is-inside-work-tree': 'true',
    'status --porcelain=v2 --branch': '# branch.oid abc1234\n# branch.head solo',
    'remote get-url origin': new Error('no origin'),
  });
  const view = inspectCheckout('/repo', { run, inProgress: null, lastFetch: null });
  assert.equal(view.upstream, null);
  assert.equal(view.ahead, null);
  assert.equal(view.behind, null);
  assert.equal(view.remote, null);
});

test('inspectCheckout: real repo (integration) reports a branch or detached HEAD', () => {
  // Runs against this actual repository — read-only.
  let insideRepo = true;
  try { execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { insideRepo = false; }
  if (!insideRepo) return; // skip if the test env isn't a git checkout
  const view = inspectCheckout(__dirname);
  assert.equal(view.isRepo, true);
  assert.ok(view.branch !== undefined);
  assert.ok(typeof view.dirty === 'boolean');
  assert.ok(view.head === null || typeof view.head.full === 'string');
});
