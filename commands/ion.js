// phewsh ion — command surface for the shared visual room.
//
// Ion is not a second execution system. It is the room over the existing
// Phewsh primitives:
//   - `serve` exposes the local worker bridge
//   - `task` owns shared requests, invites, claims, reviews, and receipts
//   - `/ion` is the browser room where humans can see and steer the loop

const { execFileSync } = require('child_process');

const WEB_URL = 'https://phewsh.com/ion';
const PROOF_URL = 'https://phewsh.com/ion/two-person-proof.md';

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

  ${sage('Make this machine available — the two-step')}
    ${cyan('phewsh project add')}      ${sage('1. register this repo (once per repo)')}
    ${cyan('phewsh serve')}            ${sage('2. one worker serves the whole machine')}
    ${cyan('phewsh ion doctor')}       ${sage('read-only two-person preflight')}
    ${cyan('phewsh ion status')}       ${sage('show bridge/project/task status')}

  ${sage('Use the existing task loop')}
    ${cyan('phewsh ion task')}         ${sage('list shared tasks')}
    ${cyan('phewsh ion request "..."')} ${sage('request work in the room')}
    ${cyan('phewsh ion claim next')}   ${sage('manual claim + isolated PR flow')}
    ${cyan('phewsh ion invite <email>')} ${sage('invite a teammate')}
    ${cyan('phewsh ion join')}         ${sage('accept pending invites')}

  ${sage('Prove it with two people')}
    ${cyan('phewsh ion doctor')}       ${sage('must report zero failures first')}
    ${cyan(PROOF_URL)}

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
      → same-machine Phewsh worker runs only after a human explicitly claims the task
      → branch/PR/evidence returns to Ion
      → notification posts back to Slack/Discord

  ${sage('Cross-machine/VPS execution still needs a separate authority ruling.')}
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

async function runDoctor(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`\n  ${cream('phewsh ion doctor')} ${sage('— read-only two-person preflight')}`);
    console.log(`\n    ${cyan('phewsh ion doctor')} ${sage('[--offline] [--json] [--port <n>]')}\n`);
    console.log(`  ${sage('Checks project/room identity, local readiness, worker binding, and')}`);
    console.log(`  ${sage('read-only cloud access. Browser sign-in and realtime stay human.')}\n`);
    console.log(`  ${sage('Walkthrough:')} ${cream(PROOF_URL)}\n`);
    return;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port') { index += 1; continue; }
    if (arg !== '--json' && arg !== '--offline') throw new Error(`Unknown doctor option: ${arg}`);
  }
  const json = args.includes('--json');
  const offline = args.includes('--offline');
  const portIndex = args.indexOf('--port');
  const requestedPort = portIndex >= 0 ? Number.parseInt(args[portIndex + 1], 10) : undefined;
  if (portIndex >= 0 && (!requestedPort || requestedPort < 1 || requestedPort > 65535)) {
    throw new Error('--port needs a number from 1 to 65535.');
  }
  const { diagnoseIon } = require('../lib/ion-doctor');
  const report = await diagnoseIon({ offline, port: requestedPort });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n  ${cream('Ion doctor')} ${sage('— read-only two-person preflight')}\n`);
    for (const check of report.checks) {
      const mark = check.status === 'pass' ? green('✓')
        : check.status === 'fail' ? red('✗')
          : check.status === 'human' ? '\x1b[38;5;216m◇\x1b[0m' : sage('–');
      console.log(`  ${mark} ${cream(check.label)} ${sage('— ' + check.detail)}`);
      if (check.fix) console.log(`    ${sage('Next:')} ${cream(check.fix)}`);
    }
    const s = report.summary;
    console.log(`\n  ${cream('Summary:')} ${green(s.pass + ' pass')} ${sage('·')} ${s.fail ? red(s.fail + ' fail') : green('0 fail')} ${sage('·')} \x1b[38;5;216m${s.human} human\x1b[0m${s.skip ? sage(' · ' + s.skip + ' skipped') : ''}`);
    console.log(report.readyForWalkthrough
      ? `  ${green('Ready for the two-person walkthrough.')} ${sage('The two browser checks above remain intentionally human.')}\n`
      : `  ${sage('Fix the failed checks, keep')} ${cream('phewsh serve')} ${sage('running, then rerun')} ${cream('phewsh ion doctor')}${sage('.')}\n`);
    console.log(`  ${sage('Walkthrough:')} ${cream(PROOF_URL)}\n`);
  }
  if (report.summary.fail > 0) process.exitCode = 1;
}

module.exports = async function run() {
  const args = process.argv.slice(3);
  const sub = args[0] || 'open';
  const rest = args.slice(1);

  try {
    if (sub === '--help' || sub === '-h' || sub === 'help') return showHelp();
    if (sub === 'open') return openBrowser();
    if (sub === 'serve' || sub === 'worker') return runServe(rest);
    if (sub === 'doctor') return await runDoctor(rest);
    if (sub === 'status') {
      console.log(`\n  ${cream('Ion room:')} ${cyan(WEB_URL)}`);
      console.log(`  ${sage('Local worker:')} ${cream('phewsh project add')} ${sage('(once per repo), then')} ${cream('phewsh serve')}`);
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
