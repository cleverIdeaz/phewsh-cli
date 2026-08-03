// `process.cwd()` is where a process was started. It is not a project identity,
// and it is never an authority.
//
// Three places still treated it as one after the claim binding landed, and the
// binding audit named all three: the job execution fallback in serve, the stdio
// `phewsh_complete_task` write into `.intent/status.md`, and — now fixed
// elsewhere in this slice — the direct CLI claim's repo root.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const load = () => import('../mcp/lib/handlers.js');

/**
 * The stdio surface has no registry, no repository path and no remote, so the
 * only `.intent/` it can write is the one in its own working directory. That
 * makes the caller's string the whole gate — which is why it must be a RESOLVED
 * project and not a raw name the caller chose.
 */
test('a raw caller string cannot write project truth', async () => {
  const { updateLocalStatusMd } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-cwd-raw-'));
  const intentDir = path.join(dir, '.intent');
  fs.mkdirSync(intentDir);
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    // The literal id a caller used to be able to send. It names nothing that
    // was resolved, so it writes nothing.
    updateLocalStatusMd('local', true, 'did a thing', 'agent-1');
    updateLocalStatusMd({ id: 'local' }, true, 'did a thing', 'agent-1');
    assert.equal(fs.existsSync(path.join(intentDir, 'status.md')), false,
      'an unresolved project wrote into .intent/');
  } finally {
    process.chdir(cwd);
  }
});

test('the resolved cwd-derived project is the only one that writes, and only into its own .intent/', async () => {
  const { updateLocalStatusMd, loadProjects } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-cwd-ok-'));
  const intentDir = path.join(dir, '.intent');
  fs.mkdirSync(intentDir);
  fs.writeFileSync(path.join(intentDir, 'vision.md'), '# Fixture Project\n\nA fixture.\n');
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const resolved = loadProjects().find((p) => p.id === 'local');
    assert.ok(resolved, 'a cwd with .intent/ must mint a local project');

    updateLocalStatusMd(resolved, true, 'did a thing', 'agent-1');
    const written = fs.readFileSync(path.join(intentDir, 'status.md'), 'utf8');
    assert.match(written, /did a thing/);

    // A cloud-cached project carries no path and is not this directory.
    updateLocalStatusMd({ id: 'team-app', name: 'Team App' }, true, 'from elsewhere', 'agent-2');
    assert.doesNotMatch(fs.readFileSync(path.join(intentDir, 'status.md'), 'utf8'), /from elsewhere/);
  } finally {
    process.chdir(cwd);
  }
});

/**
 * The serve job runner used to end with `job.project?.path || process.cwd()`.
 * One `createJob` caller made it unreachable, which is exactly why it survived
 * review: unreachable today is one refactor away from reachable tomorrow, and
 * the failure mode is a harness running in the worker's own directory.
 */
test('no serve execution path falls back to the worker directory', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'commands', 'serve.js'), 'utf8');
  // Narrow on purpose: `job.project?.path || null` elsewhere is a legitimate
  // absence check. The hazard is specifically falling back to a DIRECTORY.
  assert.doesNotMatch(source, /job\.project\?\.path\s*\|\|\s*process\.cwd\(\)/,
    'the unbound job fallback is back — an unbound job must refuse, not run somewhere');
  assert.doesNotMatch(source, /executeViaHarness\([^)]*process\.cwd\(\)/s,
    'a harness must never be launched into the worker’s own directory');

  // And the binding itself: every job is created with a resolved project.
  const callers = source.match(/createJob\(/g) || [];
  assert.equal(callers.length, 2, 'createJob gained or lost a call site — re-check that each one binds a project');
});

test('the direct CLI claim takes its repo root from the registry, not the current folder', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'commands', 'task.js'), 'utf8');
  assert.doesNotMatch(source, /rev-parse',\s*'--show-toplevel'\],\s*process\.cwd\(\)/,
    'the claim repo root is cwd-derived again');
  assert.match(source, /resolveClaimWorkspace\(/,
    'the claim path must resolve its workspace through the shared rule');
});
