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

test('intent.js parses flags when invoked directly (the /init help-screen bug)', () => {
  // The session once spawned `node intent.js --init` — flags landed at argv[2],
  // slice(3) missed them, and /init printed the help screen instead of initializing.
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-init-'));
  const out = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'commands', 'intent.js'), '--init'],
    { cwd: dir, encoding: 'utf8', input: '' }); // non-TTY → starter artifacts, no prompts
  assert.ok(!/Usage:/.test(out), 'must not print the help screen');
  assert.ok(fs.existsSync(path.join(dir, '.intent', 'vision.md')), '.intent/vision.md created');
});

test('feedback builds a prefilled public-issue URL with only visible metadata', () => {
  const { buildUrl } = require('../commands/feedback');
  const url = buildUrl('clarify lost my answers');
  assert.match(url, /^https:\/\/github\.com\/cleverIdeaz\/phewsh-cli\/issues\/new\?/);
  const decoded = decodeURIComponent(url).replace(/\+/g, ' '); // URLSearchParams space encoding
  assert.match(decoded, /clarify lost my answers/);
  assert.match(decoded, /phewsh \d+\.\d+\.\d+/);
  // no user text: template placeholder, empty title
  assert.match(decodeURIComponent(buildUrl('')).replace(/\+/g, ' '), /What happened\?/);
});
