// Regression tests for the divergent-writer fix: every native projection write
// (self-heal, watch, /seq claude, `phewsh seq claude -w`) must go through ONE
// canonical projection with ONE source policy — so a manual sequence can never
// produce a stale or divergent CLAUDE.md. Also covers upward project-root
// resolution and the archival of narrative.md from projection sources.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { discover, resolveProjectRoot } = require('../lib/sequencer/discover');
const selfheal = require('../lib/selfheal');

function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-canon-')));
  fs.mkdirSync(path.join(dir, '.intent'));
  fs.writeFileSync(path.join(dir, '.intent', 'vision.md'), '# Vision\nCanonical truth.\n');
  fs.writeFileSync(path.join(dir, '.intent', 'status.md'), '# Status\n## Now\nShipped `0.15.63`.\n');
  fs.writeFileSync(path.join(dir, '.intent', 'next.md'), '# Next\nThe current item.\n');
  fs.writeFileSync(path.join(dir, '.intent', 'project.json'), JSON.stringify({ name: 'Canon', decisionGate: { constraints: { budget: 10 } } }));
  return dir;
}

const coreOf = (claudeMd) => {
  const m = claudeMd.match(/<!-- PHEWSH:START -->([\s\S]*?)<!-- PHEWSH:END -->/);
  return m ? m[1] : '';
};

test('resolveProjectRoot walks up from a nested dir to the .intent root', () => {
  const root = project();
  const nested = path.join(root, 'cli', 'lib');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveProjectRoot(nested), root, 'nested dir resolves to the project root');
  assert.equal(resolveProjectRoot(root), root, 'root resolves to itself');
});

test('resolveProjectRoot leaves a dir with no .intent anywhere unchanged', () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-bare-')));
  assert.equal(resolveProjectRoot(bare), bare);
});

test('a nested project (its own .intent) resolves to itself, not an ancestor', () => {
  const outer = project();
  const inner = path.join(outer, 'sub');
  fs.mkdirSync(path.join(inner, '.intent'), { recursive: true });
  fs.writeFileSync(path.join(inner, '.intent', 'vision.md'), '# Inner\n');
  assert.equal(resolveProjectRoot(inner), inner, 'nearest .intent wins');
});

test('narrative.md is NOT a discovered source (archived, never projected)', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.intent', 'narrative.md'), '# Old\nCLI (v0.11.16, published)\n');
  const names = discover(root).map(s => s.name);
  assert.ok(!names.includes('narrative.md'), 'narrative.md excluded from discovery');
});

test('canonical projection never carries stale narrative.md content (no 0.11.16)', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.intent', 'narrative.md'), '# Old Unified Narrative\nCLI (v0.11.16, published)\n');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Human notes\n');
  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const written = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
  assert.ok(!written.includes('0.11.16'), 'stale narrative version cannot leak into the projection');
  assert.ok(written.includes('Canonical truth') || written.includes('Canon'), 'canonical .intent IS projected');
});

test('the canonical projection is deterministic and idempotent', () => {
  const root = project();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Human header\n\nKeep me.\n');
  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const first = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const second = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');
  assert.equal(coreOf(first), coreOf(second), 'same inputs → byte-identical generated block');
  assert.ok(second.includes('Human header') && second.includes('Keep me.'), 'human content outside markers preserved');
});

test('canonical projection budget preserves current focus, Next criteria, and constraints together', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.intent', 'vision.md'), '# Vision\n' + 'Durable identity and architecture. '.repeat(190));
  fs.writeFileSync(path.join(root, '.intent', 'status.md'), '# Status\n## Now\n**Current Focus:**\n- **Latest focus survives:** keep the active state visible.\n');
  fs.writeFileSync(path.join(root, '.intent', 'next.json'), JSON.stringify({
    version: 1,
    items: [{
      id: 'current',
      title: 'Keep the full operating contract visible',
      state: 'now',
      updated: new Date().toISOString(),
      criteria: Array.from({ length: 12 }, (_, index) => ({
        expected: `criterion ${index + 1} remains visible with enough explanatory text to exercise the projection budget`,
        type: 'measurable',
        accepted: true,
      })),
    }],
  }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');

  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const written = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(written, /Latest focus survives/);
  assert.match(written, /criterion 12 remains visible/);
  assert.match(written, /Budget: \$10/);
});

test('writing the projection from a nested dir targets the project-root CLAUDE.md', () => {
  const root = project();
  const nested = path.join(root, 'pkg');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# root\n');
  selfheal.syncContextFiles({ cwd: nested, targets: ['CLAUDE.md'] });
  // The root CLAUDE.md got the block; no stray CLAUDE.md created in the nested dir.
  assert.ok(coreOf(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8')).length > 0, 'root projection written');
  assert.ok(!fs.existsSync(path.join(nested, 'CLAUDE.md')), 'no nested CLAUDE.md created');
});

// The Record is the fourth word. `phewsh remember` writes .intent/decisions.md,
// and until 2026-07-28 the canonical projection's source allowlist omitted it —
// so every native projection taught Project and Next but dropped what the last
// session learned. Found by the P2 released-artifact cold-transfer run.
test('the canonical projection carries the Record, not just Project and Next', () => {
  const root = project();
  fs.writeFileSync(
    path.join(root, '.intent', 'decisions.md'),
    '# Decisions\n\n- 2026-07-28 — Chose loopback-only dispatch because a remote node cannot prove machine identity.\n',
  );
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# root\n');
  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const core = coreOf(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'));
  assert.match(core, /## Record/, 'canonical projection has no Record section');
  assert.match(core, /loopback-only dispatch/, 'canonical projection dropped the recorded decision');
  assert.match(core, /\.intent\/decisions\.md/, 'Record section does not point at its source of truth');
});

test('the canonical projection keeps the Record bounded and newest-first', () => {
  const root = project();
  const entries = Array.from({ length: 12 }, (_, i) =>
    `- 2026-07-${String(i + 1).padStart(2, '0')} — Decision number ${i + 1}.`).join('\n');
  fs.writeFileSync(path.join(root, '.intent', 'decisions.md'), `# Decisions\n\n${entries}\n`);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# root\n');
  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const core = coreOf(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'));
  assert.match(core, /Decision number 12\./, 'newest decision missing');
  assert.doesNotMatch(core, /Decision number 1\./, 'unbounded — carried the whole journal');
  assert.match(core, /3 most recent of 12 decisions/, 'did not disclose that the record was truncated');
  // Newest first: 12 must appear before 10 (both are inside the cap).
  assert.ok(core.includes('Decision number 10.'), 'expected the third-newest entry to be carried');
  assert.ok(core.indexOf('Decision number 12.') < core.indexOf('Decision number 10.'), 'not newest-first');
});

// The regression this caused on first implementation: two real phewsh decision
// entries (each ~2,000 chars) consumed the pre-emission budget and evicted the
// entire Active Actions block — Now plus 26 accepted success criteria — from
// every projection. The Record is a headline pointing at the file; it must never
// outrank the accepted Next criteria.
test('a long Record never evicts the accepted Next criteria', () => {
  const root = project();
  const fat = Array.from({ length: 6 }, (_, i) =>
    `- 2026-07-${String(i + 10).padStart(2, '0')} — Decision ${i + 1}. ${'context '.repeat(300)}`).join('\n');
  fs.writeFileSync(path.join(root, '.intent', 'decisions.md'), `# Decisions\n\n${fat}\n`);
  fs.writeFileSync(path.join(root, '.intent', 'next.json'), JSON.stringify({
    items: [{
      id: 'n1', title: 'Ship the golden journey', state: 'now',
      criteria: Array.from({ length: 20 }, (_, i) => ({ expected: `Criterion number ${i + 1} must hold`, type: 'measurable' })),
    }],
  }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# root\n');
  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const core = coreOf(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'));
  assert.match(core, /## Record/, 'Record missing');
  assert.match(core, /Criterion number 1 must hold/, 'accepted Next criteria were evicted by the Record');
  assert.match(core, /Ship the golden journey/, 'the current Next item was evicted by the Record');
});

test('each Record entry is truncated to a headline, not the full journal entry', () => {
  const root = project();
  const long = `- 2026-07-28 — Headline part. ${'tail '.repeat(400)}`;
  fs.writeFileSync(path.join(root, '.intent', 'decisions.md'), `# Decisions\n\n${long}\n`);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# root\n');
  selfheal.syncContextFiles({ cwd: root, targets: ['CLAUDE.md'] });
  const core = coreOf(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'));
  const line = core.split('\n').find(l => l.includes('Headline part.'));
  assert.ok(line, 'the decision headline is missing');
  assert.ok(line.length < 300, `Record entry not truncated (${line.length} chars)`);
  assert.match(line, /…$/, 'truncated entry does not disclose truncation');
});
