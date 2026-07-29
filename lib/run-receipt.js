// The run receipt — what the engine OBSERVED, written once.
//
// Three rules give this file its shape:
//
//   1. Facts only. Every field is something the engine watched happen: which
//      route ran, when, in which registered project, which paths changed, how
//      many bytes came back. Nothing here is a model's account of itself.
//   2. Evidence is referenced, never quoted. A transcript, a file's contents,
//      or an environment variable must never end up in a receipt — integrity
//      data (byte count, sha256) does the referencing instead.
//   3. A receipt is not a verdict. It records that work happened and points at
//      what to inspect. It never says the work was correct, and it is not
//      project truth until a human accepts it (see closure.js).
//
// Immutable: once written, a receipt is never edited. A human's decision about
// it is a separate artifact, so evidence and judgement can never be confused.

const path = require('path');
const { execFileSync } = require('child_process');

const RECEIPT_SCHEMA = 'phewsh.run-receipt';
const RECEIPT_VERSION = 1;

/** Relative, POSIX-style, and never escaping the project. */
function safeRelative(p) {
  const rel = String(p || '').trim();
  if (!rel || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Which paths this run is responsible for.
 *
 * `before` and `after` are `git status --porcelain` maps (path → status) taken
 * around the run. A path that was already dirty is NOT automatically the run's
 * work — claiming it would make every receipt in a working tree look busier
 * than the run really was.
 *
 * But "already dirty" is not "untouched". An independent critic found that
 * skipping those paths entirely meant a run that FURTHER modified or deleted
 * one of them reported changing nothing. So a dirty path whose status CHANGED
 * is attributed to the run, while one that looks exactly as it did is not.
 */
function attributeChanges(before = {}, after = {}) {
  const preExisting = Object.keys(before).map(safeRelative).filter(Boolean).sort();
  const created = [];
  const modified = [];
  const deleted = [];

  for (const [raw, status] of Object.entries(after)) {
    const rel = safeRelative(raw);
    if (!rel) continue;
    const code = String(status).trim();
    const wasThere = raw in before;
    // Same path, same status → the run left it exactly as it found it.
    if (wasThere && String(before[raw]).trim() === code) continue;
    if (code.startsWith('D')) deleted.push(rel);
    else if (!wasThere && (code === '??' || code.startsWith('A'))) created.push(rel);
    else modified.push(rel);
  }

  return { preExisting, created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function changeCount(changes) {
  return changes.created.length + changes.modified.length + changes.deleted.length;
}

/**
 * Assemble a receipt. Unknown input is dropped rather than guessed: anything
 * not passed here is something the engine did not observe, and a receipt full
 * of plausible-looking blanks is worse than a short honest one.
 */
function buildRunReceipt(input) {
  // `null` means the tree could not be read. That is an UNKNOWN, and it must
  // never render as "nothing changed" — the two are opposite claims.
  const observed = input.changes != null;
  const changes = {
    observed,
    ...(input.changes || { preExisting: [], created: [], modified: [], deleted: [] }),
  };
  const touched = changeCount(changes);
  const cancelled = input.status === 'cancelled';
  const failed = input.status === 'error';
  const startedAt = input.startedAt || null;
  const endedAt = input.endedAt || null;

  const unknowns = [
    'Whether the work is correct. No check ran here.',
    'What the tool did internally — only its changed paths and output size were observed.',
  ];
  if (!observed) {
    unknowns.push('Which files changed. The working tree could not be read, so nothing is attributed to this run.');
  } else if (touched === 0 && input.status === 'done') {
    unknowns.push('Whether the tool intended to change files. Nothing in the project changed.');
  }

  return {
    schema: RECEIPT_SCHEMA,
    version: RECEIPT_VERSION,
    receiptId: input.receiptId,
    jobId: input.jobId || null,
    // The project NAME, which is how every receipt reader already groups.
    projectId: input.projectId,
    // The stable id of the one repository this run was bound to.
    boundProjectId: input.boundProjectId || null,
    runtimeId: input.runtimeId,
    runtimeLabel: input.runtimeLabel || input.runtimeId,
    startedAt,
    endedAt,
    durationMs: startedAt && endedAt ? new Date(endedAt) - new Date(startedAt) : null,
    status: input.status,
    /**
     * True when the caller named this project. False means the run simply
     * happened where the worker was started — still real, still evidence, but
     * nobody chose it.
     */
    boundByCaller: input.boundByCaller === true,
    cancelled,
    // Half-done: it stopped or failed, but the project is not as it was.
    partial: (cancelled || failed) && touched > 0,
    // The authority a human reviewed before this ran, kept verbatim so the
    // receipt can be checked against what was actually approved.
    contract: input.contract || null,
    changes,
    checks: {
      run: false,
      reason: 'Checks did not run. The engine dispatched a tool; it did not test the result.',
    },
    cost: {
      known: false,
      reason: 'Unknown — the engine observes which account authorizes a tool, never a price.',
      account: input.contract?.actorAccount || null,
    },
    // Referenced, never quoted.
    output: input.output?.sha256
      ? { bytes: Number(input.output.bytes) || 0, sha256: input.output.sha256 }
      : { bytes: 0, sha256: null },
    evidence: {
      receiptFile: `receipts/${input.receiptId}.json`,
      sessionEvents: `sessions/${input.projectId}_sessions.json`,
      note: 'Inspect the changed paths with git in the project itself.',
    },
    verificationCeiling:
      'Not verified. This records that a run happened and what changed; it does not check the work.',
    unknowns,
    carried: [
      'The changed paths, the route that ran, and when.',
      'The authority contract as it was reviewed.',
      'The receipt id, so this run can be found again.',
    ],
    notCarried: [
      'The transcript and the model’s reasoning.',
      'File contents and any secret in the environment.',
      'Any judgement about whether the work is correct.',
      'Protection from being altered. This is an ordinary file on your disk; '
        + 'Phewsh never rewrites it and checks its hash on read, but a program '
        + 'running as you could edit it.',
    ],
    // Phewsh writes this once and never edits it. That is a behaviour it can
    // guarantee. Immutability is not — see notCarried.
    writeOnce: true,
  };
}

/**
 * The project's working tree as git sees it — the observation the receipt's
 * changed paths are derived from. Taken once before the run and once after, so
 * a tree that was already dirty is never billed to the run.
 *
 * Returns null when git cannot answer, which is an honest unknown rather than
 * "nothing changed".
 */
function gitStatusMap(dir) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    });
    const map = {};
    const unquote = (v) => v.trim().replace(/^"|"$/g, '');
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      const rest = line.slice(3);
      if (rest.includes(' -> ')) {
        // A rename is two facts: a path that now exists and one that no longer
        // does. Keeping only the new path understates the change.
        const [from, to] = rest.split(' -> ');
        const oldPath = unquote(from);
        const newPath = unquote(to);
        if (newPath) map[newPath] = status;
        if (oldPath) map[oldPath] = ' D';
        continue;
      }
      const file = unquote(rest);
      if (file) map[file] = status;
    }
    return map;
  } catch {
    return null;
  }
}

module.exports = {
  RECEIPT_SCHEMA, RECEIPT_VERSION, buildRunReceipt, attributeChanges, changeCount, gitStatusMap,
};
