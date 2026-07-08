// phewsh project — the serve registry: which projects may this machine's
// worker expose to phewsh.com/ion and /cockpit?
//
// Jul 8 2026 Option C ruling: one worker per machine, explicit registry,
// identity = normalized git remote (never the folder name). Adding a project
// here does NOT execute anything and does NOT let anyone run work remotely —
// it only makes the project visible as "online" when `phewsh serve` runs.
// Manual claim remains the execution boundary.
//
// Usage:
//   phewsh project              Show the registry + what to do next
//   phewsh project add [path]   Register a project (default: this directory)
//   phewsh project list         Same as bare `phewsh project`
//   phewsh project remove <name|path>   Stop exposing a project

const path = require('path');
const { addServeProject, removeServeProject, serveProjects } = require('../lib/projects-index');

const b = (s) => `\x1b[1m${s}\x1b[0m`;
const g = (s) => `\x1b[38;5;247m${s}\x1b[0m`;
const w = (s) => `\x1b[97m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

function showList() {
  const projects = serveProjects();
  console.log('');
  console.log(`  ${b(w('Served projects'))} ${g('— what this machine\'s worker shows on phewsh.com/ion')}`);
  console.log('');
  if (projects.length === 0) {
    console.log(`  ${g('None yet. Registering a project is one command, run inside its repo:')}`);
    console.log('');
    console.log(`    ${cyan('cd <your-project> && phewsh project add')}`);
    console.log('');
    console.log(`  ${g('Then start the worker once for the whole machine:')}  ${cyan('phewsh serve')}`);
  } else {
    for (const p of projects) {
      console.log(`  ${green('●')} ${w(p.name)}`);
      console.log(`     ${g('repo:')} ${g(p.remote || 'no remote')}`);
      console.log(`     ${g('path:')} ${g(p.path)}`);
    }
    console.log('');
    console.log(`  ${g('These appear as this machine\'s projects when')} ${cyan('phewsh serve')} ${g('is running.')}`);
    console.log(`  ${g('Add another:')} ${cyan('phewsh project add [path]')}   ${g('Stop exposing one:')} ${cyan('phewsh project remove <name>')}`);
  }
  console.log('');
  console.log(`  ${g('Registering never executes anything — work still starts only when a')}`);
  console.log(`  ${g('human claims it. See phewsh.com/ion for the team room.')}`);
  console.log('');
}

function main() {
  const args = process.argv.slice(3);
  const sub = args[0];

  if (sub === 'add') {
    const dir = args[1] ? path.resolve(args[1]) : process.cwd();
    try {
      const p = addServeProject(dir);
      console.log('');
      console.log(`  ${green('✓')} ${w(p.name)} ${g('registered for this machine\'s worker.')}`);
      console.log(`     ${g('identity:')} ${g(p.remote)}`);
      console.log('');
      console.log(`  ${g('Next:')} ${cyan('phewsh serve')} ${g('— one worker serves every registered project;')}`);
      console.log(`  ${g('phewsh.com/ion will show it as online on this machine.')}`);
      console.log('');
    } catch (err) {
      console.log('');
      console.log(`  ${yellow('●')} ${err.message.split('\n').join(`\n  ${g('')}`)}`);
      console.log('');
      process.exit(1);
    }
    return;
  }

  if (sub === 'remove' || sub === 'rm') {
    if (!args[1]) {
      console.log('');
      console.log(`  ${g('Which one? ')} ${cyan('phewsh project remove <name|path>')}`);
      console.log('');
      showList();
      process.exit(1);
    }
    const hit = removeServeProject(args[1]);
    console.log('');
    if (hit) {
      console.log(`  ${green('✓')} ${w(hit.name)} ${g('is no longer exposed by this machine\'s worker.')}`);
      console.log(`  ${g('(The project itself is untouched — this only changes what the worker shows.)')}`);
    } else {
      console.log(`  ${yellow('●')} ${g('No served project matches')} ${w(args[1])}${g('. Here\'s what\'s registered:')}`);
      showList();
      process.exit(1);
    }
    console.log('');
    return;
  }

  if (sub && sub !== 'list' && sub !== 'ls' && sub !== 'help' && sub !== '--help' && sub !== '-h') {
    console.log('');
    console.log(`  ${yellow('●')} ${g('Unknown subcommand:')} ${w(sub)}`);
  }

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    console.log('');
    console.log(`  ${b(w('phewsh project'))} ${g('— choose which projects this machine\'s worker exposes')}`);
    console.log('');
    console.log(`    ${cyan('phewsh project')}                    ${g('show the registry + guidance')}`);
    console.log(`    ${cyan('phewsh project add [path]')}         ${g('register a project (default: here)')}`);
    console.log(`    ${cyan('phewsh project remove <name|path>')} ${g('stop exposing a project')}`);
    console.log('');
    console.log(`  ${g('Safety: registering only affects visibility. Execution always requires')}`);
    console.log(`  ${g('a human claim — nothing runs remotely because it was registered.')}`);
    console.log('');
    return;
  }

  showList();
}

module.exports = main;
