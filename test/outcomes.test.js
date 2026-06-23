// Tests for the decision/outcome record — especially the kept/route-error
// distinction that made the old /outcomes read like phewsh was broken.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// The lib resolves ~/.phewsh at require time, so point HOME at a temp dir and
// require a fresh copy. (macOS/Linux os.homedir() honors $HOME.)
function freshLib() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-outcomes-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  delete require.cache[require.resolve('../lib/outcomes')];
  const lib = require('../lib/outcomes');
  return { lib, home, restore: () => { process.env.HOME = prevHome; } };
}

test('looksTrivial: greetings and filler, but not real short prompts', () => {
  const { lib, restore } = freshLib();
  try {
    for (const t of ['hi', 'hey', 'yo', 'ok', 'thanks', 'hi there', 'Hi!', 'test']) {
      assert.equal(lib.looksTrivial(t), true, `${t} should be trivial`);
    }
    for (const real of ['fix the auth bug', 'refactor session.js', 'why use phewsh']) {
      assert.equal(lib.looksTrivial(real), false, `${real} should NOT be trivial`);
    }
  } finally { restore(); }
});

test('isAutoLabel keys on the explicit flag', () => {
  const { lib, restore } = freshLib();
  try {
    assert.equal(lib.isAutoLabel({ outcome: 'failed', auto: true }), true);
    assert.equal(lib.isAutoLabel({ outcome: 'failed' }), false);
    assert.equal(lib.isAutoLabel({ outcome: 'kept' }), false);
  } finally { restore(); }
});

test('outcomeStats separates human judgments from auto route-errors', () => {
  const { lib, restore } = freshLib();
  try {
    const a = lib.recordDecision({ project: 'p', route: 'codex', summary: 'real work A' });
    const b = lib.recordDecision({ project: 'p', route: 'codex', summary: 'real work B' });
    const c = lib.recordDecision({ project: 'p', route: 'claude-code', summary: 'errored call' });
    lib.labelOutcome(a, 'kept');
    lib.labelOutcome(b, 'reverted', 'broke the build');
    lib.labelOutcome(c, 'failed', null, { auto: true }); // route errored

    const s = lib.outcomeStats();
    assert.equal(s.total, 3);
    assert.equal(s.judged, 2);        // a + b, NOT the auto failure
    assert.equal(s.autoFailed, 1);    // c
    assert.equal(s.kept, 1);
    assert.equal(s.reverted, 1);
    assert.equal(s.failed, 0);        // the auto one doesn't count as a verdict
    // route-error tracked separately, doesn't tank claude-code's kept-rate
    assert.equal(s.byRoute['claude-code'].errored, 1);
    assert.equal(s.byRoute['claude-code'].total, 0);
  } finally { restore(); }
});

test('a human verdict overrides a prior auto-label', () => {
  const { lib, restore } = freshLib();
  try {
    const id = lib.recordDecision({ project: 'p', route: 'codex', summary: 'x' });
    lib.labelOutcome(id, 'failed', null, { auto: true });
    assert.equal(lib.outcomeStats().autoFailed, 1);
    lib.labelOutcome(id, 'kept'); // human now judges it
    const s = lib.outcomeStats();
    assert.equal(s.autoFailed, 0);
    assert.equal(s.kept, 1);
    assert.equal(s.judged, 1);
  } finally { restore(); }
});

test('legacy migration tags failed-without-why as auto route-errors', () => {
  const { lib, home, restore } = freshLib();
  try {
    // Hand-write a legacy file: failed, no why, no auto flag.
    const file = path.join(home, '.phewsh', 'outcomes', 'decisions.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([
      { id: 'd1', ts: '2026-06-01T00:00:00Z', project: 'p', route: 'codex', summary: 'route died', outcome: 'failed', labeledAt: '2026-06-01T00:00:01Z' },
      { id: 'd2', ts: '2026-06-01T00:00:00Z', project: 'p', route: 'codex', summary: 'i judged this failed', outcome: 'failed', why: 'wrong approach', labeledAt: '2026-06-01T00:01:00Z' },
    ]));
    const s = lib.outcomeStats(); // triggers migration
    assert.equal(s.autoFailed, 1);   // d1 (no why) reclassified
    assert.equal(s.failed, 1);       // d2 (has why) stays a human verdict
    assert.equal(s.judged, 1);
  } finally { restore(); }
});

test('pendingDecisions substantive drops trivia', () => {
  const { lib, restore } = freshLib();
  try {
    lib.recordDecision({ project: 'p', route: 'codex', summary: 'hi' });
    lib.recordDecision({ project: 'p', route: 'codex', summary: 'refactor the parser' });
    assert.equal(lib.pendingDecisions().length, 2);
    assert.equal(lib.pendingDecisions({ substantive: true }).length, 1);
  } finally { restore(); }
});

test('persistence failure does not abort recording a routed request', () => {
  const { lib, home, restore } = freshLib();
  try {
    fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
    fs.writeFileSync(path.join(home, '.phewsh', 'outcomes'), 'blocks directory creation');
    assert.doesNotThrow(() => lib.recordDecision({
      project: 'p', route: 'codex', summary: 'route this despite local persistence failure',
    }));
  } finally { restore(); }
});
