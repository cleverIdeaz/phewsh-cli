// Human closure — the only path from a receipt into project truth.
//
// A receipt says what happened. It is evidence, and it is never project truth.
// Turning it into truth is a person's act, and this file is the whole of that
// act:
//
//   preview → the exact lines that would be written, and a hash of what they
//             were computed against
//   decide  → accept (write exactly that) or reject (write nothing)
//
// Four rules the tests hold:
//
//   - Reject leaves .intent/ byte-identical. Not "logically unchanged" —
//     identical.
//   - Accept applies only what was previewed, and fails closed if the files
//     moved underneath it. A human approved a specific diff against a specific
//     state; if that state is gone, so is the approval.
//   - Accept is idempotent. A lost response retried must not append a second
//     copy of the same decision.
//   - "A human accepted this" never becomes "the checks passed". The Record
//     entry carries the same verification ceiling the receipt did.
//
// Owner layer: CLI. Ion previews and gestures; only this writes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ClosureError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const RECORD_FILE = 'decisions.md';
const NEXT_FILE = 'next.json';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fileHash(file) {
  try { return sha256(fs.readFileSync(file)); } catch { return null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** The current `now` item, which is the only one a run can close. */
function currentNextItem(intentDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(intentDir, NEXT_FILE), 'utf8'));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.find((i) => i?.state === 'now') || null;
  } catch {
    return null;
  }
}

/**
 * The Record line. Built from the human's note plus receipt FACTS — never from
 * the tool's own account of what it did, and never stronger than the receipt.
 */
function recordLine(receipt, note) {
  const changed = receipt.changes.created.length + receipt.changes.modified.length + receipt.changes.deleted.length;
  const paths = changed === 0
    ? 'no files changed'
    : `${changed} path${changed === 1 ? '' : 's'} changed (${[
      ...receipt.changes.created.map((p) => `+${p}`),
      ...receipt.changes.modified.map((p) => `~${p}`),
      ...receipt.changes.deleted.map((p) => `-${p}`),
    ].slice(0, 8).join(', ')})`;

  return `- ${today()} — ${flatten(note)} Ran ${receipt.runtimeLabel} in ${receipt.projectId}; `
    + `${receipt.status}${receipt.partial ? ' (partial)' : ''}, ${paths}. `
    + 'Checks did not run, so this is not verified. '
    + `Receipt ${receipt.receiptId}.`;
}

/**
 * A person's note becomes ONE line of the Record, and only one.
 *
 * An independent critic proved the forgery this closes: `decisions.md` is a
 * list of `- YYYY-MM-DD — …` lines, so a note containing a newline wrote extra
 * entries. A three-line note put a fabricated middle entry — "Full security
 * audit PASSED; all checks green; verified by Neal." — into the Record as its
 * own decision, with the engine's honest suffix landing harmlessly on a
 * different line. The engine's own rule is that "a human accepted this" must
 * never become "the checks passed"; this is where that was breakable.
 *
 * Newlines collapse to spaces rather than being rejected, so pasting wrapped
 * text still works — it simply cannot become more than one entry.
 */
const MAX_NOTE_CHARS = 2000;

function flatten(note) {
  const oneLine = String(note ?? '')
    // Every line terminator, including the two Unicode ones a paste can
    // carry and that JSON survives: U+2028 and U+2029.
    .replace(/[\r\n\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return oneLine.length > MAX_NOTE_CHARS ? `${oneLine.slice(0, MAX_NOTE_CHARS)}…` : oneLine;
}

/**
 * What accepting would do, exactly, plus the state it was computed against.
 *
 * The baseline is the point of the whole thing: it turns "I approve this" into
 * "I approve this against these files as they are right now".
 */
function buildClosureProposal({ receipt, note, intentDir, markNextDone = false }) {
  const text = String(note || '').trim();
  if (!text) throw new ClosureError('A note is required — a Record entry with nothing said is not a record.');
  if (!receipt?.receiptId) throw new ClosureError('A receipt is required.');

  const append = recordLine(receipt, text);
  const item = markNextDone ? currentNextItem(intentDir) : null;
  if (markNextDone && !item) {
    throw new ClosureError('There is no current Next item to close.', 409);
  }

  const baseline = {
    [`.intent/${RECORD_FILE}`]: fileHash(path.join(intentDir, RECORD_FILE)),
    [`.intent/${NEXT_FILE}`]: fileHash(path.join(intentDir, NEXT_FILE)),
  };

  return {
    // Derived, not random: the same review of the same state is the same
    // proposal, which is what makes a retry recognisable.
    proposalId: sha256(`${receipt.receiptId}\n${append}\n${item ? item.id : ''}\n${JSON.stringify(baseline)}`).slice(0, 16),
    receiptId: receipt.receiptId,
    projectId: receipt.projectId,
    boundProjectId: receipt.boundProjectId,
    record: { file: `.intent/${RECORD_FILE}`, append },
    next: {
      file: `.intent/${NEXT_FILE}`,
      change: item ? { id: item.id, title: item.title || null, from: item.state, to: 'done' } : null,
    },
    baseline,
    verificationCeiling: receipt.verificationCeiling,
  };
}

/** Write through a temp file so a crash can never leave truth half-written. */
function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

/**
 * Is this next.json exactly the reviewed baseline plus THIS closure's own
 * state change, and nothing else?
 *
 * Undo the change in memory, re-serialize the way applyClosure writes it, and
 * compare against the hash the person actually reviewed. Anything a different
 * writer touched — another item, a reordering, a formatting change — fails to
 * reproduce that hash, so it is still treated as staleness.
 */
function nextMatchesBaselineOnceUndone({ filePath, change, expected }) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const item = (parsed.items || []).find((i) => i?.id === change.id);
    // Only a file already at the target state can be our own half-written work.
    if (!item || item.state !== change.to) return false;
    item.state = change.from;
    const undone = `${JSON.stringify(parsed, null, 2)}\n`;
    return crypto.createHash('sha256').update(undone).digest('hex') === expected;
  } catch {
    return false;
  }
}

/**
 * Apply — or deliberately do not apply — a reviewed proposal.
 *
 * Rejection is a real outcome, not an absence: it is returned and recorded,
 * and it leaves the files untouched.
 */
function applyClosure({ proposal, decision, intentDir }) {
  if (!proposal?.proposalId) throw new ClosureError('A reviewed proposal is required.');
  if (decision !== 'accept' && decision !== 'reject') {
    throw new ClosureError('A closure decision must be accept or reject.');
  }

  const recordPath = path.join(intentDir, RECORD_FILE);
  const nextPath = path.join(intentDir, NEXT_FILE);

  if (decision === 'reject') {
    return {
      decision: 'reject', applied: false, alreadyApplied: false,
      receiptId: proposal.receiptId, proposalId: proposal.proposalId,
    };
  }

  const current = fs.existsSync(recordPath) ? fs.readFileSync(recordPath, 'utf8') : '';

  // Idempotency BEFORE staleness: a retry of an applied acceptance has, by
  // definition, a stale baseline — its own write moved the file. Treating that
  // as a conflict would make every lost response look like a race.
  if (current.includes(proposal.record.append)) {
    return {
      decision: 'accept', applied: true, alreadyApplied: true,
      receiptId: proposal.receiptId, proposalId: proposal.proposalId,
      record: proposal.record.file,
    };
  }

  // A closure that crashed between its two writes must be RESUMABLE.
  //
  // Ordering alone was not enough. If Next was written and the Record write
  // then failed, a retry found: no Record line (so not "already applied"), and
  // a next.json whose hash no longer matched the baseline. It therefore raised
  // a staleness conflict — leaving Next moved, the Record empty, and the person
  // with no way forward. Partial truth, permanently.
  //
  // So before treating drift as staleness, ask whether the ONLY difference is
  // this closure's own half-finished work: put the item back to `from`,
  // re-serialize exactly as we would have written it, and see if that
  // reproduces the reviewed baseline. If it does, nobody else touched the file
  // and the remaining step is simply the Record.
  let resumingAfterNext = false;
  for (const [rel, expected] of Object.entries(proposal.baseline)) {
    const filePath = path.join(intentDir, path.basename(rel));
    const actual = fileHash(filePath);
    if (actual === expected) continue;

    if (path.basename(rel) === NEXT_FILE && proposal.next.change && !resumingAfterNext) {
      if (nextMatchesBaselineOnceUndone({ filePath, change: proposal.next.change, expected })) {
        resumingAfterNext = true;
        continue;
      }
    }

    throw new ClosureError(
      `${rel} changed since you reviewed this. Nothing was written — review it again.`, 409,
    );
  }

  // Next FIRST, Record LAST.
  //
  // The Record line is the idempotency key — a retry recognises an applied
  // closure by finding that line — so it has to be the final act. Writing it
  // first (as this did originally) meant an I/O failure on the Next half left
  // the Record changed; the retry then saw its own line, reported "already
  // applied", and skipped Next forever.
  //
  // The baseline hashes above already refuse every case where either file's
  // CONTENT drifted. This ordering closes the narrower window where the write
  // itself fails.
  let nextApplied = null;
  if (proposal.next.change) {
    if (resumingAfterNext) {
      // Already written by the attempt that crashed. Re-writing it would be
      // harmless but dishonest about what this call did.
      nextApplied = proposal.next.change;
    } else {
      const parsed = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
      const item = (parsed.items || []).find((i) => i?.id === proposal.next.change.id);
      if (!item) throw new ClosureError('The Next item in this proposal no longer exists.', 409);
      if (item.state !== proposal.next.change.from) {
        throw new ClosureError('The Next item moved since you reviewed this.', 409);
      }
      item.state = proposal.next.change.to;
      writeAtomic(nextPath, `${JSON.stringify(parsed, null, 2)}\n`);
      nextApplied = proposal.next.change;
    }
  }

  writeAtomic(recordPath, `${current.replace(/\s*$/, '')}\n${proposal.record.append}\n`);

  return {
    decision: 'accept', applied: true, alreadyApplied: false,
    receiptId: proposal.receiptId, proposalId: proposal.proposalId,
    record: proposal.record.file, next: nextApplied,
  };
}

module.exports = { ClosureError, buildClosureProposal, applyClosure, recordLine, writeAtomic };
