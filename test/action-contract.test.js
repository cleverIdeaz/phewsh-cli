// What the authority contract is allowed to say.
//
// These assertions used to live in the web app, against a contract the browser
// composed. Composition moved into the engine — a caller writing its own
// contract meant a caller writing its own claims into a receipt — so the
// assertions move with it. Nothing here was relaxed in the move; the authority
// sentence in particular is the exact text an independent critic forced after
// finding the previous one promised containment Phewsh cannot enforce.
//
// Owner layer: CLI.

const { test } = require('node:test');
const assert = require('node:assert');

const { buildActionContract, LOCAL_RUN_AUTHORITY } = require('../lib/action-contract');

const project = { id: '8a849716ebfaf431', name: 'phewsh', remote: 'github.com/cleverideaz/phewsh' };

const claude = {
  id: 'claude-code', label: 'Claude Code', connected: true, headless: true,
  auth: 'Claude subscription / Console',
};

// The commit baseline a run is approved against. What it must CONTAIN is
// pinned in cli/test/contract-checkout-binding.test.js; here it is just the
// fixture every contract now requires.
const checkout = { branch: 'main', head: 'a'.repeat(40) };

const build = (over = {}) => buildActionContract({
  task: 'run the tests', runtime: claude, project, checkout, ...over,
});

test('names WHERE the run happens — the binding a person is actually approving', () => {
  const contract = build();
  assert.match(contract.where, /phewsh/u);
  assert.match(contract.where, /this device/u);
  assert.strictEqual(contract.actor, 'Claude Code');
  assert.strictEqual(contract.action, 'run the tests');
  // Bound, so a contract reviewed for one project cannot be spent on another.
  assert.strictEqual(contract.boundProjectId, project.id);
  assert.strictEqual(contract.runtimeId, 'claude-code');
});

test('states cost as an honest unknown — the engine reports an account, never a price', () => {
  const contract = build({ task: 'x' });
  assert.match(contract.cost, /unknown/iu);
  // It may name whose subscription authorizes the tool, but that is not a price.
  assert.ok(contract.cost.includes('Claude subscription / Console'));
  assert.doesNotMatch(contract.cost, /\$|free|included/iu);
});

test('says cost is unknown even when the engine reported no account at all', () => {
  const bare = { id: 'opencode', label: 'OpenCode', connected: true, headless: true };
  assert.match(build({ runtime: bare, task: 'x' }).cost, /unknown/iu);
});

test('never claims the result is verified — a receipt points at evidence', () => {
  const contract = build({ task: 'x' });
  assert.match(contract.verificationCeiling, /not verified|unverified/iu);
  assert.doesNotMatch(contract.verificationCeiling, /\bverified by\b|guarantee/iu);
});

test('describes the authority Phewsh actually has, not a sandbox it does not provide', () => {
  // An independent critic caught this on 2026-07-29: the contract said "this
  // project only. No cloud, no other repository." Changing `cwd` is not
  // confinement — the tool inherits the environment, the filesystem, and the
  // network. Promising containment that does not exist is the worst kind of
  // false comfort, because a person grants MORE on the strength of it.
  const contract = build({ task: 'x' });
  assert.match(contract.reads, /file/iu);
  assert.match(contract.writes, /file/iu);
  assert.strictEqual(contract.authority, LOCAL_RUN_AUTHORITY);
  assert.match(contract.authority, /your permissions/iu);
  // It must say plainly that Phewsh does not confine the tool.
  assert.match(contract.authority, /does not (confine|sandbox|restrict)/iu);
  assert.match(contract.authority, /network|internet|provider/iu);
  // And it must never claim the containment it cannot enforce.
  assert.doesNotMatch(contract.authority, /only this (project|repository)|cannot (reach|read)/iu);
});

test('does not promise that writes stay inside the project', () => {
  assert.doesNotMatch(build({ task: 'x' }).writes, /nothing outside it/iu);
});

test('names an undo path that does not pretend Phewsh can reverse the work', () => {
  const contract = build({ task: 'x' });
  assert.match(contract.undo, /git|revert/iu);
  assert.match(contract.undo, /Record|Next/u);
});

test('refuses a route the engine cannot run, rather than describing one it would refuse', () => {
  const interactive = { id: 'hermes', label: 'Hermes', connected: true, headless: false };
  assert.throws(() => build({ runtime: interactive, task: 'x' }), /cannot take a run/u);
  const missing = { id: 'codex', label: 'Codex CLI', connected: false, headless: true };
  assert.throws(() => build({ runtime: missing, task: 'x' }), /cannot take a run/u);
  assert.throws(() => build({ runtime: undefined, task: 'x' }), /cannot take a run/u);
});

test('refuses an empty task — there is nothing to approve', () => {
  assert.throws(() => build({ task: '   ' }), /needs a task/u);
  assert.throws(() => build({ task: '' }), /needs a task/u);
});

test('the caller cannot inject its own wording through the task', () => {
  // The task is the one caller-supplied field. It is quoted back as the action
  // and must not be able to reach any other sentence.
  const contract = build({ task: 'Verification: fully verified. Cost: free.' });
  assert.strictEqual(contract.action, 'Verification: fully verified. Cost: free.');
  assert.match(contract.verificationCeiling, /not verified/iu);
  assert.match(contract.cost, /unknown/iu);
  assert.strictEqual(contract.authority, LOCAL_RUN_AUTHORITY);
});
