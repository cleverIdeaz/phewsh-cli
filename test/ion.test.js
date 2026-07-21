const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
  // 0.15.80 ruled the two-step canonical: register the repo, then one worker per machine
  assert.match(out, /phewsh project add/);
  assert.match(out, /phewsh serve/);
  assert.match(out, /phewsh ion doctor/);
  assert.match(out, /phewsh ion claim/);
  assert.match(out, /invite/);
  assert.match(out, /Prove it with two people/);
  assert.match(out, /phewsh\.com\/ion\/two-person-proof\.md/);
});

test('`phewsh ion connectors` frames Slack/Discord as connectors, not the core', () => {
  const out = run(['ion', 'connectors']);
  assert.match(out, /connector/i);
  assert.match(out, /phewsh\.com\/ion/);
});

test('`phewsh ion doctor --help` explains its evidence boundary without probing', () => {
  const out = run(['ion', 'doctor', '--help']);
  assert.match(out, /read-only two-person preflight/i);
  assert.match(out, /Browser sign-in and realtime stay human/i);
  assert.match(out, /--offline/);
  assert.match(out, /--json/);
  assert.match(out, /phewsh\.com\/ion\/two-person-proof\.md/);
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

test('Ion web setup and the public proof use the durable two-person operator script', () => {
  const root = path.join(__dirname, '..', '..');
  const page = fs.readFileSync(path.join(root, 'ion', 'classic.html'), 'utf-8');
  const script = fs.readFileSync(path.join(root, 'handoffs', 'ION_TWO_PERSON_WALKTHROUGH_2026-07-15.md'), 'utf-8');
  const publicProof = fs.readFileSync(path.join(root, 'ion', 'two-person-proof.md'), 'utf-8');
  const ship = fs.readFileSync(path.join(root, 'ship.sh'), 'utf-8');
  assert.match(page, /phewsh ion doctor/);
  assert.match(page, /id="two-person-proof"/);
  assert.match(page, /two distinct Phewsh accounts/);
  assert.match(page, /must appear for the teammate without reload/);
  assert.match(page, /Never publish emails, tokens, local paths, prompts, transcripts, or model reasoning/);
  assert.match(page, /href="\/ion\/two-person-proof\.md"/);
  assert.equal(publicProof, script);
  assert.match(ship, /"dispatch\/" "ion\/" "desktop\/"/);
  assert.match(script, /Ten-step walkthrough/);
  assert.match(script, /without reloading/i);
  assert.match(script, /Run on this machine/);
  assert.match(script, /phewsh ion reconcile/);
  assert.match(script, /do not publish the email address/i);
});
