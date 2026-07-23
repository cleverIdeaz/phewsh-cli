// Supabase REST client for the CLI — no SDK, just fetch (Node 18+ built-in)

const HOSTED_SUPABASE_URL = 'https://fpnpfnahwaztdlxuayyv.supabase.co';
const HOSTED_SUPABASE_ANON_KEY = 'sb_publishable_sL3R5aB43Yo5Ct0NQwB4fg_je9ccSHY';

function resolveSupabaseConfig(env = process.env) {
  const customUrl = String(env.PHEWSH_SUPABASE_URL || '').trim();
  const customKey = String(env.PHEWSH_SUPABASE_ANON_KEY || '').trim();

  if (!customUrl && !customKey) {
    return {
      url: HOSTED_SUPABASE_URL,
      anonKey: HOSTED_SUPABASE_ANON_KEY,
      custom: false,
    };
  }
  if (!customUrl || !customKey) {
    throw new Error(
      'PHEWSH_SUPABASE_URL and PHEWSH_SUPABASE_ANON_KEY must be set together.',
    );
  }

  let parsed;
  try {
    parsed = new URL(customUrl);
  } catch {
    throw new Error('PHEWSH_SUPABASE_URL must be a valid absolute URL.');
  }

  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(
      'PHEWSH_SUPABASE_URL must use HTTPS; plain HTTP is allowed only on loopback.',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('PHEWSH_SUPABASE_URL must be an origin without credentials, path, query, or fragment.');
  }

  return {
    url: parsed.origin,
    anonKey: customKey,
    custom: true,
  };
}

const resolvedSupabase = resolveSupabaseConfig();
const SUPABASE_URL = resolvedSupabase.url;
const SUPABASE_ANON_KEY = resolvedSupabase.anonKey;

function assertSupabaseTokenTarget(
  accessToken,
  targetUrl = SUPABASE_URL,
  requireIssuer = resolvedSupabase.custom,
) {
  if (!accessToken) return;
  let issuer = '';
  try {
    const parts = String(accessToken).split('.');
    if (parts.length === 3) {
      issuer = String(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).iss || '')
        .replace(/\/+$/u, '');
    }
  } catch {
    issuer = '';
  }

  const expected = `${String(targetUrl).replace(/\/+$/u, '')}/auth/v1`;
  if (!issuer) {
    if (requireIssuer) {
      throw new Error(
        'The selected custom Supabase origin requires a session JWT issued by that origin. '
        + 'Sign out, then log in again with the same endpoint override.',
      );
    }
    return;
  }
  if (issuer !== expected) {
    throw new Error(
      'The stored Supabase session belongs to a different origin. '
      + 'Sign out, then log in again with the selected endpoint override.',
    );
  }
}

async function req(path, options = {}, accessToken = null) {
  assertSupabaseTokenTarget(accessToken);
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    ...options.headers,
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers,
  });
  return res;
}

// Send numeric OTP to email (omitting redirect_to forces a code, not a magic link)
async function sendOtp(email) {
  const res = await req('/auth/v1/otp', {
    method: 'POST',
    body: JSON.stringify({ email, create_user: true }),
  });
  return res.ok;
}

// Verify OTP token and return session
async function verifyOtp(email, token) {
  const res = await req('/auth/v1/verify', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', email, token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.msg || 'OTP verification failed');
  }
  return res.json(); // { access_token, refresh_token, user }
}

// Refresh a Supabase session
async function refreshSession(refreshToken) {
  const res = await req('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  return res.json();
}

// REST: select rows
async function select(table, query = '', accessToken) {
  const res = await req(`/rest/v1/${table}?${query}`, {
    method: 'GET',
    headers: { 'Prefer': 'return=representation' },
  }, accessToken);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `SELECT ${table} failed`);
  }
  return res.json();
}

// REST: upsert (insert or update)
async function upsert(table, data, accessToken, { onConflict } = {}) {
  const conflict = Array.isArray(onConflict) && onConflict.length
    ? `?on_conflict=${encodeURIComponent(onConflict.join(','))}`
    : '';
  const res = await req(`/rest/v1/${table}${conflict}`, {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(data),
  }, accessToken);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `UPSERT ${table} failed`);
  }
  return res.json();
}

// REST: insert rows (no upsert semantics)
async function insert(table, data, accessToken) {
  const res = await req(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(data),
  }, accessToken);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `INSERT ${table} failed`);
  }
  return res.json();
}

// Storage: authenticated private-object download. The caller validates the
// manifest byte count and digest before exposing the result to a harness.
async function downloadStorageObject(bucket, objectPath, accessToken) {
  const encodedBucket = encodeURIComponent(String(bucket || ''));
  const encodedPath = String(objectPath || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const res = await req(`/storage/v1/object/${encodedBucket}/${encodedPath}`, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream' },
  }, accessToken);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `Storage download failed (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// REST: call a Postgres function (used for the atomic task transitions —
// claim_task, start_execution, complete_execution, open_pr, review_task).
async function rpc(fn, args = {}, accessToken) {
  const res = await req(`/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(args),
  }, accessToken);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.message || `${fn} failed (${res.status})`);
  }
  return body;
}

// SAP: fire-and-forget per-inference tracking
// Session ID — unique per CLI invocation, enables multi-prompt correlation
const { randomUUID } = require('crypto');
const CLI_SESSION_ID = randomUUID();

// kWh estimates by model family (conservative)
const MODEL_KWH = {
  'claude-haiku':   0.00025,
  'claude-sonnet':  0.00060,
  'claude-opus':    0.00200,
  'gemini-flash':   0.00020,
  'deepseek':       0.00030,
  'kimi':           0.00040,
};

function estimateKwh(model, totalTokens) {
  let base = 0.0004;
  if (model) {
    const lower = model.toLowerCase();
    for (const [key, val] of Object.entries(MODEL_KWH)) {
      if (lower.includes(key)) { base = val; break; }
    }
  }
  const scale = Math.max(0.5, Math.min(4, (totalTokens || 1000) / 1000));
  return base * scale;
}

function trackSap({ userId, source = 'cli', model, promptTokens, completionTokens, accessToken } = {}) {
  const totalTokens = (promptTokens || 0) + (completionTokens || 0);
  const kwh = estimateKwh(model, totalTokens);
  const co2_g = kwh * 500;   // US grid avg gCO2/kWh
  const water_ml = kwh * 1800;

  req('/rest/v1/rpc/track_sap_event', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id:           userId || null,
      p_session_id:        CLI_SESSION_ID,
      p_source:            source,
      p_model:             model || null,
      p_prompt_tokens:     promptTokens || null,
      p_completion_tokens: completionTokens || null,
      p_kwh:               kwh,
      p_co2_g:             co2_g,
      p_water_ml:          water_ml,
    }),
  }, accessToken).catch(() => { /* never surface SAP errors */ });
}

module.exports = {
  sendOtp,
  verifyOtp,
  refreshSession,
  select,
  upsert,
  insert,
  rpc,
  downloadStorageObject,
  trackSap,
  resolveSupabaseConfig,
  assertSupabaseTokenTarget,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
};
