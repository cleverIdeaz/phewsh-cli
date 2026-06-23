const test = require('node:test');
const assert = require('node:assert/strict');
const { routeCoach } = require('../lib/route-coach');
const { HARNESSES } = require('../lib/harnesses');

function harnesses(ids) {
  return Object.entries(HARNESSES).map(([id, h]) => ({
    id,
    ...h,
    installed: ids.includes(id),
    headless: !!h.args,
  }));
}

test('points code edits to native work when the harness can receive a brief', () => {
  const advice = routeCoach('Please implement the failing tests and patch the code', {
    route: { type: 'harness', id: 'codex' },
    harnesses: harnesses(['claude-code', 'codex']),
    hasIntentDir: true,
  });
  assert.equal(advice.id, 'native-work:claude-code');
  assert.equal(advice.command, '/work claude-code');
});

test('points reviews to Codex without switching the default route', () => {
  const advice = routeCoach('Review this plan for risks and regressions', {
    route: { type: 'harness', id: 'claude-code' },
    harnesses: harnesses(['claude-code', 'codex']),
    hasIntentDir: true,
  });
  assert.equal(advice.id, 'review-with-codex');
  assert.equal(advice.command, '@codex <same ask>');
});

test('does not suggest Codex review when already on Codex', () => {
  const advice = routeCoach('Review this plan for risks', {
    route: { type: 'harness', id: 'codex' },
    harnesses: harnesses(['codex']),
    hasIntentDir: true,
  });
  assert.equal(advice, null);
});

test('points judgment calls to council when multiple headless tools are installed', () => {
  const advice = routeCoach('Which strategy should I pick? Compare options and tradeoffs', {
    route: { type: 'harness', id: 'claude-code' },
    harnesses: harnesses(['claude-code', 'codex', 'gemini']),
    hasIntentDir: true,
  });
  assert.equal(advice.id, 'ask-council');
  assert.equal(advice.command, '/council <same ask>');
});

test('points raw first-turn project intent to clarify before chat drift starts', () => {
  const advice = routeCoach('I want to build a tool that keeps all my AI work aligned across projects', {
    route: { type: 'harness', id: 'claude-code' },
    harnesses: harnesses(['claude-code']),
    hasIntentDir: false,
    turnsThisSession: 0,
  });
  assert.equal(advice.id, 'clarify-first');
  assert.equal(advice.command, '/clarify');
});

test('stays quiet for ordinary chat', () => {
  const advice = routeCoach('Summarize what we just discussed', {
    route: { type: 'harness', id: 'claude-code' },
    harnesses: harnesses(['claude-code', 'codex']),
    hasIntentDir: true,
  });
  assert.equal(advice, null);
});
