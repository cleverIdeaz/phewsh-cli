// A dispatched run must happen IN the project it was requested for.
//
// The local handshake proves which workspace a browser is looking at, but it
// grants no execution authority. When a run is finally authorized, the engine
// must bind it to the same repository the grant named — resolved from the
// registry by stable id, never from a path the caller sent, never from a
// display name, never "first match", and never whatever directory the worker
// happened to be started in.
//
// The decisive shape of these tests: start the node in repo A, register A and
// B, dispatch to B, and make the spawned process report its OWN working
// directory. Nothing here trusts the engine's account of itself.
//
// Owner layer: CLI.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { pair, listProjects, grantFor } = require('./helpers/grants');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const PORT = 7940 + Math.floor(Math.random() * 40);

const children = [];
after(() => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } });

// The node's stdout is kept because the pairing approval code is printed there
// — a test reads it exactly where the human would.
const nodesByPort = new Map();

function startServe(port, cwd, env = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...env },
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
        try { parsed = JSON.parse(raw); } catch { /* non-JSON is a valid outcome to assert on */ }
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
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`node did not start on ${port}`);
}

// Status now belongs to the grant that started the job, so polling carries it.
async function pollStatus(port, jobId, token, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await request(port, `/status/${jobId}`, { token });
    last = res;
    if (res.body && ['done', 'error', 'cancelled'].includes(res.body.status)) return res.body;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`job did not reach a terminal state (last: ${last && last.raw})`);
}

/**
 * A harness that reports its own working directory and nothing else. This is
 * the only witness that cannot be fooled by the engine agreeing with itself.
 */
function fakeHarnessDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-fakebin-'));
  const bin = path.join(dir, 'claude');
  // `node -e` rather than `pwd`: a shell's `pwd` can echo an inherited PWD env
  // var instead of the real directory, which would make this witness lie.
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} -e "console.log(process.cwd())"\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

/** One isolated machine with two real, separately registered repos. */
function twoRepos() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-bindhome-'));
  const env = { PHEWSH_HOME: home, HOME: home, PATH: `${fakeHarnessDir()}${path.delimiter}${process.env.PATH}` };
  const make = (label, remote) => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-${label}-`)));
    fs.mkdirSync(path.join(repo, '.intent'));
    fs.writeFileSync(path.join(repo, '.intent', 'vision.md'), `# Vision\n\n${label} truth.\n`);
    const run = (cmd, args) => execFileSync(cmd, args, {
      cwd: repo, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
    });
    run('git', ['init', '-q']);
    run('git', ['config', 'user.email', 'bind@fixture.test']);
    run('git', ['config', 'user.name', 'Bind Fixture']);
    run('git', ['remote', 'add', 'origin', remote]);
    run(process.execPath, [BIN, 'project', 'add']);
    return repo;
  };
  const a = make('repoA', 'https://github.com/example/repo-a.git');
  const b = make('repoB', 'https://github.com/example/repo-b.git');
  return { home, env, a, b };
}

const packet = (task) => ({ version: '1.0', id: 'bind-test', objective: { task } });

/**
 * Complete the handshake for one project. A bound dispatch requires this: an
 * independent critic found that without it, any script on an allowlisted origin
 * could run work on the machine.
 */
async function provenSession(port, id, scopes = ['truth:read', 'work:run', 'work:control']) {
  const hostGrant = await hostGrantFor(port);
  return grantFor(port, hostGrant, id, scopes);
}

/**
 * A run must name a contract the ENGINE composed and a human reviewed. These
 * tests predate that requirement, so they were failing on the refusal rather
 * than proving the binding they exist to prove. One-use and expires at use, so
 * every dispatch needs its own.
 */
async function contractFor(port, projectId, runtimeId, task, token) {
  const reviewed = await request(port, '/contract', {
    method: 'POST', token, body: { projectId, runtimeId, task },
  });
  assert.strictEqual(reviewed.status, 200, `contract review failed: ${reviewed.raw}`);
  return reviewed.body.contractId;
}

// One pairing per node, reused across a test's calls the way a real client
// pairs once and then works.
const hostGrants = new Map();
async function hostGrantFor(port) {
  if (!hostGrants.has(port)) {
    hostGrants.set(port, await pair(port, nodesByPort.get(port)));
  }
  return hostGrants.get(port);
}

async function idsFor(port) {
  const projects = await listProjects(port, await hostGrantFor(port));
  const byPath = {};
  for (const p of projects) byPath[p.name] = p.id;
  return { projects, byPath };
}

test('a dispatch bound to a project runs IN that project, not the worker cwd', async () => {
  const port = PORT;
  const { env, a, b } = twoRepos();
  // The worker is started in A. B is the project the caller asked for.
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const target = projects.find((p) => p.remote && p.remote.includes('repo-b'));
  assert.ok(target?.id, 'repo B must be registered and carry a stable id');

  const token = await provenSession(port, target.id);
  const contractId = await contractFor(port, target.id, 'claude-code', 'report your cwd', token);
  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: {
      actionId: 'bind-1', runtimeId: 'claude-code', projectId: target.id,
      contractId, packet: packet('report your cwd'),
    },
  });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.jobId, 'a bound dispatch must be accepted');
  // The response names what it bound to, so a surface can show it rather than
  // assume it.
  assert.strictEqual(res.body.project.id, target.id);

  const terminal = await pollStatus(port, res.body.jobId, token);
  assert.strictEqual(terminal.status, 'done', `run failed: ${terminal.error || ''}`);
  const reported = fs.realpathSync(String(terminal.result).trim());
  assert.strictEqual(reported, b, 'the spawned process must run in repo B');
  assert.notStrictEqual(reported, a, 'it must NOT run where the worker was started');
});

test('the run leaves repo A untouched', async () => {
  const port = PORT + 1;
  const { env, a, b } = twoRepos();
  const before = fs.readdirSync(a).sort();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const target = projects.find((p) => p.remote && p.remote.includes('repo-b'));

  const token = await provenSession(port, target?.id || projects[0].id);
  const contractId = await contractFor(port, target.id, 'claude-code', 'report your cwd', token);
  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: {
      actionId: 'bind-2', runtimeId: 'claude-code', projectId: target.id,
      contractId, packet: packet('report your cwd'),
    },
  });
  const terminal = await pollStatus(port, res.body.jobId, token);
  assert.strictEqual(terminal.status, 'done');
  assert.deepStrictEqual(fs.readdirSync(a).sort(), before, 'repo A must be unchanged');
  assert.strictEqual(fs.realpathSync(String(terminal.result).trim()), b);
});

test('an unknown id is refused before anything is spawned', async () => {
  const port = PORT + 2;
  const { env, a } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  // A perfectly valid grant — for a different project than the one named.
  const token = await provenSession(port, projects[0].id);

  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: { actionId: 'bind-3', runtimeId: 'claude-code', projectId: 'ffffffffffffffff', packet: packet('should never run') },
  });
  // The grant decides first, so an id nobody holds authority for is refused as
  // unauthorized rather than as unknown — the engine must not confirm which
  // ids exist to a caller that cannot act on them.
  assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`);
  assert.ok(!res.body.jobId, 'a refused dispatch must not create a job');
});

test('a display name is not identity — it cannot select a project to run in', async () => {
  const port = PORT + 3;
  const { env, a } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const token = await provenSession(port, projects[0].id);

  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: { actionId: 'bind-4', runtimeId: 'claude-code', projectId: projects[0].name, packet: packet('should never run') },
  });
  assert.ok(res.status === 401 || res.status === 403, `a display name resolved a project (${res.status})`);
  assert.ok(!res.body.jobId);
});

test('a caller-supplied path is never execution identity', async () => {
  const port = PORT + 4;
  const { env, a, b } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const worker = projects.find((p) => p.remote && p.remote.includes('repo-a')) || projects[0];
  const token = await provenSession(port, worker.id);

  // Every shape a caller might hope the engine honours, alongside a legitimate
  // grant and projectId. None may redirect the run: the granted id is the only
  // thing that resolves a directory.
  for (const extra of [{ cwd: b }, { path: b }, { projectPath: b }]) {
    const contractId = await contractFor(port, worker.id, 'claude-code', 'report your cwd', token);
    const res = await request(port, '/dispatch', {
      method: 'POST', token,
      body: {
        actionId: `p-${Object.keys(extra)[0]}`, runtimeId: 'claude-code',
        projectId: worker.id, contractId, packet: packet('report your cwd'), ...extra,
      },
    });
    assert.strictEqual(res.status, 200, `bound dispatch refused: ${res.raw}`);
    const terminal = await pollStatus(port, res.body.jobId, token);
    assert.strictEqual(fs.realpathSync(String(terminal.result).trim()), a,
      `a ${Object.keys(extra)[0]} in the body must never redirect the run`);
  }
});

test('a registration whose repo identity drifted is refused, not silently used', async () => {
  const port = PORT + 5;
  const { env, a, b } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const target = projects.find((p) => p.remote && p.remote.includes('repo-b'));
  // Authority obtained while the registration was still honest.
  const token = await provenSession(port, target.id);

  // B is now a different repository than the one that was registered.
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/example/somewhere-else.git'], {
    cwd: b, env: { ...process.env, ...env }, stdio: 'ignore',
  });

  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: { actionId: 'bind-5', runtimeId: 'claude-code', projectId: target.id, packet: packet('should never run') },
  });
  // A grant is not a licence to act on a repo that has since become something
  // else. Identity is revalidated on USE, not only when the grant was issued.
  assert.strictEqual(res.status, 409);
  assert.ok(!res.body.jobId, 'a stale registration must not produce a job');
  assert.match(res.body.error, /project add/i, 'the refusal must name the one way forward');
});

test('an interactive-only runtime is refused honestly, bound or not', async () => {
  const port = PORT + 6;
  const { env, a } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const target = projects.find((p) => p.remote && p.remote.includes('repo-b'));

  const token = await provenSession(port, target?.id || projects[0].id);
  // The refusal has moved EARLIER, to contract review, which is the better
  // place: nothing is queued, nothing spawns, and no receipt records an attempt
  // that never happened. Bound or not is the point — a legitimate grant for a
  // real project still cannot get a contract for a route that cannot run here.
  const reviewed = await request(port, '/contract', {
    method: 'POST', token,
    body: { projectId: target.id, runtimeId: 'hermes', task: 'x' },
  });
  assert.ok(reviewed.status >= 400, `expected a refusal, got ${reviewed.status}: ${reviewed.raw}`);
  assert.match(String(reviewed.body.error), /cannot take a run/i);
  assert.ok(!reviewed.body.contractId, 'a refusal must not hand back a contract');

  // And the run itself stays refused without one, so skipping review is not a
  // way around the first gate.
  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: { actionId: 'bind-6', runtimeId: 'hermes', projectId: target.id, packet: packet('x') },
  });
  assert.ok(res.status >= 400, 'dispatch without a reviewed contract must be refused');
  assert.ok(!res.body.jobId, 'a refused dispatch must not create a job');
});

test('cancellation and its retry stay bound to the same job and project', async () => {
  const port = PORT + 7;
  const { env, a } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const target = projects.find((p) => p.remote && p.remote.includes('repo-b'));

  const token = await provenSession(port, target?.id || projects[0].id);
  const contractId = await contractFor(port, target.id, 'claude-code', 'report your cwd', token);
  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: {
      actionId: 'bind-7', runtimeId: 'claude-code', projectId: target.id,
      contractId, packet: packet('report your cwd'),
    },
  });
  const terminal = await pollStatus(port, res.body.jobId, token);
  assert.ok(['done', 'cancelled'].includes(terminal.status));

  // A lost response must be retryable without inventing a second outcome.
  const first = await request(port, '/cancel', { method: 'POST', body: { jobId: res.body.jobId } });
  const second = await request(port, '/cancel', { method: 'POST', body: { jobId: res.body.jobId } });
  assert.strictEqual(first.body.status, second.body.status,
    'retrying a cancel must not change the recorded outcome');
});

test('the receipt is filed under the project that ran, not the worker', async () => {
  const port = PORT + 8;
  const { env, home, a } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const target = projects.find((p) => p.remote && p.remote.includes('repo-b'));

  const token = await provenSession(port, target?.id || projects[0].id);
  const contractId = await contractFor(port, target.id, 'claude-code', 'report your cwd', token);
  const res = await request(port, '/dispatch', {
    method: 'POST', token,
    body: {
      actionId: 'bind-8', runtimeId: 'claude-code', projectId: target.id,
      contractId, packet: packet('report your cwd'),
    },
  });
  await pollStatus(port, res.body.jobId, token);

  // Evidence must be findable where the work happened. Filing it under a
  // generic "web" bucket is how a run becomes untraceable to its project.
  const sessionsDir = path.join(home, '.phewsh', 'sessions');
  const files = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  const mine = files.filter((f) => f.startsWith(`${target.name}_`));
  assert.ok(mine.length > 0, `no receipt filed under ${target.name}; found: ${files.join(', ')}`);
  const events = JSON.parse(fs.readFileSync(path.join(sessionsDir, mine[0]), 'utf8'));
  const event = events.find((e) => e.event === 'dispatch_enqueued' && e.jobId === res.body.jobId);
  assert.ok(event, 'the dispatch event must be recorded against the project that ran');
  // `projectId` is the grouping key every receipt reader already uses
  // (receipts-data collectSessions → gatherReceipts filters on it by NAME).
  // Overwriting it with the stable id would make exactly the headline flow
  // unfindable by project.
  assert.strictEqual(event.projectId, target.name, 'the existing grouping key must survive');
  // The stable id rides alongside it, so the run is traceable to one exact repo.
  assert.strictEqual(event.boundProjectId, target.id);

  // The whole run, not just its first moment: a completion filed under a
  // generic bucket is a run whose OUTCOME nobody can trace to a repository.
  const completion = events.find((e) => e.event === 'task_complete');
  assert.ok(completion, 'the completion must be filed under the project that ran');
  assert.strictEqual(completion.boundProjectId, target.id);
});

test('the unbound legacy dispatch is closed — it runs nothing and leaves nothing', async () => {
  // This path used to fall back to the worker's own directory whenever
  // projectId was absent, and required no credential at all. It was the last
  // way to execute on this machine without proving anything, so it is gone
  // rather than merely discouraged: the shipped caller was migrated in the
  // same wave. A test that preserved this bypass was itself a defect.
  const port = PORT + 9;
  const { env, a, home } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);

  // No credential at all.
  const anon = await request(port, '/dispatch', {
    method: 'POST',
    body: { actionId: 'legacy-1', runtimeId: 'claude-code', packet: packet('report your cwd') },
  });
  assert.ok(anon.status === 401 || anon.status === 403,
    `an uncredentialed dispatch must be refused (${anon.status})`);

  // Even fully authorized, omitting projectId must not resolve to the worker's
  // directory — there is no default project.
  const { projects } = await idsFor(port);
  const token = await provenSession(port, projects[0].id);
  const unbound = await request(port, '/dispatch', {
    method: 'POST', token,
    body: { actionId: 'legacy-2', runtimeId: 'claude-code', packet: packet('report your cwd') },
  });
  assert.strictEqual(unbound.status, 400, 'an unbound dispatch must be refused, not defaulted');
  assert.match(String(unbound.body?.error || ''), /projectId/u, 'the refusal must name what is missing');

  // Nothing ran, so there is nothing to file.
  const dir = path.join(home, '.phewsh', 'receipts');
  const receipts = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    // `.integrity.json` is the hash index, not a receipt.
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  assert.strictEqual(receipts.length, 0, 'a refused dispatch must not leave a receipt');
  assert.strictEqual(fs.readdirSync(a).includes('.phewsh-ran'), false, 'nothing may have executed in the worker directory');
});

// A contract binds the repository. Until this test it did not bind the CODE:
// review and dispatch are separate calls, a contract lives for half an hour,
// and a branch can move in between — a commit, a checkout, a detach. The
// approval then reads as if it still applies to work the reviewer never saw.
test('a run approved before the branch moved is refused, not silently re-pointed', async () => {
  const port = PORT + 10;
  const { env, a, b } = twoRepos();
  startServe(port, a, env);
  await waitForNode(port);
  const { projects } = await idsFor(port);
  const target = projects.find((p) => p.remote && p.remote.includes('repo-b'));
  assert.ok(target?.id, 'repo B must be registered and carry a stable id');

  const token = await provenSession(port, target.id);
  const contractId = await contractFor(port, target.id, 'claude-code', 'report your cwd', token);

  // What the reviewer approved is no longer what is checked out.
  fs.writeFileSync(path.join(b, 'landed.txt'), 'work the reviewer never saw');
  execFileSync('git', ['add', 'landed.txt'], { cwd: b, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'landed'], { cwd: b, stdio: 'ignore' });

  const moved = await request(port, '/dispatch', {
    method: 'POST', token,
    body: {
      actionId: 'moved-1', runtimeId: 'claude-code', projectId: target.id,
      contractId, packet: packet('report your cwd'),
    },
  });
  assert.strictEqual(moved.status, 409, `a moved checkout still ran (${moved.status}): ${moved.raw}`);
  assert.match(String(moved.body?.error || ''), /moved|review it again/iu,
    'the refusal must say the project moved, not imply the approval still holds');
  assert.ok(!moved.body?.jobId, 'a refused dispatch must not create a job');

  // And the refusal SPENDS it. Leaving a stale approval in the store would let
  // a caller retry until the tree happened to line up again.
  const replay = await request(port, '/dispatch', {
    method: 'POST', token,
    body: {
      actionId: 'moved-2', runtimeId: 'claude-code', projectId: target.id,
      contractId, packet: packet('report your cwd'),
    },
  });
  assert.strictEqual(replay.status, 409, `a refused contract was replayable (${replay.status})`);
  assert.ok(!replay.body?.jobId, 'a replayed contract must not create a job');
});
