const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { createPPS, writeGuardedViews } = require('../lib/pps');

const os = require('os');
const configFile = require('../lib/config-file');
const args = process.argv.slice(3);
const INTENT_DIR = path.join(process.cwd(), '.intent');
const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');
const WEB_URL = 'https://phewsh.com/intent';

const flags = {
  evolve: args.includes('--evolve') || args.includes('-e'),
  open: args.includes('--open') || args.includes('-o'),
  status: args.includes('--status') || args.includes('-s'),
  init: args.includes('--init') || args.includes('-i'),
  help: args.includes('--help') || args.includes('-h'),
  sync: args.includes('--sync'),
  pull: args.includes('--pull'),
};

function hasExistingArtifacts() {
  return fs.existsSync(INTENT_DIR) &&
    fs.existsSync(path.join(INTENT_DIR, 'vision.md')) &&
    fs.existsSync(path.join(INTENT_DIR, 'plan.md'));
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
  const close = () => rl.close();
  return { ask, close };
}

function openWeb() {
  console.log(`\n  Opening ${WEB_URL} ...\n`);
  try {
    if (process.platform === 'darwin') execSync(`open "${WEB_URL}"`);
    else if (process.platform === 'win32') execSync(`start "${WEB_URL}"`);
    else execSync(`xdg-open "${WEB_URL}"`);
  } catch {
    console.log(`  Could not open browser. Visit: ${WEB_URL}\n`);
  }
}

function showStatus() {
  if (!hasExistingArtifacts()) {
    console.log('\n  No .intent/ found in this directory.');
    console.log('  Run `phewsh intent --init` to create one.\n');
    return;
  }

  console.log('\n  .intent/ — artifact status\n');

  const files = ['vision.md', 'plan.md', 'next.md', 'status.md'];
  for (const file of files) {
    const filePath = path.join(INTENT_DIR, file);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const kb = (stat.size / 1024).toFixed(1);
      const updated = stat.mtime.toLocaleDateString();
      console.log(`  ✓ ${file.padEnd(14)} ${kb}KB   updated ${updated}`);
    }
  }

  const nextPath = path.join(INTENT_DIR, 'next.md');
  const statusPath = path.join(INTENT_DIR, 'status.md');
  const actionFile = fs.existsSync(nextPath) ? nextPath : fs.existsSync(statusPath) ? statusPath : null;

  if (actionFile) {
    const content = fs.readFileSync(actionFile, 'utf-8');
    const checkboxes = content.split('\n').filter(l => l.match(/^[-*]\s*\[[ x]\]/));
    if (checkboxes.length > 0) {
      const done = checkboxes.filter(l => l.includes('[x]')).length;
      console.log(`\n  Next Actions: ${done}/${checkboxes.length} complete\n`);
      checkboxes.slice(0, 5).forEach(line => {
        const checked = line.includes('[x]');
        const text = line.replace(/^[-*]\s*\[[ x]\]\s*/, '').replace(/\*\*/g, '');
        console.log(`  ${checked ? '✅' : '⬜'} ${text}`);
      });
      if (checkboxes.length > 5) console.log(`  ... and ${checkboxes.length - 5} more`);
    }
  }

  console.log('\n  Run `phewsh intent --evolve` to update artifacts.\n');
}

async function initIntent() {
  if (hasExistingArtifacts()) {
    console.log('\n  .intent/ already exists in this directory.');
    console.log('  Use `phewsh intent --status` to view or `--evolve` to update.\n');
    return;
  }

  const projectName = path.basename(process.cwd());
  const date = new Date().toISOString().split('T')[0];

  console.log('\n  😮‍💨🤫  phewsh intent --init\n');

  let what = '';
  let goal = '';

  if (process.stdin.isTTY) {
    console.log('  Answer two questions. Your artifacts will be ready instantly.\n');
    const { ask, close } = createPrompter();
    what = await ask('  What are you building? (one or two sentences)\n  > ');
    goal = await ask('\n  What does success look like? What\'s the primary outcome?\n  > ');
    close();
    console.log('');
  } else {
    console.log('  Creating starter artifacts...\n');
  }

  console.log('\n  Creating .intent/ ...\n');

  // Build a starter PPS and generate views from it
  const pps = createPPS({
    entity: projectName,
    archetype: 'product',
    raw: [what, goal].filter(Boolean).join(' '),
    intent: {
      goal: what || '',
      success_criteria: goal ? [goal] : [],
      constraints: [],
      inputs: [],
      outputs: [],
      tasks: [
        { text: 'Refine the vision — complete vision.md', type: 'do' },
        { text: 'Define Phase 1 — what is the smallest thing to ship?', type: 'do' },
        { text: 'Identify the first blocker', type: 'do' },
      ],
    },
  });

  // Truth guard: never overwrite a hand-authored file (a partial .intent/
  // slips past hasExistingArtifacts — e.g. vision.md alone).
  const { written, preserved } = writeGuardedViews(INTENT_DIR, pps);

  console.log(`  ✓ .intent/pps.json     — Compiled spec (the .md files are the truth)`);
  const label = { 'vision.md': 'The north star', 'plan.md': 'The strategy', 'next.md': 'What to do right now' };
  for (const f of written) console.log(`  ✓ .intent/${f.padEnd(12)} — ${label[f]}`);
  for (const f of preserved) console.log(`  ● .intent/${f.padEnd(12)} — kept as-is (yours, hand-authored)`);
  console.log(`
  Tip: Run \`phewsh clarify\` to have AI compile your messy intent into a precise spec.

  Next:
    phewsh clarify            Compile intent → structured spec with AI
    phewsh intent --open      Open the web compass to go deeper
    phewsh intent --status    Check your progress any time
  `);
}

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
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

async function evolveArtifacts() {
  if (!hasExistingArtifacts()) {
    console.log('\n  No .intent/ found. Run `phewsh intent --init` first.\n');
    return;
  }

  const config = loadConfig();
  if (!config?.apiKey) {
    console.log('\n  No API key. Run `phewsh login --set-key` to add one.');
    console.log('  Or use `phewsh intent --open` to evolve via the web app.\n');
    return;
  }

  // Get evolution instruction
  const evolveIdx = args.indexOf('--evolve') !== -1 ? args.indexOf('--evolve') : args.indexOf('-e');
  let instruction = args.slice(evolveIdx + 1).filter(a => !a.startsWith('--')).join(' ').trim();

  if (!instruction && process.stdin.isTTY) {
    const { ask, close } = createPrompter();
    console.log('\n  What changed? Describe what to evolve.\n');
    instruction = await ask('  > ');
    close();
  }

  if (!instruction) {
    instruction = 'Refine and improve these artifacts based on what we now know. Make them more specific and actionable.';
  }

  // Load current artifacts
  const vision = fs.readFileSync(path.join(INTENT_DIR, 'vision.md'), 'utf-8');
  const plan = fs.readFileSync(path.join(INTENT_DIR, 'plan.md'), 'utf-8');
  const nextPath = path.join(INTENT_DIR, 'next.md');
  const next = fs.existsSync(nextPath) ? fs.readFileSync(nextPath, 'utf-8') : '';

  // Build constraint block if gate exists
  const gate = loadGate();
  let constraintBlock = '';
  if (gate?.state === 'active' && gate.constraints) {
    const c = gate.constraints;
    constraintBlock = `\n\nOPERATIONAL CONSTRAINTS (must shape output):
- Budget: $${c.budget || 'unlimited'}
- Time: ${c.timeHoursPerWeek || 'unlimited'} hrs/week
- Skill: ${c.skillLevel}
- Urgency: ${c.urgency}
- Autonomy: ${c.autonomy}`;
  }

  const systemPrompt = `You are an intent evolution engine. You refine project artifacts to be more specific, actionable, and aligned with the user's evolving understanding.${constraintBlock}

Return your response in EXACTLY this format — three sections separated by the exact delimiters shown:

===VISION===
(updated vision.md content)
===PLAN===
(updated plan.md content)
===NEXT===
(updated next.md content with checkbox items like - [ ] task)

Rules:
- Preserve structure and formatting of existing artifacts
- Make changes targeted to the user's instruction
- If constraints are set, ensure all suggestions respect them
- Next actions should be concrete and immediately actionable
- Use markdown formatting`;

  const userPrompt = `INSTRUCTION: ${instruction}

CURRENT VISION:
${vision.slice(0, 3000)}

CURRENT PLAN:
${plan.slice(0, 3000)}

CURRENT NEXT:
${(next || 'No next actions yet').slice(0, 2000)}`;

  console.log('\n  Evolving artifacts...\n');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: require('../lib/providers').DEFAULT_ANTHROPIC_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Parse sections
    const visionMatch = text.match(/===VISION===\s*([\s\S]*?)(?====PLAN===)/);
    const planMatch = text.match(/===PLAN===\s*([\s\S]*?)(?====NEXT===)/);
    const nextMatch = text.match(/===NEXT===\s*([\s\S]*?)$/);

    let updated = 0;

    if (visionMatch?.[1]?.trim()) {
      fs.writeFileSync(path.join(INTENT_DIR, 'vision.md'), visionMatch[1].trim());
      updated++;
    }
    if (planMatch?.[1]?.trim()) {
      fs.writeFileSync(path.join(INTENT_DIR, 'plan.md'), planMatch[1].trim());
      updated++;
    }
    if (nextMatch?.[1]?.trim()) {
      fs.writeFileSync(path.join(INTENT_DIR, 'next.md'), nextMatch[1].trim());
      updated++;
    }

    if (updated > 0) {
      const tokens = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
      console.log(`  ✓ Evolved ${updated} artifact${updated !== 1 ? 's' : ''} (${tokens} tokens)\n`);
      console.log('  Updated:');
      if (visionMatch?.[1]?.trim()) console.log('    vision.md');
      if (planMatch?.[1]?.trim()) console.log('    plan.md');
      if (nextMatch?.[1]?.trim()) console.log('    next.md');
      console.log(`\n  Run \`phewsh intent --status\` to review changes.`);
      console.log(`  Run \`phewsh push\` to sync to cloud.\n`);
    } else {
      console.log('  Could not parse evolved artifacts. Try again or use the web app.\n');
    }
  } catch (err) {
    console.error(`\n  Evolution failed: ${err.message}\n`);
  }
}

function showHelp() {
  console.log(`
  😮‍💨🤫  phewsh intent

  Usage:
    phewsh intent              Show status (or prompt to init if new)
    phewsh intent --init       Create .intent/ with structured artifacts
    phewsh intent --status     Show artifact state and next actions
    phewsh intent --sync       Push .intent/ to cloud (requires login)
    phewsh intent --pull       Pull .intent/ from cloud
    phewsh intent --open       Open the web compass at phewsh.com/intent
    phewsh intent --evolve     Evolve artifacts with AI (in-terminal)
    phewsh intent --evolve "add mobile support"   Evolve with specific instruction

  Artifacts created in .intent/:
    vision.md   — Why this exists and where it's going
    plan.md     — How to get there, in what order
    next.md     — What to do right now (executable checklist)

  These work with any AI coding tool. Your context travels with the project.
  `);
}

// Main
async function main() {
  if (flags.help) {
    showHelp();
  } else if (flags.open) {
    openWeb();
  } else if (flags.init) {
    await initIntent();
  } else if (flags.status) {
    showStatus();
  } else if (flags.sync) {
    const { main: sync } = require('./sync');
    await sync('push');
  } else if (flags.pull) {
    const { main: sync } = require('./sync');
    await sync('pull');
  } else if (flags.evolve) {
    await evolveArtifacts();
  } else {
    if (hasExistingArtifacts()) {
      showStatus();
    } else {
      showHelp();
    }
  }
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
