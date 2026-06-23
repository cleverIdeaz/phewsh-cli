// Discover all memory/context source files for the working directory.
// Returns a list of { path, type, name, scope } for each recognized source.
//
// Two scopes:
//   'project' — files in the working directory (this repo/project)
//   'global'  — per-user memory that travels across every project
//               (your global CLAUDE.md, Codex AGENTS.md, Gemini GEMINI.md)
//
// Global sources enrich the summary so `phewsh seq` reflects cross-tool
// continuity even in a bare directory. They are deliberately kept OUT of
// project-file writes by default (see sequence() includeGlobal) so personal
// global notes never leak into a committed project CLAUDE.md.

const fs = require('fs');
const path = require('path');
const os = require('os');

// narrative.md is intentionally NOT a source: it is a deprecated artifact that
// predates the four-word model (Project · Next · Work · Record) and is no longer
// authoritative project truth. It must never enter a native projection. See
// resolveProjectRoot + the canonical projection in selfheal.
const INTENT_FILES = ['vision.md', 'plan.md', 'status.md', 'next.md'];
const INTENT_JSON = ['project.json', 'next.json', 'pps.json', 'gate.json'];

// Resolve the project root by walking UP from `start` to the nearest ancestor
// (including start) that contains a `.intent/` directory — bounded by the home
// dir and the filesystem root. This stops a nested dir (e.g. an app folder under
// a monorepo) from being treated as its own project, and makes every
// context-generating path agree on the same root. Returns `start` unchanged when
// no `.intent/` exists anywhere upward (so bare-directory behavior is untouched).
function resolveProjectRoot(start = process.cwd(), home = os.homedir()) {
  let dir;
  try { dir = path.resolve(start); } catch { return start; }
  const fsRoot = path.parse(dir).root;
  const homeReal = (() => { try { return fs.realpathSync(home); } catch { return home; } })();
  while (true) {
    if (fs.existsSync(path.join(dir, '.intent'))) return dir;
    if (dir === fsRoot) break;
    let real; try { real = fs.realpathSync(dir); } catch { real = dir; }
    if (real === homeReal) break; // don't escape above the user's home
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function discover(cwd = process.cwd(), home = os.homedir()) {
  cwd = resolveProjectRoot(cwd, home);
  const sources = [];
  const seenPaths = new Set();

  const add = (s) => {
    const real = path.resolve(s.path);
    if (seenPaths.has(real)) return; // never list the same file twice
    seenPaths.add(real);
    sources.push(s);
  };

  // ── Project scope ──────────────────────────────────────────────

  // .intent/ artifacts
  const intentDir = path.join(cwd, '.intent');
  if (fs.existsSync(intentDir)) {
    for (const file of [...INTENT_FILES, ...INTENT_JSON]) {
      const p = path.join(intentDir, file);
      if (fs.existsSync(p)) {
        add({ path: p, type: 'intent', name: file, scope: 'project' });
      }
    }
  }

  // CLAUDE.md — the claude-md parser strips phewsh's generated block, so only
  // the user's MANUAL content is ingested (safe, no recursion).
  const claudeMd = path.join(cwd, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    add({ path: claudeMd, type: 'claude-md', name: 'CLAUDE.md', scope: 'project' });
  }

  // Claude auto-memory — project-scoped
  // ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md
  const claudeDir = path.join(home, '.claude');
  if (fs.existsSync(claudeDir)) {
    const projectsDir = path.join(claudeDir, 'projects');
    if (fs.existsSync(projectsDir)) {
      // Claude encodes cwd as path with - replacing /
      const encoded = cwd.replace(/\//g, '-');
      const memoryDir = path.join(projectsDir, encoded, 'memory');
      if (fs.existsSync(memoryDir)) {
        const memoryIndex = path.join(memoryDir, 'MEMORY.md');
        if (fs.existsSync(memoryIndex)) {
          add({ path: memoryIndex, type: 'claude-memory', name: 'MEMORY.md', scope: 'project' });

          // Also discover linked memory files from MEMORY.md
          try {
            const content = fs.readFileSync(memoryIndex, 'utf-8');
            const linkRegex = /\[([^\]]+\.md)\]\(([^)]+\.md)\)/g;
            let match;
            while ((match = linkRegex.exec(content)) !== null) {
              const linked = path.join(memoryDir, match[2]);
              if (fs.existsSync(linked)) {
                add({ path: linked, type: 'claude-memory-file', name: match[2], scope: 'project' });
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  // (.cursorrules / AGENTS.md / GEMINI.md intentionally NOT read as sources —
  // see note above: they are phewsh-managed outputs, not source truth.)

  // soul.md
  const soulMd = path.join(cwd, 'soul.md');
  if (fs.existsSync(soulMd)) {
    add({ path: soulMd, type: 'soul', name: 'soul.md', scope: 'project' });
  }

  // .github/copilot-instructions.md
  const copilot = path.join(cwd, '.github', 'copilot-instructions.md');
  if (fs.existsSync(copilot)) {
    add({ path: copilot, type: 'copilot', name: 'copilot-instructions.md', scope: 'project' });
  }

  // README.md (low priority but useful for identity)
  const readme = path.join(cwd, 'README.md');
  if (fs.existsSync(readme)) {
    add({ path: readme, type: 'readme', name: 'README.md', scope: 'project' });
  }

  // ── Global scope (per-user, travels across every project) ──────
  // Canonical global memory files for each agent CLI. Read-only; never
  // written to. These give value even with no .intent/ in the directory.
  // De-dup via seenPaths handles the edge where cwd === home.
  const globals = [
    { path: path.join(home, '.claude', 'CLAUDE.md'), type: 'claude-md', name: '~/.claude/CLAUDE.md' },
    { path: path.join(home, '.codex', 'AGENTS.md'), type: 'agent', name: '~/.codex/AGENTS.md' },
    { path: path.join(home, '.gemini', 'GEMINI.md'), type: 'agent', name: '~/.gemini/GEMINI.md' },
  ];
  for (const g of globals) {
    if (fs.existsSync(g.path)) {
      add({ path: g.path, type: g.type, name: g.name, scope: 'global' });
    }
  }

  return sources;
}

module.exports = { discover, resolveProjectRoot };
