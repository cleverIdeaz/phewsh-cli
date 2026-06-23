const test = require('node:test');
const assert = require('node:assert/strict');
const {
  echoedRows,
  estimateTokens,
  formatPasteSummary,
  formatTokenCount,
  relativeFolder,
  shouldCollapsePaste,
  visibleLength,
} = require('../lib/session-display');

test('collapses multi-line and long single-line input', () => {
  assert.equal(shouldCollapsePaste(['one', 'two'], 'one\ntwo'), true);
  assert.equal(shouldCollapsePaste(['short'], 'short'), false);
  assert.equal(shouldCollapsePaste(['x'.repeat(300)], 'x'.repeat(300)), true);
});

test('formats a compact expandable paste summary', () => {
  assert.equal(
    formatPasteSummary('one\ntwo', 2),
    '[pasted 7 chars · 2 lines · Ctrl+O to expand]'
  );
});

test('estimates display width and wrapped terminal rows', () => {
  assert.equal(visibleLength('\x1b[38;5;79mphewsh\x1b[0m'), 6);
  assert.equal(echoedRows(['12345678901234567890'], 'p> ', 20), 2);
  assert.equal(echoedRows(['one', 'two'], 'p> ', 80), 2);
});

test('formats approximate context and home-relative folders', () => {
  assert.equal(estimateTokens('12345678'), 2);
  assert.equal(formatTokenCount(2345), '2.3k');
  assert.equal(relativeFolder('/Users/neal/project', '/Users/neal'), '~/project');
  assert.equal(relativeFolder('/Users/neal', '/Users/neal'), '~');
});
