const test = require('node:test');
const assert = require('node:assert/strict');
const { corsHeaders, isAllowedRequest } = require('../lib/cors');

function request(headers = {}) {
  return { headers };
}

test('allows the production web app with an exact reflected origin', () => {
  const req = request({ origin: 'https://phewsh.com' });
  assert.equal(isAllowedRequest(req), true);
  assert.equal(corsHeaders(req)['Access-Control-Allow-Origin'], 'https://phewsh.com');
});

// http://localhost:3000 used to be permanently allowlisted, which meant
// whatever app happened to occupy port 3000 inherited the node's trust. Real
// local development opts in explicitly instead.
test('the local development origin is opt-in, not permanently trusted', () => {
  const req = request({ origin: 'http://localhost:3000' });
  assert.equal(isAllowedRequest(req), false);

  const previous = process.env.PHEWSH_ALLOWED_ORIGINS;
  process.env.PHEWSH_ALLOWED_ORIGINS = 'http://localhost:3000';
  try {
    assert.equal(isAllowedRequest(req), true);
    assert.equal(corsHeaders(req)['Access-Control-Allow-Origin'], 'http://localhost:3000');
  } finally {
    if (previous === undefined) delete process.env.PHEWSH_ALLOWED_ORIGINS;
    else process.env.PHEWSH_ALLOWED_ORIGINS = previous;
  }
});

test('allows the Phewsh Desktop (Tauri) webview origin and reflects it', () => {
  const req = request({ origin: 'tauri://localhost' });
  assert.equal(isAllowedRequest(req), true);
  assert.equal(corsHeaders(req)['Access-Control-Allow-Origin'], 'tauri://localhost');
  const win = request({ origin: 'http://tauri.localhost' });
  assert.equal(isAllowedRequest(win), true);
});

test('rejects an untrusted browser origin', () => {
  const req = request({ origin: 'https://example.com' });
  assert.equal(isAllowedRequest(req), false);
  assert.deepEqual(corsHeaders(req), {});
});

test('rejects cross-site browser requests that omit Origin', () => {
  const req = request({ 'sec-fetch-site': 'cross-site' });
  assert.equal(isAllowedRequest(req), false);
});

test('allows non-browser clients without Origin or fetch metadata', () => {
  assert.equal(isAllowedRequest(request()), true);
});

test('supports explicit additional origins through configuration', () => {
  const previous = process.env.PHEWSH_ALLOWED_ORIGINS;
  process.env.PHEWSH_ALLOWED_ORIGINS = 'https://preview.phewsh.test';
  try {
    const req = request({ origin: 'https://preview.phewsh.test' });
    assert.equal(isAllowedRequest(req), true);
  } finally {
    if (previous === undefined) delete process.env.PHEWSH_ALLOWED_ORIGINS;
    else process.env.PHEWSH_ALLOWED_ORIGINS = previous;
  }
});

test('the preflight allows the local-session header a browser must send', async () => {
  // Node-to-node tests never preflight, so this class of break is invisible to
  // them: the whole local run and closure flow failed in every browser while
  // the suite stayed green.
  const headers = corsHeaders(request({ origin: 'https://phewsh.com' }));
  assert.match(headers['Access-Control-Allow-Headers'], /X-Phewsh-Local-Session/i,
    'a browser cannot send the session token without this');
});
