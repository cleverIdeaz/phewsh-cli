const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { containedPath, ContainmentError } = require('../lib/truth-path');

// A grant names a REGISTERED REPOSITORY. Everything a grant authorizes has to
// resolve inside that repository, or the grant means something wider than the
// person approving it was shown.
//
// Nothing resolved symlinks, so `.intent` — or any file under it — could point
// anywhere on the machine. A `truth:read` grant for one project became a reader
// for whatever the link pointed at, and a closure write became a writer outside
// the repo entirely. Both were reachable by anyone who could create a symlink in
// a registered repo, which includes every harness the engine runs there.

function repoFixture(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-contain-${label}-`)));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-outside-${label}-`)));
  fs.mkdirSync(path.join(root, '.intent'));
  fs.writeFileSync(path.join(root, '.intent', 'decisions.md'), '# Decisions\n');
  fs.writeFileSync(path.join(outside, 'secrets.md'), 'not yours\n');
  return { root, outside };
}

test('an ordinary path inside the repository resolves', () => {
  const { root } = repoFixture('ok');
  const resolved = containedPath(root, '.intent', 'decisions.md');
  assert.equal(resolved, path.join(root, '.intent', 'decisions.md'));
});

test('a path that does not exist yet still resolves, so truth can be created', () => {
  const { root } = repoFixture('create');
  const resolved = containedPath(root, '.intent', 'next.json');
  assert.equal(resolved, path.join(root, '.intent', 'next.json'));
});

test('a symlinked .intent pointing outside the repository is refused', () => {
  const { root, outside } = repoFixture('dirlink');
  fs.rmSync(path.join(root, '.intent'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.intent'));

  assert.throws(
    () => containedPath(root, '.intent', 'secrets.md'),
    (error) => error instanceof ContainmentError && /outside/i.test(error.message),
  );
  // And the directory itself, asked for on its own.
  assert.throws(() => containedPath(root, '.intent'), ContainmentError);
});

test('a symlinked truth FILE pointing outside the repository is refused', () => {
  const { root, outside } = repoFixture('filelink');
  fs.rmSync(path.join(root, '.intent', 'decisions.md'));
  fs.symlinkSync(path.join(outside, 'secrets.md'), path.join(root, '.intent', 'decisions.md'));

  assert.throws(
    () => containedPath(root, '.intent', 'decisions.md'),
    (error) => error instanceof ContainmentError,
  );
});

test('a traversal segment cannot climb out', () => {
  const { root } = repoFixture('traverse');
  for (const attempt of [
    ['.intent', '..', '..', 'etc', 'passwd'],
    ['..', 'elsewhere', 'file.md'],
    ['.intent', '../../../../../../etc/hosts'],
  ]) {
    assert.throws(() => containedPath(root, ...attempt), ContainmentError, attempt.join('/'));
  }
});

test('an absolute segment cannot replace the root', () => {
  const { root, outside } = repoFixture('absolute');
  assert.throws(() => containedPath(root, path.join(outside, 'secrets.md')), ContainmentError);
  assert.throws(() => containedPath(root, '/etc/passwd'), ContainmentError);
});

test('a symlink that stays inside the repository is contained, so it is allowed', () => {
  // Containment is the property, not "no symlinks anywhere". A repo that links
  // its own files around is still only exposing itself.
  const { root } = repoFixture('internal');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'real.md'), '# real\n');
  fs.symlinkSync(path.join(root, 'docs', 'real.md'), path.join(root, '.intent', 'vision.md'));

  const resolved = containedPath(root, '.intent', 'vision.md');
  assert.equal(resolved, path.join(root, 'docs', 'real.md'));
});

test('the repository root itself is contained', () => {
  const { root } = repoFixture('root');
  assert.equal(containedPath(root), root);
});

test('a sibling directory sharing the root as a name prefix is NOT inside it', () => {
  // The string check this guards against: `/tmp/repo-evil` starts with
  // `/tmp/repo`, but it is a different directory.
  const { root } = repoFixture('prefix');
  const sibling = `${root}-evil`;
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'x.md'), 'x\n');
  fs.symlinkSync(sibling, path.join(root, 'link'));

  assert.throws(() => containedPath(root, 'link', 'x.md'), ContainmentError);
});

test('an unusable root is refused rather than silently trusted', () => {
  assert.throws(() => containedPath('', '.intent'), ContainmentError);
  assert.throws(() => containedPath(null, '.intent'), ContainmentError);
  assert.throws(
    () => containedPath(path.join(os.tmpdir(), 'phewsh-does-not-exist-ever'), '.intent'),
    ContainmentError,
  );
});
