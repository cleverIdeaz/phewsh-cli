// The run receipt and its human closure — journey items 9 and 10.
//
// A receipt is EVIDENCE: what the engine observed, written once, never edited.
// It is not project truth, and it is not a claim that the work was any good.
// Accepting it is a separate human act, recorded separately, and only that act
// may touch .intent/.
//
// These tests pin the parts that must not drift: the schema itself, what may
// never appear in it, how changed paths are attributed, and the fail-closed
// rules around applying a closure.
//
// Owner layer: CLI.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  RECEIPT_SCHEMA, RECEIPT_VERSION, buildRunReceipt, attributeChanges, gitStatusMap,
} = require('../lib/run-receipt');
const { buildClosureProposal, applyClosure, ClosureError } = require('../lib/closure');

const contract = {
  action: 'report the working directory',
  actor: 'Claude Code',
  where: 'phewsh — the copy on this device (github.com/cleverideaz/phewsh)',
  reads: 'Files in this project, including its .intent/.',
  writes: 'May create or change files in this project. Nothing outside it.',
  cost: 'Unknown — the engine reports which account authorizes a tool, never a price.',
  authority: 'Runs on this machine, in this project only. No cloud, no other repository, no other device.',
  verificationCeiling: 'Not verified. A receipt records what happened and points at evidence; it does not check the work.',
  undo: 'File changes are yours to revert with git. Nothing reaches Record or Next unless you accept it.',
};

const baseInput = () => ({
  receiptId: 'r-0123456789abcdef',
  jobId: '9b0a22a1-5a3b-43cb-be5f-1bd7710c80f1',
  projectId: 'phewsh',
  boundProjectId: '8a849716ebfaf431',
  boundProjectRemote: 'github.com/cleverideaz/phewsh',
  runtimeId: 'claude-code',
  runtimeLabel: 'Claude Code',
  startedAt: '2026-07-29T02:19:11.929Z',
  endedAt: '2026-07-29T02:19:13.001Z',
  status: 'done',
  contract,
  changes: { preExisting: ['notes.md'], created: ['out.txt'], modified: [], deleted: [] },
  output: { bytes: 42, sha256: 'a'.repeat(64) },
});

test('the receipt carries the engine-observed facts under a versioned schema', () => {
  const receipt = buildRunReceipt(baseInput());

  assert.strictEqual(receipt.schema, RECEIPT_SCHEMA);
  assert.strictEqual(receipt.version, RECEIPT_VERSION);
  assert.strictEqual(receipt.receiptId, 'r-0123456789abcdef');
  // Both identities, each keeping its own job: the name groups receipts, the
  // stable id says which exact repository this run touched.
  assert.strictEqual(receipt.projectId, 'phewsh');
  assert.strictEqual(receipt.boundProjectId, '8a849716ebfaf431');
  assert.strictEqual(receipt.runtimeId, 'claude-code');
  assert.strictEqual(receipt.status, 'done');
  assert.strictEqual(receipt.durationMs, 1072);
  assert.deepStrictEqual(receipt.contract, contract);
  assert.strictEqual(receipt.writeOnce, true);
});

test('a receipt never carries a transcript, file contents, secrets, or an absolute path', () => {
  const receipt = buildRunReceipt({
    ...baseInput(),
    // Everything a careless caller might try to attach.
    output: { bytes: 42, sha256: 'a'.repeat(64), text: 'the model said hello' },
    transcript: 'user: hi\nassistant: hello',
    env: { ANTHROPIC_API_KEY: 'sk-should-never-appear' },
  });

  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /the model said hello/u, 'no model output text');
  assert.doesNotMatch(serialized, /user: hi/u, 'no transcript');
  assert.doesNotMatch(serialized, /sk-should-never-appear/u, 'no secrets');
  assert.doesNotMatch(serialized, /\/Users\/|\/home\/|C:\\\\/u, 'no absolute paths');
  // Integrity data survives — that is how output is referenced without quoting it.
  assert.strictEqual(receipt.output.bytes, 42);
  assert.match(receipt.output.sha256, /^[a-f0-9]{64}$/u);
  assert.strictEqual(receipt.output.text, undefined);
});

test('checks are reported as not run rather than implied to have passed', () => {
  const receipt = buildRunReceipt(baseInput());
  assert.strictEqual(receipt.checks.run, false);
  assert.match(receipt.checks.reason, /did not run/i);
  // The single most dangerous possible lie in this file.
  assert.doesNotMatch(JSON.stringify(receipt.checks), /passed|success/iu);
});

test('cost is unknown unless it was evidenced', () => {
  const receipt = buildRunReceipt(baseInput());
  assert.strictEqual(receipt.cost.known, false);
  assert.match(receipt.cost.reason, /unknown/i);
  assert.doesNotMatch(JSON.stringify(receipt.cost), /\$|free/iu);
});

test('the receipt states its verification ceiling, unknowns, and what did not carry', () => {
  const receipt = buildRunReceipt(baseInput());
  assert.match(receipt.verificationCeiling, /not verified/i);
  assert.ok(receipt.unknowns.length > 0, 'a run with no checks has unknowns');
  assert.ok(receipt.notCarried.some((n) => /transcript/i.test(n)),
    'the transcript boundary must be stated, not assumed');
  assert.ok(receipt.carried.some((c) => /changed path|receipt/i.test(c)));
});

test('a cancelled run is recorded as cancelled, never as a failure or a success', () => {
  const receipt = buildRunReceipt({ ...baseInput(), status: 'cancelled' });
  assert.strictEqual(receipt.status, 'cancelled');
  assert.strictEqual(receipt.cancelled, true);
  assert.strictEqual(receipt.partial, true, 'a cancelled run that changed files is partial');
});

test('an error that still changed files is marked partial', () => {
  const errored = buildRunReceipt({ ...baseInput(), status: 'error' });
  assert.strictEqual(errored.partial, true);
  const clean = buildRunReceipt({
    ...baseInput(), status: 'error',
    changes: { preExisting: [], created: [], modified: [], deleted: [] },
  });
  assert.strictEqual(clean.partial, false, 'nothing changed, so nothing is half-done');
});

test('changed paths separate what the run did from what was already dirty', () => {
  // git porcelain before → after. Only the delta is attributable to the run.
  const before = { 'notes.md': ' M', 'stale.txt': '??' };
  const after = { 'notes.md': ' M', 'stale.txt': '??', 'new.txt': '??', 'src/a.js': ' M', 'gone.md': ' D' };
  const changes = attributeChanges(before, after);

  assert.deepStrictEqual(changes.preExisting, ['notes.md', 'stale.txt']);
  assert.deepStrictEqual(changes.created, ['new.txt']);
  assert.deepStrictEqual(changes.modified, ['src/a.js']);
  assert.deepStrictEqual(changes.deleted, ['gone.md']);
  // A path that was already dirty is never claimed as the run's work.
  assert.ok(!changes.modified.includes('notes.md'));
});

test('changed paths are relative — a receipt must not publish where the repo lives', () => {
  const changes = attributeChanges({}, { 'src/a.js': ' M' });
  for (const p of [...changes.created, ...changes.modified, ...changes.deleted]) {
    assert.ok(!path.isAbsolute(p), `${p} must be relative`);
  }
});

// ─── Closure: the human act, separate from the evidence ──────────────────────

function intentFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-closure-'));
  const intentDir = path.join(dir, '.intent');
  fs.mkdirSync(intentDir);
  fs.writeFileSync(path.join(intentDir, 'decisions.md'), '# Decisions\n\n- 2026-07-28 — An earlier decision.\n');
  fs.writeFileSync(path.join(intentDir, 'next.json'), JSON.stringify({
    items: [{ id: 'n1', title: 'Ship the local journey', state: 'now', criteria: [] }],
  }, null, 2));
  return intentDir;
}

const hashOf = (file) => require('node:crypto')
  .createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Closure receives receipts after the data layer has reread and verified the
// persisted bytes. Building the schema alone intentionally has no verdict.
const intactReceipt = () => ({ ...buildRunReceipt(baseInput()), integrity: 'intact' });

test('a proposal shows the exact change and pins what it was computed against', () => {
  const intentDir = intentFixture();
  const receipt = intactReceipt();
  const proposal = buildClosureProposal({ receipt, note: 'The run reported its directory.', intentDir });

  assert.ok(proposal.proposalId);
  assert.strictEqual(proposal.receiptId, receipt.receiptId);
  assert.strictEqual(proposal.boundProjectId, receipt.boundProjectId);
  // Exactly what would be appended — reviewable before anything is written.
  assert.match(proposal.record.append, /The run reported its directory\./u);
  assert.strictEqual(proposal.record.file, '.intent/decisions.md');
  // No Next change unless one was asked for.
  assert.strictEqual(proposal.next.change, null);
  // The baseline is what "fail closed if the files moved" is measured against.
  assert.strictEqual(proposal.baseline['.intent/decisions.md'],
    hashOf(path.join(intentDir, 'decisions.md')));
});

test('a proposed Next change names the exact transition', () => {
  const intentDir = intentFixture();
  const proposal = buildClosureProposal({
    receipt: intactReceipt(), note: 'done', intentDir, markNextDone: true,
  });
  assert.deepStrictEqual(proposal.next.change, { id: 'n1', title: 'Ship the local journey', from: 'now', to: 'done' });
});

test('rejecting leaves .intent/ byte-identical and still keeps the receipt', () => {
  const intentDir = intentFixture();
  const receipt = intactReceipt();
  const proposal = buildClosureProposal({ receipt, note: 'not this', intentDir, markNextDone: true });
  const before = {
    decisions: fs.readFileSync(path.join(intentDir, 'decisions.md')),
    next: fs.readFileSync(path.join(intentDir, 'next.json')),
  };

  const outcome = applyClosure({ proposal, decision: 'reject', intentDir });

  assert.strictEqual(outcome.decision, 'reject');
  assert.strictEqual(outcome.applied, false);
  assert.deepStrictEqual(fs.readFileSync(path.join(intentDir, 'decisions.md')), before.decisions);
  assert.deepStrictEqual(fs.readFileSync(path.join(intentDir, 'next.json')), before.next);
  // The evidence is not erased by a human declining to adopt it.
  assert.strictEqual(outcome.receiptId, receipt.receiptId);
});

test('accepting applies exactly the reviewed change and nothing else', () => {
  const intentDir = intentFixture();
  const proposal = buildClosureProposal({
    receipt: intactReceipt(), note: 'The run reported its directory.', intentDir, markNextDone: true,
  });

  const outcome = applyClosure({ proposal, decision: 'accept', intentDir });
  assert.strictEqual(outcome.applied, true);

  const decisions = fs.readFileSync(path.join(intentDir, 'decisions.md'), 'utf8');
  assert.ok(decisions.includes(proposal.record.append.trim()), 'the reviewed line must be the line written');
  assert.ok(decisions.includes('- 2026-07-28 — An earlier decision.'), 'existing Record must survive');
  const next = JSON.parse(fs.readFileSync(path.join(intentDir, 'next.json'), 'utf8'));
  assert.strictEqual(next.items[0].state, 'done');
});

test('a retried acceptance cannot duplicate the Record or the Next change', () => {
  const intentDir = intentFixture();
  const proposal = buildClosureProposal({
    receipt: intactReceipt(), note: 'Exactly once.', intentDir,
  });

  const first = applyClosure({ proposal, decision: 'accept', intentDir });
  // A lost response, retried with the same proposal — the shape of a real retry.
  const second = applyClosure({ proposal, decision: 'accept', intentDir });

  assert.strictEqual(first.applied, true);
  assert.strictEqual(second.applied, true, 'a retry reports the same outcome');
  assert.strictEqual(second.alreadyApplied, true);
  const decisions = fs.readFileSync(path.join(intentDir, 'decisions.md'), 'utf8');
  const occurrences = decisions.split('Exactly once.').length - 1;
  assert.strictEqual(occurrences, 1, 'the Record must contain the entry exactly once');
});

test('acceptance fails closed when the files moved since the preview', () => {
  const intentDir = intentFixture();
  const proposal = buildClosureProposal({
    receipt: intactReceipt(), note: 'stale', intentDir,
  });
  // Someone (or another tool) edited project truth after the human read the preview.
  fs.appendFileSync(path.join(intentDir, 'decisions.md'), '- 2026-07-29 — Someone else wrote here.\n');
  const after = fs.readFileSync(path.join(intentDir, 'decisions.md'));

  assert.throws(
    () => applyClosure({ proposal, decision: 'accept', intentDir }),
    (err) => err instanceof ClosureError && err.status === 409 && /changed since/i.test(err.message),
  );
  assert.deepStrictEqual(fs.readFileSync(path.join(intentDir, 'decisions.md')), after,
    'a refused acceptance must not write anything');
});

test('acceptance is never rewritten as a claim about the work', () => {
  const intentDir = intentFixture();
  const proposal = buildClosureProposal({
    receipt: intactReceipt(), note: 'Ran the thing.', intentDir,
  });
  applyClosure({ proposal, decision: 'accept', intentDir });
  const decisions = fs.readFileSync(path.join(intentDir, 'decisions.md'), 'utf8');
  // "A human accepted this" must never become "the checks passed".
  assert.doesNotMatch(decisions, /tests? passed|verified by|checks? passed/iu);
  assert.match(decisions, /not verified|checks did not run/iu,
    'the Record entry must carry the same ceiling the receipt did');
});

test('the shared fixture still matches what the engine produces', () => {
  // Ion renders against this exact file (see intent/app tests). If the schema
  // moves and the fixture does not, the two surfaces have already diverged —
  // this is the test that notices before a user does.
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'run-receipt.v1.json'), 'utf8',
  ));
  const rebuilt = buildRunReceipt({
    receiptId: fixture.receiptId,
    jobId: fixture.jobId,
    projectId: fixture.projectId,
    boundProjectId: fixture.boundProjectId,
    boundProjectRemote: fixture.boundProjectRemote,
    runtimeId: fixture.runtimeId,
    runtimeLabel: fixture.runtimeLabel,
    startedAt: fixture.startedAt,
    endedAt: fixture.endedAt,
    status: fixture.status,
    contract: fixture.contract,
    changes: fixture.changes,
    output: fixture.output,
    boundByCaller: fixture.boundByCaller,
  });
  assert.deepStrictEqual(rebuilt, fixture,
    'regenerate test/fixtures/run-receipt.v1.json and update the Ion renderer together');
});

test('a closure that cannot finish writes nothing at all', () => {
  // Found by an independent critic: Record was written before Next, so a Next
  // that had moved left the Record changed and Next untouched — and the retry
  // then saw its own Record line, reported "already applied", and skipped Next
  // permanently. Validate everything first, then write Next, then Record last:
  // the Record line is the idempotency key, so it must be the final act.
  const intentDir = intentFixture();
  const proposal = buildClosureProposal({
    receipt: intactReceipt(), note: 'Half-applied is not a state.',
    intentDir, markNextDone: true,
  });
  const recordBefore = fs.readFileSync(path.join(intentDir, 'decisions.md'));

  // Someone closes that Next item by hand between the review and the click.
  const next = JSON.parse(fs.readFileSync(path.join(intentDir, 'next.json'), 'utf8'));
  next.items[0].state = 'done';
  fs.writeFileSync(path.join(intentDir, 'next.json'), JSON.stringify(next, null, 2));

  assert.throws(
    () => applyClosure({ proposal, decision: 'accept', intentDir }),
    (err) => err instanceof ClosureError && err.status === 409,
  );
  assert.deepStrictEqual(fs.readFileSync(path.join(intentDir, 'decisions.md')), recordBefore,
    'the Record must not be written when the Next half cannot be');
});

test('a retry after a refused closure still applies cleanly', () => {
  const intentDir = intentFixture();
  const receipt = intactReceipt();
  const stale = buildClosureProposal({ receipt, note: 'First attempt.', intentDir, markNextDone: true });
  const next = JSON.parse(fs.readFileSync(path.join(intentDir, 'next.json'), 'utf8'));
  next.items[0].state = 'done';
  fs.writeFileSync(path.join(intentDir, 'next.json'), JSON.stringify(next, null, 2));
  assert.throws(() => applyClosure({ proposal: stale, decision: 'accept', intentDir }));

  // Re-reviewed against the world as it now is, acceptance works — nothing was
  // left in a state that blocks the second try.
  const fresh = buildClosureProposal({ receipt, note: 'Second attempt.', intentDir });
  const outcome = applyClosure({ proposal: fresh, decision: 'accept', intentDir });
  assert.strictEqual(outcome.applied, true);
  const decisions = fs.readFileSync(path.join(intentDir, 'decisions.md'), 'utf8');
  assert.ok(decisions.includes('Second attempt.'));
  assert.ok(!decisions.includes('First attempt.'), 'the refused attempt left no trace');
});

// ─── Attribution, corrected after an independent critic (2026-07-29) ─────────
// Skipping every path that was already dirty meant a run that FURTHER modified
// or deleted one of them showed as having changed nothing.

test('a pre-existing dirty path the run then changes is attributed to the run', () => {
  const before = { 'notes.md': ' M', 'staged.txt': 'M ' };
  const after = { 'notes.md': 'MM', 'staged.txt': 'MM' };
  const changes = attributeChanges(before, after);
  assert.deepStrictEqual(changes.modified, ['notes.md', 'staged.txt'],
    'a changed status on a dirty path is the run touching it again');
  assert.deepStrictEqual(changes.preExisting, ['notes.md', 'staged.txt']);
});

test('a pre-existing path the run deletes is reported as deleted', () => {
  const changes = attributeChanges({ 'gone.md': ' M' }, { 'gone.md': ' D' });
  assert.deepStrictEqual(changes.deleted, ['gone.md']);
  assert.deepStrictEqual(changes.modified, []);
});

test('a dirty path the run left alone is not claimed', () => {
  const changes = attributeChanges({ 'notes.md': ' M' }, { 'notes.md': ' M' });
  assert.deepStrictEqual(changes.modified, []);
  assert.deepStrictEqual(changes.created, []);
});

test('when git cannot be read, the receipt says so instead of saying nothing changed', () => {
  // The worst version of this bug: an unobserved run rendering as "no files
  // changed" in Ion and in the Record.
  const receipt = buildRunReceipt({ ...baseInput(), changes: null });
  assert.strictEqual(receipt.changes.observed, false);
  assert.deepStrictEqual(receipt.changes.created, []);
  assert.ok(receipt.unknowns.some((u) => /which files changed/i.test(u)),
    'an unobserved tree must become an explicit unknown');
});

test('an observed run says so, so the two cases are never confused', () => {
  const receipt = buildRunReceipt(baseInput());
  assert.strictEqual(receipt.changes.observed, true);
});

test('a real rename is observed as both a new path and a gone one', () => {
  // gitStatusMap parses real porcelain, so this uses a real repository.
  const { execFileSync } = require('node:child_process');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phewsh-rename-')));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, stdio: 'ignore' });
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'r@r.test']);
  run('git', ['config', 'user.name', 'Rename']);
  fs.writeFileSync(path.join(repo, 'old.js'), 'contents\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-qm', 'first']);

  const before = gitStatusMap(repo);
  fs.renameSync(path.join(repo, 'old.js'), path.join(repo, 'new.js'));
  run('git', ['add', '-A']);
  const after = gitStatusMap(repo);

  const changes = attributeChanges(before, after);
  assert.ok(changes.deleted.includes('old.js'), 'the old path is gone and must be reported');
  assert.ok([...changes.created, ...changes.modified].includes('new.js'), 'the new path must be reported');
});

// ─── "Immutable" was a claim, not a property (independent critic, 2026-07-29) ─
// A receipt is an ordinary file in the user's home directory. Any program
// running as that user — including the harness the run just launched — can
// edit it. Phewsh cannot prevent that without a key it does not have. What it
// CAN do is notice, and say so.

test('a receipt records write-once behaviour, not a promise of immutability', () => {
  const receipt = buildRunReceipt(baseInput());
  assert.strictEqual(receipt.writeOnce, true);
  assert.strictEqual(receipt.immutable, undefined,
    'claiming immutability for a user-writable file is the overclaim itself');
  assert.ok(receipt.notCarried.some((n) => /tamper|alter|edit/i.test(n)),
    'the receipt must disclose that it can be altered on disk');
});

test('an altered receipt is detected on read rather than trusted', () => {
  const { recordRunReceipt, readRunReceipt } = require('../lib/receipts-data');
  // receipts-data resolves ~/.phewsh once at require time, so this writes into
  // the real store. A unique id per run keeps it isolated, and it is removed
  // afterwards — a stale receipt from a previous run would look "altered"
  // before this test even started.
  const id = `r-integrity${Date.now().toString(16)}`;
  let file = null;
  try {
    file = recordRunReceipt(buildRunReceipt({ ...baseInput(), receiptId: id }));
    if (!file) return; // a store this test cannot write is not what is under test

    assert.strictEqual(readRunReceipt(id).integrity, 'intact');

    // The harness edits its own evidence.
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
    tampered.changes.created = [];
    fs.writeFileSync(file, JSON.stringify(tampered, null, 2));

    assert.strictEqual(readRunReceipt(id).integrity, 'altered',
      'a receipt that no longer matches its recorded hash must be flagged, not served as evidence');
  } finally {
    if (file) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
  }
});
