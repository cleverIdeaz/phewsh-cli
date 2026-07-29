// Runtime discovery + unlock metadata — the one honest answer to "what can
// this machine actually route work through, and how do I enable what's
// missing?"
//
// Every surface (Ion web, Desktop, mobile, connectors) must render THIS rather
// than keep its own list. `.intent/architecture.md` §"Capability discovery":
// "CLI defines → the local node reports → every surface renders what it's told."
//
// Scope: this is NOT the full capability/action/receipt contract. Cost,
// authority target, verification ceiling, and undo are not in this slice.
//
// The descriptor may only project facts the engine already holds. It must not
// invent a capability, a model list, or a provider phewsh cannot detect.

const test = require('node:test');
const assert = require('node:assert/strict');
const { harnessCapabilities, HARNESSES, interactiveLaunchArgs } = require('../lib/harnesses');

// Named ids, not `Object.keys(HARNESSES)` — deriving the expectation from the
// same object the implementation maps over is a tautology that cannot fail.
test('the descriptor covers every harness the engine ships, by name', () => {
  assert.deepEqual(harnessCapabilities().map((c) => c.id).sort(), [
    'aider', 'amp', 'claude-code', 'codex', 'copilot', 'cursor', 'droid',
    'gemini', 'goose', 'grok', 'hermes', 'kimi', 'kiro', 'opencode', 'pi',
  ]);
});

test('each entry carries the routing facts a surface needs to explain the choice honestly', () => {
  const codex = harnessCapabilities().find((c) => c.id === 'codex');
  assert.equal(codex.label, 'Codex CLI');
  assert.equal(codex.role, 'reasons & reviews');
  assert.match(codex.bestFor, /reviews/);
  assert.equal(codex.auth, 'ChatGPT plan');
  assert.equal(codex.headless, true);
  assert.equal(codex.briefing, true);
  assert.equal(codex.models, true);
  assert.equal(typeof codex.installed, 'boolean');
});

// `briefing` is NOT "can be used interactively". phewsh launches any installed
// harness interactively; the flag says only whether the verified brief rides
// along automatically or falls back to the clipboard (commands/session.js
// prints "auto-attached" vs "not auto-injectable for this tool").
test('briefing means the brief auto-attaches at launch — never that the tool is unusable interactively', () => {
  const caps = harnessCapabilities();
  const byId = Object.fromEntries(caps.map((c) => [c.id, c]));

  // Auto-attach: the harness exposes a flag that preloads a system brief.
  assert.equal(byId['claude-code'].briefing, true);
  assert.equal(byId.codex.briefing, true);

  // No auto-attach — but both are still launchable, and `interactiveLaunchArgs`
  // proves it by returning a usable (empty) argv rather than throwing.
  for (const id of ['hermes', 'pi', 'cursor', 'aider']) {
    assert.equal(byId[id].briefing, false, `${id} has no interactiveArgs`);
    assert.deepEqual(
      interactiveLaunchArgs(id, 'BRIEF'),
      { args: [], briefingPassed: false },
      `${id} must still launch — the brief goes to the clipboard instead`
    );
  }
});

test('headless and briefing are independent — hermes/pi are interactive-only yet still launchable', () => {
  const byId = Object.fromEntries(harnessCapabilities().map((c) => [c.id, c]));
  // args:null → cannot run one-shot. This is the only honest "cannot" here.
  assert.equal(byId.hermes.headless, false);
  assert.equal(byId.pi.headless, false);
  // cursor CAN run headless but still gets no auto-attached brief.
  assert.equal(byId.cursor.headless, true);
  assert.equal(byId.cursor.briefing, false);
});

// This slice is runtime discovery + unlock metadata only. Pinning the exact
// key set is what actually prevents cost/authority/verification/undo fields
// from being smuggled in under a different name and treated as a contract.
test('the descriptor ships exactly these keys — cost, authority, verification and undo are not in this slice', () => {
  for (const c of harnessCapabilities()) {
    assert.deepEqual(Object.keys(c).sort(), [
      'auth', 'bestFor', 'briefing', 'headless', 'id', 'install',
      'installKind', 'installed', 'label', 'models', 'role',
    ], `${c.id} key set`);
  }
});

test('descriptor is JSON-safe — it crosses the /health wire, so it may carry no functions', () => {
  const caps = harnessCapabilities();
  const round = JSON.parse(JSON.stringify(caps));
  assert.deepEqual(round, caps);
  for (const c of caps) {
    for (const [key, value] of Object.entries(c)) {
      assert.notEqual(typeof value, 'function', `${c.id}.${key} must not be a function`);
    }
  }
});

test('argument builders never leak — a surface must not learn how to invoke a harness', () => {
  for (const c of harnessCapabilities()) {
    assert.equal(c.args, undefined);
    assert.equal(c.interactiveArgs, undefined);
    assert.equal(c.bin, undefined);
  }
});

test('interactive-only harnesses report headless:false instead of pretending they can run one-shot', () => {
  const hermes = harnessCapabilities().find((c) => c.id === 'hermes');
  assert.equal(hermes.headless, false, 'hermes has args:null — it cannot run headlessly');
  assert.equal(HARNESSES.hermes.args, null, 'guards the premise of this test');
});

test('an uninstalled harness still reports its install hint so the surface can name one unlock path', () => {
  const kiro = harnessCapabilities().find((c) => c.id === 'kiro');
  assert.match(kiro.install, /kiro\.dev/);
});

// A surface that renders every hint as a shell command tells people to run
// prose. The engine owns the table, so the engine says which kind it is.
test('install hints declare whether they are a runnable command or a docs pointer', () => {
  const byId = Object.fromEntries(harnessCapabilities().map((c) => [c.id, c]));
  assert.equal(byId.codex.installKind, 'command');
  assert.equal(byId.codex.install, 'npm i -g @openai/codex');
  assert.equal(byId.cursor.installKind, 'command', 'a curl pipeline is still a command');
  assert.equal(byId.kiro.installKind, 'docs', '"see kiro.dev/downloads" is not runnable');
  assert.equal(byId.kimi.installKind, 'docs');
  for (const c of harnessCapabilities()) {
    if (c.install) assert.ok(['command', 'docs'].includes(c.installKind), `${c.id} must classify its hint`);
    else assert.equal(c.installKind, null);
  }
});

test('models is a pass-through flag, never a model list phewsh would have to keep current', () => {
  for (const c of harnessCapabilities()) {
    assert.equal(typeof c.models, 'boolean');
    assert.equal(c.modelHints, undefined, 'hints are a CLI affordance, not a contract promise');
  }
});

test('the engine knows 15 harnesses — the count the handoff and any surface must quote', () => {
  assert.equal(harnessCapabilities().length, 15);
});
