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

const MODEL_ROUTING = `## Model routing
**Tradeoff:** explicit routing beats habit. The biggest model is not the default — it's a budget decision you make on purpose.

### 1. Keep a routing glossary
Score every model you can run on three axes — **intelligence** (can it do the task), **taste** (do you like how it works), **cost**. Cost breaks ties; it never leads. Keep the scores here, next to this block, and update them when your lineup changes:

| Model | Intelligence | Taste | Cost | Route it |
|---|---|---|---|---|
| (your frontier model) | high | high | $$$ | plans, reviews, architecture, judgment calls |
| (your mid model) | good | good | $$ | well-specced execution, refactors, tests |
| (your small/local model) | basic | — | $ | summaries, formatting, mechanical edits |

### 2. Plan ≠ execute (the 10-80-10 split)
Use the frontier model to research and write a durable **spec** (the first 10%). Hand the spec to a cheaper model to execute (the 80%). Bring the frontier model back to review the diff (the last 10%). Output tokens dominate execution and cost far more than input — the split is where the savings live.

### 3. Effort is a second axis
Higher thinking/effort settings are not strictly better: maximum effort tends to overthink, overbuild, and second-guess a good plan. Try high before max. A strong model on low effort often matches a mid model on high.

### 4. Advisor, not executor
The smartest model is your on-demand senior advisor, not the daily executor: it designs the workflow, devil's-advocates the plan, and verifies the result. Cheaper sub-agents execute and report back to it.

**Working if:** your spend curve bends down while review quality holds — and "which model should do this?" has a written answer instead of a habit.`;

const GOVERNANCE_AUDITS = `## Governance audits
**Tradeoff:** these audit the system around the model, not the code. Run them at milestones or monthly — not every session.

Answer each against the project's real record (.intent/, receipts, git history), never from memory. Write findings into the decision record so the next audit compounds instead of restarting.

### 1. Goal orientation
Does today's work trace to the stated goal, or has activity replaced progress? Name the last three things shipped and which goal each served.

### 2. Better, defined
"Better" needs a written definition and a check. What measurable outcome would prove the current direction right — and when did you last look at it?

### 3. Autonomy ladder
Trust is granted by risk × leverage, not habit. Which actions run unattended today that couldn't have a month ago — what earned that? Which still require a human that shouldn't?

### 4. Memory that compounds
Would the next session — or the next model — know what this one learned? If the answer lives in a chat log, it is already lost; promote it to a durable file.

### 5. Decisions into policy
Which choice has been re-litigated three times? Record the ruling once, with its why, and stop paying for it again.

### 6. Attack surface
List every place an outside string reaches your agents (webhooks, issues, scraped pages, pasted content). Each is a prompt-injection path; each needs a declared posture, even if the posture is "trusted, human-reviewed".

### 7. Bus factor
If the one person who understands this system disappeared, what breaks first? That is the next thing to document.

### 8. One real constraint
Of everything limiting the project, which single constraint, removed, would un-stick the most? Spend the frontier-model time there.

**Working if:** audits produce recorded rulings that change behavior — not a report that gets filed.`;

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
  'model-routing': {
    kind: 'vendored',
    title: 'Model routing — right model, right effort, right stage',
    desc: 'A routing glossary template (intelligence/taste/cost), the plan→execute→review 10-80-10 split, effort-level guidance, and the advisor pattern. Preservation pack: inspired by techniques the community discovered during the Fable era — the practices outlive any model.',
    source: 'phewsh preservation packs · distilled from multiple independent community sources',
    license: 'MIT (the distillation; the ideas are community practice)',
    targets: ['CLAUDE.md', 'AGENTS.md'],
    content: MODEL_ROUTING,
  },
  'governance-audits': {
    kind: 'vendored',
    title: 'Governance audits — audit the system, not the code',
    desc: 'Eight recurring audits for AI-assisted projects: goal orientation, defined "better", autonomy ladder, compounding memory, decisions-into-policy, attack surface, bus factor, the one real constraint. Preservation pack: independently distilled; run findings into the decision record.',
    source: "phewsh preservation packs · original distillation, inspired by Daniel Miessler's public AI audit prompts (danielmiessler.com) — none of his text is reproduced",
    license: 'MIT (the distillation)',
    targets: ['CLAUDE.md', 'AGENTS.md'],
    content: GOVERNANCE_AUDITS,
  },
  'boat-to-shore': {
    kind: 'linked',
    title: 'Boat to Shore — completion-loop skill',
    desc: 'A tested Claude skill for recurring autonomous improvement sessions (run it via /loop): one verified slice per session, state-file continuity across resets, branch discipline, honest handoffs. Moves a repo from unfinished (Water) to shippable (Shore) to excellent (Mountain). Pairs with a plan made at phewsh.com/intent.',
    source: 'github.com/cleverIdeaz/phewsh-cli (skills/boat-to-shore)',
    license: 'MIT',
    install: 'mkdir -p ~/.claude/skills/boat-to-shore && curl -fsSL https://raw.githubusercontent.com/cleverIdeaz/phewsh-cli/main/skills/boat-to-shore/SKILL.md -o ~/.claude/skills/boat-to-shore/SKILL.md',
  },
  'portfolio-boat-loop': {
    kind: 'linked',
    title: 'Portfolio Boat Loop — multi-repo loop router',
    desc: 'The layer above boat-to-shore: decides which repo gets the next session window, rotates by Water→Shore→Mountain, tracks the whole portfolio in one state file, and keeps loop state from bloating. The repo loop moves one boat; this decides which boat gets the next tide.',
    source: 'github.com/cleverIdeaz/phewsh-cli (skills/portfolio-boat-loop)',
    license: 'MIT',
    install: 'mkdir -p ~/.claude/skills/portfolio-boat-loop && curl -fsSL https://raw.githubusercontent.com/cleverIdeaz/phewsh-cli/main/skills/portfolio-boat-loop/SKILL.md -o ~/.claude/skills/portfolio-boat-loop/SKILL.md',
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
