// A reviewed run is bound to a COMMIT BASELINE, not just to a repository.
//
// The project-binding audit on 2026-07-31 found the contract already binds
// project id, live remote, runtime and an executionDigest of the packet — and
// then stops. Nothing recorded WHICH COMMIT the reviewer was looking at. So an
// approval held for thirty minutes still ran after the branch moved under it:
// same repo, same words, different code. A person approves a diff they can see;
// binding the repo alone silently re-points that approval at whatever landed
// since.
//
// These tests are written against real git checkouts rather than a stubbed
// runner. The whole failure mode is "the filesystem moved and the snapshot did
// not notice", which a mock cannot reproduce.
//
// Owner layer: CLI.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildActionContract, captureCheckout, assertCheckoutUnmoved,
} = require('../lib/action-contract');
const { resolveRunTarget } = require('../lib/local-claim');

const git = (dir, args) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

function newRepo(remote = 'https://github.com/example/baseline.git') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-baseline-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'baseline@fixture.test']);
  git(dir, ['config', 'user.name', 'Baseline Fixture']);
  git(dir, ['remote', 'add', 'origin', remote]);
  return dir;
}

function commit(dir, name) {
  fs.writeFileSync(path.join(dir, name), name);
  git(dir, ['add', name]);
  git(dir, ['commit', '-q', '-m', name]);
  return git(dir, ['rev-parse', 'HEAD']);
}

// `symbolic-ref`, not `rev-parse --abbrev-ref`: the latter cannot name the
// branch of a checkout that has no commit yet, which is one of the states
// under test here.
const branchOf = (dir) => git(dir, ['symbolic-ref', '--short', 'HEAD']);

const claude = {
  id: 'claude-code', label: 'Claude Code', connected: true, headless: true,
  auth: 'Claude subscription / Console',
};
const project = { id: '8a849716ebfaf431', name: 'phewsh', remote: 'github.com/cleverideaz/phewsh' };

const build = (over = {}) => buildActionContract({
  task: 'run the tests', runtime: claude, project,
  checkout: { branch: 'main', head: 'a'.repeat(40) },
  ...over,
});

// ---------------------------------------------------------------------------
// Capturing the baseline
// ---------------------------------------------------------------------------

test('captures the branch and the commit a run would start from', () => {
  const dir = newRepo();
  const head = commit(dir, 'a.txt');

  const snapshot = captureCheckout(dir);
  assert.strictEqual(snapshot.head, head);
  assert.strictEqual(snapshot.branch, branchOf(dir));
});

test('a checkout with no commit yet binds to an explicit "no commit", not to a guess', () => {
  // A registered repo can legitimately have an unborn HEAD. That is a real,
  // nameable state — null here means "there was no commit", and the first
  // commit therefore MOVES it. It must never read as "baseline unknown".
  const dir = newRepo();
  const snapshot = captureCheckout(dir);
  assert.strictEqual(snapshot.head, null);
  assert.strictEqual(snapshot.branch, branchOf(dir));
});

test('reports a detached HEAD as no branch rather than inventing one', () => {
  const dir = newRepo();
  const head = commit(dir, 'a.txt');
  git(dir, ['checkout', '-q', '--detach', head]);

  const snapshot = captureCheckout(dir);
  assert.strictEqual(snapshot.branch, null);
  assert.strictEqual(snapshot.head, head);
});

test('refuses to bind a directory that is not a git checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-nonrepo-'));
  assert.throws(() => captureCheckout(dir), /not a git checkout/iu);
});

// ---------------------------------------------------------------------------
// The contract carries it
// ---------------------------------------------------------------------------

test('the contract names the branch and commit it was reviewed against', () => {
  const contract = build();
  assert.strictEqual(contract.boundBranch, 'main');
  assert.strictEqual(contract.boundHead, 'a'.repeat(40));
});

test('refuses to compose a contract with no commit baseline at all', () => {
  // Without this, an approval is unverifiable after the fact: there is nothing
  // to compare the live checkout to, and "cannot check" must never pass.
  assert.throws(() => build({ checkout: undefined }), /baseline|approved against/iu);
  assert.throws(() => build({ checkout: {} }), /baseline|approved against/iu);
});

// ---------------------------------------------------------------------------
// Re-verified before the run
// ---------------------------------------------------------------------------

test('an unchanged checkout still matches its approval', () => {
  const dir = newRepo();
  commit(dir, 'a.txt');
  const contract = build({ checkout: captureCheckout(dir) });

  const live = assertCheckoutUnmoved(contract, dir);
  assert.strictEqual(live.head, contract.boundHead);
  assert.strictEqual(live.branch, contract.boundBranch);
});

test('a new commit on the same branch invalidates the approval', () => {
  const dir = newRepo();
  commit(dir, 'a.txt');
  const contract = build({ checkout: captureCheckout(dir) });

  commit(dir, 'b.txt');
  assert.throws(() => assertCheckoutUnmoved(contract, dir), /moved|review/iu);
});

test('a first commit invalidates an approval reviewed against an empty checkout', () => {
  const dir = newRepo();
  const contract = build({ checkout: captureCheckout(dir) });

  commit(dir, 'a.txt');
  assert.throws(() => assertCheckoutUnmoved(contract, dir), /moved|review/iu);
});

test('switching branches invalidates the approval even at the same commit', () => {
  const dir = newRepo();
  commit(dir, 'a.txt');
  const contract = build({ checkout: captureCheckout(dir) });

  git(dir, ['checkout', '-q', '-b', 'other']);
  assert.throws(() => assertCheckoutUnmoved(contract, dir), /moved|review/iu);
});

test('detaching HEAD invalidates the approval even at the same commit', () => {
  const dir = newRepo();
  const head = commit(dir, 'a.txt');
  const contract = build({ checkout: captureCheckout(dir) });

  git(dir, ['checkout', '-q', '--detach', head]);
  assert.throws(() => assertCheckoutUnmoved(contract, dir), /moved|review/iu);
});

test('an approval carrying no baseline cannot be verified, so it is refused', () => {
  const dir = newRepo();
  commit(dir, 'a.txt');
  assert.throws(() => assertCheckoutUnmoved({}, dir), /baseline|review/iu);
});

// ---------------------------------------------------------------------------
// The leg that already existed — pinned so a repair here cannot weaken it
// ---------------------------------------------------------------------------

test('a repo re-pointed at a different origin is still refused outright', () => {
  // Remote drift was already covered by assertLiveIdentity before this change.
  // Pinned here so the commit baseline is understood as an ADDITION to that
  // gate, never a replacement for it.
  const dir = newRepo();
  commit(dir, 'a.txt');
  const registered = [{ id: 'p1', name: 'baseline', path: dir, remote: 'github.com/example/baseline' }];
  assert.ok(resolveRunTarget('p1', registered));

  git(dir, ['remote', 'set-url', 'origin', 'https://github.com/example/somewhere-else.git']);
  assert.throws(() => resolveRunTarget('p1', registered), /no longer matches|identity/iu);
});
