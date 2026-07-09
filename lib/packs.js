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
//     installer or review page (e.g. GSD is its own tool — we hand you its command).

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
  'boat-to-shore': {
    kind: 'linked',
    title: 'Boat to Shore — completion-loop skill',
    desc: 'A tested Claude skill for recurring autonomous improvement sessions (run it via /loop): one verified slice per session, state-file continuity across resets, branch discipline, honest handoffs. Moves a repo from unfinished (Water) to shippable (Shore) to excellent (Mountain). Pairs with a plan made at phewsh.com/intent.',
    source: 'github.com/cleverIdeaz/phewsh-cli (skills/boat-to-shore)',
    license: 'MIT',
    install: 'mkdir -p ~/.claude/skills/boat-to-shore && curl -fsSL https://raw.githubusercontent.com/cleverIdeaz/phewsh-cli/main/skills/boat-to-shore/SKILL.md -o ~/.claude/skills/boat-to-shore/SKILL.md',
  },
  gsd: {
    kind: 'linked',
    title: 'GSD — Get Shit Done',
    desc: 'A Claude-centric workflow augmentation (hooks, commands, planning). Its own tool — phewsh just points you at it; it is not vendored.',
    source: 'github.com/gsd-build/get-shit-done',
    license: 'see the GSD repo',
    install: 'npx @gsd-build/get-shit-done init   # follow the GSD repo for current instructions',
  },
  'loop-library': {
    kind: 'linked',
    title: 'Loop Library / Loopy',
    desc: 'Forward Future\'s practical agent-loop library and Loopy skill, with checks and stopping conditions. Good Work-layer inspiration; phewsh links to it without becoming a scheduler or runner.',
    source: 'signals.forwardfuture.com/loop-library · github.com/Forward-Future/loop-library',
    license: 'MIT',
    install: 'npx skills add Forward-Future/loop-library --skill loopy -g   # install Loopy through upstream skills tooling',
  },
  'matt-skills': {
    kind: 'linked',
    title: 'Matt Pocock Skills',
    desc: 'Engineering-focused skills for debugging, TDD, domain modeling, handoffs, git guardrails, and design reviews.',
    source: 'github.com/mattpocock/skills',
    license: 'MIT',
    install: 'npx skills@latest add mattpocock/skills   # install through upstream skills tooling',
  },
  'cybersecurity-skills': {
    kind: 'linked',
    title: 'Anthropic Cybersecurity Skills',
    desc: 'Large cybersecurity skill library mapped to security frameworks. Review scope carefully before using on real targets.',
    source: 'github.com/mukul975/Anthropic-Cybersecurity-Skills',
    license: 'Apache-2.0',
    install: 'review https://github.com/mukul975/Anthropic-Cybersecurity-Skills   # choose upstream install path and scope deliberately',
  },
  skillspector: {
    kind: 'linked',
    title: 'NVIDIA SkillSpector',
    desc: 'Security scanner for AI-agent skills. Useful candidate for future Phewsh pack vetting before install or distribution.',
    source: 'github.com/nvidia/skillspector',
    license: 'see the SkillSpector repo',
    install: 'review https://github.com/nvidia/skillspector   # run scanner only after reading upstream docs',
  },
  'codebase-memory-mcp': {
    kind: 'linked',
    title: 'Codebase Memory MCP',
    desc: 'Persistent code-intelligence MCP server for repository memory and fast code search. Linked only; configure per harness.',
    source: 'github.com/DeusData/codebase-memory-mcp',
    license: 'see the codebase-memory-mcp repo',
    install: 'review https://github.com/DeusData/codebase-memory-mcp   # install/configure upstream MCP manually',
  },
  'unlimited-ocr': {
    kind: 'linked',
    title: 'Unlimited OCR',
    desc: 'Local/GPU OCR model candidate for images and PDFs. Relevant to RecipeFlower-style recipe capture, but heavy and not auto-installed.',
    source: 'github.com/baidu/Unlimited-OCR',
    license: 'MIT',
    install: 'review https://github.com/baidu/Unlimited-OCR   # inspect CUDA/SGLang requirements before installing',
  },
  'palmier-pro': {
    kind: 'linked',
    title: 'Palmier Pro',
    desc: 'Open-source macOS video editor with an MCP surface. Useful media-production inspiration; platform-gated and not bundled.',
    source: 'github.com/palmier-io/palmier-pro',
    license: 'GPLv3',
    install: 'review https://github.com/palmier-io/palmier-pro   # macOS/Apple Silicon requirements apply',
  },
  openmontage: {
    kind: 'linked',
    title: 'OpenMontage',
    desc: 'Agentic video-production system with pipelines, tools, and skills. Treat as an upstream media lab, not a core Phewsh dependency.',
    source: 'github.com/calesthio/OpenMontage',
    license: 'see the OpenMontage repo',
    install: 'review https://github.com/calesthio/OpenMontage   # install only in a project that needs agentic video production',
  },
  hyperframes: {
    kind: 'linked',
    title: 'Hyperframes',
    desc: 'HTML-to-video rendering for agents. Good fit for future product demos, walkthroughs, and generated media packs.',
    source: 'github.com/heygen-com/hyperframes',
    license: 'see the Hyperframes repo',
    install: 'review https://github.com/heygen-com/hyperframes   # inspect current renderer/runtime requirements',
  },
  'deer-flow': {
    kind: 'linked',
    title: 'DeerFlow',
    desc: 'Open-source agent harness with sub-agents, memory, sandboxes, and skills. Compare as an executor/harness, not a Phewsh replacement.',
    source: 'github.com/bytedance/deer-flow',
    license: 'MIT',
    install: 'review https://github.com/bytedance/deer-flow   # evaluate as a separate harness before configuring',
  },
  'hermes-agent': {
    kind: 'linked',
    title: 'Hermes Agent',
    desc: 'Nous Research agent project. Linked as a possible compatible harness to evaluate before any deeper integration.',
    source: 'github.com/nousresearch/hermes-agent',
    license: 'see the Hermes Agent repo',
    install: 'review https://github.com/nousresearch/hermes-agent   # evaluate upstream capabilities first',
  },
  voicebox: {
    kind: 'linked',
    title: 'Voicebox',
    desc: 'Open-source AI voice studio. Candidate for future audio/voice workflows and Keylink-adjacent media experiments.',
    source: 'github.com/jamiepine/voicebox',
    license: 'see the Voicebox repo',
    install: 'review https://github.com/jamiepine/voicebox   # install only for voice workflows that need it',
  },
  gstack: {
    kind: 'linked',
    title: 'gstack',
    desc: 'Opinionated Claude Code setup with role/tooling patterns. Useful reference, but Phewsh should preserve its own four-word model.',
    source: 'github.com/garrytan/gstack',
    license: 'see the gstack repo',
    install: 'review https://github.com/garrytan/gstack   # inspect before mixing with existing agent files',
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
