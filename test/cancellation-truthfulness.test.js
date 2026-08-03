// Cancellation has to be a fact, not a label.
//
// `/cancel` set `status = 'cancelled'` — a TERMINAL state — the moment it was
// asked, then sent SIGTERM to the direct child only. Three things were wrong at
// once:
//
//   1. The API claimed the run was over while the harness was still executing
//      and still writing files into the person's repository.
//   2. A harness that ignores SIGTERM was never actually stopped, so "cancelled"
//      could be permanently false.
//   3. Only the direct child was signalled, so anything the harness spawned kept
//      running as an orphan.
//
// So there is now a non-terminal `cancelling` state, the whole process GROUP is
// signalled with bounded escalation to SIGKILL, and `cancelled` plus its receipt
// are written only once exit is actually observed.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { pair, listProjects, grantFor } = require('./helpers/grants');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const PORT = 7760 + Math.floor(Math.random() * 40);

const children = [];
after(() => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

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
        try { parsed = JSON.parse(raw); } catch { /* asserting on raw is valid */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A harness that refuses to die politely and takes a child with it. `trap '' TERM`
 * ignores SIGTERM; the background subshell inherits that, and keeps touching a
 * heartbeat file so the test can prove it really stopped rather than assuming it.
 */
function stubbornHarnessDir(heartbeat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-stubborn-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, [
    '#!/bin/sh',
    "trap '' TERM",
    `( while : ; do echo tick >> "${heartbeat}"; sleep 0.05; done ) &`,
    'while : ; do sleep 0.05; done',
  ].join('\n') + '\n');
  fs.chmodSync(bin, 0o755);
  return dir;
}

function fixture(heartbeat) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-cancelhome-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-cancelrepo-')));
  const env = {
    PHEWSH_HOME: home, HOME: home,
    PATH: `${stubbornHarnessDir(heartbeat)}${path.delimiter}${process.env.PATH}`,
    // A short grace period so the escalation is observable in a test rather than
    // a wall-clock wait.
    PHEWSH_CANCEL_GRACE_MS: '300',
  };
  fs.mkdirSync(path.join(repo, '.intent'));
  fs.writeFileSync(path.join(repo, '.intent', 'vision.md'), '# Vision\n\nCancel fixture.\n');
  const run = (cmd, args) => execFileSync(cmd, args, {
    cwd: repo, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
  });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'cancel@fixture.test']);
  run('git', ['config', 'user.name', 'Cancel Fixture']);
  run('git', ['remote', 'add', 'origin', 'https://github.com/example/cancel.git']);
  run(process.execPath, [BIN, 'project', 'add']);
  return { home, repo, env };
}

function startServe(port, cwd, env) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', ...env },
  });
  children.push(child);
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d.toString(); });
  child.stderr.on('data', () => {});
  return child;
}

async function waitForNode(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await request(port, '/health')).status === 200) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`node did not start on ${port}`);
}

async function waitForStatus(port, jobId, token, predicate, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(port, `/status/${jobId}`, { token });
    last = res.body;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`status never satisfied predicate (last: ${JSON.stringify(last)})`);
}

test('cancelling stays non-terminal until the process is really gone, and takes the whole group', async () => {
  const port = PORT;
  const heartbeat = path.join(os.tmpdir(), `phewsh-heartbeat-${process.pid}-${Date.now()}.log`);
  const { repo, env, home } = fixture(heartbeat);
  const node = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, node);
  const project = (await listProjects(port, hostGrant))[0];
  const token = await grantFor(port, hostGrant, project.id, ['truth:read', 'work:run', 'work:control']);

  const reviewed = await request(port, '/contract', {
    method: 'POST', token, body: { projectId: project.id, runtimeId: 'claude-code', task: 'run forever' },
  });
  assert.strictEqual(reviewed.status, 200, `contract review failed: ${reviewed.raw}`);

  const dispatched = await request(port, '/dispatch', {
    method: 'POST', token,
    body: {
      actionId: 'cancel-stubborn', runtimeId: 'claude-code', projectId: project.id,
      contractId: reviewed.body.contractId,
      packet: { version: '1.0', id: 'cancel-stubborn', objective: { task: 'run forever' } },
    },
  });
  assert.ok(dispatched.body.jobId, `dispatch must be accepted: ${dispatched.raw}`);
  const { jobId } = dispatched.body;

  // Wait until the harness is genuinely running — its child is ticking.
  await waitForStatus(port, jobId, token, (s) => s.status === 'executing');
  const ticking = Date.now() + 4000;
  while (!fs.existsSync(heartbeat) && Date.now() < ticking) {
    await new Promise((r) => setTimeout(r, 60));
  }
  assert.ok(fs.existsSync(heartbeat), 'the stub harness never started its child');

  const cancel = await request(port, '/cancel', { method: 'POST', token, body: { jobId } });
  assert.strictEqual(cancel.status, 200, cancel.raw);
  // The decisive assertion: the run is NOT over yet, and the API must not say it
  // is. This harness ignores SIGTERM, so at this instant it is still alive.
  assert.strictEqual(cancel.body.status, 'cancelling',
    'a cancel that has not been observed to finish must not report a terminal state');

  // Escalation must then actually end it.
  const terminal = await waitForStatus(port, jobId, token, (s) => s.status === 'cancelled');
  assert.strictEqual(terminal.status, 'cancelled');

  // And the whole process GROUP is gone: the harness's child stops ticking.
  await new Promise((r) => setTimeout(r, 400));
  const settled = fs.statSync(heartbeat).size;
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(fs.statSync(heartbeat).size, settled,
    'a process the harness spawned is still running after cancellation');

  // A cancelled run leaves the same evidence as any other terminal state.
  const receipts = await request(port, `/receipts/run?projectId=${project.id}`, { token });
  assert.strictEqual(receipts.status, 200, receipts.raw);
  assert.ok(receipts.body.receipts.length >= 1, 'a cancelled run must leave a receipt');
  const resultsDir = path.join(home, '.phewsh', 'results');
  assert.ok(
    fs.existsSync(resultsDir) && fs.readdirSync(resultsDir).length > 0,
    'a cancelled run must leave a result file, like every other terminal state',
  );

  // Retrying the cancel is safe and does not relabel the finished run.
  const retry = await request(port, '/cancel', { method: 'POST', token, body: { jobId } });
  assert.strictEqual(retry.body.status, 'cancelled');
});
