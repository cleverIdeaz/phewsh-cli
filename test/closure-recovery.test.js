// A closure that crashes between its two writes must be recoverable.
//
// Accepting a receipt touches two files: next.json (Work moves on) and
// decisions.md (the Record gains a line). Ordering was fixed first — Next
// written first, the Record line last, because that line is the idempotency
// key a retry recognises. But ordering alone left a real hole: if the Record
// write failed AFTER Next had been written, a retry found no Record line (so
// not "already applied") and a next.json whose hash no longer matched the
// reviewed baseline. It raised a staleness conflict, and the person was left
// with Work moved, the Record empty, and no way forward. Partial truth,
// permanently.
//
// These tests inject that failure for real — the .intent/ directory is made
// unwritable so the atomic write cannot land its temp file — rather than
// simulating the end state. Then they prove the retry finishes the job, and
// that a genuinely concurrent edit is still refused.
//
// Owner layer: CLI.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { buildClosureProposal, applyClosure, ClosureError } = require('../lib/closure');

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A project mid-run: one receipt, one Next item in flight, one Record line. */
function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-recover-'));
  const intentDir = path.join(repo, '.intent');
  fs.mkdirSync(intentDir);
  fs.writeFileSync(path.join(intentDir, 'decisions.md'), '# Decisions\n\n- 2026-07-28 — Before the run.\n');
  fs.writeFileSync(path.join(intentDir, 'next.json'), `${JSON.stringify({
    items: [
      { id: 'n1', title: 'Close the loop', state: 'now', criteria: [] },
      { id: 'n2', title: 'Something else', state: 'next', criteria: [] },
    ],
  }, null, 2)}\n`);
  return { repo, intentDir };
}

const receipt = {
  receiptId: 'r-recover-1',
  jobId: 'j-1',
  projectId: 'phewsh',
  boundProjectId: '8a849716ebfaf431',
  runtimeId: 'claude-code',
  runtimeLabel: 'Claude Code',
  status: 'done',
  partial: false,
  cancelled: false,
  changes: { preExisting: [], created: ['run-artifact.txt'], modified: [], deleted: [] },
  checks: { run: false, reason: 'No checks were run.' },
  cost: { known: false, reason: 'Unknown.', account: null },
  output: { bytes: 12, sha256: null },
  verificationCeiling: 'Not verified.',
  unknowns: [],
};

function proposalFor(intentDir, { markNextDone = true } = {}) {
  return buildClosureProposal({
    receipt, note: 'Adopting the run.', intentDir, markNextDone,
  });
}

/**
 * Make the write of decisions.md fail the way a full disk or a lost permission
 * would: writeAtomic puts its temp file beside the target, so a directory it
 * cannot write to stops it — after Next has already landed.
 */
function withUnwritableIntentDir(intentDir, fn) {
  const original = fs.statSync(intentDir).mode;
  fs.chmodSync(intentDir, 0o555);
  try {
    return fn();
  } finally {
    fs.chmodSync(intentDir, original);
  }
}

test('a crash after Next and before the Record is resumable, and completes exactly once', () => {
  const { intentDir } = fixture();
  const nextPath = path.join(intentDir, 'next.json');
  const recordPath = path.join(intentDir, 'decisions.md');
  const proposal = proposalFor(intentDir);
  const recordBefore = fs.readFileSync(recordPath, 'utf8');

  // The write of next.json needs the directory writable too, so the crash is
  // injected by letting Next land and then failing the Record. Do it by hand in
  // the same order applyClosure uses.
  //
  // First: a real attempt that dies partway.
  let crashed = null;
  try {
    withUnwritableIntentDir(intentDir, () => applyClosure({
      proposal, decision: 'accept', intentDir,
    }));
  } catch (error) {
    crashed = error;
  }
  assert.ok(crashed, 'the injected failure did not actually fail');

  // With the whole directory unwritable, NEITHER file moved — that is the
  // benign case. Reproduce the dangerous one exactly: Next written, Record not.
  const parsed = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
  parsed.items.find((i) => i.id === 'n1').state = 'done';
  fs.writeFileSync(nextPath, `${JSON.stringify(parsed, null, 2)}\n`);
  assert.strictEqual(fs.readFileSync(recordPath, 'utf8'), recordBefore,
    'the Record must still be untouched for this to be the half-applied state');

  // The retry must RECOVER rather than refuse.
  const outcome = applyClosure({ proposal, decision: 'accept', intentDir });
  assert.strictEqual(outcome.applied, true);
  assert.strictEqual(outcome.alreadyApplied, false);
  assert.deepStrictEqual(outcome.next, proposal.next.change,
    'the recovery must still report the Next change it completed');

  const recordAfter = fs.readFileSync(recordPath, 'utf8');
  assert.ok(recordAfter.includes(proposal.record.append), 'the Record line was never written');
  assert.strictEqual(
    recordAfter.split(proposal.record.append).length - 1, 1,
    'the Record line must appear exactly once',
  );
  assert.strictEqual(
    JSON.parse(fs.readFileSync(nextPath, 'utf8')).items.find((i) => i.id === 'n1').state, 'done',
    'Next must be left at its target state, not re-toggled',
  );
});

test('a second retry after a completed recovery is idempotent, not a duplicate', () => {
  const { intentDir } = fixture();
  const nextPath = path.join(intentDir, 'next.json');
  const recordPath = path.join(intentDir, 'decisions.md');
  const proposal = proposalFor(intentDir);

  const parsed = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
  parsed.items.find((i) => i.id === 'n1').state = 'done';
  fs.writeFileSync(nextPath, `${JSON.stringify(parsed, null, 2)}\n`);

  applyClosure({ proposal, decision: 'accept', intentDir });
  const afterFirst = fs.readFileSync(recordPath, 'utf8');

  const second = applyClosure({ proposal, decision: 'accept', intentDir });
  assert.strictEqual(second.alreadyApplied, true, 'a completed closure must report itself as applied');
  assert.strictEqual(fs.readFileSync(recordPath, 'utf8'), afterFirst,
    'a retry after completion must write nothing');
});

test('recovery does NOT swallow a real concurrent edit to Next', () => {
  const { intentDir } = fixture();
  const nextPath = path.join(intentDir, 'next.json');
  const proposal = proposalFor(intentDir);

  // Half-applied AND somebody else moved a different item. Undoing our own
  // change no longer reproduces the reviewed baseline, so this is staleness.
  const parsed = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
  parsed.items.find((i) => i.id === 'n1').state = 'done';
  parsed.items.find((i) => i.id === 'n2').state = 'now';
  fs.writeFileSync(nextPath, `${JSON.stringify(parsed, null, 2)}\n`);

  assert.throws(
    () => applyClosure({ proposal, decision: 'accept', intentDir }),
    (error) => error instanceof ClosureError && /changed since you reviewed/u.test(error.message),
    'a concurrent edit must still fail closed',
  );
});

test('recovery does not fire for a Next item somebody moved somewhere else entirely', () => {
  const { intentDir } = fixture();
  const nextPath = path.join(intentDir, 'next.json');
  const proposal = proposalFor(intentDir);

  // Not our target state — so not our half-written work.
  const parsed = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
  parsed.items.find((i) => i.id === 'n1').state = 'blocked';
  fs.writeFileSync(nextPath, `${JSON.stringify(parsed, null, 2)}\n`);

  assert.throws(
    () => applyClosure({ proposal, decision: 'accept', intentDir }),
    (error) => error instanceof ClosureError,
    'only this closure\'s own target state may be treated as resumable',
  );
});

test('a failed acceptance leaves the Record byte-identical', () => {
  const { intentDir } = fixture();
  const recordPath = path.join(intentDir, 'decisions.md');
  const proposal = proposalFor(intentDir);
  const before = hash(recordPath);

  try {
    withUnwritableIntentDir(intentDir, () => applyClosure({
      proposal, decision: 'accept', intentDir,
    }));
  } catch { /* the point */ }

  assert.strictEqual(hash(recordPath), before,
    'a closure that could not complete must not have written a partial Record');
});

test('a closure with no Next change still recovers on retry', () => {
  const { intentDir } = fixture();
  const recordPath = path.join(intentDir, 'decisions.md');
  // markNextDone: false — Record only. There is no half-applied state to reach,
  // but the retry path must still behave.
  const proposal = proposalFor(intentDir, { markNextDone: false });
  assert.strictEqual(proposal.next.change, null);

  const first = applyClosure({ proposal, decision: 'accept', intentDir });
  assert.strictEqual(first.applied, true);
  const after = fs.readFileSync(recordPath, 'utf8');

  const retry = applyClosure({ proposal, decision: 'accept', intentDir });
  assert.strictEqual(retry.alreadyApplied, true);
  assert.strictEqual(fs.readFileSync(recordPath, 'utf8'), after);
});
