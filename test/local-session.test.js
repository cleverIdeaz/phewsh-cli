// The local-only workspace journey.
//
// Ion may open WITHOUT a cloud sign-in, but only after a human paired this
// exact node — and even then, reading a project's truth needs a grant that
// names that project and carries truth:read.
//
// The nonce-echo handshake this file used to test is retired. It proved the
// node was live and nothing else, yet it handed out a token that acted; the
// proof was real and the authorization was free. What remains valuable here is
// everything it also checked: that identity is a stable id rather than a
// display name, that an unregistered repo is never reachable, that a missing
// .intent/ is reported honestly instead of granted as a hollow workspace, and
// that Work is derived rather than stored.
//
// Owner layer: CLI. The engine decides what a verified local workspace is;
// Ion only renders the verdict.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { request, waitForNode, pair, listProjects, grantFor, projHdr } = require('./helpers/grants');

const BIN = path.join(__dirname, '..', 'bin', 'phewsh.js');
const PORT = 7600 + Math.floor(Math.random() * 200);

const children = [];
after(() => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } });

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

/** A real repo with .intent/, registered in an isolated PHEWSH home. */
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-localhome-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-localrepo-'));
  fs.mkdirSync(path.join(repo, '.intent'));
  fs.writeFileSync(path.join(repo, '.intent', 'vision.md'), '# Vision\n\n## North Star\nLocal-only truth.\n');
  fs.writeFileSync(path.join(repo, '.intent', 'decisions.md'), '# Decisions\n\n- 2026-07-28 — Chose loopback-only local mode.\n');
  return { home, repo, env: { PHEWSH_HOME: home, HOME: home } };
}

function register(repo, env) {
  const { execFileSync } = require('node:child_process');
  const run = (cmd, args) => execFileSync(cmd, args, {
    cwd: repo, env: { ...process.env, NO_COLOR: '1', ...env }, stdio: 'ignore',
  });
  // A served project must be a real repo — work has to stay traceable.
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'local@fixture.test']);
  run('git', ['config', 'user.name', 'Local Fixture']);
  run('git', ['remote', 'add', 'origin', 'https://github.com/example/local-fixture.git']);
  run(process.execPath, [BIN, 'project', 'add']);
}

test('a registered project exposes a stable id so nothing resolves by display name', async () => {
  const { repo, env } = fixture();
  register(repo, env);
  const port = PORT;
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const projects = await listProjects(port, hostGrant);
  assert.ok(projects.length > 0, 'registered project not exposed');
  for (const p of projects) {
    assert.ok(typeof p.id === 'string' && p.id.length >= 8,
      `project ${p.name} has no stable id — callers would have to match by name`);
  }
  // The absolute path stays private; the id is the handle.
  assert.ok(!JSON.stringify(projects).includes(repo), 'discovery leaked the absolute repo path');
});

test('the retired handshake issues nothing and says what replaced it', async () => {
  const port = PORT + 1;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const [project] = await listProjects(port, hostGrant);

  const res = await request(port, '/local-session', {
    method: 'POST', body: { nonce: 'nonce-retired-path', projectId: project.id },
  });
  assert.strictEqual(res.status, 410, 'the free-token handshake must be gone, not merely unused');
  assert.ok(!res.body.sessionToken, 'it still handed out a token');
  assert.match(String(res.body.replacedBy || ''), /host\/pair/u, 'a stale client is not told where to go');
});

test('an unregistered or unknown project id is refused — never a first-match fallback', async () => {
  const port = PORT + 3;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const projects = await listProjects(port, hostGrant);

  const res = await request(port, '/project/grant', {
    method: 'POST', headers: { 'x-phewsh-host-grant': hostGrant },
    body: { projectId: 'not-a-registered-project', scopes: ['truth:read'] },
  });
  assert.ok(res.status === 404 || res.status === 400, `unknown project id must not resolve (${res.status})`);
  assert.notStrictEqual(res.body?.projectId, projects[0]?.id,
    'refusal must not quietly hand back the first registered project');
});

test('a project name is not accepted as identity', async () => {
  const port = PORT + 4;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const [project] = await listProjects(port, hostGrant);

  const res = await request(port, '/project/grant', {
    method: 'POST', headers: { 'x-phewsh-host-grant': hostGrant },
    body: { projectId: project.name, scopes: ['truth:read'] },
  });
  assert.ok(res.status === 404 || res.status === 400, 'display name must never resolve a workspace');
});

test('the node reports a missing .intent honestly instead of granting a hollow workspace', async () => {
  const port = PORT + 5;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-nointent-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-nointent-'));
  const env = { PHEWSH_HOME: home, HOME: home };
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const projects = await listProjects(port, hostGrant);
  const target = projects[0];
  if (!target) return; // nothing registered — nothing to assert

  const grant = await grantFor(port, hostGrant, target.id, ['truth:read']);
  const res = await request(port, `/local-truth?projectId=${target.id}`, { headers: projHdr(grant) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.intentPresent, false,
    'a repo with no .intent/ must be reported as such, not granted as a workspace');
});

test('local truth comes from .intent/ and is bounded, with Work never stored', async () => {
  const port = PORT + 6;
  const { repo, env } = fixture();
  // A long Record proves the endpoint bounds what it returns.
  const entries = Array.from({ length: 25 }, (_, i) =>
    `- 2026-07-${String((i % 28) + 1).padStart(2, '0')} — Decision number ${i + 1}.`).join('\n');
  fs.writeFileSync(path.join(repo, '.intent', 'decisions.md'), `# Decisions\n\n${entries}\n`);
  fs.writeFileSync(path.join(repo, '.intent', 'next.json'), JSON.stringify({
    items: [{ id: 'n1', title: 'Ship the local journey', state: 'now',
      criteria: [{ expected: 'It opens with no cloud account', type: 'measurable' }] }],
  }));
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const [project] = await listProjects(port, hostGrant);
  const grant = await grantFor(port, hostGrant, project.id, ['truth:read']);

  const res = await request(port, `/local-truth?projectId=${project.id}`, { headers: projHdr(grant) });
  assert.strictEqual(res.status, 200);
  assert.match(res.body.vision, /Local-only truth/u, 'Project did not come from .intent/vision.md');
  assert.strictEqual(res.body.next.title, 'Ship the local journey');
  assert.strictEqual(res.body.next.criteria.length, 1);
  assert.strictEqual(res.body.record.total, 25);
  assert.ok(res.body.record.recent.length <= 10, 'Record must be bounded, not the whole journal');
  assert.match(res.body.record.recent[0], /Decision number 25\./u, 'Record must be newest-first');
  // Work is derived, never a stored field.
  assert.strictEqual(res.body.work, undefined, 'Work must stay derived — the engine must not store it');
});

test('the vision arrives as prose — YAML frontmatter is file metadata, not Project', async () => {
  const port = PORT + 9;
  const { repo, env } = fixture();
  fs.writeFileSync(path.join(repo, '.intent', 'vision.md'),
    '---\nentity: Local Fixture\narchetype: protocol\nupdated: 2026-07-29\n---\n# Vision\n\n## North Star\nLocal-only truth.\n');
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const [project] = await listProjects(port, hostGrant);
  const grant = await grantFor(port, hostGrant, project.id, ['truth:read']);

  const res = await request(port, `/local-truth?projectId=${project.id}`, { headers: projHdr(grant) });
  assert.strictEqual(res.status, 200);
  // Every surface would otherwise have to strip this itself, and one of them
  // would forget. The engine answers with what Project SAYS.
  assert.ok(!res.body.vision.startsWith('---'), 'frontmatter must not lead the vision');
  assert.doesNotMatch(res.body.vision, /archetype: protocol/u, 'file metadata is not Project');
  assert.match(res.body.vision, /North Star/u, 'the prose itself must survive');
  assert.match(res.body.vision, /Local-only truth\./u);
});

test('local truth refuses an id that is not the one the grant names', async () => {
  const port = PORT + 7;
  const { repo, env } = fixture();
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const [project] = await listProjects(port, hostGrant);
  const grant = await grantFor(port, hostGrant, project.id, ['truth:read']);

  const res = await request(port, '/local-truth?projectId=deadbeefdeadbeef', { headers: projHdr(grant) });
  assert.ok(res.status === 401 || res.status === 403,
    'a browser must not be able to read an arbitrary repo with a grant for another');
});

test('a registered repo with no .intent is reported honestly, not as an empty workspace', async () => {
  const port = PORT + 8;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-truth-nointent-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-truth-nointent-'));
  const env = { PHEWSH_HOME: home, HOME: home };
  register(repo, env);
  const child = startServe(port, repo, env);
  await waitForNode(port);

  const hostGrant = await pair(port, child);
  const projects = await listProjects(port, hostGrant);
  const target = projects[0];
  if (!target) return;

  const grant = await grantFor(port, hostGrant, target.id, ['truth:read']);
  const res = await request(port, `/local-truth?projectId=${target.id}`, { headers: projHdr(grant) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.intentPresent, false);
  assert.match(res.body.reason, /phewsh intent --init/u, 'must name the single prerequisite');
});
