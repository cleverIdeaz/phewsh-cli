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

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { listHarnesses } = require('../lib/harnesses');
const selfheal = require('../lib/selfheal');
const slash = require('../lib/slash-commands');

const PHEWSH_DIR = path.join(os.homedir(), '.phewsh');
const LEDGER_FILE = path.join(PHEWSH_DIR, 'ambient.json');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

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
const PRETOOL_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';

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
function preToolGateApplied() {
  const s = loadClaudeSettings();
  return !!s && hasHook(s, 'PreToolUse', HOOK_PRETOOL.command);
}

function enablePreToolGate() {
  const settings = loadClaudeSettings() || {};
  settings.hooks = settings.hooks || {};
  let changed = false;
  for (const [event, hook] of [['PreToolUse', HOOK_PRETOOL], ['PostToolUse', HOOK_POSTTOOL]]) {
    settings.hooks[event] = settings.hooks[event] || [];
    if (hasHook(settings, event, hook.command)) continue;
    settings.hooks[event].push({ matcher: PRETOOL_MATCHER, hooks: [hook] });
    changed = true;
  }
  if (changed) fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  return changed;
}

function disablePreToolGate() {
  const settings = loadClaudeSettings();
  if (!settings?.hooks) return false;
  let changed = false;
  for (const [event, hook] of [['PreToolUse', HOOK_PRETOOL], ['PostToolUse', HOOK_POSTTOOL]]) {
    const entries = settings.hooks[event];
    if (!entries) continue;
    const before = entries.length;
    settings.hooks[event] = entries
      .map(e => ({ ...e, hooks: (e.hooks || []).filter(h => h.command !== hook.command) }))
      .filter(e => e.hooks.length > 0);
    if ((settings.hooks[event] || []).length === 0) delete settings.hooks[event];
    if (before !== (settings.hooks[event]?.length ?? 0)) changed = true;
  }
  if (changed) fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
  return changed;
}

function showConsentScreen(harnesses) {
  console.log('');
  console.log(`  ${b(cream('PHEWSH ambient'))} ${sage('— continuity without launching phewsh')}`);
  console.log('');
  console.log(`  ${sage('Detected on this machine:')}`);
  for (const h of harnesses.filter(h => h.installed)) {
    const note = h.id === 'claude-code' ? teal('live hook + base file') : slate('base file + project context sync (no live hook to install)');
    console.log(`    ${green('✓')} ${cream(h.label.padEnd(14))} ${note}`);
  }
  console.log('');
  console.log(`  ${b('Claude Code enhancements:')}`);
  console.log(`    ${teal('Context sync')}     ${sage('SessionStart hook — when a project has')} ${cream('.intent/')}${sage(', a short brief')}`);
  console.log(`                     ${sage('(vision, next steps, constraints) is injected at session start.')}`);
  console.log(`    ${teal('Session capture')}  ${sage('SessionEnd hook — appends one metadata line (time, project, cwd)')}`);
  console.log(`                     ${sage('to')} ${cream('~/.phewsh/ambient-sessions.jsonl')}${sage('.')} ${b(sage('Never transcript contents.'))}`);

  const globalTargets = selfheal.detectGlobalTargets();
  if (globalTargets.length > 0) {
    console.log('');
    console.log(`  ${b('Machine-wide awareness (so tools understand your .intent/ files anywhere):')}`);
    console.log(`    ${sage('A small, marked, reversible factual note is written into each tool\'s base')}`);
    console.log(`    ${sage('file so it reads a')} ${cream('.intent/')} ${sage('directory as your project docs when it sees one:')}`);
    for (const t of globalTargets) {
      console.log(`      ${teal('+')} ${cream(path.join('~', t.dir, t.file).padEnd(22))} ${slate('(' + t.label + ')')}`);
    }
    console.log(`    ${sage('Only tools you already have are touched. Your own text is preserved.')}`);
  }
  console.log('');
  console.log(`  ${peach('Exactly what changes:')} ${sage('two hook entries in')} ${cream(CLAUDE_SETTINGS)}${globalTargets.length ? sage(' + the base-file blocks above') : ''}${sage('.')}`);
  console.log(`  ${sage('Undo anytime:')} ${cream('phewsh ambient off')} ${sage('· full record:')} ${cream('phewsh ambient status')}`);
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
  showConsentScreen(harnesses);

  const globalPending = selfheal.detectGlobalTargets().length > 0;
  // "Fully applied" now means BOTH the Claude hooks AND the machine-wide base
  // files (when there are tools to write them to). Re-running tops up whatever
  // is missing — e.g. you enabled hooks before global base files existed.
  if (claudeApplied() && !globalPending) {
    console.log(`  ${green('Already applied.')} ${sage('Status:')} ${cream('phewsh ambient status')}`);
    console.log('');
    return;
  }

  if (!skipConfirm) {
    const ok = await confirm(`  ${b('Apply?')} ${slate('[y/N] ')}`);
    if (!ok) {
      // A declined prompt is a deliberate opt-out — record it so the first-run
      // auto-enable never overrides the user's "no" on a later command.
      const led = loadLedger();
      led.disabled = true;
      saveLedger(led);
      console.log(`  ${sage('Nothing changed.')} ${slate('(phewsh won\'t auto-enable; run `phewsh ambient on` anytime.)')}`);
      console.log('');
      return;
    }
  }

  const changes = applyClaudeHooks();
  const { written } = selfheal.syncGlobalBaseFiles();
  const projectWritten = selfheal.syncContextFiles().synced || [];
  const slashWritten = slash.installSlashCommands().written;
  const ledger = loadLedger();
  ledger.applied['claude-code'] = {
    at: new Date().toISOString(),
    file: CLAUDE_SETTINGS,
    changes,
    captures: '~/.phewsh/ambient-sessions.jsonl — timestamp, project, cwd only',
    undo: 'phewsh ambient off',
  };
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
  ledger.seenHarnesses = harnesses.filter(h => h.installed).map(h => h.id);
  ledger.disabled = false; // explicit enable clears any prior opt-out
  saveLedger(ledger);

  console.log('');
  console.log(`  ${green('●')} ${b('Ambient is on.')}`);
  changes.forEach(c => console.log(`    ${teal('+')} ${slate(c)}`));
  written.forEach(f => console.log(`    ${teal('+')} ${slate('base file ' + f + ' (machine-wide phewsh awareness)')}`));
  projectWritten.forEach(f => console.log(`    ${teal('+')} ${slate('project block ' + f + ' (shared canonical core)')}`));
  if (slashWritten.length) console.log(`    ${teal('+')} ${cream('/intent')} ${slate('command added to ' + slashWritten.join(', '))}`);
  console.log('');
  console.log(`  ${sage('Next Claude Code session in a project with')} ${cream('.intent/')} ${sage('starts pre-briefed.')}`);
  if (written.length > 0) {
    console.log(`  ${sage('Every detected tool now reads your')} ${cream('.intent/')} ${sage('files as project docs. The')} 😮‍💨🤫 ${sage('signature appears in real phewsh projects.')}`);
  }
  console.log(`  ${sage('You never have to launch phewsh for this to work.')}`);
  console.log('');
}

function turnOff() {
  const removed = removeClaudeHooks();
  const { removed: removedGlobal } = selfheal.removeGlobalBaseFiles();
  const { removed: removedProject } = selfheal.removeProjectContextFiles();
  const { removed: removedSlash } = slash.removeSlashCommands();
  const ledger = loadLedger();
  delete ledger.applied['claude-code'];
  delete ledger.applied.globalBase;
  delete ledger.applied.slashCommands;
  delete ledger.autoEnabledAt;
  ledger.disabled = true; // sticky opt-out — first-run auto-enable must respect this
  saveLedger(ledger);
  console.log('');
  if (removed.length > 0 || removedGlobal.length > 0 || removedProject.length > 0 || removedSlash.length > 0) {
    console.log(`  ${green('●')} ${b('Ambient is off.')}`);
    removed.forEach(c => console.log(`    ${peach('-')} ${slate(c)}`));
    removedGlobal.forEach(f => console.log(`    ${peach('-')} ${slate('base file ' + f + ' (phewsh block removed)')}`));
    removedProject.forEach(f => console.log(`    ${peach('-')} ${slate('project block ' + f + ' (human content preserved)')}`));
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
  console.log('');
  console.log(`  ${b(cream('PHEWSH ambient'))} ${sage('— status')}`);
  console.log('');
  for (const h of harnesses.filter(h => h.installed)) {
    if (h.id === 'claude-code') {
      const on = claudeApplied();
      console.log(`    ${on ? green('●') : yellow('○')} ${cream(h.label.padEnd(14))} ${on ? teal('ambient on') : sage('not enhanced — phewsh ambient on')}`);
      const entry = ledger.applied['claude-code'];
      if (entry) {
        console.log(`        ${slate('applied ' + entry.at)}`);
        (entry.changes || []).forEach(c => console.log(`        ${slate('· ' + c + ' (' + entry.file + ')')}`));
        console.log(`        ${slate('· captures: ' + entry.captures)}`);
      }
    } else {
      console.log(`    ${slate('○')} ${cream(h.label.padEnd(14))} ${slate('detected — kept current via its context file (no live hook to install)')}`);
    }
  }

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

// First-run / always-on. The first time phewsh is used interactively, wire
// ambient automatically across every installed harness — so the user never has
// to run `phewsh ambient on`. Idempotent and self-limiting:
//   • respects an explicit opt-out (ledger.disabled — set by `ambient off` or
//     declining the consent prompt); never re-enables behind the user's back.
//   • no-op once it has run (autoEnabledAt) — the per-run self-heal keeps files
//     fresh after that.
//   • if NO harness is installed yet, does nothing and re-checks next run.
// Transparent: prints a one-time notice naming what changed and how to undo —
// informed consent after the fact, fully reversible. Never throws/blocks.
async function ensureAuto() {
  const ledger = loadLedger();
  const interacted = ledger.disabled || ledger.autoEnabledAt ||
    (ledger.applied && (ledger.applied['claude-code'] || ledger.applied.globalBase));
  if (interacted) return;

  const harnesses = listHarnesses();
  const installed = harnesses.filter(h => h.installed);
  if (installed.length === 0) return; // nothing to enhance yet — try again next run

  const hasClaude = installed.some(h => h.id === 'claude-code');
  const changes = hasClaude ? applyClaudeHooks() : [];
  const { written } = selfheal.syncGlobalBaseFiles();
  const slashWritten = slash.installSlashCommands().written;
  // Refresh existing project files only — first-run auto-enable must not dump
  // context files into whatever repo the user happens to be standing in.
  try { selfheal.syncContextFiles({ createMissing: false }); } catch { /* best-effort */ }

  const now = new Date().toISOString();
  if (hasClaude) {
    ledger.applied['claude-code'] = {
      at: now, file: CLAUDE_SETTINGS, changes,
      captures: '~/.phewsh/ambient-sessions.jsonl — timestamp, project, cwd only',
      undo: 'phewsh ambient off',
    };
  }
  if (written.length > 0) {
    ledger.applied.globalBase = { at: now, files: written, undo: 'phewsh ambient off' };
  }
  if (slashWritten.length > 0) {
    ledger.applied.slashCommands = { at: now, tools: slashWritten, undo: 'phewsh ambient off' };
  }
  ledger.disabled = false;
  ledger.autoEnabledAt = now;
  ledger.seenHarnesses = installed.map(h => h.id);
  saveLedger(ledger);

  if ((changes.length || written.length) && process.stdout.isTTY) {
    console.log('');
    console.log(`  ${b(cream('phewsh set itself up across your AI tools'))} ${sage('— so they stay in sync with your project intent.')}`);
    if (hasClaude) console.log(`    ${teal('+')} ${slate('Claude Code gets a brief from a project\'s .intent/ at session start')}`);
    written.forEach(f => console.log(`    ${teal('+')} ${slate('environment note added to ' + f)}`));
    if (slashWritten.length) console.log(`    ${teal('+')} ${cream('/intent')} ${slate('command added to ' + slashWritten.join(', '))}`);
    console.log(`    ${sage('In any project with')} ${cream('.intent/')}${sage(', your tools now read its real intent. Reversible:')} ${cream('phewsh ambient off')}`);
    console.log(`    ${sage('Want a guaranteed status line each time you launch a tool?')} ${cream('phewsh shim on')}`);
    console.log('');
  }
}

async function main() {
  const sub = process.argv[3] || 'status';
  const skipConfirm = process.argv.includes('--yes');
  if (sub === 'on') return turnOn(skipConfirm);
  if (sub === 'off') return turnOff();
  return status();
}

module.exports = main;
module.exports.ensureAuto = ensureAuto;
module.exports.enablePreToolGate = enablePreToolGate;
module.exports.disablePreToolGate = disablePreToolGate;
module.exports.preToolGateApplied = preToolGateApplied;
