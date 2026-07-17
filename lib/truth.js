const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadIntentContext } = require('./intent-context');
const { outcomeEvidence } = require('./outcomes');
const { gatherReceipts } = require('./receipts-data');
const { SOURCE_CONTRACT, RESOLUTION_ORDER } = require('./source-contract');

function runGit(cwd, args, { trim = true } = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return trim ? output.trim() : output.replace(/\n$/, '');
  } catch {
    return null;
  }
}

function parsePorcelain(raw) {
  if (!raw) return { tracked: [], untracked: [] };
  const tracked = [];
  const untracked = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '??') untracked.push(file);
    else tracked.push({ code, file });
  }
  return { tracked, untracked };
}

// True drift signal: how many commits have changed *code* since the narrative
// file (status.md) was last updated. mtime comparison is unreliable — a file
// committed in the latest commit always has an mtime <= the commit time, so a
// naive "file older than HEAD" check cries wolf right after you do the right
// thing. We instead ask git: from the commit that last touched status.md to
// HEAD, how many commits changed something other than .intent/ and generated
// projections? Zero means status.md is current with the code; >0 is real drift.
function statusDrift(cwd, statusFile = '.intent/status.md') {
  const lastCommit = runGit(cwd, ['log', '-1', '--format=%H', '--', statusFile]);
  if (!lastCommit) return { tracked: false, commitsSince: 0, lastCommit: null };
  const raw = runGit(cwd, [
    'log', '--format=%h', `${lastCommit}..HEAD`,
    '--', '.',
    ':(exclude).intent',
    ':(exclude)CLAUDE.md',
    ':(exclude)AGENTS.md',
    ':(exclude)GEMINI.md',
    ':(exclude).cursorrules',
    ':(exclude).phewsh.context',
  ]);
  const commitsSince = raw ? raw.split('\n').filter(Boolean).length : 0;
  return { tracked: true, commitsSince, lastCommit: lastCommit.slice(0, 8) };
}

function gitSnapshot(cwd = process.cwd(), packageJsonPath = null) {
  const isRepo = runGit(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!isRepo) return { available: false, isRepo: false, head: null, tracked: [], untracked: [] };
  const status = parsePorcelain(runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], { trim: false }));
  const head = runGit(cwd, ['rev-parse', 'HEAD']);
  if (!head) return {
    available: true,
    isRepo: true,
    head: null,
    shortHead: null,
    latestCommitAt: null,
    committedPackageVersion: null,
    drift: { tracked: false, commitsSince: 0, lastCommit: null },
    ...status,
  };
  const latestCommitAt = runGit(cwd, ['log', '-1', '--format=%cI']);
  let committedPackageVersion = null;
  if (packageJsonPath) {
    const relativePackagePath = path.relative(cwd, packageJsonPath).split(path.sep).join('/');
    if (relativePackagePath && !relativePackagePath.startsWith('../')) {
      const committedPackage = runGit(cwd, ['show', `HEAD:${relativePackagePath}`]);
      try { committedPackageVersion = JSON.parse(committedPackage).version || null; } catch { /* unavailable at HEAD */ }
    }
  }
  return { available: true, isRepo: true, head, shortHead: head.slice(0, 8), latestCommitAt, committedPackageVersion, drift: statusDrift(cwd), ...status };
}

function statDate(filePath) {
  try { return fs.statSync(filePath).mtime.toISOString(); } catch { return null; }
}

function intentClaims(cwd = process.cwd()) {
  return loadIntentContext(cwd).map(item => {
    const lines = item.promptContent.split('\n').map(line => line.trim()).filter(Boolean);
    const summary = item.kind === 'constraints'
      ? lines.find(line => line.startsWith('Constraints:')) || lines.find(line => line.startsWith('Goal:'))
      : lines.find(line => {
      const value = line.trim();
      return value && !value.startsWith('#') && !value.startsWith('---');
    });
    const details = item.kind === 'constraints'
      ? lines.filter(line => line.startsWith('Goal:') && line !== summary)
      : [];
    return {
      file: `.intent/${item.file}`,
      kind: item.kind,
      declaredUpdated: item.updated,
      modifiedAt: statDate(path.join(cwd, '.intent', item.file)),
      summary: summary || '(no concise claim found)',
      details,
      invalid: !!item.invalid,
    };
  });
}

function projectionInfo(cwd = process.cwd()) {
  const projections = [];
  const newestIntentAt = newestIntentDate(cwd);
  let status = { drifted: [] };
  let targets = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules'];
  try {
    const selfheal = require('./selfheal');
    status = selfheal.projectionStatus({ cwd });
    targets = selfheal.TARGET_FILES;
  } catch { /* fall back to the known target list */ }
  for (const file of targets) {
    const filePath = path.join(cwd, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const generated = content.match(/Auto-synced by `phewsh seq` \| (\d{4}-\d{2}-\d{2})/);
      const hasBlock = content.includes('<!-- PHEWSH:START -->') && content.includes('<!-- PHEWSH:END -->');
      if (hasBlock) projections.push({
        file,
        generatedDate: generated ? generated[1] : null,
        modifiedAt: statDate(filePath),
        source: '.intent/ generated harness projection',
        stale: status.drifted.includes(file),
      });
    } catch { /* absent projection */ }
  }

  const contextPath = path.join(cwd, '.phewsh.context');
  if (fs.existsSync(contextPath)) projections.push({
    file: '.phewsh.context',
    generatedDate: null,
    modifiedAt: statDate(contextPath),
    source: '.intent/ generated projection',
    stale: newestIntentAt ? fs.statSync(contextPath).mtimeMs + 1000 < newestIntentAt.getTime() : false,
  });
  return projections;
}

function newestIntentDate(cwd) {
  const dir = path.join(cwd, '.intent');
  try {
    const newest = fs.readdirSync(dir)
      .filter(file => /\.(md|json)$/.test(file))
      .reduce((max, file) => Math.max(max, fs.statSync(path.join(dir, file)).mtimeMs), 0);
    return newest ? new Date(newest) : null;
  } catch {
    return null;
  }
}

function latestDeclaredDate(claims) {
  return claims.reduce((latest, claim) => {
    const value = claim.declaredUpdated;
    return value && (!latest || value > latest) ? value : latest;
  }, null);
}

function detectConflicts({ packageVersion, npmLatest, claims, projections, git, cwd }) {
  const conflicts = [];
  if (git.committedPackageVersion && git.committedPackageVersion !== packageVersion) {
    conflicts.push(`Working package is ${packageVersion}; Git HEAD contains ${git.committedPackageVersion}.`);
  }
  if (npmLatest.status === 'known' && npmLatest.version !== packageVersion) {
    conflicts.push(`Working package is ${packageVersion}; npm latest is ${npmLatest.version}.`);
  }
  const versionClaims = [];
  for (const item of loadClaimText(claims, cwd).filter(item => /\/(status|next)\.md$/.test(item.file))) {
    const matches = item.text.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g);
    for (const match of matches) versionClaims.push({ file: item.file, version: match[1] });
  }
  const latestByFile = new Map();
  for (const item of versionClaims) {
    const current = latestByFile.get(item.file);
    if (!current || compareVersions(item.version, current.version) > 0) latestByFile.set(item.file, item);
  }
  const staleVersions = [...latestByFile.values()].filter(item => item.version !== packageVersion);
  if (staleVersions.length) {
    const unique = staleVersions.map(item => `${item.file} latest claim is ${item.version}`);
    conflicts.push(`Package is ${packageVersion}; current-state intent disagrees: ${unique.join(', ')}.`);
  }

  const latest = latestDeclaredDate(claims);
  for (const projection of projections) {
    if (projection.stale) {
      conflicts.push(`${projection.file} is older than its authoritative .intent/ sources and should be regenerated.`);
    } else if (projection.file === '.phewsh.context' && latest && projection.generatedDate && projection.generatedDate < latest.slice(0, 10)) {
      conflicts.push(`${projection.file} was generated ${projection.generatedDate}, before authoritative intent updated ${latest.slice(0, 10)}.`);
    }
  }
  const statusDirty = [...git.tracked.map(item => item.file), ...git.untracked].includes('.intent/status.md');
  if (git.drift?.tracked && git.drift.commitsSince > 0 && !statusDirty) {
    conflicts.push(`${git.drift.commitsSince} commit(s) changed code since .intent/status.md was last updated (${git.drift.lastCommit}); its current-state claims may be stale.`);
  }
  if (git.tracked.length || git.untracked.length) {
    conflicts.push(`Worktree is dirty (${git.tracked.length} tracked, ${git.untracked.length} untracked); committed/generated state is not the whole current state.`);
  }
  for (const claim of claims.filter(item => item.invalid)) {
    conflicts.push(`${claim.file} is invalid and cannot be treated as authoritative structured intent.`);
  }
  return conflicts;
}

function localMemoryInfo() {
  const root = path.join(os.homedir(), '.phewsh');
  const countJson = relative => {
    try { return fs.readdirSync(path.join(root, relative)).filter(file => file.endsWith('.json')).length; }
    catch { return 0; }
  };
  return {
    root,
    available: fs.existsSync(root),
    outcomes: fs.existsSync(path.join(root, 'outcomes', 'decisions.json')),
    sessionFiles: countJson('sessions'),
    resultFiles: countJson('results'),
    briefFiles: (() => {
      const briefs = path.join(root, 'briefs');
      try {
        return fs.readdirSync(briefs).reduce((count, project) => {
          try { return count + fs.readdirSync(path.join(briefs, project)).filter(file => file.endsWith('.md')).length; }
          catch { return count; }
        }, 0);
      } catch { return 0; }
    })(),
    ambient: fs.existsSync(path.join(root, 'ambient.json')),
    portability: 'machine-local unless explicitly copied or promoted',
  };
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function currentNarrativeText(text) {
  return String(text || '').split(/^##\s+(?:Archive|Archived)\b.*$/im)[0];
}

function loadClaimText(claims, cwd) {
  return claims.map(claim => {
    const filePath = path.join(cwd, claim.file);
    try { return { file: claim.file, text: currentNarrativeText(fs.readFileSync(filePath, 'utf-8')) }; }
    catch { return { file: claim.file, text: '' }; }
  });
}

async function fetchNpmLatest(packageName, { fetchImpl = global.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return { status: 'unknown', reason: 'offline or fetch unavailable' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return { status: 'unknown', reason: `registry returned HTTP ${response.status}` };
    const data = await response.json();
    return data && data.version
      ? { status: 'known', version: String(data.version) }
      : { status: 'unknown', reason: 'registry response had no version' };
  } catch {
    return { status: 'unknown', reason: 'offline or registry unavailable' };
  }
}

// Fast, offline, fail-soft snapshot for the front-door cockpit — no npm fetch,
// no file hashing. Answers "what verified truth is loaded?" at a glance so the
// product thesis (one verified truth) is visible the moment phewsh opens.
// Cheap, offline version-claim drift: does the shipped package version sit ahead
// of the newest version the .intent narrative still claims? This is the SHARP
// staleness signal the front door was missing — the recency-based "commits since
// .intent changed" check goes quiet the moment you edit status.md, even if its
// headline claim is stale. We compare the project's package version (repo root,
// or a cli/ monorepo child like phewsh itself) to the max version mentioned in
// status.md/next.md, and only flag when code has shipped PAST the docs.
function quickVersionDrift(cwd = process.cwd()) {
  try {
    let shipped = null;
    for (const rel of ['package.json', 'cli/package.json']) {
      const p = path.join(cwd, rel);
      if (!fs.existsSync(p)) continue;
      try { shipped = JSON.parse(fs.readFileSync(p, 'utf-8')).version; } catch { /* unreadable */ }
      if (shipped) break;
    }
    if (!shipped) return null;
    let claimed = null;
    for (const rel of ['.intent/status.md', '.intent/next.md']) {
      const p = path.join(cwd, rel);
      if (!fs.existsSync(p)) continue;
      const current = currentNarrativeText(fs.readFileSync(p, 'utf-8'));
      for (const m of current.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)) {
        if (!claimed || compareVersions(m[1], claimed) > 0) claimed = m[1];
      }
    }
    if (!claimed) return null;
    return compareVersions(shipped, claimed) > 0 ? { shipped, claimed } : null;
  } catch {
    return null;
  }
}

function quickVerifiedState(cwd = process.cwd()) {
  try {
    const git = gitSnapshot(cwd);
    const versionDrift = quickVersionDrift(cwd);
    if (!git.available) return { available: false, isRepo: false, versionDrift };
    return {
      available: true,
      isRepo: true,
      shortHead: git.shortHead,
      dirtyCount: git.tracked.length + git.untracked.length,
      driftCommits: git.drift?.tracked ? git.drift.commitsSince : 0,
      versionDrift,
    };
  } catch {
    return { available: false, isRepo: false };
  }
}

async function auditTruth({
  cwd = process.cwd(),
  packageJsonPath = path.join(__dirname, '..', 'package.json'),
  fetchImpl = global.fetch,
  npmLatest,
  outcomes,
  receipts,
} = {}) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const git = gitSnapshot(cwd, packageJsonPath);
  const claims = intentClaims(cwd);
  const projections = projectionInfo(cwd);
  const latest = npmLatest || (process.env.PHEWSH_OFFLINE === '1'
    ? { status: 'unknown', reason: 'offline mode' }
    : await fetchNpmLatest(pkg.name, { fetchImpl }));
  const project = path.basename(cwd);
  const outcomeData = outcomes || outcomeEvidence({ project });
  const receiptData = receipts || gatherReceipts({ project, limit: 5 }).summary;
  const conflicts = detectConflicts({ packageVersion: pkg.version, npmLatest: latest, claims, projections, git, cwd });
  const unknowns = [
    'Remote Git state was not fetched by this read-only audit.',
    'Conversation reasoning that was not promoted into durable files cannot be verified.',
    'Deployment state is unknown unless a deployment provider is checked separately.',
  ];
  if (latest.status !== 'known') unknowns.push(`npm publication state is unknown: ${latest.reason}.`);
  return {
    auditedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
    package: { name: pkg.name, version: pkg.version, npmLatest: latest },
    git,
    intent: { authoritative: claims },
    projections,
    outcomes: outcomeData,
    receipts: receiptData,
    localMemory: localMemoryInfo(),
    sourceContract: SOURCE_CONTRACT,
    resolutionOrder: RESOLUTION_ORDER,
    conflicts,
    unknowns,
    persistence: {
      survivesClone: ['Git HEAD and committed files', '.intent/ authoritative artifacts', 'committed generated projections such as CLAUDE.md'],
      machineLocal: ['tracked and untracked worktree changes until committed', '~/.phewsh config, outcomes, receipts, sessions, and credentials', 'installed harnesses and npm registry reachability'],
    },
  };
}

function formatTruth(report) {
  const lines = [];
  const latest = report.package.npmLatest.status === 'known'
    ? report.package.npmLatest.version
    : `unknown (${report.package.npmLatest.reason})`;
  lines.push(`Truth audit (read-only)`);
  lines.push(`Runtime: Node ${report.runtime.node} on ${report.runtime.platform}`);
  lines.push(`Package: ${report.package.name} ${report.package.version}; npm latest: ${latest}`);
  const gitHead = !report.git.available
    ? 'unknown (not a Git worktree)'
    : report.git.head
      ? `${report.git.shortHead} (${report.git.head})`
      : 'unborn (Git worktree; no commits yet)';
  lines.push(`Git HEAD: ${gitHead}`);
  if (report.git.committedPackageVersion) lines.push(`Package at Git HEAD: ${report.git.committedPackageVersion}`);
  lines.push(`Dirty tracked: ${report.git.tracked.length ? report.git.tracked.map(item => `${item.code} ${item.file}`).join(', ') : 'none'}`);
  lines.push(`Dirty untracked: ${report.git.untracked.length ? report.git.untracked.join(', ') : 'none'}`);
  lines.push('');
  lines.push('Authoritative intent:');
  if (!report.intent.authoritative.length) lines.push('- none');
  for (const claim of report.intent.authoritative) {
    lines.push(`- ${claim.file} [${claim.kind}] declared ${claim.declaredUpdated || 'unknown'}; modified ${claim.modifiedAt || 'unknown'}; ${claim.summary}`);
    claim.details.forEach(detail => lines.push(`  ${detail}`));
  }
  lines.push('');
  lines.push('Historical evidence:');
  lines.push(`- Outcomes: ${report.outcomes.total} routed; ${report.outcomes.judged} human-judged; ${report.outcomes.pending} pending; ${report.outcomes.autoFailed} automatic route failures`);
  lines.push(`- Receipts: ${report.receipts.totalEvents} events; ${report.receipts.completed} completed; ${report.receipts.failed} failed; ${report.receipts.blocked} blocked`);
  lines.push('');
  lines.push('Local-only memory:');
  lines.push(`- ~/.phewsh: ${report.localMemory.available ? 'present' : 'absent'}; ${report.localMemory.sessionFiles} session file(s); ${report.localMemory.resultFiles} result file(s); ${report.localMemory.briefFiles} saved briefing(s); outcomes ${report.localMemory.outcomes ? 'present' : 'absent'}`);
  lines.push(`- Portability: ${report.localMemory.portability}`);
  lines.push('');
  lines.push('Generated projections:');
  if (!report.projections.length) lines.push('- none');
  for (const projection of report.projections) {
    lines.push(`- ${projection.file}: ${projection.source}; generated ${projection.generatedDate || 'unknown'}; modified ${projection.modifiedAt || 'unknown'}; ${projection.stale ? 'stale' : 'current by timestamp'}`);
  }
  lines.push('');
  lines.push('Conflicts:');
  if (!report.conflicts.length) lines.push('- none detected');
  report.conflicts.forEach(conflict => lines.push(`- ${conflict}`));
  lines.push('');
  lines.push('Unknowns:');
  report.unknowns.forEach(item => lines.push(`- ${item}`));
  lines.push('');
  lines.push('Source contract:');
  report.sourceContract.forEach(item => lines.push(`- ${item.category} [${item.authority}]: ${item.sources.join(', ')}`));
  lines.push(`Resolution order: ${report.resolutionOrder.join(' -> ')}`);
  lines.push('Conflicts stay visible; generated context and memory never override stronger evidence.');
  lines.push('');
  lines.push('Survives clone:');
  report.persistence.survivesClone.forEach(item => lines.push(`- ${item}`));
  lines.push('Machine-local:');
  report.persistence.machineLocal.forEach(item => lines.push(`- ${item}`));
  return lines.join('\n');
}

module.exports = {
  auditTruth,
  fetchNpmLatest,
  formatTruth,
  gitSnapshot,
  intentClaims,
  parsePorcelain,
  projectionInfo,
  quickVerifiedState,
  quickVersionDrift,
  statusDrift,
};
