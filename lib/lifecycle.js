const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { auditTruth } = require('./truth');

const GENERATED_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.phewsh.context']);

function fileHash(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return `non-file:${stat.size}`;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function statusPaths(git) {
  return [
    ...git.tracked.map(item => item.file.includes(' -> ') ? item.file.split(' -> ').pop() : item.file),
    ...git.untracked,
  ];
}

function currentDiffSummary(cwd) {
  try {
    const compact = execFileSync('git', ['diff', '--stat', '--compact-summary', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const numstat = execFileSync('git', ['diff', '--numstat', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    let additions = 0;
    let deletions = 0;
    let binary = 0;
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [added, deleted] = line.split('\t');
      if (added === '-' || deleted === '-') binary++;
      else {
        additions += Number(added) || 0;
        deletions += Number(deleted) || 0;
      }
    }
    return { compact: compact || 'no tracked diff', additions, deletions, binary };
  } catch {
    return { compact: 'unavailable', additions: null, deletions: null, binary: null };
  }
}

function snapshotFingerprints(cwd, report) {
  const paths = new Set(statusPaths(report.git));
  for (const claim of report.intent.authoritative) paths.add(claim.file);
  for (const projection of report.projections) paths.add(projection.file);
  const fingerprints = {};
  for (const relative of paths) fingerprints[relative] = fileHash(path.join(cwd, relative));
  return fingerprints;
}

function captureSnapshot(report, { cwd = process.cwd() } = {}) {
  return {
    capturedAt: new Date().toISOString(),
    cwd,
    head: report.git.head,
    dirty: statusPaths(report.git),
    diffSummary: currentDiffSummary(cwd),
    fingerprints: snapshotFingerprints(cwd, report),
    truth: report,
  };
}

function gitNamesBetween(cwd, beforeHead, afterHead) {
  if (!beforeHead || !afterHead || beforeHead === afterHead) return [];
  try {
    const raw = execFileSync('git', ['diff', '--name-status', beforeHead, afterHead], {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.split('\n').filter(Boolean).map(line => {
      const [code, ...files] = line.split('\t');
      return { code, file: files[files.length - 1] };
    });
  } catch {
    return [];
  }
}

function changedFingerprints(before, after) {
  const paths = new Set([...Object.keys(before.fingerprints), ...Object.keys(after.fingerprints)]);
  const changed = [];
  for (const file of paths) {
    if (before.fingerprints[file] !== after.fingerprints[file]) changed.push(file);
  }
  return changed.sort();
}

function claimsForFiles(report, files) {
  const changed = new Set(files);
  return report.intent.authoritative
    .filter(claim => changed.has(claim.file))
    .map(claim => ({ file: claim.file, summary: claim.summary, declaredUpdated: claim.declaredUpdated }));
}

function compareSnapshots(before, after) {
  const fingerprintChanges = changedFingerprints(before, after);
  const committed = gitNamesBetween(after.cwd, before.head, after.head);
  const files = [...new Set([...fingerprintChanges, ...committed.map(item => item.file)])].sort();
  const intentFiles = files.filter(file => file.startsWith('.intent/'));
  const generatedFiles = files.filter(file => GENERATED_FILES.has(file));
  return {
    kind: 'postflight',
    observedAt: after.capturedAt,
    beforeHead: before.head,
    afterHead: after.head,
    headChanged: before.head !== after.head,
    files,
    committed,
    preExistingDirty: before.dirty,
    currentDirty: after.dirty,
    diffSummary: after.diffSummary,
    intentFiles,
    generatedFiles,
    claims: claimsForFiles(after.truth, intentFiles),
    verification: require('./verify').verifyCurrentWork(after.cwd, { changedPaths: files }),
    conflicts: after.truth.conflicts,
    unknowns: [
      'PHEWSH cannot infer whether each observed file change was intended or correct.',
      'Publication and deployment remain unknown unless an external runtime was verified.',
    ],
    truth: after.truth,
  };
}

function observeCurrent(report, { cwd = process.cwd() } = {}) {
  const files = statusPaths(report.git);
  const intentFiles = files.filter(file => file.startsWith('.intent/'));
  const generatedFiles = files.filter(file => GENERATED_FILES.has(file));
  return {
    kind: 'current',
    observedAt: new Date().toISOString(),
    beforeHead: report.git.head,
    afterHead: report.git.head,
    headChanged: false,
    files,
    committed: [],
    preExistingDirty: [],
    currentDirty: files,
    diffSummary: currentDiffSummary(cwd),
    intentFiles,
    generatedFiles,
    claims: claimsForFiles(report, intentFiles),
    verification: require('./verify').verifyCurrentWork(cwd),
    conflicts: report.conflicts,
    unknowns: [
      'Without a preflight snapshot, PHEWSH cannot attribute current changes to one harness session.',
      'PHEWSH cannot infer whether each observed file change was intended or correct.',
    ],
    truth: report,
    cwd,
  };
}

function formatObservedReport(report, { title = 'Observed change report' } = {}) {
  const lines = [title];
  lines.push(`Observed: ${report.observedAt}`);
  if (report.kind === 'postflight') {
    lines.push(`Git transition: ${report.beforeHead?.slice(0, 8) || 'unknown'} -> ${report.afterHead?.slice(0, 8) || 'unknown'}`);
  } else {
    lines.push(`Git HEAD: ${report.afterHead?.slice(0, 8) || 'unknown'}`);
  }
  lines.push('');
  lines.push('What changed:');
  if (!report.files.length) lines.push('- no file changes observed');
  report.files.forEach(file => lines.push(`- ${file}`));
  if (report.committed.length) {
    lines.push('');
    lines.push('Verified committed changes:');
    report.committed.forEach(item => lines.push(`- ${item.code} ${item.file}`));
  }
  lines.push('');
  lines.push('Claims made or changed:');
  if (!report.claims.length) lines.push('- no changed .intent/ claim files observed');
  report.claims.forEach(claim => lines.push(`- ${claim.file}: ${claim.summary}`));
  lines.push('');
  lines.push('What can be verified:');
  lines.push(`- current Git HEAD is ${report.afterHead?.slice(0, 8) || 'unknown'}`);
  lines.push(`- ${report.currentDirty.length} path(s) are currently uncommitted`);
  lines.push(`- ${report.intentFiles.length} authoritative intent file(s) changed`);
  lines.push(`- ${report.generatedFiles.length} generated projection file(s) changed`);
  if (report.diffSummary.additions != null) {
    lines.push(`- tracked diff: +${report.diffSummary.additions} / -${report.diffSummary.deletions}${report.diffSummary.binary ? ` / ${report.diffSummary.binary} binary` : ''}`);
  } else {
    lines.push(`- tracked diff summary: ${report.diffSummary.compact}`);
  }
  lines.push('');
  lines.push('Verification:');
  if (!report.verification) {
    lines.push('- no started item with success criteria; no verdict inferred');
  } else {
    const status = require('./verify').overallStatus(report.verification.summary);
    lines.push(`- ${status}: ${report.verification.item}`);
    report.verification.results.forEach(result => {
      lines.push(`- [${result.status}] ${result.expected} — ${result.note}`);
    });
  }
  lines.push('');
  lines.push('Contradictions:');
  if (!report.conflicts.length) lines.push('- none detected');
  report.conflicts.forEach(item => lines.push(`- ${item}`));
  lines.push('');
  lines.push('Unknowns:');
  report.unknowns.forEach(item => lines.push(`- ${item}`));
  lines.push('');
  lines.push('Reconciliation:');
  lines.push(report.files.length || report.conflicts.length
    ? '- review with /reconcile; PHEWSH will propose an exact intent diff before writing'
    : '- nothing currently requires reconciliation');
  return lines.join('\n');
}

function reconciliationProposal(report, { cwd = process.cwd(), target = '.intent/next.md' } = {}) {
  const targetPath = path.join(cwd, target);
  let before;
  try { before = fs.readFileSync(targetPath, 'utf-8'); } catch {
    return { available: false, reason: `${target} does not exist` };
  }
  const date = new Date().toISOString().slice(0, 10);
  const committed = report.committed.length > 0;
  const lines = [
    '',
    `## ${committed ? 'Verified work reconciliation' : 'Observed work requiring reconciliation'} (${date})`,
    '',
    `State: ${committed ? 'Git commits were observed during the work session.' : 'Uncommitted working-tree changes; not shipped.'}`,
    '',
    'Observed files:',
    ...(report.files.length ? report.files.map(file => `- ${file}`) : ['- none']),
  ];
  if (report.verification) {
    const status = require('./verify').overallStatus(report.verification.summary);
    lines.push(
      '',
      `Verification verdict: ${status}`,
      `Work item: ${report.verification.item}`,
      ...report.verification.results.map(result => `- [${result.status}] ${result.expected} — ${result.note}`),
    );
  } else {
    lines.push('', 'Verification verdict: unavailable — no started item with success criteria.');
  }
  if (report.conflicts.length) {
    lines.push('', 'Conflicts still open:', ...report.conflicts.map(item => `- ${item}`));
  }
  if (report.unknowns.length) {
    lines.push('', 'Unknowns:', ...report.unknowns.map(item => `- ${item}`));
  }
  const addition = `${lines.join('\n')}\n`;
  const beforeHash = crypto.createHash('sha256').update(before).digest('hex');
  const diff = [
    `--- a/${target}`,
    `+++ b/${target}`,
    `@@ append after ${before.split('\n').length} lines @@`,
    ...addition.trimEnd().split('\n').map(line => `+${line}`),
  ].join('\n');
  return { available: true, target, targetPath, beforeHash, addition, diff };
}

function applyReconciliation(proposal) {
  if (!proposal?.available) return { written: false, reason: proposal?.reason || 'no proposal' };
  try {
    const current = fs.readFileSync(proposal.targetPath, 'utf-8');
    const currentHash = crypto.createHash('sha256').update(current).digest('hex');
    if (currentHash !== proposal.beforeHash) {
      return { written: false, reason: `${proposal.target} changed after the proposal was generated` };
    }
    fs.appendFileSync(proposal.targetPath, proposal.addition);
    return { written: true, target: proposal.target };
  } catch (err) {
    return { written: false, reason: err.message };
  }
}

async function createPostflight(before, options = {}) {
  const truth = await auditTruth({ ...options, cwd: before.cwd });
  const after = captureSnapshot(truth, { cwd: before.cwd });
  return compareSnapshots(before, after);
}

module.exports = {
  GENERATED_FILES,
  applyReconciliation,
  captureSnapshot,
  compareSnapshots,
  createPostflight,
  currentDiffSummary,
  fileHash,
  formatObservedReport,
  observeCurrent,
  reconciliationProposal,
  statusPaths,
};
