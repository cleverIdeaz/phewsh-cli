const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const record = require('../lib/record');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-rec-')); }

test('remember creates .intent/decisions.md with a dated line and a header', () => {
  const d = tmp();
  const r = record.remember('keep packs opt-in', d);
  assert.ok(r && r.date && r.text === 'keep packs opt-in');
  const fp = path.join(d, '.intent', 'decisions.md');
  assert.ok(fs.existsSync(fp), 'file created in .intent/');
  const raw = fs.readFileSync(fp, 'utf-8');
  assert.ok(raw.startsWith('# Decisions'), 'has a header');
  assert.match(raw, /- \d{4}-\d{2}-\d{2} — keep packs opt-in/);
});

test('remember appends (never overwrites) and notes() returns each line oldest-first', () => {
  const d = tmp();
  record.remember('first', d);
  record.remember('second', d);
  const ns = record.notes(d);
  assert.equal(ns.length, 2);
  assert.match(ns[0], /first$/);
  assert.match(ns[1], /second$/);
});

test('empty/whitespace text is a no-op; missing file yields no notes', () => {
  const d = tmp();
  assert.equal(record.remember('   ', d), null);
  assert.equal(record.remember('', d), null);
  assert.deepEqual(record.notes(d), []);
});

test('user prose between entries is preserved (append-only)', () => {
  const d = tmp();
  record.remember('one', d);
  const fp = path.join(d, '.intent', 'decisions.md');
  fs.appendFileSync(fp, '\nSome freeform note I typed by hand.\n');
  record.remember('two', d);
  const raw = fs.readFileSync(fp, 'utf-8');
  assert.ok(raw.includes('Some freeform note I typed by hand.'), 'hand-written content survives');
  assert.equal(record.notes(d).length, 2, 'only the dated lines count as notes');
});
