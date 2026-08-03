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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
 *
 * That closed half the hole. A porcelain status is two characters of state, so
 * the ordinary case still slipped past: a file already ` M` before the run and
 * edited again during it is still ` M` afterwards. Same code, so the receipt
 * said nothing changed while the harness had rewritten the file — the receipt
 * understating real work on a path a person is about to accept into the Record.
 *
 * So a snapshot carries a CONTENT fingerprint too, and content is what decides
 * when the status is unchanged. Where a fingerprint is missing on either side
 * the comparison is unknown, and an unknown must not become either claim.
 */
function snapshotEntry(value) {
  if (value && typeof value === 'object') {
    return {
      status: String(value.status ?? '').trim(),
      fingerprint: value.fingerprint ?? null,
    };
  }
  // Older callers and the shared fixtures pass `path → status` strings, which
  // carry no content at all.
  return { status: String(value ?? '').trim(), fingerprint: null };
}

function attributeChanges(before = {}, after = {}, dir = null) {
  const preExisting = Object.keys(before).map(safeRelative).filter(Boolean).sort();
  const created = [];
  const modified = [];
  const deleted = [];

  for (const [raw, value] of Object.entries(after)) {
    const rel = safeRelative(raw);
    if (!rel) continue;
    const now = snapshotEntry(value);
    const wasThere = raw in before;
    const then = wasThere ? snapshotEntry(before[raw]) : null;

    if (then && then.status === now.status) {
      // Same path, same status. Only content can tell "the run rewrote this"
      // from "the run left it exactly as it found it".
      const comparable = then.fingerprint != null && now.fingerprint != null;
      if (!comparable || then.fingerprint === now.fingerprint) continue;
      modified.push(rel);
      continue;
    }
    if (now.status.startsWith('D')) deleted.push(rel);
    else if (!wasThere && (now.status === '??' || now.status.startsWith('A'))) created.push(rel);
    else modified.push(rel);
  }

  // A path that was dirty BEFORE and is absent AFTER left the dirty set, which
  // means the run resolved it. Iterating `after` alone missed every one of these,
  // and they are the ordinary outcomes of an agent working in a repository:
  // `git commit`, `git checkout --`, `git reset --hard`, `git stash`, `git clean`.
  // A run that wrote fifty files and committed them reported changing nothing —
  // an affirmative "no files changed" that closure then wrote into the Record.
  for (const raw of Object.keys(before)) {
    if (raw in after) continue;
    const rel = safeRelative(raw);
    if (!rel) continue;
    // Gone from disk is a deletion; still present means its uncommitted state was
    // resolved — committed or thrown away — and either way the run changed it.
    // Without a directory to check, `modified` is the safer of two honest
    // answers: it may name the wrong category, but it never claims nothing moved.
    if (dir && !fs.existsSync(path.join(dir, rel))) deleted.push(rel);
    else modified.push(rel);
  }

  return { preExisting, created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

/**
 * The one place a tree observation becomes receipt input.
 *
 * Returns null — an explicit UNKNOWN — unless both snapshots were readable. The
 * finalizer used to substitute empty arrays here, described as "no attributed
 * changes", and empty arrays are a claim: the receipt renders "no files changed"
 * in Ion and in the Record. "The engine never looked" and "the engine looked and
 * saw nothing" are opposite statements, and only one of them was true.
 *
 * Two readable snapshots that happen to match ARE an observation, so a genuine
 * no-op run is still reported as observed.
 */
function observedChanges(before, after, dir = null) {
  if (!before || !after) return null;
  return attributeChanges(before, after, dir);
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
    // The other half of local execution identity. The public handle is path
    // derived for compatibility, so the normalized registered remote prevents
    // evidence from crossing when a different repo later occupies that path.
    boundProjectRemote: input.boundProjectRemote || null,
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
    // Referenced, never quoted. `truncated` matters because the node caps what a
    // harness may put in memory: without it, a shortened capture's hash and byte
    // count would present part of the output as the whole of it.
    output: input.output?.sha256
      ? {
        bytes: Number(input.output.bytes) || 0,
        sha256: input.output.sha256,
        truncated: input.output.truncated === true,
      }
      : { bytes: 0, sha256: null, truncated: input.output?.truncated === true },
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
 * A dirty path's content, so "the run edited this again" is distinguishable from
 * "the run left it alone" when the porcelain status cannot tell them apart.
 *
 * Content, not mtime: a harness that rewrites a file with identical bytes has
 * left the tree as it found it, and a timestamp would call that a change.
 *
 * Enormous files fall back to size and mtime rather than being read into memory
 * — a weaker witness, but bounded, and the receipt never quotes either. Anything
 * unreadable, absent, or not a file returns null, which reads as unknown and is
 * never treated as evidence of a change.
 */
const MAX_FINGERPRINT_BYTES = 8 * 1024 * 1024;

function fingerprintOf(dir, rel) {
  try {
    const full = path.join(dir, rel);
    const stat = fs.statSync(full);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FINGERPRINT_BYTES) return `size:${stat.size}:mtime:${stat.mtimeMs}`;
    return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The project's working tree as git sees it — the observation the receipt's
 * changed paths are derived from. Taken once before the run and once after, so
 * a tree that was already dirty is never billed to the run.
 *
 * Each entry is `{ status, fingerprint }`: the status alone could not tell a
 * second edit of an already-dirty file from no edit at all.
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
        if (newPath) map[newPath] = { status, fingerprint: fingerprintOf(dir, newPath) };
        if (oldPath) map[oldPath] = { status: ' D', fingerprint: null };
        continue;
      }
      const file = unquote(rest);
      if (file) map[file] = { status, fingerprint: fingerprintOf(dir, file) };
    }
    return map;
  } catch {
    return null;
  }
}

module.exports = {
  RECEIPT_SCHEMA, RECEIPT_VERSION, buildRunReceipt, attributeChanges, observedChanges,
  changeCount, gitStatusMap,
};
