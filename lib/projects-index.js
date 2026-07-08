// Local project index — how phewsh knows your projects from anywhere.
//
// Every session opened in a project (or created via /init) records it here,
// so running `phewsh` at machine root becomes mission-control bootstrap
// ("where do you want to work?") instead of "no project found, goodbye."
//
// Storage: ~/.phewsh/project-index.json. Local-first; web sync layers on top.
// NOT projects.json — that file belongs to `phewsh mcp` (web project cache,
// array-shaped). Claiming it caused a startup crash AND would have clobbered
// MCP data on first write. One file, one owner.

const fs = require('fs');
const path = require('path');
const os = require('os');

// PHEWSH_PROJECT_INDEX override exists for tests only — never point real use away from home.
const INDEX_FILE = process.env.PHEWSH_PROJECT_INDEX || path.join(os.homedir(), '.phewsh', 'project-index.json');

// Shallow-scanned roots when the user asks to find projects. One level deep,
// opt-in only — deep-scanning someone's machine uninvited is invasive.
const SCAN_ROOTS = [
  path.join(os.homedir(), 'Documents', 'GitHub'),
  path.join(os.homedir(), 'Projects'),
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'repos'),
  path.join(os.homedir(), 'Developer'),
  path.join(os.homedir(), 'code'),
];

function load() {
  // Shape-or-nothing: corrupt index degrades to empty, never throws
  try {
    const i = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    if (i && typeof i === 'object' && i.projects && typeof i.projects === 'object') return i;
    return { projects: {} };
  } catch { return { projects: {} }; }
}

function save(index) {
  fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

/** Upsert the project at `dir` (called whenever a session opens one). */
function recordProject(dir, extra = {}) {
  const index = load();
  const key = path.resolve(dir);
  index.projects[key] = {
    ...(index.projects[key] || {}),
    name: path.basename(key),
    path: key,
    lastOpened: new Date().toISOString(),
    ...extra,
  };
  save(index);
}

/** Known projects, most recently opened first. Prunes paths that vanished. */
function listProjects() {
  const index = load();
  const alive = Object.values(index.projects).filter(p => {
    try { return fs.existsSync(path.join(p.path, '.intent')); } catch { return false; }
  });
  return alive.sort((a, b) => String(b.lastOpened).localeCompare(String(a.lastOpened)));
}

/** Shallow scan: direct children of common roots that contain .intent/. */
function scanForProjects(roots = SCAN_ROOTS) {
  const found = [];
  const seen = new Set(); // realpath-dedupe — case-insensitive FS makes ~/Projects and ~/projects one dir
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      try {
        if (fs.existsSync(path.join(dir, '.intent', 'vision.md'))) {
          const real = fs.realpathSync(dir);
          if (seen.has(real)) continue;
          seen.add(real);
          found.push({ name: e.name, path: real });
        }
      } catch { /* unreadable dir — skip */ }
    }
  }
  return found;
}

// Likely candidates: real projects (a .git repo is the conservative signal)
// that don't have .intent/ yet. Same shallow, opt-in scan as scanForProjects —
// one level deep in the usual folders, never recursive, never dotfiles read.
// Each hit carries its `reason` so the user sees WHY it was suggested.
const CANDIDATE_CAP = 15;
function scanForCandidates(roots = SCAN_ROOTS) {
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      try {
        if (!fs.existsSync(path.join(dir, '.git'))) continue;
        if (fs.existsSync(path.join(dir, '.intent'))) continue; // already phewsh-enabled (or partially)
        const real = fs.realpathSync(dir);
        if (seen.has(real)) continue;
        seen.add(real);
        found.push({ name: e.name, path: real, reason: 'git repo, no .intent/ yet' });
        if (found.length >= CANDIDATE_CAP) return found;
      } catch { /* unreadable dir — skip */ }
    }
  }
  return found;
}

// ─── Serve registry (Jul 8 2026 Option C ruling) ────────────────────────────
// Auto-recorded session entries are NOT auto-exposed to the worker. Only
// projects the human deliberately registers with `phewsh project add` carry
// serve:true, and only those appear on the bridge/web. Identity is the
// normalized git remote — the same convention the task-claim path enforces —
// never the folder name.

const { execFileSync } = require('child_process');
const { normalizeRemote } = require('./team-tasks');

function originRemote(dir) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch { return null; }
}

/**
 * Register a project so the local worker may expose it. Validates before
 * writing; throws with a plain-language message when something is missing.
 */
function addServeProject(dir) {
  if (!fs.existsSync(path.resolve(dir))) throw new Error(`That folder doesn't exist: ${path.resolve(dir)}`);
  const key = fs.realpathSync(path.resolve(dir)); // one entry per real directory, symlinks collapse

  if (!fs.existsSync(path.join(key, '.git'))) {
    throw new Error(`Not a git repository: ${key}\nA served project needs a repo so work stays traceable. Run this inside a git repo (or git init first).`);
  }
  const remote = originRemote(key);
  if (!remote) {
    throw new Error(`This repo has no 'origin' remote yet.\nThe remote is the project's identity — it's how phewsh guarantees work lands in the right repo.\nAdd one first:  git remote add origin <url>`);
  }
  const index = load();
  index.projects[key] = {
    ...(index.projects[key] || {}),
    name: path.basename(key),
    path: key,
    remote: normalizeRemote(remote),
    serve: true,
    serveAddedAt: new Date().toISOString(),
    lastOpened: index.projects[key]?.lastOpened || new Date().toISOString(),
  };
  save(index);
  return index.projects[key];
}

/** Stop exposing a project (by name or path). The session-index entry stays. */
function removeServeProject(nameOrPath) {
  const index = load();
  let wantPath = path.resolve(nameOrPath);
  try { wantPath = fs.realpathSync(wantPath); } catch { /* not a live path — name match still works */ }
  const hit = Object.values(index.projects).find(p =>
    p.serve && (p.path === wantPath || p.name === nameOrPath));
  if (!hit) return null;
  delete index.projects[hit.path].serve;
  delete index.projects[hit.path].serveAddedAt;
  save(index);
  return hit;
}

/** Projects the worker is allowed to expose, pruned to paths that still exist. */
function serveProjects() {
  const index = load();
  return Object.values(index.projects)
    .filter(p => p.serve === true && fs.existsSync(p.path))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function fmtAgo(ts) {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

module.exports = { INDEX_FILE, SCAN_ROOTS, recordProject, listProjects, scanForProjects, scanForCandidates, fmtAgo, addServeProject, removeServeProject, serveProjects };
