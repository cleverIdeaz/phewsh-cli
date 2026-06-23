// Continuity — make "nothing lost across tools" visible.
//
// Every routed action phewsh records is tagged with the tool that ran it
// (claude-code, codex, gemini…). Read newest-first, that list IS a thread of
// your work across every tool. This module turns it into something a human
// (front door, /thread) or a standalone harness (ambient brief) can feel:
// "last you were doing X, via Codex, 3h ago — keep going."
//
// Pure + deterministic: feed it the decision records, get back strings.

const ROUTE_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
  kiro: 'Kiro',
  copilot: 'Copilot',
  hermes: 'Hermes',
  pi: 'Pi',
  aider: 'Aider',
  goose: 'Goose',
  amp: 'Amp',
  droid: 'Droid',
  api: 'direct API',
  council: 'council',
};

function labelFor(route, labeler) {
  if (labeler) { const l = labeler(route); if (l) return l; }
  return ROUTE_LABELS[route] || route || 'a tool';
}

function agoText(ts, now = Date.now()) {
  const then = new Date(ts).getTime();
  if (isNaN(then)) return '';
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Decisions for a project (or all), newest first. */
function threadFor(decisions, { project = null } = {}) {
  return (decisions || [])
    .filter(d => d && d.ts && (!project || d.project === project))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/** The single most recent action — "where you left off", or null. */
function lastLeftOff(decisions, { project = null } = {}) {
  const t = threadFor(decisions, { project });
  if (!t.length) return null;
  const d = t[0];
  return {
    summary: (d.summary || '').trim(),
    route: d.route,
    ts: d.ts,
    outcome: d.outcome || null,
  };
}

/** A one-line "picking up where you left off" string, or null. */
function continuityLine(decisions, { project = null, now = Date.now(), labeler = null, maxLen = 52 } = {}) {
  const last = lastLeftOff(decisions, { project });
  if (!last) return null;
  let s = last.summary.replace(/\s+/g, ' ');
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  const via = labelFor(last.route, labeler);
  const ago = agoText(last.ts, now);
  const when = ago ? ` · ${ago}` : '';
  return s ? `last: “${s}” · via ${via}${when}` : `last action via ${via}${when}`;
}

/** How many distinct tools appear in the thread (the "across tools" proof). */
function toolsInThread(decisions, { project = null } = {}) {
  const set = new Set(threadFor(decisions, { project }).map(d => d.route).filter(Boolean));
  return set.size;
}

module.exports = { agoText, threadFor, lastLeftOff, continuityLine, toolsInThread, labelFor, ROUTE_LABELS };
