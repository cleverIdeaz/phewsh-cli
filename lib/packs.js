// phewsh packs — an opt-in gateway to proven AI-workflow enhancements.
//
// phewsh's core is project truth + continuity + record. It is NOT a grab-bag of
// every viral CLAUDE.md. But good ideas exist out there, and phewsh is a natural
// front door to them — IF they stay optional, attributed, and reversible. So:
//   • Nothing is vendored or injected by default (never in ambient/first-run).
//   • `phewsh pack install <name>` shows the source + license + a diff preview
//     and asks before writing.
//   • `phewsh pack remove <name>` cleanly reverses it (marked block only).
//
// Two kinds of pack:
//   • vendored — phewsh writes a clearly-marked block into the project's agent
//     files (e.g. Karpathy's coding guidelines into CLAUDE.md/AGENTS.md).
//   • linked   — phewsh doesn't vendor it; it points you at the upstream
//     installer (e.g. GSD is its own tool — we hand you its command).

const fs = require('fs');
const path = require('path');

const KARPATHY_GUIDELINES = `## Coding guidelines
**Tradeoff:** these bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think before coding
State assumptions explicitly; if uncertain, ask. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so. If something's unclear, stop and name it.

### 2. Simplicity first
Minimum code that solves the problem, nothing speculative. No features beyond what was asked, no abstractions for single-use code, no error handling for impossible cases. If 200 lines could be 50, rewrite. Ask: "would a senior engineer call this overcomplicated?"

### 3. Surgical changes
Touch only what you must. Don't "improve" adjacent code, don't refactor what isn't broken, match existing style. Remove only the orphans YOUR change created; mention pre-existing dead code, don't delete it. Every changed line should trace to the request.

### 4. Goal-driven execution
Turn tasks into verifiable goals ("add validation" → "write tests for invalid inputs, then make them pass"). For multi-step work, state a brief plan with a verify step each. Strong success criteria let you loop independently.

**Working if:** fewer unnecessary diffs, fewer rewrites from overcomplication, and clarifying questions come before mistakes, not after.`;

const PACKS = {
  'karpathy-style': {
    kind: 'vendored',
    title: 'Karpathy-style coding guidelines',
    desc: 'Behavioral guidelines that reduce common LLM coding mistakes (think-before-coding, simplicity, surgical changes, goal-driven loops).',
    source: "Andrej Karpathy's CLAUDE.md · github.com/multica-ai/andrej-karpathy-skills",
    license: 'review the source repo for license before redistributing',
    targets: ['CLAUDE.md', 'AGENTS.md'],
    content: KARPATHY_GUIDELINES,
  },
  gsd: {
    kind: 'linked',
    title: 'GSD — Get Shit Done',
    desc: 'A Claude-centric workflow augmentation (hooks, commands, planning). Its own tool — phewsh just points you at it; it is not vendored.',
    source: 'github.com/gsd-build/get-shit-done',
    license: 'see the GSD repo',
    install: 'npx @gsd-build/get-shit-done init   # follow the GSD repo for current instructions',
  },
};

function markers(name) {
  return { start: `<!-- phewsh-pack:${name} START -->`, end: `<!-- phewsh-pack:${name} END -->` };
}

function blockFor(name, pack) {
  const m = markers(name);
  const header = `# ${pack.title} (phewsh pack: ${name})\n`
    + `> Source: ${pack.source}\n`
    + `> Opt-in via \`phewsh pack install ${name}\` · remove: \`phewsh pack remove ${name}\`\n\n`;
  return `${m.start}\n${header}${pack.content}\n${m.end}`;
}

function isInstalled(name, cwd = process.cwd()) {
  const pack = PACKS[name];
  if (!pack || pack.kind !== 'vendored') return false;
  return pack.targets.some(f => {
    try { return fs.readFileSync(path.join(cwd, f), 'utf-8').includes(markers(name).start); }
    catch { return false; }
  });
}

// Returns the files it WOULD write to + the block, without writing — for preview.
function previewInstall(name, cwd = process.cwd()) {
  const pack = PACKS[name];
  if (!pack || pack.kind !== 'vendored') return null;
  return { files: pack.targets, block: blockFor(name, pack) };
}

function install(name, cwd = process.cwd()) {
  const pack = PACKS[name];
  if (!pack || pack.kind !== 'vendored') return { written: [] };
  const block = blockFor(name, pack);
  const m = markers(name);
  const written = [];
  for (const f of pack.targets) {
    const fp = path.join(cwd, f);
    let existing = '';
    try { existing = fs.readFileSync(fp, 'utf-8'); } catch { /* new file */ }
    if (existing.includes(m.start)) {
      // refresh in place
      const re = new RegExp(escapeRe(m.start) + '[\\s\\S]*?' + escapeRe(m.end));
      fs.writeFileSync(fp, existing.replace(re, block));
    } else {
      fs.writeFileSync(fp, (existing ? existing.replace(/\s*$/, '') + '\n\n' : '') + block + '\n');
    }
    written.push(f);
  }
  return { written };
}

function remove(name, cwd = process.cwd()) {
  const pack = PACKS[name];
  if (!pack || pack.kind !== 'vendored') return { removed: [] };
  const m = markers(name);
  const removed = [];
  for (const f of pack.targets) {
    const fp = path.join(cwd, f);
    try {
      const existing = fs.readFileSync(fp, 'utf-8');
      if (!existing.includes(m.start)) continue;
      const re = new RegExp('\\n*' + escapeRe(m.start) + '[\\s\\S]*?' + escapeRe(m.end) + '\\n*', 'g');
      fs.writeFileSync(fp, existing.replace(re, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, ''));
      removed.push(f);
    } catch { /* not there */ }
  }
  return { removed };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { PACKS, install, remove, isInstalled, previewInstall, blockFor };
