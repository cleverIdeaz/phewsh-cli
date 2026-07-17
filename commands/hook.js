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

// The accountability invitation. A real project (it has .git) with no
// .intent/ gets ONE gentle note injected — telling the agent to offer
// grounding once, and to drop it if declined. Once per project, ever
// (tracked in ~/.phewsh/intent-nudges.json); every later session is
// silent again. Invite, never nag — the recorded stance (decisions.md).
function maybeIntentInvitation() {
  try {
    if (!fs.existsSync(path.join(process.cwd(), '.git'))) return; // not a real project — cost nothing
    const nudgeFile = path.join(PHEWSH_DIR, 'intent-nudges.json');
    let seen = {};
    try { seen = JSON.parse(fs.readFileSync(nudgeFile, 'utf-8')); } catch { /* first nudge ever */ }
    if (seen && seen[process.cwd()]) return; // already invited here — never again
    seen = (seen && typeof seen === 'object') ? seen : {};
    seen[process.cwd()] = new Date().toISOString();
    fs.mkdirSync(PHEWSH_DIR, { recursive: true });
    fs.writeFileSync(nudgeFile, JSON.stringify(seen, null, 2));
    process.stdout.write([
      '# phewsh — one-time note for this project',
      'This repo has no `.intent/` yet — no durable project truth that travels between AI tools.',
      'If the user starts substantial (non-trivial) work here, offer ONCE, in plain language, to ground the project:',
      '`phewsh clarify` (guided walk) or `phewsh init` (two questions) creates `.intent/` — vision, plan, and next steps that every AI tool reads, so the next session picks up where this one left off.',
      'If they decline, or the work is trivial/exploratory, drop it and never raise it again. Do not create `.intent/` yourself uninvited.',
    ].join('\n') + '\n');
    appendBreadcrumb('intent-invite');
  } catch { /* the invitation is a nicety — never break the host */ }
}

function sessionStart() {
  if (!fs.existsSync(path.join(INTENT_DIR, 'vision.md')) &&
      !fs.existsSync(path.join(INTENT_DIR, 'plan.md'))) {
    // No .intent/ here — one gentle invitation if this is a real project,
    // then silence forever.
    maybeIntentInvitation();
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

// Load the Decision Gate context (constraints + protected files) for the project
// being worked in. Walks upward to the .intent/ root first — sessions started
// in a subdirectory must inherit the same autonomy as the project root, or the
// ask tier comes back for them. Best-effort: missing/garbled → empty context.
function loadGateContext(cwd) {
  try {
    const { resolveProjectRoot } = require('../lib/sequencer/discover');
    const root = resolveProjectRoot(cwd);
    const pj = JSON.parse(fs.readFileSync(path.join(root, '.intent', 'project.json'), 'utf-8'));
    const dg = pj.decisionGate || {};
    return {
      constraints: dg.constraints || {},
      protectedFiles: dg.protectedFiles || pj.protectedFiles || [],
    };
  } catch { return { constraints: {}, protectedFiles: [] }; }
}

// PreToolUse adapter — the Decision Gate acting BEFORE a tool runs. Reads Claude
// Code's PreToolUse JSON from stdin, evaluates against the project's constraints
// + protected files, and emits a permission decision. FAIL-SAFE: any error, no
// stdin, or no policy hit → exit 0 (allow). A broken gate must never trap you.
// It logs only a redacted decision line (never the tool payload).
function preTool() {
  try {
    if (process.stdin.isTTY) process.exit(0); // not a real hook invocation
    const { evaluateAction, auditLine } = require('../lib/gate-policy');
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf-8'); } catch { process.exit(0); }
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

    const cwd = payload.cwd || process.cwd();
    const envelope = {
      toolName: payload.tool_name || payload.toolName,
      toolInput: payload.tool_input || payload.toolInput || {},
      home: os.homedir(), // lets the pure policy match literal home-dir targets
      ...loadGateContext(cwd),
    };
    let result = { decision: 'allow', reason: '' };
    try { result = evaluateAction(envelope); } catch { process.exit(0); }

    if (result.decision !== 'allow') {
      try { appendBreadcrumb('pre-tool', { decision: result.decision, action: auditLine(envelope, result) }); } catch { /* audit is best-effort */ }
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: result.decision, // 'deny' | 'ask'
          permissionDecisionReason: result.reason,
        },
      }));
    }
    process.exit(0);
  } catch {
    process.exit(0); // fail open, always
  }
}

// PostToolUse adapter — the other half of the lifecycle. After a write-ish
// tool runs, leave a redacted receipt (tool name + relative target, or just
// the binary name for shell — NEVER args, content, or output) so `phewsh`
// can show what agents actually did here. Always silent to the host, always
// fail-open: a broken receipt must never slow or break the tool that ran.
function postTool() {
  try {
    if (process.stdin.isTTY) process.exit(0); // not a real hook invocation
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf-8'); } catch { process.exit(0); }
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    const tool = payload.tool_name || payload.toolName;
    if (!tool) process.exit(0);
    const input = payload.tool_input || payload.toolInput || {};
    const cwd = payload.cwd || process.cwd();
    let target = null;
    if (typeof input.file_path === 'string') {
      target = path.relative(cwd, input.file_path) || input.file_path;
    } else if (typeof input.command === 'string') {
      target = String(input.command).trim().split(/\s+/)[0] || null; // binary only, never args
    }
    appendBreadcrumb('post-tool', { tool, ...(target ? { target } : {}) });
    process.exit(0);
  } catch {
    process.exit(0); // fail open, always
  }
}

function main() {
  const event = process.argv[3];
  if (event === 'session-start') return sessionStart();
  if (event === 'session-end') return sessionEnd();
  if (event === 'pre-tool') return preTool();
  if (event === 'post-tool') return postTool();
  // Unknown event: exit silently — hooks must never error the host tool.
  process.exit(0);
}

module.exports = main;
