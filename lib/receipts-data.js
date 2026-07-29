// Shared receipt collection — the data layer behind `phewsh receipts` and the
// /receipts endpoints on both local bridges (phewsh serve, phewsh mcp serve).
//
// A receipt is evidence that AI work actually happened. Sources:
//   ~/.phewsh/sessions/*_sessions.json   events (start/complete/evaluate/dispatch)
//   ~/.phewsh/results/*.json             task completions + flagged blockers
//   ~/.phewsh/handoffs/*/*.json          cross-harness truth receipts
//   ~/.phewsh/spend/{date}.json          daily model spend
//   ~/.phewsh/bridge/jobs.json           web↔CLI dispatch jobs

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const handoffReceipt = require('./handoff-receipt');

const PHEWSH_DIR = path.join(os.homedir(), '.phewsh');
const SESSIONS_DIR = path.join(PHEWSH_DIR, 'sessions');
const RESULTS_DIR = path.join(PHEWSH_DIR, 'results');
const HANDOFFS_DIR = path.join(PHEWSH_DIR, 'handoffs');
const SPEND_DIR = path.join(PHEWSH_DIR, 'spend');
const BRIDGE_JOBS = path.join(PHEWSH_DIR, 'bridge', 'jobs.json');
// Full run receipts (schema phewsh.run-receipt), one immutable file each.
const RUN_RECEIPTS_DIR = path.join(PHEWSH_DIR, 'receipts');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function collectSessions() {
  const events = [];
  for (const f of listDir(SESSIONS_DIR)) {
    if (!f.endsWith('_sessions.json')) continue;
    const sessions = readJson(path.join(SESSIONS_DIR, f), []);
    if (!Array.isArray(sessions)) continue;
    for (const s of sessions) {
      events.push({ ts: s.timestamp, project: s.projectId, agent: s.agentId, kind: s.event, data: s, receipt: `sessions/${f}` });
    }
  }
  return events;
}

function collectResults() {
  const events = [];
  for (const f of listDir(RESULTS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const r = readJson(path.join(RESULTS_DIR, f), null);
    if (!r) continue;
    events.push({
      ts: r.reportedAt || r.flaggedAt,
      project: r.projectId,
      agent: r.agentId,
      kind: r.type === 'blocker' ? 'blocker_record' : 'result_record',
      data: r,
      receipt: `results/${f}`,
    });
  }
  return events;
}

function collectBridgeJobs() {
  const store = readJson(BRIDGE_JOBS, { jobs: {} });
  return Object.values(store.jobs || {}).map(j => {
    const { packet, ...rest } = j;
    return {
      ts: j.updatedAt || j.createdAt,
      project: 'web',
      agent: j.runtimeId,
      kind: `job_${j.status}`,
      data: { ...rest, summary: packet?.objective?.task?.slice(0, 140) || null, packet },
      receipt: 'bridge/jobs.json',
    };
  });
}

function collectHandoffs() {
  const events = [];
  for (const projectDir of listDir(HANDOFFS_DIR)) {
    const dir = path.join(HANDOFFS_DIR, projectDir);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of listDir(dir)) {
      if (!file.endsWith('.json')) continue;
      const receipt = readJson(path.join(dir, file), null);
      if (!receipt || receipt.kind !== 'handoff') continue;
      events.push({
        ts: receipt.created_at,
        project: receipt.project?.name || projectDir,
        agent: receipt.routes?.from || 'unknown',
        kind: 'handoff',
        data: receipt,
        valid: handoffReceipt.integrityValid(receipt),
        receipt: `handoffs/${projectDir}/${file}`,
      });
    }
  }
  return events;
}

function spendSummary() {
  const days = listDir(SPEND_DIR).filter(f => f.endsWith('.json')).sort();
  let total = 0;
  let today = 0;
  const todayKey = new Date().toISOString().slice(0, 10);
  for (const f of days) {
    const data = readJson(path.join(SPEND_DIR, f), { total: 0 });
    total += data.total || 0;
    if (f === `${todayKey}.json`) today = data.total || 0;
  }
  return { days: days.length, total: Math.round(total * 1e4) / 1e4, today };
}

/**
 * The merged, deduped, newest-first proof trail.
 * A completion leaves two records (task_complete session event + richer
 * result_record file) — the session twin is dropped so counts stay honest.
 */
function sameProject(receipt, cwd) {
  if (!cwd || !receipt?.project?.identity) return false;
  try {
    return handoffReceipt.canonical(receipt.project.identity)
      === handoffReceipt.canonical(handoffReceipt.projectIdentity(cwd));
  } catch { return false; }
}

function publicEvent(event, { cwd = null } = {}) {
  if (event.kind !== 'handoff') return event;
  const receipt = event.data;
  const publicRoutes = new Set([
    'phewsh', 'api', 'unselected', 'unknown',
    'claude-code', 'codex', 'gemini', 'cursor', 'opencode', 'grok', 'kiro',
    'copilot', 'hermes', 'pi', 'aider', 'goose', 'amp', 'droid',
  ]);
  const safeRoute = value => publicRoutes.has(value) ? value : 'other';
  const verification = cwd && sameProject(receipt, cwd)
    ? handoffReceipt.verifyHandoffReceipt(receipt, { cwd })
    : null;
  return {
    ts: event.ts,
    // Receipt collection derives the project label from a local directory.
    // Filtering may use it locally, but the browser never needs to receive it.
    project: null,
    agent: safeRoute(event.agent),
    kind: event.kind,
    valid: event.valid,
    receipt: null,
    data: {
      created_at: receipt.created_at,
      trigger: receipt.trigger,
      routes: {
        from: safeRoute(receipt.routes?.from),
        to: safeRoute(receipt.routes?.to),
      },
      verdict: verification?.status || (event.valid ? 'integrity-valid' : 'invalid'),
      truth_file_count: receipt.carried?.intent?.length || 0,
      dirty_path_count: receipt.carried?.repository?.dirty?.length || 0,
      not_carried: (receipt.not_carried || []).map(item => item.item),
    },
  };
}

function gatherReceipts({ project = null, kind = null, limit = 50, publicView = false, cwd = null } = {}) {
  let events = [...collectSessions(), ...collectResults(), ...collectBridgeJobs(), ...collectHandoffs()]
    .filter(e => e.ts);

  events = events.filter(e => {
    if (e.kind !== 'task_complete') return true;
    return !events.some(r => r.kind === 'result_record'
      && r.data.taskId === e.data.taskId
      && Math.abs(new Date(r.ts) - new Date(e.ts)) < 5000);
  });

  if (project) events = events.filter(e => e.project === project);
  if (kind) events = events.filter(e => e.kind === kind);
  // A browser connected to one local worker should never receive even
  // redacted handoff counts from unrelated checkouts on the same machine.
  if (publicView && cwd) {
    events = events.filter(event => event.kind !== 'handoff' || sameProject(event.data, cwd));
  }
  events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const counts = { completed: 0, failed: 0, blocked: 0, gated: 0, dispatched: 0, handoffs: 0, invalidHandoffs: 0 };
  for (const e of events) {
    if (e.kind === 'result_record' || e.kind === 'task_complete') {
      if (e.data.success === false) counts.failed++; else counts.completed++;
    }
    if (e.kind === 'blocker_record' || e.kind === 'blocker_flagged') counts.blocked++;
    if (e.kind === 'action_evaluated') counts.gated++;
    if (e.kind === 'dispatch_enqueued') counts.dispatched++;
    if (e.kind === 'handoff') {
      counts.handoffs++;
      if (e.valid === false) counts.invalidHandoffs++;
    }
  }

  return {
    summary: { ...counts, spend: spendSummary(), totalEvents: events.length },
    events: events.slice(0, limit).map(event => publicView ? publicEvent(event, { cwd }) : event),
  };
}

// ─── Writers — so any executor can leave the same paper trail ──────────────

function ensureDirs() {
  for (const dir of [PHEWSH_DIR, SESSIONS_DIR, RESULTS_DIR, RUN_RECEIPTS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

const RECEIPT_INDEX = () => path.join(RUN_RECEIPTS_DIR, '.integrity.json');

const contentHash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Persist a run receipt. Written through a temp file and renamed, so a crash
 * mid-write can never leave a half-receipt that reads as evidence.
 *
 * Phewsh writes a receipt ONCE and never edits it, and records its hash so an
 * edit made by anything else is visible on read. That is tamper-EVIDENT, not
 * tamper-proof: this is an ordinary file in the user's home directory, and any
 * program running as that user — including the harness a run just launched —
 * can change it. Saying otherwise would be the overclaim an independent critic
 * caught on 2026-07-29.
 */
function recordRunReceipt(receipt) {
  try {
    ensureDirs();
    const file = path.join(RUN_RECEIPTS_DIR, `${receipt.receiptId}.json`);
    if (fs.existsSync(file)) return file;
    const body = JSON.stringify(receipt, null, 2);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    const index = readJson(RECEIPT_INDEX(), {});
    index[receipt.receiptId] = contentHash(body);
    fs.writeFileSync(RECEIPT_INDEX(), JSON.stringify(index, null, 2));
    return file;
  } catch {
    return null;
  }
}

/**
 * One receipt by id, straight off disk — so it survives a node restart —
 * carrying an `integrity` verdict:
 *
 *   intact     the bytes still hash to what was recorded at write time
 *   altered    something changed this file after Phewsh wrote it
 *   unrecorded no hash was stored (a receipt from before this check existed)
 */
function readRunReceipt(receiptId) {
  if (!receiptId || !/^[A-Za-z0-9._-]+$/.test(receiptId)) return null;
  const file = path.join(RUN_RECEIPTS_DIR, `${receiptId}.json`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  let receipt;
  try { receipt = JSON.parse(raw); } catch { return null; }
  const expected = readJson(RECEIPT_INDEX(), {})[receiptId];
  const integrity = !expected ? 'unrecorded'
    : contentHash(raw) === expected ? 'intact' : 'altered';
  return { ...receipt, integrity };
}

/**
 * Newest-first receipts, bounded.
 *
 * Filter by `boundProjectId` — the stable id — never by display name. Two
 * registered repositories can share a basename, and a receipt crossing between
 * them would let one project's evidence be closed into another's Record.
 */
function listRunReceipts({ boundProjectId = null, project = null, limit = 20 } = {}) {
  return listDir(RUN_RECEIPTS_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    // Through readRunReceipt so every listed receipt carries its integrity
    // verdict — a list that silently drops the check is a list of claims.
    .map((f) => readRunReceipt(f.replace(/\.json$/, '')))
    .filter((r) => r
      && (!boundProjectId || r.boundProjectId === boundProjectId)
      && (!project || r.projectId === project))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}

function recordSessionEvent(agentId, projectId, event, data = {}) {
  try {
    ensureDirs();
    const file = path.join(SESSIONS_DIR, `${projectId}_sessions.json`);
    let sessions = readJson(file, []);
    if (!Array.isArray(sessions)) sessions = [];
    sessions.push({ agentId: agentId || 'anonymous', projectId, event, timestamp: new Date().toISOString(), ...data });
    if (sessions.length > 100) sessions = sessions.slice(-100);
    fs.writeFileSync(file, JSON.stringify(sessions, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * A task id is a NAME, never a path.
 *
 * `record.taskId` comes straight off a dispatch body (`packet.id`), and this
 * used to be interpolated into a filename unsanitized. An independent critic
 * wrote outside `~/.phewsh/results` entirely with `packet.id =
 * "../../victim/pwned"` — arbitrary-directory file creation with a controlled
 * prefix, and a way to plant a forged file into the receipts directory that
 * `listRunReceipts` reads by glob. `readRunReceipt` already validated its id;
 * only the write path was left open.
 */
function safeFileStem(value) {
  const stem = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    // Separators are already gone, so nothing can traverse — but a run of dots
    // still reads like one and confuses tooling that globs. Collapse it.
    .replace(/\.{2,}/gu, '.')
    .replace(/^[.-]+/u, '');
  return stem.slice(0, 128) || 'task';
}

function recordResultFile(record) {
  ensureDirs();
  const file = path.join(RESULTS_DIR, `${safeFileStem(record.taskId)}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

module.exports = {
  PHEWSH_DIR, SESSIONS_DIR, RESULTS_DIR, HANDOFFS_DIR, SPEND_DIR, BRIDGE_JOBS, RUN_RECEIPTS_DIR,
  gatherReceipts, spendSummary,
  recordSessionEvent, recordResultFile,
  recordRunReceipt, readRunReceipt, listRunReceipts,
};
