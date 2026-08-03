const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildClosureProposal, ClosureError } = require('../lib/closure');

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-closure-integrity-'));
  const intentDir = path.join(repo, '.intent');
  fs.mkdirSync(intentDir);
  fs.writeFileSync(path.join(intentDir, 'decisions.md'), '# Decisions\n');
  fs.writeFileSync(path.join(intentDir, 'next.json'), '{"items":[]}\n');
  return { repo, intentDir };
}

const intactReceipt = () => ({
  receiptId: 'r-integrity-1',
  projectId: 'phewsh',
  boundProjectId: 'bound-project',
  boundProjectRemote: 'github.com/example/phewsh',
  runtimeLabel: 'Claude Code',
  status: 'done',
  partial: false,
  changes: { created: ['result.txt'], modified: [], deleted: [] },
  verificationCeiling: 'Not verified.',
  integrity: 'intact',
});

test('an intact persisted receipt can produce a closure proposal', () => {
  const { repo, intentDir } = fixture();
  try {
    const proposal = buildClosureProposal({
      receipt: intactReceipt(),
      note: 'Adopt this result.',
      intentDir,
    });
    assert.equal(proposal.receiptId, 'r-integrity-1');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('altered, unrecorded, missing, and unknown integrity cannot produce a proposal', () => {
  const { repo, intentDir } = fixture();
  const missing = intactReceipt();
  delete missing.integrity;
  const invalidReceipts = [
    { ...intactReceipt(), integrity: 'altered' },
    { ...intactReceipt(), integrity: 'unrecorded' },
    missing,
    { ...intactReceipt(), integrity: 'future-integrity-state' },
  ];

  try {
    for (const receipt of invalidReceipts) {
      assert.throws(
        () => buildClosureProposal({ receipt, note: 'Must not be proposed.', intentDir }),
        (error) => error instanceof ClosureError
          && error.status === 409
          && /integrity.*intact/iu.test(error.message),
        `integrity ${String(receipt.integrity)} did not fail closed explicitly`,
      );
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('legacy path-only evidence cannot enter current project truth', () => {
  const { repo, intentDir } = fixture();
  const legacy = intactReceipt();
  delete legacy.boundProjectRemote;
  try {
    assert.throws(
      () => buildClosureProposal({ receipt: legacy, note: 'Must not be proposed.', intentDir }),
      (error) => error instanceof ClosureError
        && error.status === 409
        && /remote identity|legacy/iu.test(error.message),
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
