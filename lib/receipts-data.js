// Shared receipt collection — the data layer behind `phewsh receipts` and the
// /receipts endpoints on both local bridges (phewsh serve, phewsh mcp serve).
//
// A receipt is evidence that AI work actually happened. Sources:
//   ~/.phewsh/sessions/*_sessions.json   events (start/complete/evaluate/dispatch)
//   ~/.phewsh/results/*.json             task completions + flagged blockers
//   ~/.phewsh/spend/{date}.json          daily model spend
//   ~/.phewsh/bridge/jobs.json           web↔CLI dispatch jobs

const fs = require('fs');
const path = require('path');
const os = require('os');

const PHEWSH_DIR = path.join(os.homedir(), '.phewsh');
const SESSIONS_DIR = path.join(PHEWSH_DIR, 'sessions');
const RESULTS_DIR = path.join(PHEWSH_DIR, 'results');
const SPEND_DIR = path.join(PHEWSH_DIR, 'spend');
const BRIDGE_JOBS = path.join(PHEWSH_DIR, 'bridge', 'jobs.json');

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
function gatherReceipts({ project = null, limit = 50 } = {}) {
  let events = [...collectSessions(), ...collectResults(), ...collectBridgeJobs()]
    .filter(e => e.ts);

  events = events.filter(e => {
    if (e.kind !== 'task_complete') return true;
    return !events.some(r => r.kind === 'result_record'
      && r.data.taskId === e.data.taskId
      && Math.abs(new Date(r.ts) - new Date(e.ts)) < 5000);
  });

  if (project) events = events.filter(e => e.project === project);
  events.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const counts = { completed: 0, failed: 0, blocked: 0, gated: 0, dispatched: 0 };
  for (const e of events) {
    if (e.kind === 'result_record' || e.kind === 'task_complete') {
      if (e.data.success === false) counts.failed++; else counts.completed++;
    }
    if (e.kind === 'blocker_record' || e.kind === 'blocker_flagged') counts.blocked++;
    if (e.kind === 'action_evaluated') counts.gated++;
    if (e.kind === 'dispatch_enqueued') counts.dispatched++;
  }

  return {
    summary: { ...counts, spend: spendSummary(), totalEvents: events.length },
    events: events.slice(0, limit),
  };
}

// ─── Writers — so any executor can leave the same paper trail ──────────────

function ensureDirs() {
  for (const dir of [PHEWSH_DIR, SESSIONS_DIR, RESULTS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
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

function recordResultFile(record) {
  ensureDirs();
  const file = path.join(RESULTS_DIR, `${record.taskId}_${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

module.exports = {
  PHEWSH_DIR, SESSIONS_DIR, RESULTS_DIR, SPEND_DIR, BRIDGE_JOBS,
  gatherReceipts, spendSummary,
  recordSessionEvent, recordResultFile,
};
