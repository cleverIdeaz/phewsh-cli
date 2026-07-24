// phewsh status --json — the structured contract the desktop shell (and any
// other machine consumer) reads instead of scraping human terminal output.
// Guards: stable schema, valid JSON, no ANSI, human output unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bin = path.join(__dirname, '..', 'bin', 'phewsh.js');

function makeTempProject({ withIntent = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-status-json-'));
  if (withIntent) {
    fs.mkdirSync(path.join(dir, '.intent'));
    fs.writeFileSync(
      path.join(dir, '.intent', 'project.json'),
      JSON.stringify({ name: 'Status JSON Fixture' }),
    );
    fs.writeFileSync(path.join(dir, '.intent', 'vision.md'), '# Vision\nFixture.\n');
  }
  return dir;
}

function run(args, cwd, home) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
  });
}

test('status --json emits valid JSON with the stable v1 schema', () => {
  const project = makeTempProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-home-'));
  const result = run(['status', '--json'], project, home);

  assert.equal(result.status, 0, result.stderr);
  // Machine output must be clean: parseable, no ANSI escapes.
  assert.doesNotMatch(result.stdout, /\x1b\[/);
  const data = JSON.parse(result.stdout);

  assert.equal(data.schema, 2);
  assert.equal(typeof data.generatedAt, 'string');
  assert.equal(typeof data.version, 'string');

  // Device (desktop-shell contract): os + versions + serve endpoint pointer.
  assert.equal(typeof data.device.os, 'string');
  assert.equal(typeof data.device.cliVersion, 'string');
  assert.equal(data.device.serve.endpoint, 'http://127.0.0.1:7483');

  assert.equal(data.project.name, 'Status JSON Fixture');
  assert.equal(data.project.hasIntent, true);
  assert.equal(data.project.hasVision, true);
  assert.equal(typeof data.project.intentFiles, 'number');

  // Checkout (read-only Git state). The temp fixture isn't a git repo → isRepo:false.
  assert.equal(typeof data.checkout, 'object');
  assert.equal(data.checkout.isRepo, false);

  // Cloud link: the fixture has .intent/ but no cloud id.
  assert.equal(data.cloudLink.linked, false);
  assert.equal(data.cloudLink.intentPresent, true);
  assert.equal(data.cloudLink.intentValid, true);
  assert.equal(typeof data.cloudLink.registeredOnWorker, 'boolean');

  assert.equal(typeof data.next.counts.now, 'number');
  assert.equal(typeof data.next.counts.next, 'number');
  assert.equal(typeof data.next.counts.done, 'number');

  assert.equal(typeof data.work.tools, 'number');
  assert.equal(typeof data.record.decisions, 'number');
  assert.equal(typeof data.record.pending, 'number');
  assert.equal(typeof data.delivery.adaptersOn, 'boolean');
  assert.equal(typeof data.delivery.shims, 'number');
});

test('status --json is honest when no project truth exists', () => {
  const project = makeTempProject({ withIntent: false });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-home-'));
  const result = run(['status', '--json'], project, home);

  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.project.hasIntent, false);
  assert.equal(data.project.hasVision, false);
  assert.equal(data.project.intentFiles, 0);
});

test('human status output is unchanged by the json addition', () => {
  const project = makeTempProject();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-home-'));
  const result = run(['status'], project, home);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PHEWSH STATUS/);
  assert.match(result.stdout, /Status JSON Fixture/);
  // The human view must never accidentally become JSON.
  assert.throws(() => JSON.parse(result.stdout));
});
