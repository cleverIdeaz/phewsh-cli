const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const handoff = require('../lib/handoff-receipt');

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'handoff-proof-fixture.json'),
  'utf8',
));

test('public Claude-to-Codex fixture writes and verifies the receipt before destination output', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-public-proof-project-'));
  const phewshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-public-proof-state-'));
  const receiptRoot = path.join(phewshRoot, 'handoffs');

  try {
    for (const relative of FIXTURE.project.committed) {
      const file = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, FIXTURE.project.files[relative]);
    }

    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'proof@phewsh.test'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Phewsh public proof'], { cwd });
    execFileSync('git', ['add', ...FIXTURE.project.committed], { cwd });
    execFileSync('git', ['commit', '-qm', 'record project truth'], { cwd });

    for (const relative of FIXTURE.project.dirty) {
      const file = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, FIXTURE.project.files[relative]);
    }

    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();

    const created = handoff.createHandoffReceipt({
      cwd,
      root: receiptRoot,
      report: {
        git: {
          available: true,
          head,
          tracked: [],
          untracked: FIXTURE.project.dirty,
        },
      },
      fromRoute: FIXTURE.handoff.from,
      toRoute: FIXTURE.handoff.to,
      trigger: FIXTURE.handoff.trigger,
      now: new Date(FIXTURE.handoff.created_at),
    });
    assert.equal(created.written, true);

    const briefFile = path.join(phewshRoot, 'briefs', 'auth-service', 'handoff.md');
    fs.mkdirSync(path.dirname(briefFile), { recursive: true });
    fs.writeFileSync(briefFile, FIXTURE.brief);
    const attached = handoff.attachBrief(
      created.file,
      handoff.digest(FIXTURE.brief),
      briefFile,
      { phewshRoot },
    );
    assert.equal(attached.written, true);

    // No destination harness or model is invoked in this proof. The receipt is
    // complete and verifiable before any Codex output can exist.
    assert.equal(FIXTURE.expected.receipt_before_destination_output, true);
    assert.deepEqual(attached.receipt.routes, {
      from: FIXTURE.handoff.from,
      to: FIXTURE.handoff.to,
    });
    assert.equal(attached.receipt.trigger, FIXTURE.handoff.trigger);
    assert.ok(attached.receipt.carried.repository.head);
    assert.deepEqual(
      attached.receipt.carried.intent.map(item => item.path),
      FIXTURE.expected.intent_paths,
    );
    assert.deepEqual(
      attached.receipt.carried.repository.dirty.map(item => item.path),
      FIXTURE.expected.dirty_paths,
    );
    assert.equal(attached.receipt.carried.brief.sha256, handoff.digest(FIXTURE.brief));
    assert.deepEqual(
      attached.receipt.not_carried.map(item => item.item),
      FIXTURE.expected.not_carried,
    );
    assert.equal(FIXTURE.failed_attempt.captured_in_receipt, false);
    assert.doesNotMatch(JSON.stringify(attached.receipt), /usage limit reached/);

    const pickup = handoff.verifyHandoffReceipt(created.file, { cwd, phewshRoot });
    assert.equal(pickup.status, FIXTURE.expected.pickup_status);
    assert.equal(handoff.integrityValid(pickup.receipt), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(phewshRoot, { recursive: true, force: true });
  }
});
