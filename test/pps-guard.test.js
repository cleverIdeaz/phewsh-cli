// The truth guard (decisions.md ruling, Jul 5 2026): .md files are user-owned
// truth; pps.json is the compiler's receipt. writeGuardedViews must never
// overwrite a file the human has edited — or one it never generated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPPS, readPPS, writeGuardedViews } = require('../lib/pps');

function tmpIntent() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-pps-'));
}

function freshPPS() {
  return createPPS({
    entity: 'demo',
    raw: 'a demo project',
    intent: { goal: 'ship the demo', success_criteria: ['it works'], tasks: [{ text: 'do the thing', type: 'do' }] },
  });
}

test('fresh directory: all three views written, hashes recorded', () => {
  const dir = tmpIntent();
  const { written, preserved } = writeGuardedViews(dir, freshPPS());
  assert.deepEqual(written.sort(), ['next.md', 'plan.md', 'vision.md']);
  assert.deepEqual(preserved, []);
  const saved = readPPS(dir);
  assert.equal(Object.keys(saved.generated.hashes).length, 3);
  assert.match(fs.readFileSync(path.join(dir, 'vision.md'), 'utf-8'), /provenance: compiled by phewsh clarify/);
});

test('unedited machine-owned views are regenerated on update', () => {
  const dir = tmpIntent();
  const pps = freshPPS();
  writeGuardedViews(dir, pps);
  const updated = readPPS(dir);
  updated.intent.goal = 'ship the demo, faster';
  const { written, preserved } = writeGuardedViews(dir, updated);
  assert.deepEqual(written.sort(), ['next.md', 'plan.md', 'vision.md']);
  assert.deepEqual(preserved, []);
  assert.match(fs.readFileSync(path.join(dir, 'vision.md'), 'utf-8'), /faster/);
});

test('a hand-edited view is preserved, the rest regenerate', () => {
  const dir = tmpIntent();
  const pps = freshPPS();
  writeGuardedViews(dir, pps);
  fs.writeFileSync(path.join(dir, 'vision.md'), '# Vision\n\nMy own words. Hands off.\n');
  const updated = readPPS(dir);
  updated.intent.goal = 'a new goal';
  const { written, preserved } = writeGuardedViews(dir, updated);
  assert.deepEqual(preserved, ['vision.md']);
  assert.deepEqual(written.sort(), ['next.md', 'plan.md']);
  assert.match(fs.readFileSync(path.join(dir, 'vision.md'), 'utf-8'), /My own words/);
});

test('pre-existing hand-authored files (no pps yet) are never claimed', () => {
  // The phewsh-repo scenario: a rich hand-written .intent/ and no pps.json.
  const dir = tmpIntent();
  fs.writeFileSync(path.join(dir, 'vision.md'), '# Vision\n\nHand-written from day one.\n');
  fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n\nAlso hand-written.\n');
  const { written, preserved } = writeGuardedViews(dir, freshPPS());
  assert.deepEqual(preserved.sort(), ['plan.md', 'vision.md']);
  assert.deepEqual(written, ['next.md']);
  assert.match(fs.readFileSync(path.join(dir, 'vision.md'), 'utf-8'), /day one/);
});
