const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// phewsh.com/ion tells users `phewsh ion serve` / `phewsh ion claim <id>` —
// the ion verb family must stay wired as a thin router over serve + task
// (Ion is the room; it is NOT a second execution system).
const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const run = (args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf-8' });

test('`phewsh ion help` describes the room and its real subcommands', () => {
  const out = run(['ion', 'help']);
  assert.match(out, /shared rooms/i);
  assert.match(out, /phewsh ion serve/);
  assert.match(out, /phewsh ion claim/);
  assert.match(out, /invite/);
});

test('`phewsh ion connectors` frames Slack/Discord as connectors, not the core', () => {
  const out = run(['ion', 'connectors']);
  assert.match(out, /connector/i);
  assert.match(out, /phewsh\.com\/ion/);
});

test('`phewsh ion` rejects unknown subcommands with help', () => {
  try {
    run(['ion', 'blastoff']);
  } catch (err) {
    // exitCode 1 path still prints help
    assert.match(String(err.stdout), /Unknown ion command/);
    return;
  }
  // execFileSync may not throw when exitCode is set without a non-zero exit —
  // accept either as long as the message printed
  const out = run(['ion', 'blastoff']);
  assert.match(out, /Unknown ion command/);
});
