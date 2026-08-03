const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { attributeChanges, gitStatusMap } = require('../lib/run-receipt');

// A previous repair made a CHANGED porcelain status on an already-dirty path
// count as the run's work. That closed half the hole. The status code is only
// two characters of state, so the common case slipped through untouched: a file
// already ` M` before the run, edited again during it, is still ` M` afterwards.
// Same code, so the run reported changing nothing — while the harness had
// rewritten the file. That is the receipt understating real work on a path the
// person is about to accept into the Record.
//
// So the snapshot has to carry CONTENT, not just status.

function repoFixture(label) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-dirty-${label}-`)));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, stdio: 'ignore' });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'dirty@fixture.test']);
  run('git', ['config', 'user.name', 'Dirty Fixture']);
  fs.writeFileSync(path.join(repo, 'tracked.md'), 'committed\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-qm', 'first']);
  return { repo, run };
}

test('a file dirty BEFORE the run and edited DURING it is attributed, though its status never changes', () => {
  const { repo } = repoFixture('same-status');
  const file = path.join(repo, 'tracked.md');

  // Dirty before the run. The person did this, not the run.
  fs.writeFileSync(file, 'committed\nedited by the human\n');
  const before = gitStatusMap(repo);
  assert.equal(String(before['tracked.md'].status ?? before['tracked.md']).trim(), 'M');

  // The run edits it again. Porcelain still says exactly ` M`.
  fs.writeFileSync(file, 'committed\nedited by the human\nedited by the run\n');
  const after = gitStatusMap(repo);
  assert.equal(
    String(after['tracked.md'].status ?? after['tracked.md']).trim(),
    String(before['tracked.md'].status ?? before['tracked.md']).trim(),
    'this test is only meaningful while the status code is identical',
  );

  const changes = attributeChanges(before, after);
  assert.deepEqual(changes.modified, ['tracked.md'],
    'the run rewrote this file; the receipt must say so');
  assert.deepEqual(changes.preExisting, ['tracked.md'],
    'and must still disclose that it was already dirty');
});

test('an untracked file dirty before the run and rewritten during it is attributed', () => {
  const { repo } = repoFixture('untracked');
  const file = path.join(repo, 'scratch.txt');

  fs.writeFileSync(file, 'human draft\n');
  const before = gitStatusMap(repo);
  fs.writeFileSync(file, 'rewritten by the run\n');
  const after = gitStatusMap(repo);

  const changes = attributeChanges(before, after);
  assert.deepEqual(changes.modified, ['scratch.txt']);
  // Not "created": it existed before the run started.
  assert.deepEqual(changes.created, []);
});

test('a dirty path the run genuinely left alone is still not claimed', () => {
  const { repo } = repoFixture('untouched');
  fs.writeFileSync(path.join(repo, 'tracked.md'), 'committed\nhuman edit\n');

  const before = gitStatusMap(repo);
  const after = gitStatusMap(repo);

  const changes = attributeChanges(before, after);
  assert.deepEqual(changes.modified, [], 'attributing an untouched path overstates the run');
  assert.deepEqual(changes.created, []);
  assert.deepEqual(changes.deleted, []);
  assert.deepEqual(changes.preExisting, ['tracked.md']);
});

test('rewriting a dirty file back to identical content is not claimed as a change', () => {
  const { repo } = repoFixture('identical');
  const file = path.join(repo, 'tracked.md');
  fs.writeFileSync(file, 'committed\nhuman edit\n');
  const before = gitStatusMap(repo);

  // Same bytes written again. The tree is in the state the run found it, so
  // there is nothing to attribute — content is the witness, not mtime.
  fs.writeFileSync(file, 'committed\nhuman edit\n');
  const after = gitStatusMap(repo);

  assert.deepEqual(attributeChanges(before, after).modified, []);
});

test('a dirty path the run deletes is reported deleted, not modified', () => {
  const { repo } = repoFixture('deleted');
  const file = path.join(repo, 'tracked.md');
  fs.writeFileSync(file, 'committed\nhuman edit\n');
  const before = gitStatusMap(repo);

  fs.rmSync(file);
  const after = gitStatusMap(repo);

  const changes = attributeChanges(before, after);
  assert.deepEqual(changes.deleted, ['tracked.md']);
  assert.deepEqual(changes.modified, []);
});

test('a snapshot with no content fingerprint falls back to the status code alone', () => {
  // Older callers and the shared fixtures pass `path → status` strings. That
  // carries no content, so identical statuses must stay unattributed rather
  // than becoming a guess in either direction.
  assert.deepEqual(attributeChanges({ 'notes.md': ' M' }, { 'notes.md': ' M' }).modified, []);
  assert.deepEqual(attributeChanges({ 'notes.md': ' M' }, { 'notes.md': 'MM' }).modified, ['notes.md']);
  assert.deepEqual(attributeChanges({}, { 'new.md': '??' }).created, ['new.md']);
});

test('a mixed snapshot — one side fingerprinted, one side not — is not attributed on a guess', () => {
  const withPrint = { 'notes.md': { status: ' M', fingerprint: 'abc' } };
  const without = { 'notes.md': ' M' };
  assert.deepEqual(attributeChanges(withPrint, without).modified, []);
  assert.deepEqual(attributeChanges(without, withPrint).modified, []);
});

// ─── Found by an independent critic, 2026-07-29 ──────────────────────────────
//
// attributeChanges iterated the AFTER snapshot only, so a path present in
// `before` and ABSENT from `after` was never attributed. Every ordinary way an
// agent resolves a dirty path removes it from the dirty set — `git commit`,
// `git checkout --`, `git reset --hard`, `git stash`, `git clean` — so the
// receipt reported `observed: true` with no changes at all, and closure carried
// "no files changed" into the Record.
//
// That is strictly worse than the unreadable-tree case this wave repaired: an
// unknown is honest, an affirmative "nothing changed" is not.

test("a dirty path the run reverted is attributed, not silently dropped", () => {
  const { repo } = repoFixture('reverted');
  const file = path.join(repo, 'tracked.md');
  fs.writeFileSync(file, 'committed\nthe human was mid-thought\n');
  const before = gitStatusMap(repo);
  assert.ok(before['tracked.md'], 'the file must be dirty before the run');

  // The harness throws the person's uncommitted edit away.
  execFileSync('git', ['checkout', '--', 'tracked.md'], { cwd: repo, stdio: 'ignore' });
  const after = gitStatusMap(repo);
  assert.equal(after['tracked.md'], undefined, 'it has left the dirty set entirely');

  const changes = attributeChanges(before, after);
  assert.deepEqual(changes.modified, ['tracked.md'],
    'destroying an uncommitted edit is the run changing that path');
  assert.notDeepEqual(
    [changes.created, changes.modified, changes.deleted], [[], [], []],
    'a receipt must never claim "no files changed" for this',
  );
});

test('a dirty path the run committed is attributed', () => {
  const { repo, run } = repoFixture('committed');
  fs.writeFileSync(path.join(repo, 'tracked.md'), 'committed\nnew work\n');
  fs.writeFileSync(path.join(repo, 'fresh.md'), 'brand new\n');
  const before = gitStatusMap(repo);

  run('git', ['add', '-A']);
  execFileSync('git', ['commit', '-qm', 'the harness committed'], { cwd: repo, stdio: 'ignore' });
  const after = gitStatusMap(repo);

  const changes = attributeChanges(before, after);
  const all = [...changes.created, ...changes.modified, ...changes.deleted];
  assert.ok(all.includes('tracked.md'), 'a committed path is still a path the run changed');
  assert.ok(all.includes('fresh.md'));
});

test('an untracked file the run deleted is reported gone, not omitted', () => {
  const { repo } = repoFixture('cleaned');
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'the human left this here\n');
  const before = gitStatusMap(repo);

  fs.rmSync(path.join(repo, 'scratch.txt'));
  const after = gitStatusMap(repo);

  // The repo directory is what lets a deletion be told from a revert.
  const changes = attributeChanges(before, after, repo);
  assert.deepEqual(changes.deleted, ['scratch.txt'],
    'a file that no longer exists must be reported deleted, not modified');
  assert.deepEqual(changes.modified, []);

  // Without it, the run is still reported as having changed the path — the
  // category is the imprecise part, never the fact that something moved.
  const blind = attributeChanges(before, after);
  assert.deepEqual(blind.modified, ['scratch.txt']);
  assert.deepEqual(blind.deleted, []);
});
