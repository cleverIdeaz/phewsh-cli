// `phewsh mcp token` — mint a fresh Supabase JWT for the remote MCP server.
// Pure logic lives here so tests can inject a config dir and a stubbed refresh.

const path = require('path');
const os = require('os');
const configFile = require('./config-file');
const { SUPABASE_URL } = require('./supabase');

const REMOTE_MCP_URL = `${SUPABASE_URL}/functions/v1/mcp`;

function decodeExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    if (!payload.exp) return null;
    return Math.max(0, Math.round((payload.exp * 1000 - Date.now()) / 60000));
  } catch {
    return null;
  }
}

// Returns { token, expiresInMin, userId, addCommand } or throws with a
// human-readable message. `refresh` is injectable for tests.
async function mintToken({ configDir, refresh } = {}) {
  const dir = configDir || path.join(os.homedir(), '.phewsh');
  const configPath = path.join(dir, 'config.json');
  const config = configFile.loadConfig(configPath);
  if (!config || !config.supabaseAccessToken) {
    throw new Error('Not logged in. Run `phewsh login` first.');
  }

  let token = config.supabaseAccessToken;
  let expiresInMin = decodeExpiry(token);

  // Refresh when expired or close to it, so the printed token is usable.
  if ((expiresInMin === null || expiresInMin < 5) && config.supabaseRefreshToken) {
    const doRefresh = refresh || require('./supabase').refreshSession;
    const session = await doRefresh(config.supabaseRefreshToken);
    if (session && session.access_token) {
      token = session.access_token;
      configFile.saveConfig(configPath, {
        ...config,
        supabaseAccessToken: session.access_token,
        supabaseRefreshToken: session.refresh_token || config.supabaseRefreshToken,
      });
      expiresInMin = decodeExpiry(token);
    }
  }

  if (expiresInMin !== null && expiresInMin <= 0) {
    throw new Error('Token expired and could not be refreshed. Run `phewsh login` again.');
  }

  return {
    token,
    expiresInMin,
    userId: config.supabaseUserId || null,
    addCommand: `claude mcp add --transport http phewsh ${REMOTE_MCP_URL} --header "Authorization: Bearer ${token}"`,
  };
}

module.exports = { mintToken, decodeExpiry, REMOTE_MCP_URL };
