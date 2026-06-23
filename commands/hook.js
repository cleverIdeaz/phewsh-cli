// phewsh hook — runtime endpoints for ambient harness hooks.
//
// These are invoked BY other tools (Claude Code hooks), not by people.
// Contract: fast, silent when there's nothing to say, and they never
// read or store transcript contents — metadata only. What gets written
// is documented in `phewsh ambient status`.
//
//   phewsh hook session-start   stdout → injected into the agent's context
//   phewsh hook session-end     stdin (hook JSON) → metadata breadcrumb

const fs = require('fs');
const path = require('path');
const os = require('os');

const continuity = require('../lib/continuity');

const PHEWSH_DIR = path.join(os.homedir(), '.phewsh');
const AMBIENT_LOG = path.join(PHEWSH_DIR, 'ambient-sessions.jsonl');
const DECISIONS_FILE = path.join(PHEWSH_DIR, 'outcomes', 'decisions.json');
const INTENT_DIR = path.join(process.cwd(), '.intent');

// "Where you left off, across every tool" — drawn from phewsh's own decision
// record (not the host transcript). This is what makes opening Claude Code
// standalone feel like resuming: it sees the thread Codex (or phewsh) left.
function continuityBrief(project) {
  try {
    const decisions = JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf-8'));
    const line = continuity.continuityLine(decisions, { project });
    if (!line) return null;
    const tools = continuity.toolsInThread(decisions, { project });
    const span = tools >= 2 ? ` (${tools} tools, one thread)` : '';
    return `Continuity${span}: you were ${line}. Nothing's lost — continue it.`;
  } catch { return null; }
}

function readIfExists(p, maxBytes = 16384) {
  try { return fs.readFileSync(p, 'utf-8').slice(0, maxBytes); } catch { return null; }
}

function projectName() {
  const meta = readIfExists(path.join(INTENT_DIR, 'project.json'));
  if (meta) {
    try { const m = JSON.parse(meta); if (m.name) return m.name; } catch { /* fall through */ }
  }
  return path.basename(process.cwd());
}

function appendBreadcrumb(event, extra = {}) {
  try {
    if (!fs.existsSync(PHEWSH_DIR)) fs.mkdirSync(PHEWSH_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      cwd: process.cwd(),
      project: fs.existsSync(INTENT_DIR) ? projectName() : null,
      source: 'claude-code-ambient',
      ...extra,
    });
    fs.appendFileSync(AMBIENT_LOG, line + '\n');
  } catch { /* breadcrumbs must never break the host tool */ }
}

function firstLines(text, n) {
  let body = text;
  // Strip YAML frontmatter — metadata, not context.
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4);
  }
  return body.split('\n')
    .filter(l => l.trim())
    .filter(l => !/^#+\s*$/.test(l.trim()))
    .slice(0, n)
    .join('\n');
}

function sessionStart() {
  if (!fs.existsSync(path.join(INTENT_DIR, 'vision.md')) &&
      !fs.existsSync(path.join(INTENT_DIR, 'plan.md'))) {
    // No .intent/ here — stay silent, cost the host nothing.
    process.exit(0);
  }

  const parts = [];
  parts.push(`# Project brief (from .intent/ — PHEWSH continuity layer)`);
  parts.push(`Project: ${projectName()}`);

  const meta = readIfExists(path.join(INTENT_DIR, 'project.json'));
  if (meta) {
    try {
      const m = JSON.parse(meta);
      if (m.tldr) parts.push(`TLDR: ${m.tldr}`);
      if (m.constraints) {
        const c = Object.entries(m.constraints).map(([k, v]) => `${k}: ${v}`).join(' · ');
        if (c) parts.push(`Constraints: ${c}`);
      }
    } catch { /* skip meta */ }
  }

  const vision = readIfExists(path.join(INTENT_DIR, 'vision.md'));
  if (vision) parts.push(`\n## Vision (excerpt)\n${firstLines(vision, 8)}`);

  const next = readIfExists(path.join(INTENT_DIR, 'next.md'));
  if (next) parts.push(`\n## Next (excerpt)\n${firstLines(next, 8)}`);

  const status = readIfExists(path.join(INTENT_DIR, 'status.md'));
  if (status) parts.push(`\n## Status (excerpt)\n${firstLines(status, 5)}`);

  // Decisions are tagged with the cwd basename (how recordDecision keys them),
  // not the project.json display name — match on that so the thread connects.
  const cont = continuityBrief(path.basename(process.cwd()));
  if (cont) parts.push(`\n## Continuity (across your tools)\n${cont}`);

  // Drift nudge (read-only): if code moved ahead of .intent/, say so — right
  // here, where the agent will see it — so the human knows *when* to reconcile.
  // We never auto-rewrite their source of truth; we just make the gap visible.
  try {
    const { statusDrift } = require('../lib/truth');
    const drift = statusDrift(process.cwd());
    if (drift && drift.tracked && drift.commitsSince > 0) {
      parts.push(`\n## ⚠ phewsh drift\n.intent/ is ${drift.commitsSince} commit(s) behind the code (since ${drift.lastCommit}) — its current-state claims may be stale. Good moment to reconcile so every tool inherits today's reality.`);
    }
  } catch { /* drift is a nicety; never break the host */ }

  // Ambient operating guidance: make phewsh *felt*, not invoked. The human may
  // not know a single slash command — translate intent into phewsh actions for
  // them, nudge gently, and leave a quiet signature so they feel the layer.
  // Shared with the synced context files so every tool gets the same behavior.
  parts.push('\n' + require('../lib/ambient-guidance').PROJECT_GUIDANCE);

  parts.push(`\n(Brief injected by PHEWSH ambient from .intent/. Honor the constraints above. The human can run \`phewsh\` for mission control — council, outcomes, the decision record.)`);

  process.stdout.write(parts.join('\n') + '\n');
  appendBreadcrumb('session-start');
  process.exit(0);
}

function sessionEnd() {
  let stdin = '';
  process.stdin.on('data', d => { stdin += d.toString(); });
  process.stdin.on('end', () => {
    let reason = null;
    try { reason = JSON.parse(stdin).reason || null; } catch { /* metadata only; fine */ }
    // Self-heal: if this project's .intent/ drifted ahead of CLAUDE.md during
    // the session, bring it current now — so the next tool to open here (phewsh
    // or any agent) reads today's intent without anyone running `seq -w`. Silent
    // and deterministic; failures never touch the host tool.
    let healed = false;
    let synced = [];
    try {
      const selfheal = require('../lib/selfheal');
      // Keep EVERY tool's native context file current from .intent/, not just
      // CLAUDE.md — so the next tool to open here (Codex, Gemini, Cursor, …)
      // reads today's truth without anyone running a command. Idempotent:
      // only writes files whose substantive content actually changed.
      synced = selfheal.syncContextFiles().synced || [];
      healed = synced.length > 0;
    } catch { /* a hook must never error the host */ }
    appendBreadcrumb('session-end', { ...(reason ? { reason } : {}), ...(synced.length ? { synced } : {}) });
    process.exit(0);
  });
  // If the host never closes stdin, don't hang it.
  setTimeout(() => { appendBreadcrumb('session-end'); process.exit(0); }, 1500);
}

function main() {
  const event = process.argv[3];
  if (event === 'session-start') return sessionStart();
  if (event === 'session-end') return sessionEnd();
  // Unknown event: exit silently — hooks must never error the host tool.
  process.exit(0);
}

module.exports = main;
