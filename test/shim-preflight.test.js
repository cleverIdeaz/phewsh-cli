const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');

// codexbanner bug: the launch banner leaked into Codex's app-server JSONL
// stream. When stdout is piped (any machine-readable consumer), the
// preflight must write NOTHING to stdout and still exit 0 fast.
test('shim-preflight is silent on piped stdout (machine-readable launches)', () => {
  const out = execFileSync(process.execPath, [BIN, 'shim-preflight', 'codex'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  assert.equal(out, '', 'no banner bytes on a piped stdout');
});

test('shim-preflight exits 0 even for an unknown tool', () => {
  // exit code is asserted implicitly: execFileSync throws on non-zero
  const out = execFileSync(process.execPath, [BIN, 'shim-preflight'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  assert.equal(out, '');
});
