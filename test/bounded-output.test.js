const { test } = require('node:test');
const assert = require('node:assert/strict');

const { boundedAppend, MAX_HARNESS_OUTPUT_BYTES } = require('../lib/bounded-output');

// A harness's stdout was accumulated into a string with `+=` and no ceiling. An
// agent that streams for a long time, loops, or dumps a large file therefore grew
// the node's memory without limit — the same shape as the unbounded request body a
// critic used to drive it to 777 MB, except this one arrives from a process the
// person deliberately started, so it is not even hostile to trigger.
//
// Truncating has to stay HONEST: the receipt records a byte count and a hash of
// what came back, so a truncated capture must say it was truncated rather than
// present a shorter output as the whole of it.

test('output under the ceiling is kept exactly', () => {
  const buf = boundedAppend(null, 'hello ');
  const next = boundedAppend(buf, 'world');
  assert.equal(next.text, 'hello world');
  assert.equal(next.truncated, false);
  assert.equal(next.bytes, 11);
});

test('output past the ceiling stops growing and says so', () => {
  const chunk = 'x'.repeat(64 * 1024);
  let buf = null;
  // Comfortably more than the ceiling.
  for (let i = 0; i < Math.ceil(MAX_HARNESS_OUTPUT_BYTES / chunk.length) + 8; i++) {
    buf = boundedAppend(buf, chunk);
  }

  assert.equal(buf.truncated, true, 'a capture that dropped output must admit it');
  assert.ok(
    Buffer.byteLength(buf.text) <= MAX_HARNESS_OUTPUT_BYTES,
    `kept ${Buffer.byteLength(buf.text)} bytes, ceiling is ${MAX_HARNESS_OUTPUT_BYTES}`,
  );
  // The count is what the harness actually produced, not what was kept — the
  // receipt should not understate the run.
  assert.ok(buf.bytes > MAX_HARNESS_OUTPUT_BYTES, 'the produced byte count must be the real one');
});

test('the beginning is what survives, because that is where a harness says what it did', () => {
  let buf = boundedAppend(null, 'FIRST LINE\n');
  buf = boundedAppend(buf, 'y'.repeat(MAX_HARNESS_OUTPUT_BYTES * 2));
  assert.ok(buf.text.startsWith('FIRST LINE\n'), 'the opening output must not be discarded');
});

test('a chunk that straddles the ceiling is cut, not dropped whole', () => {
  const almost = MAX_HARNESS_OUTPUT_BYTES - 10;
  let buf = boundedAppend(null, 'a'.repeat(almost));
  assert.equal(buf.truncated, false);

  buf = boundedAppend(buf, 'b'.repeat(500));
  assert.equal(Buffer.byteLength(buf.text), MAX_HARNESS_OUTPUT_BYTES);
  assert.ok(buf.text.endsWith('b'.repeat(10)), 'the part that fit must be kept');
  assert.equal(buf.truncated, true);
});

test('appending after truncation neither grows nor un-truncates', () => {
  let buf = boundedAppend(null, 'z'.repeat(MAX_HARNESS_OUTPUT_BYTES + 100));
  const size = Buffer.byteLength(buf.text);
  const produced = buf.bytes;

  buf = boundedAppend(buf, 'more');
  assert.equal(Buffer.byteLength(buf.text), size);
  assert.equal(buf.truncated, true);
  assert.equal(buf.bytes, produced + 4, 'the produced count still tracks everything received');
});

test('empty and absent chunks are harmless', () => {
  assert.equal(boundedAppend(null, '').text, '');
  assert.equal(boundedAppend(null, undefined).text, '');
  const buf = boundedAppend(boundedAppend(null, 'kept'), '');
  assert.equal(buf.text, 'kept');
  assert.equal(buf.truncated, false);
});
