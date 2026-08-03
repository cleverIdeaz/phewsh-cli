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
const PORT = 7840 + Math.floor(Math.random() * 40);

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

// A closure decision is a person's judgement, and the FIRST one is the answer.
// Rejection returned an outcome and recorded nothing durable, so the proposal
// stayed decidable: a reject followed by an accept still wrote the Record line
// the person had just declined. The reverse is as bad — an accept followed by a
// reject answered "reject, applied: false" for work already in project truth.
test('the first closure decision is final — the opposite replay is a conflict', async () => {
  const port = PORT + 20;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;
  const before = hashes(repo);

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Declining this.', markNextDone: true },
  });
  const { proposalId } = preview.body;

  const rejected = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'reject', proposalId },
  });
  assert.strictEqual(rejected.body.decision, 'reject');
  assert.deepStrictEqual(hashes(repo), before);

  // The identical retry of a lost response is safe and says the same thing.
  const replay = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'reject', proposalId },
  });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.decision, 'reject');
  assert.strictEqual(replay.body.applied, false);
  assert.deepStrictEqual(hashes(repo), before, 'a replayed rejection must still write nothing');

  // Changing the answer afterwards is not a retry. It must not write.
  const flipped = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId },
  });
  assert.strictEqual(flipped.status, 409, `a reversed decision must conflict: ${flipped.raw}`);
  assert.match(String(flipped.body.error), /reject/i, 'the refusal must name the decision already made');
  assert.deepStrictEqual(hashes(repo), before,
    'the Record must not carry a line the person declined');
});

// Found by an independent critic: the finality check above was one HTTP call away
// from useless. A proposalId is DERIVED from the receipt, the note and the
// baseline, so re-running the identical preview returns the same id — and
// remembering it overwrote the stored entry, discarding the decision with it.
// Reject, preview again, accept: the declined line went into the Record with no
// second human gesture anywhere.
test('re-previewing an identical proposal cannot launder away a rejection', async () => {
  const port = PORT + 24;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;
  const before = hashes(repo);

  const body = { projectId: id, receiptId, note: 'Reviewed and DECLINED.', markNextDone: true };
  const first = await request(port, '/closure/preview', { method: 'POST', token, body });
  const rejected = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'reject', proposalId: first.body.proposalId },
  });
  assert.strictEqual(rejected.body.decision, 'reject');

  // The same review again. Same inputs, same baseline, therefore the same id.
  const second = await request(port, '/closure/preview', { method: 'POST', token, body });
  assert.strictEqual(second.status, 200, second.raw);
  assert.strictEqual(second.body.proposalId, first.body.proposalId,
    'this test is only meaningful while the id is deterministic');

  const flipped = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId: second.body.proposalId },
  });
  assert.strictEqual(flipped.status, 409, `a re-preview must not reopen the decision: ${flipped.raw}`);
  assert.deepStrictEqual(hashes(repo), before,
    'the Record must not carry a line the person declined');
});

test('an accepted closure cannot be reversed into a rejection', async () => {
  const port = PORT + 21;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Adopting this.', markNextDone: true },
  });
  const { proposalId } = preview.body;

  const accepted = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'accept', proposalId },
  });
  assert.strictEqual(accepted.body.applied, true);
  const afterAccept = hashes(repo);

  const flipped = await request(port, '/closure/decide', {
    method: 'POST', token, body: { projectId: id, decision: 'reject', proposalId },
  });
  assert.strictEqual(flipped.status, 409, `a reversed decision must conflict: ${flipped.raw}`);
  assert.match(String(flipped.body.error), /accept/i);
  assert.deepStrictEqual(hashes(repo), afterAccept,
    'a rejection cannot un-write accepted project truth, so it must not pretend to');
});

// A grant names a REPOSITORY. If `.intent` is a symlink, `truth:read` for one
// project becomes a reader for wherever the link points, and an accepted closure
// writes the Record outside the repo. Creating that link needs no privilege —
// every harness the engine runs inside a registered repo can do it.
test('a symlinked .intent cannot be read or written through a project grant', async () => {
  const port = PORT + 22;
  const { env, repo } = fixture();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-outside-truth-')));
  fs.writeFileSync(path.join(outside, 'decisions.md'), '# Not this project\n');
  fs.writeFileSync(path.join(outside, 'vision.md'), '# Someone else\n');

  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);

  // Registered honestly, then re-pointed at another directory entirely.
  fs.rmSync(path.join(repo, '.intent'), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, '.intent'));

  const truth = await request(port, `/local-truth?projectId=${id}`, { token });
  assert.strictEqual(truth.status, 403, `a link out of the repo must be refused: ${truth.raw}`);
  assert.match(String(truth.body.error), /outside the registered project/i,
    'the refusal must be containment, so this cannot pass for some other reason');
  assert.ok(!truth.raw.includes('Someone else'), 'no content from outside the repo may be returned');

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId: 'r-anything', note: 'x' },
  });
  assert.ok(preview.status >= 400, 'no proposal may be built against truth outside the repo');
  assert.deepStrictEqual(
    fs.readFileSync(path.join(outside, 'decisions.md'), 'utf8'), '# Not this project\n',
    'nothing outside the repository may be written',
  );
});

// Repo A, then repo B, at the SAME PATH.
//
// This is the sharp case because the stable project id is derived from the path,
// so A and B share one id. Only the bound remote can tell them apart. If any
// surface trusts the id alone, then cloning a different repository over a
// registered directory inherits the previous project's grants and evidence —
// and could close A's work into B's Record.
test('a different repository at the same path inherits nothing from the last one', async () => {
  const port = PORT + 23;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const tokenA = await provenSession(port, id);
  await runOnce(port, id, 'work done for repo A', tokenA);
  const receiptA = (await request(port, `/receipts/run?projectId=${id}`, { token: tokenA }))
    .body.receipts[0].receiptId;
  assert.ok(receiptA, 'repo A must have left a receipt to try to misuse');

  // Repo B now occupies that directory, and is registered honestly.
  const git = (args) => execFileSync('git', args, {
    cwd: repo, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
  });
  git(['remote', 'set-url', 'origin', 'https://github.com/example/somewhere-else.git']);
  execFileSync(process.execPath, [BIN, 'project', 'add'], {
    cwd: repo, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
  });

  // 1. The old grant cannot control anything, even though its id still matches.
  const stale = await request(port, `/receipts/run?projectId=${id}`, { token: tokenA });
  assert.ok(stale.status >= 400,
    `a grant for the previous repository must not act on this one: ${stale.raw}`);

  const idB = await projectId(port);
  assert.strictEqual(idB, id, 'this test is only meaningful while the path-derived id is unchanged');
  const tokenB = await provenSession(port, idB);

  // 2. A's evidence must not appear in B's list.
  const listed = await request(port, `/receipts/run?projectId=${idB}`, { token: tokenB });
  assert.strictEqual(listed.status, 200, listed.raw);
  assert.ok(
    !listed.body.receipts.some((r) => r.receiptId === receiptA),
    "the previous repository's receipts must not auto-list for this one",
  );

  // 3. Nor be readable by id under B's grant.
  const read = await request(port, `/receipt?id=${receiptA}`, { token: tokenB });
  assert.strictEqual(read.status, 403, `A's receipt must not be readable as B: ${read.raw}`);

  // 4. Nor be closeable into B's Record — the whole point.
  const beforeTruth = hashes(repo);
  const preview = await request(port, '/closure/preview', {
    method: 'POST', token: tokenB,
    body: { projectId: idB, receiptId: receiptA, note: 'Adopting the other repo work.' },
  });
  assert.ok(preview.status >= 400, `A's evidence must not build a proposal for B: ${preview.raw}`);
  assert.deepStrictEqual(hashes(repo), beforeTruth,
    "B's project truth must be byte-identical after the attempt");
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

test('an altered receipt cannot produce a closure preview', async () => {
  const port = PORT + 13;
  const { env, repo, home } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token }))
    .body.receipts[0].receiptId;
  const before = hashes(repo);

  // Keep the JSON readable while changing its bytes, so the data layer returns
  // the explicit `altered` verdict rather than treating the receipt as missing.
  fs.appendFileSync(path.join(home, '.phewsh', 'receipts', `${receiptId}.json`), '\n');

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token,
    body: { projectId: id, receiptId, note: 'Must not reach the Record.' },
  });
  assert.strictEqual(preview.status, 409, preview.raw);
  assert.match(String(preview.body?.error || ''), /integrity.*intact/iu);
  assert.deepStrictEqual(hashes(repo), before,
    'a receipt that fails integrity must not change project truth');
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

test('an expired closure review cannot be applied to project truth', async () => {
  const port = PORT + 12;
  const { env, repo } = fixture();
  env.PHEWSH_PROPOSAL_TTL_MS = '20';
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token }))
    .body.receipts[0].receiptId;
  const preview = await request(port, '/closure/preview', {
    method: 'POST', token,
    body: { projectId: id, receiptId, note: 'This review must expire.', markNextDone: true },
  });
  assert.strictEqual(preview.status, 200, preview.raw);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = hashes(repo);

  const expired = await request(port, '/closure/decide', {
    method: 'POST', token,
    body: {
      projectId: id, decision: 'accept', proposalId: preview.body.proposalId,
    },
  });
  assert.strictEqual(expired.status, 409, `an expired review was applied (${expired.status})`);
  assert.match(String(expired.body?.error || ''), /expired|review/i);
  assert.deepStrictEqual(hashes(repo), before,
    'an expired closure review changed Project truth');
});

// Found by an independent critic: a raw `fs` ENOENT was handed straight to the
// caller, carrying the absolute repository path and this node's PID — while
// /host/projects and /cockpit deliberately withhold absolute paths. And
// /closure/preview answered 200 for a project with no .intent/ at all, so it
// previewed a write that could never succeed and failed later as that same raw error.
test('a project with no .intent/ is refused honestly, without leaking a path or a pid', async () => {
  const port = PORT + 25;
  const { env, repo } = fixture();
  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);
  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;

  fs.rmSync(path.join(repo, '.intent'), { recursive: true });

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token, body: { projectId: id, receiptId, note: 'Adopting this.' },
  });
  assert.ok(preview.status >= 400, `a project with no Record must be refused: ${preview.raw}`);
  assert.match(String(preview.body.error), /\.intent/, 'the refusal must name what is missing');

  // Nothing in any refusal may carry an absolute path or this process's pid.
  for (const raw of [preview.raw]) {
    assert.ok(!raw.includes(repo), `the absolute repo path leaked: ${raw}`);
    assert.ok(!/ENOENT|\.tmp/.test(raw), `a raw fs error leaked: ${raw}`);
    assert.ok(!new RegExp(`\\b${process.pid}\\b`).test(raw), `a pid leaked: ${raw}`);
  }
});

// The journey the whole loop exists for: does the PROJECT actually move?
//
// Every test above proves the loop is SAFE — rejections leave truth
// byte-identical, replays conflict, forged proposals are refused, stale reviews
// fail closed. None of them proves it is USEFUL. A person does not run work to
// admire a receipt; they run it so the project advances and they are told what
// is next. That is the difference between a tool that did a thing and a layer
// that keeps a project moving, and until now nothing asserted it.
test('accepting a run advances the project — the next obligation becomes the current one', async () => {
  const port = PORT + 26;
  const { env, repo } = fixture();

  // Two obligations, so "done" has somewhere to go. With only one, finishing it
  // leaves an empty Next, which proves nothing about advancing.
  fs.writeFileSync(path.join(repo, '.intent', 'next.json'), JSON.stringify({
    items: [
      { id: 'n1', title: 'Close the loop', state: 'now', criteria: [] },
      { id: 'n2', title: 'Write the handoff', state: 'next', criteria: [] },
    ],
  }, null, 2));

  startServe(port, repo, env);
  await waitForNode(port);
  const id = await projectId(port);
  const token = await provenSession(port, id);

  const before = await request(port, `/local-truth?projectId=${id}`, { token });
  assert.strictEqual(before.body.next.title, 'Close the loop', 'the fixture must start on the first obligation');
  const recordBefore = before.body.record.total;

  await runOnce(port, id, 'change a file', token);
  const receiptId = (await request(port, `/receipts/run?projectId=${id}`, { token })).body.receipts[0].receiptId;

  const preview = await request(port, '/closure/preview', {
    method: 'POST', token,
    body: { projectId: id, receiptId, note: 'This closes the loop.', markNextDone: true },
  });
  assert.strictEqual(preview.status, 200, `preview refused: ${preview.raw}`);

  const decided = await request(port, '/closure/decide', {
    method: 'POST', token,
    body: { projectId: id, decision: 'accept', proposalId: preview.body.proposalId },
  });
  assert.strictEqual(decided.status, 200, `accept refused: ${decided.raw}`);

  // THE ASSERTION THAT MATTERS: read the project the way a surface reads it,
  // and the obligation a person is looking at has moved on.
  const after = await request(port, `/local-truth?projectId=${id}`, { token });
  assert.strictEqual(after.status, 200);
  assert.strictEqual(
    after.body.next.title, 'Write the handoff',
    'the project did not advance — the finished obligation is still the current one',
  );

  // ...and what was learned was kept, not just what was done.
  assert.ok(after.body.record.total > recordBefore,
    'the Record did not grow — the outcome was applied but nothing was remembered');

  // The completed item is marked done in the project's own files, so a
  // different tool opening this repo next sees the same advance.
  const onDisk = JSON.parse(fs.readFileSync(path.join(repo, '.intent', 'next.json'), 'utf8'));
  assert.strictEqual(onDisk.items.find((i) => i.id === 'n1').state, 'done',
    'the finished obligation was not recorded as done in .intent/');
});
