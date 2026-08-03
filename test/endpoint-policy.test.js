// The loopback endpoint authorization policy.
//
// WHY THIS FILE EXISTS
//
// A previous repair made `/local-session` issue a project-bound token and
// required it on the acting endpoints. That closed the "handshake was
// decorative" finding only partway, because the token itself is handed out for
// free: any allowed origin can read a project id from `/health`, POST a nonce
// to `/local-session`, and receive a token automatically. The nonce proves the
// node is live. It proves no human gesture, no trusted Phewsh identity, and no
// authority. Requiring that token on every endpoint would RELOCATE the bypass,
// not close it.
//
// So authorization is two internal capability scopes. They are implementation
// detail behind Project · Next · Work · Record — not a fifth public concept.
//
//   HOST GRANT     Created only after a one-time HUMAN-APPROVED pairing with
//                  this running node. Bound to node instance, requesting
//                  principal, expiry, and narrow host scopes. Permits
//                  registered-project and capability discovery, and authorized
//                  device diagnostics. Permits NO project truth read, NO
//                  execution, NO Record write.
//
//   PROJECT GRANT  Derived from an approved host grant after explicit project
//                  selection. Bound to stable project identity, revalidated
//                  live root/remote, node instance, principal, expiry, and
//                  explicit scopes: truth:read, work:run, work:control,
//                  record:write. Memory only — never URL, cookie,
//                  localStorage, or sessionStorage.
//
// Origin checks remain defense-in-depth. They are never authentication, and a
// MISSING Origin must never mean trusted.
//
// Owner layer: CLI. The engine decides what authority exists; Ion renders it.
//
// This file was written FIRST, failing, as the specification for the repair.
// The engine now satisfies it. Everything here is a boundary that must hold,
// not a description of how the code happens to be arranged today.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { pair, listProjects, grantFor } = require('./helpers/grants');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const PORT = 8500 + Math.floor(Math.random() * 100);

const children = [];
after(() => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } });

/**
 * Start a node and keep its stdout. The human-approval code for pairing is
 * printed to the terminal the human is looking at, so a test reads it the same
 * way a person would — there is deliberately no env var or file that hands a
 * test a grant it did not earn.
 */
function startServe(port, cwd, env = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  children.push(child);
  child.out = '';
  child.stdout.on('data', (d) => { child.out += d.toString(); });
  child.stderr.on('data', () => {});
  return child;
}

function request(port, pathname, opts = {}) {
  const { method = 'GET', body, headers = {}, origin = 'https://phewsh.com' } = opts;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: {
        // `origin: null` means "send no Origin header at all".
        ...(origin === null ? {} : { Origin: origin }),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { /* non-JSON is a valid outcome to assert on */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
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

function fixture(seedName = 'local-fixture') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-pol-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-pol-repo-'));
  fs.mkdirSync(path.join(repo, '.intent'));
  fs.writeFileSync(path.join(repo, '.intent', 'vision.md'), `# Vision\n\n## North Star\n${seedName} truth.\n`);
  fs.writeFileSync(path.join(repo, '.intent', 'decisions.md'), '# Decisions\n\n- 2026-07-29 — Seeded.\n');
  fs.writeFileSync(path.join(repo, '.intent', 'next.json'), JSON.stringify({
    items: [{ id: 'n1', title: 'Do the thing', state: 'now', criteria: [] }],
  }));
  return { home, repo, seedName, env: { PHEWSH_HOME: home, HOME: home } };
}

function register(repo, env, remote = 'https://github.com/example/local-fixture.git') {
  const run = (cmd, args) => execFileSync(cmd, args, {
    cwd: repo, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
  });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'local@fixture.test']);
  run('git', ['config', 'user.name', 'Local Fixture']);
  run('git', ['remote', 'add', 'origin', remote]);
  run(process.execPath, [BIN, 'project', 'add']);
}

const hostHdr = (g) => ({ 'x-phewsh-host-grant': g });
const projHdr = (g) => ({ 'x-phewsh-project-grant': g });

/** Discover a project id using an approved host grant. */
async function discover(port, hostGrant) {
  const projects = await listProjects(port, hostGrant);
  assert.ok(projects.length, 'no registered project was discovered');
  return projects[0];
}

// ---------------------------------------------------------------------------
// 1. /health — unauthenticated minimal liveness and protocol ONLY
// ---------------------------------------------------------------------------

test('/health discloses liveness and protocol only — no projects, remotes, routes, paths, or cloud state', async () => {
  const port = PORT;
  const { repo, env } = fixture();
  register(repo, env);
  startServe(port, repo, env);
  await waitForNode(port);

  const res = await request(port, '/health');
  assert.strictEqual(res.status, 200);

  assert.ok(res.body.status, '/health must still answer liveness');
  assert.strictEqual(res.body.projects, undefined,
    '/health enumerated registered projects to an unpaired caller');
  assert.strictEqual(res.body.runtimes, undefined,
    '/health disclosed which AI runtimes are installed on this machine');
  assert.strictEqual(res.body.project, undefined,
    '/health disclosed the served project to an unpaired caller');

  const blob = JSON.stringify(res.body);
  assert.ok(!blob.includes(repo), '/health leaked an absolute repo path');
  assert.ok(!/@/.test(blob), '/health leaked something email-shaped');
});

// ---------------------------------------------------------------------------
// 2. Pairing is a human gesture — a token cannot be taken, only granted
// ---------------------------------------------------------------------------

test('an allowed origin with no pairing gets nothing beyond liveness', async () => {
  const port = PORT + 1;
  const { repo, env } = fixture();
  register(repo, env);
  startServe(port, repo, env);
  await waitForNode(port);

  // Every protected surface, with a perfectly good allowlisted Origin and no
  // grant of any kind. Being allowed to speak is not being allowed to act.
  //
  // Collected rather than asserted one at a time: a surface that does not exist
  // yet answers 404, and failing on the first one would hide the surfaces that
  // answer 200 today — which are the actual finding.
  const leaked = [];
  for (const [pathname, opts] of [
    ['/cockpit', {}],
    ['/receipts', {}],
    ['/local-truth?projectId=anything', {}],
    ['/dispatch', { method: 'POST', body: { actionId: 'a', runtimeId: 'r', packet: { objective: { task: 't' } } } }],
    ['/claim', { method: 'POST', body: {} }],
    ['/cancel', { method: 'POST', body: { jobId: 'whatever' } }],
    ['/status/whatever', {}],
    ['/closure/preview', { method: 'POST', body: {} }],
    ['/closure/decide', { method: 'POST', body: {} }],
    ['/host/projects', {}],
  ]) {
    const res = await request(port, pathname, opts);
    if (res.status !== 401 && res.status !== 403) leaked.push(`${pathname} → ${res.status}`);
  }
  assert.deepStrictEqual(leaked, [],
    `these surfaces answered an unpaired allowed origin instead of 401/403:\n    ${leaked.join('\n    ')}`);
});

test('a freely attempted handshake issues no authority without human approval', async () => {
  const port = PORT + 2;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  // This must be attempted against a REAL registered project id. An unknown id
  // is refused for being unknown, which would pass this test while proving
  // nothing about whether authority is handed out for free.
  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);

  const res = await request(port, '/local-session', {
    method: 'POST', body: { nonce: 'nonce-free-token-attempt', projectId: project.id },
  });
  assert.notStrictEqual(res.status, 200,
    '/local-session still answered 200 for a real project with no human approval');
  if (res.body) {
    assert.ok(!res.body.sessionToken && !res.body.projectGrant && !res.body.hostGrant,
      '/local-session handed out a credential with no human approval');
  }

  // And whatever it did return must not act.
  const smuggled = res.body?.sessionToken;
  if (smuggled) {
    const used = await request(port, `/local-truth?projectId=${project.id}`, {
      headers: { 'x-phewsh-local-session': smuggled },
    });
    assert.ok(used.status === 401 || used.status === 403,
      `a freely issued session token still read project truth (${used.status})`);
  }
});

test('a pairing completed with the wrong code is refused', async () => {
  const port = PORT + 3;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const asked = await request(port, '/host/pair/request', { method: 'POST', body: { client: 'ion-web' } });
  assert.strictEqual(asked.status, 202, `pairing request refused: ${asked.raw}`);
  const done = await request(port, '/host/pair/complete', {
    method: 'POST', body: { pairingId: asked.body.pairingId, code: 'WR0NGC0DE' },
  });
  assert.ok(done.status === 403 || done.status === 400,
    `a wrong approval code was accepted (${done.status})`);
  assert.ok(!done.body?.hostGrant, 'a wrong code still produced a host grant');
  void child;
});

// ---------------------------------------------------------------------------
// 3. A host grant is discovery only — never truth, execution, or Record
// ---------------------------------------------------------------------------

test('a host grant enumerates projects but cannot read truth, run work, or write the Record', async () => {
  const port = PORT + 4;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  assert.ok(project && project.id, 'host grant could not enumerate registered projects');

  // ...and that is the ceiling.
  const truth = await request(port, `/local-truth?projectId=${project.id}`, { headers: hostHdr(hostGrant) });
  assert.ok(truth.status === 401 || truth.status === 403,
    `a host grant read project truth (${truth.status}) — it must not`);

  const run = await request(port, '/dispatch', {
    method: 'POST', headers: hostHdr(hostGrant),
    body: { projectId: project.id, actionId: 'a', runtimeId: 'r', packet: { objective: { task: 't' } } },
  });
  assert.ok(run.status === 401 || run.status === 403,
    `a host grant dispatched work (${run.status}) — it must not`);

  const decide = await request(port, '/closure/decide', {
    method: 'POST', headers: hostHdr(hostGrant),
    body: { projectId: project.id, proposalId: 'x', decision: 'accept' },
  });
  assert.ok(decide.status === 401 || decide.status === 403,
    `a host grant reached the Record (${decide.status}) — it must not`);
});

// ---------------------------------------------------------------------------
// 4. Project grants are scoped, and each scope is checked
// ---------------------------------------------------------------------------

test('a truth:read grant cannot run work, control jobs, or write the Record', async () => {
  const port = PORT + 5;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const readOnly = await grantFor(port, hostGrant, project.id, ['truth:read']);

  const truth = await request(port, `/local-truth?projectId=${project.id}`, { headers: projHdr(readOnly) });
  assert.strictEqual(truth.status, 200, `truth:read could not read truth: ${truth.raw}`);
  assert.ok(truth.body.vision, 'truth read returned no vision');

  const run = await request(port, '/dispatch', {
    method: 'POST', headers: projHdr(readOnly),
    body: { projectId: project.id, actionId: 'a', runtimeId: 'r', packet: { objective: { task: 't' } } },
  });
  assert.ok(run.status === 401 || run.status === 403,
    `truth:read dispatched work (${run.status})`);

  const decide = await request(port, '/closure/decide', {
    method: 'POST', headers: projHdr(readOnly),
    body: { projectId: project.id, proposalId: 'x', decision: 'accept' },
  });
  assert.ok(decide.status === 401 || decide.status === 403,
    `truth:read reached the Record (${decide.status})`);
});

test('a work:run grant cannot write the Record', async () => {
  const port = PORT + 6;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const runner = await grantFor(port, hostGrant, project.id, ['work:run']);

  const decide = await request(port, '/closure/decide', {
    method: 'POST', headers: projHdr(runner),
    body: { projectId: project.id, proposalId: 'x', decision: 'accept' },
  });
  assert.ok(decide.status === 401 || decide.status === 403,
    `work:run wrote the Record (${decide.status})`);
});

// ---------------------------------------------------------------------------
// 5. Binding: wrong project, wrong origin, expiry, node restart
// ---------------------------------------------------------------------------

test('a grant for one project is no grant at all for another', async () => {
  const port = PORT + 7;
  const a = fixture('project-a');
  const b = fixture('project-b');
  register(a.repo, a.env);
  // Register B into the SAME phewsh home so one node serves both.
  register(b.repo, a.env, 'https://github.com/example/local-fixture-b.git');
  const child = startServe(port, a.repo, a.env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const res = await request(port, '/host/projects', { headers: hostHdr(hostGrant) });
  const projects = res.body.projects || [];
  assert.ok(projects.length >= 2, `expected two registered projects, saw ${projects.length}`);

  const grantA = await grantFor(port, hostGrant, projects[0].id, ['truth:read']);
  const crossed = await request(port, `/local-truth?projectId=${projects[1].id}`, { headers: projHdr(grantA) });
  assert.ok(crossed.status === 401 || crossed.status === 403,
    `a grant for project A read project B (${crossed.status})`);
});

test('a grant issued to one origin is refused when replayed from another', async () => {
  const port = PORT + 8;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child, { origin: 'https://phewsh.com' });
  const project = await discover(port, hostGrant);
  const grant = await grantFor(port, hostGrant, project.id, ['truth:read']);

  const replayed = await request(port, `/local-truth?projectId=${project.id}`, {
    headers: projHdr(grant), origin: 'http://localhost:3000',
  });
  assert.ok(replayed.status === 401 || replayed.status === 403,
    `a grant bound to phewsh.com was accepted from localhost:3000 (${replayed.status})`);
});

test('an expired grant is refused', async () => {
  const port = PORT + 9;
  const { repo, env } = fixture();
  register(repo, env);
  // A deliberately tiny TTL so expiry is observable without a fake clock.
  const child = startServe(port, repo, { ...env, PHEWSH_GRANT_TTL_MS: '1200' });
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const grant = await grantFor(port, hostGrant, project.id, ['truth:read']);

  const fresh = await request(port, `/local-truth?projectId=${project.id}`, { headers: projHdr(grant) });
  assert.strictEqual(fresh.status, 200, `grant did not work while fresh: ${fresh.raw}`);

  await new Promise((r) => setTimeout(r, 1600));

  const stale = await request(port, `/local-truth?projectId=${project.id}`, { headers: projHdr(grant) });
  assert.ok(stale.status === 401 || stale.status === 403,
    `an expired grant still read truth (${stale.status})`);
});

test('every grant dies with the node — a restart re-proves or refuses', async () => {
  const port = PORT + 10;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const grant = await grantFor(port, hostGrant, project.id, ['truth:read']);
  assert.strictEqual(
    (await request(port, `/local-truth?projectId=${project.id}`, { headers: projHdr(grant) })).status, 200);

  child.kill();
  await new Promise((r) => setTimeout(r, 700));
  startServe(port, repo, env);
  await waitForNode(port);

  const after = await request(port, `/local-truth?projectId=${project.id}`, { headers: projHdr(grant) });
  assert.ok(after.status === 401 || after.status === 403,
    `a grant survived a node restart (${after.status}) — grants are bound to the node instance`);

  const hostAfter = await request(port, '/host/projects', { headers: hostHdr(hostGrant) });
  assert.ok(hostAfter.status === 401 || hostAfter.status === 403,
    `a host grant survived a node restart (${hostAfter.status})`);
});

// ---------------------------------------------------------------------------
// 6. Jobs: status and cancel belong to the grant that created them
// ---------------------------------------------------------------------------

test('a job status is readable only by the grant that created that job', async () => {
  const port = PORT + 11;
  const { repo, env } = fixture();
  register(repo, env);
  // A route that really runs, so a job exists to be read. `runtimeId: 'none'`
  // predates contract review and is refused there now — correctly, since it
  // names nothing this machine can run.
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-pol-bin-'));
  fs.writeFileSync(path.join(stub, 'claude'), '#!/bin/sh\necho "stub harness ran"\n');
  fs.chmodSync(path.join(stub, 'claude'), 0o755);
  const child = startServe(port, repo, { ...env, PATH: `${stub}${path.delimiter}${process.env.PATH}` });
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const owner = await grantFor(port, hostGrant, project.id, ['work:run', 'work:control']);

  const reviewed = await request(port, '/contract', {
    method: 'POST', headers: projHdr(owner),
    body: { projectId: project.id, runtimeId: 'claude-code', task: 'noop' },
  });
  assert.strictEqual(reviewed.status, 200, `contract review failed: ${reviewed.raw}`);

  const run = await request(port, '/dispatch', {
    method: 'POST', headers: projHdr(owner),
    body: {
      projectId: project.id, actionId: 'echo', runtimeId: 'claude-code',
      contractId: reviewed.body.contractId, packet: { objective: { task: 'noop' } },
    },
  });
  assert.ok(run.status === 200 || run.status === 202, `dispatch refused for a work:run grant: ${run.raw}`);
  const jobId = run.body.jobId;
  assert.ok(jobId, 'no jobId returned');

  const mine = await request(port, `/status/${jobId}`, { headers: projHdr(owner) });
  assert.strictEqual(mine.status, 200, `the creating grant could not read its own job: ${mine.raw}`);

  // A second, independently derived grant for the SAME project is still a
  // different session and must not see another session's job.
  const other = await grantFor(port, hostGrant, project.id, ['work:run', 'work:control']);
  const peek = await request(port, `/status/${jobId}`, { headers: projHdr(other) });
  assert.ok(peek.status === 401 || peek.status === 403 || peek.status === 404,
    `another session read this job's status (${peek.status})`);

  const cancel = await request(port, '/cancel', { method: 'POST', headers: projHdr(other), body: { jobId } });
  assert.ok(cancel.status === 401 || cancel.status === 403 || cancel.status === 404,
    `another session cancelled this job (${cancel.status})`);

  const anon = await request(port, `/status/${jobId}`);
  assert.ok(anon.status === 401 || anon.status === 403,
    `an ungranted caller read job status (${anon.status})`);
});

test('receipts never cross projects, and never reach an ungranted caller', async () => {
  const port = PORT + 12;
  const a = fixture('project-a');
  const b = fixture('project-b');
  register(a.repo, a.env);
  register(b.repo, a.env, 'https://github.com/example/local-fixture-b.git');
  const child = startServe(port, a.repo, a.env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const res = await request(port, '/host/projects', { headers: hostHdr(hostGrant) });
  const projects = res.body.projects || [];
  const grantA = await grantFor(port, hostGrant, projects[0].id, ['truth:read']);

  const crossed = await request(port, `/receipts/run?projectId=${projects[1].id}`, { headers: projHdr(grantA) });
  assert.ok(crossed.status === 401 || crossed.status === 403,
    `project A's grant listed project B's receipts (${crossed.status})`);

  const anon = await request(port, `/receipts/run?projectId=${projects[0].id}`);
  assert.ok(anon.status === 401 || anon.status === 403,
    `an ungranted caller listed receipts (${anon.status})`);
});

// ---------------------------------------------------------------------------
// 7. Host-scoped device surfaces
// ---------------------------------------------------------------------------

test('/cockpit is host-authorized and carries no email or absolute paths by default', async () => {
  const port = PORT + 13;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const anon = await request(port, '/cockpit');
  assert.ok(anon.status === 401 || anon.status === 403,
    `/cockpit answered an ungranted caller (${anon.status})`);

  const hostGrant = await pair(port, child);
  const view = await request(port, '/cockpit', { headers: hostHdr(hostGrant) });
  assert.strictEqual(view.status, 200, `/cockpit refused an approved host grant: ${view.raw}`);

  const blob = JSON.stringify(view.body);
  assert.ok(!/"email"\s*:\s*"[^"]+"/.test(blob), '/cockpit disclosed an email address by default');
  assert.ok(!blob.includes(repo), '/cockpit disclosed an absolute repo path by default');
  assert.ok(!blob.includes(os.homedir()), '/cockpit disclosed an absolute home path by default');
});

test('the global receipts feed requires host-admin scope, not ambient access', async () => {
  const port = PORT + 14;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const anon = await request(port, '/receipts');
  assert.ok(anon.status === 401 || anon.status === 403,
    `the global receipts feed answered an ungranted caller (${anon.status})`);

  // A plain discovery host grant is not an admin grant.
  const hostGrant = await pair(port, child);
  const asHost = await request(port, '/receipts', { headers: hostHdr(hostGrant) });
  assert.ok(asHost.status === 401 || asHost.status === 403,
    `a discovery-only host grant read every project's receipts (${asHost.status})`);
});

// ---------------------------------------------------------------------------
// 8. Origin is defense-in-depth, never authentication
// ---------------------------------------------------------------------------

test('a missing Origin is never treated as trusted', async () => {
  const port = PORT + 15;
  const { repo, env } = fixture();
  register(repo, env);
  startServe(port, repo, env);
  await waitForNode(port);

  const trusted = [];
  for (const [pathname, opts] of [
    ['/cockpit', {}],
    ['/receipts', {}],
    ['/local-truth?projectId=anything', {}],
    ['/dispatch', { method: 'POST', body: { actionId: 'a', runtimeId: 'r', packet: { objective: { task: 't' } } } }],
    ['/host/projects', {}],
  ]) {
    const res = await request(port, pathname, { ...opts, origin: null });
    if (res.status !== 401 && res.status !== 403) trusted.push(`${pathname} → ${res.status}`);
  }
  assert.deepStrictEqual(trusted, [],
    `these surfaces trusted a request with no Origin header at all:\n    ${trusted.join('\n    ')}`);
});

test('localhost development origins are opt-in, not permanently trusted', async () => {
  const port = PORT + 16;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  // Whatever app happens to occupy port 3000 must not inherit trust by default,
  // neither to start a pairing nor to reach any protected surface.
  const asked = await request(port, '/host/pair/request', {
    method: 'POST', body: { client: 'ion-web' }, origin: 'http://localhost:3000',
  });
  assert.strictEqual(asked.status, 403,
    'http://localhost:3000 could start a pairing by default — dev origins must be opt-in');

  for (const pathname of ['/host/projects', '/cockpit', '/receipts']) {
    const res = await request(port, pathname, { origin: 'http://localhost:3000' });
    assert.ok(res.status === 401 || res.status === 403,
      `${pathname} answered http://localhost:3000 by default (${res.status})`);
  }

  // Opt-in remains possible for real local development.
  const optedIn = startServe(port + 40, repo, { ...env, PHEWSH_ALLOWED_ORIGINS: 'http://localhost:3000' });
  await waitForNode(port + 40);
  const allowed = await request(port + 40, '/host/pair/request', {
    method: 'POST', body: { client: 'ion-web' }, origin: 'http://localhost:3000',
  });
  assert.strictEqual(allowed.status, 202,
    'an explicitly opted-in dev origin was still refused');
  void child; void optedIn;
});

test('the CORS preflight advertises the grant headers a real browser will send', async () => {
  const port = PORT + 17;
  const { repo, env } = fixture();
  register(repo, env);
  startServe(port, repo, env);
  await waitForNode(port);

  const res = await request(port, '/local-truth', { method: 'OPTIONS' });
  assert.strictEqual(res.status, 204, `preflight did not answer 204 (${res.status})`);
  const allowed = String(res.headers['access-control-allow-headers'] || '').toLowerCase();
  assert.ok(allowed.includes('x-phewsh-host-grant'),
    'preflight omits x-phewsh-host-grant — every browser call would fail while node-to-node tests stay green');
  assert.ok(allowed.includes('x-phewsh-project-grant'),
    'preflight omits x-phewsh-project-grant — every browser call would fail while node-to-node tests stay green');
});

// ---------------------------------------------------------------------------
// 9. Legacy /intent migration — the bypass is closed, not preserved
// ---------------------------------------------------------------------------

test('an unbound dispatch with no projectId is refused — no cwd fallback survives', async () => {
  const port = PORT + 18;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  // This is exactly the shipped /intent page's legacy call shape.
  const legacy = await request(port, '/dispatch', {
    method: 'POST',
    body: { actionId: 'a', runtimeId: 'r', packet: { objective: { task: 'legacy unbound run' } } },
  });
  assert.ok(legacy.status === 401 || legacy.status === 403 || legacy.status === 400,
    `the legacy unbound dispatch still executed (${legacy.status}) — the bypass must be closed, not preserved`);

  // Even holding a full-authority grant, omitting projectId must not silently
  // resolve to the worker's own directory.
  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const granted = await grantFor(port, hostGrant, project.id, ['work:run']);
  const unbound = await request(port, '/dispatch', {
    method: 'POST', headers: projHdr(granted),
    body: { actionId: 'a', runtimeId: 'r', packet: { objective: { task: 'still unbound' } } },
  });
  assert.ok(unbound.status === 400 || unbound.status === 401 || unbound.status === 403,
    `dispatch without an explicit projectId fell back to cwd (${unbound.status})`);
});

test('/claim requires an execution-scoped project grant', async () => {
  const port = PORT + 19;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const anon = await request(port, '/claim', {
    method: 'POST',
    body: {
      projectId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
    },
  });
  assert.ok(anon.status === 401 || anon.status === 403,
    `/claim accepted an ungranted caller (${anon.status})`);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const readOnly = await grantFor(port, hostGrant, project.id, ['truth:read']);
  const underScoped = await request(port, '/claim', {
    method: 'POST', headers: projHdr(readOnly),
    body: {
      projectId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
    },
  });
  assert.ok(underScoped.status === 401 || underScoped.status === 403,
    `/claim accepted a truth:read grant (${underScoped.status})`);
});

// ---------------------------------------------------------------------------
// 10. The authority contract is the ENGINE's statement, not the caller's
// ---------------------------------------------------------------------------

test('the engine composes the contract; a caller-supplied one is refused outright', async () => {
  const port = PORT + 20;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const token = await grantFor(port, hostGrant, project.id, ['work:run']);

  // Silently dropping a caller's contract would let a surface believe its
  // claims were recorded. Accepting it would let a surface write its own
  // claims into evidence. Both are wrong, so it is refused.
  const smuggled = await request(port, '/dispatch', {
    method: 'POST', headers: projHdr(token),
    body: {
      projectId: project.id, actionId: 'a', runtimeId: 'claude-code',
      packet: { objective: { task: 't' } },
      contract: { action: 't', verificationCeiling: 'Fully verified.', cost: 'Free.' },
    },
  });
  assert.strictEqual(smuggled.status, 400, `a caller-supplied contract was not refused (${smuggled.status})`);
  assert.match(String(smuggled.body?.error || ''), /contractId|cannot be supplied/u);
});

test('a reviewed contract is bound to its project and its route', async () => {
  const port = PORT + 21;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const token = await grantFor(port, hostGrant, project.id, ['work:run']);

  const reviewed = await request(port, '/contract', {
    method: 'POST', headers: projHdr(token),
    body: { projectId: project.id, runtimeId: 'claude-code', task: 'do the thing' },
  });
  // A machine without Claude Code installed correctly refuses the route; that
  // is the same rule the dispatcher applies, so either outcome is honest.
  if (reviewed.status === 409) {
    assert.match(String(reviewed.body?.error || ''), /cannot take a run/u);
    return;
  }
  assert.strictEqual(reviewed.status, 200, `contract review failed: ${reviewed.raw}`);
  assert.ok(reviewed.body.contractId, 'no contractId returned');

  // The engine's own words, not anything a caller sent.
  const c = reviewed.body.contract;
  assert.strictEqual(c.action, 'do the thing');
  // The exact sentence an independent critic forced. Wording is pinned in
  // cli/test/action-contract.test.js; what matters here is that it survives
  // the wire unchanged.
  assert.match(c.authority, /does not confine it/iu, 'the authority sentence must not soften');
  assert.match(c.authority, /network/iu);
  assert.doesNotMatch(c.authority, /only this (project|repository)/iu);
  assert.match(c.verificationCeiling, /not verified/iu);
  assert.match(c.cost, /never a price/iu);
  assert.strictEqual(c.boundProjectId, project.id);

  // Reviewed for one route; spending it on another is refused.
  const wrongRoute = await request(port, '/dispatch', {
    method: 'POST', headers: projHdr(token),
    body: {
      projectId: project.id, actionId: 'a', runtimeId: 'codex',
      contractId: reviewed.body.contractId,
      packet: { objective: { task: 'do the thing' } },
    },
  });
  assert.strictEqual(wrongRoute.status, 409, `a contract crossed routes (${wrongRoute.status})`);

  // An id this node never issued is refused rather than invented.
  const forged = await request(port, '/dispatch', {
    method: 'POST', headers: projHdr(token),
    body: {
      projectId: project.id, actionId: 'a', runtimeId: 'claude-code',
      contractId: 'ffffffffffffffffffffffff',
      packet: { objective: { task: 'do the thing' } },
    },
  });
  assert.strictEqual(forged.status, 409, `a forged contractId was accepted (${forged.status})`);
});

test('reviewing a contract needs work:run for that exact project', async () => {
  const port = PORT + 22;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const project = await discover(port, hostGrant);
  const readOnly = await grantFor(port, hostGrant, project.id, ['truth:read']);

  const anon = await request(port, '/contract', {
    method: 'POST',
    body: { projectId: project.id, runtimeId: 'claude-code', task: 't' },
  });
  assert.ok(anon.status === 401 || anon.status === 403, `/contract answered an ungranted caller (${anon.status})`);

  const underScoped = await request(port, '/contract', {
    method: 'POST', headers: projHdr(readOnly),
    body: { projectId: project.id, runtimeId: 'claude-code', task: 't' },
  });
  assert.ok(underScoped.status === 401 || underScoped.status === 403,
    `/contract accepted a truth:read grant (${underScoped.status})`);
});
