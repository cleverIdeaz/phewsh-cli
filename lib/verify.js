// Verification — the smallest contract that closes phewsh's define→verify loop:
// criteria defined up front → checked against real evidence after work → an
// honest verdict (pass · partial · fail · unknown · human · proposed).
//
// This is NOT a loop runner, queue, or evaluator framework. It is a pure,
// deterministic function over a criterion + the repo state. No arbitrary
// command execution: evidence comes from the filesystem and `git diff` (run via
// execFile with a fixed argv, no shell), which are safe and reproducible.
// Richer evidence (test/build output, second-model critique) can be supplied by
// the caller later without changing this contract.
//
// A criterion:
//   {
//     expected: "what 'done' looks like, in plain words",
//     type: "measurable" | "human",
//     check?: { kind: "file"|"exists"|"contains"|"changed", path, text? },
//     // `exists` is the legacy spelling retained for portable older projects.
//     accepted?: boolean   // model-proposed criteria are false until the user accepts
//   }
//
// Verdict status:
//   pass · partial · fail · unknown · human · proposed

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STATUSES = ['pass', 'partial', 'fail', 'unknown', 'human', 'proposed'];

function gitChangedPaths(cwd) {
  try {
    // Fixed argv, no shell — cannot be injected. `git diff` covers tracked
    // staged/unstaged changes; `git ls-files` adds untracked paths so a newly
    // created deliverable can satisfy a changed-path criterion before commit.
    const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return [...new Set(`${tracked}\n${untracked}`.split('\n').map(s => s.trim()).filter(Boolean))];
  } catch {
    return null; // not a git repo / git unavailable → evidence is unknown, never faked
  }
}

/** Verdict for one criterion against the repo at `cwd`. Pure + honest. */
function verifyCriterion(c, cwd = process.cwd(), ctx = {}) {
  if (!c || !c.expected) return { status: 'unknown', note: 'no criterion' };
  if (c.accepted === false) return { status: 'proposed', note: 'proposed — not yet accepted' };
  if (c.type === 'human') return { status: 'human', note: 'needs your judgment' };

  const chk = c.check;
  if (!chk || !chk.kind) return { status: 'unknown', note: 'measurable, but no evidence/check defined' };

  const p = chk.path ? path.join(cwd, chk.path) : null;
  try {
    if (chk.kind === 'file' || chk.kind === 'exists') {
      return fs.existsSync(p)
        ? { status: 'pass', note: `${chk.path} exists` }
        : { status: 'fail', note: `${chk.path} not found` };
    }
    if (chk.kind === 'contains') {
      if (!fs.existsSync(p)) return { status: 'fail', note: `${chk.path} not found` };
      const body = fs.readFileSync(p, 'utf-8');
      return body.includes(chk.text)
        ? { status: 'pass', note: `${chk.path} contains the expected text` }
        : { status: 'partial', note: `${chk.path} exists but is missing the expected text` };
    }
    if (chk.kind === 'changed') {
      const changed = ctx.changedPaths !== undefined ? ctx.changedPaths : gitChangedPaths(cwd);
      if (changed === null) return { status: 'unknown', note: 'no git evidence available here' };
      const prefix = chk.path.endsWith('/') ? chk.path : chk.path + '/';
      return changed.some(f => f === chk.path || f.startsWith(prefix))
        ? { status: 'pass', note: `${chk.path} changed since HEAD` }
        : { status: 'fail', note: `${chk.path} not changed since HEAD` };
    }
  } catch (err) {
    return { status: 'unknown', note: 'could not evaluate evidence: ' + (err.message || 'error') };
  }
  return { status: 'unknown', note: `unknown check kind: ${chk.kind}` };
}

/** Verdicts + a roll-up summary for a list of criteria. */
function verifyAll(criteria, cwd = process.cwd(), ctx = {}) {
  const list = Array.isArray(criteria) ? criteria : [];
  // Gather git evidence once and share it (one subprocess, not one per criterion).
  const changedPaths = ctx.changedPaths !== undefined
    ? ctx.changedPaths
    : (list.some(c => c.check && c.check.kind === 'changed') ? gitChangedPaths(cwd) : undefined);
  const results = list.map(c => ({ expected: c.expected, type: c.type, ...verifyCriterion(c, cwd, { changedPaths }) }));
  const summary = { pass: 0, partial: 0, fail: 0, unknown: 0, human: 0, proposed: 0, total: results.length };
  results.forEach(r => { summary[r.status] = (summary[r.status] || 0) + 1; });
  // The honest headline: only "all clear" when every measurable criterion passed
  // (human criteria still need you); human/unknown/fail are never rewritten as done.
  summary.allMeasurablePass = results.length > 0 &&
    results.every(r => r.status === 'pass' || r.status === 'human') &&
    results.some(r => r.status === 'pass');
  summary.needsHuman = summary.human > 0 || summary.proposed > 0;
  return { results, summary };
}

/** Verify the currently started Next item. Queued work is not treated as work done. */
function verifyCurrentWork(cwd = process.cwd(), ctx = {}) {
  try {
    const next = require('./next');
    const item = next.ordered(next.load(cwd)).find(candidate => candidate.state === 'now');
    if (!item || !Array.isArray(item.criteria) || item.criteria.length === 0) return null;
    return { item: item.title, itemId: item.id, ...verifyAll(item.criteria, cwd, ctx) };
  } catch {
    return null;
  }
}

function overallStatus(summary) {
  if (!summary || summary.total === 0) return 'none';
  if (summary.fail) return 'fail';
  if (summary.partial) return 'partial';
  if (summary.unknown) return 'unknown';
  if (summary.proposed) return 'proposed';
  if (summary.human) return 'human';
  return summary.pass === summary.total ? 'pass' : 'unknown';
}

module.exports = {
  STATUSES,
  gitChangedPaths,
  overallStatus,
  verifyAll,
  verifyCriterion,
  verifyCurrentWork,
};
