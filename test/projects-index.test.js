// Tests for project discovery — scanForProjects (.intent/ present) and
// scanForCandidates (git repo, no .intent/ yet). Both shallow, both
// injectable-root so no test ever reads the host machine's real folders.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanForProjects, scanForCandidates } = require('../lib/projects-index');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-scan-'));
  const mk = (name, files = []) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    return dir;
  };
  return { root, mk };
}

test('scanForProjects finds only dirs with .intent/vision.md', () => {
  const { root, mk } = makeRoot();
  mk('enabled', ['.intent/vision.md']);
  mk('plain-repo', ['.git/HEAD']);
  mk('random', ['notes.txt']);
  const found = scanForProjects([root]);
  assert.deepEqual(found.map(p => p.name), ['enabled']);
});

test('scanForCandidates finds git repos without .intent, with a reason', () => {
  const { root, mk } = makeRoot();
  mk('candidate', ['.git/HEAD']);
  mk('enabled', ['.git/HEAD', '.intent/vision.md']);
  mk('partial-intent', ['.git/HEAD', '.intent/next.json']); // any .intent/ counts as started
  mk('not-a-repo', ['package.json']);
  mk('.hidden', ['.git/HEAD']);
  const found = scanForCandidates([root]);
  assert.deepEqual(found.map(p => p.name), ['candidate']);
  assert.equal(found[0].reason, 'git repo, no .intent/ yet');
});

test('scanForCandidates caps results and skips unreadable roots', () => {
  const { root, mk } = makeRoot();
  for (let i = 0; i < 20; i++) mk(`repo-${String(i).padStart(2, '0')}`, ['.git/HEAD']);
  const found = scanForCandidates([path.join(root, 'does-not-exist'), root]);
  assert.equal(found.length, 15); // CANDIDATE_CAP
});
