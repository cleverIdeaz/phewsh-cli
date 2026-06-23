// phewsh context
// Export portable adaptive context for any AI tool.
// Reads .intent/ artifacts + project.json (decisionGate) and generates an operational briefing.

const fs = require('fs');
const path = require('path');

const INTENT_DIR = path.join(process.cwd(), '.intent');

const args = process.argv.slice(3);
const flags = {
  full: args.includes('--full') || args.includes('-f'),
  claude: args.includes('--claude'),
  clipboard: args.includes('--copy') || args.includes('-c'),
  file: args.includes('--file') || args.includes('-o'),
  help: args.includes('--help') || args.includes('-h'),
};

function loadArtifact(name) {
  const p = path.join(INTENT_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

function loadGate() {
  // Canonical source: project.json → decisionGate. Fall back to legacy gate.json.
  const projectPath = path.join(INTENT_DIR, 'project.json');
  if (fs.existsSync(projectPath)) {
    try {
      const project = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
      if (project?.decisionGate) return project.decisionGate;
    } catch { /* fall through to legacy */ }
  }
  const p = path.join(INTENT_DIR, 'gate.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function extractExecutionState(nextContent) {
  const items = [];
  const stateMap = { ' ': 'todo', '-': 'in_progress', 'x': 'done', '!': 'blocked', '~': 'skipped' };

  for (const line of nextContent.split('\n')) {
    const match = line.match(/^[-*]\s*\[([ x!\-~])\]\s*\*?\*?(.+?)\*?\*?\s*$/);
    if (match) {
      const char = match[1] === '-' ? '-' : match[1];
      items.push({ title: match[2].replace(/\*\*/g, '').trim(), state: stateMap[char] || 'todo' });
    }
  }

  return {
    total: items.length,
    done: items.filter(i => i.state === 'done').length,
    doing: items.filter(i => i.state === 'in_progress').length,
    blocked: items.filter(i => i.state === 'blocked').length,
    skipped: items.filter(i => i.state === 'skipped').length,
    items,
  };
}

function buildConstraintInstructions(c) {
  const lines = [];

  if (c.budget > 0) {
    lines.push(`- Budget: $${c.budget} total. ${
      c.budget < 100 ? 'Extremely tight — free/open-source only.'
      : c.budget < 500 ? 'Limited — justify any paid tool.'
      : c.budget < 2000 ? 'Moderate — strategic spending OK.'
      : 'Substantial — professional tools welcome.'
    }`);
  }

  if (c.timeHoursPerWeek > 0) {
    lines.push(`- Time: ${c.timeHoursPerWeek} hrs/week. ${
      c.timeHoursPerWeek <= 5 ? 'Micro-steps only. Each task < 2 hours.'
      : c.timeHoursPerWeek <= 15 ? 'Part-time. Clear stopping points.'
      : c.timeHoursPerWeek <= 30 ? 'Near full-time. Sustained work OK.'
      : 'Full-time+. Ambitious scope OK.'
    }`);
  }

  lines.push(`- Skill: ${c.skillLevel}. ${
    c.skillLevel === 'beginner' ? 'Explain everything. Simplest architecture wins.'
    : c.skillLevel === 'intermediate' ? 'Reference docs, flag gotchas.'
    : c.skillLevel === 'advanced' ? 'Focus on strategic decisions.'
    : 'Deep expertise. Advanced patterns welcome.'
  }`);

  lines.push(`- Urgency: ${c.urgency}. ${
    c.urgency === 'relaxed' ? 'Thoroughness over speed.'
    : c.urgency === 'moderate' ? 'Weeks not months. Proven approaches.'
    : c.urgency === 'urgent' ? 'Days matter. Cut scope aggressively.'
    : 'BLOCKING. Strip to essentials.'
  }`);

  lines.push(`- Autonomy: ${c.autonomy}. ${
    c.autonomy === 'hands-on' ? 'Present options, not recommendations.'
    : c.autonomy === 'guided' ? 'Opinionated suggestions with reasoning.'
    : c.autonomy === 'delegated' ? 'Be decisive. Only escalate irreversible decisions.'
    : 'Maximum automation.'
  }`);

  return lines.join('\n');
}

function generateContext(includeArtifacts = false) {
  const vision = loadArtifact('vision.md');
  const plan = loadArtifact('plan.md');
  const next = loadArtifact('next.md');
  const gate = loadGate();
  const projectName = path.basename(process.cwd());

  if (!vision && !plan && !next) return null;

  const sections = [];
  const constraints = gate?.constraints;
  const hasConstraints = constraints && (
    constraints.budget > 0 ||
    constraints.timeHoursPerWeek > 0 ||
    constraints.skillLevel !== 'intermediate' ||
    constraints.urgency !== 'moderate' ||
    constraints.autonomy !== 'guided'
  );

  // Header
  sections.push(`# PHEWSH Adaptive Context — ${projectName}`);
  sections.push(`> Generated ${new Date().toISOString().split('T')[0]} | phewsh.com/intent`);
  sections.push(`> Drop this into CLAUDE.md, .cursorrules, or agent config.`);
  sections.push('');

  // Project identity
  sections.push('## Project');
  sections.push(`- **Name**: ${projectName}`);
  if (gate?.archetype) sections.push(`- **Type**: ${gate.archetype}`);

  // Extract TLDR from vision first line
  if (vision) {
    const firstMeaningful = vision.split('\n').find(l => l.trim().length > 20 && !l.startsWith('#'));
    if (firstMeaningful) sections.push(`- **TLDR**: ${firstMeaningful.trim()}`);
  }
  sections.push('');

  // Operational constraints
  if (hasConstraints) {
    sections.push('## Operational Reality');
    sections.push('These constraints MUST shape every suggestion and implementation decision:');
    sections.push('');
    sections.push(buildConstraintInstructions(constraints));
    sections.push('');

    // Execution Reality Map
    if (gate?.executionMap) {
      const map = gate.executionMap;
      sections.push('### Execution Assessment');
      sections.push(`- **Feasibility**: ${gate.feasibility}`);
      if (map.recommendedMode) sections.push(`- **Recommended mode**: ${map.recommendedMode}`);
      if (map.primaryBottleneck) sections.push(`- **Primary bottleneck**: ${map.primaryBottleneck}`);
      if (map.highestLeveragePath) sections.push(`- **Highest leverage move**: ${map.highestLeveragePath}`);
      if (map.estimatedTimeline) sections.push(`- **Timeline**: ${map.estimatedTimeline}`);
      if (map.majorRisks?.length > 0) sections.push(`- **Risks**: ${map.majorRisks.join('; ')}`);
      sections.push('');
    }
  }

  // Execution state
  if (next) {
    const exec = extractExecutionState(next);
    if (exec.total > 0) {
      sections.push('## Current Execution State');
      sections.push(`Progress: ${exec.done}/${exec.total} done${exec.doing ? `, ${exec.doing} in progress` : ''}${exec.blocked ? `, ${exec.blocked} blocked` : ''}`);
      sections.push('');

      const doing = exec.items.filter(i => i.state === 'in_progress');
      if (doing.length > 0) {
        sections.push('**Currently working on:**');
        doing.forEach(i => sections.push(`- ${i.title}`));
        sections.push('');
      }

      const blocked = exec.items.filter(i => i.state === 'blocked');
      if (blocked.length > 0) {
        sections.push('**Blocked:**');
        blocked.forEach(i => sections.push(`- ${i.title}`));
        sections.push('');
      }

      const todo = exec.items.filter(i => i.state === 'todo');
      if (todo.length > 0) {
        sections.push('**Remaining:**');
        todo.forEach(i => sections.push(`- ${i.title}`));
        sections.push('');
      }
    }
  }

  // Constraint drift
  if (gate?.constraintHistory?.length > 0) {
    sections.push('### Constraint Drift');
    sections.push('Reality changed during this project:');
    sections.push('');
    for (const ch of gate.constraintHistory.slice(-10)) {
      const date = ch.timestamp.split('T')[0];
      sections.push(`- **${ch.field}**: ${ch.from} → ${ch.to}${ch.reason ? ` (${ch.reason})` : ''} — ${date}`);
    }
    sections.push('');
  }

  // Responsibility split
  if (gate?.responsibilitySplit) {
    sections.push('## Responsibility Split');
    if (gate.responsibilitySplit.ai?.length > 0) {
      sections.push('**AI/agents can handle:**');
      gate.responsibilitySplit.ai.forEach(r => sections.push(`- ${r}`));
    }
    if (gate.responsibilitySplit.human?.length > 0) {
      sections.push('**Requires human action:**');
      gate.responsibilitySplit.human.forEach(r => sections.push(`- ${r}`));
    }
    sections.push('');
  }

  // AI instructions
  sections.push('## Instructions for AI Tools');
  sections.push('When working on this project:');
  const instructions = [];

  if (hasConstraints) {
    instructions.push('- Adapt ALL suggestions to the operational constraints above.');
    if (constraints.budget > 0 && constraints.budget < 500) {
      instructions.push('- Never recommend paid services without noting cost and a free alternative.');
    }
    if (constraints.timeHoursPerWeek > 0 && constraints.timeHoursPerWeek <= 10) {
      instructions.push('- Break every task into steps completable in a single sitting.');
    }
    if (constraints.skillLevel === 'beginner') {
      instructions.push('- Explain every tool, concept, and command. No assumed knowledge.');
    }
    if (constraints.urgency === 'urgent' || constraints.urgency === 'critical') {
      instructions.push('- Prioritize shipping over polish. Cut scope ruthlessly.');
    }
  }

  if (next) {
    const exec = extractExecutionState(next);
    const blockedCount = exec.items.filter(i => i.state === 'blocked').length;
    if (blockedCount > 0) {
      instructions.push(`- ${blockedCount} task(s) are blocked. Suggest alternative approaches if relevant.`);
    }
    if (exec.done > 0 && exec.total > 0) {
      const pct = Math.round((exec.done / exec.total) * 100);
      instructions.push(`- Project is ${pct}% complete. Focus on remaining work.`);
    }
  }

  if (instructions.length === 0) {
    instructions.push('- Follow the project vision and plan. Check execution state for current progress.');
  }
  sections.push(instructions.join('\n'));
  sections.push('');

  // Full artifacts (optional)
  if (includeArtifacts) {
    if (vision) { sections.push('## Vision'); sections.push(vision); sections.push(''); }
    if (plan) { sections.push('## Plan'); sections.push(plan); sections.push(''); }
    if (next) { sections.push('## Next Actions'); sections.push(next); sections.push(''); }
  }

  sections.push('---');
  sections.push('*Exported from [PHEWSH Intent](https://phewsh.com/intent) — software that adapts to you.*');

  return sections.join('\n');
}

function showHelp() {
  console.log(`
  phewsh context — Export portable adaptive context

  Usage:
    phewsh context             Generate context to stdout
    phewsh context --full      Include full artifact text
    phewsh context --copy      Copy to clipboard
    phewsh context --file      Write to .phewsh.context in current directory
    phewsh context --claude    Write to CLAUDE.md (for Claude Code)

  What it does:
    Reads .intent/ artifacts + project.json (decisionGate) and produces an
    operational briefing that makes any AI tool constraint-aware.

    Drop the output into CLAUDE.md, .cursorrules, or agent config.
  `);
}

async function main() {
  if (flags.help) { showHelp(); return; }

  if (!fs.existsSync(INTENT_DIR)) {
    console.log('\n  No .intent/ found. Run `phewsh intent --init` first.\n');
    process.exit(1);
  }

  const content = generateContext(flags.full);
  if (!content) {
    console.log('\n  No artifacts found in .intent/\n');
    process.exit(1);
  }

  if (flags.file) {
    const outPath = path.join(process.cwd(), '.phewsh.context');
    fs.writeFileSync(outPath, content);
    console.log(`\n  ✓ Written to ${outPath}\n`);
    return;
  }

  if (flags.claude) {
    const outPath = path.join(process.cwd(), 'CLAUDE.md');
    const START_MARKER = '<!-- PHEWSH:START -->';
    const END_MARKER = '<!-- PHEWSH:END -->';
    const wrapped = `${START_MARKER}\n${content}\n${END_MARKER}`;

    if (fs.existsSync(outPath)) {
      let existing = fs.readFileSync(outPath, 'utf-8');
      const startIdx = existing.indexOf(START_MARKER);
      const endIdx = existing.indexOf(END_MARKER);
      if (startIdx !== -1 && endIdx !== -1) {
        existing = existing.slice(0, startIdx) + wrapped + existing.slice(endIdx + END_MARKER.length);
        fs.writeFileSync(outPath, existing);
        console.log('\n  ✓ Updated PHEWSH section in CLAUDE.md\n');
      } else {
        fs.writeFileSync(outPath, existing.trimEnd() + '\n\n' + wrapped + '\n');
        console.log('\n  ✓ Appended to CLAUDE.md\n');
      }
    } else {
      fs.writeFileSync(outPath, wrapped + '\n');
      console.log('\n  ✓ Created CLAUDE.md\n');
    }
    console.log('  Tip: Run `phewsh watch` to keep this section auto-synced.\n');
    return;
  }

  if (flags.clipboard) {
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'darwin') {
        execSync('pbcopy', { input: content });
      } else if (process.platform === 'linux') {
        execSync('xclip -selection clipboard', { input: content });
      } else {
        execSync('clip', { input: content });
      }
      console.log('\n  ✓ Copied to clipboard\n');
    } catch {
      // Fallback: print to stdout
      console.log(content);
    }
    return;
  }

  // Default: print to stdout
  console.log(content);
}

module.exports = { main, generateContext };

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
