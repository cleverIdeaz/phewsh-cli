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

function startServe(port, cwd) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    cwd: cwd || path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  return { child, output: () => out };
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
