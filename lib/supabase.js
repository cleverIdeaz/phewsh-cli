// Supabase REST client for the CLI — no SDK, just fetch (Node 18+ built-in)

const SUPABASE_URL = 'https://fpnpfnahwaztdlxuayyv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_sL3R5aB43Yo5Ct0NQwB4fg_je9ccSHY';

async function req(path, options = {}, accessToken = null) {
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
async function upsert(table, data, accessToken) {
  const res = await req(`/rest/v1/${table}`, {
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

module.exports = { sendOtp, verifyOtp, refreshSession, select, upsert, trackSap, SUPABASE_URL, SUPABASE_ANON_KEY };
