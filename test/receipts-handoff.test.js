const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('handoff receipts join the existing proof trail and project filter', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-receipts-home-'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-receipts-parent-'));
  const cwd = path.join(parent, 'canary-private-project-name');
  fs.mkdirSync(cwd);
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(cwd, '.intent'));
    fs.writeFileSync(path.join(cwd, '.intent', 'vision.md'), '# Vision\n');
    delete require.cache[require.resolve('../lib/handoff-receipt')];
    delete require.cache[require.resolve('../lib/receipts-data')];
    require('../lib/handoff-receipt').createHandoffReceipt({
      cwd,
      report: { git: { available: false } },
      fromRoute: 'canary-private-route',
      toRoute: 'claude-code',
    });

    const receipts = require('../lib/receipts-data');
    receipts.recordSessionEvent('codex', 'private-neighbor', 'work_started', {
      summary: 'must not cross the handoff-only wire',
      dirtyPaths: ['private/neighbor.txt'],
    });
    const all = receipts.gatherReceipts({ limit: 10 });
    assert.equal(all.summary.handoffs, 1);
    assert.equal(all.summary.totalEvents, 2);
    const handoffEvent = all.events.find(event => event.kind === 'handoff');
    assert.equal(handoffEvent.valid, true);
    assert.match(handoffEvent.receipt, /^handoffs\//);

    const project = path.basename(cwd);
    assert.equal(receipts.gatherReceipts({ project, limit: 10 }).events.length, 1);
    assert.equal(receipts.gatherReceipts({ project: 'elsewhere', limit: 10 }).events.length, 0);

    const handoffsOnly = receipts.gatherReceipts({ kind: 'handoff', limit: 10, publicView: true, cwd });
    assert.equal(handoffsOnly.summary.totalEvents, 1);
    assert.equal(handoffsOnly.events.length, 1);
    assert.doesNotMatch(JSON.stringify(handoffsOnly), /private-neighbor|neighbor\.txt|must not cross/);
    const publicEvent = handoffsOnly.events[0];
    const publicBytes = JSON.stringify(publicEvent);
    assert.equal(publicEvent.data.truth_file_count, 1);
    assert.equal(publicEvent.data.dirty_path_count, 0);
    assert.equal(publicEvent.receipt, null);
    assert.equal(publicEvent.project, null);
    assert.equal(publicEvent.agent, 'other');
    assert.deepEqual(publicEvent.data.routes, { from: 'other', to: 'claude-code' });
    assert.equal(publicEvent.data.verdict, 'verified');
    assert.doesNotMatch(publicBytes, /sha256|root_fingerprint|\.intent\/vision\.md|canary-private/);

    const otherCwd = fs.mkdtempSync(path.join(parent, 'other-project-'));
    fs.mkdirSync(path.join(otherCwd, '.intent'));
    fs.writeFileSync(path.join(otherCwd, '.intent', 'vision.md'), '# Other\n');
    assert.equal(
      receipts.gatherReceipts({ kind: 'handoff', limit: 10, publicView: true, cwd: otherCwd }).events.length,
      0,
      'a worker never exposes another checkout\'s handoffs',
    );

    const file = path.join(home, '.phewsh', handoffEvent.receipt);
    const tampered = JSON.parse(fs.readFileSync(file, 'utf-8'));
    tampered.routes.to = 'tampered';
    fs.writeFileSync(file, JSON.stringify(tampered));
    const invalid = receipts.gatherReceipts({ limit: 10 });
    assert.equal(invalid.summary.invalidHandoffs, 1);
    assert.equal(invalid.events.find(event => event.kind === 'handoff').valid, false);
  } finally {
    process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
