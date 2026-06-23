// phewsh update — update the CLI to the latest published version.
//
// Usage:
//   phewsh update            Check npm and install the latest version
//   phewsh update --check    Just compare versions, don't install
//   phewsh update auto on    Always auto-update in the background on launch
//   phewsh update auto off   Back to notify-only (the default)

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const configFile = require('../lib/config-file');

const CONFIG_PATH = path.join(os.homedir(), '.phewsh', 'config.json');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const g = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// Read/write the autoUpdate preference. Default: false (notify-only) — we never
// mutate a user's global binary without their say-so (the ambient ethos).
function autoUpdateEnabled() {
  const c = configFile.loadConfig(CONFIG_PATH, {}) || {};
  return c.autoUpdate === true;
}
function setAutoUpdate(on) {
  const c = configFile.loadConfig(CONFIG_PATH, {}) || {};
  c.autoUpdate = !!on;
  configFile.saveConfig(CONFIG_PATH, c);
}

// Background, non-blocking update — used on launch when autoUpdate is on. Never
// waits, never prompts; if it fails (e.g. needs sudo) the next launch retries
// and the notify line still shows. Detached so it outlives this process.
function backgroundUpdate(pkgName) {
  try {
    const child = spawn('npm', ['install', '-g', `${pkgName}@latest`], {
      stdio: 'ignore', detached: true,
    });
    child.unref();
    return true;
  } catch { return false; }
}

function isNewer(latest, current) {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  return l[0] !== c[0] ? l[0] > c[0] : l[1] !== c[1] ? l[1] > c[1] : l[2] > c[2];
}

async function main() {
  const pkg = require('../package.json');

  // `phewsh update auto on|off` — toggle background auto-update on launch.
  if (process.argv[3] === 'auto') {
    const choice = (process.argv[4] || '').toLowerCase();
    console.log('');
    if (choice === 'on') {
      setAutoUpdate(true);
      console.log(`  ${green('✓')} ${w('Auto-update on.')} ${g('phewsh will update itself in the background when a new version ships.')}`);
    } else if (choice === 'off') {
      setAutoUpdate(false);
      console.log(`  ${green('✓')} ${w('Auto-update off.')} ${g('Back to notify-only — run')} ${w('phewsh update')} ${g('when you want it.')}`);
    } else {
      console.log(`  ${g('Auto-update is')} ${autoUpdateEnabled() ? green('on') : yellow('off')}${g('.')} ${g('Toggle:')} ${w('phewsh update auto on')} ${g('/')} ${w('phewsh update auto off')}`);
    }
    console.log('');
    return;
  }

  const checkOnly = process.argv.includes('--check');

  console.log('');
  console.log(`  ${b(w('phewsh update'))}`);
  console.log('');
  console.log(`  ${g('current:')} v${pkg.version}`);

  let latest;
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    latest = (await res.json()).version;
  } catch {
    console.log(`  ${yellow('Could not reach the npm registry. Try again later.')}`);
    console.log('');
    return;
  }
  console.log(`  ${g('latest: ')} v${latest}`);
  console.log('');

  if (!latest || !isNewer(latest, pkg.version)) {
    console.log(`  ${green('Already up to date.')}`);
    console.log('');
    return;
  }

  if (checkOnly) {
    console.log(`  ${w(`v${latest} available.`)} Run ${w('phewsh update')} to install.`);
    console.log('');
    return;
  }

  console.log(`  ${g('Installing')} ${w(`phewsh@${latest}`)} ${g('via npm…')}`);
  console.log('');

  const child = spawn('npm', ['install', '-g', `${pkg.name}@latest`], { stdio: 'inherit' });
  child.on('close', (code) => {
    console.log('');
    if (code === 0) {
      console.log(`  ${green('✓')} Updated to v${latest}. New shells pick it up immediately.`);
    } else {
      // NEVER suggest `sudo npm i -g` — that root-owns the package dir and
      // poisons every future non-sudo update (the exact trap users hit). The
      // correct fix is to OWN the package, once, then update normally.
      let prefix = '';
      try {
        prefix = require('child_process').execFileSync('npm', ['config', 'get', 'prefix'],
          { encoding: 'utf-8', timeout: 3000 }).trim();
      } catch { /* unknown prefix */ }
      const pkgDir = prefix ? `${prefix}/lib/node_modules/${pkg.name}` : `$(npm prefix -g)/lib/node_modules/${pkg.name}`;
      const binLink = prefix ? `${prefix}/bin/${pkg.name}` : `$(npm prefix -g)/bin/${pkg.name}`;
      console.log(`  ${yellow('Update failed')} (npm exited ${code}) — almost certainly a permissions issue.`);
      console.log(`  ${g('The phewsh package is probably root-owned from a past `sudo` install.')}`);
      console.log(`  ${b('Own it once, then updates never need sudo again:')}`);
      console.log(`    ${w(`sudo chown -R $(whoami) "${pkgDir}"`)}`);
      console.log(`    ${w(`sudo chown -h $(whoami) "${binLink}"`)}`);
      console.log(`    ${w(`phewsh update`)}`);
      console.log(`  ${g('Or reinstall with the installer (handles this for you):')} ${w('curl -fsSL phewsh.com/install.sh | sh')}`);
      console.log(`  ${g('Do NOT run `sudo npm i -g` — that is what caused this.')}`);
    }
    console.log('');
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.log(`  ${yellow('Could not run npm:')} ${err.message}`);
    console.log('');
    process.exit(1);
  });
}

module.exports = main;
module.exports.autoUpdateEnabled = autoUpdateEnabled;
module.exports.backgroundUpdate = backgroundUpdate;
