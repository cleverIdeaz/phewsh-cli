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

test('linked packs are not vendored', () => {
  const d = tmp();
  const linked = Object.entries(packs.PACKS)
    .filter(([, p]) => p.kind === 'linked')
    .map(([name]) => name);

  assert.ok(linked.includes('gsd'));
  assert.ok(linked.includes('loop-library'));
  assert.ok(linked.includes('unlimited-ocr'));
  assert.ok(linked.includes('skillspector'));

  for (const name of linked) {
    const { written } = packs.install(name, d);
    assert.equal(written.length, 0, `${name} writes nothing`);
    assert.equal(packs.isInstalled(name, d), false, `${name} is never marked installed locally`);
    assert.equal(packs.previewInstall(name, d), null, `${name} has no vendored preview`);
  }

  fs.rmSync(d, { recursive: true, force: true });
});
