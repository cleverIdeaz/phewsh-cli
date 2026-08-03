// The MCP surface must fail closed on project identity, the same way the serve
// path already does. `"local"` is not a placeholder — handlers.loadProjects()
// mints it from the server's own cwd — so substituting it for an unresolvable
// request meant the pre-action gate answered for whatever repository the server
// was started in, and filed the answer under the id the caller asked for.

const test = require('node:test');
const assert = require('node:assert/strict');

// mcp/ is ESM ("type": "module"); this suite is CommonJS.
const load = () => import('../mcp/lib/resolve-project.js');

const LOCAL = { id: 'local', name: 'Current Project', source: 'local' };
const REAL = { id: 'team-app', name: 'Team App' };
const OTHER = { id: 'billing', name: 'Billing' };

test('an exact project id selects that project', async () => {
  const { resolveExactProject } = await load();
  assert.equal(resolveExactProject([LOCAL, REAL, OTHER], 'team-app').id, 'team-app');
  assert.equal(resolveExactProject([LOCAL, REAL], ' team-app ').id, 'team-app');
});

test('an unknown project id fails closed instead of falling back to local', async () => {
  const { resolveExactProject, McpProjectError } = await load();
  assert.throws(
    () => resolveExactProject([LOCAL, REAL], 'no-such-project'),
    (e) => e instanceof McpProjectError && /No project with id/.test(e.message),
  );
});

test('a mistyped project id does not silently become the local project', async () => {
  const { resolveExactProject, McpProjectError } = await load();
  // The whole defect in one case: "team-ap" is one keystroke from a real id,
  // and used to be answered by the server's own working directory.
  assert.throws(
    () => resolveExactProject([LOCAL, REAL], 'team-ap'),
    (e) => e instanceof McpProjectError,
  );
  assert.throws(
    () => resolveExactProject([LOCAL, REAL], 'Team-App'), // case is not identity
    (e) => e instanceof McpProjectError,
  );
});

test('a stale project id — one no longer registered — fails closed', async () => {
  const { resolveExactProject, McpProjectError } = await load();
  const after = [LOCAL, OTHER]; // REAL was removed from the registry
  assert.throws(
    () => resolveExactProject(after, REAL.id),
    (e) => e instanceof McpProjectError && /No project with id/.test(e.message),
  );
});

test('a duplicated id fails closed rather than picking one', async () => {
  const { resolveExactProject, McpProjectError } = await load();
  // Representable: loadProjects() pushes the cwd project, then spreads the
  // registry file — a registered entry can carry an id already in use.
  const dupes = [LOCAL, { id: 'local', name: 'Registered Local', source: 'registry' }];
  assert.throws(
    () => resolveExactProject(dupes, 'local'),
    (e) => e instanceof McpProjectError && /More than one project/.test(e.message),
  );
});

test('a missing or empty project id is refused — there is no default project', async () => {
  const { resolveExactProject, McpProjectError } = await load();
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(
      () => resolveExactProject([LOCAL, REAL], bad),
      (e) => e instanceof McpProjectError && /required/.test(e.message),
      `expected refusal for ${JSON.stringify(bad)}`,
    );
  }
});

test('the resolved project always IS the requested one — verdict and record cannot disagree', async () => {
  const { resolveExactProject } = await load();
  // This is the property that makes the gate's answer and its recorded session
  // name one project. Previously the verdict came from the resolved project
  // while the record was filed under the requested id.
  for (const id of ['local', 'team-app', 'billing']) {
    assert.equal(resolveExactProject([LOCAL, REAL, OTHER], id).id, id);
  }
});

test('a project whose real id is "local" still resolves — by exact match, not fallback', async () => {
  const { resolveExactProject } = await load();
  // Compatibility: asking for "local" on purpose is legitimate and unchanged.
  assert.equal(resolveExactProject([LOCAL, REAL], 'local').id, 'local');
  // But it is only reachable when it exists. No local project, no substitution.
  assert.throws(() => resolveExactProject([REAL, OTHER], 'local'));
});

test('phewsh_start default selection follows the same invariant', async () => {
  const { defaultStartProjectId } = await load();
  // Exactly one project is unambiguous, so it is still auto-selected.
  assert.equal(defaultStartProjectId([REAL]), 'team-app');
  assert.equal(defaultStartProjectId([LOCAL]), 'local');
  // Two or more is ambiguous — the caller must choose. This used to reach for
  // whichever project had the id "local", i.e. wherever the server was started.
  assert.equal(defaultStartProjectId([LOCAL, REAL]), null);
  assert.equal(defaultStartProjectId([LOCAL, REAL, OTHER]), null);
  assert.equal(defaultStartProjectId([]), null);
});
