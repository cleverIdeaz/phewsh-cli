// serve bridge — project identity on /health + honest EADDRINUSE exit.
//
// These are the two smallest truths from the Jul 8 multi-project finding
// (handoffs/ION_MULTIPROJECT_ARCHITECTURE_2026-07-08.md §10): the web must be
// able to say WHICH project a worker serves, and a second worker on a taken
// port must explain itself instead of dumping a Node stack trace.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { pair, listProjects, grantFor, hostHdr, projHdr } = require('./helpers/grants');
const http = require('node:http');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const PORT = 7900 + Math.floor(Math.random() * 500);

function startServe(port, cwd, env = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd: cwd || path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
  let out = '';
  child.out = '';
  child.stdout.on('data', (d) => { out += d.toString(); child.out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return { child, output: () => out };
}

function postJson(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: {
        Origin: 'https://phewsh.com',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { 'x-phewsh-project-grant': token } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function waitForListen(handle, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (/Running on/.test(handle.output())) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('serve never reported listening:\n' + handle.output()));
      setTimeout(poll, 100);
    })();
  });
}

function getJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    // Same-origin-less request: send an allowed Origin so cors gate passes
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, headers: { Origin: 'https://phewsh.com', ...headers } },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
  });
}

/**
 * A registered repo in an isolated PHEWSH home. Tests that need to ACT now need
 * a project to hold a grant for, and must never touch the real registry.
 */
function registeredFixture(prefix) {
  const os = require('node:os');
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repo = path.join(root, 'team-app');
  const indexFile = path.join(root, 'index.json');
  fs.mkdirSync(path.join(repo, '.intent'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.intent', 'vision.md'), '# Vision\n\nBridge fixture.\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/team-app.git'], { cwd: repo });
  fs.writeFileSync(indexFile, JSON.stringify({ projects: {
    [repo]: { name: 'team-app', path: repo, remote: 'github.com/example/team-app', serve: true },
  } }));
  return { root, repo, env: { PHEWSH_PROJECT_INDEX: indexFile, HOME: root, PHEWSH_HOME: root } };
}

/** Pair, discover, and derive a grant carrying everything a bridge test needs. */
async function authorized(port, handle, scopes = ['truth:read', 'work:run', 'work:control']) {
  const hostGrant = await pair(port, handle.child);
  const projects = await listProjects(port, hostGrant);
  const project = projects[0];
  const token = project ? await grantFor(port, hostGrant, project.id, scopes) : null;
  return { hostGrant, project, token };
}

test('capability discovery is honest, and reaches only a paired caller', async () => {
  const handle = startServe(PORT);
  try {
    await waitForListen(handle);

    // /health is now liveness and protocol only. It deliberately no longer
    // names the served project or enumerates this machine's AI runtimes: that
    // was free reconnaissance for anyone who could reach the port.
    const health = await getJson(PORT, '/health');
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(health.project, undefined, '/health must not name the served project');
    assert.strictEqual(health.runtimes, undefined, '/health must not enumerate installed runtimes');
    assert.strictEqual(health.phewsh, true, 'a client still needs to recognise the protocol');

    const hostGrant = await pair(PORT, handle.child);
    const discovered = await getJson(PORT, '/host/projects', hostHdr(hostGrant));

    // The node is the only place a surface can learn what this machine can
    // route work through. Discovery used to report {id,label,connected} — too
    // thin to describe a route honestly, so the web app kept its own invented
    // list. These assertions share this worker deliberately: spawning a second
    // one destabilizes the parallel suite.
    const codex = discovered.runtimes.find((r) => r.id === 'codex');
    assert.ok(codex, '/health must report every harness the engine knows');
    assert.strictEqual(codex.role, 'reasons & reviews');
    assert.strictEqual(codex.auth, 'ChatGPT plan');
    assert.strictEqual(codex.headless, true);
    assert.strictEqual(codex.briefing, true);
    assert.strictEqual(typeof codex.installed, 'boolean');

    // For a HARNESS, presence is installation, so `connected` mirrors it.
    const harnesses = discovered.runtimes.filter((r) => !['human', 'generic'].includes(r.id));
    assert.strictEqual(harnesses.length, 15);
    for (const r of harnesses) {
      assert.strictEqual(r.connected, r.installed, `${r.id}: alias must track installed`);
    }

    // human/generic have no binary, so they must not claim one. Asserting the
    // key is ABSENT (not false) is the point: a surface distinguishes
    // "not on PATH" from "PATH is not the question for this route".
    const human = discovered.runtimes.find((r) => r.id === 'human');
    const generic = discovered.runtimes.find((r) => r.id === 'generic');
    assert.ok(!('installed' in human), 'human must not claim a binary on PATH');
    assert.ok(!('installed' in generic), 'generic must not claim a binary on PATH');
    assert.strictEqual(human.connected, true, 'the human route is always available');
    assert.strictEqual(discovered.runtimes.length, 17);

    // A surface must never learn how to invoke a harness from the wire.
    // `bin` is a string, so this is a real assertion — unlike `args`, which
    // JSON.stringify drops for free and would pass even if serve spread the
    // whole harness record.
    assert.strictEqual(codex.bin, undefined);
    assert.strictEqual(codex.modelHints, undefined);
  } finally {
    handle.child.kill('SIGKILL');
  }
});

// hermes/pi have `args: null` — phewsh only knows how to launch them
// interactively. Dispatching one used to reach `spawn(bin, runner.args(...))`,
// call null as a function, and take the ENTIRE node down with an unhandled
// rejection, losing every other in-flight job. The guard belongs here, in the
// engine that owns execution — not in a UI filter.
test('dispatching an interactive-only harness fails that job and leaves the node alive', async () => {
  const port = PORT + 3;
  const fx = registeredFixture('phewsh-bridge-interactive-');
  const handle = startServe(port, fx.repo, fx.env);
  try {
    await waitForListen(handle);
    const { project, token } = await authorized(port, handle);
    const res = await postJson(port, '/dispatch', {
      actionId: 'a1',
      runtimeId: 'hermes',
      projectId: project.id,
      packet: { objective: { task: 'probe' } },
    }, token);
    assert.ok(res.body.jobId, `dispatch should be accepted, got: ${JSON.stringify(res.body)}`);

    // The job must reach a truthful terminal error, not vanish.
    let job = null;
    for (let i = 0; i < 40; i++) {
      job = await getJson(port, `/status/${res.body.jobId}`, projHdr(token));
      if (['done', 'error', 'cancelled'].includes(job.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(job.status, 'error');
    assert.match(job.error, /interactive-only/i);

    // The whole point: the node survived and still serves other requests.
    const health = await getJson(port, '/health');
    assert.strictEqual(health.status, 'ok');
  } finally {
    handle.child.kill('SIGKILL');
  }
});

test('discovery exposes ONLY deliberately registered projects from the serve registry', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-serve-reg-'));
  const indexFile = path.join(root, 'index.json');
  // One registered (serve:true) + one merely session-recorded — only the first may appear
  const repo = path.join(root, 'team-app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/team-app.git'], { cwd: repo });
  fs.writeFileSync(indexFile, JSON.stringify({
    projects: {
      [repo]: { name: 'team-app', path: repo, remote: 'github.com/example/team-app', serve: true },
      '/tmp/just-visited': { name: 'just-visited', path: repo, lastOpened: new Date().toISOString() },
    },
  }));

  const port = PORT + 2;
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', PHEWSH_PROJECT_INDEX: indexFile },
  });
  let out = '';
  child.out = '';
  child.stdout.on('data', (d) => { out += d.toString(); child.out += d.toString(); });
  const handle = { child, output: () => out };
  try {
    await waitForListen(handle);
    // Enumeration is behind a pairing now; /health says nothing about projects.
    const bare = await getJson(port, '/health');
    assert.strictEqual(bare.projects, undefined, '/health must not enumerate projects');
    const hostGrant = await pair(port, child);
    const discovered = await getJson(port, '/host/projects', hostHdr(hostGrant));
    assert.ok(Array.isArray(discovered.projects), 'discovery must carry a projects array');
    // `id` is the stable handle callers use to name ONE exact project without
    // matching on a display name; the absolute path stays private.
    assert.strictEqual(discovered.projects.length, 1, 'only the registered project may be exposed');
    const [only] = discovered.projects;
    assert.strictEqual(only.name, 'team-app');
    assert.strictEqual(only.remote, 'github.com/example/team-app');
    assert.match(only.id, /^[0-9a-f]{16}$/u, 'stable project id missing or malformed');
    assert.deepStrictEqual(
      Object.keys(only).sort(), ['id', 'name', 'remote'],
      'discovery must expose exactly id/name/remote — never the path',
    );
    // The banner teaches the registry too
    assert.match(out, /team-app/);
  } finally {
    child.kill('SIGKILL');
  }
});

test('/claim refuses a cloud task without a deliberately registered local binding', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-claim-none-'));
  const indexFile = path.join(root, 'index.json');
  fs.writeFileSync(indexFile, JSON.stringify({ projects: {} }));
  const handle = startServe(PORT + 13, undefined, { PHEWSH_PROJECT_INDEX: indexFile, HOME: root, PHEWSH_HOME: root });
  try {
    await waitForListen(handle);
    // With nothing registered there is no project to hold a grant for, so the
    // refusal now happens one step earlier: no authority, no claim.
    const response = await postJson(PORT + 13, '/claim', {
      projectId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      runtimeId: null,
    });
    assert.ok(response.status === 401 || response.status === 403,
      `an ungranted claim must be refused (${response.status})`);
  } finally {
    handle.child.kill('SIGKILL');
  }
});

test('/claim accepts only the repo linked by cloud id and live origin', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-claim-bound-'));
  const repo = path.join(root, 'team-app');
  const indexFile = path.join(root, 'index.json');
  const projectId = '11111111-1111-4111-8111-111111111111';
  fs.mkdirSync(path.join(repo, '.intent'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.intent', 'pps.json'), JSON.stringify({ adapters: { phewsh: { cloud_id: projectId } } }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/team-app.git'], { cwd: repo });
  fs.writeFileSync(indexFile, JSON.stringify({ projects: {
    [repo]: { name: 'team-app', path: repo, remote: 'github.com/example/team-app', serve: true },
  } }));

  const handle = startServe(PORT + 14, undefined, { PHEWSH_PROJECT_INDEX: indexFile, HOME: root, PHEWSH_HOME: root });
  try {
    await waitForListen(handle);
    const hostGrant = await pair(PORT + 14, handle.child);
    const discovered = await getJson(PORT + 14, '/host/projects', hostHdr(hostGrant));
    assert.strictEqual(discovered.projects[0].cloudProjectId, projectId);
    const token = await grantFor(PORT + 14, hostGrant, discovered.projects[0].id, ['work:run']);
    const response = await postJson(PORT + 14, '/claim', {
      projectId,
      taskId: '22222222-2222-4222-8222-222222222222',
      runtimeId: null,
    }, token);
    assert.strictEqual(response.status, 202);
    assert.strictEqual(response.body.status, 'accepted');
    assert.match(response.body.claimId, /^[0-9a-f-]{36}$/i);
    // No human approved the CLAIM — the human approved the pairing and the
    // elevated scopes. Saying otherwise misled the operator reading this.
    assert.match(handle.output(), /Ion claim 22222222 in team-app/);
    assert.doesNotMatch(handle.output(), /Human-approved Ion claim/);
  } finally {
    handle.child.kill('SIGKILL');
  }
});

async function pollStatus(port, jobId, token, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const status = await getJson(port, `/status/${jobId}`, projHdr(token));
    if (['done', 'error', 'cancelled'].includes(status.status)) return status;
    if (Date.now() - t0 > timeoutMs) throw new Error('job never reached a terminal state: ' + JSON.stringify(status));
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('/cancel of an unknown job is a safe, idempotent no-op (lost-response retry)', async () => {
  const port = PORT + 15;
  const fx = registeredFixture('phewsh-bridge-cancel-unknown-');
  const handle = startServe(port, fx.repo, fx.env);
  try {
    await waitForListen(handle);
    const { token } = await authorized(port, handle);

    // Idempotence is for the GRANT HOLDER. An ungranted caller must not learn
    // which job ids exist by reading "unknown" versus anything else.
    const anon = await postJson(port, '/cancel', { jobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    assert.ok(anon.status === 401 || anon.status === 403,
      `an ungranted cancel must be refused (${anon.status})`);

    const first = await postJson(port, '/cancel', { jobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, token);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body.status, 'unknown');
    // Retrying the same cancel must stay safe.
    const second = await postJson(port, '/cancel', { jobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, token);
    assert.strictEqual(second.body.status, 'unknown');
  } finally {
    handle.child.kill('SIGKILL');
  }
});

test('/cancel never relabels a job that already reached a terminal state', async () => {
  const port = PORT + 16;
  const fx = registeredFixture('phewsh-bridge-cancel-terminal-');
  const handle = startServe(port, fx.repo, fx.env);
  try {
    await waitForListen(handle);
    const { project, token } = await authorized(port, handle);
    // Dispatch to an uninstalled harness so the job fails fast — no real agent runs.
    const dispatch = await postJson(port, '/dispatch', {
      actionId: 'cancel-test',
      runtimeId: 'aider',
      projectId: project.id,
      packet: { version: '1.0', id: 'cancel-test', objective: { task: 'noop' } },
    }, token);
    assert.ok(dispatch.body.jobId, 'dispatch must return a jobId');
    const terminal = await pollStatus(port, dispatch.body.jobId, token);
    assert.strictEqual(terminal.status, 'error', 'uninstalled harness must terminate as error');
    // Cancelling a finished job must return its existing terminal status, not "cancelled".
    const cancel = await postJson(port, '/cancel', { jobId: dispatch.body.jobId }, token);
    assert.strictEqual(cancel.body.status, 'error');
  } finally {
    handle.child.kill('SIGKILL');
  }
});

test('second worker on a taken port exits 1 with an honest message, no stack trace', async () => {
  const first = startServe(PORT + 1);
  try {
    await waitForListen(first);
    const second = startServe(PORT + 1);
    const code = await new Promise((resolve) => second.child.on('close', resolve));
    assert.strictEqual(code, 1, 'second worker must exit 1, not crash');
    const out = second.output();
    assert.match(out, /already running on port/i);
    assert.match(out, /--port/);
    assert.ok(!/EADDRINUSE/.test(out), 'raw EADDRINUSE stack must not reach the user');
  } finally {
    first.child.kill('SIGKILL');
  }
});
