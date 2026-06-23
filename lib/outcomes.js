// Outcome-labeled decision history — the dataset PHEWSH accumulates that
// platform chat logs don't: not just "I did X" but "X was kept / reverted /
// superseded / failed."
//
// Every routed action in a phewsh session records a decision (pending).
// The user labels it when the outcome is actually known — seconds later or
// three weeks later. `phewsh outcomes` shows what accumulates.
//
// Storage: ~/.phewsh/outcomes/decisions.json (append-only, never capped —
// this file IS the asset).

const fs = require('fs');
const path = require('path');
const os = require('os');

const OUTCOMES_DIR = path.join(os.homedir(), '.phewsh', 'outcomes');
const DECISIONS_FILE = path.join(OUTCOMES_DIR, 'decisions.json');

const OUTCOMES = ['kept', 'reverted', 'superseded', 'failed'];

function load() {
  // Array-or-nothing: a corrupt/odd-shaped file must degrade, never throw
  try {
    const d = JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function save(decisions) {
  try {
    fs.mkdirSync(OUTCOMES_DIR, { recursive: true });
    fs.writeFileSync(DECISIONS_FILE, JSON.stringify(decisions, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Record a routed action as a pending decision. Returns the decision id. */
function recordDecision({ project, route, mode, summary }) {
  const decisions = load();
  // Short enough to display whole and retype: 5 timestamp chars + 3 random
  const id = 'd' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
  decisions.push({
    id,
    ts: new Date().toISOString(),
    project: project || path.basename(process.cwd()),
    route: route || 'unknown',
    mode: mode || null,
    summary: (summary || '').slice(0, 200),
    outcome: null,
    labeledAt: null,
  });
  save(decisions);
  return id;
}

/**
 * Label a decision by id (or unambiguous id prefix). Returns the decision or null.
 * @param {string} idOrPrefix
 * @param {string} outcome  one of OUTCOMES
 * @param {string|null} why one-line reason (gold for reverted/failed)
 * @param {object} [opts]
 * @param {boolean} [opts.auto]  the SYSTEM set this (e.g. a route errored), not
 *   the user's judgment. Kept separate so auto-failures never masquerade as
 *   "you tried it and reverted it" — that distinction is what made the old
 *   `/outcomes` read like phewsh was broken.
 */
function labelOutcome(idOrPrefix, outcome, why = null, opts = {}) {
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`Outcome must be one of: ${OUTCOMES.join(', ')}`);
  }
  const decisions = load();
  const matches = decisions.filter(d => d.id === idOrPrefix || d.id.startsWith(idOrPrefix));
  if (matches.length !== 1) return null;
  matches[0].outcome = outcome;
  matches[0].labeledAt = new Date().toISOString();
  if (opts.auto) matches[0].auto = true;
  else delete matches[0].auto; // a human judgment overrides a prior auto-label
  // One-line reason — the most valuable thing about a reverted/failed call.
  // Feeds /recall ("you reverted this before — because …") and /learn.
  if (why && String(why).trim()) matches[0].why = String(why).trim().slice(0, 200);
  return save(decisions) ? matches[0] : null;
}

// A routed line that isn't really a decision worth judging — greetings, one
// word fillers, or a command echo. Used to keep the "judge these" ask (and the
// nudge to label) focused on real work, not "hi". Conservative on purpose: only
// obvious noise, so genuine short prompts ("fix the bug") still count.
const TRIVIAL_RE = /^(hi|hey|hello|yo|sup|ok|okay|k|thanks|thx|ty|test|testing|cool|nice|great|good|yes|no|y|n|hi there)\b[!.\s]*$/i;
function looksTrivial(summary) {
  const s = (summary || '').trim();
  if (s.length < 3) return true;
  if (TRIVIAL_RE.test(s)) return true;
  if (/^(phewsh|\/)/.test(s) && s.split(/\s+/).length <= 3) return true; // command echo
  return false;
}

/** Unlabeled decisions, oldest first. `substantive` drops greetings/filler. */
function pendingDecisions({ project = null, substantive = false } = {}) {
  return load()
    .filter(d => !d.outcome && (!project || d.project === project))
    .filter(d => !substantive || !looksTrivial(d.summary))
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Most recent decisions (labeled or not), newest first. */
function recentDecisions(limit = 10, { project = null } = {}) {
  return load()
    .filter(d => !project || d.project === project)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}

/** Read-only evidence for /truth and /brief. Never migrates or writes. */
function outcomeEvidence({ project = null, limit = 5 } = {}) {
  const all = load().filter(d => !project || d.project === project);
  const labeled = all.filter(d => d.outcome);
  const judged = labeled.filter(d => !isAutoLabel(d));
  return {
    total: all.length,
    pending: all.length - labeled.length,
    judged: judged.length,
    autoFailed: labeled.filter(isAutoLabel).length,
    kept: judged.filter(d => d.outcome === 'kept').length,
    recent: [...all].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, limit),
  };
}

const MIGRATE_MARKER = path.join(OUTCOMES_DIR, '.auto-migrated-v1');

/**
 * One-time cleanup of records created before the `auto` flag existed. The only
 * code path that ever wrote 'failed' with no reason was the turn runner
 * reacting to a route error — a genuine human "this failed" verdict is always
 * offered a one-line why. So legacy failed-without-why = a route error; tag it
 * so it stops masquerading as the user's judgment. Idempotent (marker-guarded).
 */
function migrateLegacyAutoFailures() {
  try {
    if (fs.existsSync(MIGRATE_MARKER)) return;
    const decisions = load();
    let changed = false;
    for (const d of decisions) {
      if (d.outcome === 'failed' && !d.auto && !d.why) { d.auto = true; changed = true; }
    }
    if (changed) save(decisions);
    fs.mkdirSync(OUTCOMES_DIR, { recursive: true });
    fs.writeFileSync(MIGRATE_MARKER, new Date().toISOString());
  } catch { /* migration is best-effort — never block the record */ }
}

/** Was this outcome set by the SYSTEM (a route errored) rather than the human? */
function isAutoLabel(d) {
  return d.auto === true;
}

/**
 * The Day-14 view: totals, per-route reliability, per-mode patterns.
 * Only labeled decisions count toward outcome rates — pending is honest noise.
 */
function outcomeStats({ project = null } = {}) {
  migrateLegacyAutoFailures();
  const all = load().filter(d => !project || d.project === project);
  const labeled = all.filter(d => d.outcome);
  // A route that errored is auto-labeled 'failed' — that's a system event, not
  // the user judging the work. Split it out so the headline reflects the user's
  // actual calls (kept/reverted/superseded + failures they themselves marked).
  const judged = labeled.filter(d => !isAutoLabel(d));
  const autoFailed = labeled.filter(isAutoLabel).length;

  const stats = {
    total: all.length,
    pending: all.length - labeled.length,
    judged: judged.length,        // decisions the human actually labeled
    autoFailed,                   // route errors phewsh recorded for you
    kept: 0, reverted: 0, superseded: 0, failed: 0,
    byRoute: {},
    byMode: {},
  };

  // Outcome rates count the human's judgments only — auto route-errors don't
  // tank a tool's kept-rate (they're tracked separately in byRoute.errored).
  for (const d of judged) {
    stats[d.outcome]++;
    const r = (stats.byRoute[d.route] ||= { total: 0, kept: 0, reverted: 0, superseded: 0, failed: 0, errored: 0 });
    r.total++; r[d.outcome]++;
    if (d.mode) {
      const m = (stats.byMode[d.mode] ||= { total: 0, kept: 0, reverted: 0, superseded: 0, failed: 0, errored: 0 });
      m.total++; m[d.outcome]++;
    }
  }
  for (const d of labeled.filter(isAutoLabel)) {
    const r = (stats.byRoute[d.route] ||= { total: 0, kept: 0, reverted: 0, superseded: 0, failed: 0, errored: 0 });
    r.errored = (r.errored || 0) + 1;
  }

  return stats;
}

// ── Bypasses — the failure dataset ─────────────────────────────────────────
// Every time the user opens Claude Code (or anything) directly instead of
// phewsh, the reason why is the most valuable thing they can record. It
// directly identifies why the front door fails.

const BYPASSES_FILE = path.join(OUTCOMES_DIR, 'bypasses.json');

const BYPASS_REASONS = [
  'forgot',
  'faster',
  'needed-editing',
  'needed-context',
  'model-quality',
  'phewsh-in-the-way',
  'other',
];

function loadBypasses() {
  try {
    const d = JSON.parse(fs.readFileSync(BYPASSES_FILE, 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function recordBypass(reason, note = '') {
  if (!BYPASS_REASONS.includes(reason)) {
    throw new Error(`Reason must be one of: ${BYPASS_REASONS.join(', ')}`);
  }
  const bypasses = loadBypasses();
  bypasses.push({
    ts: new Date().toISOString(),
    project: path.basename(process.cwd()),
    reason,
    note: note.slice(0, 200),
  });
  try {
    fs.mkdirSync(OUTCOMES_DIR, { recursive: true });
    fs.writeFileSync(BYPASSES_FILE, JSON.stringify(bypasses, null, 2));
    return bypasses.length;
  } catch {
    return null;
  }
}

function bypassStats() {
  const bypasses = loadBypasses();
  const byReason = {};
  for (const b of bypasses) byReason[b.reason] = (byReason[b.reason] || 0) + 1;
  return {
    total: bypasses.length,
    byReason,
    recent: bypasses.slice(-8).reverse(),
  };
}

module.exports = {
  OUTCOMES, DECISIONS_FILE, BYPASS_REASONS, BYPASSES_FILE,
  recordDecision, labelOutcome, pendingDecisions, recentDecisions, outcomeStats,
  isAutoLabel, looksTrivial, outcomeEvidence, recordBypass, bypassStats,
};
