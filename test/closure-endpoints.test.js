// The receipt → human closure cycle, against a real node.
//
// The unit tests (run-receipt.test.js) pin the schema and the write rules.
// These prove the whole loop as a person actually meets it: run, retrieve the
// receipt (including after a restart), preview exactly what closing it would
// do, then reject or accept — with .intent/ hashed before and after so
// "unchanged" means byte-identical, not "looks the same".
//
// Owner layer: CLI.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { pair, listProjects, grantFor } = require('./helpers/grants');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const PORT = 7860 + Math.floor(Math.random() * 40);

const children = [];
after(() => { for (const c of children) { try { c.kill(); } catch { /* gone */ } } });

// Kept so the pairing approval code can be read off the node's own output.
const nodesByPort = new Map();

function startServe(port, cwd, env = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', ...env },
  });
  children.push(child);
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d.toString(); });
  child.stderr.on('data', () => {});
  nodesByPort.set(port, child);
  return child;
}

function request(port, pathname, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: {
        Origin: 'https://phewsh.com',
        ...(token ? { 'x-phewsh-project-grant': token } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* assert on status instead */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForNode(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, '/health');
      if (res.status === 200) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`node did not start on ${port}`);
}

async function pollStatus(port, jobId, token, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(port, `/status/${jobId}`, { token });
    if (res.body && ['done', 'error', 'cancelled'].includes(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('job did not finish');
}

/** A harness that changes one file and says so — a falsifiable, cost-free run. */
function fakeHarnessDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-closurebin-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} -e "`
    + `require('fs').writeFileSync('run-artifact.txt', 'made by the run'); `
    + `console.log('wrote run-artifact.txt')"\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-closurehome-'));
  const env = { PHEWSH_HOME: home, HOME: home, PATH: `${fakeHarnessDir()}${path.delimiter}${process.env.PATH}` };
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-closurerepo-')));
  fs.mkdirSync(path.join(repo, '.intent'));
  fs.writeFileSync(path.join(repo, '.intent', 'vision.md'), '# Vision\n\nClosure fixture.\n');
  fs.writeFileSync(path.join(repo, '.intent', 'decisions.md'), '# Decisions\n\n- 2026-07-28 — Before the run.\n');
  fs.writeFileSync(path.join(repo, '.intent', 'next.json'), JSON.stringify({
    items: [{ id: 'n1', title: 'Close the loop', state: 'now', criteria: [] }],
  }, null, 2));
  // A file dirty BEFORE the run, to prove attribution.
  fs.writeFileSync(path.join(repo, 'already-dirty.txt'), 'here first');
  const run = (cmd, args) => execFileSync(cmd, args, {
    cwd: repo, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
  });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'closure@fixture.test']);
  run('git', ['config', 'user.name', 'Closure Fixture']);
  run('git', ['remote', 'add', 'origin', 'https://github.com/example/closure.git']);
  run(process.execPath, [BIN, 'project', 'add']);
  return { home, env, repo };
}

const hashes = (repo) => ({
  decisions: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, '.intent', 'decisions.md'))).digest('hex'),
  next: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, '.intent', 'next.json'))).digest('hex'),
});

async function runOnce(port, id, task = 'change a file', token) {
  // The ENGINE composes the contract; the run names it by id. Sending one back
  // is refused outright, because a receipt must not carry a caller's claims.
  const reviewed = await request(port, '/contract', {
    method: 'POST', token,
    body: { projectId: id, runtimeId: 'claude-code', task },
  });
  assert.strictEqual(reviewed.status, 200, `contract review failed: ${reviewed.raw}`);

  const res = await request(port, '/dispatch', {
    method: 'POST',
    token,
    body: {
      actionId: `closure-${Date.now()}`, runtimeId: 'claude-code', projectId: id,
      contractId: reviewed.body.contractId,
      packet: { version: '1.0', id: 'closure-run', objective: { task } },
    },
  });
  const terminal = await pollStatus(port, res.body.jobId, token);
  return { jobId: res.body.jobId, terminal };
}

async function projectId(port) {
  if (!hostGrants.has(port)) hostGrants.set(port, await pair(port, nodesByPort.get(port)));
  const projects = await listProjects(port, hostGrants.get(port));
  return projects[0].id;
}

test('a completed run leaves a retrievable receipt and does NOT touch .intent/', async () => {
  const port = PORT;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  const before = hashes(repo);

  await runOnce(port, id, 'change a file', token);

  // Item 6's rule: finishing a run is not accepting it.
  assert.deepStrictEqual(hashes(repo), before, 'a run must not alter project truth');

  const list = await request(port, `/receipts/run?projectId=${id}`, { token });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.receipts.length, 1);
  const receipt = list.body.receipts[0];

  assert.strictEqual(receipt.schema, 'phewsh.run-receipt');
  assert.strictEqual(receipt.version, 1);
  assert.strictEqual(receipt.boundProjectId, id);
  assert.strictEqual(receipt.status, 'done');
  // Engine-observed attribution: the run's file, not the one already dirty.
  assert.deepStrictEqual(receipt.changes.created, ['run-artifact.txt']);
  assert.ok(receipt.changes.preExisting.includes('already-dirty.txt'));
  assert.strictEqual(receipt.checks.run, false);
  assert.strictEqual(receipt.cost.known, false);
  // Never the model's words, never a path off this project.
  assert.doesNotMatch(JSON.stringify(receipt), /wrote run-artifact/u);
  assert.doesNotMatch(JSON.stringify(receipt), /\/Users\/|\/tmp\/|\/private\//u);
});

test('a receipt survives a node restart — it is on disk, not in memory', async () => {
  const port = PORT + 1;
  const { env, repo } = fixture();
  const first = startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const before = await request(port, `/receipts/run?projectId=${id}`, { token });
  const receiptId = before.body.receipts[0].receiptId;

  first.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  startServe(port + 100, repo, env);
  await waitForNode(port + 100);

  // A restart invalidates every session — the proof was about a live node — so
  // the receipt is re-read under a freshly proven one. The receipt itself is on
  // disk and unchanged; only the permission to read it had to be re-earned.
  const fresh = await provenSession(port + 100, id);
  const after = await request(port + 100, `/receipt?id=${receiptId}`, { token: fresh });
  assert.strictEqual(after.status, 200);
  assert.deepStrictEqual(after.body, before.body.receipts[0], 'the receipt must read back identically');
});

test('rejecting a closure leaves .intent/ byte-identical and keeps the receipt', async () => {
  const port = PORT + 2;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;
  const before = hashes(repo);

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Not adopting this.', markNextDone: true },
  });
  assert.strictEqual(preview.status, 200);
  assert.match(preview.body.record.append, /Not adopting this\./u);
  assert.deepStrictEqual(preview.body.next.change, { id: 'n1', title: 'Close the loop', from: 'now', to: 'done' });
  // Previewing is a read. Nothing may move.
  assert.deepStrictEqual(hashes(repo), before);

  const decided = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'reject', proposalId: preview.body.proposalId },
  });
  assert.strictEqual(decided.body.decision, 'reject');
  assert.strictEqual(decided.body.applied, false);
  assert.deepStrictEqual(hashes(repo), before, '.intent/ must be byte-identical after a rejection');
  // The evidence outlives the judgement.
  assert.strictEqual((await request(port, `/receipt?id=${receiptId}`, { token })).status, 200);
});

test('accepting applies exactly the reviewed change, once, and is retry-safe', async () => {
  const port = PORT + 3;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Adopting this once.', markNextDone: true },
  });
  const proposal = preview.body;

  const first = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId: proposal.proposalId },
  });
  assert.strictEqual(first.body.applied, true);
  assert.strictEqual(first.body.alreadyApplied, false);

  const decisions = fs.readFileSync(path.join(repo, '.intent', 'decisions.md'), 'utf8');
  assert.ok(decisions.includes(proposal.record.append), 'the written line must be the reviewed line');
  assert.ok(decisions.includes('- 2026-07-28 — Before the run.'), 'existing Record survives');
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(repo, '.intent', 'next.json'), 'utf8')).items[0].state, 'done',
  );

  // The lost-response retry.
  const retry = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId: proposal.proposalId },
  });
  assert.strictEqual(retry.body.applied, true);
  assert.strictEqual(retry.body.alreadyApplied, true);
  const after = fs.readFileSync(path.join(repo, '.intent', 'decisions.md'), 'utf8');
  assert.strictEqual(after.split('Adopting this once.').length - 1, 1, 'exactly one Record entry');
});

test('an acceptance reviewed against stale files fails closed', async () => {
  const port = PORT + 4;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;
  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Reviewed before the edit.' },
  });

  // Someone else writes project truth between the review and the click.
  fs.appendFileSync(path.join(repo, '.intent', 'decisions.md'), '- 2026-07-29 — Another tool wrote here.\n');
  const afterEdit = hashes(repo);

  const decided = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId: preview.body.proposalId },
  });
  assert.strictEqual(decided.status, 409);
  assert.match(decided.body.error, /changed since/i);
  assert.deepStrictEqual(hashes(repo), afterEdit, 'a refused acceptance writes nothing');
});

test("one project's receipt cannot be closed into another project's truth", async () => {
  const port = PORT + 5;
  const a = fixture();
  startServe(port, a.repo, a.env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;

  const bogus = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: 'ffffffffffffffff', receiptId, note: 'wrong project' },
  });
  // The grant names one project, so naming another is refused as unauthorized
  // before the engine ever looks for it — it must not confirm what exists.
  assert.ok(bogus.status === 401 || bogus.status === 403, `expected a refusal, got ${bogus.status}`);
});

test('the human decision is recorded as its own event, never folded into the receipt', async () => {
  const port = PORT + 6;
  const { env, repo, home } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;
  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Recorded separately.' },
  });
  await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId: preview.body.proposalId },
  });

  // The receipt is immutable: accepting it must not have edited it.
  const receipt = (await request(port, `/receipt?id=${receiptId}`, { token })).body;
  assert.strictEqual(receipt.writeOnce, true);
  // Written once by Phewsh AND still matching the hash recorded at write time.
  assert.strictEqual(receipt.integrity, 'intact');
  assert.strictEqual(receipt.closure, undefined, 'a receipt must not absorb the human decision');

  const sessionsDir = path.join(home, '.phewsh', 'sessions');
  const file = fs.readdirSync(sessionsDir).find((f) => f.endsWith('_sessions.json'));
  const events = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
  const decision = events.find((e) => e.event === 'closure_decided');
  assert.ok(decision, 'the decision must be its own recorded event');
  assert.strictEqual(decision.receiptId, receiptId);
  assert.strictEqual(decision.decision, 'accept');
  assert.strictEqual(decision.boundProjectId, id);
});

// ─── What the independent critic found (2026-07-29) ──────────────────────────
// Two holes, both mine, both critical:
//
//   1. Nothing proved a caller had completed the handshake. /dispatch and the
//      closure endpoints checked only the request Origin, so any script on an
//      allowlisted origin could run work and write project truth.
//   2. /closure/decide trusted a client-supplied proposal object. A caller
//      could skip the preview entirely and append any line it liked to
//      decisions.md — including a claim that checks passed.
//
// These tests are written from the attacker's side.

// A real pairing plus a project grant carrying everything the closure journey
// touches. There is no shortcut: the approval code is read off the node.
const hostGrants = new Map();
async function provenSession(port, id) {
  if (!hostGrants.has(port)) hostGrants.set(port, await pair(port, nodesByPort.get(port)));
  return grantFor(port, hostGrants.get(port), id,
    ['truth:read', 'work:run', 'work:control', 'record:write']);
}

test('a caller that never completed the handshake cannot run work or write truth', async () => {
  const port = PORT + 7;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const before = hashes(repo);

  // Reading what exists stays open; DOING things does not.
  const dispatch = await request(port, '/dispatch', {
    method: 'POST',
    body: {
      actionId: 'no-session', runtimeId: 'claude-code', projectId: id,
      packet: { version: '1.0', id: 'x', objective: { task: 'should never run' } },
    },
  });
  assert.strictEqual(dispatch.status, 401, 'a bound dispatch requires a proven local session');
  assert.ok(!dispatch.body.jobId);

  const preview = await request(port, '/closure/preview', {
    method: 'POST', body: { projectId: id, receiptId: 'r-whatever', note: 'nope' },
  });
  assert.strictEqual(preview.status, 401);

  const decide = await request(port, '/closure/decide', {
    method: 'POST', body: { projectId: id, decision: 'accept', proposalId: 'anything' },
  });
  assert.strictEqual(decide.status, 401);

  assert.deepStrictEqual(hashes(repo), before, 'nothing may be written without a session');
});

test('a session token is bound to one project and does not travel', async () => {
  const port = PORT + 8;
  const { env, repo } = fixture();
  // A second registered project on the same machine.
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-other-')));
  fs.mkdirSync(path.join(other, '.intent'));
  fs.writeFileSync(path.join(other, '.intent', 'vision.md'), '# Vision\n\nOther.\n');
  const run = (cmd, args) => execFileSync(cmd, args, {
    cwd: other, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
  });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'o@o.test']);
  run('git', ['config', 'user.name', 'Other']);
  run('git', ['remote', 'add', 'origin', 'https://github.com/example/other.git']);
  run(process.execPath, [BIN, 'project', 'add']);

  startServe(port, repo, env);
  await waitForNode(port);
  if (!hostGrants.has(port)) hostGrants.set(port, await pair(port, nodesByPort.get(port)));
  const projects = await listProjects(port, hostGrants.get(port));
  const first = projects[0].id;
  const second = projects[1].id;
  const token = await provenSession(port, first);

  const crossed = await request(port, '/closure/preview', {
    method: 'POST', body: { projectId: second, receiptId: 'r-x', note: 'wrong project' },
    token,
  });
  assert.ok(crossed.status === 401 || crossed.status === 403,
    `a grant for one project must not authorize another (${crossed.status})`);
});

test('a forged proposal is refused — the engine only applies what IT prepared', async () => {
  const port = PORT + 9;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const before = hashes(repo);

  // The whole attack in one request: no preview, arbitrary Record line.
  const forged = await request(port, '/closure/decide', {
    method: 'POST',
    token,
    body: {
      projectId: id, decision: 'accept',
      proposal: {
        proposalId: 'made-up',
        boundProjectId: id,
        record: { file: '.intent/decisions.md', append: '- 2026-07-29 — All tests passed. Verified.' },
        next: { file: '.intent/next.json', change: null },
        baseline: {},
      },
    },
  });
  assert.strictEqual(forged.status, 409);
  assert.match(forged.body.error, /review/i);
  assert.deepStrictEqual(hashes(repo), before, 'a forged closure must write nothing');

  const decisions = fs.readFileSync(path.join(repo, '.intent', 'decisions.md'), 'utf8');
  assert.doesNotMatch(decisions, /All tests passed/u);
});

test('a proposal id from a previous node cannot be replayed after a restart', async () => {
  const port = PORT + 10;
  const { env, repo } = fixture();
  const first = startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  let token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;
  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Reviewed on the old node.' },
  });
  const proposalId = preview.body.proposalId;

  first.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  startServe(port + 100, repo, env);
  await waitForNode(port + 100);
  token = await provenSession(port + 100, id);
  const before = hashes(repo);

  const replay = await request(port + 100, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId },
  });
  // Failing closed is the honest outcome: the review happened against a state
  // this node never saw.
  assert.strictEqual(replay.status, 409);
  assert.deepStrictEqual(hashes(repo), before);
});

// ─── Journey item 13: nothing writes project truth except an accepted closure ─
// Signing in later must not silently upload, duplicate, replace, or rebind
// local truth. The strongest local form of that promise: exactly ONE code path
// writes .intent/, and it is the one a person clicked Accept on.

test('every local operation except an accepted closure leaves .intent/ byte-identical', async () => {
  const port = PORT + 11;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const before = hashes(repo);

  // The whole local surface, exercised in order.
  const token = await provenSession(port, id);            // handshake
  await request(port, '/health');                          // discovery
  await request(port, `/local-truth?projectId=${id}`);     // read Project/Next/Record
  await runOnce(port, id, 'change a file', token);         // a real run
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token }))
    .body.receipts[0].receiptId;
  await request(port, `/receipt?id=${receiptId}`, { token });
  const preview = await request(port, '/closure/preview', {
    method: 'POST', token,
    body: { projectId: id, receiptId, note: 'Previewed, not accepted.', markNextDone: true },
  });
  await request(port, '/closure/decide', {
    method: 'POST', token,
    body: { projectId: id, decision: 'reject', proposalId: preview.body.proposalId },
  });
  // A second handshake, as a later sign-in or reload would do.
  await provenSession(port, id);

  assert.deepStrictEqual(hashes(repo), before,
    'only an accepted closure may change project truth');
});
