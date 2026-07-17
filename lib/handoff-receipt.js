// Cross-harness handoff receipts.
//
// A receipt proves the portable project state Phewsh could observe at handoff
// time. It does not claim that a model understood the brief, remember a chat,
// or carried private reasoning. Receipts stay machine-local under ~/.phewsh;
// `.intent/` remains the portable truth being fingerprinted, not a log sink.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { normalizeRemote } = require('./team-tasks');

const SCHEMA = 1;
const MAX_DIRTY_HASH_BYTES = 10 * 1024 * 1024;
const NOT_CARRIED = [
  { item: 'conversation transcript', reason: 'never captured' },
  { item: 'model reasoning', reason: 'never captured' },
  { item: 'editor buffers', reason: 'outside Phewsh evidence' },
  { item: 'harness-local memory', reason: 'tool-owned and not portable' },
  { item: 'unrecorded decisions', reason: 'cannot be verified until written to the Record' },
];

function handoffsDir() {
  return path.join(os.homedir(), '.phewsh', 'handoffs');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash('sha256').update(body).digest('hex');
}

function seal(receipt) {
  const { integrity: _ignored, ...body } = receipt;
  return { ...body, integrity: digest(canonical(body)) };
}

function fileHash(file) {
  return digest(fs.readFileSync(file));
}

function atomicWriteJson(file, value, { mode = 0o600 } = {}) {
  const body = JSON.stringify(value, null, 2) + '\n';
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    // rename preserves the temp file mode on POSIX. Keep this explicit for
    // platforms and filesystems whose defaults differ.
    try { fs.chmodSync(file, mode); } catch { /* best-effort on Windows */ }
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(temp); } catch { /* absent or already renamed */ }
    throw err;
  }
}

function walkFiles(dir, base = dir) {
  const files = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, base));
    else if (entry.isFile()) {
      const relative = path.relative(base, absolute).split(path.sep).join('/');
      try { files.push({ path: `.intent/${relative}`, sha256: fileHash(absolute) }); }
      catch { files.push({ path: `.intent/${relative}`, sha256: null, unreadable: true }); }
    }
  }
  return files;
}

function intentFingerprints(cwd = process.cwd()) {
  return walkFiles(path.join(cwd, '.intent'));
}

function statusPath(item) {
  const file = typeof item === 'string' ? item : item.file;
  return file.includes(' -> ') ? file.split(' -> ').pop() : file;
}

function dirtyFingerprint(cwd, file) {
  try {
    const absolute = path.join(cwd, file);
    const size = fs.statSync(absolute).size;
    if (size > MAX_DIRTY_HASH_BYTES) {
      return { path: file, sha256: null, size, unverifiable: 'over-size-limit' };
    }
    return { path: file, sha256: fileHash(absolute), size };
  }
  catch { return { path: file, sha256: null, missing: true }; }
}

function reportRepository(report, cwd) {
  if (!report?.git?.available) return { available: false };
  const current = liveRepository(cwd);
  if (current.available) return current;
  const dirty = [
    ...(report.git.tracked || []).map(statusPath),
    ...(report.git.untracked || []).map(statusPath),
  ].sort().map(file => dirtyFingerprint(cwd, file));
  return { available: true, head: report.git.head, dirty };
}

function liveRepository(cwd) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parts = raw.split('\0').filter(Boolean);
    const paths = [];
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      const code = line.slice(0, 2);
      paths.push(line.slice(3));
      if (/[RC]/.test(code)) i++; // -z emits the original rename/copy path next
    }
    const dirty = paths
      .sort()
      .map(file => dirtyFingerprint(cwd, file));
    return { available: true, head, dirty };
  } catch { return { available: false }; }
}

function canonicalRoot(cwd) {
  try { return fs.realpathSync(path.resolve(cwd)); } catch { return path.resolve(cwd); }
}

function projectIdentity(cwd) {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const normalized = normalizeRemote(remote);
    if (normalized) return { kind: 'git-remote', value: normalized };
  } catch { /* local fallback below */ }
  return { kind: 'local-root', value: digest(canonicalRoot(cwd)) };
}

function projectFolder(cwd, root = handoffsDir()) {
  const identity = projectIdentity(cwd);
  const fingerprint = digest(`${identity.kind}:${identity.value}`).slice(0, 10);
  return path.join(root, `project-${fingerprint}`);
}

function createHandoffReceipt({
  cwd = process.cwd(),
  report,
  fromRoute = 'phewsh',
  toRoute = 'unselected',
  trigger = 'explicit-handoff',
  now = new Date(),
  root = handoffsDir(),
} = {}) {
  const createdAt = now.toISOString();
  const resolvedRoot = canonicalRoot(cwd);
  const identity = projectIdentity(cwd);
  const base = {
    schema: SCHEMA,
    kind: 'handoff',
    created_at: createdAt,
    project: {
      name: path.basename(resolvedRoot),
      identity,
    },
    trigger,
    routes: { from: fromRoute || 'unknown', to: toRoute || 'unselected' },
    carried: {
      intent: intentFingerprints(cwd),
      repository: reportRepository(report, cwd),
      brief: null,
    },
    not_carried: NOT_CARRIED,
    claims: [],
  };
  const id = `h-${digest(canonical(base)).slice(0, 10)}`;
  const receipt = seal({ ...base, id });
  const stamp = createdAt.replace(/[:.]/g, '-');
  const file = path.join(projectFolder(cwd, root), `${stamp}-${id}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteJson(file, receipt);
    return { written: true, file, receipt };
  } catch (err) {
    return { written: false, file: null, receipt, reason: err.message };
  }
}

function readReceipt(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function integrityValid(receipt) {
  if (!receipt || typeof receipt !== 'object' || !receipt.integrity) return false;
  const { integrity, ...body } = receipt;
  return integrity === digest(canonical(body));
}

function changedPaths(before, after) {
  const oldMap = new Map((before || []).map(item => [item.path, item.sha256]));
  const newMap = new Map((after || []).map(item => [item.path, item.sha256]));
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  return [...paths].filter(file => oldMap.get(file) !== newMap.get(file)).sort();
}

function verifyHandoffReceipt(receiptOrFile, {
  cwd = process.cwd(),
  phewshRoot = path.join(os.homedir(), '.phewsh'),
} = {}) {
  const file = typeof receiptOrFile === 'string' ? receiptOrFile : null;
  const receipt = file ? readReceipt(file) : receiptOrFile;
  if (!receipt) return { status: 'invalid', id: null, file, reason: 'unreadable receipt' };
  if (!integrityValid(receipt)) {
    return { status: 'invalid', id: receipt.id || null, file, receipt, reason: 'integrity mismatch' };
  }
  if (receipt.schema !== SCHEMA || receipt.kind !== 'handoff') {
    return { status: 'invalid', id: receipt.id || null, file, receipt, reason: 'unsupported receipt schema' };
  }

  const currentIdentity = projectIdentity(cwd);
  if (canonical(receipt.project?.identity) !== canonical(currentIdentity)) {
    return { status: 'invalid', id: receipt.id, file, receipt, reason: 'receipt belongs to another project identity' };
  }

  const truthChanged = changedPaths(receipt.carried?.intent, intentFingerprints(cwd));
  const briefChanged = [];
  const brief = receipt.carried?.brief;
  if (brief) {
    if (!brief.path) briefChanged.push('handoff brief location is not recorded');
    else {
      const briefFile = path.resolve(phewshRoot, brief.path);
      const insideRoot = briefFile === path.resolve(phewshRoot)
        || briefFile.startsWith(path.resolve(phewshRoot) + path.sep);
      if (!insideRoot) briefChanged.push('handoff brief path is invalid');
      else {
        try {
          if (fileHash(briefFile) !== brief.sha256) briefChanged.push('handoff brief changed');
        } catch { briefChanged.push('handoff brief missing'); }
      }
    }
  }
  const beforeRepo = receipt.carried?.repository || { available: false };
  const afterRepo = liveRepository(cwd);
  const repositoryChanged = [];
  const repositoryPartial = [];
  if (beforeRepo.available !== afterRepo.available) repositoryChanged.push('Git availability changed');
  if (beforeRepo.available && afterRepo.available) {
    if (beforeRepo.head !== afterRepo.head) repositoryChanged.push('Git HEAD changed');
    const dirtyChanged = changedPaths(beforeRepo.dirty, afterRepo.dirty);
    repositoryChanged.push(...dirtyChanged.map(file => `working path changed: ${file}`));
    const partial = new Set([...(beforeRepo.dirty || []), ...(afterRepo.dirty || [])]
      .filter(item => item.unverifiable)
      .map(item => item.path));
    repositoryPartial.push(...[...partial].sort().map(file => `working path not fingerprinted (over 10 MB): ${file}`));
  }

  const moved = truthChanged.length || repositoryChanged.length || briefChanged.length;
  return {
    status: moved ? 'moved' : (repositoryPartial.length ? 'partial' : 'verified'),
    id: receipt.id,
    createdAt: receipt.created_at,
    file,
    receipt,
    truthChanged,
    repositoryChanged,
    repositoryPartial,
    briefChanged,
    notCarried: receipt.not_carried || [],
  };
}

function latestHandoffReceipt({
  cwd = process.cwd(),
  root = handoffsDir(),
  phewshRoot = path.join(os.homedir(), '.phewsh'),
} = {}) {
  const dir = projectFolder(cwd, root);
  let files = [];
  try { files = fs.readdirSync(dir).filter(file => file.endsWith('.json')).sort().reverse(); } catch { return null; }
  if (!files.length) return null;
  return verifyHandoffReceipt(path.join(dir, files[0]), { cwd, phewshRoot });
}

function attachBrief(file, sha256, briefFile, { phewshRoot = path.join(os.homedir(), '.phewsh') } = {}) {
  const receipt = readReceipt(file);
  if (!receipt || !integrityValid(receipt)) return { written: false, reason: 'receipt is invalid' };
  let relative = null;
  if (briefFile) {
    const candidate = path.relative(path.resolve(phewshRoot), path.resolve(briefFile));
    if (candidate && candidate !== '..' && !candidate.startsWith('..' + path.sep) && !path.isAbsolute(candidate)) {
      relative = candidate.split(path.sep).join('/');
    }
  }
  receipt.carried = receipt.carried || {};
  receipt.carried.brief = sha256 ? { sha256, path: relative } : null;
  const updated = seal(receipt);
  try {
    atomicWriteJson(file, updated);
    return { written: true, file, receipt: updated };
  } catch (err) { return { written: false, file, reason: err.message }; }
}

function summarizeEvidence(items, limit = 3) {
  const evidence = (items || []).filter(Boolean).map(item => {
    const text = String(item);
    return text.length > 120 ? text.slice(0, 117) + '...' : text;
  });
  if (!evidence.length) return 'observed state changed';
  const visible = evidence.slice(0, limit).join(', ');
  const remaining = evidence.length - limit;
  return remaining > 0
    ? `${visible}, … +${remaining} more (${evidence.length} changes total)`
    : visible;
}

function handoffSummary(result) {
  if (!result) return 'no handoff receipt — cold start from .intent/ only';
  if (result.status === 'invalid') return `handoff ${result.id || 'receipt'} invalid — ${result.reason}`;
  if (result.status === 'partial') return `handoff ${result.id} partial — ${summarizeEvidence(result.repositoryPartial)}`;
  if (result.status === 'verified') {
    const trigger = result.receipt?.trigger === 'work-start' ? ' at work start' : '';
    return `handoff ${result.id} verified${trigger} — truth and repository unchanged`;
  }
  const moved = [...(result.truthChanged || []), ...(result.repositoryChanged || []), ...(result.briefChanged || [])];
  return `handoff ${result.id} moved — ${summarizeEvidence(moved)}`;
}

module.exports = {
  SCHEMA,
  MAX_DIRTY_HASH_BYTES,
  NOT_CARRIED,
  handoffsDir,
  canonical,
  digest,
  projectIdentity,
  intentFingerprints,
  createHandoffReceipt,
  verifyHandoffReceipt,
  latestHandoffReceipt,
  attachBrief,
  summarizeEvidence,
  handoffSummary,
  integrityValid,
};
