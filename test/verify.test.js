const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const verify = require('../lib/verify');
const next = require('../lib/next');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-verify-')); }

test('no criteria → empty result, no fake verdict', () => {
  const { results, summary } = verify.verifyAll(undefined);
  assert.equal(results.length, 0);
  assert.equal(summary.total, 0);
  assert.equal(summary.allMeasurablePass, false);
});

test('proposed (unaccepted) criterion is never auto-verified', () => {
  const v = verify.verifyCriterion({ expected: 'x', type: 'measurable', accepted: false, check: { kind: 'file', path: 'whatever' } }, tmp());
  assert.equal(v.status, 'proposed');
});

test('measurable file check: pass when present, fail when absent', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'out.txt'), 'hi');
  assert.equal(verify.verifyCriterion({ expected: 'out exists', type: 'measurable', check: { kind: 'file', path: 'out.txt' } }, d).status, 'pass');
  assert.equal(verify.verifyCriterion({ expected: 'missing exists', type: 'measurable', check: { kind: 'file', path: 'nope.txt' } }, d).status, 'fail');
});

test('contains check: pass / partial / fail', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.md'), 'hello world');
  assert.equal(verify.verifyCriterion({ expected: 'has hello', type: 'measurable', check: { kind: 'contains', path: 'a.md', text: 'hello' } }, d).status, 'pass');
  assert.equal(verify.verifyCriterion({ expected: 'has bye', type: 'measurable', check: { kind: 'contains', path: 'a.md', text: 'goodbye' } }, d).status, 'partial');
  assert.equal(verify.verifyCriterion({ expected: 'b has x', type: 'measurable', check: { kind: 'contains', path: 'b.md', text: 'x' } }, d).status, 'fail');
});

test('measurable with no check → unknown (never faked)', () => {
  const v = verify.verifyCriterion({ expected: 'tests pass', type: 'measurable' }, tmp());
  assert.equal(v.status, 'unknown');
});

test('human criterion → human review required, no auto-verdict', () => {
  const v = verify.verifyCriterion({ expected: 'the UX feels calm', type: 'human' }, tmp());
  assert.equal(v.status, 'human');
});

test('changed check uses injected git evidence; missing git → unknown', () => {
  const d = tmp();
  const pass = verify.verifyCriterion({ expected: 'touched x', type: 'measurable', check: { kind: 'changed', path: 'src/x.js' } }, d, { changedPaths: ['src/x.js'] });
  assert.equal(pass.status, 'pass');
  const fail = verify.verifyCriterion({ expected: 'touched y', type: 'measurable', check: { kind: 'changed', path: 'src/y.js' } }, d, { changedPaths: [] });
  assert.equal(fail.status, 'fail');
  const unk = verify.verifyCriterion({ expected: 'touched z', type: 'measurable', check: { kind: 'changed', path: 'src/z.js' } }, d, { changedPaths: null });
  assert.equal(unk.status, 'unknown');
});

test('changed check includes untracked files and respects path boundaries', () => {
  const d = tmp();
  execFileSync('git', ['init', '-q'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: d });
  fs.writeFileSync(path.join(d, 'base.txt'), 'base');
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: d });
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'new.js'), 'new');

  const criterion = { expected: 'src changed', type: 'measurable', check: { kind: 'changed', path: 'src' } };
  assert.equal(verify.verifyCriterion(criterion, d).status, 'pass');
  assert.equal(verify.verifyCriterion(
    { expected: 'sr changed', type: 'measurable', check: { kind: 'changed', path: 'sr' } },
    d,
  ).status, 'fail');
});

test('mixed verdicts roll up honestly — allMeasurablePass requires every measurable to pass', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'done.txt'), 'ok');
  const criteria = [
    { expected: 'file made', type: 'measurable', check: { kind: 'file', path: 'done.txt' } }, // pass
    { expected: 'other file', type: 'measurable', check: { kind: 'file', path: 'missing.txt' } }, // fail
    { expected: 'reads well', type: 'human' }, // human
  ];
  const { summary } = verify.verifyAll(criteria, d);
  assert.equal(summary.pass, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.human, 1);
  assert.equal(summary.allMeasurablePass, false, 'a fail must block the all-clear');
  assert.equal(summary.needsHuman, true);
});

test('criteria attach to a Next item and survive load/save (carry through /brief, /switch)', () => {
  const d = tmp();
  next.add('build the verify slice', d);
  const item = next.addCriterion(1, { expected: 'lib/verify.js exists', type: 'measurable', check: { kind: 'file', path: 'cli/lib/verify.js' } }, d);
  assert.ok(item.criteria && item.criteria.length === 1);
  // reload from disk — criteria persist (so they travel with the repo to any harness)
  const reloaded = next.load(d).items[0];
  assert.equal(reloaded.criteria[0].expected, 'lib/verify.js exists');
  assert.equal(reloaded.criteria[0].accepted, true);
});

test('proposed criteria must be accepted before they count', () => {
  const d = tmp();
  next.add('thing', d);
  next.addCriterion(1, { expected: 'proposed one', type: 'measurable', accepted: false, check: { kind: 'file', path: 'x' } }, d);
  let crit = next.load(d).items[0].criteria[0];
  assert.equal(verify.verifyCriterion(crit, d).status, 'proposed');
  next.acceptCriteria(1, d);
  crit = next.load(d).items[0].criteria[0];
  assert.notEqual(verify.verifyCriterion(crit, d).status, 'proposed');
});

test('verifyAll does not mutate the repo (read-only)', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, '.intent'), { recursive: true });
  next.add('x', d);
  next.addCriterion(1, { expected: 'a', type: 'measurable', check: { kind: 'file', path: 'a' } }, d);
  const before = fs.readFileSync(path.join(d, '.intent', 'next.json'), 'utf-8');
  verify.verifyAll(next.load(d).items[0].criteria, d);
  const after = fs.readFileSync(path.join(d, '.intent', 'next.json'), 'utf-8');
  assert.equal(before, after, 'verification reads, never writes');
});
