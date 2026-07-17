// phewsh shims — the GUARANTEE layer.
//
// The lesson from four dogfood rounds: a model can't be relied on to prove
// phewsh is active (it may flag a prose block, or ignore it). So phewsh proves
// it ITSELF. A shim is a tiny script named like the user's tool (`claude`,
// `codex`, …) placed first on PATH. When the user runs `claude`, the shim:
//   1. prints a deterministic phewsh status banner (phewsh prints it — not the
//      model, so it's guaranteed), then
//   2. exec's the REAL tool, unchanged.
//
// NON-NEGOTIABLE SAFETY: the shim must ALWAYS run the real tool, even if phewsh
// is broken, missing, or slow. The banner is best-effort; the hand-off is not.
// We bake the resolved real path into the shim and add a PATH-stripped fallback,
// so the user's tools can never be bricked by phewsh.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const PHEWSH_DIR = path.join(os.homedir(), '.phewsh');
const SHIM_DIR = path.join(PHEWSH_DIR, 'shims');

const RC_START = '# >>> phewsh shims >>>';
const RC_END = '# <<< phewsh shims <<<';
const RC_BLOCK = `${RC_START}\nexport PATH="$HOME/.phewsh/shims:$PATH"\n${RC_END}`;

// Resolve a tool's REAL binary, excluding our own shim dir so we never resolve
// the shim to itself. Returns absolute path or null.
function resolveReal(bin) {
  // Only ever called with bins from the fixed harness registry — but keep it
  // strict anyway so this can never become a shell-injection surface.
  if (!/^[A-Za-z0-9_.-]+$/.test(bin)) return null;
  try {
    const cleanPath = (process.env.PATH || '')
      .split(path.delimiter)
      .filter(p => p && path.resolve(p) !== path.resolve(SHIM_DIR))
      .join(path.delimiter);
    const cmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    const out = execFileSync('sh', ['-c', cmd], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: cleanPath },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim().split('\n')[0].trim();
    return out && path.resolve(out) !== path.resolve(SHIM_DIR, bin) ? out : null;
  } catch { return null; }
}

// The shim script. POSIX sh. Real path is baked in; phewsh banner is wrapped so
// any failure is swallowed; the real exec is the last, unconditional step.
function shimScript(bin, realPath) {
  return `#!/bin/sh
# phewsh shim for ${bin} — prints a status banner, then runs the real tool.
# SAFETY: phewsh is best-effort; the real ${bin} ALWAYS runs.
phewsh shim-preflight ${bin} 2>/dev/null || true
REAL="${realPath}"
if [ -x "$REAL" ]; then exec "$REAL" "$@"; fi
# Fallback: find the real ${bin} on PATH, excluding our shim dir.
CLEAN="$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "${SHIM_DIR}" | paste -sd: -)"
REAL2="$(PATH="$CLEAN" command -v ${bin} 2>/dev/null)"
if [ -n "$REAL2" ]; then exec "$REAL2" "$@"; fi
echo "phewsh: could not locate the real '${bin}'." >&2
exit 127
`;
}

// First meaningful line of a markdown file — past YAML frontmatter and headings.
function firstLine(file, max = 64) {
  try {
    let body = fs.readFileSync(file, 'utf-8');
    if (body.startsWith('---')) { const e = body.indexOf('\n---', 3); if (e !== -1) body = body.slice(e + 4); }
    const line = body.split('\n').map(l => l.trim())
      .find(l => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---'));
    if (!line) return null;
    const clean = line.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
  } catch { return null; }
}

// How many decisions phewsh has recorded for this project (cwd basename key).
function decisionCount(cwd) {
  try {
    const file = path.join(PHEWSH_DIR, 'outcomes', 'decisions.json');
    const all = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const key = path.basename(cwd);
    const list = Array.isArray(all) ? all : (all.decisions || []);
    return list.filter(d => (d.project || d.cwd && path.basename(d.cwd)) === key).length;
  } catch { return 0; }
}

// Per-repo nudge counter — so the "create intent" coaching shows for the first
// few launches then goes quiet (a coach, not a billboard). Best-effort.
function bumpNudge(cwd) {
  try {
    const file = path.join(PHEWSH_DIR, 'shim-seen.json');
    let seen = {};
    try { seen = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* fresh */ }
    seen[cwd] = (seen[cwd] || 0) + 1;
    fs.mkdirSync(PHEWSH_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seen));
    return seen[cwd];
  } catch { return 99; } // on failure, assume "seen" so we don't nag
}

// Deterministic launch banner — computed by phewsh, offline, fast. Evidence +
// VALUE + GUIDANCE, not just "active". phewsh prints it, so it's guaranteed.
const C = { teal: s => `\x1b[38;5;79m${s}\x1b[0m`, sage: s => `\x1b[38;5;151m${s}\x1b[0m`, slate: s => `\x1b[38;5;247m${s}\x1b[0m`, cream: s => `\x1b[38;5;230m${s}\x1b[0m`, peach: s => `\x1b[38;5;216m${s}\x1b[0m` };
function preflightBanner(bin, cwd = process.cwd()) {
  try {
    const intentDir = path.join(cwd, '.intent');
    if (!fs.existsSync(intentDir)) {
      // No shared truth here. Coach (first few launches per repo), then go quiet.
      const n = bumpNudge(cwd);
      if (n <= 3) {
        return `${C.sage('😮‍💨🤫 phewsh')} ${C.slate('· no shared project truth here yet')}\n`
          + `   ${C.slate('so supported tools can read the same truth, create it:')} ${C.cream('phewsh init')} ${C.slate('· → ' + bin)}`;
      }
      return `${C.sage('😮‍💨🤫 phewsh active')} ${C.slate('· → ' + bin)}`;
    }
    // Truth present — compact health line (like `git status` in a prompt, not a
    // dump). Details live in `phewsh status`. One launch = one glance.
    const files = fs.readdirSync(intentDir).filter(f => /\.(md|json)$/.test(f)).length;
    let record = 'current';
    try {
      const { statusDrift } = require('./truth');
      const d = statusDrift(cwd);
      if (d && d.tracked && d.commitsSince > 0) record = `${d.commitsSince} behind`;
    } catch { /* nicety */ }
    let nextBit = '';
    try { const c = require('./next').counts(cwd); if (c.now + c.next > 0) nextBit = ' · next: ' + (c.now + c.next) + ' open'; } catch { /* nicety */ }
    // The four words, compact: Project · Next · Record (Work = this launch).
    return `${C.sage('😮‍💨 phewsh')} ${C.teal('✓')}  ${C.slate('project: ' + files + ' files' + nextBit + ' · record: ' + record)}  ${C.slate('· phewsh status → ' + bin)}`;
  } catch {
    return `😮‍💨🤫 phewsh active · → ${bin}`; // never break the launch
  }
}

// ── shell rc (PATH activation) ──────────────────────────────────────────
function detectRcFile() {
  const home = os.homedir();
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return path.join(home, '.zshrc');
  if (shell.includes('bash')) {
    const bp = path.join(home, '.bashrc');
    return fs.existsSync(bp) ? bp : path.join(home, '.bash_profile');
  }
  // default to zsh rc on macOS, bashrc elsewhere
  return path.join(home, process.platform === 'darwin' ? '.zshrc' : '.bashrc');
}

function rcHasBlock(rcFile) {
  try { return fs.readFileSync(rcFile, 'utf-8').includes(RC_START); } catch { return false; }
}

function addRcBlock(rcFile) {
  let existing = '';
  try { existing = fs.readFileSync(rcFile, 'utf-8'); } catch { /* new file */ }
  if (existing.includes(RC_START)) return false;
  const next = (existing.replace(/\s*$/, '') + '\n\n' + RC_BLOCK + '\n').replace(/^\n+/, '');
  fs.writeFileSync(rcFile, next);
  return true;
}

function removeRcBlock(rcFile) {
  try {
    const existing = fs.readFileSync(rcFile, 'utf-8');
    if (!existing.includes(RC_START)) return false;
    const re = new RegExp('\\n*' + RC_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '[\\s\\S]*?' + RC_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n*', 'g');
    fs.writeFileSync(rcFile, existing.replace(re, '\n').replace(/^\n+/, ''));
    return true;
  } catch { return false; }
}

// ── install / remove ─────────────────────────────────────────────────────
// Install shims for the given harness bins that actually resolve to a real
// binary. Returns { shimmed:[{bin,real}], rcFile, rcAdded, skipped:[bin] }.
function installShims(bins) {
  fs.mkdirSync(SHIM_DIR, { recursive: true });
  const shimmed = [];
  const skipped = [];
  for (const bin of bins) {
    const real = resolveReal(bin);
    if (!real) { skipped.push(bin); continue; }     // don't shim what we can't hand off to
    const shimPath = path.join(SHIM_DIR, bin);
    fs.writeFileSync(shimPath, shimScript(bin, real), { mode: 0o755 });
    fs.chmodSync(shimPath, 0o755);
    shimmed.push({ bin, real });
  }
  const rcFile = detectRcFile();
  const rcAdded = shimmed.length > 0 ? addRcBlock(rcFile) : false;
  return { shimmed, skipped, rcFile, rcAdded };
}

function removeShims() {
  const removed = [];
  try {
    if (fs.existsSync(SHIM_DIR)) {
      for (const f of fs.readdirSync(SHIM_DIR)) {
        fs.unlinkSync(path.join(SHIM_DIR, f));
        removed.push(f);
      }
      fs.rmdirSync(SHIM_DIR);
    }
  } catch { /* best-effort */ }
  const rcFile = detectRcFile();
  const rcRemoved = removeRcBlock(rcFile);
  return { removed, rcFile, rcRemoved };
}

function shimStatus() {
  let installed = [];
  try { installed = fs.existsSync(SHIM_DIR) ? fs.readdirSync(SHIM_DIR) : []; } catch { /* none */ }
  const rcFile = detectRcFile();
  return { installed, shimDir: SHIM_DIR, rcFile, rcActive: rcHasBlock(rcFile), onPath: (process.env.PATH || '').split(path.delimiter).some(p => path.resolve(p) === path.resolve(SHIM_DIR)) };
}

module.exports = {
  SHIM_DIR, resolveReal, preflightBanner, installShims, removeShims, shimStatus,
  detectRcFile, addRcBlock, removeRcBlock,
};
