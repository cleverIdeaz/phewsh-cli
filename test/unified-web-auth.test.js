const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const nav = read('assets/nav.js');
const delegatedSurfaces = [
  'ion/classic.html',
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

test('shared navigation exposes the canonical Workspace without disguising the account dashboard', () => {
  assert.match(nav, /href="\/intent\/app" class="pn-nav-link">Workspace<\/a>/);
  assert.match(nav, /mi\('\/intent\/app', 'Workspace'/);
  assert.match(nav, /mi\('\/intent\/dashboard', 'Account'/);
  assert.match(nav, /activeIntentRoute = \['\/intent\/app', '\/intent\/dashboard'\]/);
  assert.match(nav, /if \(activeIntentRoute && href !== activeIntentRoute\) return false/);
  assert.match(read('intent/app/src/components/PhewshNav.tsx'), /href="\/intent\/app"[\s\S]*?<span>My Workspace<\/span>/);
  assert.match(read('intent/app/src/app/dashboard/page.tsx'), /href="\/intent\/app"[\s\S]*?<span className="text-\[10px\] font-medium">Workspace<\/span>/);
});

test('the Ion shell explains the real record without sample activity or invented connections', () => {
  const workspace = read('intent/app/src/app/app/page.tsx');
  assert.match(workspace, /The workspace above every AI workspace\./);
  assert.match(workspace, /decisions, handoffs, evidence, and the exact work waiting on a person/);
  assert.match(workspace, /it never invents sample activity or claims shared model memory/);
  assert.match(workspace, /Routing preference only — no connection claimed/);
  assert.match(workspace, /never invented, and not cryptographic provider identity/);
  assert.match(workspace, /claim, review, merge, or reconcile/);
  assert.match(workspace, /humanWaitReason\(task\.status\)/);
  assert.match(workspace, /Phewsh will not manufacture a timeline/);
  assert.match(workspace, /The harness changes\. The project truth does not/);
  assert.doesNotMatch(workspace, /more waiting below in Next/);
  assert.doesNotMatch(workspace, /Each count opens into its recorded source below/);
  assert.doesNotMatch(workspace, /No active cloud work|No harness activity has been recorded yet/);

  // Regressions found live on Jul 20: null member names crashed the whole
  // shell; acceptance checks hard-blocked sending; project views floated
  // free of the selected project.
  assert.match(workspace, /member\.name \|\| "member"/);
  assert.doesNotMatch(workspace, /\bmember\.name\.slice\(/);
  assert.match(workspace, /class ViewBoundary/);
  assert.match(workspace, /the human reviewer defines done/);
  assert.match(workspace, /aria-label="Project views"/);
  const workPacket = read('intent/app/src/lib/workspace-work.ts');
  assert.doesNotMatch(workPacket, /At least one acceptance check is required/);
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
  assert.match(read('ion/classic.html'), /if \(window\._pnSupabase\)/);
  assert.match(read('api/index.html'), /if \(window\._pnSupabase\)/);

  for (const file of [
    'assets/nav.js',
    'ion/classic.html',
    'StyleTree/index.html',
    'api/index.html',
    'intent/app/src/lib/auth-context.tsx',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /onAuthStateChange\(async\s*\(/, `${file} must not await inside auth callback`);
  }
  assert.match(nav, /setTimeout\(function\(\) \{ syncAuthView/);
  assert.match(read('ion/classic.html'), /setTimeout\(\(\) => boot\(\), 0\)/);
  assert.match(read('StyleTree/index.html'), /setTimeout\(\(\) => applyAuthSession/);
  assert.match(read('api/index.html'), /setTimeout\(\(\) => showKeyManager/);
  assert.match(read('intent/app/src/lib/auth-context.tsx'), /setTimeout\(\(\) => fetchProfile/);
});

test('production Intent builds cannot silently omit the public auth runtime', () => {
  const runtime = JSON.parse(read('intent/app/public-runtime.json'));
  const config = read('intent/app/next.config.ts');

  assert.equal(new URL(runtime.supabaseUrl).hostname, 'fpnpfnahwaztdlxuayyv.supabase.co');
  assert.match(runtime.supabasePublishableKey, /^sb_publishable_[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(runtime.supabaseUrl, /your-project|example/i);
  assert.doesNotMatch(runtime.supabasePublishableKey, /your-|example/i);
  assert.match(config, /NEXT_PUBLIC_SUPABASE_URL: supabaseUrl/);
  assert.match(config, /NEXT_PUBLIC_SUPABASE_ANON_KEY: supabasePublishableKey/);
  assert.match(config, /Public Supabase runtime configuration is required/);
});
