// phewsh project — the serve registry (Jul 8 2026 Option C ruling).
//
// The registry is the authorization list for what a worker exposes:
// deliberate adds only, identity = normalized git remote, and removing a
// project never touches the project itself. All tests run against a temp
// index via PHEWSH_PROJECT_INDEX so the real ~/.phewsh is never written.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');

function makeRepo(root, name, remote) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}

function phewsh(args, cwd, indexFile) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, PHEWSH_PROJECT_INDEX: indexFile, NO_COLOR: '1' },
    encoding: 'utf-8',
  });
}

test('project add registers with normalized remote identity; list shows it; remove un-exposes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-registry-'));
  const indexFile = path.join(root, 'index.json');
  const repo = makeRepo(root, 'demo-app', 'git@github.com:example/Demo-App.git');

  const add = phewsh(['project', 'add'], repo, indexFile);
  assert.strictEqual(add.status, 0, add.stdout + add.stderr);
  assert.match(add.stdout, /registered/);

  // macOS tmpdir is a symlink (/var → /private/var); the spawned process
  // registers the real path, so compare against realpath.
  const repoKey = fs.realpathSync(repo);
  const saved = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  const entry = saved.projects[repoKey];
  assert.ok(entry, 'registry entry written');
  assert.strictEqual(entry.serve, true);
  // ssh form normalizes to lowercase host/owner/repo without .git — same convention as task claim
  assert.strictEqual(entry.remote, 'github.com/example/demo-app');

  const list = phewsh(['project', 'list'], root, indexFile);
  assert.match(list.stdout, /demo-app/);
  assert.match(list.stdout, /github\.com\/example\/demo-app/);

  const rm = phewsh(['project', 'remove', 'demo-app'], root, indexFile);
  assert.strictEqual(rm.status, 0);
  assert.match(rm.stdout, /no longer exposed/);
  const after = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  assert.strictEqual(after.projects[repoKey].serve, undefined, 'serve flag cleared');
  assert.ok(after.projects[repoKey].name, 'session-index entry itself remains');
});

test('project add refuses without a git repo, and without an origin remote — with plain-language guidance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-registry-'));
  const indexFile = path.join(root, 'index.json');

  const noGit = phewsh(['project', 'add'], root, indexFile);
  assert.strictEqual(noGit.status, 1);
  assert.match(noGit.stdout, /Not a git repository/);

  const noRemote = makeRepo(root, 'lonely', null);
  const res = phewsh(['project', 'add'], noRemote, indexFile);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /no 'origin' remote/);
  assert.match(res.stdout, /git remote add origin/);
});

test('remove of an unknown project fails helpfully and lists what exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-registry-'));
  const indexFile = path.join(root, 'index.json');
  const res = phewsh(['project', 'remove', 'ghost'], root, indexFile);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /No served project matches/);
});
