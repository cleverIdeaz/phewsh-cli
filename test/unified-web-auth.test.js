const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const nav = read('assets/nav.js');
const delegatedSurfaces = [
  'ion/index.html',
  'StyleTree/index.html',
  'api/index.html',
  'chat/index.html',
];
const intentSources = [
  'intent/app/src/app/create/page.tsx',
  'intent/app/src/app/dashboard/page.tsx',
  'intent/app/src/app/loops/page.tsx',
  'intent/app/src/components/AuthButton.tsx',
  'intent/app/src/components/PhewshNav.tsx',
  'intent/app/src/lib/auth-context.tsx',
  'intent/app/src/lib/supabase.ts',
];

test('global nav owns every web sign-in method and uses one fixed callback', () => {
  assert.match(nav, /AUTH_CALLBACK_PATH = '\/intent\/dashboard'/);
  assert.match(nav, /url\.origin !== window\.location\.origin/);
  assert.match(nav, /sessionStorage\.setItem\(AUTH_RETURN_KEY/);
  assert.match(nav, /Date\.now\(\) - started > 15 \* 60 \* 1000/);
  assert.match(nav, /signInWithOAuth/);
  assert.match(nav, /signInWithOtp/);

  const delegated = [...delegatedSurfaces, ...intentSources]
    .map((file) => read(file))
    .join('\n');
  assert.doesNotMatch(delegated, /signInWithOAuth|signInWithOtp/);
});

test('every gated web surface delegates to Phewsh auth', () => {
  for (const file of delegatedSurfaces) {
    assert.match(read(file), /data-phewsh-auth/, `${file} must use the global auth trigger`);
  }
  for (const file of intentSources.slice(0, 5)) {
    assert.match(read(file), /openSignIn/, `${file} must use the shared Intent auth action`);
  }
  assert.match(read('intent/app/src/lib/phewsh-auth.ts'), /phewsh:auth-open/);
});

test('pages share one Supabase client and auth callbacks defer database work', () => {
  assert.match(nav, /if \(window\._pnSupabase\)/);
  assert.match(read('intent/app/src/components/NavLoader.tsx'), /_pnSupabase = appSupabase/);
  assert.match(read('StyleTree/index.html'), /window\._pnSupabase \|\| supabase\.createClient/);
  assert.match(read('ion/index.html'), /if \(window\._pnSupabase\)/);
  assert.match(read('api/index.html'), /if \(window\._pnSupabase\)/);

  for (const file of [
    'assets/nav.js',
    'ion/index.html',
    'StyleTree/index.html',
    'api/index.html',
    'intent/app/src/lib/auth-context.tsx',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /onAuthStateChange\(async\s*\(/, `${file} must not await inside auth callback`);
  }
  assert.match(nav, /setTimeout\(function\(\) \{ syncAuthView/);
  assert.match(read('ion/index.html'), /setTimeout\(\(\) => boot\(\), 0\)/);
  assert.match(read('StyleTree/index.html'), /setTimeout\(\(\) => applyAuthSession/);
  assert.match(read('api/index.html'), /setTimeout\(\(\) => showKeyManager/);
  assert.match(read('intent/app/src/lib/auth-context.tsx'), /setTimeout\(\(\) => fetchProfile/);
});
