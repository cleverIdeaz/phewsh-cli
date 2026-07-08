// phewsh ion — command surface for the shared visual room.
//
// Ion is not a second execution system. It is the room over the existing
// Phewsh primitives:
//   - `serve` exposes the local worker bridge
//   - `task` owns shared requests, invites, claims, reviews, and receipts
//   - `/ion` is the browser room where humans can see and steer the loop

const { execFileSync } = require('child_process');

const WEB_URL = 'https://phewsh.com/ion';

const cream = (s) => `\x1b[97m${s}\x1b[0m`;
const sage = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function openBrowser(url = WEB_URL) {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url]);
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url]);
    else execFileSync('xdg-open', [url]);
    console.log(`\n  ${green('✓')} Opened ${cream(url)}\n`);
  } catch {
    console.log(`\n  ${sage('Could not open browser. Visit:')} ${cream(url)}\n`);
  }
}

function showHelp() {
  console.log(`
  ${cream('phewsh ion')} — shared rooms for humans + local agents

  ${sage('Open the room')}
    ${cyan('phewsh ion')}              ${sage('open phewsh.com/ion')}
    ${cyan('phewsh ion open')}         ${sage('same')}

  ${sage('Make this machine available')}
    ${cyan('phewsh ion serve')}        ${sage('start the local worker bridge')}
    ${cyan('phewsh ion status')}       ${sage('show bridge/project/task status')}

  ${sage('Use the existing task loop')}
    ${cyan('phewsh ion task')}         ${sage('list shared tasks')}
    ${cyan('phewsh ion request "..."')} ${sage('request work in the room')}
    ${cyan('phewsh ion claim next')}   ${sage('manual claim + isolated PR flow')}
    ${cyan('phewsh ion invite <email>')} ${sage('invite a teammate')}
    ${cyan('phewsh ion join')}         ${sage('accept pending invites')}

  ${sage('Connectors')}
    ${cyan('phewsh ion connectors')}   ${sage('show Slack/Discord connector plan')}
`);
}

function showConnectors() {
  console.log(`
  ${cream('Ion connectors')}

  ${sage('Canonical room:')} ${cream('phewsh.com/ion')}
  ${sage('Execution:')}      ${cream('phewsh ion serve')} ${sage('or')} ${cream('phewsh ion claim <id>')}

  ${sage('Slack and Discord are connectors, not the core room yet.')}
  ${sage('Planned flow:')}
    Slack/Discord mention
      → Ion task request
      → human approval in Ion
      → local/VPS Phewsh worker runs
      → branch/PR/evidence returns to Ion
      → notification posts back to Slack/Discord

  ${sage('Do not build bot auto-execution first. Keep Ion as the source of truth.')}
`);
}

function runTask(args) {
  process.argv = [process.argv[0], process.argv[1], 'task', ...args];
  return require('./task')();
}

function runServe(args) {
  process.argv = [process.argv[0], process.argv[1], 'serve', ...args];
  return require('./serve')();
}

module.exports = async function run() {
  const args = process.argv.slice(3);
  const sub = args[0] || 'open';
  const rest = args.slice(1);

  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') return showHelp();
    if (sub === 'open') return openBrowser();
    if (sub === 'serve' || sub === 'worker') return runServe(rest);
    if (sub === 'status') {
      console.log(`\n  ${cream('Ion room:')} ${cyan(WEB_URL)}`);
      console.log(`  ${sage('Local worker:')} ${cream('phewsh ion serve')}`);
      return runTask(['list']);
    }
    if (sub === 'task' || sub === 'tasks') return runTask(rest.length ? rest : ['list']);
    if (sub === 'request' || sub === 'new') return runTask(['new', ...rest]);
    if (sub === 'claim') return runTask(['claim', ...rest]);
    if (sub === 'invite') return runTask(['invite', ...rest]);
    if (sub === 'join') return runTask(['join']);
    if (sub === 'reconcile') return runTask(['reconcile', ...rest]);
    if (sub === 'connectors' || sub === 'slack' || sub === 'discord') return showConnectors();

    console.log(`\n  ${red('✗')} Unknown ion command: ${sub}\n`);
    showHelp();
    process.exitCode = 1;
  } catch (err) {
    console.error(`\n  ${red('✗')} ${err.message}\n`);
    process.exitCode = 1;
  }
};

module.exports.openBrowser = openBrowser;
