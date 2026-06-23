// Tests for the learning-loop insight layer.

const { test } = require('node:test');
const assert = require('node:assert');
const { routeRates, modeRates, bestRoute, learningLine, keptBadge, totalLabeled } = require('../lib/learning');

const stats = {
  kept: 13, reverted: 6, superseded: 2, failed: 1, // 22 labeled
  byRoute: {
    codex: { total: 10, kept: 8, reverted: 1, superseded: 1, failed: 0 },
    'claude-code': { total: 9, kept: 5, reverted: 3, superseded: 1, failed: 0 },
    gemini: { total: 1, kept: 0, reverted: 0, superseded: 0, failed: 1 },
  },
  byMode: {
    build: { total: 12, kept: 9, reverted: 2, superseded: 1, failed: 0 },
    review: { total: 5, kept: 1, reverted: 3, superseded: 0, failed: 1 },
  },
};

test('totalLabeled sums the four outcomes', () => {
  assert.equal(totalLabeled(stats), 22);
  assert.equal(totalLabeled(null), 0);
});

test('routeRates ranks by kept-rate, filters thin samples', () => {
  const r = routeRates(stats, { minSample: 2 });
  assert.deepEqual(r.map((x) => x.route), ['codex', 'claude-code']); // gemini n=1 filtered
  assert.ok(r[0].keptRate > r[1].keptRate);
});

test('bestRoute needs enough data', () => {
  assert.equal(bestRoute(stats, { minSample: 3 }).route, 'codex');
  assert.equal(bestRoute({ byRoute: { x: { total: 1, kept: 1 } } }, { minSample: 3 }), null);
});

test('modeRates ranks modes', () => {
  const m = modeRates(stats, { minSample: 2 });
  assert.equal(m[0].mode, 'build'); // 9/12 beats 1/5
});

test('learningLine is honest — null until enough labeled', () => {
  assert.equal(learningLine({ kept: 1, byRoute: {} }), null);
  const line = learningLine(stats);
  assert.match(line, /After 22 labeled/);
  assert.match(line, /Codex 8\/10/);
});

test('keptBadge hides thin samples, shows real ones', () => {
  assert.equal(keptBadge(stats, 'gemini'), ''); // n=1
  assert.equal(keptBadge(stats, 'codex'), '8/10 kept');
  assert.equal(keptBadge(stats, 'nonexistent'), '');
});
