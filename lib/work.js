// "Work" — the read-only view for the fourth plain word
// (Project · Next · Work · Record). This is a DERIVED aggregator, not a new
// store: it reads state that already exists and answers, in one glance, "what's
// happening right now?" No automation, no loop runner, no persistence. Work is
// made *visible* here; bounding and running it is a later, separate phase
// (see .intent/work-layer.md — the design fence).

const fs = require('fs');
const path = require('path');
const os = require('os');

function projectSummary(cwd) {
  const intentDir = path.join(cwd, '.intent');
  const present = fs.existsSync(intentDir);
  let name = path.basename(cwd);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(intentDir, 'project.json'), 'utf-8'));
    if (m && m.name) name = m.name;
  } catch { /* fall back to dir name */ }
  let tagline = null;
  try {
    const v = fs.readFileSync(path.join(intentDir, 'vision.md'), 'utf-8');
    const m = v.match(/##\s*North Star\s*\n+([^\n]+)/);
    if (m) tagline = m[1].trim().replace(/\.+$/, '').slice(0, 120);
  } catch { /* no tagline */ }
  return { present, name, tagline };
}

function nextSummary(cwd) {
  try {
    const nx = require('./next');
    const items = nx.ordered(nx.load(cwd));
    const now = items.find(i => i.state === 'now') || null;
    const queued = items.filter(i => i.state === 'next');
    return { now: now ? now.title : null, queuedCount: queued.length, topQueued: queued[0] ? queued[0].title : null };
  } catch { return { now: null, queuedCount: 0, topQueued: null }; }
}

function loadDecisions() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.phewsh', 'outcomes', 'decisions.json'), 'utf-8'));
  } catch { return []; }
}

function workSummary(cwd) {
  // No reliable standalone "current tool" detection exists, so derive from the
  // continuity thread: who acted last for this project, and how recently.
  // "active" = recent enough to look like a live session.
  try {
    const continuity = require('./continuity');
    const project = path.basename(cwd);
    const last = continuity.lastLeftOff(loadDecisions(), { project });
    if (!last || !last.ts) return { tool: null, active: false, lastAgo: null };
    let tool = null;
    try { tool = continuity.labelFor(last.route); } catch { tool = last.route || null; }
    const ageMs = Date.now() - new Date(last.ts).getTime();
    const active = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 15 * 60 * 1000;
    return { tool, active, lastAgo: continuity.agoText(last.ts) };
  } catch { return { tool: null, active: false, lastAgo: null }; }
}

function recordSummary(cwd) {
  // Prefer a human-remembered decision; fall back to the latest routed decision.
  try {
    const ns = require('./record').notes(cwd);
    if (ns.length) {
      const latest = ns[ns.length - 1].replace(/^- \d{4}-\d{2}-\d{2} — /, '');
      return { latest, source: 'remembered' };
    }
  } catch { /* none */ }
  try {
    const { recentDecisions } = require('./outcomes');
    const r = recentDecisions(1, { project: path.basename(cwd) });
    if (r.length && r[0].summary) return { latest: r[0].summary, source: 'decision' };
  } catch { /* none */ }
  return { latest: null, source: null };
}

function reviewSummary(cwd) {
  // "Does anything appear to need a human?" — derived from existing signals only.
  const needs = [];
  try {
    const { outcomeStats } = require('./outcomes');
    const s = outcomeStats({ project: path.basename(cwd) });
    if (s.pending > 0) needs.push(`${s.pending} decision${s.pending === 1 ? '' : 's'} to label — phewsh outcomes`);
  } catch { /* none */ }
  try {
    const drift = require('./selfheal').commitsSinceIntent(cwd);
    if (drift > 0) needs.push(`intent is ${drift} commit${drift === 1 ? '' : 's'} behind the code — reconcile`);
  } catch { /* none */ }
  return { needs, clear: needs.length === 0 };
}

// Verification verdicts for the STARTED (now) item's criteria — the define→verify
// loop, surfaced read-only. Null when nothing is started or has no criteria.
function verificationSummary(cwd) {
  try { return require('./verify').verifyCurrentWork(cwd); }
  catch { return null; }
}

/** The whole read-only view. Pure aggregation over existing state. */
function workView(cwd = process.cwd()) {
  return {
    project: projectSummary(cwd),
    next: nextSummary(cwd),
    work: workSummary(cwd),
    record: recordSummary(cwd),
    verification: verificationSummary(cwd),
    review: reviewSummary(cwd),
  };
}

module.exports = { workView };
