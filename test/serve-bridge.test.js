// serve bridge — project identity on /health + honest EADDRINUSE exit.
//
// These are the two smallest truths from the Jul 8 multi-project finding
// (handoffs/ION_MULTIPROJECT_ARCHITECTURE_2026-07-08.md §10): the web must be
// able to say WHICH project a worker serves, and a second worker on a taken
// port must explain itself instead of dumping a Node stack trace.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
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
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return { child, output: () => out };
}

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: {
        Origin: 'https://phewsh.com',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
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

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    // Same-origin-less request: send an allowed Origin so cors gate passes
    const req = http.get(
      { host: '127.0.0.1', port, path: pathname, headers: { Origin: 'https://phewsh.com' } },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
  });
}

test('/health reports which project this worker serves (name + origin remote)', async () => {
  const handle = startServe(PORT);
  try {
    await waitForListen(handle);
    const health = await getJson(PORT, '/health');
    assert.strictEqual(health.status, 'ok');
    assert.ok(health.project, '/health must carry a project field');
    // Started in cli/ inside the monorepo → name is the directory basename
    assert.strictEqual(health.project.name, 'cli');
    // The monorepo has an origin remote; identity travels with the worker
    assert.ok(
      health.project.remote && /phewsh/.test(health.project.remote),
      `expected an origin remote mentioning phewsh, got: ${health.project.remote}`
    );
  } finally {
    handle.child.kill('SIGKILL');
  }
});

test('/health exposes ONLY deliberately registered projects from the serve registry', async () => {
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
  child.stdout.on('data', (d) => { out += d.toString(); });
  const handle = { child, output: () => out };
  try {
    await waitForListen(handle);
    const health = await getJson(port, '/health');
    assert.ok(Array.isArray(health.projects), '/health must carry a projects array');
    assert.deepStrictEqual(health.projects, [{ name: 'team-app', remote: 'github.com/example/team-app' }]);
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
  const handle = startServe(PORT + 3, undefined, { PHEWSH_PROJECT_INDEX: indexFile, HOME: root });
  try {
    await waitForListen(handle);
    const response = await postJson(PORT + 3, '/claim', {
      projectId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      runtimeId: null,
    });
    assert.strictEqual(response.status, 404);
    assert.match(response.body.error, /not linked to a project registered on this machine/i);
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

  const handle = startServe(PORT + 4, undefined, { PHEWSH_PROJECT_INDEX: indexFile, HOME: root });
  try {
    await waitForListen(handle);
    const health = await getJson(PORT + 4, '/health');
    assert.strictEqual(health.projects[0].cloudProjectId, projectId);
    const response = await postJson(PORT + 4, '/claim', {
      projectId,
      taskId: '22222222-2222-4222-8222-222222222222',
      runtimeId: null,
    });
    assert.strictEqual(response.status, 202);
    assert.strictEqual(response.body.status, 'accepted');
    assert.match(response.body.claimId, /^[0-9a-f-]{36}$/i);
    assert.match(handle.output(), /Human-approved Ion claim 22222222 in team-app/);
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
