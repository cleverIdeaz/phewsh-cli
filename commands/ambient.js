// phewsh ambient — continuity without launching phewsh.
//
// Principle (Jun 12): ambient before primary. Installing phewsh should make
// the tools you already use better — context arrives, sessions leave
// breadcrumbs — without you ever typing `phewsh`.
//
// Constraint (non-negotiable): radical transparency. Nothing changes
// without a consent screen that names every file and every line. The
// ledger (~/.phewsh/ambient.json) records exactly what was applied and
// how to undo it. Trust matters more than automation here.
//
//   phewsh ambient            — status: detected tools, what's enhanced
//   phewsh ambient on [--yes] — consent screen, then apply
//   phewsh ambient off        — remove everything, update ledger
//   phewsh ambient explain    — inspect the open adapter contract

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { listHarnesses } = require('../lib/harnesses');
const selfheal = require('../lib/selfheal');
const slash = require('../lib/slash-commands');
const intentSkills = require('../lib/intent-skills');

const PHEWSH_DIR = path.join(os.homedir(), '.phewsh');
const LEDGER_FILE = path.join(PHEWSH_DIR, 'ambient.json');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const ADAPTER_CONTRACT = path.join(__dirname, '..', 'docs', 'adapter-contract.json');

const HOOK_START = { type: 'command', command: 'phewsh hook session-start' };
const HOOK_END = { type: 'command', command: 'phewsh hook session-end' };
// Opt-in Decision Gate enforcement (separate from ambient context sync). The
// matcher scopes the hook to the tools the policy actually judges, so it never
// fires on harmless reads.
const HOOK_PRETOOL = { type: 'command', command: 'phewsh hook pre-tool' };
// The receipt half of the lifecycle: after a write-ish tool runs, record a
// redacted breadcrumb (tool + target, never args/content). Installed and
// removed together with the pre-tool gate — one toggle, whole lifecycle.
const HOOK_POSTTOOL = { type: 'command', command: 'phewsh hook post-tool' };
// Bash IS gated pre-tool: the policy's catastrophic tier hard-denies (never
// prompts, so auto mode flows) and its ask tier is autonomy-gated. The old
// "drop Bash to unblock auto mode" fix is superseded by that split.
const PRETOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
const POSTTOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
// Codex (0.144+) reads the same hook shape — matcher + command entries per
// lifecycle event — from ~/.codex/hooks.json. One policy, two harnesses.
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_HOOKS = path.join(CODEX_DIR, 'hooks.json');

// ANSI helpers (256-color per cli/lib/ui.js palette rules)
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const teal = (s) => `\x1b[38;5;79m${s}\x1b[0m`;
const sage = (s) => `\x1b[38;5;151m${s}\x1b[0m`;
const slate = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const cream = (s) => `\x1b[38;5;230m${s}\x1b[0m`;
const peach = (s) => `\x1b[38;5;216m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8')); } catch { return { version: 1, applied: {}, seenHarnesses: [] }; }
}

function loadAdapterContract() {
  return JSON.parse(fs.readFileSync(ADAPTER_CONTRACT, 'utf-8'));
}

function explainAdapterContract(asJson) {
  const contract = loadAdapterContract();
  if (asJson) {
    console.log(JSON.stringify(contract, null, 2));
    return;
  }

  const truth = contract.projectTruth;
  console.log('');
  console.log(`  ${b(cream('PHEWSH adapter contract'))} ${sage('— one truth, removable layers')}`);
  console.log('');
  console.log(`  ${b(cream(truth.label))} ${slate('· ' + truth.owner + '-owned · ' + truth.path)}`);
  console.log(`    ${sage('authority')}  ${cream(truth.authority)}`);
  console.log(`    ${sage('create')}     ${cream(truth.create)} ${slate('· inspect: ' + truth.inspect)}`);
  console.log(`    ${sage('remove')}     ${slate(truth.remove)}`);

  for (const layer of contract.layers) {
    console.log('');
    console.log(`  ${b(cream(layer.label))} ${slate('· ' + layer.kind + ' · ' + layer.state + ' · ' + layer.scope)}`);
    console.log(`    ${sage('targets')}    ${cream(layer.targets.join(', '))}`);
    if (layer.apply) console.log(`    ${sage('apply')}      ${cream(layer.apply)}`);
    if (layer.refresh) console.log(`    ${sage('refresh')}    ${cream(layer.refresh)}`);
    console.log(`    ${sage('inspect')}    ${cream(layer.inspect)}`);
    if (layer.remove) console.log(`    ${sage('remove')}     ${cream(layer.remove)}`);
    console.log(`    ${sage('writes')}     ${layer.writes.length ? slate(layer.writes.join(', ')) : slate('none')}`);
    console.log(`    ${sage('ownership')}  ${slate(layer.ownership)}`);
    console.log(`    ${sage('authority')}  ${cream(layer.authority)}`);
    console.log(`    ${sage('boundary')}   ${slate(layer.boundary)}`);
  }

  console.log('');
  console.log(`  ${sage('Machine-readable:')} ${cream('phewsh ambient explain --json')} ${slate('· phewsh.com/platform/adapters.json')}`);
  console.log('');
}

function help() {
  console.log('');
  console.log(`  ${b(cream('phewsh ambient'))} ${sage('— inspect or install reversible adapters')}`);
  console.log('');
  console.log(`  ${cream('status'.padEnd(22))} ${slate('Inspect installed skill, hook, and projection state')}`);
  console.log(`  ${cream('explain'.padEnd(22))} ${slate('Read the open adapter and authority contract')}`);
  console.log(`  ${cream('explain --json'.padEnd(22))} ${slate('Emit the same contract as machine-readable JSON')}`);
  console.log(`  ${cream('on [--yes]'.padEnd(22))} ${slate('Preview, consent to, and install ambient adapters')}`);
  console.log(`  ${cream('off'.padEnd(22))} ${slate('Remove only unchanged ambient-owned additions')}`);
  console.log('');
  console.log(`  ${sage('.intent/ remains project truth. Safety hooks stay independent:')} ${cream('phewsh gate enforce status')}`);
  console.log('');
}

function saveLedger(ledger) {
  if (!fs.existsSync(PHEWSH_DIR)) fs.mkdirSync(PHEWSH_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

function loadClaudeSettings() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8')); } catch { return null; }
}

function hasHook(settings, eventName, command) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some(e => (e.hooks || []).some(h => h.command === command));
}

function claudeApplied() {
  const s = loadClaudeSettings();
  return !!s && hasHook(s, 'SessionStart', HOOK_START.command) && hasHook(s, 'SessionEnd', HOOK_END.command);
}

function applyClaudeHooks() {
  const settings = loadClaudeSettings() || {};
  settings.hooks = settings.hooks || {};
  const changes = [];
  for (const [event, hook] of [['SessionStart', HOOK_START], ['SessionEnd', HOOK_END]]) {
    settings.hooks[event] = settings.hooks[event] || [];
    if (!hasHook(settings, event, hook.command)) {
      settings.hooks[event].push({ hooks: [hook] });
      changes.push(`hooks.${event} += "${hook.command}"`);
    }
  }
  if (changes.length > 0) {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  }
  return changes;
}

function removeClaudeHooks() {
  const settings = loadClaudeSettings();
  if (!settings?.hooks) return [];
  const removed = [];
  for (const [event, hook] of [['SessionStart', HOOK_START], ['SessionEnd', HOOK_END]]) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const before = entries.length;
    settings.hooks[event] = entries
      .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => h.command !== hook.command) }))
      .filter(e => e.hooks.length > 0);
    if (settings.hooks[event].length !== before) removed.push(`hooks.${event} -= "${hook.command}"`);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (removed.length > 0) fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  return removed;
}

// ── Decision Gate enforcement (PreToolUse) — opt-in, reversible ──────────────
// One policy, two harnesses: the same hook entries go into Claude Code's
// settings.json and Codex's hooks.json (same schema). Foreign hooks in
// either file are always preserved.
function preToolGateApplied() {
  const s = loadClaudeSettings();
  return !!s && hasHook(s, 'PreToolUse', HOOK_PRETOOL.command);
}

function codexGateApplied() {
  try {
    const s = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf-8'));
    return hasHook(s, 'PreToolUse', HOOK_PRETOOL.command);
  } catch { return false; }
}

// Add/repair phewsh gate entries in a { hooks: { <event>: [...] } } container
// (the shape both harnesses share). Existing entries get their matcher
// normalized to the current canonical one — that's the upgrade path for
// installs from older phewsh versions.
function applyGateHooks(container) {
  container.hooks = container.hooks || {};
  let changed = false;
  for (const [event, hook, matcher] of [['PreToolUse', HOOK_PRETOOL, PRETOOL_MATCHER], ['PostToolUse', HOOK_POSTTOOL, POSTTOOL_MATCHER]]) {
    container.hooks[event] = container.hooks[event] || [];
    const existing = container.hooks[event].filter(e => (e.hooks || []).some(h => h.command === hook.command));
    if (existing.length > 0) {
      for (const entry of existing) {
        if (entry.matcher !== matcher) {
          entry.matcher = matcher;
          changed = true;
        }
      }
      continue;
    }
    container.hooks[event].push({ matcher, hooks: [hook] });
    changed = true;
  }
  return changed;
}

function removeGateHooks(container) {
  if (!container?.hooks) return false;
  let changed = false;
  for (const [event, hook] of [['PreToolUse', HOOK_PRETOOL], ['PostToolUse', HOOK_POSTTOOL]]) {
    const entries = container.hooks[event];
    if (!entries) continue;
    const before = entries.length;
    container.hooks[event] = entries
      .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => h.command !== hook.command) }))
      .filter(e => e.hooks.length > 0);
    if ((container.hooks[event] || []).length === 0) delete container.hooks[event];
    if (before !== (container.hooks[event]?.length ?? 0)) changed = true;
  }
  return changed;
}

function enablePreToolGate() {
  let changed = false;
  const installed = listHarnesses().filter(h => h.installed).map(h => h.id);
  const claudeDir = path.dirname(CLAUDE_SETTINGS);
  if (installed.includes('claude-code') || fs.existsSync(claudeDir)) {
    const settings = loadClaudeSettings() || {};
    if (applyGateHooks(settings)) {
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
      changed = true;
    }
  }
  if (installed.includes('codex') || fs.existsSync(CODEX_DIR)) {
    let codex = {};
    try { codex = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf-8')) || {}; } catch { /* first install */ }
    if (applyGateHooks(codex)) {
      fs.mkdirSync(CODEX_DIR, { recursive: true });
      fs.writeFileSync(CODEX_HOOKS, JSON.stringify(codex, null, 2));
      changed = true;
    }
  }
  return changed;
}

function disablePreToolGate() {
  let changed = false;
  const settings = loadClaudeSettings();
  if (settings && removeGateHooks(settings)) {
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    changed = true;
  }
  try {
    const codex = JSON.parse(fs.readFileSync(CODEX_HOOKS, 'utf-8'));
    if (removeGateHooks(codex)) {
      fs.writeFileSync(CODEX_HOOKS, JSON.stringify(codex, null, 2));
      changed = true;
    }
  } catch { /* no codex hooks file — nothing to remove */ }
  return changed;
}

function displayPath(file) {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep)
    ? '~' + file.slice(home.length)
    : file;
}

function printProjectSkillPrecedence(overrides, heading = 'Project-local intent skill precedence:') {
  if (!overrides || overrides.length === 0) return;
  console.log('');
  console.log(`  ${b(heading)}`);
  for (const override of overrides) {
    const exact = override.state === 'exact';
    const detail = exact
      ? 'matches Phewsh canonical · user-owned and preserved'
      : override.state === 'different'
        ? 'differs from Phewsh canonical · can override the user-level skill'
        : 'could not be read · can override the user-level skill';
    console.log(`    ${exact ? green('●') : yellow('!')} ${cream(override.relative)} ${slate('(' + override.id + ' · ' + detail + ')')}`);
  }
  console.log(`    ${slate('Phewsh never edits project-local skills; review, rename, or remove one yourself if the user-level skill should win.')}`);
}

function projectProjectionPlan() {
  try {
    const root = require('../lib/sequencer/discover').resolveProjectRoot(process.cwd());
    if (!fs.existsSync(path.join(root, '.intent'))) return null;
    return { root, files: selfheal.TARGET_FILES };
  } catch { return null; }
}

function showConsentScreen(harnesses) {
  const installed = harnesses.filter(h => h.installed);
  const hasClaude = installed.some(h => h.id === 'claude-code');
  const globalTargets = selfheal.detectGlobalTargets();
  const skillTargets = intentSkills.detectIntentSkillTargets();
  const projectSkillOverrides = intentSkills.projectIntentSkillStatus();
  const slashTargets = slash.detectSlashTargets();
  const projectPlan = projectProjectionPlan();
  console.log('');
  console.log(`  ${b(cream('PHEWSH ambient'))} ${sage('— continuity without launching phewsh')}`);
  console.log('');
  console.log(`  ${sage('Detected on this machine:')}`);
  for (const h of installed) {
    const note = h.id === 'claude-code'
      ? teal('intent skill + session hooks + generated context')
      : h.id === 'codex'
        ? teal('intent skill + generated context; safety hooks use gate enforce')
        : slate('generated project/base context adapter');
    console.log(`    ${green('✓')} ${cream(h.label.padEnd(14))} ${note}`);
  }
  if (hasClaude) {
    console.log('');
    console.log(`  ${b('Claude Code runtime behavior:')}`);
    console.log(`    ${teal('SessionStart')}  ${sage('injects a bounded .intent/ brief: vision, next steps, constraints.')}`);
    console.log(`    ${teal('SessionEnd')}    ${sage('appends time, project, and cwd metadata to')}`);
    console.log(`                  ${cream('~/.phewsh/ambient-sessions.jsonl')}${sage('.')} ${b(sage('Never transcript contents.'))}`);
  }

  console.log('');
  console.log(`  ${b('Exact files this command may write:')}`);
  if (hasClaude) console.log(`    ${teal('+')} ${cream(displayPath(CLAUDE_SETTINGS))} ${slate('(two Claude session-hook entries; other settings preserved)')}`);
  if (skillTargets.length > 0) {
    for (const target of skillTargets) {
      console.log(`    ${teal('+')} ${cream(displayPath(target.file))} ${slate('(' + target.id + ' intent skill; user-owned copies preserved)')}`);
    }
  }
  for (const target of globalTargets) {
    console.log(`    ${teal('+')} ${cream(displayPath(target.path))} ${slate('(' + target.label + ' marked base-file block)')}`);
  }
  for (const file of projectPlan?.files || []) {
    console.log(`    ${teal('+')} ${cream(path.join(projectPlan.root, file))} ${slate('(marked project context block; human text preserved)')}`);
  }
  for (const target of slashTargets) {
    console.log(`    ${teal('+')} ${cream(displayPath(target.path))} ${slate('(' + target.id + ' /intent fallback; user-owned command preserved)')}`);
  }
  console.log(`    ${teal('+')} ${cream(displayPath(LEDGER_FILE))} ${slate('(adapter receipt and opt-out state)')}`);
  if (skillTargets.length > 0) console.log(`    ${teal('+')} ${cream(displayPath(intentSkills.RECEIPT_FILE))} ${slate('(ownership hashes for safe updates/removal)')}`);
  const legacyCodexPrompt = path.join(os.homedir(), '.codex', 'prompts', 'intent.md');
  console.log(`    ${peach('↻')} ${cream(displayPath(legacyCodexPrompt))} ${slate('(removed only if marked phewsh-managed)')}`);
  printProjectSkillPrecedence(projectSkillOverrides, 'Project-local intent skills this command will not write:');
  console.log('');
  console.log(`  ${sage('Project truth stays in .intent/. Native transcripts stay in their tools.')}`);
  console.log(`  ${sage('Safety/receipt hooks are a separate layer:')} ${cream('phewsh gate enforce on|off|status')}${sage('.')}`);
  console.log(`  ${sage('Undo ambient only:')} ${cream('phewsh ambient off')} ${sage('· inspect first/after:')} ${cream('phewsh ambient status')}`);
  console.log(`  ${slate('Choosing No changes no AI-tool file; only the opt-out is saved in ~/.phewsh/ambient.json.')}`);
  console.log('');
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function turnOn(skipConfirm) {
  const harnesses = listHarnesses();
  const installed = harnesses.filter(h => h.installed);
  const hasClaude = installed.some(h => h.id === 'claude-code');
  showConsentScreen(harnesses);

  if (!skipConfirm) {
    const ok = await confirm(`  ${b('Apply?')} ${slate('[y/N] ')}`);
    if (!ok) {
      // A declined prompt is a deliberate opt-out. The CLI never turns these
      // adapters on from a bare launch; only a later explicit `ambient on` can.
      const led = loadLedger();
      led.disabled = true;
      saveLedger(led);
      console.log(`  ${sage('No AI-tool files changed.')} ${slate('(Run `phewsh ambient on` anytime to review again.)')}`);
      console.log('');
      return;
    }
  }

  const changes = hasClaude ? applyClaudeHooks() : [];
  const { written } = selfheal.syncGlobalBaseFiles();
  const projectPlan = projectProjectionPlan();
  const projectWritten = selfheal.syncContextFiles().synced || [];
  const skillResult = intentSkills.installIntentSkills();
  const slashWritten = slash.installSlashCommands().written;
  const ledger = loadLedger();
  if (hasClaude) {
    ledger.applied['claude-code'] = {
      at: new Date().toISOString(),
      file: CLAUDE_SETTINGS,
      changes,
      captures: '~/.phewsh/ambient-sessions.jsonl — timestamp, project, cwd only',
      undo: 'phewsh ambient off',
    };
  }
  if (written.length > 0 || ledger.applied.globalBase) {
    ledger.applied.globalBase = {
      at: new Date().toISOString(),
      files: written.length > 0 ? written : (ledger.applied.globalBase || {}).files || [],
      undo: 'phewsh ambient off',
    };
  }
  if (slashWritten.length > 0 || ledger.applied.slashCommands) {
    ledger.applied.slashCommands = {
      at: new Date().toISOString(),
      tools: slashWritten.length > 0 ? slashWritten : (ledger.applied.slashCommands || {}).tools || [],
      undo: 'phewsh ambient off',
    };
  }
  if (projectPlan && projectWritten.length > 0) {
    const previous = Array.isArray(ledger.applied.projectContext) ? ledger.applied.projectContext : [];
    const sameRoot = previous.find(entry => entry.root === projectPlan.root);
    const files = [...new Set([...(sameRoot?.files || []), ...projectWritten])];
    ledger.applied.projectContext = [
      ...previous.filter(entry => entry.root !== projectPlan.root),
      { root: projectPlan.root, files, undo: 'phewsh ambient off' },
    ];
  }
  const skillStatus = intentSkills.intentSkillStatus();
  if (skillStatus.checked.length > 0) {
    ledger.applied.intentSkill = {
      at: new Date().toISOString(),
      tools: skillStatus.satisfied,
      source: 'phewsh/skills/intent/SKILL.md',
      undo: 'phewsh ambient off',
    };
  }
  ledger.seenHarnesses = installed.map(h => h.id);
  ledger.disabled = false;
  saveLedger(ledger);

  console.log('');
  console.log(`  ${green('●')} ${b('Ambient is on.')}`);
  changes.forEach(c => console.log(`    ${teal('+')} ${slate(c)}`));
  written.forEach(f => console.log(`    ${teal('+')} ${slate('base file ' + f + ' (machine-wide phewsh awareness)')}`));
  projectWritten.forEach(f => console.log(`    ${teal('+')} ${slate('project block ' + f + ' (shared canonical core)')}`));
  skillResult.written.forEach(id => console.log(`    ${teal('+')} ${cream('intent skill')} ${slate('installed for ' + id)}`));
  skillResult.preserved.forEach(id => console.log(`    ${sage('●')} ${slate(id + ' already has its own intent skill — preserved')}`));
  if (skillResult.migrated.length) console.log(`    ${teal('↻')} ${slate('replaced the managed legacy Codex prompt with the open skill')}`);
  if (slashWritten.length) console.log(`    ${teal('+')} ${cream('/intent')} ${slate('command added to ' + slashWritten.join(', '))}`);
  printProjectSkillPrecedence(intentSkills.projectIntentSkillStatus());
  console.log('');
  if (hasClaude) console.log(`  ${sage('Next Claude Code session in a project with')} ${cream('.intent/')} ${sage('starts pre-briefed.')}`);
  if (written.length > 0) {
    console.log(`  ${sage('Detected compatible tools now recognize')} ${cream('.intent/')} ${sage('as project docs through marked adapters.')}`);
  }
  console.log(`  ${sage('You never have to launch phewsh for this to work.')}`);
  console.log('');
}

function turnOff() {
  const removed = removeClaudeHooks();
  const { removed: removedGlobal } = selfheal.removeGlobalBaseFiles();
  const { removed: removedSkills, preserved: preservedSkills } = intentSkills.removeIntentSkills();
  const { removed: removedSlash } = slash.removeSlashCommands();
  const ledger = loadLedger();
  const removedProject = [];
  for (const entry of Array.isArray(ledger.applied.projectContext) ? ledger.applied.projectContext : []) {
    const result = selfheal.removeProjectContextFiles({ cwd: entry.root, targets: entry.files });
    removedProject.push(...result.removed.map(file => path.join(entry.root, file)));
  }
  delete ledger.applied['claude-code'];
  delete ledger.applied.globalBase;
  delete ledger.applied.slashCommands;
  delete ledger.applied.intentSkill;
  delete ledger.applied.projectContext;
  ledger.disabled = true;
  saveLedger(ledger);
  console.log('');
  if (removed.length > 0 || removedGlobal.length > 0 || removedProject.length > 0 || removedSkills.length > 0 || preservedSkills.length > 0 || removedSlash.length > 0) {
    console.log(`  ${green('●')} ${b('Ambient is off.')}`);
    removed.forEach(c => console.log(`    ${peach('-')} ${slate(c)}`));
    removedGlobal.forEach(f => console.log(`    ${peach('-')} ${slate('base file ' + f + ' (phewsh block removed)')}`));
    removedProject.forEach(f => console.log(`    ${peach('-')} ${slate('project block ' + f + ' (human content preserved)')}`));
    removedSkills.forEach(id => console.log(`    ${peach('-')} ${slate('intent skill for ' + id)}`));
    preservedSkills.forEach(id => console.log(`    ${sage('●')} ${slate('modified/user intent skill for ' + id + ' preserved')}`));
    if (removedSlash.length) console.log(`    ${peach('-')} ${slate('/intent command removed from ' + removedSlash.join(', '))}`);
    console.log(`  ${sage('Breadcrumb log kept at')} ${cream('~/.phewsh/ambient-sessions.jsonl')} ${sage('— delete it if you want; phewsh never will.')}`);
  } else {
    console.log(`  ${sage('Nothing was applied — nothing to remove.')}`);
  }
  console.log('');
}

function status() {
  const harnesses = listHarnesses();
  const ledger = loadLedger();
  const skills = intentSkills.intentSkillStatus();
  const skillLabel = (id) => {
    if (!skills.checked.includes(id) || !skills.satisfied.includes(id)) return null;
    if ((skills.outdated || []).includes(id)) return 'native intent skill update available — phewsh ambient on';
    return skills.exact.includes(id) ? 'native intent skill on' : 'custom intent skill preserved';
  };
  console.log('');
  console.log(`  ${b(cream('PHEWSH ambient'))} ${sage('— status')}`);
  console.log(`  ${slate('Project truth stays in .intent/. Each adapter below is independent and reversible.')}`);
  console.log('');
  for (const h of harnesses.filter(h => h.installed)) {
    if (h.id === 'claude-code') {
      const sessionOn = claudeApplied();
      const skill = skillLabel(h.id);
      const gateOn = preToolGateApplied();
      const layers = [
        sessionOn ? 'session hooks on' : 'session hooks available',
        skill || 'intent skill available',
        gateOn ? 'safety/receipt hooks on' : 'safety hooks off',
      ];
      const active = sessionOn || !!skill || gateOn;
      console.log(`    ${active ? green('●') : yellow('○')} ${cream(h.label.padEnd(14))} ${active ? teal(layers.join(' · ')) : sage(layers.join(' · '))}`);
      const entry = ledger.applied['claude-code'];
      if (entry) {
        console.log(`        ${slate('applied ' + entry.at)}`);
        (entry.changes || []).forEach(c => console.log(`        ${slate('· ' + c + ' (' + entry.file + ')')}`));
        console.log(`        ${slate('· captures: ' + entry.captures)}`);
      }
    } else if (h.id === 'codex') {
      const skill = skillLabel(h.id);
      const gateOn = codexGateApplied();
      const layers = [skill || 'intent skill available', gateOn ? 'safety/receipt hooks on' : 'safety hooks off', 'generated context supported'];
      const active = !!skill || gateOn;
      console.log(`    ${active ? green('●') : yellow('○')} ${cream(h.label.padEnd(14))} ${active ? teal(layers.join(' · ')) : sage(layers.join(' · '))}`);
    } else {
      console.log(`    ${slate('○')} ${cream(h.label.padEnd(14))} ${slate('detected · generated project/base context adapter')}`);
    }
  }
  printProjectSkillPrecedence(skills.projectOverrides || []);

  // Machine-wide base files — what phewsh wrote so every tool is aware.
  const gb = ledger.applied.globalBase;
  const detected = selfheal.detectGlobalTargets();
  if (gb && (gb.files || []).length > 0) {
    console.log('');
    console.log(`    ${green('●')} ${cream('Machine-wide awareness'.padEnd(22))} ${teal('on')} ${slate('(applied ' + gb.at + ')')}`);
    (gb.files || []).forEach(f => console.log(`        ${slate('· ' + f)}`));
  } else if (detected.length > 0) {
    console.log('');
    console.log(`    ${yellow('○')} ${cream('Machine-wide awareness'.padEnd(22))} ${sage('available for ' + detected.map(t => t.label).join(', ') + ' — phewsh ambient on')}`);
  }

  // New harnesses since last apply — the re-offer.
  const seen = ledger.seenHarnesses || [];
  const fresh = harnesses.filter(h => h.installed && !seen.includes(h.id));
  if (seen.length > 0 && fresh.length > 0) {
    console.log('');
    console.log(`  ${peach('New since last time:')} ${cream(fresh.map(h => h.label).join(', '))}`);
  }

  // Recent breadcrumbs — show the user exactly what ambient has recorded.
  const logFile = path.join(PHEWSH_DIR, 'ambient-sessions.jsonl');
  try {
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    console.log('');
    console.log(`  ${sage('Last ambient breadcrumbs (' + lines.length + ' total):')}`);
    lines.slice(-3).forEach(l => {
      try {
        const e = JSON.parse(l);
        console.log(`    ${slate(e.ts + ' · ' + e.event + ' · ' + (e.project || path.basename(e.cwd || '?')))}`);
      } catch { /* skip bad line */ }
    });
  } catch { /* no breadcrumbs yet */ }
  console.log('');
}

async function main() {
  const sub = process.argv[3] || 'status';
  const skipConfirm = process.argv.includes('--yes');
  if (['help', '--help', '-h'].includes(sub)) return help();
  if (sub === 'explain') return explainAdapterContract(process.argv.includes('--json'));
  if (sub === 'on') return turnOn(skipConfirm);
  if (sub === 'off') return turnOff();
  return status();
}

module.exports = main;
module.exports.enablePreToolGate = enablePreToolGate;
module.exports.disablePreToolGate = disablePreToolGate;
module.exports.preToolGateApplied = preToolGateApplied;
module.exports.codexGateApplied = codexGateApplied;
