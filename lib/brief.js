const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { auditTruth } = require('./truth');

function concise(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function workContract(cwd = process.cwd()) {
  try {
    const item = require('./next').briefItem(cwd);
    if (!item) return null;
    const all = Array.isArray(item.criteria) ? item.criteria : [];
    return {
      id: item.id,
      title: item.title,
      state: item.state,
      accepted: all.filter(criterion => criterion.accepted !== false),
      proposedCount: all.filter(criterion => criterion.accepted === false).length,
    };
  } catch {
    return null;
  }
}

function formatBrief(report, { cwd = process.cwd(), maxClaims = 5, task = workContract(cwd), handoff = null } = {}) {
  const lines = [];
  const npm = report.package.npmLatest.status === 'known'
    ? report.package.npmLatest.version
    : `unknown (${report.package.npmLatest.reason})`;
  const dirtyCount = report.git.tracked.length + report.git.untracked.length;

  lines.push('# PHEWSH Verified Project Brief');
  lines.push(`Project: ${path.basename(cwd)}`);
  lines.push(`Generated: ${report.auditedAt}`);
  lines.push('');
  lines.push('## Verified State');
  lines.push(`- Git HEAD: ${report.git.available ? report.git.shortHead : 'unknown'}`);
  if (report.git.committedPackageVersion) lines.push(`- Package at Git HEAD: ${report.git.committedPackageVersion}`);
  lines.push(`- Working package: ${report.package.version}`);
  lines.push(`- npm latest: ${npm}`);
  lines.push(`- Working tree: ${dirtyCount ? `${dirtyCount} changed path(s), uncommitted` : 'clean'}`);
  lines.push('');
  lines.push('## Intent Claims');
  lines.push('These sources are authoritative for purpose and priorities, but code/release claims below remain claims until verified.');
  report.intent.authoritative.slice(0, maxClaims).forEach(claim => {
    lines.push(`- ${claim.file} [declared ${claim.declaredUpdated || 'unknown'}]: ${concise(claim.summary)}`);
  });
  lines.push('');
  lines.push('## Current Work Contract');
  if (!task) {
    lines.push('- No started or queued Next item.');
  } else {
    lines.push(`- Item: ${concise(task.title, 240)}`);
    lines.push(`- State: ${task.state === 'now' ? 'started' : 'queued'}`);
    if (task.accepted.length) {
      lines.push('- Accepted success criteria:');
      task.accepted.forEach(criterion => {
        lines.push(`  - [${criterion.type === 'human' ? 'human judgment' : 'measurable'}] ${concise(criterion.expected, 260)}`);
      });
    } else {
      lines.push('- Accepted success criteria: none defined.');
    }
    if (task.proposedCount) {
      lines.push(`- ${task.proposedCount} proposed criterion/criteria omitted until the user accepts them.`);
    }
  }
  lines.push('');
  lines.push('## Conflicts And Unknowns');
  if (!report.conflicts.length) lines.push('- No explicit conflicts detected.');
  report.conflicts.forEach(item => lines.push(`- Conflict: ${concise(item, 360)}`));
  if (!report.unknowns.length) lines.push('- No additional unknowns recorded.');
  report.unknowns.slice(0, 6).forEach(item => lines.push(`- Unknown: ${concise(item, 360)}`));
  lines.push('');
  lines.push('## Continuity Evidence');
  if (!handoff) {
    lines.push('- Handoff: no receipt; cold start from .intent/ only. No continuity is being silently claimed.');
  } else if (handoff.status === 'verified') {
    const trigger = handoff.receipt?.trigger === 'work-start'
      ? ' at work start (incoming boundary, not a completed-session receipt)'
      : ` after ${handoff.receipt?.trigger || 'handoff'}`;
    lines.push(`- Handoff: ${handoff.id} verified${trigger}; portable truth and repository state are unchanged since it was written.`);
  } else if (handoff.status === 'partial') {
    lines.push(`- Handoff: ${handoff.id} partial; ${concise((handoff.repositoryPartial || []).join(', '), 320)}.`);
  } else if (handoff.status === 'moved') {
    const moved = [...(handoff.truthChanged || []), ...(handoff.repositoryChanged || []), ...(handoff.briefChanged || [])];
    lines.push(`- Handoff: ${handoff.id} moved since it was written: ${concise(moved.join(', '), 320)}.`);
  } else {
    lines.push(`- Handoff: ${handoff.id || 'receipt'} invalid; ${handoff.reason || 'integrity could not be verified'}.`);
  }
  lines.push('- Not carried: conversation transcript, model reasoning, editor buffers, harness-local memory, or decisions not written into the Record.');
  lines.push(`- Outcomes: ${report.outcomes.total} routed; ${report.outcomes.judged} human-judged; ${report.outcomes.pending} pending.`);
  lines.push(`- Receipts: ${report.receipts.totalEvents} local event(s); ${report.receipts.completed} completed; ${report.receipts.failed} failed; ${report.receipts.handoffs || 0} handoff(s).`);
  for (const item of report.outcomes.recent.slice(0, 3)) {
    lines.push(`- Recent ${item.route || 'unknown'}: ${concise(item.summary, 180)}${item.outcome ? ` [${item.outcome}]` : ' [pending]'}`);
  }
  lines.push('');
  lines.push('## Operating Contract');
  lines.push('- Prefer verified runtime and repository evidence over generated summaries or model memory.');
  lines.push('- Treat .intent/ as authoritative for goals and declared decisions, not as proof that implementation shipped.');
  lines.push('- Do not describe working-tree changes as committed, published, or deployed.');
  lines.push('- Surface disagreement explicitly. Do not silently merge conflicting sources.');
  lines.push('- Before finishing, report what changed, what remains unknown, and what should be reconciled.');
  return lines.join('\n');
}

async function generateBrief(options = {}) {
  const report = options.report || await auditTruth(options);
  const handoff = Object.prototype.hasOwnProperty.call(options, 'handoff')
    ? options.handoff
    : require('./handoff-receipt').latestHandoffReceipt({ cwd: options.cwd || process.cwd() });
  return { report, handoff, content: formatBrief(report, { ...options, handoff }) };
}

function persistBrief(content, {
  project = path.basename(process.cwd()),
  route = 'unknown',
  root = path.join(os.homedir(), '.phewsh', 'briefs'),
} = {}) {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(root, project);
  const file = path.join(dir, `${stamp}-${route}.md`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content);
    return { written: true, file, hash };
  } catch (err) {
    return { written: false, file: null, hash, reason: err.message };
  }
}

module.exports = { concise, formatBrief, generateBrief, persistBrief, workContract };
