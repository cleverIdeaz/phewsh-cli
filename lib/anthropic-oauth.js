/**
 * Anthropic subscription (Claude Pro/Max) OAuth — PKCE flow.
 *
 * This mirrors how Claude Code / third-party harnesses log in with a Claude
 * subscription instead of a console API key. It reuses Anthropic's public
 * Claude Code OAuth client.
 *
 * NOTE: Subscription usage through a third-party client draws from "extra
 * usage" and is billed per token (see claude.ai/settings/usage). It is an
 * unofficial integration path and may change at any time. For distributed
 * software, prefer a plain ANTHROPIC_API_KEY.
 */

const crypto = require('crypto');

// Anthropic's public Claude Code OAuth client id.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

// Beta header required for OAuth-token (subscription) requests to the
// Messages API.
const OAUTH_BETA = 'oauth-2025-04-20';

// Subscription OAuth requires the Claude Code identity as the first system
// block, otherwise the API rejects the request.
const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

function base64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Generate PKCE verifier + S256 challenge and an anti-CSRF state. */
function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(32));
  return { verifier, challenge, state };
}

/** Build the URL the user opens in the browser to authorize. */
function buildAuthUrl(pkce) {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchange the code the user pasted back for tokens.
 * The pasted value is in the form `code#state` (Anthropic appends state).
 */
async function exchangeCode(pastedCode, pkce) {
  const [code, returnedState] = String(pastedCode).trim().split('#');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: returnedState || pkce.state,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return normalizeTokens(await res.json());
}

/** Refresh an expired access token using the stored refresh token. */
async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }
  return normalizeTokens(await res.json());
}

function normalizeTokens(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // expires_in is seconds from now; store an absolute ms timestamp.
    expiresAt: Date.now() + (Number(data.expires_in || 0) * 1000),
    scope: data.scope,
  };
}

/**
 * Given the saved config, return a valid access token, refreshing and
 * persisting it if it is expired (or within the 60s skew window).
 * `save(config)` is the caller's persistence function.
 */
async function getValidAccessToken(config, save) {
  const oauth = config.anthropicOAuth;
  if (!oauth?.accessToken) return null;

  const skewMs = 60 * 1000;
  if (oauth.expiresAt && Date.now() < oauth.expiresAt - skewMs) {
    return oauth.accessToken;
  }

  if (!oauth.refreshToken) return oauth.accessToken; // best effort
  const fresh = await refreshTokens(oauth.refreshToken);
  config.anthropicOAuth = { ...oauth, ...fresh };
  if (typeof save === 'function') save(config);
  return fresh.accessToken;
}

module.exports = {
  CLIENT_ID,
  OAUTH_BETA,
  CLAUDE_CODE_IDENTITY,
  createPkce,
  buildAuthUrl,
  exchangeCode,
  refreshTokens,
  getValidAccessToken,
};
