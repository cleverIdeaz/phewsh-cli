// Self-healing continuity — phewsh keeps each harness's managed context block
// current from .intent/ so the user never has to run `seq -w` by hand. This is
// the deterministic half of the trust promise: one canonical core, projected
// into native files while preserving human-authored content around it.
//
// Pure-ish and safe: never throws, never blocks the host. Returns a small
// result the caller can render ("✓ kept your CLAUDE.md current — you didn't
// have to"). The LLM-assisted half (drafting next.md/status.md from a session)
// lives elsewhere; this layer needs no model and works fully offline.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const INTENT_FILES_RE = /\.(md|json)$/;
const TARGET_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules'];
const START_MARKER = '<!-- PHEWSH:START -->';
const END_MARKER = '<!-- PHEWSH:END -->';

// Newest mtime among .intent/ artifacts, or 0 if none / unreadable.
function newestIntentMs(intentDir) {
  try {
    return fs.readdirSync(intentDir)
      .filter(f => INTENT_FILES_RE.test(f))
      .reduce((m, f) => {
        try { return Math.max(m, fs.statSync(path.join(intentDir, f)).mtimeMs); }
        catch { return m; }
      }, 0);
  } catch { return 0; }
}

/**
 * Has any existing harness projection drifted from the canonical generated
 * core? Missing files are not created by this check; deliberate sync points
 * decide when to seed them.
 * @param {string} [cwd]
 */
function isStale(cwd = process.cwd()) {
  return projectionStatus({ cwd }).stale;
}

/**
 * Re-sequence .intent/ into every existing harness projection if any managed
 * block drifted. It never creates files merely because phewsh was launched.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {boolean} [opts.force]  resync even if not detected stale
 * @returns {{ healed: boolean, synced?: string[], reason?: string }}
 */
function heal({ cwd = process.cwd(), force = false } = {}) {
  try {
    if (!force && !isStale(cwd)) return { healed: false, reason: 'fresh' };
    const result = syncContextFiles({ cwd, createMissing: false });
    return { healed: result.synced.length > 0, synced: result.synced, reason: result.reason };
  } catch (err) {
    return { healed: false, reason: err && err.message ? err.message : 'error' };
  }
}

// ── Multi-tool context sync ──────────────────────────────────────────────
// phewsh keeps EVERY harness's native context file current from .intent/, not
// just CLAUDE.md — so opening Codex (AGENTS.md), Gemini (GEMINI.md), or Cursor
// (.cursorrules) in a phewsh project reads the same truth Claude Code does.
// Same proven marker pattern (block between PHEWSH:START/END, rest preserved),
// plus a verifiable signed footer so "is it current?" is `cat`-able, not vibes.
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Strip the volatile signed footer so timestamp-only changes don't cause churn.
// Covers both the project ("synced by phewsh") and global ("installed by
// phewsh") footers — otherwise the timestamp leaks into the diff and re-running
// rewrites every file every time.
function coreOf(text) {
  return text
    .replace(/Auto-synced by `phewsh seq` \| \d{4}-\d{2}-\d{2}/g, 'Auto-synced by `phewsh seq` | <date>')
    .replace(/\n?>\s*—\s*(synced|installed) by phewsh[\s\S]*$/m, '')
    .trim();
}

function sourceHash(core) {
  return crypto.createHash('sha256').update(coreOf(core)).digest('hex').slice(0, 10);
}

function markerCore(text) {
  const re = new RegExp(escapeRe(START_MARKER) + '([\\s\\S]*?)' + escapeRe(END_MARKER));
  const match = String(text || '').match(re);
  return match ? coreOf(match[1]) : null;
}

function footerSource(text) {
  const match = String(text || '').match(/>\s*—\s*synced by phewsh[^\n]*·\s*source\s+([a-f0-9]{10})/i);
  return match ? match[1] : null;
}

// Insert/replace the phewsh block between markers; create the file (with a
// short header) if absent; preserve everything outside the markers. Writes
// only when the substantive content changed (footer timestamp is ignored), so
// re-running every session doesn't churn files. Returns true if written.
function upsertBlock(filePath, core, footer, fileLabel, headerText) {
  try {
    const block = footer ? core.replace(/\s*$/, '') + '\n' + footer : core.replace(/\s*$/, '');
    const wrapped = `${START_MARKER}\n${block}\n${END_MARKER}`;
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    if (existing && existing.includes(START_MARKER) && existing.includes(END_MARKER)) {
      const re = new RegExp(escapeRe(START_MARKER) + '([\\s\\S]*?)' + escapeRe(END_MARKER));
      const m = existing.match(re);
      const expectedSource = footerSource(footer);
      if (m && coreOf(m[1]) === coreOf(core) &&
          (!expectedSource || footerSource(m[1]) === expectedSource)) return false;
      // A replacement function keeps canonical text such as "$10" from being
      // interpreted as a regex capture reference and duplicating old content.
      const next = existing.replace(re, () => wrapped);
      fs.writeFileSync(filePath, next);
    } else if (existing) {
      fs.writeFileSync(filePath, existing.replace(/\s*$/, '') + '\n\n' + wrapped + '\n');
    } else {
      const header = headerText != null
        ? headerText
        : `# ${fileLabel} — kept current by phewsh\n> Project context compiled from .intent/. The block below is auto-managed; edit outside the markers.\n\n`;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, header + wrapped + '\n');
    }
    return true;
  } catch { return false; }
}

// Remove phewsh's marker block from a file. If nothing but whitespace remains,
// delete the file (phewsh created it). Returns true if the file changed.
function removeBlock(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (!existing.includes(START_MARKER)) return false;
    const re = new RegExp(escapeRe(START_MARKER) + '[\\s\\S]*?' + escapeRe(END_MARKER), 'g');
    const next = existing.replace(re, '').trim();
    // If all that's left is phewsh's own scaffolding (the global HTML-comment
    // notice, or the generated "kept current by phewsh" header), phewsh created
    // the whole file — remove it. Otherwise keep the user's surrounding content.
    const residual = next
      .replace(/<!--\s*phewsh writes only the marked block[\s\S]*?-->/gi, '')
      .replace(/^#[^\n]*kept current by phewsh[^\n]*\n?/m, '')
      .replace(/^>\s*Project context compiled from \.intent\/[^\n]*\n?/m, '')
      .trim();
    if (!residual) { fs.unlinkSync(filePath); return true; }
    fs.writeFileSync(filePath, next + '\n');
    return true;
  } catch { return false; }
}

function buildContextCore(cwd = process.cwd()) {
  const { sequence } = require('./sequencer');
  const prev = process.cwd();
  let output;
  try {
    if (cwd !== prev) process.chdir(cwd);
    output = sequence({
      target: 'claude-md',
      sources: ['intent'],
      sourceNames: ['vision.md', 'project.json', 'status.md', 'next.md', 'next.json'],
      excludeChunkSources: [
        '.intent/project.json:actions',
        '.intent/project.json:responsibilities',
        '.intent/project.json:success',
      ],
      write: false,
    }).output;
  } finally {
    if (cwd !== prev) { try { process.chdir(prev); } catch { /* best-effort */ } }
  }
  if (!output) return null;
  const { PROJECT_GUIDANCE } = require('./ambient-guidance');
  return output.replace(/\s*$/, '') + '\n\n' + PROJECT_GUIDANCE;
}

function projectionStatus({ cwd = process.cwd(), targets = TARGET_FILES } = {}) {
  try {
    if (!fs.existsSync(path.join(cwd, '.intent'))) {
      return { stale: false, checked: [], drifted: [], reason: 'no-intent' };
    }
    const checked = targets.filter(file => fs.existsSync(path.join(cwd, file)));
    if (!checked.length) return { stale: false, checked, drifted: [], reason: 'no-projections' };
    const core = buildContextCore(cwd);
    if (!core) return { stale: false, checked, drifted: [], reason: 'no-output' };
    const drifted = checked.filter(file => {
      try {
        return markerCore(fs.readFileSync(path.join(cwd, file), 'utf-8')) !== coreOf(core);
      } catch {
        return true;
      }
    });
    return { stale: drifted.length > 0, checked, drifted, source: sourceHash(core) };
  } catch (err) {
    return { stale: false, checked: [], drifted: [], reason: err && err.message ? err.message : 'error' };
  }
}

// Build the phewsh block once (from .intent/ via the sequencer) and write it
// into every target tool's context file with a signed, timestamped footer.
// createMissing:false = refresh-only. Used by per-launch self-heal so merely
// opening phewsh in a repo never CREATES context files (which would dirty a
// clean tree unexpectedly) — it only keeps already-present ones fresh. File
// creation stays with deliberate acts (a real session's SessionEnd, /reconcile,
// `seq`), where the user is actually working in the project.
function syncContextFiles({ cwd = process.cwd(), targets = TARGET_FILES, createMissing = true } = {}) {
  try {
    cwd = require('./sequencer/discover').resolveProjectRoot(cwd);
    const intentDir = path.join(cwd, '.intent');
    if (!fs.existsSync(intentDir)) return { synced: [], reason: 'no-intent' };
    const core = buildContextCore(cwd);
    if (!core) return { synced: [], reason: 'no-output' };
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const footer = `> — synced by phewsh 😮‍💨🤫 · ${stamp} · source ${sourceHash(core)}`;
    const synced = [];
    for (const file of targets) {
      const fp = path.join(cwd, file);
      if (!createMissing && !fs.existsSync(fp)) continue; // refresh-only: don't seed a clean repo
      if (upsertBlock(fp, core, footer, file)) synced.push(file);
    }
    return { synced };
  } catch (err) { return { synced: [], reason: err && err.message ? err.message : 'error' }; }
}

// ── Layer 2: machine-wide base files ─────────────────────────────────────
// So a tool behaves like phewsh exists even OUTSIDE a phewsh project (a fresh
// repo, the home dir). We write the project-agnostic guidance into each tool's
// GLOBAL base context file — but ONLY for tools whose config dir already exists
// (honest: don't seed dirs for tools the user doesn't have). Marker-wrapped,
// signed, fully reversible via removeGlobalBaseFiles().
const GLOBAL_TARGETS = [
  { dir: '.claude', file: 'CLAUDE.md', label: 'Claude Code' },
  { dir: '.codex',  file: 'AGENTS.md', label: 'Codex' },
  { dir: '.gemini', file: 'GEMINI.md', label: 'Gemini' },
];

// Returns the list of {dir,file,label,path} targets whose tool dir exists.
function detectGlobalTargets() {
  const home = os.homedir();
  return GLOBAL_TARGETS
    .map(t => ({ ...t, path: path.join(home, t.dir, t.file) }))
    .filter(t => fs.existsSync(path.join(home, t.dir)));
}

function syncGlobalBaseFiles() {
  try {
    const { GLOBAL_GUIDANCE } = require('./ambient-guidance');
    // No header, no footer for the GLOBAL note — the marker pair is enough to
    // find/remove it, and any "installed by phewsh / undo / emoji" metadata is
    // exactly the self-referential noise that made a safety-tuned model
    // challenge the block. The block is now just the bare fact, marker-wrapped.
    const header = '';
    const footer = '';
    const written = [];
    for (const t of detectGlobalTargets()) {
      if (upsertBlock(t.path, GLOBAL_GUIDANCE, footer, t.label, header)) {
        written.push(path.join('~', t.dir, t.file));
      }
    }
    return { written };
  } catch (err) { return { written: [], reason: err && err.message ? err.message : 'error' }; }
}

// Refresh the global base files ONLY if the user already opted in (ledger shows
// globalBase applied). This propagates content fixes — e.g. de-escalating the
// guidance after a model flagged it — on the next launch with the new binary,
// without a manual re-run and without ever newly creating files unprompted.
// Idempotent (writes only when content changed), silent, never throws.
function refreshGlobalBaseFilesIfApplied() {
  try {
    const ledgerPath = path.join(os.homedir(), '.phewsh', 'ambient.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
    if (ledger && ledger.applied && ledger.applied.globalBase) {
      return syncGlobalBaseFiles();
    }
  } catch { /* not applied / no ledger — do nothing */ }
  return { written: [] };
}

function removeGlobalBaseFiles() {
  const home = os.homedir();
  const removed = [];
  for (const t of GLOBAL_TARGETS) {
    const fp = path.join(home, t.dir, t.file);
    if (removeBlock(fp)) removed.push(path.join('~', t.dir, t.file));
  }
  return { removed };
}

function removeProjectContextFiles({ cwd = process.cwd(), targets = TARGET_FILES } = {}) {
  const removed = [];
  for (const file of targets) {
    if (removeBlock(path.join(cwd, file))) removed.push(file);
  }
  return { removed };
}

// The deeper drift: code ships but .intent/ content never gets updated (the
// exact failure that ate phewsh's own dogfood — 16 versions shipped while
// next.md stayed days stale). Count git commits authored AFTER the newest
// .intent/ narrative file, so phewsh can notice "you've shipped but your intent
// is behind" and offer to fold it in. Best-effort: 0 if not a git repo / no git.
const NARRATIVE_FILES = ['vision.md', 'plan.md', 'status.md', 'next.md', 'narrative.md'];

function newestNarrativeMs(intentDir) {
  return NARRATIVE_FILES.reduce((m, f) => {
    try { return Math.max(m, fs.statSync(path.join(intentDir, f)).mtimeMs); }
    catch { return m; }
  }, 0);
}

function commitsSinceIntent(cwd = process.cwd()) {
  try {
    const intentDir = path.join(cwd, '.intent');
    if (!fs.existsSync(intentDir)) return 0;
    const since = newestNarrativeMs(intentDir);
    if (!since) return 0;
    const { execFileSync } = require('child_process');
    const iso = new Date(since).toISOString();
    // execFile (no shell) with args as an array — the date is machine-generated,
    // and array args mean there's no shell to inject into regardless.
    const out = execFileSync('git', ['log', `--since=${iso}`, '--oneline'], {
      cwd, encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(l => l.trim()).length;
  } catch { return 0; }
}

function worktreeChanges(cwd = process.cwd()) {
  try {
    const { execFileSync } = require('child_process');
    const raw = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd, encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return raw.split('\n').filter(Boolean).map(line => ({
      code: line.slice(0, 2),
      file: line.slice(3),
      untracked: line.slice(0, 2) === '??',
    }));
  } catch { return []; }
}

// Build a "what shipped since .intent/ was last updated" draft block straight
// from git commit subjects — deterministic, no LLM. This is the offline floor
// of `/wrap`: even with nothing connected, phewsh can fold real work into the
// record. (An LLM pass can later prose-ify this; the commits are the truth.)
function wrapDraft(cwd = process.cwd()) {
  try {
    const intentDir = path.join(cwd, '.intent');
    if (!fs.existsSync(intentDir)) return null;
    const since = newestNarrativeMs(intentDir);
    if (!since) return null;
    const { execFileSync } = require('child_process');
    const iso = new Date(since).toISOString();
    const raw = execFileSync('git', ['log', `--since=${iso}`, '--pretty=format:%s'], {
      cwd, encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const commits = raw.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .filter(s => !/^Merge (branch|pull|remote)/i.test(s)); // drop merge noise
    const dirty = worktreeChanges(cwd);
    if (commits.length === 0 && dirty.length === 0) return null;
    const date = new Date().toISOString().slice(0, 10);
    const block = commits.length
      ? `\n## Shipped since last update (folded in ${date})\n`
        + commits.map(s => `- ${s}`).join('\n') + '\n'
      : null;
    return { commits, dirty, block, date };
  } catch { return null; }
}

// Append a block to a .intent/ narrative file (default next.md), then heal so
// CLAUDE.md reflects it immediately. Returns { written: boolean, file }.
function appendToNext(block, { cwd = process.cwd(), file = 'next.md' } = {}) {
  try {
    const target = path.join(cwd, '.intent', file);
    if (!fs.existsSync(target)) return { written: false, file };
    fs.appendFileSync(target, block.endsWith('\n') ? block : block + '\n');
    heal({ cwd, force: true });
    return { written: true, file };
  } catch { return { written: false, file }; }
}

module.exports = {
  isStale, heal, newestIntentMs, newestNarrativeMs,
  commitsSinceIntent, worktreeChanges, wrapDraft, appendToNext,
  buildContextCore, projectionStatus, syncContextFiles, TARGET_FILES,
  syncGlobalBaseFiles, removeGlobalBaseFiles, removeProjectContextFiles, detectGlobalTargets,
  refreshGlobalBaseFilesIfApplied,
};
