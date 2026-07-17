#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

// `phewsh shim-preflight <bin>` — called BY the shims on every tool launch.
// Must be instant and side-effect-free: print the banner, exit. No update
// check, no network, no session. Intercepted before anything else loads.
if (command === 'shim-preflight') {
  // Machine-readable launches (Codex app-server JSONL, anything spawned with
  // piped stdio) must get NOTHING on stdout — a banner corrupts the stream
  // the parent parses. A human terminal has a TTY; everything else stays silent.
  if (process.stdout.isTTY) {
    try {
      const bin = args[1] || 'tool';
      process.stdout.write(require('../lib/shims').preflightBanner(bin) + '\n');
    } catch { /* a broken banner must never delay the real tool */ }
  }
  process.exit(0);
}

// Smart word-wrap for all prose the CLI prints — wraps at word boundaries
// instead of the terminal's mid-word hard wrap. TTY-only, idempotent, and it
// leaves process.stdout.write paths (spinner, streamed AI) alone. Installed
// after the shim-preflight fast path so that stays instant and untouched.
try {
  const ui = require('../lib/ui');
  // Restore a width the user pinned with `/width` in a past session, so the fix
  // for a misreporting terminal sticks without re-typing it every launch.
  try {
    const os = require('os');
    const path = require('path');
    const cfg = require('../lib/config-file').loadConfig(path.join(os.homedir(), '.phewsh', 'config.json'));
    if (cfg && cfg.displayWidth) ui.setWidth(cfg.displayWidth);
  } catch { /* no saved width is fine */ }
  ui.installSmartWrap();
} catch { /* never block the CLI on cosmetics */ }

// ── ANSI helpers (no chalk dependency)
const b  = (s) => `\x1b[1m${s}\x1b[0m`;   // bold
const d  = (s) => `\x1b[2m${s}\x1b[0m`;   // dim
const w  = (s) => `\x1b[97m${s}\x1b[0m`;  // bright white
const g  = (s) => `\x1b[38;5;247m${s}\x1b[0m`;  // slate, 256-color (matches ui.js — 24-bit breaks Apple Terminal)
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

function showBrand() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const hasIntent = fs.existsSync(path.join(process.cwd(), '.intent', 'vision.md'));
  const configPath = path.join(os.homedir(), '.phewsh', 'config.json');
  let hasKey = false;
  let email = null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    hasKey = !!config?.apiKey;
    email = config?.email;
  } catch { /* no config */ }

  console.log('');
  console.log('  😮\u200d💨 🤫');
  console.log('');
  console.log(`  ${b(w('█▀█ █░█ █▀▀ █░█░█ █▀ █░█'))}`);
  console.log(`  ${b(w('█▀▀ █▀█ ██▄ ▀▄▀▄▀ ▄█ █▀█'))}`);
  console.log(`  ${g('Keep all your AI tools. phewsh is the one memory they share.')}`);
  console.log('');

  // Context-aware hint
  if (!hasKey) {
    console.log(`  ${g('Get started:')} ${w('phewsh')}  ${g('(guided setup, takes 60 seconds)')}`);
  } else if (hasIntent) {
    console.log(`  ${green('●')} .intent/ loaded  ${g('·')}  ${w('phewsh')} ${g('to chat ·')} ${w('phewsh watch')} ${g('to sync')}`);
  } else if (email) {
    console.log(`  ${g('logged in as')} ${email}  ${g('·')}  ${w('phewsh')} ${g('to start')}`);
  } else {
    console.log(`  ${g('Ready.')} ${w('phewsh')} ${g('to start a session.')}`);
  }
  console.log('');
}

const COMMANDS = {
  session: () => require('../commands/session'),
  intent:  () => require('../commands/intent'),
  // `phewsh init` = `phewsh intent --init` — the universal spelling (git init,
  // npm init) and what phewsh.com/cli tells new users to run.
  init:    () => { process.argv.splice(3, 0, '--init'); return require('../commands/intent'); },
  clarify: () => require('../commands/clarify').run(),
  push:    () => require('../commands/push'),
  pull:    () => require('../commands/pull'),
  link:    () => require('../commands/link'),
  sync:    () => require('../commands/sync').main('status'),
  login:   () => require('../commands/login'),
  ai:      () => require('../commands/ai'),
  style:   () => require('../commands/style'),
  mbhd:    () => require('../commands/mbhd'),
  context: () => require('../commands/context'),
  gate:    () => require('../commands/gate'),
  sap:     () => require('../commands/sap'),
  browse:  () => require('../commands/browse'),
  watch:   () => require('../commands/watch')(),
  mcp:     () => require('../commands/mcp')(),
  receipts: () => require('../commands/receipts')(),
  outcomes: () => require('../commands/outcomes')(),
  truth:   () => require('../commands/truth'),
  brief:   () => require('../commands/brief'),
  bypass:  () => require('../commands/bypass')(),
  setup:   () => require('../commands/setup')(),
  update:  () => require('../commands/update')(),
  serve:   () => require('../commands/serve')(),
  project: () => require('../commands/project')(),
  projects: () => require('../commands/project')(),
  sequence: () => require('../commands/sequence')(),
  seq:     () => require('../commands/sequence')(),
  ambient: () => require('../commands/ambient')(),
  shim:    () => require('../commands/shim')(),
  status:  () => require('../commands/status')(),
  next:    () => require('../commands/next')(),
  work:    () => require('../commands/work')(),
  remember: () => require('../commands/remember')(),
  task:    () => require('../commands/task')(),
  dispatch: () => require('../commands/task')(),
  ion:     () => require('../commands/ion')(),
  pack:    () => require('../commands/pack')(),
  hook:    () => require('../commands/hook')(),
  feedback: () => require('../commands/feedback')(),
  welcome: () => require('../commands/welcome')(),
  intro:   () => require('../commands/welcome')(),
  help:    showHelp,
  version: showVersion,
};

function showVersion() {
  console.log(`phewsh v${require('../package.json').version}`);
}

function showHelp() {
  const pkg = require('../package.json');
  showBrand();
  console.log(`  ${g('v' + pkg.version)}  ·  ${g('phewsh.com/cli')}\n`);
  console.log(`  ${g('Phewsh keeps work from getting lost — for you, and every AI tool you use.')}`);
  console.log('');
  console.log(`  ${b(w('the whole idea — four plain words'))}`);
  console.log(`    ${cyan('intent')}     ${g('PROJECT   what you\'re building & why')}`);
  console.log(`    ${cyan('next')}       ${g('NEXT      what should happen next — a zero-AI list')}`);
  console.log(`    ${cyan('work')}       ${g('WORK      what\'s happening now — at a glance')}`);
  console.log(`    ${cyan('remember')}   ${g('RECORD    jot a decision so it sticks & travels')}`);
  console.log(`    ${cyan('status')}     ${g('see all four at a glance')}`);
  console.log('');
  console.log(`  ${b(w('get started'))}`);
  console.log(`    ${cyan('phewsh')}           ${g('Open a session — routes through your installed agents')}`);
  console.log(`    ${cyan('phewsh setup')}      ${g('Guided setup — pick your default route (60 seconds)')}`);
  console.log(`    ${cyan('phewsh clarify')}    ${g('Turn a messy idea into .intent/ artifacts')}`);
  console.log('');
  console.log(`  ${b(w('author .intent/'))}`);
  console.log(`    ${cyan('intent')}     ${g('Create, view, evolve .intent/ artifacts')}`);
  console.log(`    ${cyan('gate')}       ${g('Set constraints (budget, time, skill, urgency)')}`);
  console.log(`    ${cyan('context')}    ${g('Export .intent/ for any AI tool')}`);
  console.log(`    ${cyan('status')}     ${g('git status for AI continuity — truth, record, drift, what\'s wired')}`);
  console.log(`    ${cyan('next')}       ${g('What should happen next — a zero-AI list every tool reads')}`);
  console.log(`    ${cyan('truth')}      ${g('Read-only audit: versions, Git, intent, projections, conflicts')}`);
  console.log(`    ${cyan('brief')}      ${g('Provider-ready briefing built from verified project truth')}`);
  console.log(`    ${cyan('ai')}         ${g('One-shot prompt with .intent/ context')}
    ${cyan('browse')}     ${g('Read any URL — AI summary in your terminal')}`);
  console.log('');
  console.log(`  ${b(w('sync everywhere'))}`);
  console.log(`    ${cyan('seq')}        ${g('Sequence all memory → optimal context for any agent')}`);
  console.log(`    ${cyan('watch')}      ${g('Auto-sync .intent/ → native harness files + cloud')}`);
  console.log(`    ${cyan('push/pull')}  ${g('Manual sync to/from phewsh.com/intent')}`);
  console.log(`    ${cyan('serve')}      ${g('Execution bridge — run from phewsh.com/ion or /intent')}`);
  console.log(`    ${cyan('project')}    ${g('Choose which projects this machine\'s worker shows on /ion')}`);
  console.log(`    ${cyan('ion')}        ${g('Shared visual room for humans + local agents')}`);
  console.log(`    ${cyan('mcp')}        ${g('Connect AI agents via MCP protocol')}`);
  console.log(`    ${cyan('ambient')}    ${g('Continuity without launching phewsh — enhance your other tools')}`);
  console.log(`    ${cyan('shim')}       ${g('Guaranteed launch banner — phewsh prints status before each tool')}`);
  console.log(`    ${cyan('pack')}       ${g('Opt-in workflow packs (Karpathy guidelines, GSD…) — attributed, reversible')}`);
  console.log(`    ${cyan('task')}       ${g('Shared tasks — request, claim, and ship teammate work via branch + PR')}
    ${cyan('dispatch')}   ${g('Friendly verb over task: dispatch "<title>" to request, <id>|next to claim')}
    ${cyan('receipts')}   ${g('Proof trail — what agents actually did, with evidence')}`);
  console.log(`    ${cyan('remember')}   ${g('Jot a decision to .intent/decisions.md — every tool inherits it')}`);
  console.log(`    ${cyan('outcomes')}   ${g('Decision record — what was kept, reverted, or failed')}`);
  console.log(`    ${cyan('bypass')}     ${g('Went around phewsh? Record why — 10 seconds, no guilt')}`);
  console.log('');
  console.log(`  ${b(w('configure'))}`);
  console.log(`    ${cyan('feedback')}   ${g('Tell us what you need — prefilled GitHub issue; `feedback list` shows the queue')}`);
  console.log(`    ${cyan('login')}      ${g('Identity + API key + cloud sync')}`);
  console.log(`    ${cyan('link')}       ${g('Link local .intent/ to cloud project')}`);
  console.log(`    ${cyan('update')}     ${g('Update phewsh — or `phewsh update auto on` to stay current automatically')}`);
  console.log('');
  console.log(`  ${g('Works in: Claude Code · Cursor · ChatGPT · any MCP agent')}`);
  console.log(`  ${g('No account needed. Account adds sync + sharing.')}`);
  console.log('');
}

// Non-blocking update check — resolves true if update found
let _updateDone = false;
function checkForUpdates() {
  const pkg = require('../package.json');
  return fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(3000) })
    .then(r => r.json())
    .then(data => {
      if (data.version && data.version !== pkg.version) {
        const newer = data.version.split('.').map(Number);
        const current = pkg.version.split('.').map(Number);
        // Compare major, then minor, then patch — a later slot only matters
        // when all earlier slots are equal (0.11.16 is NOT newer than 0.12.0).
        const isNewer =
          newer[0] !== current[0] ? newer[0] > current[0] :
          newer[1] !== current[1] ? newer[1] > current[1] :
          newer[2] > current[2];
        if (isNewer) {
          // Auto-update is opt-in (phewsh update auto on). When on, we update
          // in the background — never blocking this session, never prompting —
          // so the NEXT launch is current. When off, we just point the way.
          let auto = false;
          try { auto = require('../commands/update').autoUpdateEnabled(); } catch { /* default off */ }
          if (auto) {
            let started = false;
            try { started = require('../commands/update').backgroundUpdate(pkg.name); } catch { /* best-effort */ }
            if (started) console.log(g(`\n  ↻ Updating phewsh ${pkg.version} → ${data.version} in the background — next launch uses it.\n`));
            else console.log(g(`\n  Update available: ${pkg.version} → ${data.version}\n  Run: phewsh update\n`));
          } else {
            console.log(g(`\n  Update available: ${pkg.version} → ${data.version}`));
            console.log(g(`  Run: phewsh update  ${'\x1b[2m'}(or 'phewsh update auto on' to always stay current)${'\x1b[0m'}\n`));
          }
        }
      }
    })
    .catch(() => {})
    .finally(() => { _updateDone = true; });
}

// Always check for updates (non-blocking)
const updatePromise = checkForUpdates();

function exitAfterUpdate(code = 0) {
  // If update check already resolved, exit now
  if (_updateDone) return process.exit(code);
  // Otherwise wait up to 2s for it to finish
  updatePromise.then(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000);
}

async function maybeFirstRunIntro() {
  // First ever run → play the intro once, then never again. Marker, not config,
  // so it's independent of login state. Never blocks the session on failure.
  try {
    const fs = require('fs'), path = require('path'), os = require('os');
    const marker = path.join(os.homedir(), '.phewsh', '.welcomed');
    if (fs.existsSync(marker)) return;
    if (process.stdout.isTTY) await require('../lib/intro').playIntro();
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch { /* the intro is a nicety — never let it block the session */ }
}

// Always-on, frictionless: on the first interactive use, auto-enable ambient
// across every installed harness (unless the user opted out); on every run
// after, self-heal so each tool's context files are present and fresh. All
// best-effort and non-blocking — a launch must never wait on or fail from this.
async function ambientSelfHeal() {
  try { await require('../commands/ambient').ensureAuto(); } catch { /* never block launch */ }
  // Refresh-only: keep already-present context files fresh, but never CREATE
  // them just because phewsh was opened here — that would dirty a clean repo.
  try { require('../lib/selfheal').syncContextFiles({ createMissing: false }); } catch { /* never block launch */ }
  try { require('../lib/selfheal').refreshGlobalBaseFilesIfApplied(); } catch { /* never block launch */ }
}

if (!command) {
  // Bare `phewsh` — first run gets the intro, then drop into the session.
  // Session handles missing API key gracefully with /login and /key commands.
  ambientSelfHeal().finally(() => maybeFirstRunIntro().then(() => COMMANDS.session()));
} else if (command === 'help' || command === '--help' || command === '-h') {
  showHelp();
  exitAfterUpdate(0);
} else if (command === 'version' || command === '--version' || command === '-v') {
  showVersion();
  exitAfterUpdate(0);
} else if (COMMANDS[command]) {
  COMMANDS[command]();
} else if (require('../lib/harnesses').resolveHarness(command)) {
  // `phewsh <harness>` — a doorway shortcut. Accepts the id OR the tool's real
  // binary (so `phewsh claude` works, since that's the Claude Code binary).
  // Launch the session and auto-run /work for that harness (preflight → brief →
  // native handoff → postflight). This is what the phewsh.com doorways copy.
  process.env.PHEWSH_AUTOWORK = require('../lib/harnesses').resolveHarness(command);
  ambientSelfHeal().finally(() => maybeFirstRunIntro().then(() => COMMANDS.session()));
} else {
  console.error(`\n  Unknown command: ${command}\n  Run 'phewsh help' for available commands.\n`);
  process.exit(1);
}
