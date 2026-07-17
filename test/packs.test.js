const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const packs = require('../lib/packs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-pack-')); }

test('vendored pack installs a marked block, preserves user content, removes cleanly', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# CLAUDE.md\nmy own notes\n');

  const { written } = packs.install('karpathy-style', d);
  assert.ok(written.includes('CLAUDE.md'));
  const after = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf-8');
  assert.ok(after.includes('my own notes'), 'user content preserved');
  assert.ok(after.includes('phewsh-pack:karpathy-style START'), 'pack block added');
  assert.ok(packs.isInstalled('karpathy-style', d));

  // idempotent: installing again doesn't duplicate
  packs.install('karpathy-style', d);
  const twice = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf-8');
  assert.equal((twice.match(/phewsh-pack:karpathy-style START/g) || []).length, 1);

  const { removed } = packs.remove('karpathy-style', d);
  assert.ok(removed.includes('CLAUDE.md'));
  const cleaned = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf-8');
  assert.ok(cleaned.includes('my own notes'), 'user content survives removal');
  assert.ok(!cleaned.includes('phewsh-pack'), 'pack block gone');

  fs.rmSync(d, { recursive: true, force: true });
});

test('model-routing pack vendors the routing glossary and coexists with karpathy-style', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# CLAUDE.md\nmy own notes\n');

  assert.equal(packs.PACKS['model-routing'].kind, 'vendored');
  const { written } = packs.install('model-routing', d);
  assert.ok(written.includes('CLAUDE.md'));
  assert.ok(written.includes('AGENTS.md'));
  const after = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf-8');
  assert.ok(after.includes('routing glossary'), 'glossary content vendored');
  assert.ok(after.includes('10-80-10'), 'plan/execute split vendored');
  assert.ok(packs.isInstalled('model-routing', d));

  // two vendored packs coexist; removing one leaves the other intact
  packs.install('karpathy-style', d);
  packs.remove('model-routing', d);
  const cleaned = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf-8');
  assert.ok(!cleaned.includes('phewsh-pack:model-routing'), 'model-routing gone');
  assert.ok(cleaned.includes('phewsh-pack:karpathy-style START'), 'karpathy-style survives');
  assert.ok(cleaned.includes('my own notes'), 'user content survives');

  fs.rmSync(d, { recursive: true, force: true });
});

test('every vendored pack round-trips: install, no duplicate, remove, user content intact', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), '# CLAUDE.md\nmy own notes\n');
  const vendored = Object.entries(packs.PACKS)
    .filter(([, p]) => p.kind === 'vendored')
    .map(([name]) => name);
  assert.ok(vendored.includes('governance-audits'), 'governance-audits is vendored');
  assert.ok(vendored.length >= 3, 'catalog has grown past one pack');

  for (const name of vendored) {
    packs.install(name, d);
    assert.ok(packs.isInstalled(name, d), `${name} installs`);
    packs.install(name, d);
    const body = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf-8');
    assert.equal((body.match(new RegExp(`phewsh-pack:${name} START`, 'g')) || []).length, 1, `${name} does not duplicate`);
  }
  for (const name of vendored) {
    packs.remove(name, d);
    assert.ok(!packs.isInstalled(name, d), `${name} removes`);
  }
  const cleaned = fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf-8');
  assert.ok(cleaned.includes('my own notes'), 'user content survives full cycle');
  assert.ok(!cleaned.includes('phewsh-pack'), 'no pack residue');

  fs.rmSync(d, { recursive: true, force: true });
});

test('linked packs are not vendored', () => {
  const d = tmp();
  const linked = Object.entries(packs.PACKS)
    .filter(([, p]) => p.kind === 'linked')
    .map(([name]) => name);

  assert.ok(linked.includes('gsd'));
  assert.ok(linked.includes('loop-library'));
  assert.ok(linked.includes('unlimited-ocr'));
  assert.ok(linked.includes('skillspector'));
  assert.match(
    packs.PACKS['loop-library'].install,
    /npx skills add Forward-Future\/loop-library --skill loopy -g/,
    'loop-library points at the current upstream Loopy install command',
  );

  for (const name of linked) {
    const { written } = packs.install(name, d);
    assert.equal(written.length, 0, `${name} writes nothing`);
    assert.equal(packs.isInstalled(name, d), false, `${name} is never marked installed locally`);
    assert.equal(packs.previewInstall(name, d), null, `${name} has no vendored preview`);
  }

  fs.rmSync(d, { recursive: true, force: true });
});
