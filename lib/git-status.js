// Read-only Git checkout inspection for the capability/status contract.
//
// The CLI owns Git inspection; Desktop and Ion only render what this reports. This
// module is STRICTLY read-only — it runs `rev-parse`, `status`, and `remote get-url`
// and never commits, pushes, pulls, fetches, merges, rebases, resets, or checks out.
// It answers: which branch, which commit, dirty or clean, ahead/behind/diverged from
// upstream, mid-merge/rebase/conflict — the alignment facts Phewsh coordinates on
// without becoming a Git client or declaring anyone's local state canonical.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { normalizeRemote } = require('./team-tasks');

// Parse `git status --porcelain=v2 --branch` output. Pure: no I/O, so it is the
// unit-tested core. See git-scm porcelain v2 format.
function parseStatusV2(text) {
  const out = {
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    diverged: false,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 },
  };
  let oid = null;
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim();
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') out.detached = true;
      else out.branch = head;
    } else if (line.startsWith('# branch.upstream ')) {
      out.upstream = line.slice('# branch.upstream '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.slice('# branch.ab '.length).trim().match(/^\+(\d+)\s+-(\d+)$/);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line[0] === '1' || line[0] === '2') {
      // Ordinary/renamed tracked change: field 2 is the XY status (index, worktree).
      const xy = line.split(' ')[1] || '..';
      if (xy[0] && xy[0] !== '.') out.counts.staged++;
      if (xy[1] && xy[1] !== '.') out.counts.unstaged++;
    } else if (line[0] === 'u') {
      out.counts.conflicts++;
    } else if (line[0] === '?') {
      out.counts.untracked++;
    }
    // '!' (ignored) is intentionally skipped.
  }
  if (oid && oid !== '(initial)') out.head = { short: oid.slice(0, 7), full: oid };
  out.diverged = out.ahead > 0 && out.behind > 0;
  return out;
}

function defaultRun(cwd) {
  return (args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
  }).toString();
}

function gitDir(run, cwd) {
  try {
    const dir = run(['rev-parse', '--git-dir']).trim();
    return path.isAbsolute(dir) ? dir : path.join(cwd, dir);
  } catch { return null; }
}

// merge/rebase in progress, best-effort (filesystem markers in the git dir).
function detectInProgress(run, cwd, opts) {
  if (opts.inProgress !== undefined) return opts.inProgress;
  const dir = gitDir(run, cwd);
  if (!dir) return null;
  try {
    if (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply'))) return 'rebase';
    if (fs.existsSync(path.join(dir, 'MERGE_HEAD'))) return 'merge';
  } catch { /* ignore */ }
  return null;
}

function fetchHeadTime(run, cwd, opts) {
  if (opts.lastFetch !== undefined) return opts.lastFetch;
  const dir = gitDir(run, cwd);
  if (!dir) return null;
  try { return fs.statSync(path.join(dir, 'FETCH_HEAD')).mtime.toISOString(); }
  catch { return null; }
}

// Inspect the checkout at `cwd`. Inject `run` (git command runner) for tests.
function inspectCheckout(cwd, opts = {}) {
  const run = opts.run || defaultRun(cwd);

  let isRepo = false;
  try { isRepo = run(['rev-parse', '--is-inside-work-tree']).trim() === 'true'; }
  catch { isRepo = false; }
  if (!isRepo) return { isRepo: false };

  let parsed;
  try { parsed = parseStatusV2(run(['status', '--porcelain=v2', '--branch'])); }
  catch { return { isRepo: true, error: 'git status unavailable' }; }

  let remote = null;
  try { remote = normalizeRemote(run(['remote', 'get-url', 'origin']).trim()); }
  catch { /* no origin */ }

  const dirty = parsed.counts.staged > 0
    || parsed.counts.unstaged > 0
    || parsed.counts.untracked > 0
    || parsed.counts.conflicts > 0;

  const inProgress = parsed.counts.conflicts > 0 ? 'conflict' : detectInProgress(run, cwd, opts);

  return {
    isRepo: true,
    branch: parsed.branch,
    detached: parsed.detached,
    head: parsed.head,
    dirty,
    counts: parsed.counts,
    upstream: parsed.upstream,
    // ahead/behind are only meaningful relative to a tracked upstream.
    ahead: parsed.upstream ? parsed.ahead : null,
    behind: parsed.upstream ? parsed.behind : null,
    diverged: parsed.diverged,
    inProgress, // 'merge' | 'rebase' | 'conflict' | null
    remote, // privacy-safe host/owner/repo display, or null
    lastFetch: fetchHeadTime(run, cwd, opts), // ISO string or null (label as "last fetch")
  };
}

module.exports = { parseStatusV2, inspectCheckout };
