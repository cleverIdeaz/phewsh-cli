// The MCP HTTP bridge must not accept executable work with no project named.
//
// WHY THIS FILE EXISTS
//
// `phewsh serve` refuses a dispatch that does not name a project, resolves the
// id against the machine's own registry, re-verifies live origin, binds a
// reviewed contract, and pins the branch and commit it was approved against.
// `cli/mcp/http-server.js` is a SECOND HTTP server, on the SAME default port
// (7483), whose `/dispatch` asked for none of that: no project id, no token —
// `isAllowedRequest` is an Origin check only — no contract, no baseline. It
// filed the result under the literal string "web", so the work could not be
// traced back to a repository afterwards either.
//
// It does not spawn: `mcp/lib/dispatch-queue.js` has no child_process import,
// so a packet accepted here runs wherever the polling harness already happens
// to be. That is the entire problem. "The laptop is running Phewsh" and "the
// laptop will only do bound work" have to be the same sentence, and until this
// endpoint names a project they are not.
//
// The rule enforced here is the SAME rule the serve path uses — see
// lib/project-identity.js, which both surfaces resolve through.
//
// Owner layer: CLI.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SERVER = path.join(__dirname, '..', 'mcp', 'http-server.js');
const PORT = 7660 + Math.floor(Math.random() * 60);

const children = [];
after(() => { for (const c of children) { try { c.kill(); } catch { /* already gone */ } } });

/**
 * An isolated machine: its own ~/.phewsh registry, and a cwd that DOES carry a
 * `.intent/` directory. That second part is deliberate — a cwd-derived project
 * with the id "local" is exactly what an unresolvable request used to be
 * answered by, so it must be present for the refusals to prove anything.
 */
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-mcphome-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-mcpcwd-'));
  fs.mkdirSync(path.join(cwd, '.intent'));
  fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\n\nThe server\'s own directory.\n');

  fs.mkdirSync(path.join(home, '.phewsh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.phewsh', 'projects.json'), JSON.stringify([
    { id: 'team-app', name: 'Team App' },
    { id: 'billing', name: 'Billing' },
    // A duplicated id is representable: loadProjects() spreads this file after
    // pushing the cwd-derived project, and nothing dedupes it.
    { id: 'twin', name: 'Twin A' },
    { id: 'twin', name: 'Twin B' },
  ]));
  return { home, cwd };
}

function startServer(port, { home, cwd }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', HOME: home, PHEWSH_MCP_PORT: String(port) },
  });
  children.push(child);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

function request(port, pathname, opts = {}) {
  const { method = 'GET', body } = opts;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
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

async function waitFor(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, '/health');
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`MCP HTTP bridge did not start on ${port}`);
}

const packet = (task, id = 'mcp-http-test') => ({ version: '1.0', id, objective: { task } });

const dispatch = (port, body) => request(port, '/dispatch', { method: 'POST', body });

// One node for the whole file: every case is a request, and the registry does
// not change between them. The home is returned so a test can read the evidence
// the server actually wrote, rather than trusting its own HTTP response.
let ready;
function node() {
  if (!ready) {
    const fx = fixture();
    ready = (async () => {
      startServer(PORT, fx);
      await waitFor(PORT);
      return { port: PORT, home: fx.home };
    })();
  }
  return ready;
}

test('a dispatch that names no project is refused, not defaulted', async () => {
  const { port: p } = await node();
  const res = await dispatch(p, { actionId: 'a', runtimeId: 'claude-code', packet: packet('do the thing') });
  assert.strictEqual(res.status, 400, `an unbound dispatch was accepted (${res.status}): ${res.raw}`);
  assert.match(String(res.body?.error || ''), /project_id|project id/iu,
    'the refusal must name what is missing');
  assert.ok(!res.body?.jobId, 'a refused dispatch must not create a job');
});

test('an unknown project id is refused rather than answered by the server cwd', async () => {
  // The original defect in one request: this server was STARTED in a directory
  // carrying .intent/, so there is a project here with the id "local". An
  // unresolvable request must not reach it.
  const { port: p } = await node();
  const res = await dispatch(p, {
    actionId: 'a', runtimeId: 'claude-code', projectId: 'no-such-project', packet: packet('t'),
  });
  assert.strictEqual(res.status, 404, `an unknown project id was accepted (${res.status}): ${res.raw}`);
  assert.ok(!res.body?.jobId, 'a refused dispatch must not create a job');
});

test('a near-miss id is refused — one keystroke is not a binding', async () => {
  const { port: p } = await node();
  const res = await dispatch(p, {
    actionId: 'a', runtimeId: 'claude-code', projectId: 'team-ap', packet: packet('t'),
  });
  assert.strictEqual(res.status, 404, `a mistyped project id was accepted (${res.status})`);
  assert.ok(!res.body?.jobId);
});

test('a duplicated project id is refused rather than resolved to whichever came first', async () => {
  const { port: p } = await node();
  const res = await dispatch(p, {
    actionId: 'a', runtimeId: 'claude-code', projectId: 'twin', packet: packet('t'),
  });
  assert.strictEqual(res.status, 409, `an ambiguous project id was accepted (${res.status}): ${res.raw}`);
  assert.ok(!res.body?.jobId);
});

test('an exact project id is accepted and the job records THAT project', async () => {
  const { port: p } = await node();
  const res = await dispatch(p, {
    actionId: 'bound-1', runtimeId: 'claude-code', projectId: 'team-app', packet: packet('report'),
  });
  assert.strictEqual(res.status, 200, `a correctly bound dispatch was refused: ${res.raw}`);
  assert.ok(res.body?.jobId, 'a bound dispatch must create a job');
  // Named in the response, so a caller shows what it bound to rather than what
  // it asked for.
  assert.strictEqual(res.body.projectId, 'team-app');

  // And carried on the job itself: a queued packet nobody can trace back to a
  // repository is not evidence of anything.
  const status = await request(p, `/status/${res.body.jobId}`);
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.body?.projectId, 'team-app',
    'the queued job must carry the resolved project, not the requested string');
});

test('the local project is still reachable — only the substitution is gone', async () => {
  // loadProjects() mints this from the server's own cwd. A caller that means it
  // still gets it; what changed is that nothing ELSE resolves to it.
  const { port: p } = await node();
  const res = await dispatch(p, {
    actionId: 'bound-2', runtimeId: 'claude-code', projectId: 'local', packet: packet('report'),
  });
  assert.strictEqual(res.status, 200, `an explicit "local" was refused: ${res.raw}`);
  assert.strictEqual(res.body.projectId, 'local');
});

// ---------------------------------------------------------------------------
// Requested → resolved → queued → recorded. One identity, all the way through.
// ---------------------------------------------------------------------------

test('a completion cannot re-file the run under a different project', async () => {
  // The binding is only worth as much as the LAST consumer of it. This handler
  // used to take the project from the completion body, so a run bound to A
  // could be recorded against B by whoever reported it finished.
  const { port: p } = await node();
  const started = await dispatch(p, {
    actionId: 'bound-3', runtimeId: 'claude-code', projectId: 'team-app', packet: packet('report', 'divergence-1'),
  });
  assert.strictEqual(started.status, 200, started.raw);

  const wrong = await request(p, `/jobs/${started.body.jobId}/complete`, {
    method: 'POST',
    body: { success: true, result: 'done', agentId: 'claude-code', projectId: 'billing' },
  });
  assert.strictEqual(wrong.status, 409,
    `a completion re-filed the run under another project (${wrong.status}): ${wrong.raw}`);
  assert.match(String(wrong.body?.error || ''), /project/iu);
});

test('the recorded evidence names the project the job was BOUND to', async () => {
  const { port: p, home } = await node();
  const started = await dispatch(p, {
    actionId: 'bound-4', runtimeId: 'claude-code', projectId: 'billing', packet: packet('report', 'divergence-2'),
  });
  assert.strictEqual(started.status, 200, started.raw);

  const done = await request(p, `/jobs/${started.body.jobId}/complete`, {
    method: 'POST',
    body: { success: true, result: 'finished', agentId: 'claude-code' },
  });
  assert.strictEqual(done.status, 200, done.raw);

  // Read what the server actually WROTE, not what it told us it wrote.
  const dir = path.join(home, '.phewsh', 'results');
  const records = fs.readdirSync(dir)
    .filter((f) => f.startsWith('divergence-2_'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')));
  assert.strictEqual(records.length, 1, `expected exactly one result record, got ${records.length}`);
  assert.strictEqual(records[0].projectId, 'billing',
    'evidence must name the bound project — never "web", never the caller\'s claim');
});

test('a completion that names the bound project agrees, and is accepted', async () => {
  const { port: p } = await node();
  const started = await dispatch(p, {
    actionId: 'bound-5', runtimeId: 'claude-code', projectId: 'team-app', packet: packet('report', 'divergence-3'),
  });
  assert.strictEqual(started.status, 200, started.raw);

  const done = await request(p, `/jobs/${started.body.jobId}/complete`, {
    method: 'POST',
    body: { success: true, result: 'finished', agentId: 'claude-code', projectId: 'team-app' },
  });
  assert.strictEqual(done.status, 200, `an agreeing completion was refused: ${done.raw}`);
});

// ---------------------------------------------------------------------------
// No implicit compatibility fallback survives, and the legacy status is stated
// ---------------------------------------------------------------------------

test('the bridge declares itself legacy in code and in the interop map', async () => {
  // CG's requirement, kept as a test rather than a convention: a compatibility
  // path that does not say it is one gets treated as the supported path.
  const source = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'http-server.js'), 'utf-8');
  assert.match(source, /LEGACY \/ COMPATIBILITY INFRASTRUCTURE/u,
    'the transport must say what it is at the top of the file');
  // Matched loosely across the comment's line wrapping — what matters is that
  // the file says Origin is a browser boundary and not authentication.
  assert.match(source, /Origin check/u, 'the file must name what isAllowedRequest is');
  assert.match(source, /browser boundary/u);
  assert.match(source, /never[\s*]+authentication/su,
    'Origin validation must never read as authentication');

  const map = fs.readFileSync(path.join(__dirname, '..', 'MCP-INTEROP-MAP.md'), 'utf-8');
  assert.match(map, /LEGACY \/\s*\n?>?\s*COMPATIBILITY/u,
    'the interop map must carry the same status');
});

test('no implicit "web" project fallback remains anywhere in the transport', async () => {
  // The exact string that used to stand in for a project. Its absence is the
  // difference between evidence and a note that something happened somewhere.
  const source = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'http-server.js'), 'utf-8');
  assert.doesNotMatch(source, /projectId\s*\|\|\s*"web"/u,
    'a project identity must never fall back to the literal "web"');
  assert.doesNotMatch(source, /recordResult\(\{\s*\n\s*projectId:\s*projectId\b/u,
    'evidence must be filed under the bound project, not the reporter\'s claim');
});
