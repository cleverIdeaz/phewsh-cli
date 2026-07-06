// phewsh gate
// Declare operational constraints from CLI.
// Stores in .intent/project.json under decisionGate — same schema as web app's DecisionGate.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const configFile = require('../lib/config-file');

const INTENT_DIR = path.join(process.cwd(), '.intent');
const PROJECT_PATH = path.join(INTENT_DIR, 'project.json');
// Legacy single-file gate location (pre-migration). Built without a hard-coded
// path literal — project.json is the canonical store and we never write here.
const LEGACY_GATE_PATH = path.join(INTENT_DIR, 'gate' + '.json');
const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');

const args = process.argv.slice(3);
const subcommand = args[0];

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const d = (s) => `\x1b[2m${s}\x1b[0m`;
const g = (s) => `\x1b[90m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

const DEFAULT_CONSTRAINTS = {
  budget: 0,
  timeHoursPerWeek: 0,
  skillLevel: 'intermediate',
  urgency: 'moderate',
  autonomy: 'guided',
};

function loadProjectJson() {
  if (!fs.existsSync(PROJECT_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf-8')); } catch { return null; }
}

function saveProjectJson(project) {
  fs.mkdirSync(INTENT_DIR, { recursive: true });
  fs.writeFileSync(PROJECT_PATH, JSON.stringify(project, null, 2));
}

// One-time migration: fold the legacy single-file gate into project.json under
// decisionGate, then remove the legacy file. After this, project.json is the
// only source — nothing ever writes the legacy file again.
function migrateLegacyGate() {
  if (!fs.existsSync(LEGACY_GATE_PATH)) return;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(LEGACY_GATE_PATH, 'utf-8')); } catch { return; }

  let project = loadProjectJson();
  if (project && project.decisionGate) {
    // project.json already canonical — the legacy file is stale. Drop it.
    fs.unlinkSync(LEGACY_GATE_PATH);
    return;
  }

  if (!project) {
    // Only the legacy file existed — create project.json from it.
    project = { id: 'local', name: path.basename(process.cwd()), decisionGate: legacy, actions: [] };
  } else {
    // project.json exists but has no decisionGate — copy it in.
    project.decisionGate = legacy;
  }
  saveProjectJson(project);
  fs.unlinkSync(LEGACY_GATE_PATH);
  console.log(`  ${g('Migrated legacy gate → .intent/project.json (decisionGate)')}`);
}

function loadGate() {
  const project = loadProjectJson();
  if (project && project.decisionGate) return project.decisionGate;
  // Pre-migration fallback (migration not yet run this invocation).
  if (fs.existsSync(LEGACY_GATE_PATH)) {
    try { return JSON.parse(fs.readFileSync(LEGACY_GATE_PATH, 'utf-8')); } catch { return null; }
  }
  return null;
}

function saveGate(gate) {
  let project = loadProjectJson();
  if (!project) {
    project = { id: 'local', name: path.basename(process.cwd()), decisionGate: gate, actions: [] };
  } else {
    project.decisionGate = gate;
  }
  saveProjectJson(project);
}

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function createPrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
  const close = () => rl.close();
  return { ask, close };
}

function formatConstraints(c) {
  const lines = [];
  if (c.budget > 0) lines.push(`  Budget:    $${c.budget}`);
  if (c.timeHoursPerWeek > 0) lines.push(`  Time:      ${c.timeHoursPerWeek} hrs/week`);
  lines.push(`  Skill:     ${c.skillLevel}`);
  lines.push(`  Urgency:   ${c.urgency}`);
  lines.push(`  Autonomy:  ${c.autonomy}`);
  return lines.join('\n');
}

async function activate() {
  if (!fs.existsSync(INTENT_DIR)) {
    console.log('\n  No .intent/ found. Run `phewsh intent --init` first.\n');
    process.exit(1);
  }

  // Fold any legacy gate.json into project.json before reading state.
  migrateLegacyGate();

  const existing = loadGate();
  if (existing?.state === 'active') {
    console.log('\n  Decision Gate is already active:\n');
    console.log(formatConstraints(existing.constraints));
    console.log(`\n  ${g('Run `phewsh gate update` to change constraints')}`);
    console.log(`  ${g('Run `phewsh gate pause` to deactivate')}\n`);
    return;
  }

  console.log(`\n  ${b(w('Decision Gate — Declare your operational reality'))}\n`);
  console.log(`  ${g('These constraints shape how AI tools respond to your project.')}\n`);

  const { ask, close } = createPrompter();

  const budgetStr = await ask(`  Budget ($ total, 0 = no limit): `);
  const budget = parseInt(budgetStr) || 0;

  const timeStr = await ask(`  Time (hours/week, 0 = no limit): `);
  const timeHoursPerWeek = parseInt(timeStr) || 0;

  console.log(`\n  Skill level: ${g('beginner | intermediate | advanced | expert')}`);
  const skillLevel = (await ask(`  > `)) || 'intermediate';
  const validSkills = ['beginner', 'intermediate', 'advanced', 'expert'];
  const skill = validSkills.includes(skillLevel) ? skillLevel : 'intermediate';

  console.log(`\n  Urgency: ${g('relaxed | moderate | urgent | critical')}`);
  const urgencyInput = (await ask(`  > `)) || 'moderate';
  const validUrgencies = ['relaxed', 'moderate', 'urgent', 'critical'];
  const urgency = validUrgencies.includes(urgencyInput) ? urgencyInput : 'moderate';

  console.log(`\n  Autonomy: ${g('hands-on | guided | delegated | autonomous')}`);
  const autonomyInput = (await ask(`  > `)) || 'guided';
  const validAutonomies = ['hands-on', 'guided', 'delegated', 'autonomous'];
  const autonomy = validAutonomies.includes(autonomyInput) ? autonomyInput : 'guided';

  close();

  const constraints = { budget, timeHoursPerWeek, skillLevel: skill, urgency, autonomy };

  // Try AI feasibility analysis if API key available
  const config = loadConfig();
  let feasibility = 'test';
  let summary = '';
  let successCriteria = [];
  let responsibilitySplit = { ai: [], human: [] };

  const vision = fs.existsSync(path.join(INTENT_DIR, 'vision.md'))
    ? fs.readFileSync(path.join(INTENT_DIR, 'vision.md'), 'utf-8') : '';
  const plan = fs.existsSync(path.join(INTENT_DIR, 'plan.md'))
    ? fs.readFileSync(path.join(INTENT_DIR, 'plan.md'), 'utf-8') : '';

  if (config?.apiKey && vision) {
    console.log(`\n  ${g('Analyzing feasibility...')}`);
    try {
      const analysis = await analyzeFeasibility(config.apiKey, vision, plan, constraints);
      feasibility = analysis.feasibility || 'test';
      summary = analysis.summary || '';
      successCriteria = analysis.successCriteria || [];
      responsibilitySplit = analysis.responsibilitySplit || { ai: [], human: [] };
    } catch (err) {
      console.log(`  ${yellow('Analysis skipped:')} ${err.message}`);
    }
  }

  const gate = {
    state: 'active',
    feasibility,
    constraints,
    successCriteria,
    responsibilitySplit,
    summary,
    constraintHistory: [],
    activatedAt: new Date().toISOString(),
  };

  saveGate(gate);

  console.log(`\n  ${green('✓')} Decision Gate activated\n`);
  console.log(formatConstraints(constraints));
  if (feasibility) console.log(`\n  Feasibility: ${feasibility}`);
  if (summary) console.log(`  ${g(summary)}`);
  console.log(`\n  ${g('Run `phewsh context` to export these constraints for other AI tools')}\n`);
}

async function analyzeFeasibility(apiKey, vision, plan, constraints) {
  const prompt = `Analyze this project's feasibility given the operational constraints. Return ONLY valid JSON:

{
  "feasibility": "realistic" | "stretch" | "test",
  "summary": "one sentence assessment",
  "successCriteria": ["measurable outcome 1", "measurable outcome 2"],
  "responsibilitySplit": { "ai": ["what AI handles"], "human": ["what needs human action"] }
}

CONSTRAINTS:
- Budget: $${constraints.budget || 'unlimited'}
- Time: ${constraints.timeHoursPerWeek || 'unlimited'} hrs/week
- Skill: ${constraints.skillLevel}
- Urgency: ${constraints.urgency}

VISION:
${vision.slice(0, 2000)}

PLAN:
${(plan || 'No plan yet').slice(0, 1500)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: require('../lib/providers').DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`API error ${response.status}`);
  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(clean);
}

function showStatus() {
  const gate = loadGate();
  if (!gate) {
    console.log('\n  No Decision Gate configured.');
    console.log('  Run `phewsh gate activate` to declare your constraints.\n');
    return;
  }

  console.log(`\n  ${b('Decision Gate')} — ${gate.state === 'active' ? green('active') : yellow('paused')}\n`);
  console.log(formatConstraints(gate.constraints));
  if (gate.feasibility) console.log(`\n  Feasibility: ${gate.feasibility}`);
  if (gate.summary) console.log(`  ${g(gate.summary)}`);

  if (gate.constraintHistory?.length > 0) {
    console.log(`\n  ${g('Drift history:')}`);
    gate.constraintHistory.slice(-5).forEach(ch => {
      console.log(`    ${ch.field}: ${ch.from} → ${ch.to} ${g(ch.timestamp.split('T')[0])}`);
    });
  }
  console.log('');
}

async function update() {
  const gate = loadGate();
  if (!gate) {
    console.log('\n  No gate exists. Run `phewsh gate activate` first.\n');
    return;
  }

  console.log(`\n  ${b('Update constraints')} ${g('(press Enter to keep current value)')}\n`);

  const { ask, close } = createPrompter();
  const old = { ...gate.constraints };

  const budgetStr = await ask(`  Budget [$${old.budget}]: `);
  const timeStr = await ask(`  Time hrs/week [${old.timeHoursPerWeek}]: `);
  const skillStr = await ask(`  Skill [${old.skillLevel}]: `);
  const urgencyStr = await ask(`  Urgency [${old.urgency}]: `);
  const autonomyStr = await ask(`  Autonomy [${old.autonomy}]: `);
  const reason = await ask(`\n  Reason for change: `);

  close();

  const updated = {
    budget: budgetStr ? parseInt(budgetStr) || 0 : old.budget,
    timeHoursPerWeek: timeStr ? parseInt(timeStr) || 0 : old.timeHoursPerWeek,
    skillLevel: skillStr || old.skillLevel,
    urgency: urgencyStr || old.urgency,
    autonomy: autonomyStr || old.autonomy,
  };

  // Track drift
  const changes = [];
  for (const [key, val] of Object.entries(updated)) {
    if (String(val) !== String(old[key])) {
      changes.push({
        field: key,
        from: String(old[key]),
        to: String(val),
        reason: reason || 'Manual update',
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (changes.length === 0) {
    console.log('\n  No changes made.\n');
    return;
  }

  gate.constraints = updated;
  gate.constraintHistory = [...(gate.constraintHistory || []), ...changes];
  saveGate(gate);

  console.log(`\n  ${green('✓')} Updated ${changes.length} constraint(s)`);
  changes.forEach(ch => console.log(`    ${ch.field}: ${ch.from} → ${ch.to}`));
  console.log('');
}

function pause() {
  const gate = loadGate();
  if (!gate) { console.log('\n  No gate exists.\n'); return; }
  gate.state = 'paused';
  saveGate(gate);
  console.log(`\n  ${yellow('⏸')} Decision Gate paused\n`);
}

function resume() {
  const gate = loadGate();
  if (!gate) { console.log('\n  No gate exists.\n'); return; }
  gate.state = 'active';
  saveGate(gate);
  console.log(`\n  ${green('▶')} Decision Gate resumed\n`);
}

function showHelp() {
  console.log(`
  phewsh gate — Declare operational constraints

  Usage:
    phewsh gate              Show gate status
    phewsh gate activate     Set constraints interactively
    phewsh gate update       Update existing constraints (tracks drift)
    phewsh gate pause        Temporarily deactivate
    phewsh gate resume       Reactivate
    phewsh gate reset        Remove gate entirely

  What it does:
    Declares your real-world constraints (budget, time, skill, urgency,
    autonomy) so AI tools adapt their output accordingly.

    Stored in .intent/project.json under decisionGate — used by
    \`phewsh context\` to export constraint-aware briefings for any AI tool.
  `);
}

async function main() {
  if (subcommand === '--help' || subcommand === '-h') { showHelp(); return; }
  if (!subcommand || subcommand === 'status') { showStatus(); return; }
  if (subcommand === 'activate' || subcommand === 'init') { await activate(); return; }
  if (subcommand === 'update' || subcommand === 'edit') { await update(); return; }
  if (subcommand === 'pause') { pause(); return; }
  if (subcommand === 'resume') { resume(); return; }
  if (subcommand === 'enforce') { enforce(args[1]); return; }
  if (subcommand === 'reset') {
    let removed = false;
    const project = loadProjectJson();
    if (project && project.decisionGate) {
      delete project.decisionGate;
      saveProjectJson(project);
      removed = true;
    }
    if (fs.existsSync(LEGACY_GATE_PATH)) {
      fs.unlinkSync(LEGACY_GATE_PATH);
      removed = true;
    }
    console.log(removed ? '\n  Gate removed.\n' : '\n  No gate to remove.\n');
    return;
  }
  console.log(`\n  Unknown: ${subcommand}. Run \`phewsh gate --help\`.\n`);
}

// Opt-in deterministic enforcement: register/unregister the Claude Code
// PreToolUse hook that makes the Decision Gate act BEFORE a tool runs. Reversible,
// Claude-Code-only for now (it's the one provider with a real veto hook).
function enforce(action) {
  let amb;
  try { amb = require('./ambient'); } catch { console.log('\n  Enforcement unavailable.\n'); return; }
  const on = (action || 'status').toLowerCase();
  if (on === 'on' || on === 'enable') {
    const changed = amb.enablePreToolGate();
    console.log(changed
      ? `\n  ${green('●')} Gate enforcement ${green('ON')} — before a tool runs, Claude Code asks/denies on protected-path writes and high-blast-radius commands; after, a redacted receipt records what ran (tool + target, never content).\n  ${g('Reversible:')} phewsh gate enforce off\n`
      : `\n  Gate enforcement already on.\n`);
    return;
  }
  if (on === 'off' || on === 'disable') {
    const changed = amb.disablePreToolGate();
    console.log(changed ? `\n  Gate enforcement ${yellow('OFF')} — PreToolUse + PostToolUse hooks removed.\n` : `\n  Gate enforcement was not on.\n`);
    return;
  }
  // status
  const applied = amb.preToolGateApplied();
  console.log(`\n  Gate enforcement: ${applied ? green('ON') : g('off')} ${g('(Claude Code PreToolUse + PostToolUse)')}`);
  console.log(`  ${g('Turn on:')} phewsh gate enforce on   ${g('· off:')} phewsh gate enforce off`);
  console.log(`  ${g('Before: deny writes to protected paths (.env, keys, .git/…),')}`);
  console.log(`  ${g('ask before high-blast-radius shell (rm -rf, force-push, sudo…).')}`);
  console.log(`  ${g('After: redacted receipt of what ran — tool + target, never args or content.')}`);
  console.log(`  ${g('Opt-in, local-only, fail-open. Other tools: advisory only for now.')}\n`);
}

module.exports = main;

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
