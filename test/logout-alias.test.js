const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');

// `phewsh logout` is the universal spelling for `phewsh login --logout`.
// It must clear the local session by removing ~/.phewsh/config.json.
test('`phewsh logout` removes the local session like `login --logout`', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-logout-'));
  const configPath = path.join(home, '.phewsh', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ email: 'x@example.com', supabaseUserId: 'u_1' }));

  const out = execFileSync(process.execPath, [BIN, 'logout'], {
    cwd: home,
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  assert.ok(!/Unknown command/.test(out), `should not be an unknown command, got: ${out}`);
  assert.match(out, /Logged out/);
  assert.ok(!fs.existsSync(configPath), 'config.json should be removed after logout');

  fs.rmSync(home, { recursive: true, force: true });
});

test('`phewsh logout` when not logged in is a graceful no-op', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-logout-'));

  const out = execFileSync(process.execPath, [BIN, 'logout'], {
    cwd: home,
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
  });

  assert.match(out, /Not logged in/);

  fs.rmSync(home, { recursive: true, force: true });
});
