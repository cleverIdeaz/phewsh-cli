// phewsh watch — Live sync daemon
//
// Watches .intent/ for changes and auto-pushes to Supabase + refreshes each
// harness's managed context block from one canonical generated core.
// This is the backbone of cross-tool continuity:
//   edit in terminal → native harness files + phewsh.com/intent update.
//
// Usage:
//   phewsh watch              Start watching (push + harness projections)
//   phewsh watch --no-claude  Skip local projection sync (legacy flag)
//   phewsh watch --no-push    Skip cloud push (local projections only)
//   phewsh watch --verbose    Show detailed sync info

const fs = require('fs');
const path = require('path');
const os = require('os');
const configFile = require('../lib/config-file');

const INTENT_DIR = path.join(process.cwd(), '.intent');
const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');

const args = process.argv.slice(3);
const flags = {
  noClaude: args.includes('--no-claude'),
  noPush: args.includes('--no-push'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  help: args.includes('--help') || args.includes('-h'),
};

// ANSI helpers
const b = (s) => `\x1b[1m${s}\x1b[0m`;
const g = (s) => `\x1b[90m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

// ── Config + Auth ──────────────────────────────────────────────────────────

function loadConfig() {
  return configFile.loadConfig(CONFIG_PATH);
}

function updateHarnessFiles() {
  return require('../lib/selfheal').syncContextFiles().synced || [];
}

// ── Cloud Push ──────────────────────────────────────────────────────────────

async function pushToCloud(config) {
  const { ensureValidToken, push } = require('./sync');

  const token = await ensureValidToken(config);
  if (!token) return false;

  try {
    await push(config, token);
    return true;
  } catch (err) {
    if (flags.verbose) console.log(`  ${red('!')} Push failed: ${err.message}`);
    return false;
  }
}

// ── File Watcher ────────────────────────────────────────────────────────────

function watchIntent({ watch = fs.watch, onError = () => {} } = {}) {
  let debounceTimer = null;
  let syncInProgress = false;
  let pendingSync = false;
  let failed = false;
  const watchers = [];

  function close() {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* already closed */ }
    }
  }

  function fail(err) {
    if (failed) return;
    failed = true;
    close();
    onError(err);
  }

  function addWatcher(dir, listener) {
    const watcher = watch(dir, { recursive: false }, listener);
    if (typeof watcher.on === 'function') watcher.on('error', fail);
    watchers.push(watcher);
  }

  async function onFileChange(filename) {
    // Skip temp files and hidden files
    if (!filename || filename.startsWith('.') || filename.endsWith('~') || filename.endsWith('.swp')) return;

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(async () => {
      if (syncInProgress) {
        pendingSync = true;
        return;
      }

      syncInProgress = true;
      const time = new Date().toLocaleTimeString();
      console.log(`  ${cyan('~')} ${g(time)} Change detected: ${w(filename)}`);

      let actions = [];

      // Update every native projection from the same canonical core.
      if (!flags.noClaude) {
        const synced = updateHarnessFiles();
        if (synced.length) actions.push(synced.join(', '));
      }

      // Push to cloud
      if (!flags.noPush) {
        const config = loadConfig();
        if (config?.supabaseUserId) {
          const pushed = await pushToCloud(config);
          if (pushed) actions.push('cloud');
        } else if (flags.verbose) {
          console.log(`  ${yellow('!')} Not logged in — skipping cloud push. Run \`phewsh login\` to enable.`);
        }
      }

      if (actions.length > 0) {
        console.log(`  ${green('✓')} Synced → ${actions.join(' + ')}`);
      }

      syncInProgress = false;

      // If another change came in while syncing, process it
      if (pendingSync) {
        pendingSync = false;
        onFileChange('(queued)');
      }
    }, 300); // 300ms debounce
  }

  // Watch the .intent/ directory
  try {
    addWatcher(INTENT_DIR, (eventType, filename) => {
      onFileChange(filename);
    });

    // Also watch subdirectories if any exist.
    const entries = fs.readdirSync(INTENT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        addWatcher(path.join(INTENT_DIR, entry.name), (eventType, filename) => {
          onFileChange(`${entry.name}/${filename}`);
        });
      }
    }
  } catch (err) {
    close();
    throw err;
  }

  return { close };
}

function formatWatchFailure(err) {
  const reason = err?.code === 'EMFILE'
    ? 'This machine has too many open file watchers.'
    : `File watching failed${err?.message ? `: ${err.message}` : '.'}`;
  return [
    `${reason} The initial sync completed, but continuous watching did not start.`,
    'Run `phewsh seq --write` for a one-shot local refresh, close unused watchers, then retry `phewsh watch`.',
  ];
}

// ── Main ────────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
  phewsh watch — Keep AI tools in sync with .intent/

  Usage:
    phewsh watch              Start watching
    phewsh watch --no-claude  Skip local harness-file regeneration
    phewsh watch --no-push    Skip cloud push (local only)
    phewsh watch --verbose    Show detailed sync info

  What it does:
    Watches .intent/ for changes and automatically:
    1. Regenerates managed blocks in CLAUDE.md, AGENTS.md, GEMINI.md, and .cursorrules
    2. Pushes to phewsh.com/intent (optional — needs account)

    The loop:
      edit .intent/ → native harness files update → cloud mirror updates

  Requirements:
    - .intent/ directory must exist (run \`phewsh intent --init\`)
    - Everything works without an account. Account adds cloud sync.
  `);
}

async function main() {
  if (flags.help) { showHelp(); return; }

  if (!fs.existsSync(INTENT_DIR)) {
    console.log(`\n  ${red('No .intent/ found.')} Run \`phewsh intent --init\` first.\n`);
    process.exit(1);
  }

  const config = loadConfig();
  const loggedIn = !!config?.supabaseUserId;

  console.log('');
  console.log(`  ${b(w('.intent/ Watch'))} ${g('v' + require('../package.json').version)}`);
  console.log(`  ${g('Keeps your AI tools in sync with .intent/')}`);
  console.log('');

  // Show what's enabled
  const features = [];
  if (!flags.noClaude) features.push(`${green('●')} Harness projections auto-sync`);
  else features.push(`${g('○')} Harness projections ${g('(disabled)')}`);

  if (!flags.noPush && loggedIn) features.push(`${green('●')} Cloud push → phewsh.com/intent`);
  else if (!flags.noPush && !loggedIn) features.push(`${yellow('●')} Cloud push ${g('(not logged in — run phewsh login)')}`);
  else features.push(`${g('○')} Cloud push ${g('(disabled)')}`);

  features.forEach(f => console.log(`  ${f}`));
  console.log('');

  // Do initial sync
  console.log(`  ${cyan('~')} Running initial sync...`);

  if (!flags.noClaude) {
    const synced = updateHarnessFiles();
    if (synced.length) console.log(`  ${green('✓')} Updated ${synced.join(', ')}`);
  }

  if (!flags.noPush && loggedIn) {
    const pushed = await pushToCloud(config);
    if (pushed) console.log(`  ${green('✓')} Pushed to cloud`);
  }

  console.log('');
  console.log(`  ${g('Watching .intent/ for changes... (Ctrl+C to stop)')}`);
  console.log('');

  // Start watching
  let watcher;
  const watchFailed = (err) => {
    for (const line of formatWatchFailure(err)) console.log(`  ${yellow('!')} ${g(line)}`);
    console.log('');
    process.exitCode = 1;
  };
  try {
    watcher = watchIntent({ onError: watchFailed });
  } catch (err) {
    watchFailed(err);
    return;
  }

  // Clean exit
  process.on('SIGINT', () => {
    watcher.close();
    console.log(`\n  ${g('Watch stopped.')}\n`);
    process.exit(0);
  });
}

module.exports = main;
module.exports.watchIntent = watchIntent;
module.exports.formatWatchFailure = formatWatchFailure;
