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

test('allows the documented local development origin', () => {
  const req = request({ origin: 'http://localhost:3000' });
  assert.equal(isAllowedRequest(req), true);
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
