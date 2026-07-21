const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const bin = path.join(root, 'cli', 'bin', 'phewsh.js');
const rejectFetch = path.join(__dirname, 'fixtures', 'reject-fetch.js');

function run(args, { rejectNetwork = false } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(rejectNetwork ? { NODE_OPTIONS: `--require=${rejectFetch}` } : {}),
    },
  });
}

test('packaged MCP proof command exposes the bounded operator without requiring credentials for help', () => {
  const result = run(['mcp', 'proof', 'help'], { rejectNetwork: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /phewsh mcp proof prepare/);
  assert.match(result.stdout, /phewsh mcp proof verify/);
  assert.match(result.stdout, /--native-capture <file> --evidence-out <file>/);
});

test('unknown MCP proof modes fail before reading credentials or contacting the network', () => {
  const result = run(['mcp', 'proof', 'unknown-mode'], { rejectNetwork: true });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stderr, /logged in|fetch|MCP HTTP/i);
});

test('the npm package carries one proof implementation and the repository path stays a thin wrapper', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'cli', 'package.json'), 'utf8'));
  const implementation = path.join(root, 'cli', 'lib', 'cross-provider-proof.mjs');
  const wrapper = fs.readFileSync(
    path.join(root, 'intent', 'app', 'supabase', 'tests', 'cross-provider-continuity-gate.mjs'),
    'utf8',
  );
  assert.equal(packageJson.files.includes('lib/'), true);
  assert.equal(fs.existsSync(implementation), true);
  assert.match(wrapper, /export \* from '\.\.\/\.\.\/\.\.\/\.\.\/cli\/lib\/cross-provider-proof\.mjs'/);
  assert.doesNotMatch(wrapper, /phewsh-cross-provider-continuity-evidence|function assessChallengeEvents/);
});

test('live continuity checks use the refresh-aware MCP token path instead of raw stored credentials', () => {
  for (const relative of [
    'intent/app/supabase/tests/workspace-continuity-live-check.mjs',
    'intent/app/supabase/tests/remote-mcp-live-check.mjs',
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.match(source, /require\('\.\.\/\.\.\/\.\.\/\.\.\/cli\/lib\/mcp-token'\)/, relative);
    assert.match(source, /await mintToken\(\)/, relative);
    assert.doesNotMatch(source, /apiKey\s*\|\||supabaseAccessToken/, relative);
  }
});
