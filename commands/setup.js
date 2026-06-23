// phewsh setup — guided setup, hermes-style.
//
// Detects what's already on the machine (agent CLIs carry their own login),
// lets you pick the default route, optionally adds an API key. Ends with one
// instruction: type `phewsh`.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const ui = require('../lib/ui');
const { HARNESSES, listHarnesses } = require('../lib/harnesses');
const configFile = require('../lib/config-file');

const { b, teal, sage, slate, cream, ember, green } = ui;

const CONFIG_DIR = path.join(os.homedir(), '.phewsh');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH, {});
}

function saveConfig(config) {
  configFile.saveConfig(CONFIG_PATH, config);
}

function ask(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())));
}

module.exports = async function setup() {
  const config = loadConfig();
  const harnesses = listHarnesses();
  const installed = harnesses.filter(h => h.installed);

  console.log('');
  console.log(`  ${b(cream('phewsh setup'))}`);
  ui.divider('line');
  console.log('');
  console.log(`  ${sage('phewsh routes your work through tools you already pay for.')}`);
  console.log(`  ${sage('No API key required — agent CLIs carry their own login.')}`);
  console.log('');

  // ── 1. What's on this machine ─────────────────────────
  console.log(`  ${b(cream('Detected on this machine'))}`);
  for (const h of harnesses) {
    const status = h.installed ? green('✓ installed') : slate('✗ not installed');
    const mode = h.headless ? '' : slate(' · interactive — /work ' + h.id);
    const fit = h.bestFor ? slate(' · best for ' + h.bestFor) : '';
    console.log(`    ${cream(h.label.padEnd(14))} ${status}  ${slate('(' + h.auth + ')')}${mode}${fit}`);
  }
  if (installed.length === 0) {
    console.log('');
    console.log(`  ${ember('!')} ${sage('No agent CLIs found. Install one (recommended) or use an API key:')}`);
    console.log(`    ${slate('Claude Code:')}  ${cream('npm install -g @anthropic-ai/claude-code')}`);
    console.log(`    ${slate('Codex CLI:')}    ${cream('npm install -g @openai/codex')}`);
  }
  console.log('');

  // Agent-run (no TTY): auto-configure instead of asking questions nobody
  // can answer. Keep an existing valid route; otherwise pick the first
  // installed harness.
  const chatCapable = installed.filter(h => h.headless);
  if (!process.stdin.isTTY) {
    const configuredHarness = chatCapable.find(h => h.id === config.defaultRoute);
    if (configuredHarness) {
      if (!config.fallback) config.fallback = 'ask';
      saveConfig(config);
      console.log(`  ${teal('●')} ${sage('Kept configured default route:')} ${cream(configuredHarness.label)} ${slate('— no API key needed')}`);
    } else if (config.defaultRoute === 'api' && config.apiKey) {
      saveConfig(config);
      console.log(`  ${teal('●')} ${sage('Kept configured default route: API (existing key found)')}`);
    } else if (chatCapable.length > 0) {
      config.defaultRoute = chatCapable[0].id;
      if (!config.fallback) config.fallback = 'ask';
      saveConfig(config);
      console.log(`  ${teal('●')} ${sage('Auto-configured (non-interactive): default route =')} ${cream(chatCapable[0].label)} ${slate('— no API key needed')}`);
      console.log(`  ${slate('Change anytime: run `phewsh setup` in your own terminal, or /use inside a session.')}`);
    } else if (config.apiKey) {
      config.defaultRoute = 'api';
      saveConfig(config);
      console.log(`  ${teal('●')} ${sage('Auto-configured: default route = API (existing key found)')}`);
    } else {
      console.log(`  ${ember('!')} ${sage('Nothing to configure yet — no agent CLI installed and no API key.')}`);
      console.log(`  ${slate('Install Claude Code or Codex (or set a key), then rerun phewsh setup.')}`);
    }
    console.log('');
    console.log(`  ${sage('Start working:')}  ${cream('phewsh')}`);
    console.log('');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── 2. Pick the default route ─────────────────────────
  // Interactive-only harnesses (Hermes, Pi) can't take chat routing — they
  // stay reachable via /work in a session, so they're not default options.
  const options = chatCapable.map(h => ({ kind: 'harness', id: h.id, label: `${h.label} — ${h.bestFor || h.role}; your ${h.auth.split(' / ')[0].toLowerCase()}, no API key` }));
  options.push({ kind: 'api', id: 'api', label: 'Direct API — bring your own Anthropic/OpenRouter key' });

  console.log(`  ${b(cream('Where should phewsh route your work by default?'))}`);
  options.forEach((o, i) => {
    const current = (config.defaultRoute === o.id) ? ` ${teal('● current')}` : '';
    console.log(`    ${teal(String(i + 1))} ${sage(o.label)}${current}`);
  });
  console.log('');

  const answer = await ask(rl, `  ${teal('>')} ${slate(`1-${options.length}, enter = ${options[0] ? '1' : 'skip'}: `)}`);
  const idx = answer === '' ? 0 : parseInt(answer, 10) - 1;
  const choice = options[idx];

  if (!choice) {
    console.log(`  ${slate('Skipped — phewsh will auto-detect each session.')}`);
  } else if (choice.kind === 'harness') {
    config.defaultRoute = choice.id;
    saveConfig(config);
    console.log(`  ${teal('●')} ${sage('Default route:')} ${cream(HARNESSES[choice.id].label)} ${slate('— no API key needed')}`);
  } else {
    // ── 3. API key, only if they chose the API route ────
    config.defaultRoute = 'api';
    if (config.apiKey) {
      console.log(`  ${teal('●')} ${sage('Default route: API — using your existing key')} ${slate('(' + config.apiKey.slice(0, 8) + '...)')}`);
      saveConfig(config);
    } else {
      console.log('');
      console.log(`  ${sage('Anthropic:')} ${cream('console.anthropic.com/settings/keys')} ${slate('(sk-ant-...)')}`);
      console.log(`  ${sage('OpenRouter:')} ${cream('openrouter.ai/keys')} ${slate('(sk-or-...)')}`);
      const key = await ask(rl, `  ${sage('Paste your API key (enter to skip):')}\n  ${teal('>')} `);
      if (key) {
        config.apiKey = key;
        config.provider = key.startsWith('sk-or-') ? 'openrouter' : 'anthropic';
        console.log(`  ${teal('●')} ${sage('Key saved.')}`);
      } else {
        delete config.defaultRoute;
        console.log(`  ${slate('No key — phewsh will fall back to any installed agent CLI.')}`);
      }
      saveConfig(config);
    }
  }

  // ── 4. Fallback behavior — first-class, not buried config ────────────
  console.log('');
  console.log(`  ${b(cream('If your route hits a usage limit or fails:'))}`);
  console.log(`    ${teal('1')} ${sage('Ask me before switching')} ${slate('(default — shows what changes, context always travels)')}`);
  console.log(`    ${teal('2')} ${sage('Auto-switch to the next available route')}`);
  console.log('');
  const fbAnswer = await ask(rl, `  ${teal('>')} ${slate('1-2, enter = 1: ')}`);
  config.fallback = fbAnswer.trim() === '2' ? 'auto' : 'ask';
  saveConfig(config);
  console.log(`  ${teal('●')} ${sage('Fallback:')} ${cream(config.fallback === 'auto' ? 'auto-switch' : 'ask first')} ${slate('— either way, your project context and record stay intact')}`);

  rl.close();

  // ── 5. Done ───────────────────────────────────────────
  console.log('');
  ui.divider('line');
  console.log(`  ${teal('●')} ${b(cream('Setup complete.'))}`);
  console.log('');
  console.log(`  ${sage('Start working:')}  ${cream('phewsh')}`);
  console.log(`  ${slate('Optional: phewsh login (cloud sync) · phewsh intent --init (.intent/ for a project)')}`);
  console.log('');
};
