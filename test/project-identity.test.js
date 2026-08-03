// ONE answer to "which project is this?"
//
// The rule — exact id or explicit failure, never `.find()` through ambiguity —
// was written twice: `lib/local-claim.js:resolveRunTarget` for the serve path
// and `mcp/lib/resolve-project.js:resolveExactProject` for the MCP surface.
// Both were correct on the day they were written. That is not the point. Two
// implementations of one boundary drift, and when they drift the PERMISSIVE one
// is the one an attacker or an accident finds.
//
// So the rule moves into a single pure decision — no I/O, no throwing, the same
// shape `lib/project-binding.js:resolveProjectBinding` already uses in this
// repo — and both callers delegate to it. Each keeps its own wording, its own
// status codes, and its own extra gates: serve still re-verifies live origin
// through assertLiveIdentity, which the MCP surface has no path to do. What
// neither can do any more is answer the identity question differently.
//
// The last test here is the one that matters: same registry, same question,
// both surfaces, same verdict.
//
// Owner layer: CLI.

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchProjectId } = require('../lib/project-identity');
const { resolveRunTarget, LocalClaimError } = require('../lib/local-claim');

// mcp/ is ESM ("type": "module"); this suite is CommonJS.
const loadMcp = () => import('../mcp/lib/resolve-project.js');

const REAL = { id: 'team-app', name: 'Team App' };
const OTHER = { id: 'billing', name: 'Billing' };

test('an exact id selects that project, and only that project', () => {
  const verdict = matchProjectId([REAL, OTHER], 'team-app');
  assert.equal(verdict.outcome, 'exact');
  assert.equal(verdict.match, REAL);
  // Surrounding whitespace is transport noise, not identity.
  assert.equal(matchProjectId([REAL, OTHER], '  team-app  ').match, REAL);
});

test('no id at all is a refusal, never a default', () => {
  for (const nothing of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(matchProjectId([REAL, OTHER], nothing).outcome, 'missing',
      `${JSON.stringify(nothing)} was treated as an identity`);
  }
});

test('an unknown id refuses and says what it does know', () => {
  const verdict = matchProjectId([REAL, OTHER], 'no-such-project');
  assert.equal(verdict.outcome, 'unknown');
  assert.equal(verdict.wanted, 'no-such-project');
  // Naming the known ids is what turns a refusal into something a caller can
  // act on. It discloses nothing the caller could not already list.
  assert.deepEqual(verdict.known, ['team-app', 'billing']);
});

test('a near-miss is a refusal — one keystroke is not a match', () => {
  assert.equal(matchProjectId([REAL, OTHER], 'team-ap').outcome, 'unknown');
  assert.equal(matchProjectId([REAL, OTHER], 'team-apps').outcome, 'unknown');
});

test('case is not identity', () => {
  assert.equal(matchProjectId([REAL, OTHER], 'Team-App').outcome, 'unknown');
  assert.equal(matchProjectId([REAL, OTHER], 'TEAM-APP').outcome, 'unknown');
});

test('a duplicated id is ambiguous — it never picks one', () => {
  const twin = { id: 'team-app', name: 'Team App (stale registry entry)' };
  const verdict = matchProjectId([REAL, twin, OTHER], 'team-app');
  assert.equal(verdict.outcome, 'ambiguous');
  assert.equal(verdict.count, 2);
  assert.equal(verdict.match, undefined, 'an ambiguous verdict must not carry a pick');
});

test('a registry that is not a list cannot produce a match', () => {
  // Fail closed on a shape nobody expected, rather than throwing somewhere
  // further down where the refusal would read as an internal error.
  for (const broken of [null, undefined, 'team-app', { id: 'team-app' }]) {
    assert.equal(matchProjectId(broken, 'team-app').outcome, 'unknown');
  }
});

test('malformed entries are skipped rather than crashing the decision', () => {
  const verdict = matchProjectId([null, undefined, 'nope', REAL], 'team-app');
  assert.equal(verdict.outcome, 'exact');
  assert.equal(verdict.match, REAL);
});

// ---------------------------------------------------------------------------
// The unification itself
// ---------------------------------------------------------------------------

test('serve and MCP return the SAME verdict for the same registry', async () => {
  const { resolveExactProject, McpProjectError } = await loadMcp();

  // One registry, shaped so the serve path can also resolve it: `path` and
  // `remote` are what assertLiveIdentity needs, and are ignored by MCP.
  const registered = [
    { id: 'team-app', name: 'Team App', path: '/tmp/team-app', remote: 'github.com/example/team-app' },
    { id: 'billing', name: 'Billing', path: '/tmp/billing', remote: 'github.com/example/billing' },
  ];
  const liveOrigin = (dir) => registered.find((p) => p.path === dir)?.remote ?? null;

  const serve = (wanted) => {
    try { return { ok: true, id: resolveRunTarget(wanted, registered, liveOrigin).id }; }
    catch (error) {
      assert.ok(error instanceof LocalClaimError, `serve threw something unexpected: ${error}`);
      return { ok: false };
    }
  };
  const mcp = (wanted) => {
    try { return { ok: true, id: resolveExactProject(registered, wanted).id }; }
    catch (error) {
      assert.ok(error instanceof McpProjectError, `mcp threw something unexpected: ${error}`);
      return { ok: false };
    }
  };

  for (const wanted of ['team-app', 'billing', 'no-such-project', 'team-ap', 'Team-App', '', '   ', null]) {
    assert.deepEqual(serve(wanted), mcp(wanted),
      `serve and MCP disagreed about ${JSON.stringify(wanted)} — the weaker answer is the one that gets used`);
  }
});

test('serve and MCP both refuse a duplicated id rather than one picking a winner', async () => {
  const { resolveExactProject } = await loadMcp();
  const twins = [
    { id: 'team-app', name: 'A', path: '/tmp/a', remote: 'github.com/example/a' },
    { id: 'team-app', name: 'B', path: '/tmp/b', remote: 'github.com/example/b' },
  ];
  const liveOrigin = (dir) => twins.find((p) => p.path === dir)?.remote ?? null;

  assert.throws(() => resolveRunTarget('team-app', twins, liveOrigin), LocalClaimError);
  assert.throws(() => resolveExactProject(twins, 'team-app'), /More than one/u);
});
