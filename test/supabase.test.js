const test = require('node:test');
const assert = require('node:assert/strict');
const {
  upsert,
  resolveSupabaseConfig,
  assertSupabaseTokenTarget,
} = require('../lib/supabase');

function tokenForIssuer(issuer) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ iss: issuer })}.signature`;
}

test('cloud endpoint overrides are paired and transport-safe', () => {
  assert.deepEqual(
    resolveSupabaseConfig({
      PHEWSH_SUPABASE_URL: 'http://127.0.0.1:54321/',
      PHEWSH_SUPABASE_ANON_KEY: 'local-anon',
    }),
    {
      url: 'http://127.0.0.1:54321',
      anonKey: 'local-anon',
      custom: true,
    },
  );
  assert.equal(
    resolveSupabaseConfig({
      PHEWSH_SUPABASE_URL: 'https://cloud.example.test',
      PHEWSH_SUPABASE_ANON_KEY: 'self-hosted-anon',
    }).url,
    'https://cloud.example.test',
  );
  assert.throws(
    () => resolveSupabaseConfig({ PHEWSH_SUPABASE_URL: 'https://cloud.example.test' }),
    /must be set together/,
  );
  assert.throws(
    () => resolveSupabaseConfig({
      PHEWSH_SUPABASE_URL: 'http://cloud.example.test',
      PHEWSH_SUPABASE_ANON_KEY: 'unsafe',
    }),
    /must use HTTPS/,
  );
  assert.throws(
    () => resolveSupabaseConfig({
      PHEWSH_SUPABASE_URL: 'https://cloud.example.test/surprise',
      PHEWSH_SUPABASE_ANON_KEY: 'unsafe',
    }),
    /must be an origin/,
  );
});

test('session JWTs cannot cross Supabase origin boundaries', () => {
  const localToken = tokenForIssuer('http://127.0.0.1:54321/auth/v1');
  const hostedToken = tokenForIssuer('https://cloud.example.test/auth/v1');
  assert.doesNotThrow(() => (
    assertSupabaseTokenTarget(localToken, 'http://127.0.0.1:54321', true)
  ));
  assert.throws(
    () => assertSupabaseTokenTarget(hostedToken, 'http://127.0.0.1:54321', true),
    /different origin/,
  );
  assert.throws(
    () => assertSupabaseTokenTarget('opaque-session', 'http://127.0.0.1:54321', true),
    /requires a session JWT/,
  );
});

test('upsert can target a composite unique constraint explicitly', async () => {
  const originalFetch = global.fetch;
  let request = null;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => [] };
  };

  try {
    await upsert('artifacts', { project_id: 'p1', kind: 'vision', content: 'truth' }, 'token', {
      onConflict: ['project_id', 'kind'],
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.match(request.url, /\/rest\/v1\/artifacts\?on_conflict=project_id%2Ckind$/);
  assert.equal(request.options.method, 'POST');
  assert.match(request.options.headers.Prefer, /resolution=merge-duplicates/);
});
