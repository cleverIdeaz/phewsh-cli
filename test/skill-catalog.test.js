const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getCatalogEntry, listCatalog, validateCatalog } = require('../lib/skill-catalog');

test('the Skills Atlas has one valid, uniquely identified catalog', () => {
  const entries = listCatalog({ view: 'atlas' });
  assert.doesNotThrow(() => validateCatalog(entries));
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  assert.equal(getCatalogEntry('intent').provenance, 'original');
  assert.equal(getCatalogEntry('intent').availability, 'available');
});

test('catalog relationships cannot point at entries the Atlas does not contain', () => {
  const entries = listCatalog({ view: 'atlas' });
  const broken = entries.map(entry => (
    entry.id === 'intent'
      ? { ...entry, related_entries: [...entry.related_entries, 'missing-skill'] }
      : entry
  ));

  assert.throws(
    () => validateCatalog(broken),
    /intent has unknown related entry missing-skill/,
  );
});

test('catalog trust claims require evidence and external work defaults to unreviewed', () => {
  const entries = listCatalog({ view: 'atlas' });
  for (const entry of entries) {
    if (entry.security_status === 'Phewsh tested') {
      assert.match(entry.tested_on, /^\d{4}-\d{2}-\d{2}$/, `${entry.id} needs a test date`);
      assert.ok(entry.test_evidence, `${entry.id} needs test evidence`);
    }
    if (entry.provenance === 'linked') {
      assert.equal(entry.security_status, 'Unreviewed', `${entry.id} must start unreviewed`);
    }
    if (entry.availability === 'planned') {
      assert.equal(entry.install_mode, 'none', `${entry.id} must not look installable`);
      assert.equal(entry.install_command, '', `${entry.id} must not publish a command`);
    }
  }
});

test('the pack view is a subset of available catalog entries with install guidance', () => {
  const packEntries = listCatalog({ view: 'packs' });
  assert.ok(packEntries.length > 0);
  for (const entry of packEntries) {
    assert.equal(entry.availability, 'available');
    assert.notEqual(entry.install_mode, 'none');
    assert.ok(entry.install_command || entry.install_mode === 'managed-block');
  }
});
