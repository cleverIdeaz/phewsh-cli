const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, saveConfig } = require('../lib/config-file');

test('stores credentials with owner-only permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-config-'));
  const configPath = path.join(root, '.phewsh', 'config.json');

  saveConfig(configPath, { apiKey: 'secret' });

  assert.deepEqual(loadConfig(configPath), { apiKey: 'secret' });
  assert.equal(fs.statSync(path.dirname(configPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

  fs.rmSync(root, { recursive: true, force: true });
});

test('hardens permissions on an existing config when read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-config-'));
  const configDir = path.join(root, '.phewsh');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { mode: 0o755 });
  fs.writeFileSync(configPath, '{"apiKey":"secret"}', { mode: 0o644 });

  loadConfig(configPath);

  assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

  fs.rmSync(root, { recursive: true, force: true });
});
