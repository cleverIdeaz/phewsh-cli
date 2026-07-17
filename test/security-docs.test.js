const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLI = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(CLI, file), 'utf8');

test('published security docs state current boundaries and ship in the package', () => {
  const pkg = JSON.parse(read('package.json'));
  const security = read('SECURITY.md');
  const threat = read('docs/threat-model.md');
  const release = read('docs/release-checklist.md');
  const proof = read('docs/handoff-proof.md');

  assert.ok(pkg.files.includes('docs/threat-model.md'));
  assert.ok(pkg.files.includes('docs/release-checklist.md'));
  assert.ok(pkg.files.includes('docs/handoff-proof.md'));
  assert.ok(pkg.files.includes('docs/handoff-proof-fixture.json'));
  assert.match(security, /\[threat model\]\(\.\/docs\/threat-model\.md\)/);
  assert.match(security, /\[release integrity checklist\]\(\.\/docs\/release-checklist\.md\)/);

  for (const boundary of [
    /Loopback is not authentication/,
    /fail-open/,
    /not a sandbox/,
    /not a signature/,
    /PHEWSH_MCP_HOST/,
    /no release provenance/,
    /Supabase/,
  ]) {
    assert.match(security + '\n' + threat, boundary);
  }

  for (const gate of [
    /npm publish --provenance/,
    /npm audit --omit=dev/,
    /npm pack --dry-run --json/,
    /signed tag/,
    /manual and have no release provenance/,
  ]) {
    assert.match(release, gate);
  }

  assert.doesNotMatch(security, /Local shell-injection surface/);
  assert.doesNotMatch(security, /public source repo (?:is|are) planned/i);
  assert.doesNotMatch(security, /exact mirror of the published npm package/i);
  assert.match(proof, /before Codex produces any model\s+output/);
  assert.match(proof, /does not call Claude Code or Codex/);
});

test('current CLI surfaces do not promise transcript or universal-tool continuity', () => {
  const files = [
    'README.md',
    'index.html',
    'commands/hook.js',
    'commands/remember.js',
    'commands/session.js',
    'commands/status.js',
    'lib/route-coach.js',
    'lib/ui.js',
  ];
  const current = files.map(read).join('\n');

  assert.doesNotMatch(current, /Nothing's lost — continue it/);
  assert.doesNotMatch(current, /four answers every tool inherits/);
  assert.doesNotMatch(current, /memory every tool can share/);
  assert.doesNotMatch(current, /Last audited .* against the published CLI/);
  assert.match(current, /prior tool transcript did not carry/i);
});
