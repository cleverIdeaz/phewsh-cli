const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const next = require('../lib/next');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-next-')); }

test('add queues an item as NEXT and persists to .intent/next.json', () => {
  const d = tmp();
  const item = next.add('Expose project truth over MCP', d);
  assert.ok(item && item.id, 'returns an item with an id');
  assert.equal(item.state, 'next');
  assert.ok(fs.existsSync(path.join(d, '.intent', 'next.json')), 'store created in .intent/');
  const loaded = next.load(d);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].title, 'Expose project truth over MCP');
});

test('state transitions ordered NOW before NEXT before DONE (ids are stable across reorders)', () => {
  const d = tmp();
  const first = next.add('first', d);
  next.add('second', d);
  const third = next.add('third', d);
  // ids don't shift when the list reorders mid-sequence; numbers would
  next.setState(first.id, 'done', d);
  next.setState(third.id, 'now', d);
  const order = next.ordered(next.load(d)).map(i => `${i.state}:${i.title}`);
  assert.deepEqual(order, ['now:third', 'next:second', 'done:first']);
});

test('number refs resolve against the current display order at command time', () => {
  const d = tmp();
  next.add('a', d);
  next.add('b', d);
  // single-shot: "2" is the 2nd row the user just saw
  const moved = next.setState(2, 'now', d);
  assert.equal(moved.title, 'b');
  assert.equal(next.ordered(next.load(d))[0].title, 'b', 'now floats to top');
});

test('done items carry a done timestamp; drop and clear remove items', () => {
  const d = tmp();
  next.add('ship it', d);
  const done = next.setState(1, 'done', d);
  assert.ok(done.done, 'done timestamp set');
  next.add('keep me', d);
  // clear removes only done items
  const data = next.load(d);
  data.items = data.items.filter(i => i.state !== 'done');
  next.save(data, d);
  const after = next.load(d);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].title, 'keep me');
  // drop removes by number
  next.remove(1, d);
  assert.equal(next.load(d).items.length, 0);
});

test('resolve matches by exact id or 1-based number; counts summarize states', () => {
  const d = tmp();
  const a = next.add('alpha', d);
  next.add('beta', d);
  next.setState(2, 'now', d);
  const byId = next.resolve(next.load(d), a.id);
  assert.equal(byId.title, 'alpha');
  const c = next.counts(d);
  assert.equal(c.total, 2);
  assert.equal(c.now, 1);
  assert.equal(c.next, 1);
});

test('corrupt or missing store degrades to empty, never throws', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.intent'), { recursive: true });
  fs.writeFileSync(path.join(d, '.intent', 'next.json'), '{ not valid json');
  const loaded = next.load(d);
  assert.deepEqual(loaded.items, []);
  // empty dir
  const d2 = tmp();
  assert.deepEqual(next.load(d2).items, []);
});
