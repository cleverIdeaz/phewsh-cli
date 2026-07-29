// Origin policy for the loopback node.
//
// This is defense-in-depth and NOTHING MORE. An Origin header is a statement
// by the caller's browser about the caller's browser; it is not authentication
// and must never be treated as authority. Authorization lives in
// lib/capability-grants.js, behind a human-approved pairing. Two consequences
// are load-bearing here:
//
//   1. A MISSING Origin is not trusted. It used to pass whenever
//      sec-fetch-site was not 'cross-site', which meant any local process — and
//      any browser request that simply omitted the header — sailed through the
//      only check there was.
//
//   2. Development origins are OPT-IN. http://localhost:3000 was permanently
//      allowlisted, so whatever app happened to occupy port 3000 inherited the
//      node's trust. Real local development sets PHEWSH_ALLOWED_ORIGINS.

const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://phewsh.com',
  'https://www.phewsh.com',
  // Phewsh Desktop (Tauri) hosts the same bundled Ion frontend from the system
  // webview's own app origin. WKWebView (macOS/iOS) serves it as
  // tauri://localhost; the Windows/Android webview uses http://tauri.localhost.
  // Allowlisting these lets a Desktop-hosted Ion reach this loopback node
  // directly — and, because the system webview is not Chromium, without any
  // Local/Private Network Access prompt. Still loopback-only, allowlist-only,
  // and still subject to the same grants as every other caller.
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
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

/**
 * Whether this request may be answered at all. Passing means only "you may
 * speak to this node" — never "you may act on it".
 *
 * A request with no Origin at all is allowed to reach the router so that
 * liveness and the native/CLI channel keep working, but it carries the
 * `no-origin` principal, which no grant is ever issued to over HTTP. It can
 * therefore read `/health` and nothing else.
 */
function isAllowedRequest(req) {
  const origin = requestOrigin(req);
  if (origin) return allowedOrigins().has(origin);
  // No Origin: never cross-site, and never trusted — grants still decide.
  return req.headers['sec-fetch-site'] !== 'cross-site';
}

function corsHeaders(req) {
  const origin = requestOrigin(req);
  if (!origin || !allowedOrigins().has(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // The grant headers a real browser will send. Omitting a header here makes
    // every browser call fail the preflight while every node-to-node test stays
    // green — the exact trap that cost a full debugging cycle last time, because
    // a preflight only exists in a real browser.
    'Access-Control-Allow-Headers': [
      'Content-Type',
      'Authorization',
      'X-Phewsh-Runtime',
      'X-Phewsh-Local-Session',
      'X-Phewsh-Host-Grant',
      'X-Phewsh-Project-Grant',
      'X-Phewsh-Client',
    ].join(', '),
    // Chrome Local/Private Network Access: an HTTPS page (phewsh.com) fetching
    // plain-http loopback gets a preflight carrying Access-Control-Request-
    // Private-Network; without this answer Chrome kills the request before it
    // is ever sent — the cockpit shows "bridge offline" while serve is
    // demonstrably up. Loopback-only server, allowlisted origins only.
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

module.exports = {
  corsHeaders,
  isAllowedRequest,
  allowedOrigins,
  requestOrigin,
};
