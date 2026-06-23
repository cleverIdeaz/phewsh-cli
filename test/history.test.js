// Tests for persistent command history.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, loadForReadline, append } = require('../lib/history');

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-hist-'));
  return path.join(d, 'history');
}

test('append then load round-trips in file order', () => {
  const f = tmpFile();
  append('first', f);
  append('second', f);
  assert.deepEqual(load(100, f), ['first', 'second']);
});

test('loadForReadline returns newest-first', () => {
  const f = tmpFile();
  append('a', f); append('b', f); append('c', f);
  assert.deepEqual(loadForReadline(100, f), ['c', 'b', 'a']);
});

test('load caps to max', () => {
  const f = tmpFile();
  for (let i = 0; i < 10; i++) append('line' + i, f);
  assert.deepEqual(load(3, f), ['line7', 'line8', 'line9']);
});

test('blank lines are ignored', () => {
  const f = tmpFile();
  append('', f); append('   ', f); append('real', f);
  assert.deepEqual(load(100, f), ['real']);
});

test('secret-bearing /key lines are never written', () => {
  const f = tmpFile();
  append('/key sk-or-v1-supersecret', f);
  append('/model opus', f);
  assert.deepEqual(load(100, f), ['/model opus']);
});

test('newlines collapse so one entry stays one line', () => {
  const f = tmpFile();
  append('multi\nline\npaste', f);
  assert.deepEqual(load(100, f), ['multi line paste']);
});

test('missing file loads empty, never throws', () => {
  assert.deepEqual(load(100, '/nonexistent/dir/history'), []);
});
