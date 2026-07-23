const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const matrixUrl = pathToFileURL(path.join(
  __dirname,
  '../../intent/app/supabase/tests/project-captures-live-check.mjs',
)).href;

test('capture live-check target requires loopback or an exact trusted HTTPS origin', async () => {
  const { trustedCaptureTestBase } = await import(matrixUrl);
  assert.equal(
    trustedCaptureTestBase('http://127.0.0.1:54321/'),
    'http://127.0.0.1:54321',
  );
  assert.equal(
    trustedCaptureTestBase('https://test.example.dev', 'https://test.example.dev'),
    'https://test.example.dev',
  );
  assert.throws(
    () => trustedCaptureTestBase('http://test.example.dev', 'http://test.example.dev'),
    /must use HTTPS/,
  );
  assert.throws(
    () => trustedCaptureTestBase('https://test.example.dev'),
    /exact HTTPS origin/,
  );
  assert.throws(
    () => trustedCaptureTestBase('https://test.example.dev/path', 'https://test.example.dev'),
    /must be an origin/,
  );
});

test('capture live-check fixtures cover real image, audio, and text bytes', async () => {
  const { captureFixtures } = await import(matrixUrl);
  const fixtures = captureFixtures();
  assert.deepEqual(fixtures.map((fixture) => fixture.kind), ['image', 'audio', 'text']);
  assert.ok(fixtures.every((fixture) => fixture.bytes.length > 0));
  assert.equal(fixtures[0].bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(fixtures[1].bytes.subarray(0, 4).toString(), 'RIFF');
  assert.match(fixtures[2].bytes.toString(), /private capture acceptance/);
});

test('capture live-check removes private test data through the product protocol', () => {
  const source = fs.readFileSync(new URL(matrixUrl), 'utf8');
  assert.match(source, /prepare_capture_task_deletion/);
  assert.match(source, /storage\/v1\/object\/\$\{BUCKET\}/);
  assert.match(source, /finalize_capture_task_deletion/);
  assert.match(source, /finalization removes every immutable capture manifest row/);
  assert.match(source, /private cloud inputs were removed/);
});
