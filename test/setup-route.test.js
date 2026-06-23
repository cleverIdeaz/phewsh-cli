const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('non-interactive setup preserves an installed configured route', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-setup-route-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const configPath = path.join(home, '.phewsh', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    defaultRoute: 'codex',
    fallback: 'ask',
  }));

  for (const name of ['claude', 'codex']) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, `#!${process.execPath}\n`);
    fs.chmodSync(executable, 0o755);
  }

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'phewsh.js'), 'setup'],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          NO_COLOR: '1',
        },
        encoding: 'utf-8',
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const plainOutput = result.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(plainOutput, /Kept configured default route:\s+Codex CLI/);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.equal(saved.defaultRoute, 'codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
