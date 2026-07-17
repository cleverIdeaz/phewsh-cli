const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mintToken, decodeExpiry, REMOTE_MCP_URL } = require('../lib/mcp-token');
const { saveConfig, loadConfig } = require('../lib/config-file');

function fakeJwt(expSecondsFromNow) {
  const payload = Buffer.from(JSON.stringify({
    sub: 'user-1',
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })).toString('base64url');
  return `header.${payload}.sig`;
}

function tempConfig(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-mcptoken-'));
  const dir = path.join(root, '.phewsh');
  saveConfig(path.join(dir, 'config.json'), config);
  return { root, dir };
}

test('throws when not logged in', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-mcptoken-'));
  await assert.rejects(
    () => mintToken({ configDir: path.join(root, '.phewsh') }),
    /Not logged in/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('returns a still-valid token without refreshing', async () => {
  const jwt = fakeJwt(3600);
  const { root, dir } = tempConfig({ supabaseAccessToken: jwt, supabaseUserId: 'user-1' });
  let refreshed = false;
  const out = await mintToken({ configDir: dir, refresh: async () => { refreshed = true; } });
  assert.equal(out.token, jwt);
  assert.equal(refreshed, false);
  assert.equal(out.userId, 'user-1');
  assert.ok(out.expiresInMin > 50);
  assert.ok(out.addCommand.includes(REMOTE_MCP_URL));
  assert.ok(out.addCommand.includes(jwt));
  fs.rmSync(root, { recursive: true, force: true });
});

test('refreshes an expired token and persists the rotation', async () => {
  const oldJwt = fakeJwt(-60);
  const newJwt = fakeJwt(3600);
  const { root, dir } = tempConfig({
    supabaseAccessToken: oldJwt,
    supabaseRefreshToken: 'refresh-1',
  });
  const out = await mintToken({
    configDir: dir,
    refresh: async (rt) => {
      assert.equal(rt, 'refresh-1');
      return { access_token: newJwt, refresh_token: 'refresh-2' };
    },
  });
  assert.equal(out.token, newJwt);
  const saved = loadConfig(path.join(dir, 'config.json'));
  assert.equal(saved.supabaseAccessToken, newJwt);
  assert.equal(saved.supabaseRefreshToken, 'refresh-2');
  fs.rmSync(root, { recursive: true, force: true });
});

test('throws when expired and refresh fails', async () => {
  const { root, dir } = tempConfig({
    supabaseAccessToken: fakeJwt(-60),
    supabaseRefreshToken: 'refresh-1',
  });
  await assert.rejects(
    () => mintToken({ configDir: dir, refresh: async () => null }),
    /could not be refreshed/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('decodeExpiry handles malformed tokens', () => {
  assert.equal(decodeExpiry('not-a-jwt'), null);
  assert.equal(decodeExpiry(''), null);
});
