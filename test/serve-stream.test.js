// serve stream-json surfacing — the model's actual answer and a readable live
// phase must reach the web, not the raw NDJSON event log Claude Code emits with
// --output-format stream-json. Fixtures use the real event shapes captured from
// a live `claude -p` acceptance run (job 6f9a15ad, 2026-07-23).

const { test } = require('node:test');
const assert = require('node:assert');
const { extractStreamResult, streamPhase, parseStreamEvent } = require('../commands/serve')._internals;

// A trimmed but faithful Claude Code stream-json transcript.
const CLAUDE_STREAM = [
  '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup","session_id":"6c92"}',
  '{"type":"system","subtype":"status","status":"requesting","uuid":"bb56"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"PHEWSH ION LOCAL EXECUTION VERIFIED."}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"PHEWSH ION LOCAL EXECUTION VERIFIED.","total_cost_usd":0.01}',
].join('\n');

test('extractStreamResult returns the model answer from a stream-json transcript', () => {
  const out = extractStreamResult(CLAUDE_STREAM);
  assert.deepStrictEqual(out, { text: 'PHEWSH ION LOCAL EXECUTION VERIFIED.', isError: false });
});

test('extractStreamResult honors an in-band API error', () => {
  const stream = '{"type":"result","subtype":"error","is_error":true,"result":"rate limit reached"}';
  assert.deepStrictEqual(extractStreamResult(stream), { text: 'rate limit reached', isError: true });
});

test('extractStreamResult returns null for plain-text output (codex/gemini unchanged)', () => {
  assert.strictEqual(extractStreamResult('I created the file and ran the tests. All 3 passed.'), null);
  assert.strictEqual(extractStreamResult(''), null);
});

test('streamPhase maps event types to readable live status, never raw JSON', () => {
  assert.strictEqual(streamPhase({ type: 'result' }), 'Finishing…');
  assert.strictEqual(streamPhase({ type: 'assistant' }), 'Responding…');
  // stream_event is the partial-message streaming Claude emits mid-turn — the
  // exact event that leaked raw JSON in the live cancel run.
  assert.strictEqual(streamPhase({ type: 'stream_event' }), 'Responding…');
  assert.strictEqual(streamPhase({ type: 'user' }), 'Running a step…');
  assert.strictEqual(streamPhase({ type: 'system', subtype: 'status' }), 'Working…');
  assert.strictEqual(streamPhase({ type: 'system', subtype: 'hook_started' }), 'Starting…');
  // Any other recognized JSON event object gets a phase, never raw JSON.
  assert.strictEqual(streamPhase({ type: 'some_future_event' }), 'Working…');
  // Non-events (plain text → parseStreamEvent returns null) fall through.
  assert.strictEqual(streamPhase(null), null);
  assert.strictEqual(streamPhase({ subtype: 'x' }), null);
});

test('parseStreamEvent parses JSON lines and rejects plain text', () => {
  assert.deepStrictEqual(parseStreamEvent('{"type":"result","result":"x"}'), { type: 'result', result: 'x' });
  assert.strictEqual(parseStreamEvent('Working on it...'), null);
  assert.strictEqual(parseStreamEvent(''), null);
});
