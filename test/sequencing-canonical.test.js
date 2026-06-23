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
