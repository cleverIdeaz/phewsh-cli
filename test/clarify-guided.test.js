// Tests for the guided-clarify node set and answer assembly.

const { test } = require('node:test');
const assert = require('node:assert');
const { GUIDE_NODES, assembleRaw, askGuided, extractJson } = require('../commands/clarify');

// A scripted readline stub: hands back answers in order, records prompts.
function stubRl(answers) {
  const prompts = [];
  let i = 0;
  return {
    prompts,
    closed: false,
    question(q, cb) { prompts.push(q); cb(answers[i++]); },
    close() { this.closed = true; },
  };
}

function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => { console.log = orig; }).then(r => ({ result: r, lines }));
}

test('walks the five strongest compass nodes, in order', () => {
  assert.deepEqual(GUIDE_NODES.map(n => n.title), ['Purpose', 'Audience', 'Method', 'Scope', 'Edge']);
});

test('every node carries a question and a directive', () => {
  for (const n of GUIDE_NODES) {
    assert.ok(n.q && n.q.endsWith('?'), `${n.title} asks a question`);
    assert.ok(n.directive && n.directive.length, `${n.title} has a directive`);
    assert.ok(n.id && n.id.length, `${n.title} has an id`);
  }
});

test('assembleRaw labels each answer by node for the compiler', () => {
  const answers = [
    { title: 'Purpose', directive: 'the core reason this exists', answer: 'help people track habits' },
    { title: 'Scope', directive: 'boundaries, in and out', answer: 'one habit, no social feed' },
  ];
  const raw = assembleRaw(answers);
  assert.match(raw, /Purpose \(the core reason this exists\): help people track habits/);
  assert.match(raw, /Scope \(boundaries, in and out\): one habit, no social feed/);
  assert.equal(raw.split('\n').length, 2);
});

test('assembleRaw of no answers is empty (triggers freeform fallback)', () => {
  assert.equal(assembleRaw([]), '');
});

test('the walk asks all five nodes in order and prints each', async () => {
  const rl = stubRl(['p', 'a', 'm', 's', 'e']);
  const { result, lines } = await captureLog(() => askGuided(rl));
  // five questions asked, in node order
  assert.equal(rl.prompts.length, 5);
  assert.match(rl.prompts[0], /core reason this exists|outcome are you really after/);
  // each node title printed as a step header
  const text = lines.join('\n');
  for (const n of GUIDE_NODES) assert.match(text, new RegExp(`${n.title} — `));
  assert.match(text, /1\/5/);
  assert.match(text, /5\/5/);
  // all five answers captured, rl closed
  assert.equal(result.length, 5);
  assert.ok(rl.closed);
});

test('blank answers are skipped, not recorded', async () => {
  const rl = stubRl(['real purpose', '', '', 'scoped', '']);
  const { result } = await captureLog(() => askGuided(rl));
  assert.deepEqual(result.map(r => r.title), ['Purpose', 'Scope']);
  assert.equal(assembleRaw(result).split('\n').length, 2);
});

test('skipping everything yields empty assembly (freeform fallback path)', async () => {
  const rl = stubRl(['', '', '', '', '']);
  const { result } = await captureLog(() => askGuided(rl));
  assert.equal(assembleRaw(result), '');
});

// extractJson powers the no-key harness path — harness output is messy.
test('extractJson reads a clean JSON object', () => {
  assert.deepEqual(extractJson('{"goal":"x","tasks":[]}'), { goal: 'x', tasks: [] });
});

test('extractJson strips a ```json code fence', () => {
  const out = 'Here you go:\n```json\n{"goal":"ship it"}\n```\nHope that helps!';
  assert.deepEqual(extractJson(out), { goal: 'ship it' });
});

test('extractJson finds JSON embedded in prose', () => {
  const out = 'Sure! {"goal":"track habits","success_criteria":["daily"]} — done.';
  assert.deepEqual(extractJson(out), { goal: 'track habits', success_criteria: ['daily'] });
});

test('extractJson throws cleanly when there is no JSON', () => {
  assert.throws(() => extractJson('I cannot help with that.'), /could not parse/);
});
