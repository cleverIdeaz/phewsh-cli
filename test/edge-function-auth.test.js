// Pins the JWT-rotation safety contract from
// handoffs/JWT_ROTATION_AUDIT_2026-07-20.md: no Edge Function may depend on
// the platform gateway's JWT verification (which has documented ES256 failures
// after rotating off the legacy HS256 secret). Every function either validates
// the caller in-function via supabase.auth.getUser() or is public by design
// with its own rate limiting — and each one is explicitly verify_jwt = false.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const fnDir = path.join(root, 'intent', 'app', 'supabase', 'functions');
const configToml = fs.readFileSync(
  path.join(root, 'intent', 'app', 'supabase', 'config.toml'), 'utf8');

// Functions that authenticate the user themselves (must contain getUser()).
const userAuthed = [
  'claim-pending-credits',
  'create-checkout-session',
  'create-portal-session',
  'create-credit-checkout',
  'intent-cloud-execute',
  'pod-create-checkout',
  'pod-create-order',
  'pod-upload-url',
  'pod-fetch-pdf',
  'mcp',
];

// Public by design: fingerprint rate limiting, callers send the public
// publishable key. Gateway JWT checks never protected these.
const publicByDesign = ['intent-free-tts', 'intent-free-whisper'];

// The 12 functions the dashboard rotation warning named (minus
// make-server-9a299ea0, which is not managed from this repo) plus the three
// that were already off — all must be explicit verify_jwt = false.
const mustBeVerifyJwtOff = [
  'claim-pending-credits',
  'create-checkout-session',
  'create-portal-session',
  'create-credit-checkout',
  'intent-cloud-execute',
  'intent-free-tts',
  'intent-free-whisper',
  'pod-create-checkout',
  'pod-create-order',
  'pod-upload-url',
  'pod-fetch-pdf',
  'stripe-webhook',
  'chat-completions',
  'mcp',
];

const readFn = (name) => {
  const dir = path.join(fnDir, name);
  return fs.readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
};

test('user-authenticated functions validate in-function with getUser()', () => {
  for (const name of userAuthed) {
    const src = readFn(name);
    assert.match(src, /auth\.getUser\(/,
      `${name} must call supabase.auth.getUser() so auth does not depend on the platform gateway`);
  }
});

test('no function verifies JWTs manually against the legacy secret', () => {
  for (const name of fs.readdirSync(fnDir)) {
    if (name.startsWith('.') || name === '_shared') continue;
    if (!fs.statSync(path.join(fnDir, name)).isDirectory()) continue;
    const src = readFn(name);
    assert.ok(!/JWT_SECRET|jwtVerify|jwt\.verify\(|['"]HS256['"]/.test(src),
      `${name} must not hand-verify JWTs with the legacy HS256 secret (breaks on ES256 rotation)`);
  }
});

test('every rotation-affected function is explicitly verify_jwt = false', () => {
  for (const name of mustBeVerifyJwtOff) {
    const block = new RegExp(
      `\\[functions\\.${name}\\]\\s*\\nverify_jwt = false`);
    assert.match(configToml, block,
      `config.toml must pin [functions.${name}] verify_jwt = false`);
  }
});

test('public-by-design functions carry their own rate limiting', () => {
  for (const name of publicByDesign) {
    const src = readFn(name);
    assert.match(src, /fingerprint/i,
      `${name} is public by design and must keep fingerprint rate limiting`);
  }
});
