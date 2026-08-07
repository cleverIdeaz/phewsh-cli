const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ws = require('../lib/worker-state');

test('every serve.js job status translates, and an unknown one refuses to guess', () => {
  // The mapping is only trustworthy if it covers what serve.js actually sets.
  // Read the real source so this test fails when a new status appears there
  // rather than when someone remembers to update a list.
  const serve = fs.readFileSync(path.join(__dirname, '..', 'commands', 'serve.js'), 'utf8');
  const assigned = new Set(
    [...serve.matchAll(/job\.status\s*=\s*'([a-z]+)'/g)].map((m) => m[1]),
  );
  assigned.add('queued'); // set at creation, not by assignment
  for (const status of assigned) {
    assert.ok(ws.FROM_SERVE_STATUS[status], `serve.js sets job.status='${status}' with no contract mapping`);
    assert.ok(ws.JOB_STATES.includes(ws.FROM_SERVE_STATUS[status]));
  }

  assert.equal(ws.jobStateOf({ status: 'executing' }), 'running');
  assert.equal(ws.jobStateOf({ status: 'done' }), 'completed');
  // Unknown must read as unknown. Defaulting to 'running' or 'failed' would
  // make a state the node never reported look observed.
  assert.equal(ws.jobStateOf({ status: 'teleporting' }), null);
  assert.equal(ws.jobStateOf(null), null);
  assert.equal(ws.jobStateOf({}), null);
});

test('cancelling is its own state — it may claim neither running nor cancelled', () => {
  assert.equal(ws.jobStateOf({ status: 'cancelling' }), 'cancelling');
  assert.ok(!ws.isTerminal('cancelling'), 'a cancelling job has not stopped yet');
  assert.ok(ws.isTerminal('cancelled'));
});

test('states with no truthful producer are named but never claimed as observed', () => {
  for (const state of ws.NOT_YET_OBSERVABLE) {
    assert.ok(ws.JOB_STATES.includes(state), 'the vocabulary is stable');
    assert.ok(
      !Object.values(ws.FROM_SERVE_STATUS).includes(state),
      `${state} has no producer, so nothing may map onto it`,
    );
  }
});

test('presence separates "I cannot see it" from "it is gone"', () => {
  const now = 1_000_000;
  assert.equal(ws.presenceOf({ lastHeartbeatAt: now - 1000, now }), 'connected');
  // Silence is not death: an expired heartbeat is stale, not disconnected.
  assert.equal(ws.presenceOf({ lastHeartbeatAt: now - 60_000, now }), 'stale');
  assert.equal(ws.presenceOf({ lastHeartbeatAt: null, now }), 'stale');
  // Only an observed transport close may assert disconnected.
  assert.equal(ws.presenceOf({ lastHeartbeatAt: now, now, transportClosed: true }), 'disconnected');
});

test('presence and job state are independent — a worker can go stale mid-run', () => {
  // The sentence a single collapsed enum cannot say.
  const record = ws.workerStateRecord({
    workerId: 'node-1',
    projectId: 'p_miramora',
    presence: 'stale',
    jobs: [{ jobId: 'j1', state: 'running', taskId: 't42' }],
  });
  assert.equal(record.presence, 'stale');
  assert.equal(record.activeJobs[0].state, 'running');
  assert.equal(record.activeJobs[0].taskId, 't42');
  // Reachability is unknown, so activity must not be asserted either way.
  assert.equal(record.activity, 'unknown');
});

test('activity is derived from the jobs, so it cannot disagree with them', () => {
  const base = { workerId: 'node-1', projectId: 'p', presence: 'connected' };
  assert.equal(ws.workerStateRecord({ ...base, jobs: [] }).activity, 'idle');
  assert.equal(
    ws.workerStateRecord({ ...base, jobs: [{ jobId: 'j1', state: 'running' }] }).activity,
    'working',
  );
  // Terminal jobs are not activity.
  const done = ws.workerStateRecord({ ...base, jobs: [{ jobId: 'j1', state: 'completed' }] });
  assert.equal(done.activity, 'idle');
  assert.equal(done.activeJobs.length, 0);
});

test('the unauthenticated /health payload gains no project or task identity', () => {
  // /health is a shape claim reachable by any local caller: "this speaks the
  // protocol", never "this is trustworthy". Job state rides on the granted
  // routes instead, so adding it here would turn a public probe into a
  // project-and-task oracle.
  const serve = fs.readFileSync(path.join(__dirname, '..', 'commands', 'serve.js'), 'utf8');
  const start = serve.indexOf("url.pathname === '/health'");
  assert.ok(start > 0, 'the /health route must exist to be constrained');
  // The handler ends at the next route test.
  const rest = serve.slice(start);
  const handler = rest.slice(0, rest.indexOf("url.pathname === '/host/pair/request'"));
  for (const leak of ['projectId', 'taskId', 'boundProjectId', 'cloudProjectId']) {
    assert.ok(!handler.includes(leak), `/health must not expose ${leak} to an ungranted caller`);
  }
});
