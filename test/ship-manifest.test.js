// Every page the site links to must actually be staged for deploy.
//
// `ship.sh` copies only the paths in SHIP_MANIFEST. A page can therefore exist,
// build cleanly, pass its own tests, and still never reach production — which
// is exactly what happened to /x, /build and the live room: all three were
// finished and none of them would ever have shipped.
//
// This binds the two together: if the shared nav links a route, the manifest
// has to carry it.

const baseTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../skills/catalog.json');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

// These assertions read the monorepo's website sources, which are NOT part of
// the public cli/ mirror (ship.sh rsyncs only cli/). Outside the monorepo they
// skip rather than fail on a missing path — a test that cannot pass where it is
// published is noise, not a guard.
const MONOREPO = fs.existsSync(path.join(ROOT, 'ship.sh'));
const test = MONOREPO ? baseTest : baseTest.skip;


/** The quoted paths inside the SHIP_MANIFEST=( ... ) array, comments excluded. */
function shipManifest() {
  const sh = read('ship.sh');
  const start = sh.indexOf('SHIP_MANIFEST=(');
  assert.ok(start > -1, 'ship.sh must declare SHIP_MANIFEST');
  const body = sh.slice(start, sh.indexOf('\n)', start));
  return body
    .split('\n')
    .map((l) => l.replace(/#.*$/, '')) // a commented-out path is not shipped
    .join('\n')
    .match(/"([^"]+)"/g)
    ?.map((s) => s.slice(1, -1)) ?? [];
}

/** Routes the shared nav points at — the site's own promise of what exists. */
function navRoutes() {
  const nav = read('assets/nav.js');
  const hrefs = nav.match(/href=["'](\/[a-z0-9-]*)\/?["']/g) ?? [];
  const mi = nav.match(/mi\(\s*['"](\/[a-z0-9-]+)['"]/g) ?? [];
  const all = [...hrefs, ...mi]
    .map((m) => (m.match(/(\/[a-z0-9-]*)/) || [])[1])
    .filter((r) => r && r !== '/');
  return [...new Set(all)];
}

const covers = (manifest, route) => {
  const dir = route.replace(/^\//, '') + '/';
  return manifest.some((p) => p === dir || p === `${dir}index.html` || p.startsWith(dir));
};

test('every route in the shared nav is staged for deploy', () => {
  const manifest = shipManifest();
  const missing = navRoutes().filter((r) => !covers(manifest, r));
  assert.deepEqual(
    missing,
    [],
    `linked from the nav but never shipped: ${missing.join(', ')} — add to SHIP_MANIFEST in ship.sh`
  );
});

test('pages that exist and are meant to be public are staged', () => {
  const manifest = shipManifest();
  // Not every directory in this monorepo is a public page, so this is an
  // explicit list rather than a filesystem sweep.
  for (const route of ['/x', '/build', '/desktop', '/cli', '/ion', '/platform', '/mcp', '/skills']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, route.slice(1), 'index.html')),
      `${route}/index.html should exist`
    );
    assert.ok(covers(manifest, route), `${route} exists but is not in SHIP_MANIFEST`);
  }
});

test('Skills Atlas output is staged by exact generated paths, never a directory sweep', () => {
  const manifest = shipManifest();
  const generated = [
    'skills/index.html',
    'skills/catalog.json',
    ...catalog.entries
      .filter(entry => entry.source_path)
      .map(entry => `skills/${entry.id}/SKILL.md`),
  ];

  assert.ok(!manifest.includes('skills/'), 'skills/ would sweep unrelated files into a release');
  for (const file of generated) {
    assert.ok(manifest.includes(file), `${file} is generated but absent from SHIP_MANIFEST`);
  }
});

test('ship verifies the complete staged index before it creates a commit', () => {
  const sh = read('ship.sh');
  const staging = sh.indexOf('git add "$p"');
  const verifier = sh.indexOf('node scripts/verify-ship-index.mjs');
  const commit = sh.indexOf('git commit -m');

  assert.ok(staging > -1 && verifier > staging, 'the index verifier must run after manifest staging');
  assert.ok(commit > verifier, 'the index verifier must run before git commit');
});

// The live room is deliberately withheld until its Realtime authorization
// policy is applied. If someone stages it, the migration must be there too.
test('the live room stays out of the manifest until its policy exists', () => {
  const manifest = shipManifest();
  const staged = covers(manifest, '/intent/live');
  const migration = 'intent/app/supabase/migrations/20260726010000_realtime_room_access.sql';
  assert.ok(
    fs.existsSync(path.join(ROOT, migration)),
    'the Realtime authorization migration must exist'
  );
  if (staged) {
    // Shipping it is a deliberate act, and this test is where the reason is
    // recorded: applying the migration is a database change no test can see.
    assert.ok(
      read('ship.sh').includes('20260726010000_realtime_room_access'),
      'if intent/live/ is staged, ship.sh must still name the migration it depends on'
    );
  }
});

test('the negative control: a bogus nav route would be caught', () => {
  const manifest = shipManifest();
  assert.equal(covers(manifest, '/definitely-not-a-real-route'), false);
});
