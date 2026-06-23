const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://phewsh.com',
  'https://www.phewsh.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
]);

function allowedOrigins() {
  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
  for (const origin of (process.env.PHEWSH_ALLOWED_ORIGINS || '').split(',')) {
    const trimmed = origin.trim();
    if (trimmed) origins.add(trimmed);
  }
  return origins;
}

function requestOrigin(req) {
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function isAllowedRequest(req) {
  const origin = requestOrigin(req);
  if (origin) return allowedOrigins().has(origin);

  // CLI clients do not send browser fetch metadata. A browser can omit Origin
  // on some cross-site requests, so reject those before they reach any route.
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

function corsHeaders(req) {
  const origin = requestOrigin(req);
  if (!origin || !allowedOrigins().has(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Phewsh-Runtime',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

module.exports = {
  corsHeaders,
  isAllowedRequest,
};
