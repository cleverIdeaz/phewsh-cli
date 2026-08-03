// Shared test helpers for talking to a node that requires capability grants.
//
// Every node-level test now has to do what a real client does: pair with the
// node by reading the approval code a human would read off their terminal,
// discover projects with the resulting host grant, then derive a project grant
// carrying only the scopes that test actually needs.
//
// There is deliberately no shortcut — no env var, no file, no test-only route
// that hands out a grant. A helper that could skip the human gesture would be a
// backdoor in the product, and the tests would stop proving the thing they
// exist to prove.

// ── Port bands: keep these disjoint ──────────────────────────────────────────
//
// Node-level suites run in parallel, and two nodes on one port is NOT a loud
// failure. `waitForNode` succeeds against whichever one is listening, and the
// pairing code is then printed on the OTHER child's stdout — so it surfaces as
// "the node never displayed an approval code for the human to read", which
// reads exactly like a timing flake and was misfiled as one for weeks.
//
// Each suite owns a band wide enough for its random offset plus its highest
// `PORT + N`. If you add a suite, take a NEW band; do not squeeze into a gap.
//
//   7400–7527  claim-execution-binding      7840–7906  closure-endpoints
//   7560–7630  local-session                7940–7990  dispatch-binding
//   7660–7720  mcp-http-binding             8100–8316  serve-bridge
//   7760–7800  cancellation-truthfulness    8500–8622  endpoint-policy
//   8700–8764  ground-project               8800–8893  critic-findings
//
const assert = require('node:assert');
const http = require('node:http');

/** Strip colour escapes: a person reads the characters, not the escapes. */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/gu, '');

function request(port, pathname, opts = {}) {
  const { method = 'GET', body, headers = {}, origin = 'https://phewsh.com' } = opts;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: {
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

/**
 * Complete a real pairing. `child` must be a spawned node whose stdout is being
 * accumulated onto `child.out` — the approval code is read from there, exactly
 * where the human would find it.
 */
// Remember which node is on which port, so grantFor can read an elevated
// approval code off the right terminal without every call site threading it.
const nodesByPort = new Map();

async function pair(port, child, { client = 'test-client', origin = 'https://phewsh.com' } = {}) {
  nodesByPort.set(port, child);
  const before = (child.out || '').length;
  const asked = await request(port, '/host/pair/request', { method: 'POST', body: { client }, origin });
  assert.strictEqual(asked.status, 202, `pairing request refused: ${asked.raw}`);

  const deadline = Date.now() + 8000;
  let code = null;
  while (Date.now() < deadline && !code) {
    const m = plain((child.out || '').slice(before)).match(/approval code\s+([A-Z0-9]{6,8})/u);
    if (m) code = m[1];
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(code, 'the node never displayed an approval code for the human to read');

  const done = await request(port, '/host/pair/complete', {
    method: 'POST', body: { pairingId: asked.body.pairingId, code }, origin,
  });
  assert.strictEqual(done.status, 200, `pairing completion refused: ${done.raw}`);
  return done.body.hostGrant;
}

const hostHdr = (g) => ({ 'x-phewsh-host-grant': g });
const projHdr = (g) => ({ 'x-phewsh-project-grant': g });

/** Registered projects, via an approved host grant. */
async function listProjects(port, hostGrant, origin = 'https://phewsh.com') {
  const res = await request(port, '/host/projects', { headers: hostHdr(hostGrant), origin });
  assert.strictEqual(res.status, 200, `discovery refused: ${res.raw}`);
  return res.body.projects || [];
}

/**
 * Derive a project grant with explicit scopes.
 *
 * Reading is issued directly. Anything that ACTS — work:run, work:control,
 * record:write — needs its own approval at the node, naming the project and
 * the powers, so this completes that the way a person does: by reading the
 * code off the terminal. There is deliberately no shortcut.
 */
async function grantFor(port, hostGrant, projectId, scopes, origin = 'https://phewsh.com') {
  const child = nodesByPort.get(port);
  const before = (child?.out || '').length;

  const res = await request(port, '/project/grant', {
    method: 'POST', headers: hostHdr(hostGrant), body: { projectId, scopes }, origin,
  });
  if (res.status === 200) return res.body.projectGrant;
  assert.strictEqual(res.status, 202, `project grant refused: ${res.raw}`);
  assert.ok(!res.body.code, 'the approval code must never travel over HTTP');
  assert.ok(child, `port ${port} has no node registered — call pair() first`);

  const deadline = Date.now() + 8000;
  let code = null;
  while (Date.now() < deadline && !code) {
    const m = plain(child.out.slice(before)).match(/approval code\s+([A-Z0-9]{6,8})/u);
    if (m) code = m[1];
    else await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(code, 'the node never displayed an approval code for the elevated grant');

  const approved = await request(port, '/project/grant/approve', {
    method: 'POST', body: { approvalId: res.body.approvalId, code }, origin,
  });
  assert.strictEqual(approved.status, 200, `elevated approval refused: ${approved.raw}`);
  return approved.body.projectGrant;
}

/**
 * The whole dance in one call, for tests whose subject is something else
 * entirely (binding, receipts, closure) and which just need to be allowed in.
 */
async function authorize(port, child, { scopes = ['truth:read'], origin = 'https://phewsh.com', index = 0 } = {}) {
  const hostGrant = await pair(port, child, { origin });
  const projects = await listProjects(port, hostGrant, origin);
  assert.ok(projects.length > index, `expected at least ${index + 1} registered project(s), saw ${projects.length}`);
  const project = projects[index];
  const projectGrant = await grantFor(port, hostGrant, project.id, scopes, origin);
  return { hostGrant, projectGrant, project, projects };
}

module.exports = { request, waitForNode, pair, listProjects, grantFor, authorize, hostHdr, projHdr, plain };
