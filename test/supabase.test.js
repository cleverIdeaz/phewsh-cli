const test = require('node:test');
const assert = require('node:assert/strict');
const { upsert } = require('../lib/supabase');

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
