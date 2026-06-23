const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapAnsi, sage, termWidth, rawWidth, setWidth } = require('../lib/ui');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('wrapAnsi wraps at word boundaries without exceeding width', () => {
  const text = 'This is a fairly long sentence that should wrap at word boundaries.';
  const lines = stripAnsi(wrapAnsi(text, 30)).split('\n');
  assert.ok(lines.length > 1, 'long line is split');
  for (const l of lines) assert.ok(l.length <= 30, `line "${l}" within width`);
});

test('wrapAnsi never splits a word — content is preserved verbatim', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
  const out = stripAnsi(wrapAnsi(text, 24));
  assert.ok(out.includes('\n'), 'long line wrapped');
  assert.equal(out.replace(/\n/g, ' '), text, 'words rejoin to the original, none broken');
});

test('wrapAnsi leaves an over-long single word whole (no mid-word break)', () => {
  const url = 'https://example.com/a/really/long/path/that/exceeds/width';
  const out = stripAnsi(wrapAnsi(`see ${url} end`, 30)).split('\n');
  assert.ok(out.includes(url), 'the long token survives intact on its own line');
});

test('wrapAnsi re-opens active colour on each continuation line', () => {
  const out = wrapAnsi(sage('alpha beta gamma delta epsilon zeta eta theta'), 24).split('\n');
  assert.ok(out.length > 1);
  for (const l of out.slice(1)) assert.ok(l.includes('38;5;151'), 'continuation keeps the sage tint');
});

test('wrapAnsi is a no-op when width is unknown (piped output stays raw)', () => {
  const text = 'a long line that would otherwise wrap if a width were known to us here';
  assert.equal(wrapAnsi(text, undefined), text);
  assert.equal(wrapAnsi(text, 0), text);
});

test('termWidth honors PHEWSH_WIDTH env override for terminals that misreport size', () => {
  const prevW = process.env.PHEWSH_WIDTH;
  try {
    setWidth(null); // ensure no live override is in effect
    process.env.PHEWSH_WIDTH = '60';
    assert.equal(rawWidth(), 60, 'env pin is the believed width');
    assert.equal(termWidth(), 58, 'pinned width minus the 2-col safety margin');
  } finally {
    if (prevW === undefined) delete process.env.PHEWSH_WIDTH; else process.env.PHEWSH_WIDTH = prevW;
  }
});

test('setWidth pins a live override that /width uses, and clears back to auto', () => {
  try {
    setWidth(72);
    assert.equal(rawWidth(), 72, 'live override wins');
    assert.equal(termWidth(), 70, 'override minus margin');
    setWidth('not a number');
    assert.notEqual(rawWidth(), 72, 'invalid input clears the override');
  } finally {
    setWidth(null);
  }
});

test('wrapAnsi preserves leading indent as a hanging indent', () => {
  const out = stripAnsi(wrapAnsi('  one two three four five six seven eight nine ten', 24)).split('\n');
  for (const l of out) assert.ok(l.startsWith('  '), `"${l}" keeps the 2-space indent`);
});
