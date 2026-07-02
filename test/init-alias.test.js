const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// phewsh.com/cli tells new users to run `phewsh init` as step 2 of the install
// flow — it must work as an alias for `phewsh intent --init`.
test('`phewsh init` creates .intent/ like `intent --init`', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-init-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'phewsh.js'), 'init'], {
    cwd: proj,
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  assert.ok(!/Unknown command/.test(out), `should not be an unknown command, got: ${out}`);
  assert.ok(fs.existsSync(path.join(proj, '.intent', 'vision.md')), '.intent/vision.md should exist');

  fs.rmSync(root, { recursive: true, force: true });
});
