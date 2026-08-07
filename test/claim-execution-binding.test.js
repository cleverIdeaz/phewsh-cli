// `/claim` starts a harness — so it needs a reviewed contract, not just a repo.
//
// The repository binding on this route was already strong: a cloud uuid resolves
// to exactly one deliberately registered repo, the grant must name that repo,
// and the live origin must still match. What was missing is that ONE authorized
// POST created a branch, created a worktree, and launched a harness with no
// reviewed action contract, no worker binding, and no commit baseline — so an
// approval given for one task, one route, one machine and one tree could be
// spent on a different one.
//
// `/dispatch` already solved this shape. These tests hold `/claim` to it.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { request, pair, listProjects, grantFor, projHdr } = require('./helpers/grants');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
// Test port bands must never contain a RESERVED RUNTIME PORT. This band used to
// be 7400+rand(120) = 7400–7519, which straddles **7483 — the default
// `phewsh serve` port**. Any developer with Desktop open (Desktop starts serve)
// could have this suite talk to their real node instead of its fixture, and the
// collision is silent: `waitForNode` succeeds against whichever node answers,
// the approval code prints on the other process, and it surfaces only as
// "the node never displayed an approval code".
//
// Reserved: 7483 (`phewsh serve` default). Bands in use, base + ~12 offsets:
//   7560–7631 local-session      7660–7731 mcp-http-binding
//   7760–7811 cancellation       7840–7891 closure-endpoints
//   7940–7991 dispatch-binding   8100–8311 serve-bridge
//   8500–8611 endpoint-policy    8700–8771 ground-project
//   8800–8891 critic-findings
// 7992–8099 is the free gap; this file needs 11 ports (offsets 0–10), so the
// span is capped to keep the top of the band (8069+10 = 8079) clear of 8100.
const PORT = 8000 + Math.floor(Math.random() * 70);
const CLOUD_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TASK_ID = '33333333-3333-4333-8333-333333333333';

/** A registered repo linked to a cloud project, with one real commit. */
function makeRepo(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-${label}-`));
  const repo = path.join(root, 'team-app');
  fs.mkdirSync(path.join(repo, '.intent'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.intent', 'pps.json'),
    JSON.stringify({ adapters: { phewsh: { cloud_id: CLOUD_ID } } }),
  );
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  // Pinned, not inherited: `init.defaultBranch` varies by machine, and a test
  // that asserts the bound branch must not assert the developer's git config.
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['remote', 'add', 'origin', 'https://github.com/example/team-app.git']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# team-app\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'first']);

  const indexFile = path.join(root, 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify({
    projects: {
      [repo]: { name: 'team-app', path: repo, remote: 'github.com/example/team-app', serve: true },
    },
  }));
  return { root, repo, indexFile };
}

function startServe(port, env) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d.toString(); });
  child.stderr.on('data', (d) => { child.out += d.toString(); });
  return child;
}

function waitForListen(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (/Running on/.test(child.out)) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`serve never listened:\n${child.out}`));
      setTimeout(poll, 100);
    })();
  });
}

/**
 * A node with one registered, cloud-linked repo and a `work:run` grant on it.
 *
 * The grant is obtained the way a person obtains one — pairing, discovery, then
 * an elevated approval read off the terminal. There is no test-only shortcut,
 * because a shortcut would stop these tests proving the thing they exist for.
 */
async function bootNode(port, label) {
  const fixture = makeRepo(label);
  const child = startServe(port, {
    PHEWSH_PROJECT_INDEX: fixture.indexFile,
    HOME: fixture.root,
    PHEWSH_HOME: fixture.root,
  });
  await waitForListen(child);
  const hostGrant = await pair(port, child);
  const [project] = await listProjects(port, hostGrant);
  const token = await grantFor(port, hostGrant, project.id, ['work:run']);
  return { ...fixture, child, hostGrant, project, token };
}

const post = (port, pathname, body, token) => request(port, pathname, {
  method: 'POST', body, headers: token ? projHdr(token) : {},
});

/** Review one claim, returning the held contract id. */
async function review(port, token, body = {}) {
  const res = await post(port, '/claim/contract', {
    projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, ...body,
  }, token);
  assert.strictEqual(res.status, 200, `contract review refused: ${res.raw}`);
  return res;
}

test('/claim refuses to start a harness without a reviewed contract', async () => {
  const port = PORT;
  const node = await bootNode(port, 'claim-nocontract');
  try {
    const res = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null,
    }, node.token);
    assert.strictEqual(res.status, 400, `an unreviewed claim must be refused: ${res.raw}`);
    assert.match(res.body.error, /review/i, 'the refusal must say how to get a contract');
    assert.ok(!res.body.claimId, 'no claim may be started');
    // The proof that matters: nothing was spawned.
    assert.doesNotMatch(node.child.out, /Ion claim/, 'a harness was started without a contract');
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('/claim/contract states the project, branch, HEAD, task, route and worker it binds', async () => {
  const port = PORT + 1;
  const node = await bootNode(port, 'claim-contract');
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: node.repo, encoding: 'utf8' }).trim();
    const res = await review(port, node.token);
    const { contract, contractId } = res.body;
    assert.match(contractId, /^[0-9a-f]{24}$/u, 'a contract must be named by an engine-minted id');
    assert.strictEqual(contract.boundProjectId, node.project.id);
    assert.strictEqual(contract.boundProjectRemote, 'github.com/example/team-app');
    assert.strictEqual(contract.boundCloudProjectId, CLOUD_ID);
    assert.strictEqual(contract.boundTaskId, TASK_ID);
    assert.strictEqual(contract.boundBranch, 'main');
    assert.strictEqual(contract.boundHead, head);
    assert.ok(contract.boundWorkerId, 'a run must name the worker that will execute it');
    assert.match(contract.executionDigest, /^[0-9a-f]{64}$/u);
    // The authority sentence must not promise containment Phewsh cannot enforce.
    assert.match(contract.authority, /Phewsh does not confine it/);
    // A worktree and a branch are repository mutations. Say so before approval.
    assert.match(contract.writes, /branch/i);
    assert.match(contract.writes, /worktree/i);
    // The grant is bound by fingerprint, never by restating the secret.
    assert.ok(contract.boundGrantFingerprint, 'the contract must bind the grant that reviewed it');
    assert.doesNotMatch(JSON.stringify(contract), new RegExp(node.token), 'a grant token must never travel inside a contract');
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('a contract reviewed for one task cannot be spent on another', async () => {
  const port = PORT + 2;
  const node = await bootNode(port, 'claim-task');
  try {
    const { body: { contractId } } = await review(port, node.token);
    const res = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: OTHER_TASK_ID, runtimeId: null, contractId,
    }, node.token);
    assert.strictEqual(res.status, 409, `a task swap must conflict: ${res.raw}`);
    assert.doesNotMatch(node.child.out, /Ion claim/, 'a harness ran on a task nobody reviewed');
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('a contract reviewed for one route cannot be spent on another', async () => {
  const port = PORT + 3;
  const node = await bootNode(port, 'claim-route');
  try {
    const { body: { contractId } } = await review(port, node.token);
    // `claude-code` may or may not be installed here; either way it is not the
    // route this contract was reviewed for, and that alone must refuse.
    const res = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: 'claude-code', contractId,
    }, node.token);
    assert.ok(res.status === 409 || res.status === 400, `a route swap must be refused: ${res.raw}`);
    assert.doesNotMatch(node.child.out, /Ion claim/, 'a harness ran on a route nobody reviewed');
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('a caller may not supply its own claim contract', async () => {
  const port = PORT + 4;
  const node = await bootNode(port, 'claim-forged');
  try {
    const res = await post(port, '/claim', {
      projectId: CLOUD_ID,
      taskId: TASK_ID,
      runtimeId: null,
      contract: { authority: 'Sandboxed. Cannot touch anything.', boundProjectId: 'anything' },
    }, node.token);
    assert.strictEqual(res.status, 400, `a supplied contract must be refused outright: ${res.raw}`);
    assert.doesNotMatch(node.child.out, /Ion claim/);
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('one review authorizes one run — a spent contract cannot be replayed', async () => {
  const port = PORT + 5;
  const node = await bootNode(port, 'claim-replay');
  try {
    const { body: { contractId } } = await review(port, node.token);
    const first = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId,
    }, node.token);
    assert.strictEqual(first.status, 202, `the reviewed claim must run: ${first.raw}`);

    const replay = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId,
    }, node.token);
    assert.strictEqual(replay.status, 409, `a spent contract must not run twice: ${replay.raw}`);
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('a claim approved before the branch moved is refused, and the approval is consumed', async () => {
  const port = PORT + 6;
  const node = await bootNode(port, 'claim-moved');
  try {
    const { body: { contractId } } = await review(port, node.token);

    // The reviewer said yes to the code that was there. Move it.
    fs.writeFileSync(path.join(node.repo, 'README.md'), '# team-app\n\nchanged\n');
    execFileSync('git', ['add', 'README.md'], { cwd: node.repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', 'second'], { cwd: node.repo, stdio: 'ignore' });

    const stale = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId,
    }, node.token);
    assert.strictEqual(stale.status, 409, `a moved checkout must refuse: ${stale.raw}`);
    assert.match(stale.body.error, /moved|changed/i);
    assert.doesNotMatch(node.child.out, /Ion claim/, 'a harness ran against code nobody reviewed');

    // ...and the refusal SPENDS it. A stale approval left decidable is one a
    // caller retries until the tree happens to line up again.
    const retry = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId,
    }, node.token);
    assert.strictEqual(retry.status, 409, `a refused contract must not survive: ${retry.raw}`);
    assert.match(retry.body.error, /missing|expired|already used/i);
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('the claim receipt names the repository and the commit baseline it ran against', async () => {
  const port = PORT + 7;
  const node = await bootNode(port, 'claim-receipt');
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: node.repo, encoding: 'utf8' }).trim();
    const { body: { contractId } } = await review(port, node.token);
    const res = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId,
    }, node.token);
    assert.strictEqual(res.status, 202, res.raw);

    const sessionsDir = path.join(node.root, '.phewsh', 'sessions');
    const file = fs.readdirSync(sessionsDir).find((f) => f.endsWith('_sessions.json'));
    assert.ok(file, 'a claim that started a harness left no session event');
    const events = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
    const event = events.find((e) => e.event === 'local_claim_requested');
    assert.ok(event, 'no local_claim_requested event was recorded');

    // The whole point: this receipt used to carry only claimId + taskId, which
    // made it the one execution route whose evidence could not be traced to a
    // repository.
    assert.strictEqual(event.boundProjectId, node.project.id);
    assert.strictEqual(event.boundProjectRemote, 'github.com/example/team-app');
    assert.strictEqual(event.boundCloudProjectId, CLOUD_ID);
    assert.strictEqual(event.boundHead, head);
    assert.strictEqual(event.boundBranch, 'main');
    assert.strictEqual(event.taskId, TASK_ID);
    assert.ok(event.boundWorkerId, 'the receipt must name the worker that executed');
    assert.ok(event.contractId, 'the receipt must name the contract that authorized it');
    // Filed under the project NAME, the grouping key the receipt layer reads —
    // not under the literal "ion", which was findable from no project at all.
    assert.strictEqual(event.projectId, 'team-app');
  } finally {
    node.child.kill('SIGKILL');
  }
});

// ─── Claim state: what the Work board reads ─────────────────────────────────
//
// /status/:jobId covers the dispatch path only — its jobs are keyed by a jobId
// no Ion task ever has. Claimed tasks are keyed by the task itself, which is
// the handle a board actually holds, so they report through /claim/status.

const get = (port, pathname, token) => request(port, pathname, {
  method: 'GET', headers: token ? projHdr(token) : {},
});

/** Wait for a claim to reach a terminal state, or fail loudly. */
async function settled(port, token, taskId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get(port, '/claim/status', token);
    assert.strictEqual(res.status, 200, `claim status refused: ${res.raw}`);
    const claim = res.body.claims.find((c) => c.taskId === taskId);
    if (claim && ['completed', 'failed', 'cancelled'].includes(claim.state)) return claim;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`claim ${taskId.slice(0, 8)} never reached a terminal state`);
}

test('claim state is not readable without the same grant that starts a claim', async () => {
  const port = PORT + 8;
  const node = await bootNode(port, 'claim-status-ungranted');
  try {
    // An ungranted caller must learn nothing — not the tasks, not that any
    // exist. The same rule /claim itself follows.
    const res = await get(port, '/claim/status');
    assert.ok(res.status === 401 || res.status === 403, `ungranted read must refuse, got ${res.status}: ${res.raw}`);
    assert.ok(!/taskId|claims/.test(res.raw) || !res.body?.claims, 'a refusal must not enumerate claims');
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('a finished claim keeps its outcome instead of vanishing, and the task can be claimed again', async () => {
  const port = PORT + 9;
  const node = await bootNode(port, 'claim-status-outcome');
  try {
    const { body: { contractId } } = await review(port, node.token);
    const started = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId,
    }, node.token);
    assert.strictEqual(started.status, 202, `the reviewed claim must run: ${started.raw}`);

    // Before this, a finished claim was DELETED: a task that completed or
    // failed became indistinguishable from one never claimed at all.
    const claim = await settled(port, node.token, TASK_ID);
    assert.ok(['completed', 'failed'].includes(claim.state));
    assert.strictEqual(claim.taskId, TASK_ID);
    assert.ok(claim.changedAt, 'a terminal claim must carry when it changed, not just when it started');
    assert.ok(Date.parse(claim.changedAt) >= Date.parse(claim.startedAt));

    // Keeping the outcome must not cost the ability to retry. A fresh review
    // of the same task has to be accepted, not refused as "already claiming".
    const { body: { contractId: second } } = await review(port, node.token);
    const retry = await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId: second,
    }, node.token);
    assert.strictEqual(retry.status, 202, `a finished task must be re-claimable: ${retry.raw}`);
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('claim state names the task, project and worker without leaking the child process', async () => {
  const port = PORT + 10;
  const node = await bootNode(port, 'claim-status-shape');
  try {
    const { body: { contractId } } = await review(port, node.token);
    await post(port, '/claim', {
      projectId: CLOUD_ID, taskId: TASK_ID, runtimeId: null, contractId,
    }, node.token);
    const claim = await settled(port, node.token, TASK_ID);

    assert.strictEqual(claim.cloudProjectId, CLOUD_ID);
    assert.ok(claim.projectId, 'the stable local project id must be named');
    assert.ok(claim.claimId, 'the claim must be identifiable');
    // The map holds a live ChildProcess. Serializing it would put a PID and a
    // pile of stream handles on the wire.
    assert.strictEqual(claim.child, undefined, 'the child process handle must never be serialized');

    const res = await get(port, '/claim/status', node.token);
    assert.ok(res.body.workerId, 'the answer must name which worker it came from');
    assert.ok(res.body.observedAt, 'the answer must say when it was observed');
    assert.ok(!/"child"|"_handle"|"stdin"/.test(res.raw), `no process internals on the wire: ${res.raw.slice(0, 200)}`);
  } finally {
    node.child.kill('SIGKILL');
  }
});
