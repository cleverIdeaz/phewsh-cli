// Grounding a project is Level 2, and Ion could not do it.
//
// A person opens Ion, picks the repo they are working in, and Phewsh says:
// "Run `phewsh intent --init` in that repository, then read it again."
// That is a copied terminal instruction standing in the middle of the product's
// second promise — ground my project — and it is the most common first-run dead
// end there is. The engine simply had no endpoint for it.
//
// `phewsh intent --init` already answers two plain questions ("what are you
// building", "what does success look like") and, off a TTY, scaffolds without
// asking anything. The grounding itself is `lib/pps.js:createPPS` +
// `writeGuardedViews`, both of which take an explicit directory. So this is
// implement-once-expose-everywhere: the same two answers, the same writer, one
// bounded endpoint — never a second implementation of what project truth is.
//
// The rules it must not break: the project is resolved by the engine from its
// own registry, truth is never overwritten, and a hand-authored file survives.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { request, pair, listProjects, grantFor, projHdr } = require('./helpers/grants');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
// 8700–8764. See the band map in `test/helpers/grants.js`. The suites used to
// overlap each other, which is where both the "already running on port N" and
// the "never displayed an approval code" failures came from. Take a NEW band,
// never a gap between two existing ones.
const PORT = 8700 + Math.floor(Math.random() * 60);

function makeRepo(label, seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `phewsh-ground-${label}-`));
  const repo = path.join(root, 'team-app');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q']);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['remote', 'add', 'origin', 'https://github.com/example/team-app.git']);
  for (const [file, body] of Object.entries(seed)) {
    fs.mkdirSync(path.join(repo, '.intent'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.intent', file), body);
  }
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

async function boot(port, label, { seed = {}, scopes = ['record:write'] } = {}) {
  const fixture = makeRepo(label, seed);
  const child = startServe(port, {
    PHEWSH_PROJECT_INDEX: fixture.indexFile, HOME: fixture.root, PHEWSH_HOME: fixture.root,
  });
  await waitForListen(child);
  const hostGrant = await pair(port, child);
  const [project] = await listProjects(port, hostGrant);
  const token = await grantFor(port, hostGrant, project.id, scopes);
  return { ...fixture, child, project, token };
}

const ground = (port, body, token) => request(port, '/ground', {
  method: 'POST', body, headers: token ? projHdr(token) : {},
});

test('grounding needs a record-writing grant — an ungranted caller learns nothing', async () => {
  const port = PORT;
  const node = await boot(port, 'ungranted', { scopes: ['truth:read'] });
  try {
    const anon = await ground(port, { projectId: node.project.id, what: 'x', goal: 'y' });
    assert.ok(anon.status === 401 || anon.status === 403, `ungranted grounding accepted (${anon.status})`);

    // A read-only grant is not a writing grant. Writing project truth is the
    // one thing `truth:read` must never buy.
    const readOnly = await ground(port, { projectId: node.project.id, what: 'x', goal: 'y' }, node.token);
    assert.ok(readOnly.status === 401 || readOnly.status === 403,
      `a truth:read grant grounded a project (${readOnly.status})`);
    assert.strictEqual(fs.existsSync(path.join(node.repo, '.intent', 'vision.md')), false,
      'project truth was written without a writing grant');
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('grounding writes .intent/ into the resolved project, never the worker directory', async () => {
  const port = PORT + 1;
  const node = await boot(port, 'writes');
  const workerCwd = path.join(__dirname, '..');
  try {
    const res = await ground(port, {
      projectId: node.project.id,
      what: 'A tool that keeps a project coherent across AI tools.',
      goal: 'A stranger can resume the project without re-explaining it.',
    }, node.token);
    assert.strictEqual(res.status, 200, `grounding refused: ${res.raw}`);

    const intentDir = path.join(node.repo, '.intent');
    assert.ok(fs.existsSync(path.join(intentDir, 'pps.json')), 'no pps.json written');
    assert.ok(fs.existsSync(path.join(intentDir, 'vision.md')), 'no vision.md written');

    // The person's own words survive into the truth — this is the whole point.
    const vision = fs.readFileSync(path.join(intentDir, 'vision.md'), 'utf8');
    assert.match(vision, /coherent across AI tools/);

    // And nothing landed where the worker happens to be standing.
    assert.notStrictEqual(path.resolve(workerCwd), path.resolve(node.repo));
    assert.strictEqual(fs.existsSync(path.join(workerCwd, '.intent', 'pps.json')), false,
      'the worker directory was grounded instead of the project');

    // The response names what it did, in the project it did it in.
    assert.strictEqual(res.body.project.id, node.project.id);
    assert.strictEqual(res.body.project.name, 'team-app');
    assert.ok(Array.isArray(res.body.written) && res.body.written.length > 0);
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('a project that already has truth is never re-grounded', async () => {
  const port = PORT + 2;
  const node = await boot(port, 'existing', {
    seed: { 'vision.md': '# Hand written\n\nThe real north star.\n', 'plan.md': '# Plan\n' },
  });
  try {
    const res = await ground(port, { projectId: node.project.id, what: 'overwrite me', goal: 'please' }, node.token);
    assert.strictEqual(res.status, 409, `an already-grounded project was re-grounded: ${res.raw}`);
    assert.match(res.body.error, /already/i);

    const vision = fs.readFileSync(path.join(node.repo, '.intent', 'vision.md'), 'utf8');
    assert.match(vision, /The real north star/, 'existing project truth was overwritten');
    assert.doesNotMatch(vision, /overwrite me/);
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('a hand-authored file inside a partial .intent/ is preserved, not replaced', async () => {
  const port = PORT + 3;
  // vision.md alone is a PARTIAL ground — it slips past "already grounded"
  // because plan.md is missing, so the writer's own truth guard has to hold.
  const node = await boot(port, 'partial', {
    seed: { 'vision.md': '# Mine\n\nWritten by a person, not a scaffold.\n' },
  });
  try {
    const res = await ground(port, { projectId: node.project.id, what: 'something', goal: 'else' }, node.token);
    assert.strictEqual(res.status, 200, `partial grounding refused: ${res.raw}`);

    const vision = fs.readFileSync(path.join(node.repo, '.intent', 'vision.md'), 'utf8');
    assert.match(vision, /Written by a person/, 'a hand-authored file was overwritten');
    assert.ok(Array.isArray(res.body.preserved) && res.body.preserved.includes('vision.md'),
      'the response must say what it left alone');
  } finally {
    node.child.kill('SIGKILL');
  }
});

test('grounding an unknown project fails closed instead of guessing one', async () => {
  const port = PORT + 4;
  const node = await boot(port, 'unknown');
  try {
    const res = await ground(port, { projectId: 'deadbeefdeadbeef', what: 'x', goal: 'y' }, node.token);
    assert.ok(res.status === 403 || res.status === 404, `an unknown project id was accepted (${res.status})`);
    assert.strictEqual(fs.existsSync(path.join(node.repo, '.intent', 'pps.json')), false,
      'a mistyped id grounded some other project');
  } finally {
    node.child.kill('SIGKILL');
  }
});
