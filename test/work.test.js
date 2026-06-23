const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const work = require('../lib/work');
const next = require('../lib/next');
const record = require('../lib/record');

// Unique tmp dir → its basename matches no real project, so global outcome
// reads return nothing and the view stays hermetic.
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-work-')); }

test('empty dir: no project, nothing next, nothing recorded, review clear', () => {
  const d = tmp();
  const v = work.workView(d);
  assert.equal(v.project.present, false);
  assert.equal(v.next.now, null);
  assert.equal(v.record.latest, null);
  assert.equal(v.work.tool, null);
  assert.equal(v.review.clear, true, 'no pending/drift in a fresh non-git dir');
});

test('reads Project name + tagline from .intent', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.intent'), { recursive: true });
  fs.writeFileSync(path.join(d, '.intent', 'project.json'), JSON.stringify({ name: 'phewsh' }));
  fs.writeFileSync(path.join(d, '.intent', 'vision.md'), '# Vision\n\n## North Star\nAI work that remembers what matters.\n');
  const v = work.workView(d);
  assert.equal(v.project.present, true);
  assert.equal(v.project.name, 'phewsh');
  assert.equal(v.project.tagline, 'AI work that remembers what matters');
});

test('Next shows the started (now) item; falls back to top queued', () => {
  const d = tmp();
  next.add('queued thing', d);
  let v = work.workView(d);
  assert.equal(v.next.now, null);
  assert.equal(v.next.topQueued, 'queued thing');

  next.add('the active one', d);
  next.setState(2, 'now', d); // 2nd in display order = "the active one"
  v = work.workView(d);
  assert.equal(v.next.now, 'the active one');
});

test('Record shows the latest remembered decision, prefix stripped', () => {
  const d = tmp();
  record.remember('first decision', d);
  record.remember('Locked Phewsh to Project · Next · Work · Record', d);
  const v = work.workView(d);
  assert.equal(v.record.latest, 'Locked Phewsh to Project · Next · Work · Record');
  assert.ok(!/^- \d{4}/.test(v.record.latest), 'date prefix stripped');
});

test('workView is read-only — calling it writes nothing to .intent', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.intent'), { recursive: true });
  const before = fs.readdirSync(path.join(d, '.intent')).sort();
  work.workView(d);
  const after = fs.readdirSync(path.join(d, '.intent')).sort();
  assert.deepEqual(after, before, 'no files created or modified by the view');
});

test('view shape has the core sections (+ optional verification)', () => {
  const v = work.workView(tmp());
  assert.deepEqual(Object.keys(v).sort(), ['next', 'project', 'record', 'review', 'verification', 'work']);
  assert.equal(v.verification, null, 'no started item with criteria → null, not a fake verdict');
});
